import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/**
 * Investimentos em caixinhas (ADR-0012): cadastro, CDI, âncoras, aportes e resgates, trava, limite de saldo,
 * encerrar e reabrir, exclusão, e o que muda no resumo do mês (inclusive a amortização extra de dívidas).
 * Módulo isolado da tabela do mês. Hoje: 03/11/2026 (São Paulo).
 */
let env: TestEnv;
let c: Client;

type Row = Record<string, any>;
const box = {
  name: 'Reserva',
  icon: 'piggy',
  kind: 'savings_box',
  yieldKind: 'fixed',
  fixedRatePpm: 10000,
  taxMode: 'regressive',
  initialCents: 1_000_000,
  initialDate: '2026-03-03',
};
const createIn = async (cl: Client, body: Record<string, unknown>): Promise<Row> => {
  const res = await cl.post(cl.w('/investments'), body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const create = (body: Record<string, unknown>) => createIn(c, body);
const get = async (id: string): Promise<Row> => (await c.get(c.w(`/investments/${id}`))).json();
const move = (id: string, body: Record<string, unknown>) => c.post(c.w(`/investments/${id}/movements`), body);
const code = (res: { json: () => any }) => res.json().error?.code;
const fields = (res: { json: () => any }) => Object.keys(res.json().error.fields ?? {});

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
});
afterAll(async () => env.close());

describe('cadastro e isolamento', () => {
  it('cria a caixinha com o valor inicial e não toca a tabela do mês', async () => {
    const before = (await c.get(c.w('/occurrences?month=2026-11'))).json();
    const inv = await create({ ...box, cdiShareBp: 10500 });
    expect(inv).toMatchObject({
      status: 'active',
      yieldKind: 'fixed',
      fixedRatePpm: 10000,
      cdiShareBp: null, // normalizado
      initial: { date: '2026-03-03', amountCents: 1_000_000 },
      // 1% a.m. de 03/03 a 03/11: 8 viradas de mês
      grossCents: 1_082_856,
      principalCents: 1_000_000,
      yieldCents: 82_856,
      // 245 dias: 20% de IR
      taxTodayCents: 16_571,
      netTodayCents: 1_066_285,
      monthlyYieldCents: 10_829,
      locked: false,
    });
    expect(inv.movements).toEqual([expect.objectContaining({ kind: 'initial', amountCents: 1_000_000, taxCents: null })]);
    expect(inv.taxByBracket).toEqual([expect.objectContaining({ label: 'De 181 a 360 dias', irRatePermil: 200, irCents: 16_571 })]);
    expect((await c.get(c.w('/occurrences?month=2026-11'))).json()).toEqual(before);
    await c.del(c.w(`/investments/${inv.id}`));
  });

  it('recusa ícone fora da lista, mês-alvo sem meta e data no futuro', async () => {
    const icon = await c.post(c.w('/investments'), { ...box, icon: 'rocket' });
    expect(icon.statusCode).toBe(400);
    expect(fields(icon)).toEqual(['icon']);
    const goal = await c.post(c.w('/investments'), { ...box, goalMonth: '2027-12' });
    expect(fields(goal)).toEqual(['goalCents']);
    const future = await c.post(c.w('/investments'), { ...box, initialDate: '2026-11-04' });
    expect(fields(future)).toEqual(['initialDate']);
  });

  it('quem não é membro da carteira não acessa', async () => {
    const other = await signedIn(env, 'ana@example.com', 'Ana');
    expect((await other.get(c.w('/investments'))).statusCode).toBe(403);
    expect((await other.get(c.w('/investments/overview'))).statusCode).toBe(403);
    expect((await other.put(c.w('/investment-settings'), { cdiAnnualPpm: 149000 })).statusCode).toBe(403);
  });

  it('edita com controle de versão e exclui logicamente', async () => {
    const inv = await create(box);
    const upd = await c.put(c.w(`/investments/${inv.id}`), { ...box, name: 'Reserva de emergência', monthlyPlanCents: 50000, version: inv.version });
    expect(upd.json()).toMatchObject({ name: 'Reserva de emergência', monthlyPlanCents: 50000, version: inv.version + 1 });
    expect(code(await c.put(c.w(`/investments/${inv.id}`), { ...box, version: inv.version }))).toBe('conflict');
    expect((await c.del(c.w(`/investments/${inv.id}`))).statusCode).toBe(204);
    expect((await c.get(c.w('/investments'))).json().some((r: Row) => r.id === inv.id)).toBe(false);
    const gone = await c.get(c.w(`/investments/${inv.id}`));
    expect([gone.statusCode, code(gone)]).toEqual([404, 'investment_not_found']);
  });
});

