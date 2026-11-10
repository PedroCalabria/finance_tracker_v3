import type { DebtStrategy } from './types';

export interface OrderableDebt {
  id: string;
  monthlyRatePpm: number;
  balanceCents: number;
  /** Ordem de cadastro (ISO do `created_at`): último desempate. */
  createdAt: string;
  position: number | null;
}

const byCreated = (a: OrderableDebt, b: OrderableDebt) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);

const avalanche = (a: OrderableDebt, b: OrderableDebt) =>
  b.monthlyRatePpm - a.monthlyRatePpm || a.balanceCents - b.balanceCents || byCreated(a, b);

const snowball = (a: OrderableDebt, b: OrderableDebt) =>
  a.balanceCents - b.balanceCents || b.monthlyRatePpm - a.monthlyRatePpm || byCreated(a, b);

const manual = (a: OrderableDebt, b: OrderableDebt) =>
  (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || byCreated(a, b);

/**
 * Ordem de prioridade (ADR-0011). Avalanche: maior taxa, depois menor saldo, depois cadastro.
 * Bola de neve: menor saldo, depois maior taxa, depois cadastro. Manual: posição gravada.
 */
export function orderDebts<D extends OrderableDebt>(debts: readonly D[], strategy: DebtStrategy): D[] {
  const cmp = strategy === 'avalanche' ? avalanche : strategy === 'snowball' ? snowball : manual;
  return [...debts].sort(cmp);
}
