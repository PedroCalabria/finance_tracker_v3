import { pricePayment, revolvingMinimum, sacAmortization } from './contract';
import { monthInterest } from './rates';
import { MAX_SIMULATION_MONTHS } from './simulate';
import type { DebtTerms } from './types';

export interface PayoffOutcome {
  /** Meses até quitar pagando o contrato; null = não quita em 600 meses. */
  months: number | null;
  interestCents: number;
  /** Parcela (Price/Sem juros) ou amortização mensal (SAC); null no Rotativo. */
  installmentCents: number | null;
}

export interface WhatIfScenario extends PayoffOutcome {
  interestSavedCents: number;
  /** null quando um dos dois lados não quita. */
  monthsSaved: number | null;
}

export interface WhatIfResult {
  baseline: PayoffOutcome;
  /** Price e SAC. */
  reduceTerm?: WhatIfScenario;
  reduceInstallment?: WhatIfScenario;
  /** Rotativo e Sem juros: um só resultado. */
  single?: WhatIfScenario;
}

/** Paga só esta dívida pelo contrato, a partir do saldo de hoje (juros a partir do mês seguinte). */
export function payOffAlone(terms: DebtTerms, balanceCents: number, override: { installmentCents?: number | null; sacAmortization?: number } = {}): PayoffOutcome {
  const installment = override.installmentCents !== undefined ? override.installmentCents : terms.installmentCents;
  const sacA = override.sacAmortization ?? sacAmortization(balanceCents, terms.remainingInstallments);
  let balance = balanceCents;
  let interestTotal = 0;
  let months = 0;
  while (balance > 0 && months < MAX_SIMULATION_MONTHS) {
    months++;
    const interest = monthInterest(balance, terms.monthlyRatePpm);
    balance += interest;
    interestTotal += interest;
    let due: number;
    if (terms.structure === 'sac') due = sacA + interest;
    else if (terms.structure === 'revolving')
      due = revolvingMinimum(balance, terms.minPaymentKind, terms.minPaymentValue);
    else due = installment ?? 0;
    // Pagamento que não cobre os juros: nunca quita (e o saldo cresceria sem limite).
    if (due <= 0 || (terms.structure !== 'sac' && due <= interest && due < balance)) {
      return { months: null, interestCents: interestTotal, installmentCents: installment ?? null };
    }
    balance -= Math.min(due, balance);
  }
  return {
    months: balance > 0 ? null : months,
    interestCents: interestTotal,
    installmentCents: terms.structure === 'sac' ? sacA : terms.structure === 'revolving' ? null : (installment ?? null),
  };
}

const compare = (baseline: PayoffOutcome, o: PayoffOutcome): WhatIfScenario => ({
  ...o,
  interestSavedCents: baseline.interestCents - o.interestCents,
  monthsSaved: baseline.months !== null && o.months !== null ? baseline.months - o.months : null,
});

/** "E se eu amortizar R$ X?": só esta dívida, sem amortizar × reduzir prazo × reduzir parcela. Não grava nada. */
export function whatIfExtra(terms: DebtTerms, balanceCents: number, extraCents: number): WhatIfResult {
  const baseline = payOffAlone(terms, balanceCents);
  const after = Math.max(0, balanceCents - extraCents);
  if (terms.structure === 'price') {
    const n = terms.remainingInstallments && terms.remainingInstallments > 0 ? terms.remainingInstallments : 1;
    return {
      baseline,
      reduceTerm: compare(baseline, payOffAlone(terms, after)),
      reduceInstallment: compare(baseline, payOffAlone(terms, after, { installmentCents: pricePayment(after, terms.monthlyRatePpm, n) })),
    };
  }
  if (terms.structure === 'sac') {
    return {
      baseline,
      reduceTerm: compare(baseline, payOffAlone(terms, after, { sacAmortization: sacAmortization(balanceCents, terms.remainingInstallments) })),
      reduceInstallment: compare(baseline, payOffAlone(terms, after)),
    };
  }
  return { baseline, single: compare(baseline, payOffAlone(terms, after)) };
}
