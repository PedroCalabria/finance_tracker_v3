import { addMonths, monthOf, type ISODate } from '../dates';
import { lastDayOf, type SeriesPoint } from './project';
import type { InvestmentAnchorLite, MovementLite } from './types';
import { walkInvestment } from './walk';

/**
 * Série dos `months` meses até o atual (inclusive): aportado líquido e bruto no fim de cada mês
 * (no mês atual, hoje). Meses antes do primeiro aporte ficam zerados.
 */
export function pastSeries(
  movements: readonly MovementLite[],
  anchors: readonly InvestmentAnchorLite[],
  ratePpm: number,
  today: ISODate,
  months: number,
): SeriesPoint[] {
  const current = monthOf(today);
  const out: SeriesPoint[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const m = addMonths(current, -k);
    const w = walkInvestment(movements, anchors, ratePpm, k === 0 ? today : lastDayOf(m));
    out.push({ month: m, principalCents: w.principalCents, grossCents: w.grossCents });
  }
  return out;
}

/** Soma séries de mesmo comprimento e mesmos meses (uma por caixinha). */
export function sumSeries(all: readonly (readonly SeriesPoint[])[]): SeriesPoint[] {
  if (!all.length) return [];
  return all[0]!.map((p, i) => ({
    month: p.month,
    principalCents: all.reduce((s, ser) => s + (ser[i]?.principalCents ?? 0), 0),
    grossCents: all.reduce((s, ser) => s + (ser[i]?.grossCents ?? 0), 0),
  }));
}
