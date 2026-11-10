import { addMonths, type Month } from '../dates';
import { formatBRL } from '../money';
import { revolvingMinimum, sacAmortization } from './contract';
import { budgetFor } from './balance';
import { monthInterest } from './rates';
import type { DebtBudgetEntry, DebtTerms } from './types';

export const MAX_SIMULATION_MONTHS = 600;
/** Teto do saldo simulado: uma dívida que não diminui não pode estourar o inteiro exato (saldo × ppm). */
const BALANCE_CAP = Math.floor(Number.MAX_SAFE_INTEGER / 1e6);

/** Uma dívida ativa na simulação, já na ordem da estratégia. */
export interface SimDebt extends DebtTerms {
  id: string;
  name: string;
  /** Saldo estimado hoje (já com os juros do mês atual). */
  balanceCents: number;
  acceptsExtra: boolean;
  /** Pagamentos dela no mês atual depois da âncora vigente (abatem o obrigatório do mês 0). */
  paidThisMonthCents: number;
}

export interface SimInput {
  /** Na ordem de prioridade. */
  debts: readonly SimDebt[];
  budgets: readonly DebtBudgetEntry[];
  currentMonth: Month;
  /** Destinado no mês atual (todos os pagamentos de dívidas do mês). */
  spentThisMonthCents: number;
  /** "Só o mínimo": paga apenas os obrigatórios, sem destinar sobra. */
  minimumOnly?: boolean;
  withTimeline?: boolean;
  maxMonths?: number;
}

export type DebtWarning =
  | { code: 'budget_short'; message: string; budgetCents: number; requiredCents: number }
  | { code: 'not_decreasing'; message: string; debtId: string }
  | { code: 'no_budget'; message: string }
  | { code: 'never_paid_off'; message: string; debtIds: string[] };

export interface SimDebtResult {
  id: string;
  payoffMonth: Month | null;
  interestCents: number;
  /** Saldo no fim de cada mês, a partir do mês atual. */
  timeline?: number[];
}

export interface SimResult {
  payoffMonth: Month | null;
  totalInterestCents: number;
  perDebt: SimDebtResult[];
  warnings: DebtWarning[];
  /**
   * Amortização extra aplicada em cada mês (índice 0 = mês atual): a sobra do orçamento depois dos
   * obrigatórios, em cascata e limitada aos saldos. Depois da última quitação, os meses não aparecem (= 0).
   */
  extraByMonth: number[];
}

interface State {
  d: SimDebt;
  balance: number;
  /** SAC: amortização constante, calculada no início. */
  sacA: number;
  interest: number;
  payoff: Month | null;
  timeline: number[];
}

/** Obrigatório do mês sobre o saldo já com juros (`interest` = juros deste mês), nunca maior que o saldo. */
function obligatory(s: State, balance: number, interest: number): number {
  if (balance <= 0) return 0;
  const { d } = s;
  let due: number;
  switch (d.structure) {
    case 'price':
      due = d.installmentCents ?? 0;
      break;
    case 'sac':
      due = s.sacA + interest;
      break;
    case 'revolving':
      due = revolvingMinimum(balance, d.minPaymentKind, d.minPaymentValue);
      break;
    case 'interest_free':
      due = d.installmentCents ?? 0;
      break;
  }
  return Math.min(Math.max(0, due), balance);
}

/** Juros que já estão no saldo do mês atual (inverso de saldo × (1 + i)), para a parcela do SAC no mês 0. */
const interestInside = (balance: number, ppm: number) => (ppm > 0 ? Math.round((balance * ppm) / (1e6 + ppm)) : 0);

/** Distribui a sobra em cascata e devolve quanto foi aplicado. */
function distribute(states: State[], extra: number): number {
  let applied = 0;
  for (const s of states) {
    if (extra <= 0) break;
    if (!s.d.acceptsExtra || s.balance <= 0) continue;
    const take = Math.min(extra, s.balance);
    s.balance -= take;
    extra -= take;
    applied += take;
  }
  return applied;
}

/**
 * Simulação mês a mês (ADR-0011). Mês 0 (atual): sem juros (o saldo estimado já os tem); cada dívida paga o
 * obrigatório que falta; sobra = orçamento − destinado − obrigatórios restantes. Meses seguintes: juros,
 * obrigatórios, sobra = orçamento − obrigatórios, em cascata na ordem, pulando quem não aceita extra.
 * A parcela de uma dívida quitada aumenta a sobra (bola de neve). Price/SAC reduzem o prazo.
 */