describe('CDI da carteira', () => {
  it('sem CDI, a caixinha de % do CDI não rende e a visão geral avisa', async () => {
    const inv = await create({ ...box, yieldKind: 'cdi', cdiShareBp: 10000, fixedRatePpm: null });
    expect(inv).toMatchObject({ effectiveRatePpm: 0, grossCents: 1_000_000 });
    const ov = (await c.get(c.w('/investments/overview'))).json();
    expect(ov.warnings.map((w: Row) => w.code)).toEqual(['cdi_missing']);

    const s = (await c.put(c.w('/investment-settings'), { cdiAnnualPpm: 126825 })).json();
    expect(s).toEqual({ cdiAnnualPpm: 126825, cdiUpdatedOn: '2026-11-03' });
    expect(await get(inv.id)).toMatchObject({ effectiveRatePpm: 10000, grossCents: 1_082_856 });
    expect((await c.get(c.w('/investments/overview'))).json().warnings).toEqual([]);
    expect((await c.put(c.w('/investment-settings'), { cdiAnnualPpm: 0 })).statusCode).toBe(400);
    await c.del(c.w(`/investments/${inv.id}`));
  });
});

describe('saldo informado', () => {
  it('corrige o saldo e substitui a âncora da mesma data', async () => {
    const inv = await create(box);
    const a1 = (await c.post(c.w(`/investments/${inv.id}/anchors`), { date: '2026-11-03', balanceCents: 1_084_000 })).json();
    expect(a1).toMatchObject({ grossCents: 1_084_000, yieldCents: 84_000, anchor: { date: '2026-11-03', balanceCents: 1_084_000 } });
    const a2 = (await c.post(c.w(`/investments/${inv.id}/anchors`), { date: '2026-11-03', balanceCents: 1_090_000 })).json();
    expect(a2.anchors).toHaveLength(1);
    expect(a2.grossCents).toBe(1_090_000);
    expect(a2.movements[0].beforeAnchor).toBe(true);
    const removed = (await c.del(c.w(`/investments/${inv.id}/anchors/${a2.anchors[0].id}`))).json();
    expect(removed).toMatchObject({ grossCents: 1_082_856, anchor: null });
    expect(code(await c.post(c.w(`/investments/${inv.id}/anchors`), { date: '2026-01-01', balanceCents: 1 }))).toBe('movement_before_initial');
    await c.del(c.w(`/investments/${inv.id}`));
  });
});

