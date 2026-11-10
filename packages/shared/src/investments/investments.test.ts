import { describe, expect, it } from 'vitest';
import { addDays } from '../dates';
import { simulatePlan, type SimDebt } from '../debts';
import {
  effectiveMonthlyPpm,
  formatCdiShare,
  formatYield,
  iofRatePct,
  irRatePermil,
  KIND_DEFAULTS,
  lotTaxes,
  normalizeInvestmentTerms,
  pastSeries,
  projectInvestment,
  sumSeries,
  taxByBracket,
  taxIfRedeemedAll,
  walkInvestment,
  withdrawalTax,
  type MovementLite,
} from './index';

const initial = (date: string, amountCents: number): MovementLite => ({ date, kind: 'initial', amountCents });
const deposit = (date: string, amountCents: number): MovementLite => ({ date, kind: 'deposit', amountCents });
const withdrawal = (date: string, amountCents: number): MovementLite => ({ date, kind: 'withdrawal', amountCents });

describe('taxa efetiva', () => {
  it('12,6825% a.a. de CDI a 100% = 1% a.m.', () => {
    expect(effectiveMonthlyPpm({ yieldKind: 'cdi', cdiShareBp: 10_000, fixedRatePpm: null }, 126_825)).toBe(10_000);
  });
  it('% do CDI proporcional e prefixado direto', () => {
    expect(effectiveMonthlyPpm({ yieldKind: 'cdi', cdiShareBp: 5_000, fixedRatePpm: null }, 126_825)).toBe(5_000);
    expect(effectiveMonthlyPpm({ yieldKind: 'fixed', fixedRatePpm: 11_000, cdiShareBp: null }, null)).toBe(11_000);
    expect(effectiveMonthlyPpm({ yieldKind: 'none', fixedRatePpm: null, cdiShareBp: null }, 126_825)).toBe(0);
  });
  it('sem CDI, a caixinha com % do CDI não rende', () => {
    expect(effectiveMonthlyPpm({ yieldKind: 'cdi', cdiShareBp: 10_000, fixedRatePpm: null }, null)).toBe(0);
  });
  it('normaliza os campos do outro tipo e formata', () => {
    expect(normalizeInvestmentTerms({ yieldKind: 'cdi', cdiShareBp: 10_500, fixedRatePpm: 9_000 })).toEqual({ yieldKind: 'cdi', cdiShareBp: 10_500, fixedRatePpm: null });
    expect(normalizeInvestmentTerms({ yieldKind: 'none', cdiShareBp: 10_500, fixedRatePpm: 9_000 })).toEqual({ yieldKind: 'none', cdiShareBp: null, fixedRatePpm: null });
    expect(formatCdiShare(9_550)).toBe('95,5%');
    expect(formatYield({ yieldKind: 'cdi', cdiShareBp: 10_000, fixedRatePpm: null })).toBe('100% do CDI');
    expect(formatYield({ yieldKind: 'fixed', fixedRatePpm: 11_000, cdiShareBp: null })).toBe('1,1% a.m.');
    expect(formatYield({ yieldKind: 'none', fixedRatePpm: null, cdiShareBp: null })).toBe('Não rende');
  });
  it('sugestões por tipo', () => {
    expect(KIND_DEFAULTS.lci_lca).toMatchObject({ yieldKind: 'cdi', cdiShareBp: 9_500, taxMode: 'exempt' });
    expect(KIND_DEFAULTS.poupanca).toMatchObject({ yieldKind: 'fixed', fixedRatePpm: 5_000, taxMode: 'exempt' });
    expect(KIND_DEFAULTS.savings_box.taxMode).toBe('regressive');
  });
});