export function simulatePlan(input: SimInput): SimResult {
  const maxMonths = input.maxMonths ?? MAX_SIMULATION_MONTHS;
  const states: State[] = input.debts
    .filter((d) => d.balanceCents > 0)
    .map((d) => ({ d, balance: d.balanceCents, sacA: sacAmortization(d.balanceCents, d.remainingInstallments), interest: 0, payoff: null, timeline: [] }));
  const warnings: DebtWarning[] = [];

  // Avisos sobre a situação de hoje.
  const budget0 = budgetFor(input.budgets, input.currentMonth);
  if (budget0 === null) warnings.push({ code: 'no_budget', message: 'Defina quanto você consegue destinar às dívidas por mês.' });
  let required0 = 0;
  for (const s of states) {
    required0 += obligatory(s, s.balance, interestInside(s.balance, s.d.monthlyRatePpm));
    const next = monthInterest(s.balance, s.d.monthlyRatePpm);
    if (next > 0 && obligatory(s, s.balance + next, next) <= next) {
      warnings.push({ code: 'not_decreasing', debtId: s.d.id, message: `O pagamento de ${s.d.name} não cobre os juros: o saldo não diminui.` });
    }
  }
  if (budget0 !== null && required0 > budget0) {
    warnings.push({
      code: 'budget_short',
      budgetCents: budget0,
      requiredCents: required0,
      message: `O orçamento de ${formatBRL(budget0)} não cobre as parcelas e mínimos (${formatBRL(required0)}).`,
    });
  }

  const record = (month: Month) => {
    for (const s of states) {
      if (s.balance <= 0 && s.payoff === null) s.payoff = month;
      if (input.withTimeline) s.timeline.push(s.balance);
    }
  };
  const active = () => states.some((s) => s.balance > 0);

  // Mês 0.
  let month = input.currentMonth;
  let paid0 = 0;
  for (const s of states) {
    const due = obligatory(s, s.balance, interestInside(s.balance, s.d.monthlyRatePpm));
    const pay = Math.min(Math.max(0, due - s.d.paidThisMonthCents), s.balance);
    s.balance -= pay;
    paid0 += pay;
  }
  const extraByMonth: number[] = [];
  extraByMonth.push(!input.minimumOnly && budget0 !== null ? distribute(states, budget0 - input.spentThisMonthCents - paid0) : 0);
  record(month);

  // Meses seguintes.
  for (let k = 1; k < maxMonths && active(); k++) {
    month = addMonths(input.currentMonth, k);
    let paid = 0;
    for (const s of states) {
      if (s.balance <= 0) continue;
      const interest = monthInterest(s.balance, s.d.monthlyRatePpm);
      const grown = Math.min(s.balance + interest, BALANCE_CAP);
      s.interest += grown - s.balance;
      s.balance = grown;
      const pay = obligatory(s, s.balance, interest);
      s.balance -= pay;
      paid += pay;
    }
    const budget = budgetFor(input.budgets, month);
    extraByMonth.push(!input.minimumOnly && budget !== null ? distribute(states, budget - paid) : 0);
    record(month);
  }

  const perDebt = states.map((s) => ({
    id: s.d.id,
    payoffMonth: s.payoff,
    interestCents: s.interest,
    ...(input.withTimeline ? { timeline: s.timeline } : {}),
  }));
  const unpaid = perDebt.filter((p) => p.payoffMonth === null).map((p) => p.id);
  if (unpaid.length) warnings.push({ code: 'never_paid_off', debtIds: unpaid, message: 'Há dívidas que não quitam com este orçamento em 50 anos.' });
  const payoffMonth = unpaid.length ? null : perDebt.reduce<Month | null>((max, p) => (max === null || (p.payoffMonth ?? '') > max ? p.payoffMonth : max), null);
  return {
    payoffMonth: perDebt.length ? payoffMonth : input.currentMonth,
    totalInterestCents: perDebt.reduce((sum, p) => sum + p.interestCents, 0),
    perDebt,
    warnings,
    extraByMonth,
  };
}
