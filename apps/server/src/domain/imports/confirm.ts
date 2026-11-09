import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  addMonths,
  daysBetween,
  monthOf,
  type ImportConfirmInput,
  type ImportConfirmResult,
  type ImportDecision,
  type ImportLine,
  type Method,
  type Month,
} from '@ff/shared';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import { accounts, importBatches, importLines, invoicePayments, invoices, items, payments } from '../../db/schema';
import { AppError, conflict } from '../../http/errors';
import { verifyPreview, type PreviewPayload } from '../../imports/token';
import { isUniqueViolation } from '../catalog';
import type { Clock } from '../clock';
import { ensureInvoice } from '../invoice-core';
import { itemsSum, payInvoiceTx, updateInvoiceDatesTx } from '../invoices';
import { createItemTx } from '../items';
import { getOccurrenceChecked, patchOccurrence } from '../occurrences';
import { addPaymentTx } from '../payments';
import { materializeProjection } from '../projections';
import { fingerprintOf } from './fingerprint';
import { destinationOf } from './suggest';

/**
 * Confirmação da importação (ADR-0010, D9): tudo numa transação, reaproveitando
 * as regras do domínio (createItem, addPayment, payInvoice). Se uma linha
 * falhar, nada é gravado e o erro aponta a linha (`fields["decisions.N"]`).
 * Dentro da transação a conexão é uma só: nada de Promise.all.
 */

type LineAction = 'paid' | 'linked' | 'created' | 'invoice_paid' | 'ignored';
interface LineResult {
  action: LineAction;
  occurrenceId?: string | null;
  paymentId?: string | null;
  invoiceId?: string | null;
  invoicePaymentId?: string | null;
  itemId?: string | null;
  month?: Month | null;
}

const lineError = (index: number, status: number, code: string, message: string) => new AppError(status, code, message, { [`decisions.${index}`]: message });

/** Pagamentos do app já vinculados a uma linha nesta confirmação (ainda não gravados em import_lines). */
type Used = Set<string>;

/** Pagamento do app de mesmo valor perto da data (até `days` dias), ainda não vinculado a outra linha. */
async function findPaymentLike(tx: Tx, occurrenceId: string, line: ImportLine, days: number, used: Used): Promise<string | null> {
  const rows = await tx.query.payments.findMany({ where: eq(payments.occurrenceId, occurrenceId), columns: { id: true, paidAt: true, amountCents: true } });
  for (const p of rows) {
    if (used.has(p.id) || p.amountCents !== line.amountCents || Math.abs(daysBetween(p.paidAt, line.date)) > days) continue;
    const linkedLine = await tx.query.importLines.findFirst({ where: eq(importLines.paymentId, p.id), columns: { id: true } });
    if (!linkedLine) return p.id;
  }
  return null;
}

async function latestPayment(tx: Tx, occurrenceId: string): Promise<string | null> {
  const [p] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.occurrenceId, occurrenceId)).orderBy(desc(payments.createdAt)).limit(1);
  return p?.id ?? null;
}

