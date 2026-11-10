import { annualToMonthlyPpm, formatRatePpm } from '../debts/rates';
import type { InvestmentTerms } from './types';

/** Campos do rendimento coerentes com o tipo: o campo do outro tipo é gravado nulo (ADR-0012). */
export function normalizeInvestmentTerms(t: InvestmentTerms): InvestmentTerms {
  return {
    yieldKind: t.yieldKind,
    fixedRatePpm: t.yieldKind === 'fixed' ? (t.fixedRatePpm ?? 0) : null,
    cdiShareBp: t.yieldKind === 'cdi' ? (t.cdiShareBp ?? 10_000) : null,
  };
}

/**
 * Taxa mensal efetiva em milionésimos: prefixada, ou (CDI anual → mensal composta) × % do CDI.
 * Sem CDI informado, a caixinha com % do CDI não rende na estimativa.
 */
export function effectiveMonthlyPpm(t: InvestmentTerms, cdiAnnualPpm: number | null): number {
  if (t.yieldKind === 'fixed') return t.fixedRatePpm ?? 0;
  if (t.yieldKind === 'cdi') {
    if (cdiAnnualPpm === null) return 0;
    return Math.round((annualToMonthlyPpm(cdiAnnualPpm / 1e6) * (t.cdiShareBp ?? 0)) / 10_000);
  }
  return 0;
}

/** 10500 → "105%"; 9550 → "95,5%". */
export function formatCdiShare(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',')}%`;
}

/** "100% do CDI", "1,1% a.m." ou "Não rende". */
export function formatYield(t: InvestmentTerms): string {
  if (t.yieldKind === 'cdi') return `${formatCdiShare(t.cdiShareBp ?? 0)} do CDI`;
  if (t.yieldKind === 'fixed') return `${formatRatePpm(t.fixedRatePpm ?? 0)} a.m.`;
  return 'Não rende';
}
