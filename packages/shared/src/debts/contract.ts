import type { DebtStructure, ExtraEffect } from './types';

export const MAX_DEBT_INSTALLMENTS = 600;
/** Folga para o arredondamento do ponto flutuante antes do teto (7,0000000001 → 7). */
const EPS = 1e-9;

/**
 * Parcela Price que quita B em n meses à taxa i (centavos), arredondada para cima: arredondar para baixo
 * deixaria centavos para um mês a mais. i = 0 → ⌈B/n⌉.
 */
export function pricePayment(balanceCents: number, ratePpm: number, n: number): number {
  if (balanceCents <= 0) return 0;
  if (n <= 0) return balanceCents;
  const i = ratePpm / 1e6;
  if (i === 0) return Math.ceil(balanceCents / n);
  return Math.ceil((balanceCents * i) / (1 - (1 + i) ** -n) - 1e-6);
}

/** Nº de parcelas P que quitam B à taxa i. null se a parcela não cobre os juros (nunca quita). */
export function priceTerm(balanceCents: number, ratePpm: number, paymentCents: number): number | null {
  if (balanceCents <= 0) return 0;
  if (paymentCents <= 0) return null;
  const i = ratePpm / 1e6;
  if (i === 0) return Math.ceil(balanceCents / paymentCents);
  const x = (i * balanceCents) / paymentCents;
  if (x >= 1) return null;
  return Math.max(1, Math.ceil(-Math.log(1 - x) / Math.log(1 + i) - EPS));
}

/** Amortização constante do SAC: saldo ÷ parcelas restantes, ao centavo (sem parcelas, o saldo todo). */
export function sacAmortization(balanceCents: number, remaining: number | null): number {
  if (balanceCents <= 0) return 0;
  if (!remaining || remaining <= 0) return balanceCents;
  return Math.max(1, Math.round(balanceCents / remaining));
}

/** Saldo a partir do qual o rotativo é pago inteiro (R$ 1,00): evita que o arredondamento trave o fim da dívida. */
export const REVOLVING_PAYOFF_FLOOR_CENTS = 100;

/**
 * Pagamento mínimo do rotativo sobre o saldo (já com juros), nunca maior que ele. O percentual é
 * arredondado para cima; saldo de até R$ 1,00 é pago inteiro. Com arredondamento comum, um saldo de
 * centavos podia gerar juros de 1 centavo e mínimo de 1 centavo para sempre.
 */
export function revolvingMinimum(balanceCents: number, kind: 'fixed' | 'percent' | null, value: number | null): number {
  if (balanceCents <= 0) return 0;
  if (balanceCents <= REVOLVING_PAYOFF_FLOOR_CENTS) return balanceCents;
  const due = kind === 'percent' ? Math.ceil((balanceCents * (value ?? 0)) / 1e6 - 1e-9) : (value ?? 0);
  return Math.min(balanceCents, Math.max(0, due));
}

export interface ContractNumbers {
  installmentCents: number | null;
  remainingInstallments: number | null;
}

const clampTerm = (n: number) => Math.min(MAX_DEBT_INSTALLMENTS, Math.max(1, n));

/**
 * Contrato sugerido depois de uma amortização extra (a pessoa confirma ou corrige com os números do banco).
 * Price: reduzir prazo mantém a parcela; reduzir parcela mantém o prazo. SAC: reduzir prazo mantém a
 * amortização de antes; reduzir parcela mantém o prazo. Rotativo e Sem juros: contrato igual.
 */
export function recalcAfterExtra(
  terms: { structure: DebtStructure; monthlyRatePpm: number } & ContractNumbers,
  balanceBeforeCents: number,
  balanceAfterCents: number,
  effect: ExtraEffect,
): ContractNumbers {
  const { structure, monthlyRatePpm: ppm, installmentCents: p, remainingInstallments: n } = terms;
  if (structure !== 'price' && structure !== 'sac') return { installmentCents: p, remainingInstallments: n };
  if (balanceAfterCents <= 0) return { installmentCents: p, remainingInstallments: n === null ? null : 0 };
  if (structure === 'price') {
    if (effect === 'reduce_term') {
      const term = p ? priceTerm(balanceAfterCents, ppm, p) : null;
      return { installmentCents: p, remainingInstallments: term === null ? n : clampTerm(term) };
    }
    const months = n && n > 0 ? n : 1;
    return { installmentCents: pricePayment(balanceAfterCents, ppm, months), remainingInstallments: n };
  }
  if (effect === 'reduce_term') {
    const a = sacAmortization(balanceBeforeCents, n);
    return { installmentCents: null, remainingInstallments: clampTerm(Math.ceil(balanceAfterCents / a - EPS)) };
  }
  return { installmentCents: null, remainingInstallments: n };
}

export interface DebtTermFields {
  structure: DebtStructure;
  monthlyRatePpm: number;
  installmentCents?: number | null;
  remainingInstallments?: number | null;
  dueDay?: number | null;
  minPaymentKind?: 'fixed' | 'percent' | null;
  minPaymentValue?: number | null;
}

/** Campos que não pertencem à estrutura viram nulos (ADR-0011). */
export function normalizeDebtTerms(d: DebtTermFields) {
  const s = d.structure;
  const installment = s === 'price' || s === 'interest_free';
  const contract = s === 'price' || s === 'sac';
  return {
    structure: s,
    monthlyRatePpm: s === 'interest_free' ? 0 : d.monthlyRatePpm,
    installmentCents: installment ? (d.installmentCents ?? null) : null,
    remainingInstallments: contract ? (d.remainingInstallments ?? null) : null,
    dueDay: contract || s === 'interest_free' ? (d.dueDay ?? null) : null,
    minPaymentKind: s === 'revolving' ? (d.minPaymentKind ?? null) : null,
    minPaymentValue: s === 'revolving' ? (d.minPaymentValue ?? null) : null,
  };
}
