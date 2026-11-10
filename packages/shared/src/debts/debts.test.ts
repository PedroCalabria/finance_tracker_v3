import { describe, expect, it } from 'vitest';
import {
  annualToMonthlyPpm,
  buildPlan,
  estimateBalance,
  formatRatePpm,
  monthInterest,
  orderDebts,
  parsePercentToPpm,
  priceTerm,
  pricePayment,
  recalcAfterExtra,
  remainingInstallments,
  revolvingMinimum,
  simulatePlan,
  whatIfExtra,
  type PlanDebt,
  type SimDebt,
} from '../index';

const debt = (d: Partial<SimDebt> & Pick<SimDebt, 'id' | 'balanceCents'>): SimDebt => ({
  name: d.id,
  structure: 'interest_free',
  monthlyRatePpm: 0,
  installmentCents: null,
  remainingInstallments: null,
  minPaymentKind: null,
  minPaymentValue: null,
  acceptsExtra: true,
  paidThisMonthCents: 0,
  ...d,
});
const planDebt = (d: Partial<PlanDebt> & Pick<PlanDebt, 'id' | 'balanceCents'>): PlanDebt => ({
  ...debt(d),
  createdAt: '2026-01-01T00:00:00.000Z',
  position: null,
  ...d,
});

describe('taxas', () => {
  it('converte 12% a.a. em 0,9489% a.m.', () => {
    expect(annualToMonthlyPpm(0.12)).toBe(9489);
  });
  it('juros do mês arredondados ao centavo, meio para cima', () => {
    expect(monthInterest(100000, 100000)).toBe(10000);
    expect(monthInterest(5, 100000)).toBe(1); // 0,5 → 1
    expect(monthInterest(4, 100000)).toBe(0);
  });
  it('lê e formata percentuais', () => {
    expect(parsePercentToPpm('2,99')).toBe(29900);
    expect(parsePercentToPpm('0,9489%')).toBe(9489);
    expect(parsePercentToPpm('abc')).toBeNull();
    expect(formatRatePpm(29900)).toBe('2,99%');
    expect(formatRatePpm(9489)).toBe('0,9489%');
    expect(formatRatePpm(0)).toBe('0%');
  });
});

describe('contrato Price e SAC', () => {
  it('Price: parcela e prazo, inclusive sem juros', () => {
    expect(pricePayment(300000, 20000, 11)).toBe(30654);
    expect(priceTerm(300000, 20000, 50000)).toBe(7);
    expect(priceTerm(100000, 0, 30000)).toBe(4);
    expect(priceTerm(100000, 100000, 10000)).toBeNull(); // parcela = juros: nunca quita
  });

  it('amortização extra no Price: reduzir prazo mantém a parcela; reduzir parcela mantém o prazo', () => {
    const terms = { structure: 'price' as const, monthlyRatePpm: 20000, installmentCents: 50000, remainingInstallments: 11 };
    expect(recalcAfterExtra(terms, 500000, 300000, 'reduce_term')).toEqual({ installmentCents: 50000, remainingInstallments: 7 });
    expect(recalcAfterExtra(terms, 500000, 300000, 'reduce_installment')).toEqual({ installmentCents: 30654, remainingInstallments: 11 });
  });

  it('amortização extra no SAC', () => {
    const terms = { structure: 'sac' as const, monthlyRatePpm: 9000, installmentCents: null, remainingInstallments: 100 };
    // amortização de antes: 1.000.000 / 100 = 10.000; saldo 700.000 → 70 parcelas
    expect(recalcAfterExtra(terms, 1_000_000, 700_000, 'reduce_term')).toEqual({ installmentCents: null, remainingInstallments: 70 });
    expect(recalcAfterExtra(terms, 1_000_000, 700_000, 'reduce_installment')).toEqual({ installmentCents: null, remainingInstallments: 100 });
  });

  it('rotativo e sem juros não mudam o contrato; saldo zerado zera as parcelas', () => {
    const rev = { structure: 'revolving' as const, monthlyRatePpm: 140000, installmentCents: null, remainingInstallments: null };
    expect(recalcAfterExtra(rev, 1000, 500, 'reduce_term')).toEqual({ installmentCents: null, remainingInstallments: null });
    const price = { structure: 'price' as const, monthlyRatePpm: 20000, installmentCents: 50000, remainingInstallments: 5 };
    expect(recalcAfterExtra(price, 1000, 0, 'reduce_term')).toEqual({ installmentCents: 50000, remainingInstallments: 0 });
  });
});

