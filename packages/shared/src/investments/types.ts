import type { ISODate } from '../dates';

/**
 * Investimentos em caixinhas (ADR-0012). Dinheiro em centavos; taxa prefixada mensal em milionésimos da
 * fração (1% a.m. = 10000); % do CDI em centésimos de ponto (100% = 10000); CDI anual em milionésimos
 * (14,90% a.a. = 149000).
 */

export const INVESTMENT_KINDS = ['savings_box', 'treasury', 'lci_lca', 'poupanca', 'other'] as const;
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number];

export const INVESTMENT_KIND_LABELS: Record<InvestmentKind, string> = {
  savings_box: 'Caixinha / CDB / RDB',
  treasury: 'Tesouro',
  lci_lca: 'LCI / LCA',
  poupanca: 'Poupança',
  other: 'Outro',
};

export const YIELD_KINDS = ['fixed', 'cdi', 'none'] as const;
export type YieldKind = (typeof YIELD_KINDS)[number];

export const YIELD_KIND_LABELS: Record<YieldKind, string> = {
  cdi: '% do CDI',
  fixed: 'Taxa fixa',
  none: 'Não rende',
};

export const TAX_MODES = ['regressive', 'exempt'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  regressive: 'Tabela regressiva de IR',
  exempt: 'Isento',
};

export const MOVEMENT_KINDS = ['initial', 'deposit', 'withdrawal'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Ícones que a pessoa pode escolher (chaves de `components/Icon` no web; conferido na compilação). */
export const INVESTMENT_ICONS = [
  'piggy',
  'shield',
  'home',
  'plane',
  'car',
  'gift',
  'heart',
  'book',
  'star',
  'wallet',
  'bank',
  'calendar',
  'card',
  'tag',
  'clock',
] as const;
export type InvestmentIcon = (typeof INVESTMENT_ICONS)[number];

/** Limites: prefixado até 10% a.m.; de 1% a 300% do CDI; CDI anual até 100% a.a. */
export const MAX_FIXED_RATE_PPM = 100_000;
export const MAX_CDI_SHARE_BP = 30_000;
export const MAX_CDI_ANNUAL_PPM = 1_000_000;

export interface InvestmentTerms {
  yieldKind: YieldKind;
  fixedRatePpm: number | null;
  cdiShareBp: number | null;
}

export interface KindDefaults extends InvestmentTerms {
  taxMode: TaxMode;
}

/** O que o tipo sugere no formulário, enquanto a pessoa não muda esses campos. */
export const KIND_DEFAULTS: Record<InvestmentKind, KindDefaults> = {
  savings_box: { yieldKind: 'cdi', cdiShareBp: 10_000, fixedRatePpm: null, taxMode: 'regressive' },
  treasury: { yieldKind: 'cdi', cdiShareBp: 10_000, fixedRatePpm: null, taxMode: 'regressive' },
  lci_lca: { yieldKind: 'cdi', cdiShareBp: 9_500, fixedRatePpm: null, taxMode: 'exempt' },
  poupanca: { yieldKind: 'fixed', fixedRatePpm: 5_000, cdiShareBp: null, taxMode: 'exempt' },
  other: { yieldKind: 'none', fixedRatePpm: null, cdiShareBp: null, taxMode: 'exempt' },
};

export interface MovementLite {
  date: ISODate;
  kind: MovementKind;
  amountCents: number;
}

export interface InvestmentAnchorLite {
  date: ISODate;
  balanceCents: number;
}

/** Um aporte com o principal que ainda resta nele. */
export interface Lot {
  date: ISODate;
  principalCents: number;
}
