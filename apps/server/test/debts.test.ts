import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clockAt } from '../src/domain/clock';
import { getDebt } from '../src/domain/debts';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/**
 * Gestão de dívidas (ADR-0011): cadastro, âncoras, saldo estimado, pagamentos, quitação, orçamento,
 * estratégia e plano. Módulo isolado da tabela do mês. Hoje: 03/11/2026 (São Paulo).
 */
let env: TestEnv;
let c: Client;
let maria: string;

type Row = Record<string, any>;
const price = {
  name: 'Empréstimo Banco X',
  category: 'personal_loan',
  structure: 'price',
  monthlyRatePpm: 29900,
  installmentCents: 45000,
  remainingInstallments: 18,
  dueDay: 10,
  acceptsExtra: true,
  anchorDate: '2026-11-01',
  anchorBalanceCents: 680000,
};
const create = async (body: Record<string, unknown>): Promise<Row> => {
  const res = await c.post(c.w('/debts'), body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const pay = (id: string, body: Record<string, unknown>) => c.post(c.w(`/debts/${id}/payments`), { kind: 'installment', ...body });
const get = async (id: string): Promise<Row> => (await c.get(c.w(`/debts/${id}`))).json();
const plan = async (): Promise<Row> => (await c.get(c.w('/debt-plan'))).json();
const list = async (): Promise<Row[]> => (await c.get(c.w('/debts'))).json();
const fields = (res: { json: () => any }) => Object.keys(res.json().error.fields ?? {});

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  maria = (await c.post(c.w('/people'), { name: 'Maria' })).json().id;
});
afterAll(async () => env.close());

describe('acesso e isolamento', () => {
  it('cria a dívida com a primeira âncora e não toca a tabela do mês', async () => {
    const before = (await c.get(c.w('/occurrences?month=2026-11'))).json();
    const d = await create(price);
    expect(d).toMatchObject({
      status: 'active',
      monthlyRatePpm: 29900,
      balanceCents: 680000,
      initial: { date: '2026-11-01', balanceCents: 680000 },
      anchor: { date: '2026-11-01', balanceCents: 680000 },
      remainingInstallments: 18,
      contractAsOf: '2026-11-01',
      paidCents: 0,
    });
    expect(d.anchors).toHaveLength(1);
    expect((await c.get(c.w('/occurrences?month=2026-11'))).json()).toEqual(before);
    await c.del(c.w(`/debts/${d.id}`));
  });

  it('quem não é membro da carteira não acessa', async () => {
    const other = await signedIn(env, 'ana@example.com', 'Ana');
    expect((await other.get(c.w('/debts'))).statusCode).toBe(403);
    expect((await other.get(c.w('/debt-plan'))).statusCode).toBe(403);
  });

  it('pagar um lançamento do mês não muda a dívida', async () => {
    const d = await create(price);
    const item = (await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', description: 'Parcela empréstimo', amountCents: 45000, date: '2026-11-02', alreadyPaid: true })).json();
    expect(item.id).toBeDefined();
    expect((await get(d.id)).balanceCents).toBe(680000);
    await c.del(c.w(`/debts/${d.id}`));
  });
});

describe('cadastro e validações', () => {
  it('recusa Price sem parcela, Sem juros com taxa, credor duplo, Pessoa sem pessoa e taxa acima do limite', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...price, installmentCents: null }, 'installmentCents'],
      [{ ...price, structure: 'interest_free', monthlyRatePpm: 10000 }, 'monthlyRatePpm'],
      [{ ...price, creditorName: 'Banco', creditorPersonId: maria }, 'creditorName'],
      [{ ...price, category: 'person' }, 'creditorPersonId'],
      [{ ...price, monthlyRatePpm: 600000 }, 'monthlyRatePpm'],
      [{ ...price, anchorDate: '2026-11-04' }, 'anchorDate'],
    ];
    for (const [body, field] of cases) {
      const res = await c.post(c.w('/debts'), body);
      expect(res.statusCode, field).toBe(400);
      expect(res.json().error.code).toBe('validation');
      expect(fields(res)).toContain(field);
    }
  });

  it('credor como pessoa da carteira e troca de estrutura que limpa campos', async () => {
    const d = await create({ ...price, name: 'Mãe', category: 'person', structure: 'interest_free', monthlyRatePpm: 0, installmentCents: null, remainingInstallments: null, dueDay: null, creditorPersonId: maria, anchorBalanceCents: 100000 });
    expect(d.creditorPerson).toEqual({ id: maria, name: 'Maria' });
    expect(d.remainingInstallments).toBeNull();
    const res = await c.put(c.w(`/debts/${d.id}`), {
      ...price,
      category: 'overdraft',
      structure: 'revolving',
      monthlyRatePpm: 80000,
      minPaymentKind: 'percent',
      minPaymentValue: 150000,
      version: d.version,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ structure: 'revolving', installmentCents: null, remainingInstallments: null, dueDay: null, minPaymentKind: 'percent', minPaymentValue: 150000, creditorPerson: null });
    // versão desatualizada
    const stale = await c.put(c.w(`/debts/${d.id}`), { ...price, version: d.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
    await c.del(c.w(`/debts/${d.id}`));
  });
});

