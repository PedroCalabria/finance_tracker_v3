import type { Month } from '../dates';
import { orderDebts, type OrderableDebt } from './order';
import { simulatePlan, type SimDebt, type SimResult } from './simulate';
import type { DebtBudgetEntry, DebtStrategy } from './types';

export type PlanDebt = SimDebt & OrderableDebt;

export interface StrategySummary {
  strategy: DebtStrategy | 'minimum';
  payoffMonth: Month | null;
  totalInterestCents: number;
}

export interface PlanInput {
  debts: readonly PlanDebt[];
  budgets: readonly DebtBudgetEntry[];
  currentMonth: Month;
  spentThisMonthCents: number;
  strategy: DebtStrategy;
  /** A ordem manual já foi gravada? Senão, "Minha ordem" usa a ordem da avalanche. */
  manualOrderSet: boolean;
}

export interface PlanResult {
  /** Ids na ordem da estratégia escolhida. */
  order: string[];
  simulation: SimResult;
  comparison: StrategySummary[];
}

/** Ordem efetiva: "Minha ordem" nunca gravada = avalanche. */
export function effectiveOrder<D extends OrderableDebt>(debts: readonly D[], strategy: DebtStrategy, manualOrderSet: boolean): D[] {
  return orderDebts(debts, strategy === 'manual' && !manualOrderSet ? 'avalanche' : strategy);
}

/** Plano de quitação: simulação da estratégia escolhida (com timeline) e comparação das quatro. */
export function buildPlan(input: PlanInput): PlanResult {
  const base = { budgets: input.budgets, currentMonth: input.currentMonth, spentThisMonthCents: input.spentThisMonthCents };
  const ordered = effectiveOrder(input.debts, input.strategy, input.manualOrderSet);
  const simulation = simulatePlan({ ...base, debts: ordered, withTimeline: true });
  const summarize = (strategy: DebtStrategy | 'minimum', r: SimResult): StrategySummary => ({
    strategy,
    payoffMonth: r.payoffMonth,
    totalInterestCents: r.totalInterestCents,
  });
  const comparison: StrategySummary[] = (['avalanche', 'snowball', 'manual'] as const).map((s) =>
    s === input.strategy ? summarize(s, simulation) : summarize(s, simulatePlan({ ...base, debts: effectiveOrder(input.debts, s, input.manualOrderSet) })),
  );
  comparison.push(summarize('minimum', simulatePlan({ ...base, debts: ordered, minimumOnly: true })));
  return { order: ordered.map((d) => d.id), simulation, comparison };
}
