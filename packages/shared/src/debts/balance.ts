import { addMonths, compareDates, diffMonths, monthOf, type ISODate, type Month } from '../dates';
import { monthInterest } from './rates';
import type { BalanceAnchorLite, DebtPaymentLite } from './types';

/** Âncora vigente: a de data mais recente. */
export function currentAnchor<A extends BalanceAnchorLite>(anchors: readonly A[]): A | null {
  let best: A | null = null;
  for (const a of anchors) if (!best || compareDates(a.date, best.date) > 0) best = a;
  return best;
}

/** Saldo inicial: a âncora de data mais antiga. */
export function initialAnchor<A extends BalanceAnchorLite>(anchors: readonly A[]): A | null {
  let best: A | null = null;
  for (const a of anchors) if (!best || compareDates(a.date, best.date) < 0) best = a;
  return best;
}

/**
 * Saldo estimado numa data (ADR-0011): parte da âncora; no mês dela, subtrai os pagamentos posteriores
 * a ela; em cada mês seguinte, soma os juros do mês e depois subtrai os pagamentos do mês até a data.
 * Pagamentos com data ≤ a da âncora já estão no saldo informado. Nunca abaixo de zero.
 */
export function estimateBalance(anchor: BalanceAnchorLite, ratePpm: number, payments: readonly DebtPaymentLite[], date: ISODate): number {
  if (compareDates(date, anchor.date) <= 0) return anchor.balanceCents;
  const byMonth = new Map<Month, number>();
  for (const p of payments) {
    if (compareDates(p.date, anchor.date) <= 0 || compareDates(p.date, date) > 0) continue;
    const m = monthOf(p.date);
    byMonth.set(m, (byMonth.get(m) ?? 0) + p.amountCents);
  }
  const start = monthOf(anchor.date);
  let balance = Math.max(0, anchor.balanceCents - (byMonth.get(start) ?? 0));
  const months = diffMonths(start, monthOf(date));
  for (let k = 1; k <= months; k++) {
    const m = addMonths(start, k);
    balance += monthInterest(balance, ratePpm);
    balance = Math.max(0, balance - (byMonth.get(m) ?? 0));
  }
  return balance;
}

/** Parcelas restantes hoje: as do contrato menos os pagamentos de parcela posteriores a `contract_as_of`. */
export function remainingInstallments(remaining: number | null, contractAsOf: ISODate, payments: readonly DebtPaymentLite[]): number | null {
  if (remaining === null) return null;
  const paid = payments.filter((p) => p.kind === 'installment' && compareDates(p.date, contractAsOf) > 0).length;
  return Math.max(0, remaining - paid);
}

/** Pagamentos no mês com data posterior à da âncora (o que já abateu o obrigatório do mês atual). */
export function paidInMonthAfterAnchor(payments: readonly DebtPaymentLite[], anchorDate: ISODate, month: Month): number {
  let sum = 0;
  for (const p of payments) if (monthOf(p.date) === month && compareDates(p.date, anchorDate) > 0) sum += p.amountCents;
  return sum;
}

/** Orçamento vigente no mês: a vigência de mês mais recente ≤ ele. */
export function budgetFor(budgets: readonly { fromMonth: Month; amountCents: number }[], month: Month): number | null {
  let best: { fromMonth: Month; amountCents: number } | null = null;
  for (const b of budgets) if (b.fromMonth <= month && (!best || b.fromMonth > best.fromMonth)) best = b;
  return best ? best.amountCents : null;
}
