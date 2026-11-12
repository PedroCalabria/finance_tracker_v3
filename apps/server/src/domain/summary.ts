import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { addMonths, type Month, type MonthsRange, type Summary } from '@ff/shared';
import type { DB } from '../db/client';
import { items, occurrences } from '../db/schema';
import type { Clock } from './clock';
import { debtExtraForMonth } from './debts';
import { monthInvestmentTotals } from './investments';
import { listInvoices } from './invoices';
import { listOccurrences } from './occurrences';

/**
 * Cards do mês (ADR-0004), calculados no servidor para a regra ficar num lugar só.
 * Gastos = CONSUMO pelo mês do gasto (no crédito, o do período de compras da fatura):
 * - fora do crédito: pagamentos em "pago", restante em "a pagar"; no mês atual, os atrasados de
 *   meses anteriores somam em "a pagar" e em "em atraso";
 * - no crédito: a compra inteira em "pago" se a fatura dela está paga ou encerrada; senão, "a pagar".
 *   Fatura atrasada não entra em "em atraso" (aparece no bloco de faturas);
 * - fora da conta: pagamentos de fatura (as compras já contaram no mês delas), "Saldo restante da
 *   fatura" (não é gasto novo) e canceladas. O "Ajuste da fatura" conta no mês da fatura.
 * Previsto = realizado + o que falta. Balanço previsto = entradas − gastos (consumo).
 * Balanço realizado = CAIXA ("Na conta até agora"): recebido − (pagamentos das despesas do mês
 * fora do crédito + pagamentos das faturas que vencem no mês). Sem saldo acumulado.
 * O que tem destino (ADR-0012) também entra: o previsto desconta "guardar em caixinhas" e "amortizar
 * dívidas" (só a extra: as parcelas já estão nos gastos) e soma o resgatado; o caixa usa só o realizado.
 */
export async function monthSummary(db: DB, walletId: string, month: Month, clock: Clock): Promise<Summary> {
  const [expenses, incomes, invoiceRows, inv, debt] = await Promise.all([
    listOccurrences(db, walletId, { month, type: 'expense' }, clock),
    listOccurrences(db, walletId, { month, type: 'income' }, clock),
    listInvoices(db, walletId, month, clock),
    monthInvestmentTotals(db, walletId, month, clock),
    debtExtraForMonth(db, walletId, month, clock),
  ]);

  const expense = { paidCents: 0, pendingCents: 0, lateCents: 0 };
  let cashOut = 0;
  for (const r of expenses) {
    if (r.systemKind === 'invoice_carryover' || r.displayStatus === 'canceled') continue;
    if (r.method === 'credit' || r.invoice) {
      const settled = r.invoice && (r.invoice.status === 'paid' || r.invoice.status === 'carried');
      if (settled) expense.paidCents += r.expectedCents;
      else expense.pendingCents += r.expectedCents;
      continue;
    }
    if (!r.late) {
      expense.paidCents += r.paidCents;
      cashOut += r.paidCents;
    }
    expense.pendingCents += r.remainingCents;
    if (r.late) expense.lateCents += r.remainingCents;
  }
  // Caixa: o que saiu da conta para pagar as faturas que vencem no mês.
  for (const inv of invoiceRows) if (inv.referenceMonth === month) cashOut += inv.paidCents;

  const income = { receivedCents: 0, pendingCents: 0, lateCents: 0 };
  for (const r of incomes) {
    if (!r.late) income.receivedCents += r.paidCents;
    income.pendingCents += r.remainingCents;
    if (r.late) income.lateCents += r.remainingCents;
  }

  // O previsto do mês: o que já foi realizado mais o que ainda falta.
  const incomeForecast = income.receivedCents + income.pendingCents;
  const expenseForecast = expense.paidCents + expense.pendingCents;
  // O que tem destino (ADR-0012): passados = realizado; atual e futuros = max(planejado, realizado).
  const investmentsForecast = inv.plannedCents === null ? inv.depositedCents : Math.max(inv.plannedCents, inv.depositedCents);
  const debtExtraForecast = debt.plannedCents === null ? debt.paidCents : Math.max(debt.plannedCents, debt.paidCents);
  return {
    month,
    isCurrentMonth: month === clock.currentMonth,
    income: { ...income, forecastCents: incomeForecast },
    expense: { ...expense, forecastCents: expenseForecast },
    balance: {
      realizedCents: income.receivedCents - cashOut - inv.depositedCents + inv.withdrawnCents - debt.paidCents,
      forecastCents: incomeForecast - expenseForecast - investmentsForecast + inv.withdrawnCents - debtExtraForecast,
    },
    investments: { ...inv, forecastCents: investmentsForecast },
    debtExtra: { ...debt, forecastCents: debtExtraForecast },
  };
}

/** Meses navegáveis (pelo mês do gasto e pelo da fatura): do primeiro com dados até 6 meses à frente ou a última parcela, o que for mais longe. */
export async function monthsRange(db: DB, walletId: string, clock: Clock): Promise<MonthsRange> {
  const [r] = await db
    // Mês do gasto ou da fatura, o que for mais longe (no crédito, a fatura pode vir até 2 meses depois).
    .select({
      first: sql<string | null>`min(least(${occurrences.competenceMonth}, ${occurrences.chargeMonth}))`,
      last: sql<string | null>`max(greatest(${occurrences.competenceMonth}, ${occurrences.chargeMonth}))`,
    })
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