/** Extrato: a linha paga (ou só vincula) uma ocorrência fora do crédito. */
async function matchStatement(tx: Tx, walletId: string, userId: string, line: ImportLine, d: ImportDecision, clock: Clock, used: Used): Promise<LineResult> {
  const realId = await materializeProjection(tx, walletId, d.occurrenceId!, clock);
  const occ = await getOccurrenceChecked(tx, walletId, realId);
  const item = (await tx.query.items.findFirst({ where: eq(items.id, occ.itemId) }))!;
  const type = line.direction === 'debit' ? 'expense' : 'income';
  if (item.deletedAt || occ.invoiceId || item.type !== type || occ.status === 'canceled') {
    throw lineError(d.index, 409, 'import_target_changed', 'Este lançamento não pode mais receber esta linha. Recarregue a prévia.');
  }
  // Já pago no app: só vincula, sem pagar de novo.
  const existing = await findPaymentLike(tx, occ.id, line, 7, used);
  if (existing) return { action: 'linked', occurrenceId: occ.id, paymentId: existing, month: occ.competenceMonth };
  if (occ.status === 'paid') throw lineError(d.index, 409, 'import_target_changed', 'Este lançamento já foi pago no app. Escolha outro ou ignore a linha.');

  const [paid] = await tx
    .select({ cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(eq(payments.occurrenceId, occ.id));
  const remaining = Math.max(0, occ.expectedCents - (paid?.cents ?? 0));
  const variable = item.form === 'recurring' && item.variableAmount;
  if (line.amountCents !== remaining && (variable || (item.form === 'recurring' && line.amountCents > remaining))) {
    // Variável: o mês passa a valer o que o banco cobrou. Fixa mais cara: só este mês ou daqui em diante.
    if (!variable && !d.amountScope) throw lineError(d.index, 400, 'amount_scope_required', 'Diga se o valor novo vale só para este mês ou daqui em diante.');
    await patchOccurrence(tx, occ, item, { expectedCents: (paid?.cents ?? 0) + line.amountCents }, { ruleScope: variable ? 'occurrence' : d.amountScope });
  } else if (line.amountCents < remaining && !d.settlement) {
    throw lineError(d.index, 400, 'settlement_required', 'O valor é menor que o previsto. Diga se foi quitado com desconto ou se é um pagamento parcial.');
  }
  const fresh = await getOccurrenceChecked(tx, walletId, occ.id);
  const newRemaining = Math.max(0, fresh.expectedCents - (paid?.cents ?? 0));
  await addPaymentTx(
    tx,
    walletId,
    occ.id,
    { paidAt: line.date, amountCents: line.amountCents, settlement: line.amountCents < newRemaining ? d.settlement : undefined },
    userId,
    clock,
  );
  return { action: 'paid', occurrenceId: occ.id, paymentId: await latestPayment(tx, occ.id), month: occ.competenceMonth };
}

/** Fatura: a linha só vincula a uma ocorrência da fatura (itens no crédito não têm pagamento próprio). */
async function matchInvoiceItem(tx: Tx, walletId: string, line: ImportLine, d: ImportDecision, invoiceId: string, clock: Clock): Promise<LineResult> {
  const realId = await materializeProjection(tx, walletId, d.occurrenceId!, clock);
  const occ = await getOccurrenceChecked(tx, walletId, realId);
  if (occ.invoiceId !== invoiceId || occ.status === 'canceled') {
    throw lineError(d.index, 409, 'import_target_changed', 'Este item não está mais nesta fatura. Recarregue a prévia.');
  }
  return { action: 'linked', occurrenceId: occ.id, invoiceId, month: occ.competenceMonth };
}

async function payInvoiceLine(tx: Tx, walletId: string, userId: string, line: ImportLine, d: ImportDecision, clock: Clock, used: Used): Promise<LineResult> {
  const inv = await tx.query.invoices.findFirst({ where: and(eq(invoices.id, d.invoiceId!), eq(invoices.walletId, walletId)) });
  if (!inv) throw lineError(d.index, 404, 'not_found', 'Fatura não encontrada.');
  // Já paga com este valor perto da data: só vincula.
  const pays = await tx.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, inv.id) });
  for (const p of pays) {
    if (used.has(p.id) || p.amountCents !== line.amountCents || Math.abs(daysBetween(p.paidAt, line.date)) > 3) continue;
    const linkedLine = await tx.query.importLines.findFirst({ where: eq(importLines.invoicePaymentId, p.id), columns: { id: true } });
    if (!linkedLine) return { action: 'linked', invoiceId: inv.id, invoicePaymentId: p.id, month: inv.referenceMonth };
  }
  if (inv.status !== 'open') throw lineError(d.index, 409, 'invoice_closed', 'Esta fatura já está paga ou encerrada no app.');
  const real = d.realAmountCents ?? inv.realAmountCents ?? (await itemsSum(tx, inv.id)).cents;
  await payInvoiceTx(tx, walletId, inv.id, { realAmountCents: real, amountCents: line.amountCents, paidAt: line.date }, userId, clock);
  const [p] = await tx.select({ id: invoicePayments.id }).from(invoicePayments).where(eq(invoicePayments.invoiceId, inv.id)).orderBy(desc(invoicePayments.createdAt)).limit(1);
  return { action: 'invoice_paid', invoiceId: inv.id, invoicePaymentId: p?.id ?? null, month: inv.referenceMonth };
}