describe('caminhada (saldo estimado e lotes)', () => {
  it('juros compostos mês a mês: R$ 10.000 a 1% a.m. de 10/03 a 10/11 = R$ 10.828,56', () => {
    const w = walkInvestment([initial('2026-03-10', 1_000_000)], [], 10_000, '2026-11-10');
    expect(w.grossCents).toBe(1_082_856);
    expect(w.principalCents).toBe(1_000_000);
    expect(w.yieldCents).toBe(82_856);
  });
  it('vira o ano', () => {
    expect(walkInvestment([initial('2026-12-15', 1_000_000)], [], 10_000, '2027-01-10').grossCents).toBe(1_010_000);
  });
  it('a âncora no mesmo dia vem depois das movimentações', () => {
    const w = walkInvestment([initial('2026-10-01', 150_000), deposit('2026-11-10', 10_000)], [{ date: '2026-11-10', balanceCents: 200_000 }], 0, '2026-11-10');
    expect(w.grossCents).toBe(200_000);
    expect(w.principalCents).toBe(160_000);
  });
  it('a âncora corrige o saldo e vira rendimento', () => {
    const w = walkInvestment([initial('2026-03-10', 1_000_000)], [{ date: '2026-11-10', balanceCents: 1_084_000 }], 10_000, '2026-11-10');
    expect(w.grossCents).toBe(1_084_000);
    expect(w.yieldCents).toBe(84_000);
  });
  it('o resgate consome o lote mais antigo primeiro', () => {
    const w = walkInvestment(
      [initial('2025-01-10', 100_000), deposit('2026-10-10', 100_000), withdrawal('2026-11-05', 110_000)],
      [{ date: '2026-11-01', balanceCents: 220_000 }],
      0,
      '2026-11-10',
    );
    expect(w.lots).toEqual([{ date: '2026-10-10', principalCents: 100_000 }]);
    expect(w.grossCents).toBe(110_000);
  });
  it('eventos depois da data ficam fora; sem eventos, zero', () => {
    expect(walkInvestment([initial('2026-12-01', 100)], [], 0, '2026-11-10').grossCents).toBe(0);
    expect(walkInvestment([], [], 10_000, '2026-11-10')).toEqual({ grossCents: 0, principalCents: 0, yieldCents: 0, lots: [] });
  });
  it('resgate de tudo zera o principal', () => {
    const w = walkInvestment([initial('2026-01-01', 100_000), withdrawal('2026-02-01', 101_000)], [], 10_000, '2026-03-01');
    expect(w).toMatchObject({ grossCents: 0, principalCents: 0, lots: [] });
  });
});

describe('impostos', () => {
  it('faixas do IR e do IOF', () => {
    expect([180, 181, 360, 361, 720, 721].map(irRatePermil)).toEqual([225, 200, 200, 175, 175, 150]);
    expect([0, 1, 9, 29, 30].map(iofRatePct)).toEqual([96, 96, 70, 3, 0]);
  });
  it('IR de 20% entre 181 e 360 dias: R$ 165,71 e líquido R$ 10.662,85', () => {
    const w = walkInvestment([initial('2026-03-10', 1_000_000)], [], 10_000, '2026-11-10');
    const t = taxIfRedeemedAll(w, '2026-11-10', 'regressive');
    expect(t).toMatchObject({ irCents: 16_571, iofCents: 0, totalCents: 16_571 });
    expect(w.grossCents - t.totalCents).toBe(1_066_285);
  });
  it('IOF antes de 30 dias: R$ 2,80 + IR R$ 0,27', () => {
    const w = walkInvestment([initial('2026-11-01', 100_000)], [{ date: '2026-11-10', balanceCents: 100_400 }], 0, '2026-11-10');
    const t = taxIfRedeemedAll(w, '2026-11-10', 'regressive');
    expect(t).toMatchObject({ iofCents: 280, irCents: 27, totalCents: 307 });
    expect(w.grossCents - t.totalCents).toBe(100_093);
  });
  it('rendimento dividido por principal × dias', () => {
    const date = '2026-11-10';
    const t = lotTaxes(
      [
        { date: addDays(date, -600), principalCents: 100_000 },
        { date: addDays(date, -30), principalCents: 100_000 },
      ],
      6_300,
      date,
      'regressive',
    );
    expect(t.byLot.map((l) => [l.yieldCents, l.irRatePermil])).toEqual([
      [6_000, 175],
      [300, 225],
    ]);
    expect(taxByBracket(t).map((r) => r.label)).toEqual(['Até 180 dias', 'De 361 a 720 dias']);
  });
  it('isento e rendimento negativo não pagam', () => {
    const w = walkInvestment([initial('2026-01-01', 100_000)], [], 10_000, '2026-11-10');
    expect(taxIfRedeemedAll(w, '2026-11-10', 'exempt').totalCents).toBe(0);
    const neg = walkInvestment([initial('2026-01-01', 100_000)], [{ date: '2026-06-01', balanceCents: 90_000 }], 0, '2026-11-10');
    expect(neg.yieldCents).toBe(-10_000);
    expect(taxIfRedeemedAll(neg, '2026-11-10', 'regressive').totalCents).toBe(0);
  });
  it('imposto de um resgate parcial e do resgate total', () => {
    const w = walkInvestment([initial('2026-03-10', 1_000_000)], [], 10_000, '2026-11-10');
    expect(withdrawalTax(w, w.grossCents, '2026-11-10', 'regressive').totalCents).toBe(16_571);
    // metade: consome R$ 5.000 de principal; rendimento da fatia R$ 414,28 a 20%
    expect(withdrawalTax(w, 541_428, '2026-11-10', 'regressive').totalCents).toBe(8_286);
    expect(withdrawalTax(w, 541_428, '2026-11-10', 'exempt').totalCents).toBe(0);
  });
});

