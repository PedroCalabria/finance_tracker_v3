import { DEBT_CATEGORY_LABELS, formatMonthShort, formatRatePpm, revolvingMinimum, type DebtRow, type DebtTerms, type Month } from '@ff/shared';
import { brl } from '../components/ui';

/** Textos da tela de dívidas (ADR-0011). */

export const rateLabel = (ppm: number) => (ppm === 0 ? 'Sem juros' : `${formatRatePpm(ppm)} a.m.`);
export const monthLabel = (m: Month | null | undefined) => (m ? formatMonthShort(m, true) : 'Não quita com este orçamento');
export const signedBRL = (c: number) => `${c < 0 ? '− ' : c > 0 ? '+ ' : ''}${brl(Math.abs(c))}`;

/** Credor e categoria numa linha ("Empréstimo pessoal · Banco X"). */
export function kicker(d: DebtRow): string {
  const creditor = d.creditorPerson?.name ?? d.creditorName;
  return [DEBT_CATEGORY_LABELS[d.category], creditor].filter(Boolean).join(' · ');
}

/** Parcela ou mínimo do mês, em texto. */
export function obligationLabel(d: DebtRow): string | null {
  if (d.structure === 'revolving') {
    if (d.minPaymentKind === 'percent' && d.minPaymentValue) return `Mínimo de ${formatRatePpm(d.minPaymentValue)} do saldo`;
    return d.minPaymentValue ? `Mínimo de ${brl(d.minPaymentValue)}` : null;
  }
  if (d.structure === 'sac') return 'Amortização constante + juros';
  return d.installmentCents ? `Parcela de ${brl(d.installmentCents)}` : null;
}

/** Valor sugerido para "Registrar pagamento": a parcela ou o mínimo. */
export function suggestedPayment(d: DebtRow): number | null {
  if (d.structure === 'revolving') return revolvingMinimum(d.balanceCents, d.minPaymentKind, d.minPaymentValue) || null;
  if (d.structure === 'sac') {
    const n = d.remainingInstallments;
    if (!n) return d.balanceCents || null;
    // amortização + juros do mês sobre o saldo de hoje (aproximação: a pessoa confere com o boleto)
    return Math.round(d.balanceCents / n) + Math.round((d.balanceCents * d.monthlyRatePpm) / (1e6 + d.monthlyRatePpm));
  }
  return d.installmentCents ? Math.min(d.installmentCents, d.balanceCents || d.installmentCents) : null;
}

export const termsOf = (d: DebtRow): DebtTerms => ({
  structure: d.structure,
  monthlyRatePpm: d.monthlyRatePpm,
  installmentCents: d.installmentCents,
  remainingInstallments: d.remainingInstallments,
  minPaymentKind: d.minPaymentKind,
  minPaymentValue: d.minPaymentValue,
});

/** Percentual do saldo inicial já abatido (0 se o saldo cresceu). */
export function progressOf(d: DebtRow): { pct: number; grewCents: number } {
  const start = d.initial.balanceCents;
  if (start <= 0) return { pct: d.balanceCents <= 0 ? 100 : 0, grewCents: 0 };
  if (d.balanceCents > start) return { pct: 0, grewCents: d.balanceCents - start };
  return { pct: Math.round(((start - d.balanceCents) / start) * 100), grewCents: 0 };
}