describe('âncoras e saldo estimado', () => {
  it('juros no início do mês seguinte e pagamentos depois da âncora; segue o relógio', async () => {
    const d = await create({ ...price, structure: 'revolving', category: 'overdraft', monthlyRatePpm: 100000, installmentCents: null, remainingInstallments: null, dueDay: null, minPaymentKind: 'fixed', minPaymentValue: 10000, anchorDate: '2026-10-20', anchorBalanceCents: 100000 });
    await pay(d.id, { date: '2026-11-02', amountCents: 30000 });
    expect((await get(d.id)).balanceCents).toBe(80000);
    // Em dezembro, com o relógio do domínio (sem avançar o relógio da sessão).
    const dec = await getDebt(env.ctx.db, c.walletId, d.id, clockAt('America/Sao_Paulo', new Date('2026-12-05T15:00:00Z')));
    expect(dec.balanceCents).toBe(88000);
    await c.del(c.w(`/debts/${d.id}`));
  });

  it('atualizar saldo: substitui na mesma data, recusa data futura e não exclui a única âncora', async () => {
    const d = await create(price);
    expect((await c.post(c.w(`/debts/${d.id}/anchors`), { date: '2026-11-04', balanceCents: 1 })).statusCode).toBe(400);
    const lone = await c.del(c.w(`/debts/${d.id}/anchors/${d.anchors[0].id}`));
    expect(lone.statusCode).toBe(409);
    expect(lone.json().error.code).toBe('last_anchor');

    const a = await c.post(c.w(`/debts/${d.id}/anchors`), { date: '2026-11-03', balanceCents: 650000, remainingInstallments: 17, installmentCents: 44000 });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ balanceCents: 650000, initial: { balanceCents: 680000 }, remainingInstallments: 17, installmentCents: 44000, contractAsOf: '2026-11-03' });
    const again = (await c.post(c.w(`/debts/${d.id}/anchors`), { date: '2026-11-03', balanceCents: 640000 })).json();
    expect(again.anchors).toHaveLength(2);
    expect(again.balanceCents).toBe(640000);
    const removed = await c.del(c.w(`/debts/${d.id}/anchors/${again.anchors[0].id}`));
    expect(removed.json().balanceCents).toBe(680000);
    await c.del(c.w(`/debts/${d.id}`));
  });
});