async function createFromStatement(tx: Tx, walletId: string, userId: string, accountId: string, line: ImportLine, d: ImportDecision, clock: Clock): Promise<LineResult> {
  const method: Method = d.create!.method && d.create!.method !== 'credit' ? d.create!.method : line.method === 'credit' ? 'debit' : line.method;
  const detail = await createItemTx(
    tx,
    walletId,
    {
      type: line.direction === 'debit' ? 'expense' : 'income',
      form: 'single',
      description: d.create!.description,
      categoryId: d.create!.categoryId ?? null,
      method,
      accountId,
      amountCents: line.amountCents,
      date: line.date,
      dueDate: line.date,
      alreadyPaid: true,
    },
    userId,
    clock,
  );
  const occ = detail.occurrences[0]!;
  return { action: 'created', itemId: detail.id, occurrenceId: occ.id, paymentId: occ.payments[0]?.id ?? null, month: occ.competenceMonth };
}

/** Fatura: compra nova no crédito, nesta fatura. "PARC xx/yy" antiga: só as parcelas restantes. */
async function createFromInvoice(tx: Tx, walletId: string, userId: string, cardId: string, refMonth: Month, line: ImportLine, d: ImportDecision, clock: Clock): Promise<LineResult> {
  const parcel = line.parcel;
  const remaining = parcel ? parcel.of - parcel.n + 1 : 1;
  const note = parcel && parcel.n > 1 ? (remaining > 1 ? `Parcelas ${parcel.n} a ${parcel.of} de ${parcel.of} (importado da fatura)` : `Parcela ${parcel.n} de ${parcel.of} (importado da fatura)`) : null;
  const detail = await createItemTx(
    tx,
    walletId,
    {
      type: 'expense',
      form: remaining > 1 ? 'installment' : 'single',
      installments: remaining > 1 ? remaining : null,
      description: d.create!.description,
      categoryId: d.create!.categoryId ?? null,
      method: 'credit',
      accountId: cardId,
      amountCents: line.amountCents * remaining,
      date: line.date,
      note,
    },
    userId,
    clock,
    // "PARC n/m": a 1ª parcela importada é a n, gasta n − 1 meses depois da compra original.
    { invoiceMonth: refMonth, firstChargeMonth: parcel ? addMonths(monthOf(line.date), parcel.n - 1) : undefined },
  );
  return { action: 'created', itemId: detail.id, occurrenceId: detail.occurrences[0]?.id ?? null, month: refMonth };
}