describe('saldo estimado', () => {
  const anchor = { date: '2026-10-20', balanceCents: 100000 };
  it('juros no início do mês seguinte e o pagamento do mês', () => {
    const payments = [{ date: '2026-11-10', amountCents: 30000, kind: 'installment' as const }];
    expect(estimateBalance(anchor, 100000, payments, '2026-11-15')).toBe(80000);
  });
  it('pagamento com data igual ou anterior à âncora já está no saldo', () => {
    const payments = [
      { date: '2026-10-20', amountCents: 5000, kind: 'installment' as const },
      { date: '2026-10-01', amountCents: 5000, kind: 'installment' as const },
    ];
    expect(estimateBalance(anchor, 0, payments, '2026-10-31')).toBe(100000);
  });
  it('pagamento posterior no mesmo mês da âncora, sem juros', () => {
    const payments = [{ date: '2026-10-25', amountCents: 20000, kind: 'extra' as const }];
    expect(estimateBalance(anchor, 100000, payments, '2026-10-31')).toBe(80000);
  });
  it('ignora pagamentos depois da data pedida e atravessa a virada do ano', () => {
    const a = { date: '2026-12-15', balanceCents: 100000 };
    const payments = [{ date: '2027-02-10', amountCents: 50000, kind: 'installment' as const }];
    // jan: +10% = 110.000; fev: +10% = 121.000 − 50.000 = 71.000
    expect(estimateBalance(a, 100000, payments, '2027-01-31')).toBe(110000);
    expect(estimateBalance(a, 100000, payments, '2027-02-28')).toBe(71000);
  });
  it('nunca fica negativo', () => {
    const payments = [{ date: '2026-11-10', amountCents: 999999, kind: 'extra' as const }];
    expect(estimateBalance(anchor, 100000, payments, '2026-12-31')).toBe(0);
  });
  it('parcelas restantes descontam os pagamentos de parcela posteriores ao contrato', () => {
    const payments = [
      { date: '2026-11-10', amountCents: 45000, kind: 'installment' as const },
      { date: '2026-12-10', amountCents: 45000, kind: 'installment' as const },
      { date: '2026-12-11', amountCents: 10000, kind: 'extra' as const },
      { date: '2026-11-05', amountCents: 45000, kind: 'installment' as const },
    ];
    expect(remainingInstallments(18, '2026-11-05', payments)).toBe(16);
    expect(remainingInstallments(null, '2026-11-05', payments)).toBeNull();
  });
});