describe('pagamentos', () => {
  it('pagamento antes da âncora conta no pago mas não no saldo; parcelas restantes diminuem', async () => {
    const d = await create(price);
    const before = (await pay(d.id, { date: '2026-10-28', amountCents: 45000 })).json();
    expect(before).toMatchObject({ balanceCents: 680000, paidCents: 45000, remainingInstallments: 18 });
    expect(before.payments[0].beforeAnchor).toBe(true);
    const after = (await pay(d.id, { date: '2026-11-02', amountCents: 45000 })).json();
    expect(after).toMatchObject({ balanceCents: 635000, paidCents: 90000, remainingInstallments: 17 });
    await c.del(c.w(`/debts/${d.id}`));
  });

  it('amortização extra grava o contrato confirmado; sem contrato, o servidor sugere', async () => {
    const d = await create({ ...price, monthlyRatePpm: 20000, installmentCents: 50000, remainingInstallments: 11, anchorBalanceCents: 500000 });
    const noEffect = await pay(d.id, { date: '2026-11-02', amountCents: 200000, kind: 'extra' });
    expect(noEffect.statusCode).toBe(400);
    expect(fields(noEffect)).toEqual(['extraEffect']);

    const confirmed = (await pay(d.id, { date: '2026-11-02', amountCents: 200000, kind: 'extra', extraEffect: 'reduce_term', contract: { installmentCents: 50000, remainingInstallments: 8 } })).json();
    expect(confirmed).toMatchObject({ balanceCents: 300000, installmentCents: 50000, remainingInstallments: 8, contractAsOf: '2026-11-02' });

    const suggested = (await pay(d.id, { date: '2026-11-03', amountCents: 100000, kind: 'extra', extraEffect: 'reduce_installment' })).json();
    // saldo 200.000, 8 parcelas a 2%: parcela de R$ 273,02
    expect(suggested).toMatchObject({ balanceCents: 200000, remainingInstallments: 8, installmentCents: 27302, contractAsOf: '2026-11-03' });

    // editar e excluir a amortização não desfaz o contrato
    const extra = suggested.payments.find((p: Row) => p.amountCents === 100000);
    const edited = (await c.put(c.w(`/debts/${d.id}/payments/${extra.id}`), { date: '2026-11-03', amountCents: 90000, kind: 'extra', version: extra.version })).json();
    expect(edited).toMatchObject({ balanceCents: 210000, installmentCents: 27302 });
    const stale = await c.put(c.w(`/debts/${d.id}/payments/${extra.id}`), { date: '2026-11-03', amountCents: 80000, kind: 'extra', version: extra.version });
    expect(stale.statusCode).toBe(409);
    const deleted = (await c.del(c.w(`/debts/${d.id}/payments/${extra.id}`))).json();
    expect(deleted).toMatchObject({ balanceCents: 300000, installmentCents: 27302, remainingInstallments: 8 });
    await c.del(c.w(`/debts/${d.id}`));
  });

  it('recusa amortização em dívida que não aceita e pagamento em dívida quitada', async () => {
    const d = await create({ ...price, category: 'payroll_loan', acceptsExtra: false });
    const extra = await pay(d.id, { date: '2026-11-02', amountCents: 1000, kind: 'extra', extraEffect: 'reduce_term' });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error.code).toBe('extra_not_allowed');
    await c.post(c.w(`/debts/${d.id}/pay-off`), { date: '2026-11-03' });
    const closed = await pay(d.id, { date: '2026-11-03', amountCents: 1000 });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('debt_not_active');
    await c.del(c.w(`/debts/${d.id}`));
  });
});