export async function confirmImport(ctx: AppContext, walletId: string, userId: string, input: ImportConfirmInput, clock: Clock): Promise<ImportConfirmResult> {
  const payload: PreviewPayload = verifyPreview(ctx, input.token, walletId, userId);
  const byIndex = new Map<number, ImportDecision>();
  for (const d of input.decisions) {
    if (d.index >= payload.lines.length) throw lineError(d.index, 400, 'validation', 'Linha inexistente nesta prévia.');
    if (byIndex.has(d.index)) throw lineError(d.index, 400, 'validation', 'Linha decidida duas vezes.');
    byIndex.set(d.index, d);
  }
  try {
    return await ctx.db.transaction(async (tx) => {
      const account = await destinationOf(tx, walletId, input.accountId, payload.kind);
      // Uma confirmação por vez para o mesmo destino.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${walletId}:${account.id}`}))`);
      const prints = payload.lines.map((l) => fingerprintOf(walletId, account.id, l));
      const known = new Set(
        prints.length
          ? (await tx.select({ f: importLines.fingerprint }).from(importLines).where(and(eq(importLines.walletId, walletId), eq(importLines.accountId, account.id), inArray(importLines.fingerprint, prints)))).map((r) => r.f)
          : [],
      );

      // Fatura: datas do banco antes de criar itens (mudam a fatura dos itens).
      let invoice: typeof invoices.$inferSelect | null = null;
      if (payload.kind === 'invoice') {
        const bank = payload.header.invoice!;
        invoice = await ensureInvoice(tx, account, monthOf(bank.dueDate));
        const closing = bank.closingDate ?? invoice.closingDate;
        if (input.invoice?.useBankDates && invoice.status === 'open' && (closing !== invoice.closingDate || bank.dueDate !== invoice.dueDate)) {
          await updateInvoiceDatesTx(tx, walletId, invoice.id, closing, bank.dueDate, clock);
          invoice = (await tx.query.invoices.findFirst({ where: eq(invoices.id, invoice.id) }))!;
        }
      }

      const counts = { paid: 0, linked: 0, created: 0, invoicePaid: 0, ignored: 0, already: 0 };
      const months = new Set<Month>();
      const results: Array<{ line: ImportLine; print: string; r: LineResult }> = [];
      const used: Used = new Set();
      for (const line of payload.lines) {
        const d = byIndex.get(line.index);
        if (!d) continue;
        const print = prints[line.index]!;
        if (known.has(print)) {
          counts.already++;
          continue;
        }
        let r: LineResult;
        if (d.action === 'ignore') r = { action: 'ignored' };
        else if (payload.kind === 'statement') {
          if (d.action === 'match') r = await matchStatement(tx, walletId, userId, line, d, clock, used);
          else if (d.action === 'invoice_payment') r = await payInvoiceLine(tx, walletId, userId, line, d, clock, used);
          else r = await createFromStatement(tx, walletId, userId, account.id, line, d, clock);
        } else {
          if (d.action === 'invoice_payment') throw lineError(d.index, 400, 'validation', 'Numa fatura, a linha não paga outra fatura.');
          if (d.action === 'match') r = await matchInvoiceItem(tx, walletId, line, d, invoice!.id, clock);
          else {
            if (line.direction === 'credit') throw lineError(d.index, 400, 'validation', 'Créditos e estornos entram no ajuste da fatura: ignore a linha.');
            if (invoice!.status !== 'open') throw lineError(d.index, 409, 'invoice_closed', 'Esta fatura já foi paga no app: não dá para criar itens nela.');
            r = await createFromInvoice(tx, walletId, userId, account.id, invoice!.referenceMonth, line, d, clock);
          }
        }
        if (r.paymentId) used.add(r.paymentId);
        if (r.invoicePaymentId) used.add(r.invoicePaymentId);
        counts[r.action === 'invoice_paid' ? 'invoicePaid' : r.action]++;
        if (r.month) months.add(r.month);
        results.push({ line, print, r });
      }

      const [batch] = await tx
        .insert(importBatches)
        .values({
          walletId,
          accountId: account.id,
          readerId: payload.readerId,
          kind: payload.kind,
          periodStart: payload.header.periodStart,
          periodEnd: payload.header.periodEnd,
          invoiceId: invoice?.id ?? null,
          counts,
          createdBy: userId,
        })
        .returning({ id: importBatches.id });
      for (const { line, print, r } of results) {
        await tx.insert(importLines).values({
          walletId,
          batchId: batch!.id,
          accountId: account.id,
          fingerprint: print,
          lineDate: line.date,
          amountCents: line.amountCents,
          direction: line.direction,
          description: line.description,
          document: line.document,
          action: r.action,
          occurrenceId: r.occurrenceId ?? null,
          paymentId: r.paymentId ?? null,
          invoiceId: r.invoiceId ?? null,
          invoicePaymentId: r.invoicePaymentId ?? null,
          itemId: r.itemId ?? null,
        });
      }
      if (payload.header.importKey) await tx.update(accounts).set({ importKey: payload.header.importKey }).where(eq(accounts.id, account.id));
      // Fatura: o total do banco vira o valor real (o ajuste nasce no pagamento, ADR-0005).
      if (invoice && invoice.status === 'open') {
        const real = input.invoice?.realAmountCents ?? payload.header.invoice!.totalCents;
        await tx.update(invoices).set({ realAmountCents: real, version: sql`${invoices.version} + 1` }).where(eq(invoices.id, invoice.id));
        months.add(invoice.referenceMonth);
      }
      ctx.log.info({ readerId: payload.readerId, lines: results.length, ...counts }, 'importação confirmada');
      return { batchId: batch!.id, counts, months: [...months].sort() };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Esta importação já foi confirmada.', 'import_already_confirmed');
    throw e;
  }
}

