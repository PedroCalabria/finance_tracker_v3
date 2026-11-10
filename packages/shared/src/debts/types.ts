import type { ISODate, Month } from '../dates';

/** Gestão de dívidas (ADR-0011). Dinheiro em centavos; taxa mensal em milionésimos da fração (2,99% a.m. = 29900). */

export const DEBT_CATEGORIES = [
  'card_installment',
  'overdraft',
  'personal_loan',
  'payroll_loan',
  'vehicle_financing',
  'mortgage',
  'person',
  'other',
] as const;
export type DebtCategory = (typeof DEBT_CATEGORIES)[number];

export const DEBT_CATEGORY_LABELS: Record<DebtCategory, string> = {
  card_installment: 'Cartão: parcelamento de fatura',
  overdraft: 'Cheque especial',
  personal_loan: 'Empréstimo pessoal',
  payroll_loan: 'Consignado',
  vehicle_financing: 'Financiamento de veículo',
  mortgage: 'Financiamento imobiliário',
  person: 'Pessoa',
  other: 'Outros',
};

export const DEBT_STRUCTURES = ['price', 'sac', 'revolving', 'interest_free'] as const;
export type DebtStructure = (typeof DEBT_STRUCTURES)[number];

export const DEBT_STRUCTURE_LABELS: Record<DebtStructure, string> = {
  price: 'Price (parcela fixa)',
  sac: 'SAC (amortização constante)',
  revolving: 'Rotativo / saldo aberto',
  interest_free: 'Sem juros',
};

export const DEBT_STRATEGIES = ['avalanche', 'snowball', 'manual'] as const;
export type DebtStrategy = (typeof DEBT_STRATEGIES)[number];

export const DEBT_STRATEGY_LABELS: Record<DebtStrategy | 'minimum', string> = {
  avalanche: 'Avalanche',
  snowball: 'Bola de neve',
  manual: 'Minha ordem',
  minimum: 'Só o mínimo',
};

export type MinPaymentKind = 'fixed' | 'percent';
export type DebtPaymentKind = 'installment' | 'extra';
export type ExtraEffect = 'reduce_term' | 'reduce_installment';

/** Padrões que a categoria sugere no formulário (a pessoa pode trocar). */
export function categoryDefaults(category: DebtCategory): { structure: DebtStructure; acceptsExtra: boolean } {
  const structure: DebtStructure =
    category === 'person' ? 'interest_free' : category === 'mortgage' ? 'sac' : category === 'overdraft' ? 'revolving' : 'price';
  return { structure, acceptsExtra: category !== 'payroll_loan' };
}

/** O que a matemática precisa de uma dívida (contrato com a mesma forma de `items`). */
export interface DebtTerms {
  structure: DebtStructure;
  monthlyRatePpm: number;
  /** Price (obrigatória) e Sem juros (opcional). */
  installmentCents: number | null;
  /** Price e SAC. */
  remainingInstallments: number | null;
  minPaymentKind: MinPaymentKind | null;
  /** Centavos (fixed) ou milionésimos do saldo (percent). */
  minPaymentValue: number | null;
}

export interface DebtPaymentLite {
  date: ISODate;
  amountCents: number;
  kind: DebtPaymentKind;
}

export interface BalanceAnchorLite {
  date: ISODate;
  balanceCents: number;
}

export interface DebtBudgetEntry {
  fromMonth: Month;
  amountCents: number;
}
