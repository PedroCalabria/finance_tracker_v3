import { daysBetween, type ISODate } from '../dates';
import type { Lot, TaxMode } from './types';
import { principalConsumed, takeFifo, type WalkResult } from './walk';

/*
 * Tributação da renda fixa para pessoa física (ADR-0012). TODAS as alíquotas ficam neste arquivo.
 *
 * - IR regressivo sobre o rendimento, pelo prazo de cada aporte (Lei 11.033/2004, art. 1º):
 *   até 180 dias 22,5%; de 181 a 360 dias 20%; de 361 a 720 dias 17,5%; acima de 720 dias 15%.
 * - IOF regressivo sobre o rendimento nos resgates com menos de 30 dias (Decreto 6.306/2007, anexo):
 *   96% no 1º dia até 3% no 29º; zero a partir do 30º.
 * - Isentos para pessoa física: LCI, LCA (e CRI/CRA) e poupança.
 *
 * A MP 1.303/2025 (alíquota única de 17,5% e IR sobre LCI/LCA) perdeu a validade sem virar lei.
 * Conferido em 10/11/2026: tabela regressiva e isenção de LCI/LCA vigentes. Há proposta de 5% sobre LCI/LCA em
 * discussão (não aprovada). Fora do escopo: o IRPFM (Lei 15.270/2025), adicional para renda total acima de
 * R$ 600 mil por ano.
 * Antes de mudar qualquer número, confira a legislação vigente e atualize os testes de `investments.test.ts`.
 */

/** IR em milésimos (225 = 22,5%), pelo prazo em dias corridos. */
export const IR_BRACKETS: readonly { upToDays: number; ratePermil: number; label: string }[] = [
  { upToDays: 180, ratePermil: 225, label: 'Até 180 dias' },
  { upToDays: 360, ratePermil: 200, label: 'De 181 a 360 dias' },
  { upToDays: 720, ratePermil: 175, label: 'De 361 a 720 dias' },
  { upToDays: Number.POSITIVE_INFINITY, ratePermil: 150, label: 'Acima de 720 dias' },
];

/** IOF em % do rendimento: índice 0 = 1º dia, …, índice 28 = 29º dia. Do 30º dia em diante, zero. */
export const IOF_TABLE: readonly number[] = [
  96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50, 46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3,
];

export function irBracket(days: number) {
  return IR_BRACKETS.find((b) => days <= b.upToDays)!;
}

export function irRatePermil(days: number): number {
  return irBracket(days).ratePermil;
}

/** IOF em % do rendimento; um resgate no mesmo dia conta como o 1º dia. */
export function iofRatePct(days: number): number {
  if (days >= 30) return 0;
  return IOF_TABLE[Math.max(1, days) - 1]!;
}

export interface LotTax {
  date: ISODate;
  principalCents: number;
  days: number;
  yieldCents: number;
  iofCents: number;
  irCents: number;
  irRatePermil: number;
}

export interface TaxResult {
  iofCents: number;
  irCents: number;
  totalCents: number;
  byLot: LotTax[];
}

const ZERO: TaxResult = { iofCents: 0, irCents: 0, totalCents: 0, byLot: [] };

/** Divide `total` em inteiros proporcionais aos pesos (maiores restos), somando exatamente `total`. */
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => total * (w / sum));
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k]!.i]! += 1;
  return out;
}

/**
 * Imposto de resgatar os lotes na data, com `yieldCents` de rendimento:
 * - o rendimento é dividido entre os lotes proporcionalmente a principal × dias (sem dias, só ao principal);
 * - por lote: IOF sobre o rendimento; IR sobre (rendimento − IOF) pela idade; meio para cima;
 * - rendimento ≤ 0 ou isento: zero.
 */
export function lotTaxes(lots: readonly Lot[], yieldCents: number, date: ISODate, mode: TaxMode): TaxResult {
  if (mode === 'exempt' || yieldCents <= 0 || lots.length === 0) return ZERO;
  const days = lots.map((l) => Math.max(0, daysBetween(l.date, date)));
  let weights = lots.map((l, i) => l.principalCents * days[i]!);
  if (weights.every((w) => w <= 0)) weights = lots.map((l) => l.principalCents);
  const shares = apportion(yieldCents, weights);
  const byLot: LotTax[] = lots.map((l, i) => {
    const y = shares[i]!;
    const iof = Math.round((y * iofRatePct(days[i]!)) / 100);
    const rate = irRatePermil(days[i]!);
    const ir = Math.round(((y - iof) * rate) / 1000);
    return { date: l.date, principalCents: l.principalCents, days: days[i]!, yieldCents: y, iofCents: iof, irCents: ir, irRatePermil: rate };
  });
  const iofCents = byLot.reduce((s, l) => s + l.iofCents, 0);
  const irCents = byLot.reduce((s, l) => s + l.irCents, 0);
  return { iofCents, irCents, totalCents: iofCents + irCents, byLot };
}

/** Imposto de resgatar tudo na data da caminhada. */
export function taxIfRedeemedAll(walk: WalkResult, date: ISODate, mode: TaxMode): TaxResult {
  return lotTaxes(walk.lots, walk.yieldCents, date, mode);
}

/**
 * Imposto estimado de um resgate de `amountCents` na data da caminhada: a mesma conta, aplicada à fatia dos
 * lotes que o FIFO consumiria; o rendimento da fatia é o valor menos o principal consumido.
 */
export function withdrawalTax(walk: WalkResult, amountCents: number, date: ISODate, mode: TaxMode): TaxResult {
  if (mode === 'exempt' || amountCents <= 0 || walk.grossCents <= 0) return ZERO;
  const consumed = principalConsumed(amountCents, walk.principalCents, walk.grossCents);
  const sliceYield = Math.min(amountCents, walk.grossCents) - consumed;
  if (sliceYield <= 0) return ZERO;
  const copy = walk.lots.map((l) => ({ ...l }));
  let slice = takeFifo(copy, consumed);
  // Sem principal a consumir (só rendimento), o rendimento vem dos lotes que restam; sem lotes, conta como de hoje.
  if (slice.length === 0) slice = walk.lots.length ? walk.lots.map((l) => ({ ...l })) : [{ date, principalCents: 1 }];
  return lotTaxes(slice, sliceYield, date, mode);
}

export interface TaxBracketRow {
  label: string;
  irRatePermil: number;
  yieldCents: number;
  iofCents: number;
  irCents: number;
}

/** "Imposto se resgatar hoje" agrupado por faixa de IR (do prazo mais curto ao mais longo). */
export function taxByBracket(tax: TaxResult): TaxBracketRow[] {
  const rows: TaxBracketRow[] = [];
  for (const b of IR_BRACKETS) {
    const lots = tax.byLot.filter((l) => irBracket(l.days) === b);
    if (!lots.length) continue;
    rows.push({
      label: b.label,
      irRatePermil: b.ratePermil,
      yieldCents: lots.reduce((s, l) => s + l.yieldCents, 0),
      iofCents: lots.reduce((s, l) => s + l.iofCents, 0),
      irCents: lots.reduce((s, l) => s + l.irCents, 0),
    });
  }
  return rows;
}