describe('quitar, reabrir, excluir e orçamento', () => {
  it('quita com pagamento final, reabre no fim da ordem e some ao excluir', async () => {
    const a = await create({ ...price, name: 'A' });
    const b = await create({ ...price, name: 'B', anchorBalanceCents: 12000 });
    const paid = (await c.post(c.w(`/debts/${b.id}/pay-off`), { date: '2026-11-03', finalPayment: true })).json();
    expect(paid).toMatchObject({ status: 'paid_off', paidOffOn: '2026-11-03', paidCents: 12000, balanceCents: 0 });
    expect((await plan()).order).toEqual([a.id]);

    const reopened = (await c.post(c.w(`/debts/${b.id}/reopen`))).json();
    expect(reopened.status).toBe('active');
    expect(reopened.position).toBeGreaterThan((await get(a.id)).position);

    await c.del(c.w(`/debts/${b.id}`));
    expect((await list()).map((d) => d.id)).toEqual([a.id]);
    expect((await c.get(c.w(`/debts/${b.id}`))).statusCode).toBe(404);
    await c.del(c.w(`/debts/${a.id}`));
  });

  it('orçamento por vigência e planejado × destinado, inclusive de dívida quitada', async () => {
    expect((await c.put(c.w('/debt-budgets/2026-13'), { amountCents: 1 })).statusCode).toBe(400);
    await c.put(c.w('/debt-budgets/2026-09'), { amountCents: 200000 });
    const budgets = (await c.put(c.w('/debt-budgets/2026-11'), { amountCents: 250000 })).json();
    expect(budgets).toEqual([
      { fromMonth: '2026-09', amountCents: 200000 },
      { fromMonth: '2026-11', amountCents: 250000 },
    ]);
    const a = await create({ ...price, anchorDate: '2026-09-01' });
    await pay(a.id, { date: '2026-10-10', amountCents: 165000 });
    await pay(a.id, { date: '2026-11-02', amountCents: 45000 });
    const q = await create({ ...price, name: 'Quitada', anchorBalanceCents: 30000 });
    await c.post(c.w(`/debts/${q.id}/pay-off`), { date: '2026-11-03', finalPayment: true });
    const gone = await create({ ...price, name: 'Excluída' });
    await pay(gone.id, { date: '2026-11-02', amountCents: 99900 });
    await c.del(c.w(`/debts/${gone.id}`));

    const p = await plan();
    expect(p.budgetMonths).toEqual([
      { month: '2026-11', plannedCents: 250000, spentCents: 75000, inProgress: true },
      { month: '2026-10', plannedCents: 200000, spentCents: 165000, inProgress: false },
      { month: '2026-09', plannedCents: 200000, spentCents: 0, inProgress: false },
    ]);
    expect(p.totals.budgetCents).toBe(250000);

    await c.del(c.w('/debt-budgets/2026-11'));
    expect((await plan()).totals.budgetCents).toBe(200000);
    expect((await c.del(c.w('/debt-budgets/2026-11'))).statusCode).toBe(404);
    await c.del(c.w(`/debts/${a.id}`));
    await c.del(c.w(`/debts/${q.id}`));
    await c.del(c.w('/debt-budgets/2026-09'));
  });
});

describe('estratégia e plano', () => {
  it('minha ordem começa pela avalanche; lista incompleta é recusada; comparação e avisos', async () => {
    const cheap = await create({ ...price, name: 'Barato', monthlyRatePpm: 10000 });
    const dear = await create({ ...price, name: 'Caro', category: 'overdraft', structure: 'revolving', monthlyRatePpm: 140000, installmentCents: null, remainingInstallments: null, dueDay: null, minPaymentKind: 'percent', minPaymentValue: 100000, anchorBalanceCents: 200000 });
    const p0 = await plan();
    expect(p0.strategy).toBe('avalanche');
    expect(p0.order).toEqual([dear.id, cheap.id]);
    expect(p0.comparison.map((s: Row) => s.strategy)).toEqual(['avalanche', 'snowball', 'manual', 'minimum']);
    expect(p0.warnings.map((w: Row) => w.code)).toEqual(expect.arrayContaining(['no_budget', 'not_decreasing']));
    expect(p0.perDebt.find((x: Row) => x.id === cheap.id).timeline.length).toBeGreaterThan(1);

    await c.put(c.w('/debt-settings'), { strategy: 'snowball' });
    expect((await plan()).order).toEqual([dear.id, cheap.id]); // saldo menor primeiro

    const manual = (await c.put(c.w('/debt-settings'), { strategy: 'manual' })).json();
    expect(manual).toEqual({ strategy: 'manual', manualOrderSet: true });
    expect((await plan()).order).toEqual([dear.id, cheap.id]);

    const bad = await c.put(c.w('/debts/order'), { ids: [cheap.id] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    expect((await c.put(c.w('/debts/order'), { ids: [cheap.id, dear.id] })).statusCode).toBe(200);
    expect((await plan()).order).toEqual([cheap.id, dear.id]);

    // dívida nova entra no fim da ordem manual
    const late = await create({ ...price, name: 'Nova', monthlyRatePpm: 200000 });
    expect((await plan()).order).toEqual([cheap.id, dear.id, late.id]);

    // orçamento insuficiente
    await c.put(c.w('/debt-budgets/2026-11'), { amountCents: 10000 });
    expect((await plan()).warnings.map((w: Row) => w.code)).toContain('budget_short');

    expect((await c.get(c.w('/debt-settings'))).json()).toEqual({ strategy: 'manual', manualOrderSet: true });
  });
});
