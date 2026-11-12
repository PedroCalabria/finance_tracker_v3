import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { addMonths, dateInMonth, defaultInvoiceDates, invoiceChargeMonth, invoiceMonthForPurchase, type ISODate, type Month } from '@ff/shared';
import type { Tx } from '../db/client';
import { accounts, invoices, items, occurrences, payments } from '../db/schema';
import { badRequest, notFound } from '../http/errors';
import type { Clock } from './clock';
import { ensureInvoice } from './invoice-core';

/**
 * Recorrentes sem fim (ADR-0004): cobranças até o mês atual são GRAVADAS
 * (preguiçosamente, na primeira leitura do mês), mesmo que a fatura delas seja de um
 * mês futuro; cobranças futuras são PROJEÇÕES calculadas da regra, com id
 * "p_<itemId>_<mês da fatura/competência>", gravadas quando alguém mexe nelas.
 *
 * No crédito há três meses por cobrança: o da regra (dia `entryDate` em cada mês), o do
 * gasto (período de compras da fatura, ADR-0005) e o da fatura. Uma cobrança é gravada
 * quando o mês da regra ou o do gasto chega.
 */

type ItemRec = typeof items.$inferSelect;
type AccountRec = typeof accounts.$inferSelect;

export interface Slot {
  /** Mês da cobrança na regra (dia `entryDate` no crédito); entre `startMonth` e `endMonth`. */
  ruleMonth: Month;
  /** Mês do gasto: fora do crédito, o da regra; no crédito, o do período de compras da fatura. */
  chargeMonth: Month;
  competenceMonth: Month;
  dueDate: ISODate | null;
}

const PROJECTION_RE = /^p_([0-9a-f-]{36})_(\d{4}-\d{2})$/i;
export const projectionId = (itemId: string, month: Month) => `p_${itemId}_${month}`;
export function parseProjectionId(id: string): { itemId: string; month: Month } | null {
  const m = PROJECTION_RE.exec(id);
  return m ? { itemId: m[1]!, month: m[2]! } : null;
}

/** Onde cai a cobrança de um mês (da regra) de uma recorrente. */
export function slotFor(item: ItemRec, account: AccountRec | null, ruleMonth: Month, overrides: Map<Month, { closingDate: ISODate; dueDate: ISODate }>): Slot {
  if (item.method === 'credit' && account?.kind === 'credit_card') {
    const chargeDate = dateInMonth(ruleMonth, Number(item.entryDate.slice(8, 10)));
    const inv = invoiceMonthForPurchase(chargeDate, account.closingDay!, account.dueDay!, overrides);
    const d = overrides.get(inv) ?? defaultInvoiceDates(inv, account.closingDay!, account.dueDay!);
    const chargeMonth = invoiceChargeMonth(inv, account.closingDay!, account.dueDay!, overrides);
    return { ruleMonth, chargeMonth, competenceMonth: inv, dueDate: d.dueDate };
  }
  return { ruleMonth, chargeMonth: ruleMonth, competenceMonth: ruleMonth, dueDate: item.dueDay ? dateInMonth(ruleMonth, item.dueDay) : null };
}

/** A cobrança já chegou (mês da regra ou do gasto até o mês atual): é gravada, não projetada. */
const isDue = (slot: Slot, clock: Clock) => slot.ruleMonth <= clock.currentMonth || slot.chargeMonth <= clock.currentMonth;

export async function invoiceOverrides(tx: Tx, accountId: string | null) {
  if (!accountId) return new Map<Month, { closingDate: ISODate; dueDate: ISODate }>();
  const rows = await tx.query.invoices.findMany({ where: eq(invoices.accountId, accountId), columns: { referenceMonth: true, closingDate: true, dueDate: true } });
  return new Map(rows.map((r) => [r.referenceMonth, { closingDate: r.closingDate, dueDate: r.dueDate }]));
}

/** Valor do próximo mês: fixo = regra; variável = último valor pago (ou a regra, se nunca pago). */
export async function nextAmount(tx: Tx, item: ItemRec): Promise<number> {
  if (!item.variableAmount) return item.amountCents!;
  const [last] = await tx
    .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(occurrences)
    .innerJoin(payments, eq(payments.occurrenceId, occurrences.id))
    .where(and(eq(occurrences.itemId, item.id), eq(occurrences.status, 'paid')))
    .groupBy(occurrences.id, occurrences.competenceMonth)
    .orderBy(desc(occurrences.competenceMonth))
    .limit(1);
  return last?.paid || item.amountCents!;
}

async function activeRecurring(tx: Tx, walletId: string): Promise<ItemRec[]> {
  return tx.query.items.findMany({ where: and(eq(items.walletId, walletId), eq(items.form, 'recurring'), isNull(items.deletedAt)) });
}