describe('aportes e resgates', () => {
  it('guarda, resgata com imposto e edita', async () => {
    const inv = await create({ ...box, fixedRatePpm: 0, yieldKind: 'none', taxMode: 'exempt' });
    const dep = await move(inv.id, { date: '2026-11-02', kind: 'deposit', amountCents: 50000 });
    expect(dep.statusCode).toBe(201);
    expect(dep.json()).toMatchObject({ grossCents: 1_050_000, depositedThisMonthCents: 50000 });
    const wd = (await move(inv.id, { date: '2026-11-03', kind: 'withdrawal', amountCents: 100000, taxCents: 0 })).json();
    expect(wd.grossCents).toBe(950_000);
    const w = wd.movements.find((m: Row) => m.kind === 'withdrawal');
    const edited = await c.put(c.w(`/investments/${inv.id}/movements/${w.id}`), { date: '2026-11-03', amountCents: 120000, taxCents: 0, version: w.version });
    expect(edited.json().grossCents).toBe(930_000);
    await c.del(c.w(`/investments/${inv.id}`));
  });

  it('recusas: antes do inicial, imposto acima do valor, imposto no aporte, data no futuro', async () => {
    const inv = await create(box);
    expect(code(await move(inv.id, { date: '2026-02-01', kind: 'deposit', amountCents: 100 }))).toBe('movement_before_initial');
    expect(fields(await move(inv.id, { date: '2026-11-03', kind: 'withdrawal', amountCents: 10000, taxCents: 20000 }))).toEqual(['taxCents']);
    expect(fields(await move(inv.id, { date: '2026-11-03', kind: 'deposit', amountCents: 10000, taxCents: 1 }))).toEqual(['taxCents']);
    expect(fields(await move(inv.id, { date: '2026-11-04', kind: 'deposit', amountCents: 10000 }))).toEqual(['date']);
    await c.del(c.w(`/investments/${inv.id}`));
  });

  it('o valor inicial não é excluído nem pode ficar depois de outra movimentação', async () => {
    const inv = await create(box);
    const after = (await move(inv.id, { date: '2026-05-01', kind: 'deposit', amountCents: 100 })).json();
    const initial = after.movements.find((m: Row) => m.kind === 'initial');
    expect(code(await c.del(c.w(`/investments/${inv.id}/movements/${initial.id}`)))).toBe('initial_movement_required');
    const late = await c.put(c.w(`/investments/${inv.id}/movements/${initial.id}`), { date: '2026-06-01', amountCents: 1_000_000, version: initial.version });
    expect(code(late)).toBe('movement_before_initial');
    await c.del(c.w(`/investments/${inv.id}`));
  });

  it('resgate acima do saldo estimado, e depois de atualizar o saldo', async () => {
    const inv = await create({ ...box, yieldKind: 'none', fixedRatePpm: null, initialCents: 120000 });
    const big = await move(inv.id, { date: '2026-11-03', kind: 'withdrawal', amountCents: 150000, taxCents: 0 });
    expect([big.statusCode, code(big)]).toEqual([409, 'withdrawal_exceeds_balance']);
    expect(big.json().error.message).toContain('R$ 1.200,00');
    await c.post(c.w(`/investments/${inv.id}/anchors`), { date: '2026-11-03', balanceCents: 160000 });
    expect((await move(inv.id, { date: '2026-11-03', kind: 'withdrawal', amountCents: 150000, taxCents: 0 })).statusCode).toBe(201);
    await c.del(c.w(`/investments/${inv.id}`));
  });

  it('trava de resgate', async () => {
    const inv = await create({ ...box, name: 'CDB 2028', redeemableFrom: '2028-03-15' });
    expect(inv.locked).toBe(true);
    expect(inv.atRedeem).toMatchObject({ date: '2028-03-15' });
    const res = await move(inv.id, { date: '2026-11-03', kind: 'withdrawal', amountCents: 100, taxCents: 0 });
    expect([res.statusCode, code(res)]).toEqual([409, 'locked_until']);
    expect(res.json().error.message).toBe('Só pode resgatar a partir de 15/03/2028.');
    expect(code(await c.post(c.w(`/investments/${inv.id}/close`), { date: '2026-11-03' }))).toBe('locked_until');
    await c.del(c.w(`/investments/${inv.id}`));
  });
});

describe('encerrar e reabrir', () => {
  it('encerrar resgata o saldo com o imposto estimado; encerrada não movimenta; reabrir volta', async () => {
    const inv = await create(box);
    const closed = (await c.post(c.w(`/investments/${inv.id}/close`), { date: '2026-11-03' })).json();
    expect(closed).toMatchObject({ status: 'closed', closedOn: '2026-11-03', grossCents: 0 });
    expect(closed.movements[0]).toMatchObject({ kind: 'withdrawal', amountCents: 1_082_856, taxCents: 16_571 });
    expect(code(await move(inv.id, { date: '2026-11-03', kind: 'deposit', amountCents: 100 }))).toBe('investment_not_active');
    const reopened = (await c.post(c.w(`/investments/${inv.id}/reopen`))).json();
    expect(reopened).toMatchObject({ status: 'active', closedOn: null });
    expect(reopened.movements).toHaveLength(2);
    await c.del(c.w(`/investments/${inv.id}`));
  });
});

describe('visão geral', () => {
  it('totais, este mês, série passada e projeção', async () => {
    const d = await signedIn(env, 'bia@example.com', 'Bia');
    await createIn(d, { ...box, yieldKind: 'none', fixedRatePpm: null, taxMode: 'exempt', initialCents: 1_000_000, monthlyPlanCents: 50000 });
    const b = await createIn(d, { ...box, name: 'Viagem', yieldKind: 'none', fixedRatePpm: null, taxMode: 'exempt', initialCents: 300_000, monthlyPlanCents: 30000 });
    await d.post(d.w(`/investments/${b.id}/movements`), { date: '2026-11-02', kind: 'deposit', amountCents: 60000 });
    const ov = (await d.get(d.w('/investments/overview'))).json();
    expect(ov.totals).toMatchObject({ grossCents: 1_360_000, monthlyPlanCents: 80000, planCount: 2, activeCount: 2 });
    expect(ov.thisMonth).toEqual({ plannedCents: 80000, depositedCents: 60000 });
    expect(ov.past).toHaveLength(12);
    expect(ov.past.at(-1)).toEqual({ month: '2026-11', principalCents: 1_360_000, grossCents: 1_360_000 });
    expect(ov.projection).toHaveLength(24);
    expect(ov.projection[0]).toEqual({ month: '2026-12', principalCents: 1_440_000, grossCents: 1_440_000 });
  });
});