describe('projeção', () => {
  const today = '2026-11-10';
  const flat = walkInvestment([initial('2026-01-01', 1_000_000)], [], 0, today);
  const base = { walk: flat, ratePpm: 0, monthlyPlanCents: 100_000, goalCents: 1_500_000, goalMonth: null, redeemableFrom: null, taxMode: 'regressive' as const, today, horizonMonths: 24 };

  it('chega na meta em abr/2027', () => {
    const p = projectInvestment(base);
    expect(p.goal).toEqual({ reachedMonth: '2027-04', reachedNow: false, shortfall: null });
    expect(p.series).toHaveLength(24);
    expect(p.series[0]).toEqual({ month: '2026-12', principalCents: 1_100_000, grossCents: 1_100_000 });
  });
  it('não chega até fev/2027 e sugere R$ 1.666,67 por mês', () => {
    const p = projectInvestment({ ...base, goalMonth: '2027-02' });
    expect(p.goal?.shortfall).toEqual({ goalMonth: '2027-02', suggestedPlanCents: 166_667 });
  });
  it('sem plano e sem rendimento, não chega', () => {
    const p = projectInvestment({ ...base, monthlyPlanCents: null });
    expect(p.goal?.reachedMonth).toBeNull();
  });
  it('meta já atingida', () => {
    const p = projectInvestment({ ...base, goalCents: 900_000 });
    expect(p.goal).toMatchObject({ reachedNow: true, reachedMonth: '2026-11' });
  });
  it('líquido na data de resgate, com a idade dos lotes nessa data', () => {
    const w = walkInvestment([initial('2026-03-10', 1_000_000)], [], 10_000, today);
    const p = projectInvestment({ ...base, walk: w, ratePpm: 10_000, monthlyPlanCents: null, goalCents: null, redeemableFrom: '2028-03-15' });
    const r = p.atRedeem!;
    const yieldCents = r.grossCents - 1_000_000;
    expect(r.taxCents).toBe(Math.round(yieldCents * 0.15)); // mais de 720 dias
    expect(r.netCents).toBe(r.grossCents - r.taxCents);
    expect(p.monthlyYieldCents).toBe(10_829);
  });
});

describe('séries', () => {
  it('meses antes do primeiro aporte ficam zerados e as séries somam', () => {
    const s = pastSeries([initial('2026-10-05', 100_000)], [], 0, '2026-11-10', 3);
    expect(s.map((p) => [p.month, p.grossCents])).toEqual([
      ['2026-09', 0],
      ['2026-10', 100_000],
      ['2026-11', 100_000],
    ]);
    expect(sumSeries([s, s])[2]).toEqual({ month: '2026-11', principalCents: 200_000, grossCents: 200_000 });
  });
});

describe('amortização extra por mês (Dívidas)', () => {
  const d = (over: Partial<SimDebt> = {}): SimDebt => ({
    id: 'a',
    name: 'A',
    structure: 'interest_free',
    monthlyRatePpm: 0,
    installmentCents: 150_000,
    remainingInstallments: null,
    minPaymentKind: null,
    minPaymentValue: null,
    acceptsExtra: true,
    balanceCents: 1_100_000,
    paidThisMonthCents: 0,
    ...over,
  });
  const budgets = [{ fromMonth: '2026-11', amountCents: 200_000 }];

  it('orçamento de 2.000 com 1.500 obrigatórios: 500 por mês, e zero depois de quitar', () => {
    const r = simulatePlan({ debts: [d()], budgets, currentMonth: '2026-11', spentThisMonthCents: 0 });
    expect(r.extraByMonth).toEqual([50_000, 50_000, 50_000, 50_000, 50_000, 0]);
  });
  it('mês 0 com a parcela e uma extra já pagas', () => {
    const r = simulatePlan({ debts: [d({ paidThisMonthCents: 180_000 })], budgets, currentMonth: '2026-11', spentThisMonthCents: 180_000 });
    expect(r.extraByMonth[0]).toBe(20_000);
  });
  it('sem orçamento, sem extra', () => {
    const r = simulatePlan({ debts: [d()], budgets: [], currentMonth: '2026-11', spentThisMonthCents: 0 });
    expect(r.extraByMonth.every((v) => v === 0)).toBe(true);
  });
});
