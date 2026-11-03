import { and, eq, isNull, lt, max, min, sql } from 'drizzle-orm';
import { addMonths, type Month, type MonthsRange, type Summary } from '@ff/shared';
import type { DB } from '../db/client';
import { items, occurrences } from '../db/schema';
import type { Clock } from './clock';
import { listInvoices } from './invoices';
import { listOccurrences } from './occurrences';

/**
 * Cards do mês (ADR-0004), calculados no servidor para a regra ficar num lugar só:
 * - Pago/recebido: pagamentos das ocorrências do mês fora do crédito + pagamentos das faturas do mês.
 * - A pagar/receber: restante das ocorrências do mês + saldo das faturas abertas do mês.
 * - No mês atual, os atrasados de meses anteriores somam em "a pagar" e aparecem em "em atraso".
 * - Sem saldo acumulado entre meses.
 */
export async function monthSummary(db: DB, walletId: string, month: Month, clock: Clock): Promise<Summary> {
  const [expenses, incomes, invoiceRows] = await Promise.all([
    listOccurrences(db, walletId, { month, type: 'expense' }, clock),
    listOccurrences(db, walletId, { month, type: 'income' }, clock),
    listInvoices(db, walletId, month, clock),
  ]);

  const expense = { paidCents: 0, pendingCents: 0, lateCents: 0 };
  for (const r of expenses) {
    if (r.method === 'credit') continue; // crédito entra pela fatura
    if (!r.late) expense.paidCents += r.paidCents;
    expense.pendingCents += r.remainingCents;
    if (r.late) expense.lateCents += r.remainingCents;
  }
  for (const inv of invoiceRows) {
    const open = inv.status === 'open' ? Math.max(0, inv.totalCents - inv.paidCents) : 0;
    if (inv.referenceMonth === month) expense.paidCents += inv.paidCents;
    expense.pendingCents += open;
    if (inv.late) expense.lateCents += open;
  }

  const income = { receivedCents: 0, pendingCents: 0, lateCents: 0 };
  for (const r of incomes) {
    if (!r.late) income.receivedCents += r.paidCents;
    income.pendingCents += r.remainingCents;
    if (r.late) income.lateCents += r.remainingCents;
  }

  return {
    month,
    isCurrentMonth: month === clock.currentMonth,
    income,
    expense,
    balance: {
      realizedCents: income.receivedCents - expense.paidCents,
      forecastCents: income.receivedCents + income.pendingCents - (expense.paidCents + expense.pendingCents),
    },
  };
}

/** Meses navegáveis: do primeiro com dados até 6 meses à frente ou a última parcela, o que for mais longe. */
export async function monthsRange(db: DB, walletId: string, clock: Clock): Promise<MonthsRange> {
  const [r] = await db
    .select({ first: min(occurrences.competenceMonth), last: max(occurrences.competenceMonth) })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .where(and(eq(occurrences.walletId, walletId), isNull(items.deletedAt)));
  const sixAhead = addMonths(clock.currentMonth, 6);
  const first = r?.first && r.first < clock.currentMonth ? r.first : clock.currentMonth;
  const last = r?.last && r.last > sixAhead ? r.last : sixAhead;
  return { currentMonth: clock.currentMonth, firstMonth: first, lastMonth: last };
}

/** Ocorrências em aberto com vencimento até `to` (para os avisos). */
export async function openDueOccurrences(db: DB, walletId: string, to: string) {
  return db
    .select({ occ: occurrences, item: items })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .where(
      and(
        eq(occurrences.walletId, walletId),
        isNull(items.deletedAt),
        isNull(occurrences.invoiceId),
        sql`${occurrences.status} in ('pending','partial')`,
        lt(occurrences.dueDate, sql`(${to}::date + 1)`),
      ),
    );
}
