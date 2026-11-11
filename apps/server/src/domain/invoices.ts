import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import {
  addDays,
  addMonths,
  compareDates,
  defaultInvoiceDates,
  formatMonthShort,
  type InvoicePaymentInput,
  type InvoiceRow,
  type ISODate,
  type Month,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { accounts, attachments, invoicePayments, invoices, items, occurrences } from '../db/schema';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import type { Clock } from './clock';
import { ensureInvoice, invoiceMonthFor } from './invoice-core';
import { projectedCreditCharges } from './projections';

/**
 * Etapa 5 — faturas (ADR-0005). Uma fatura por cartão e mês de vencimento.
 * Status gravado: open | paid | carried (parcialmente paga, saldo transferido).
 */

type InvoiceRec = typeof invoices.$inferSelect;

export { ensureInvoice, invoiceMonthFor };

export async function previewInvoice(tx: Tx, walletId: string, accountId: string, date: ISODate) {
  const account = await tx.query.accounts.findFirst({ where: and(eq(accounts.id, accountId), eq(accounts.walletId, walletId)) });
  if (!account || account.kind !== 'credit_card') throw badRequest('Escolha um cartão de crédito.');
  const referenceMonth = await invoiceMonthFor(tx, account, date);
  const existing = await tx.query.invoices.findFirst({ where: and(eq(invoices.accountId, account.id), eq(invoices.referenceMonth, referenceMonth)) });
  const d = existing ?? defaultInvoiceDates(referenceMonth, account.closingDay!, account.dueDay!);
  return { referenceMonth, closingDate: d.closingDate, dueDate: d.dueDate };
}

/** Soma dos itens de uma fatura (ocorrências não canceladas, ajuste incluído). */
export async function itemsSum(tx: Tx, invoiceId: string): Promise<{ cents: number; count: number }> {
  const [r] = await tx
    .select({ cents: sql<number>`coalesce(sum(${occurrences.expectedCents}), 0)::int`, count: sql<number>`count(*)::int` })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .where(and(eq(occurrences.invoiceId, invoiceId), ne(occurrences.status, 'canceled'), isNull(items.deletedAt)));
  return { cents: r?.cents ?? 0, count: r?.count ?? 0 };
}

async function paidSum(tx: Tx, invoiceId: string): Promise<number> {
  const [r] = await tx
    .select({ cents: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)::int` })
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId));
  return r?.cents ?? 0;
}

/**
 * Faturas de um mês: uma por cartão ativo (criadas sob demanda), mais as em atraso
 * de meses anteriores quando o mês é o atual. Totais incluem recorrentes projetadas.
 */
export async function listInvoices(db: DB, walletId: string, month: Month, clock: Clock): Promise<InvoiceRow[]> {
  const cards = await db.query.accounts.findMany({
    where: and(eq(accounts.walletId, walletId), eq(accounts.kind, 'credit_card'), isNull(accounts.archivedAt)),
  });
  for (const card of cards) await ensureInvoice(db, card, month);

  const conds = [eq(invoices.walletId, walletId), eq(invoices.referenceMonth, month)];
  let recs = await db.query.invoices.findMany({ where: and(...conds), orderBy: asc(invoices.dueDate) });
  // Cartões arquivados só aparecem se a fatura tiver itens.
  if (month === clock.currentMonth) {
    const late = await db.query.invoices.findMany({
      where: and(eq(invoices.walletId, walletId), lt(invoices.referenceMonth, month), eq(invoices.status, 'open'), lt(invoices.dueDate, clock.today)),
      orderBy: asc(invoices.dueDate),
    });
    recs = [...late, ...recs];
  }
  const projections = month > clock.currentMonth ? await projectedCreditCharges(db, walletId, month, clock) : [];
  const out: InvoiceRow[] = [];
  for (const inv of recs) {
    const row = await toInvoiceRow(db, inv, clock, projections.filter((p) => p.accountId === inv.accountId).reduce((s, p) => s + p.expectedCents, 0));
    const archived = !cards.some((c) => c.id === inv.accountId);
    if (row.late && row.itemsCents === 0 && row.paidCents === 0) continue; // fatura vazia vencida não é atraso
    if (archived && row.itemCount === 0) continue;
    out.push(row);
  }
  return out;
}

export async function toInvoiceRow(tx: Tx, inv: InvoiceRec, clock: Clock, projectedCents = 0): Promise<InvoiceRow> {
  const account = (await tx.query.accounts.findFirst({ where: eq(accounts.id, inv.accountId) }))!;
  const sum = await itemsSum(tx, inv.id);
  const pays = await tx.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, inv.id), orderBy: asc(invoicePayments.paidAt) });
  const atts = pays.length
    ? await tx.query.attachments.findMany({ where: and(inArray(attachments.invoicePaymentId, pays.map((p) => p.id)), isNull(attachments.deletedAt)) })
    : [];
  const itemsCents = sum.cents + projectedCents;
  const paidCents = pays.reduce((s, p) => s + p.amountCents, 0);
  let carriedToMonth: Month | null = null;
  if (inv.carriedToInvoiceId) {
    const next = await tx.query.invoices.findFirst({ where: eq(invoices.id, inv.carriedToInvoiceId), columns: { referenceMonth: true } });
    carriedToMonth = next?.referenceMonth ?? null;
  }
  // Período das compras: do fechamento da fatura anterior (gravada ou padrão) até a véspera deste.
  const prevMonth = addMonths(inv.referenceMonth, -1);
  const prev = await tx.query.invoices.findFirst({ where: and(eq(invoices.accountId, inv.accountId), eq(invoices.referenceMonth, prevMonth)), columns: { closingDate: true } });
  const purchasesFrom = prev?.closingDate ?? defaultInvoiceDates(prevMonth, account.closingDay!, account.dueDay!).closingDate;
  return {
    id: inv.id,
    account: { id: account.id, name: account.name, bank: account.bank },
    referenceMonth: inv.referenceMonth,
    closingDate: inv.closingDate,
    dueDate: inv.dueDate,
    purchasesFrom,
    purchasesTo: addDays(inv.closingDate, -1),
    status: inv.status,
    late: inv.status === 'open' && compareDates(inv.dueDate, clock.today) < 0 && itemsCents - paidCents > 0,
    itemsCents,
    realAmountCents: inv.realAmountCents,
    totalCents: itemsCents,
    paidCents,
    itemCount: sum.count,
    payments: pays.map((p) => ({
      id: p.id,
      paidAt: p.paidAt,
      amountCents: p.amountCents,
      attachments: atts.filter((a) => a.invoicePaymentId === p.id).map((a) => ({ id: a.id, name: a.name, mime: a.mime, sizeBytes: a.sizeBytes })),
    })),
    carriedToMonth,
  };
}

async function getInvoiceChecked(tx: Tx, walletId: string, id: string): Promise<InvoiceRec> {
  const inv = await tx.query.invoices.findFirst({ where: and(eq(invoices.id, id), eq(invoices.walletId, walletId)) });
  if (!inv) throw notFound('Fatura');
  return inv;
}

/** Item de sistema único, no crédito, preso a uma fatura (ajuste ou saldo transferido). */
async function createSystemItem(
  tx: Tx,
  inv: InvoiceRec,
  kind: 'invoice_adjustment' | 'invoice_carryover',
  description: string,
  cents: number,
  sourceInvoiceId: string,
  userId: string,
): Promise<void> {
  const [it] = await tx
    .insert(items)
    .values({
      walletId: inv.walletId,
      type: 'expense',
      form: 'single',
      description,
      method: 'credit',
      accountId: inv.accountId,
      amountCents: cents,
      entryDate: inv.closingDate,
      startMonth: inv.referenceMonth,
      systemKind: kind,
      sourceInvoiceId,
      createdBy: userId,
    })
    .returning();
  await tx.insert(occurrences).values({
    walletId: inv.walletId,
    itemId: it!.id,
    competenceMonth: inv.referenceMonth,
    // Mês do gasto = o da fatura: o ajuste (juros, tarifas) é gasto daquele mês; o saldo
    // transferido não é gasto novo e fica fora do consumo pelo `system_kind` (ADR-0005).
    chargeMonth: inv.referenceMonth,
    expectedCents: cents,
    dueDate: inv.dueDate,
    invoiceId: inv.id,
  });
}

/** Ajuste = valor real − soma dos itens lançados. Um por fatura, recalculado a cada pagamento. */
async function syncAdjustment(tx: Tx, inv: InvoiceRec, realAmountCents: number, userId: string): Promise<void> {
  const existing = await tx.query.items.findFirst({
    where: and(eq(items.sourceInvoiceId, inv.id), eq(items.systemKind, 'invoice_adjustment'), isNull(items.deletedAt)),
  });
  if (existing) await tx.delete(items).where(eq(items.id, existing.id));
  const diff = realAmountCents - (await itemsSum(tx, inv.id)).cents;
  if (diff !== 0) await createSystemItem(tx, inv, 'invoice_adjustment', 'Ajuste da fatura', diff, inv.id, userId);
}

export async function payInvoice(db: DB, walletId: string, invoiceId: string, input: InvoicePaymentInput, userId: string, clock: Clock): Promise<InvoiceRow> {
  return db.transaction((tx) => payInvoiceTx(tx, walletId, invoiceId, input, userId, clock));
}

/** Mesma regra de `payInvoice`, dentro de uma transação já aberta (importação, ADR-0010). */
export async function payInvoiceTx(tx: Tx, walletId: string, invoiceId: string, input: InvoicePaymentInput, userId: string, clock: Clock): Promise<InvoiceRow> {
  const inv = await getInvoiceChecked(tx, walletId, invoiceId);
  if (inv.status !== 'open') {
    throw new AppError(409, 'invoice_closed', inv.status === 'paid' ? 'Esta fatura já está paga.' : 'Esta fatura foi encerrada e o saldo foi para a próxima.');
  }
  if (input.realAmountCents < 0) throw badRequest('O valor da fatura não pode ser negativo.');
  await syncAdjustment(tx, inv, input.realAmountCents, userId);
  const [pay] = await tx
    .insert(invoicePayments)
    .values({ walletId, invoiceId: inv.id, paidAt: input.paidAt, amountCents: input.amountCents, paidBy: userId })
    .returning();
  if (input.attachmentIds?.length) await linkAttachments(tx, walletId, input.attachmentIds, { invoicePaymentId: pay!.id });

  const total = input.realAmountCents;
  const paid = await paidSum(tx, inv.id);
  let status: InvoiceRec['status'] = 'paid';
  let carriedTo: string | null = null;
  if (paid < total) {
    // Parcialmente paga: o restante vira item na fatura seguinte e esta é encerrada.
    const account = (await tx.query.accounts.findFirst({ where: eq(accounts.id, inv.accountId) }))!;
    const next = await ensureInvoice(tx, account, addMonths(inv.referenceMonth, 1));
    const label = `Saldo restante da fatura ${formatMonthShort(inv.referenceMonth, true)} · ${account.name}`;
    await createSystemItem(tx, next, 'invoice_carryover', label, total - paid, inv.id, userId);
    status = 'carried';
    carriedTo = next.id;
  }
  const [updated] = await tx
    .update(invoices)
    .set({ realAmountCents: total, status, carriedToInvoiceId: carriedTo, version: sql`${invoices.version} + 1` })
    .where(eq(invoices.id, inv.id))
    .returning();
  return toInvoiceRow(tx, updated!, clock);
}

/** Desfazer um pagamento de fatura reabre a fatura e remove o saldo transferido. */
export async function deleteInvoicePayment(db: DB, walletId: string, paymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const pay = await tx.query.invoicePayments.findFirst({ where: and(eq(invoicePayments.id, paymentId), eq(invoicePayments.walletId, walletId)) });
    if (!pay) throw notFound('Pagamento');
    const inv = (await tx.query.invoices.findFirst({ where: eq(invoices.id, pay.invoiceId) }))!;
    if (inv.carriedToInvoiceId) {
      const next = await tx.query.invoices.findFirst({ where: eq(invoices.id, inv.carriedToInvoiceId) });
      if (next && next.status !== 'open') throw conflict('Desfaça primeiro o pagamento da fatura seguinte, que já inclui este saldo.');
      await tx.delete(items).where(and(eq(items.sourceInvoiceId, inv.id), eq(items.systemKind, 'invoice_carryover')));
    }
    await tx.update(attachments).set({ invoicePaymentId: null, deletedAt: new Date() }).where(eq(attachments.invoicePaymentId, pay.id));
    await tx.delete(invoicePayments).where(eq(invoicePayments.id, pay.id));
    const remaining = await paidSum(tx, inv.id);
    const total = inv.realAmountCents ?? (await itemsSum(tx, inv.id)).cents;
    const status = remaining >= total && remaining > 0 ? 'paid' : 'open';
    // Fatura reaberta volta a somar só o que foi lançado: o ajuste nasce de novo no próximo pagamento.
    if (status === 'open') await tx.delete(items).where(and(eq(items.sourceInvoiceId, inv.id), eq(items.systemKind, 'invoice_adjustment')));
    await tx
      .update(invoices)
      .set({ status, carriedToInvoiceId: null, version: sql`${invoices.version} + 1` })
      .where(eq(invoices.id, inv.id));
  });
}

export async function updateInvoicePaymentDate(db: DB, walletId: string, paymentId: string, paidAt: ISODate): Promise<void> {
  const r = await db
    .update(invoicePayments)
    .set({ paidAt })
    .where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.walletId, walletId)))
    .returning({ id: invoicePayments.id });
  if (r.length === 0) throw notFound('Pagamento');
}

/** Ajusta fechamento e vencimento só deste mês; os itens da fatura acompanham o vencimento. */
export async function updateInvoiceDates(db: DB, walletId: string, invoiceId: string, closingDate: ISODate, dueDate: ISODate, clock: Clock): Promise<InvoiceRow> {
  return db.transaction((tx) => updateInvoiceDatesTx(tx, walletId, invoiceId, closingDate, dueDate, clock));
}

/** Mesma regra de `updateInvoiceDates`, dentro de uma transação já aberta (importação, ADR-0010). */
export async function updateInvoiceDatesTx(tx: Tx, walletId: string, invoiceId: string, closingDate: ISODate, dueDate: ISODate, clock: Clock): Promise<InvoiceRow> {
  if (compareDates(closingDate, dueDate) >= 0) throw badRequest('O fechamento precisa ser antes do vencimento.');
  const inv = await getInvoiceChecked(tx, walletId, invoiceId);
  const [u] = await tx
    .update(invoices)
    .set({ closingDate, dueDate, version: sql`${invoices.version} + 1` })
    .where(eq(invoices.id, inv.id))
    .returning();
  await tx.update(occurrences).set({ dueDate }).where(eq(occurrences.invoiceId, inv.id));
  return toInvoiceRow(tx, u!, clock);
}

/** Mover um item para outra fatura do mesmo cartão (quando o banco considerou diferente). */
export async function moveToInvoice(tx: Tx, walletId: string, occurrenceId: string, referenceMonth: Month): Promise<void> {
  const occ = await tx.query.occurrences.findFirst({ where: and(eq(occurrences.id, occurrenceId), eq(occurrences.walletId, walletId)) });
  if (!occ) throw notFound('Lançamento');
  if (!occ.invoiceId) throw badRequest('Só lançamentos no crédito ficam em fatura.');
  const from = (await tx.query.invoices.findFirst({ where: eq(invoices.id, occ.invoiceId) }))!;
  if (from.status !== 'open') throw conflict('A fatura de origem já foi paga ou encerrada.');
  const account = (await tx.query.accounts.findFirst({ where: eq(accounts.id, from.accountId) }))!;
  const target = await ensureInvoice(tx, account, referenceMonth);
  if (target.status !== 'open') throw conflict('A fatura de destino já foi paga ou encerrada.');
  const item = (await tx.query.items.findFirst({ where: eq(items.id, occ.itemId) }))!;
  if (item.form === 'recurring') {
    const clash = await tx.query.occurrences.findFirst({
      where: and(eq(occurrences.itemId, item.id), eq(occurrences.competenceMonth, referenceMonth), isNull(occurrences.installmentNumber)),
    });
    if (clash) throw conflict('Esse lançamento recorrente já tem uma ocorrência nessa fatura.');
  }
  await tx
    .update(occurrences)
    .set({ invoiceId: target.id, competenceMonth: referenceMonth, dueDate: target.dueDate, version: sql`${occurrences.version} + 1` })
    .where(eq(occurrences.id, occ.id));
}

export async function linkAttachments(
  tx: Tx,
  walletId: string,
  ids: string[],
  link: { paymentGroupId?: string; invoicePaymentId?: string },
): Promise<void> {
  const found = await tx.query.attachments.findMany({
    where: and(inArray(attachments.id, ids), eq(attachments.walletId, walletId), isNull(attachments.deletedAt)),
  });
  if (found.length !== ids.length) throw badRequest('Comprovante não encontrado. Envie o arquivo de novo.');
  if (found.some((a) => a.paymentGroupId || a.invoicePaymentId)) throw badRequest('Esse comprovante já está ligado a outro pagamento.');
  await tx.update(attachments).set(link).where(inArray(attachments.id, ids));
}

/** Faturas abertas e vencidas antes de hoje, com saldo (para o resumo e os avisos). */
export async function openInvoicesDueBetween(tx: Tx, walletId: string, from: ISODate | null, to: ISODate) {
  return tx.query.invoices.findMany({
    where: and(eq(invoices.walletId, walletId), eq(invoices.status, 'open'), lte(invoices.dueDate, to), from ? gte(invoices.dueDate, from) : undefined),
  });
}

export const _test = { itemsSum, paidSum };
export const newGroupId = () => randomUUID();