/** Meses da regra de uma recorrente entre dois meses, respeitando início e fim. */
function ruleMonths(item: ItemRec, from: Month, to: Month): Month[] {
  const out: Month[] = [];
  let m = from < item.startMonth ? item.startMonth : from;
  const end = item.endMonth && item.endMonth < to ? item.endMonth : to;
  while (m <= end) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

/**
 * Mês da regra que gerou a ocorrência de competência `month`. Fora do crédito
 * são o mesmo mês; no crédito, a cobrança pode cair até 2 meses antes da fatura.
 * Se nenhuma cobrança da regra cai nessa fatura (ocorrência movida à mão), vale o próprio mês.
 */
export async function ruleMonthFor(tx: Tx, item: ItemRec, month: Month): Promise<Month> {
  if (item.method !== 'credit' || !item.accountId) return month;
  const account = (await tx.query.accounts.findFirst({ where: eq(accounts.id, item.accountId) })) ?? null;
  const overrides = await invoiceOverrides(tx, item.accountId);
  for (let k = 2; k >= 0; k--) {
    const c = addMonths(month, -k);
    if (c >= item.startMonth && slotFor(item, account, c, overrides).competenceMonth === month) return c;
  }
  return month;
}

/**
 * Grava as ocorrências de recorrentes cuja cobrança já chegou (`isDue`), inclusive no
 * crédito com fatura futura. Idempotente: roda em toda leitura de mês e no job de avisos.
 */
export async function ensureMaterialized(tx: Tx, walletId: string, clock: Clock): Promise<void> {
  const recs = await activeRecurring(tx, walletId);
  for (const item of recs) {
    // No crédito, a cobrança do mês seguinte pode ter o mês do gasto no mês atual.
    const until = addMonths(clock.currentMonth, 1);
    if (item.startMonth > until) continue;
    const existing = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id), columns: { competenceMonth: true } });
    const have = new Set(existing.map((e) => e.competenceMonth));
    const account = item.accountId ? ((await tx.query.accounts.findFirst({ where: eq(accounts.id, item.accountId) })) ?? null) : null;
    const overrides = await invoiceOverrides(tx, item.method === 'credit' ? item.accountId : null);
    for (const m of ruleMonths(item, item.startMonth, until)) {
      const slot = slotFor(item, account, m, overrides);
      if (!isDue(slot, clock) || have.has(slot.competenceMonth)) continue;
      await insertSlot(tx, item, account, slot);
      have.add(slot.competenceMonth);
    }
  }
}

async function insertSlot(tx: Tx, item: ItemRec, account: AccountRec | null, slot: Slot): Promise<string> {
  let invoiceId: string | null = null;
  if (item.method === 'credit' && account?.kind === 'credit_card') {
    invoiceId = (await ensureInvoice(tx, account, slot.competenceMonth)).id;
  }
  const expectedCents = await nextAmount(tx, item);
  const [row] = await tx
    .insert(occurrences)
    .values({ walletId: item.walletId, itemId: item.id, competenceMonth: slot.competenceMonth, chargeMonth: slot.chargeMonth, expectedCents, dueDate: slot.dueDate, invoiceId })
    .onConflictDoNothing()
    .returning({ id: occurrences.id });
  if (row) return row.id;
  const found = await tx.query.occurrences.findFirst({
    where: and(eq(occurrences.itemId, item.id), eq(occurrences.competenceMonth, slot.competenceMonth), isNull(occurrences.installmentNumber)),
  });
  return found!.id;
}

export interface ProjectedSlot extends Slot {
  item: ItemRec;
  account: AccountRec | null;
  expectedCents: number;
}

/**
 * Projeções (não gravadas) de recorrentes num mês futuro.
 * - `by: 'charge'` (tabela): as cobranças cujo mês do gasto é `month`;
 * - `by: 'competence'` (faturas, id da projeção): as que caem na fatura/competência `month`.
 * Cobranças até o mês atual já estão gravadas (`ensureMaterialized`).
 */
export async function projectionsFor(tx: Tx, walletId: string, month: Month, clock: Clock, by: 'charge' | 'competence' = 'competence'): Promise<ProjectedSlot[]> {
  if (month <= clock.currentMonth) return [];
  const out: ProjectedSlot[] = [];
  for (const item of await activeRecurring(tx, walletId)) {
    // No crédito, o mês do gasto fica a até um mês do da regra, e a fatura até 2 meses depois da regra.
    const months = by === 'charge' ? ruleMonths(item, addMonths(month, -1), addMonths(month, 1)) : ruleMonths(item, addMonths(month, -2), month);
    if (months.length === 0) continue;
    const account = item.accountId ? ((await tx.query.accounts.findFirst({ where: eq(accounts.id, item.accountId) })) ?? null) : null;
    const overrides = await invoiceOverrides(tx, item.method === 'credit' ? item.accountId : null);
    for (const m of months) {
      const slot = slotFor(item, account, m, overrides);
      if ((by === 'competence' ? slot.competenceMonth : slot.chargeMonth) !== month) continue;
      if (isDue(slot, clock)) continue; // já gravada
      const exists = await tx.query.occurrences.findFirst({
        where: and(eq(occurrences.itemId, item.id), eq(occurrences.competenceMonth, slot.competenceMonth), isNull(occurrences.installmentNumber)),
        columns: { id: true },
      });
      if (exists) continue;
      out.push({ ...slot, item, account, expectedCents: await nextAmount(tx, item) });
    }
  }
  return out;
}

export async function projectedCreditCharges(tx: Tx, walletId: string, month: Month, clock: Clock) {
  return (await projectionsFor(tx, walletId, month, clock))
    .filter((p) => p.item.method === 'credit' && p.account)
    .map((p) => ({ accountId: p.account!.id, expectedCents: p.expectedCents }));
}

/** Grava uma projeção quando alguém mexe nela (edita ou paga adiantado). Devolve o id real. */
export async function materializeProjection(tx: Tx, walletId: string, id: string, clock: Clock): Promise<string> {
  const p = parseProjectionId(id);
  if (!p) return id;
  const item = await tx.query.items.findFirst({ where: and(eq(items.id, p.itemId), eq(items.walletId, walletId), isNull(items.deletedAt)) });
  if (!item || item.form !== 'recurring') throw notFound('Lançamento');
  const slots = (await projectionsFor(tx, walletId, p.month, clock)).filter((s) => s.item.id === item.id);
  const existing = await tx.query.occurrences.findFirst({
    where: and(eq(occurrences.itemId, item.id), eq(occurrences.competenceMonth, p.month), isNull(occurrences.installmentNumber)),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const slot = slots[0];
  if (!slot) throw badRequest('Esse mês não tem ocorrência desse lançamento.');
  return insertSlot(tx, item, slot.account, slot);
}
