import { addMonths, compareDates, daysInMonth, diffMonths, monthOf, type ISODate, type Month } from '../dates';
import { monthInterest } from '../debts/rates';
import { lotTaxes } from './taxes';
import type { Lot, TaxMode } from './types';
import type { WalkResult } from './walk';

export const MAX_PROJECTION_MONTHS = 600;

export interface SeriesPoint {
  month: Month;
  /** Aportado líquido (principal) no fim do mês. */
  principalCents: number;
  /** Saldo bruto no fim do mês. */
  grossCents: number;
}

export interface GoalProjection {
  /** Primeiro mês com bruto ≥ meta (o mês atual se já atingiu); null se não atinge em 600 meses. */
  reachedMonth: Month | null;
  reachedNow: boolean;
  /** Não chega até o mês-alvo: o menor "guardar por mês" que chegaria (null se o mês-alvo já passou ou não há como). */
  shortfall: { goalMonth: Month; suggestedPlanCents: number | null } | null;
}

export interface RedeemProjection {
  date: ISODate;
  grossCents: number;
  taxCents: number;
  netCents: number;
}

export interface ProjectionInput {
  /** Caminhada até hoje. */
  walk: WalkResult;
  ratePpm: number;
  monthlyPlanCents: number | null;
  goalCents: number | null;
  goalMonth: Month | null;
  redeemableFrom: ISODate | null;
  taxMode: TaxMode;
  today: ISODate;
  /** Meses da série devolvida (o gráfico usa 24). */
  horizonMonths: number;
}

export interface ProjectionResult {
  series: SeriesPoint[];
  goal: GoalProjection | null;
  atRedeem: RedeemProjection | null;
  /** Rendimento do próximo mês sobre o bruto de hoje. */
  monthlyYieldCents: number;
}

interface State {
  gross: number;
  lots: Lot[];
}

/** Um mês à frente: juros sobre o bruto e depois o aporte planejado, como um lote novo no dia 1. */
function step(s: State, month: Month, ratePpm: number, plan: number): void {
  s.gross += monthInterest(s.gross, ratePpm);
  if (plan > 0) {
    s.gross += plan;
    s.lots.push({ date: `${month}-01`, principalCents: plan });
  }
}

const principalOf = (lots: readonly Lot[]) => lots.reduce((s, l) => s + l.principalCents, 0);

/** Mês em que o bruto atinge a meta (null se não atinge em `limit` meses). */
function reachMonth(gross: number, ratePpm: number, plan: number, goal: number, current: Month, limit: number): Month | null {
  const s: State = { gross, lots: [] };
  if (s.gross >= goal) return current;
  for (let k = 1; k <= limit; k++) {
    const m = addMonths(current, k);
    step(s, m, ratePpm, plan);
    if (s.gross >= goal) return m;
  }
  return null;
}

/** Menor plano mensal (em centavos) que atinge a meta até o mês-alvo, por busca binária. */
function minimalPlan(gross: number, ratePpm: number, goal: number, current: Month, goalMonth: Month): number | null {
  const months = diffMonths(current, goalMonth);
  if (months < 1) return null;
  const reaches = (plan: number) => {
    const m = reachMonth(gross, ratePpm, plan, goal, current, months);
    return m !== null && m <= goalMonth;
  };
  let lo = 1;
  let hi = Math.max(1, goal - gross);
  if (!reaches(hi)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (reaches(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Projeção mês a mês a partir do bruto de hoje (ADR-0012): juros e depois o "guardar por mês".
 * Traz a série, a meta (mês em que chega, ou o aviso com o plano mínimo), o líquido na data de resgate e o
 * rendimento mensal aproximado.
 */
export function projectInvestment(input: ProjectionInput): ProjectionResult {
  const current = monthOf(input.today);
  const plan = input.monthlyPlanCents ?? 0;
  const s: State = { gross: input.walk.grossCents, lots: input.walk.lots.map((l) => ({ ...l })) };
  const series: SeriesPoint[] = [];
  for (let k = 1; k <= input.horizonMonths; k++) {
    const m = addMonths(current, k);
    step(s, m, input.ratePpm, plan);
    series.push({ month: m, principalCents: principalOf(s.lots), grossCents: s.gross });
  }

  let goal: GoalProjection | null = null;
  if (input.goalCents !== null) {
    const reachedMonth = reachMonth(input.walk.grossCents, input.ratePpm, plan, input.goalCents, current, MAX_PROJECTION_MONTHS);
    const reachedNow = input.walk.grossCents >= input.goalCents;
    let shortfall: GoalProjection['shortfall'] = null;
    if (input.goalMonth && !reachedNow && (reachedMonth === null || reachedMonth > input.goalMonth)) {
      shortfall = {
        goalMonth: input.goalMonth,
        suggestedPlanCents: minimalPlan(input.walk.grossCents, input.ratePpm, input.goalCents, current, input.goalMonth),
      };
    }
    goal = { reachedMonth, reachedNow, shortfall };
  }

  let atRedeem: RedeemProjection | null = null;
  if (input.redeemableFrom && compareDates(input.redeemableFrom, input.today) > 0) {
    const r: State = { gross: input.walk.grossCents, lots: input.walk.lots.map((l) => ({ ...l })) };
    const months = diffMonths(current, monthOf(input.redeemableFrom));
    for (let k = 1; k <= months; k++) step(r, addMonths(current, k), input.ratePpm, plan);
    const tax = lotTaxes(r.lots, r.gross - principalOf(r.lots), input.redeemableFrom, input.taxMode);
    atRedeem = { date: input.redeemableFrom, grossCents: r.gross, taxCents: tax.totalCents, netCents: r.gross - tax.totalCents };
  }

  return { series, goal, atRedeem, monthlyYieldCents: monthInterest(input.walk.grossCents, input.ratePpm) };
}

/** Último dia do mês ("2026-02" → "2026-02-28"). */
export function lastDayOf(month: Month): ISODate {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}