describe('resumo do mês', () => {
  let d: Client;
  const summary = async (month: string) => (await d.get(d.w(`/summary?month=${month}`))).json();

  beforeAll(async () => {
    d = await signedIn(env, 'caio@example.com', 'Caio');
    await d.post(d.w('/items'), { type: 'income', form: 'single', method: 'pix', description: 'Salário', amountCents: 500000, date: '2026-11-02', alreadyPaid: true });
    await d.post(d.w('/items'), { type: 'expense', form: 'single', method: 'pix', description: 'Mercado', amountCents: 100000, date: '2026-11-02', alreadyPaid: true });
  });

  it('sem caixinhas e sem orçamento de dívidas, nada muda', async () => {
    const s = await summary('2026-11');
    expect(s.investments).toEqual({ plannedCents: 0, depositedCents: 0, forecastCents: 0, withdrawnCents: 0 });
    expect(s.debtExtra).toEqual({ plannedCents: 0, paidCents: 0, forecastCents: 0 });
    expect(s.balance).toEqual({ forecastCents: 400000, realizedCents: 400000 });
  });

  it('mês atual com caixinha e amortização planejadas; o valor inicial fica fora', async () => {
    const inv = await createIn(d, { ...box, monthlyPlanCents: 100000 });
    await d.post(d.w(`/investments/${inv.id}/movements`), { date: '2026-11-02', kind: 'deposit', amountCents: 60000 });
    const debt = (
      await d.post(d.w('/debts'), {
        name: 'Empréstimo',
        category: 'other',
        structure: 'interest_free',
        monthlyRatePpm: 0,
        installmentCents: 150000,
        acceptsExtra: true,
        anchorDate: '2026-11-01',
        anchorBalanceCents: 1_000_000,
      })
    ).json();
    await d.put(d.w('/debt-budgets/2026-11'), { amountCents: 200000 });

    const s = await summary('2026-11');
    expect(s.investments).toEqual({ plannedCents: 100000, depositedCents: 60000, forecastCents: 100000, withdrawnCents: 0 });
    expect(s.debtExtra).toEqual({ plannedCents: 50000, paidCents: 0, forecastCents: 50000 });
    expect(s.balance).toEqual({ forecastCents: 250000, realizedCents: 340000 });
    // O valor inicial (março) não mexe em março nem em novembro.
    expect((await summary('2026-03')).investments).toEqual({ plannedCents: null, depositedCents: 0, forecastCents: 0, withdrawnCents: 0 });

    // Futuro: o plano das caixinhas e a sobra da simulação.
    const dec = await summary('2026-12');
    expect(dec.investments.forecastCents).toBe(100000);
    expect(dec.debtExtra).toEqual({ plannedCents: 50000, paidCents: 0, forecastCents: 50000 });

    // Passado: só o realizado.
    expect((await summary('2026-10')).investments).toEqual({ plannedCents: null, depositedCents: 0, forecastCents: 0, withdrawnCents: 0 });

    // Aportou mais que o planejado.
    await d.post(d.w(`/investments/${inv.id}/movements`), { date: '2026-11-03', kind: 'deposit', amountCents: 90000 });
    expect((await summary('2026-11')).investments.forecastCents).toBe(150000);

    // Resgate volta para o balanço (valor − imposto).
    await d.post(d.w(`/investments/${inv.id}/movements`), { date: '2026-11-03', kind: 'withdrawal', amountCents: 200000, taxCents: 5000 });
    const r = await summary('2026-11');
    expect(r.investments.withdrawnCents).toBe(195000);
    expect(r.balance).toEqual({
      forecastCents: 500000 - 100000 - 150000 + 195000 - 50000,
      realizedCents: 500000 - 100000 - 150000 + 195000,
    });

    // Parcela (obrigatória) não conta; extra acima do planejado conta inteira.
    await d.post(d.w(`/debts/${debt.id}/payments`), { date: '2026-11-03', kind: 'installment', amountCents: 150000 });
    await d.post(d.w(`/debts/${debt.id}/payments`), { date: '2026-11-03', kind: 'extra', amountCents: 80000 });
    const e = await summary('2026-11');
    expect(e.debtExtra).toEqual({ plannedCents: 80000, paidCents: 80000, forecastCents: 80000 });
    expect(e.balance.realizedCents).toBe(500000 - 100000 - 150000 + 195000 - 80000);

    // Caixinha excluída sai do resumo.
    await d.del(d.w(`/investments/${inv.id}`));
    expect((await summary('2026-11')).investments).toEqual({ plannedCents: 0, depositedCents: 0, forecastCents: 0, withdrawnCents: 0 });
  });
});