describe('ordem de prioridade', () => {
  const ds = [
    { id: 'a', monthlyRatePpm: 30000, balanceCents: 800000, createdAt: '1', position: 2 },
    { id: 'b', monthlyRatePpm: 120000, balanceCents: 90000, createdAt: '2', position: 3 },
    { id: 'c', monthlyRatePpm: 9000, balanceCents: 300000, createdAt: '3', position: 1 },
    { id: 'd', monthlyRatePpm: 30000, balanceCents: 300000, createdAt: '4', position: null },
  ];
  it('avalanche: maior taxa, desempate pelo menor saldo', () => {
    expect(orderDebts(ds, 'avalanche').map((d) => d.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('bola de neve: menor saldo, desempate pela maior taxa', () => {
    expect(orderDebts(ds, 'snowball').map((d) => d.id)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('manual: posição gravada, sem posição no fim', () => {
    expect(orderDebts(ds, 'manual').map((d) => d.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('simulação', () => {
  const base = { budgets: [{ fromMonth: '2026-01', amountCents: 100000 }], currentMonth: '2026-11', spentThisMonthCents: 0 };

  it('sobra e bola de neve (cenário da spec)', () => {
    const r = simulatePlan({
      ...base,
      withTimeline: true,
      debts: [debt({ id: 'A', balanceCents: 60000, installmentCents: 20000 }), debt({ id: 'B', balanceCents: 120000, installmentCents: 30000 })],
    });
    expect(r.perDebt).toEqual([
      { id: 'A', payoffMonth: '2026-11', interestCents: 0, timeline: [0, 0] },
      { id: 'B', payoffMonth: '2026-12', interestCents: 0, timeline: [80000, 0] },
    ]);
    expect(r.payoffMonth).toBe('2026-12');
    expect(r.warnings).toEqual([]);
  });

  it('pagamento já registrado no mês atual abate o obrigatório e o orçamento', () => {
    const r = simulatePlan({
      ...base,
      spentThisMonthCents: 45000,
      withTimeline: true,
      debts: [debt({ id: 'P', balanceCents: 500000, installmentCents: 45000, paidThisMonthCents: 45000 }), debt({ id: 'Q', balanceCents: 100000, installmentCents: 10000, acceptsExtra: false })],
    });
    // mês 0: P não tem obrigatório; Q paga 10.000; sobra = 100.000 − 45.000 − 10.000 = 45.000 → P
    expect(r.perDebt[0]!.timeline![0]).toBe(455000);
    expect(r.perDebt[1]!.timeline![0]).toBe(90000);
  });

  it('dívida que não aceita amortização é pulada', () => {
    const r = simulatePlan({
      ...base,
      withTimeline: true,
      debts: [
        debt({ id: 'consignado', balanceCents: 500000, installmentCents: 20000, acceptsExtra: false }),
        debt({ id: 'outra', balanceCents: 500000, installmentCents: 20000 }),
      ],
    });
    expect(r.perDebt[0]!.timeline![0]).toBe(480000);
    expect(r.perDebt[1]!.timeline![0]).toBe(420000); // 20.000 + sobra de 60.000
  });

  it('juros a partir do mês seguinte e parcela final menor', () => {
    const r = simulatePlan({
      budgets: [],
      currentMonth: '2026-12',
      spentThisMonthCents: 0,
      withTimeline: true,
      debts: [debt({ id: 'p', structure: 'price', monthlyRatePpm: 100000, balanceCents: 100000, installmentCents: 60000 })],
    });
    // dez: paga 60.000 → 40.000; jan: +4.000 = 44.000, paga 44.000 → 0
    expect(r.perDebt[0]).toEqual({ id: 'p', payoffMonth: '2027-01', interestCents: 4000, timeline: [40000, 0] });
    expect(r.warnings.map((w) => w.code)).toEqual(['no_budget']);
  });

  it('SAC paga amortização constante mais juros', () => {
    const r = simulatePlan({
      budgets: [],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      withTimeline: true,
      debts: [debt({ id: 's', structure: 'sac', monthlyRatePpm: 10000, balanceCents: 303000, remainingInstallments: 3 })],
    });
    // A = 101.000; mês 0: 101.000 + juros embutidos (3.000) → 199.000; dez: +1.990, paga 101.000 + 1.990 → 98.000; jan: +980 → 0
    expect(r.perDebt[0]!.timeline).toEqual([199000, 98000, 0]);
    expect(r.perDebt[0]!.interestCents).toBe(1990 + 980);
  });

  it('rotativo que não diminui: aviso e não quita em 600 meses', () => {
    const r = simulatePlan({
      budgets: [],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      debts: [debt({ id: 'r', name: 'Rotativo', structure: 'revolving', monthlyRatePpm: 140000, balanceCents: 200000, minPaymentKind: 'percent', minPaymentValue: 100000 })],
    });
    expect(r.payoffMonth).toBeNull();
    expect(r.perDebt[0]!.payoffMonth).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(['no_budget', 'not_decreasing', 'never_paid_off']);
    expect(Number.isSafeInteger(r.totalInterestCents)).toBe(true);
  });

  it('rotativo com mínimo percentual acima da taxa quita (o arredondamento não trava os últimos centavos)', () => {
    // Antes: saldo de 7 centavos a 8% → juros de 1 centavo e mínimo de 1 centavo para sempre.
    const r = simulatePlan({
      budgets: [],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      minimumOnly: true,
      debts: [debt({ id: 'ce', structure: 'revolving', monthlyRatePpm: 80000, balanceCents: 120000, minPaymentKind: 'percent', minPaymentValue: 150000 })],
    });
    expect(r.perDebt[0]!.payoffMonth).not.toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(['no_budget']);
    expect(revolvingMinimum(200000, 'percent', 150000)).toBe(30000);
    expect(revolvingMinimum(1001, 'percent', 150000)).toBe(151); // 150,15 → para cima
    expect(revolvingMinimum(100, 'percent', 150000)).toBe(100); // até R$ 1,00: paga tudo
    expect(revolvingMinimum(5000, 'fixed', 8000)).toBe(5000);
  });

  it('orçamento que não cobre as parcelas: aviso, e as parcelas são pagas assim mesmo', () => {
    const r = simulatePlan({
      budgets: [{ fromMonth: '2026-01', amountCents: 80000 }],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      withTimeline: true,
      debts: [debt({ id: 'x', balanceCents: 1_000_000, installmentCents: 50000 }), debt({ id: 'y', balanceCents: 1_000_000, installmentCents: 45000 })],
    });
    const w = r.warnings.find((x) => x.code === 'budget_short');
    expect(w).toMatchObject({ budgetCents: 80000, requiredCents: 95000, message: 'O orçamento de R$ 800,00 não cobre as parcelas e mínimos (R$ 950,00).' });
    expect(r.perDebt[0]!.timeline![0]).toBe(950000);
  });

  it('vigência futura do orçamento passa a valer no mês dela', () => {
    const r = simulatePlan({
      budgets: [
        { fromMonth: '2026-01', amountCents: 10000 },
        { fromMonth: '2027-01', amountCents: 50000 },
      ],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      withTimeline: true,
      debts: [debt({ id: 'z', balanceCents: 100000 })],
    });
    expect(r.perDebt[0]!.timeline).toEqual([90000, 80000, 30000, 0]);
  });
});

describe('plano e comparação', () => {
  const ds = [
    planDebt({ id: 'caro', structure: 'price', monthlyRatePpm: 80000, balanceCents: 300000, installmentCents: 30000, createdAt: '2' }),
    planDebt({ id: 'barato', structure: 'price', monthlyRatePpm: 10000, balanceCents: 200000, installmentCents: 20000, createdAt: '1' }),
  ];
  const input = { debts: ds, budgets: [{ fromMonth: '2026-01', amountCents: 100000 }], currentMonth: '2026-11', spentThisMonthCents: 0 };

  it('avalanche custa menos que a bola de neve; só o mínimo custa mais que todas', () => {
    const plan = buildPlan({ ...input, strategy: 'snowball', manualOrderSet: false });
    expect(plan.order).toEqual(['barato', 'caro']);
    const by = Object.fromEntries(plan.comparison.map((c) => [c.strategy, c]));
    expect(by.avalanche!.totalInterestCents).toBeLessThan(by.snowball!.totalInterestCents);
    expect(by.minimum!.totalInterestCents).toBeGreaterThan(by.snowball!.totalInterestCents);
    expect(plan.simulation.totalInterestCents).toBe(by.snowball!.totalInterestCents);
    expect(plan.simulation.perDebt[0]!.timeline).toBeDefined();
  });

  it('"Minha ordem" nunca gravada usa a avalanche', () => {
    const plan = buildPlan({ ...input, strategy: 'manual', manualOrderSet: false });
    expect(plan.order).toEqual(['caro', 'barato']);
    const by = Object.fromEntries(plan.comparison.map((c) => [c.strategy, c]));
    expect(by.manual!.totalInterestCents).toBe(by.avalanche!.totalInterestCents);
  });

  it('só o mínimo não passa a parcela de uma dívida quitada para as outras', () => {
    const r = simulatePlan({
      budgets: [{ fromMonth: '2026-01', amountCents: 100000 }],
      currentMonth: '2026-11',
      spentThisMonthCents: 0,
      minimumOnly: true,
      withTimeline: true,
      debts: [debt({ id: 'A', balanceCents: 40000, installmentCents: 20000 }), debt({ id: 'B', balanceCents: 100000, installmentCents: 20000 })],
    });
    expect(r.perDebt[0]!.payoffMonth).toBe('2026-12');
    expect(r.perDebt[1]!.timeline).toEqual([80000, 60000, 40000, 20000, 0]);
  });
});

describe('e se eu amortizar', () => {
  const terms = { structure: 'price' as const, monthlyRatePpm: 20000, installmentCents: 50000, remainingInstallments: 11, minPaymentKind: null, minPaymentValue: null };
  it('reduzir prazo economiza mais juros que reduzir parcela', () => {
    const r = whatIfExtra(terms, 500000, 200000);
    expect(r.baseline.months).toBe(12);
    expect(r.reduceTerm!.installmentCents).toBe(50000);
    expect(r.reduceTerm!.months).toBe(7);
    expect(r.reduceInstallment!.installmentCents).toBe(30654);
    expect(r.reduceInstallment!.months).toBe(11);
    expect(r.reduceTerm!.interestSavedCents).toBeGreaterThan(r.reduceInstallment!.interestSavedCents);
    expect(r.reduceTerm!.monthsSaved).toBe(5);
  });
  it('rotativo tem um só resultado', () => {
    const r = whatIfExtra({ structure: 'revolving', monthlyRatePpm: 50000, installmentCents: null, remainingInstallments: null, minPaymentKind: 'fixed', minPaymentValue: 20000 }, 100000, 50000);
    expect(r.single).toBeDefined();
    expect(r.reduceTerm).toBeUndefined();
    expect(r.single!.months).toBeLessThan(r.baseline.months!);
  });
  it('parcela que não cobre os juros: não quita', () => {
    const r = whatIfExtra({ ...terms, installmentCents: 5000 }, 500000, 1000);
    expect(r.baseline.months).toBeNull();
    expect(r.reduceTerm!.monthsSaved).toBeNull();
  });
});
