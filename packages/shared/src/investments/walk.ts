import { addMonths, compareDates, monthOf, type ISODate, type Month } from '../dates';
import { monthInterest } from '../debts/rates';
import type { InvestmentAnchorLite, Lot, MovementLite } from './types';

export interface WalkResult {
  /** Saldo bruto estimado na data. */
  grossCents: number;
  /** Principal que resta nos lotes (aportado líquido). */
  principalCents: number;
  /** Bruto − principal; negativo se uma âncora veio abaixo do principal. */
  yieldCents: number;
  /** Lotes com principal restante, do mais antigo ao mais novo. */
  lots: Lot[];
}

/**
 * Tira `amount` de principal dos lotes mais antigos primeiro (FIFO). Muda `lots` e devolve a fatia tirada.
 */
export function takeFifo(lots: Lot[], amount: number): Lot[] {
  const taken: Lot[] = [];
  let rest = amount;
  while (rest > 0 && lots.length) {
    const lot = lots[0]!;
    const take = Math.min(rest, lot.principalCents);
    taken.push({ date: lot.date, principalCents: take });
    lot.principalCents -= take;
    rest -= take;
    if (lot.principalCents <= 0) lots.shift();
  }
  return taken;
}

/** Principal que um resgate de `amount` consome: proporcional a principal ÷ saldo; tudo se resgata o saldo inteiro. */
export function principalConsumed(amount: number, principal: number, gross: number): number {
  if (principal <= 0) return 0;
  if (gross <= 0 || amount >= gross) return principal;
  return Math.min(principal, Math.round(amount * (principal / gross)));
}

const sumPrincipal = (lots: readonly Lot[]) => lots.reduce((s, l) => s + l.principalCents, 0);

/**
 * Caminhada no tempo do primeiro evento até `date` (ADR-0012):
 * - virada de mês: soma os juros do mês (`monthInterest`); o mês do primeiro evento não rende;
 * - aporte (inicial ou não): soma e cria um lote;
 * - resgate: consome o principal dos lotes mais antigos e subtrai o valor;
 * - âncora: o saldo passa a ser o informado (na mesma data, depois das movimentações); os lotes ficam.
 * Eventos depois de `date` ficam fora. O saldo nunca fica abaixo de zero.
 * `movements` na ordem em que foram feitos dentro do mesmo dia (a ordenação por data é feita aqui).
 */
export function walkInvestment(
  movements: readonly MovementLite[],
  anchors: readonly InvestmentAnchorLite[],
  ratePpm: number,
  date: ISODate,
): WalkResult {
  type Ev = { date: ISODate; order: number; m?: MovementLite; a?: InvestmentAnchorLite };
  const events: Ev[] = [];
  movements.forEach((m, i) => {
    if (compareDates(m.date, date) <= 0) events.push({ date: m.date, order: i, m });
  });
  anchors.forEach((a) => {
    if (compareDates(a.date, date) <= 0) events.push({ date: a.date, order: Number.MAX_SAFE_INTEGER, a });
  });
  events.sort((x, y) => compareDates(x.date, y.date) || x.order - y.order);

  let balance = 0;
  const lots: Lot[] = [];
  let month: Month | null = null;
  const advanceTo = (target: Month) => {
    if (month === null) {
      month = target;
      return;
    }
    while (month < target) {
      month = addMonths(month, 1);
      balance += monthInterest(balance, ratePpm);
    }
  };

  for (const ev of events) {
    advanceTo(monthOf(ev.date));
    if (ev.a) {
      balance = ev.a.balanceCents;
      continue;
    }
    const m = ev.m!;
    if (m.kind === 'withdrawal') {
      takeFifo(lots, principalConsumed(m.amountCents, sumPrincipal(lots), balance));
      balance = Math.max(0, balance - m.amountCents);
    } else {
      balance += m.amountCents;
      lots.push({ date: m.date, principalCents: m.amountCents });
    }
  }
  if (month !== null) advanceTo(monthOf(date));

  const principal = sumPrincipal(lots);
  return { grossCents: balance, principalCents: principal, yieldCents: balance - principal, lots };
}
