import { and, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import {
  addDays,
  addMonths,
  assignMatches,
  daysBetween,
  dateInMonth,
  defaultInvoiceDates,
  importQuestions,
  monthOf,
  normalizeText,
  scoreMatch,
  type ImportDestination,
  type ImportLine,
  type ImportLineView,
  type ImportPreview,
  type ImportQuestion,
  type ImportSuggestion,
  type ImportSuggestions,
  type ImportTarget,
  type MatchCandidate,
  type MatchScore,
  type Month,
  type OccurrenceRow,
} from '@ff/shared';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { accounts, categories, importLines, invoices, items, occurrences } from '../../db/schema';
import { AppError } from '../../http/errors';
import { importKeyOf, signPreview, verifyPreview, type PreviewPayload } from '../../imports/token';
import { readImportFile } from '../../imports/read-file';
import type { Clock } from '../clock';
import { toInvoiceRow } from '../invoices';
import { buildRows, projectedRow } from '../occurrences';
import { chargeMonthFor, ensureMaterialized, projectionsFor } from '../projections';
import { fingerprintOf, sameBank } from './fingerprint';

/**
 * Prévia e sugestões da importação (ADR-0010, D8). Só lê (fora a gravação
 * preguiçosa de recorrentes até o mês atual, que qualquer tela do mês já faz):
 * nada da importação é gravado antes da confirmação.
 */

type AccountRec = typeof accounts.$inferSelect;
type ItemRec = typeof items.$inferSelect;

const STATEMENT_WINDOW = 7;
const INVOICE_WINDOW = 3;
const INVOICE_DUE_WINDOW = 10;

/** Candidato interno: o que a tela mostra (`target`) e o que a pontuação usa (`match`). */
interface Cand {
  target: ImportTarget;
  match: MatchCandidate;
  type: 'expense' | 'income';
}

const wrongDestination = (kind: 'statement' | 'invoice') =>
  new AppError(400, 'import_wrong_destination', kind === 'statement' ? 'Escolha uma conta (não um cartão) para o extrato.' : 'Escolha um cartão de crédito para a fatura.', {
    accountId: kind === 'statement' ? 'Escolha uma conta.' : 'Escolha um cartão.',
  });

export async function destinationOf(tx: Tx, walletId: string, accountId: string, kind: 'statement' | 'invoice'): Promise<AccountRec> {
  const acc = await tx.query.accounts.findFirst({ where: and(eq(accounts.id, accountId), eq(accounts.walletId, walletId)) });
  if (!acc) throw new AppError(404, 'not_found', 'Conta não encontrada.');
  if ((kind === 'statement') !== (acc.kind === 'account')) throw wrongDestination(kind);
  return acc;
}

type PaidRef = { paymentId: string; paidAt: string; amountCents: number } | null;

function occurrenceTarget(row: OccurrenceRow, alreadyPaid: PaidRef = null): ImportTarget {
  return {
    kind: 'occurrence',
    occurrenceId: row.id,
    itemId: row.itemId,
    description: row.description,
    type: row.type,
    form: row.form,
    competenceMonth: row.competenceMonth,
    installmentLabel: row.installmentLabel,
    expectedCents: row.expectedCents,
    remainingCents: row.remainingCents,
    dueDate: row.dueDate,
    displayStatus: row.displayStatus,
    variableAmount: row.variableAmount,
    projected: row.projected,
    alreadyPaid,
  };
}

// ---------- Candidatos do extrato

async function linkedPaymentIds(tx: Tx, walletId: string): Promise<Set<string>> {
  const rows = await tx.select({ id: importLines.paymentId }).from(importLines).where(and(eq(importLines.walletId, walletId)));
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

async function statementCandidates(tx: Tx, walletId: string, accountId: string, lines: ImportLine[], clock: Clock): Promise<Cand[]> {
  if (lines.length === 0) return [];
  const dates = lines.map((l) => l.date).sort();
  const fromMonth = monthOf(addDays(dates[0]!, -STATEMENT_WINDOW));
  const toMonth = monthOf(addDays(dates[dates.length - 1]!, STATEMENT_WINDOW));
  await ensureMaterialized(tx, walletId, clock);
  const recs = await tx
    .select({ occ: occurrences })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .where(
      and(
        eq(occurrences.walletId, walletId),
        isNull(items.deletedAt),
        isNull(items.systemKind),
        isNull(occurrences.invoiceId),
        ne(items.method, 'credit'),
        or(eq(items.accountId, accountId), isNull(items.accountId)),
        gte(occurrences.competenceMonth, fromMonth),
        lte(occurrences.competenceMonth, toMonth),
        ne(occurrences.status, 'canceled'),
      ),
    );
  const occs = recs.map((r) => r.occ);
  // Parcela: só a próxima em aberto de cada item é candidata a pagamento.
  const instItemIds = [...new Set(occs.filter((o) => o.installmentNumber !== null).map((o) => o.itemId))];
  const nextOpen = new Map<string, number>();
  if (instItemIds.length) {
    const open = await tx.query.occurrences.findMany({
      where: and(inArray(occurrences.itemId, instItemIds), inArray(occurrences.status, ['pending', 'partial'])),
      columns: { itemId: true, installmentNumber: true },
    });
    for (const o of open) {
      const cur = nextOpen.get(o.itemId);
      if (o.installmentNumber !== null && (cur === undefined || o.installmentNumber < cur)) nextOpen.set(o.itemId, o.installmentNumber);
    }
  }
  const linked = await linkedPaymentIds(tx, walletId);
  const rows = await buildRows(tx, occs, clock);
  const out: Cand[] = [];
  for (const row of rows) {
    const variable = row.form === 'recurring' && row.variableAmount;
    const open = row.status === 'pending' || row.status === 'partial';
    const isNext = row.installmentNumber === null || nextOpen.get(row.itemId) === row.installmentNumber;
    if (open && isNext && row.remainingCents > 0) {
      out.push({
        target: occurrenceTarget(row),
        type: row.type,
        match: { key: row.id, date: row.dueDate, month: row.competenceMonth, amountCents: row.remainingCents, description: row.description, variable, tolerant: !variable },
      });
    }
    // Já pago no app: a linha só vincula ao pagamento (mesmo valor, até 7 dias).
    for (const p of row.payments) {
      if (linked.has(p.id)) continue;
      out.push({
        target: occurrenceTarget(row, { paymentId: p.id, paidAt: p.paidAt, amountCents: p.amountCents }),
        type: row.type,
        match: { key: `pay:${p.id}`, date: p.paidAt, month: monthOf(p.paidAt), amountCents: p.amountCents, description: row.description, variable: false, tolerant: false },
      });
    }
  }
  // Meses futuros: projeções das recorrentes da conta.
  const cats = await tx.query.categories.findMany({ where: eq(categories.walletId, walletId) });
  for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) {
    if (m <= clock.currentMonth) continue;
    for (const p of await projectionsFor(tx, walletId, m, clock)) {
      if (p.item.method === 'credit' || (p.item.accountId && p.item.accountId !== accountId)) continue;
      const c = cats.find((x) => x.id === p.item.categoryId);
      const row = projectedRow(p, c ? { id: c.id, name: c.name } : null);
      const variable = p.item.variableAmount;
      out.push({
        target: occurrenceTarget(row),
        type: row.type,
        match: { key: row.id, date: row.dueDate, month: row.competenceMonth, amountCents: row.expectedCents, description: row.description, variable, tolerant: !variable },
      });
    }
  }
  return out;
}

interface InvoiceCand {
  target: Extract<ImportTarget, { kind: 'invoice' }>;
  payments: Array<{ id: string; paidAt: string; amountCents: number }>;
}

/** Faturas de cartão que uma linha do extrato pode pagar (vencimento a até 10 dias). */
async function invoiceTargets(tx: Tx, walletId: string, lines: ImportLine[], clock: Clock): Promise<InvoiceCand[]> {
  if (!lines.length) return [];
  const dates = lines.map((l) => l.date).sort();
  const from = addDays(dates[0]!, -INVOICE_DUE_WINDOW);
  const to = addDays(dates[dates.length - 1]!, INVOICE_DUE_WINDOW);
  const invs = await tx.query.invoices.findMany({ where: and(eq(invoices.walletId, walletId), gte(invoices.dueDate, from), lte(invoices.dueDate, to)) });
  const out: InvoiceCand[] = [];
  for (const inv of invs) {
    const row = await toInvoiceRow(tx, inv, clock);
    out.push({
      payments: row.payments,
      target: {
        kind: 'invoice',
        invoiceId: inv.id,
        accountName: row.account.name,
        bank: row.account.bank,
        referenceMonth: inv.referenceMonth,
        dueDate: inv.dueDate,
        totalCents: row.totalCents,
        paidCents: row.paidCents,
        realAmountCents: inv.realAmountCents,
        status: inv.status,
        alreadyPaid: null,
      },
    });
  }
  return out;
}

/** Escolhe a fatura de um cartão do banco indicado com vencimento mais perto da data da linha. */
function pickInvoice(line: ImportLine, bank: string, targets: InvoiceCand[]): ImportTarget | null {
  let best: { t: ImportTarget; d: number } | null = null;
  for (const { target: t, payments } of targets) {
    if (!sameBank(t.bank, bank)) continue;
    const d = Math.abs(daysBetween(t.dueDate, line.date));
    if (d > INVOICE_DUE_WINDOW) continue;
    const pay = payments.find((p) => p.amountCents === line.amountCents && Math.abs(daysBetween(p.paidAt, line.date)) <= 3);
    const cand = pay ? { ...t, alreadyPaid: { paymentId: pay.id, paidAt: pay.paidAt, amountCents: pay.amountCents } } : t;
    // Fatura já encerrada sem pagamento igual não serve.
    if (t.status !== 'open' && !pay) continue;
    if (!best || d < best.d) best = { t: cand, d };
  }
  return best?.t ?? null;
}

// ---------- Candidatos da fatura

async function invoiceCandidates(tx: Tx, walletId: string, card: AccountRec, refMonth: Month, clock: Clock): Promise<Cand[]> {
  const inv = await tx.query.invoices.findFirst({ where: and(eq(invoices.accountId, card.id), eq(invoices.referenceMonth, refMonth)) });
  const out: Cand[] = [];
  if (inv) {
    const recs = await tx
      .select({ occ: occurrences })
      .from(occurrences)
      .innerJoin(items, eq(items.id, occurrences.itemId))
      .where(and(eq(occurrences.invoiceId, inv.id), isNull(items.deletedAt), isNull(items.systemKind), ne(occurrences.status, 'canceled')));
    const occs = recs.map((r) => r.occ);
    const rows = await buildRows(tx, occs, clock);
    const itemRecs = occs.length ? await tx.query.items.findMany({ where: inArray(items.id, [...new Set(occs.map((o) => o.itemId))]) }) : [];
    const byId = new Map(itemRecs.map((i) => [i.id, i]));
    for (const row of rows) {
      const item = byId.get(row.itemId)!;
      out.push({ target: occurrenceTarget(row), type: row.type, match: await invoiceMatch(tx, item, row, row.competenceMonth) });
    }
  }
  if (refMonth > clock.currentMonth) {
    const cats = await tx.query.categories.findMany({ where: eq(categories.walletId, walletId) });
    for (const p of await projectionsFor(tx, walletId, refMonth, clock)) {
      if (p.item.method !== 'credit' || p.item.accountId !== card.id) continue;
      const c = cats.find((x) => x.id === p.item.categoryId);
      const row = projectedRow(p, c ? { id: c.id, name: c.name } : null);
      out.push({ target: occurrenceTarget(row), type: row.type, match: { ...(await invoiceMatch(tx, p.item, row, refMonth, p.chargeMonth)) } });
    }
  }
  return out;
}

/** Data de compra do item no crédito: a do cadastro; na recorrente, o dia da cobrança no mês da cobrança. */
async function invoiceMatch(tx: Tx, item: ItemRec, row: OccurrenceRow, refMonth: Month, chargeMonth?: Month): Promise<MatchCandidate> {
  let date = item.entryDate;
  if (item.form === 'recurring') date = dateInMonth(chargeMonth ?? (await chargeMonthFor(tx, item, refMonth)), Number(item.entryDate.slice(8, 10)));
  const variable = item.form === 'recurring' && item.variableAmount;
  return {
    key: row.id,
    date,
    month: monthOf(date),
    amountCents: row.expectedCents,
    description: row.description,
    variable,
    tolerant: !variable,
    parcel: row.installmentNumber && item.installments ? { n: row.installmentNumber, of: item.installments } : null,
  };
}

// ---------- Sugestões

/** Perguntas (regra compartilhada com a tela) e avisos de valor diferente. */
function questionsFor(line: ImportLine, t: ImportTarget): { questions: ImportQuestion[]; warnings: string[] } {
  const questions = importQuestions(line.amountCents, t);
  if (t.kind !== 'occurrence' || t.alreadyPaid || (t.form === 'recurring' && t.variableAmount) || line.amountCents === t.remainingCents) return { questions, warnings: [] };
  const brl = (c: number) => `R$ ${(c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  if (t.form === 'installment') return { questions, warnings: [`Valor diferente da parcela (${brl(t.remainingCents)}).`] };
  if (t.form === 'single' && line.amountCents > t.remainingCents) return { questions, warnings: [`Valor maior que o previsto (${brl(t.remainingCents)}).`] };
  return { questions, warnings: [] };
}

function categoryFor(line: ImportLine, type: 'expense' | 'income', cats: Array<{ id: string; name: string; type: string; archivedAt: Date | null }>): string | null {
  const active = cats.filter((c) => c.type === type && !c.archivedAt);
  const byName = (n: string) => active.find((c) => normalizeText(c.name) === normalizeText(n))?.id ?? null;
  if (line.section) return byName(line.section);
  if (line.hint === 'fee') return byName('Outros');
  return null;
}

export async function suggestFor(tx: Tx, walletId: string, payload: PreviewPayload, accountId: string, clock: Clock): Promise<ImportSuggestions> {
  const account = await destinationOf(tx, walletId, accountId, payload.kind);
  const lines = payload.lines;
  // Linhas já conciliadas numa importação anterior (mesma impressão digital, mesmo destino).
  const prints = lines.map((l) => fingerprintOf(walletId, account.id, l));
  const known = prints.length
    ? new Set(
        (await tx.select({ f: importLines.fingerprint }).from(importLines).where(and(eq(importLines.walletId, walletId), eq(importLines.accountId, account.id), inArray(importLines.fingerprint, prints)))).map((r) => r.f),
      )
    : new Set<string>();
  const cats = await tx.query.categories.findMany({ where: eq(categories.walletId, walletId) });

  let cands: Cand[];
  let invTargets: InvoiceCand[] = [];
  let invoiceInfo: ImportSuggestions['invoice'] = null;
  const invoiceKind = payload.kind === 'invoice';
  if (!invoiceKind) {
    cands = await statementCandidates(tx, walletId, account.id, lines, clock);
    invTargets = await invoiceTargets(tx, walletId, lines, clock);
  } else {
    const bank = payload.header.invoice!;
    const refMonth = monthOf(bank.dueDate);
    cands = await invoiceCandidates(tx, walletId, account, refMonth, clock);
    const inv = await tx.query.invoices.findFirst({ where: and(eq(invoices.accountId, account.id), eq(invoices.referenceMonth, refMonth)) });
    const dflt = defaultInvoiceDates(refMonth, account.closingDay!, account.dueDay!);
    const row = inv ? await toInvoiceRow(tx, inv, clock) : null;
    invoiceInfo = {
      id: inv?.id ?? null,
      referenceMonth: refMonth,
      status: inv?.status ?? 'open',
      appClosingDate: inv?.closingDate ?? dflt.closingDate,
      appDueDate: inv?.dueDate ?? dflt.dueDate,
      bankClosingDate: bank.closingDate,
      bankDueDate: bank.dueDate,
      bankTotalCents: bank.totalCents,
      itemsCents: row?.itemsCents ?? cands.reduce((s, c) => s + (c.target.kind === 'occurrence' ? c.target.expectedCents : 0), 0),
    };
  }

  // Pontuação: cada linha contra os candidatos do mesmo tipo.
  const window = invoiceKind ? INVOICE_WINDOW : STATEMENT_WINDOW;
  const perLine = new Map<number, Array<{ key: string; score: MatchScore }>>();
  for (const l of lines) {
    if (known.has(prints[l.index]!)) continue;
    const type = l.direction === 'debit' ? 'expense' : 'income';
    const scored: Array<{ key: string; score: MatchScore }> = [];
    for (const c of cands) {
      if (c.type !== type) continue;
      const s = scoreMatch(l, c.match, window);
      if (s) scored.push({ key: c.match.key, score: s });
    }
    perLine.set(l.index, scored);
  }
  const assigned = assignMatches(perLine);
  const candByKey = new Map(cands.map((c) => [c.match.key, c]));
  const usedKeys = new Set<string>();
  const usedPayments = new Set<string>();

  const views: ImportLineView[] = lines.map((l) => {
    const type = l.direction === 'debit' ? 'expense' : 'income';
    const create = { description: l.name || l.description, method: l.method, type, categoryId: categoryFor(l, type, cats) } as ImportSuggestion['create'];
    const base: ImportSuggestion = { action: 'create', target: null, alternatives: [], questions: [], warnings: [], create };
    if (known.has(prints[l.index]!)) return { ...l, suggestion: { ...base, action: 'already' } };
    const a = assigned.get(l.index);
    base.alternatives = (a?.alternatives ?? []).map((x) => candByKey.get(x.key)!.target);
    // Pagamento de fatura (extrato): fatura do cartão do banco do documento ou do favorecido do boleto.
    if (!invoiceKind && (l.hint === 'invoice_payment' || l.payeeBank)) {
      const inv = pickInvoice(l, l.hint === 'invoice_payment' ? payload.bank : l.payeeBank!, invTargets);
      if (inv) {
        const others = invTargets.map((c) => c.target).filter((t) => t.invoiceId !== (inv.kind === 'invoice' ? inv.invoiceId : '') && t.status === 'open');
        return { ...l, suggestion: { ...base, action: 'invoice_payment', target: inv, alternatives: others } };
      }
      if (l.hint === 'invoice_payment') {
        return { ...l, suggestion: { ...base, action: 'ignore', warnings: ['Nenhuma fatura de cartão deste banco vence perto desta data. Cadastre o cartão para conciliar o pagamento.'] } };
      }
    }
    if (l.ignoreByDefault) return { ...l, suggestion: { ...base, action: 'ignore', target: a?.best ? candByKey.get(a.best.key)!.target : null } };
    if (a?.best) {
      const c = candByKey.get(a.best.key)!;
      usedKeys.add(c.target.kind === 'occurrence' ? c.target.occurrenceId : '');
      if (c.target.kind === 'occurrence' && c.target.alreadyPaid) usedPayments.add(c.target.alreadyPaid.paymentId);
      return { ...l, suggestion: { ...base, action: 'match', target: c.target, ...questionsFor(l, c.target) } };
    }
    if (invoiceKind && invoiceInfo && invoiceInfo.status !== 'open') {
      return { ...l, suggestion: { ...base, action: 'ignore', warnings: ['Esta fatura já foi paga no app: não dá para criar itens nela.'] } };
    }
    return { ...l, suggestion: base };
  });

  // No app, mas não no arquivo.
  const unmatchedApp: ImportSuggestions['unmatchedApp'] = [];
  const linked = await linkedPaymentIds(tx, walletId);
  if (!invoiceKind) {
    const start = payload.header.periodStart ?? lines.map((l) => l.date).sort()[0];
    const end = payload.header.periodEnd ?? lines.map((l) => l.date).sort().at(-1);
    for (const c of cands) {
      const t = c.target;
      if (t.kind !== 'occurrence' || !t.alreadyPaid || !start || !end) continue;
      const p = t.alreadyPaid;
      if (p.paidAt < start || p.paidAt > end || usedPayments.has(p.paymentId) || linked.has(p.paymentId)) continue;
      const item = await tx.query.items.findFirst({ where: eq(items.id, t.itemId), columns: { accountId: true } });
      if (item?.accountId !== account.id) continue;
      unmatchedApp.push({ occurrenceId: t.occurrenceId, description: t.description, date: t.dueDate, amountCents: p.amountCents, paidAt: p.paidAt });
    }
  } else {
    const linkedOccs = new Set(
      (await tx.select({ id: importLines.occurrenceId }).from(importLines).where(eq(importLines.walletId, walletId))).map((r) => r.id).filter((x): x is string => !!x),
    );
    for (const c of cands) {
      const t = c.target;
      if (t.kind !== 'occurrence' || usedKeys.has(t.occurrenceId) || linkedOccs.has(t.occurrenceId)) continue;
      unmatchedApp.push({ occurrenceId: t.occurrenceId, description: t.description, date: c.match.date, amountCents: t.expectedCents, paidAt: null });
    }
  }
  return { accountId: account.id, kind: payload.kind, lines: views, unmatchedApp, invoice: invoiceInfo, invoiceTargets: invTargets.map((c) => c.target).filter((t) => t.status === 'open') };
}

// ---------- Prévia a partir do arquivo

export async function destinationsFor(tx: Tx, walletId: string, payload: Pick<PreviewPayload, 'kind' | 'bank' | 'header'>): Promise<ImportPreview['destinations']> {
  const all = await tx.query.accounts.findMany({ where: and(eq(accounts.walletId, walletId), isNull(accounts.archivedAt)) });
  const options: ImportDestination[] = all
    .filter((a) => (payload.kind === 'statement') === (a.kind === 'account'))
    .map((a) => ({ id: a.id, name: a.name, bank: a.bank, kind: a.kind }));
  const byKey = payload.header.importKey ? all.find((a) => a.importKey === payload.header.importKey && options.some((o) => o.id === a.id)) : undefined;
  const byBank = options.filter((o) => sameBank(o.bank, payload.bank));
  const suggested = byKey?.id ?? (byBank.length === 1 ? byBank[0]!.id : options.length === 1 ? options[0]!.id : null);
  return { options, suggestedAccountId: suggested };
}

export async function previewImport(ctx: AppContext, walletId: string, userId: string, file: Buffer, password: string | undefined, clock: Clock): Promise<ImportPreview> {
  const { reader, result } = await readImportFile(ctx, file, password);
  if (reader.kind === 'invoice' && !result.header.invoice) {
    throw new AppError(422, 'import_unknown_source', 'Não encontramos o vencimento e o total desta fatura.');
  }
  const bank = result.header.bankName ?? reader.bank;
  const { accountRef, ...header } = result.header;
  const payload: Omit<PreviewPayload, 'v' | 'exp'> = {
    walletId,
    userId,
    readerId: reader.id,
    kind: reader.kind,
    bank,
    header: { ...header, importKey: importKeyOf(walletId, bank, accountRef) },
    lines: result.lines,
    warnings: result.warnings,
  };
  const token = signPreview(ctx, payload);
  return ctx.db.transaction(async (tx) => {
    const destinations = await destinationsFor(tx, walletId, payload);
    const suggestions = destinations.suggestedAccountId
      ? await suggestFor(tx, walletId, { ...payload, v: 1, exp: 0 }, destinations.suggestedAccountId, clock)
      : null;
    return {
      token,
      source: { readerId: reader.id, bank, kind: reader.kind, label: reader.label },
      header: { periodStart: header.periodStart, periodEnd: header.periodEnd, accountLabel: header.accountLabel, invoice: header.invoice },
      lineCount: result.lines.length,
      warnings: result.warnings,
      destinations,
      suggestions,
    };
  });
}

export async function suggestImport(ctx: AppContext, walletId: string, userId: string, token: string, accountId: string, clock: Clock): Promise<ImportSuggestions> {
  const payload = verifyPreview(ctx, token, walletId, userId);
  return ctx.db.transaction((tx) => suggestFor(tx, walletId, payload, accountId, clock));
}

