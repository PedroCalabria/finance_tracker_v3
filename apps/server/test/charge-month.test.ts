import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/**
 * Mês do gasto (ADR-0004, ADR-0005): no crédito, a tabela e os cards usam o mês da
 * compra; a fatura continua pelo vencimento. Hoje: 03/11/2026.
 */
let env: TestEnv;
let c: Client;
/** Fecha dia 25, vence dia 1: quase toda compra cai na fatura do mês seguinte (ou do outro). */
let nu: string;

type Row = Record<string, any>;
const occ = async (month: string, cl: Client = c, type = 'expense'): Promise<Row[]> => (await cl.get(cl.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Row[], d: string) => rows.find((r) => r.description === d)!;
const create = async (body: Record<string, unknown>, cl: Client = c) => {
  const res = await cl.post(cl.w('/items'), { type: 'expense', form: 'single', method: 'credit', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const invoice = async (month: string, card: string, cl: Client = c) =>
  ((await cl.get(cl.w(`/invoices?month=${month}`))).json() as Row[]).find((i) => i.account.id === card && i.referenceMonth === month)!;
const summary = async (month: string, cl: Client) => (await cl.get(cl.w(`/summary?month=${month}`))).json();
const card = async (cl: Client, name = 'Nubank') => (await cl.post(cl.w('/accounts'), { name, bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 1 })).json().id as string;

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  nu = await card(c);
});
afterAll(async () => env.close());

describe('mês do gasto na tabela', () => {
  it('compra no cartão aparece no mês em que foi feita, com a fatura do mês seguinte', async () => {
    await create({ accountId: nu, description: 'Tênis', amountCents: 30000, date: '2026-11-10' });
    const row = find(await occ('2026-11'), 'Tênis');
    expect([row.chargeMonth, row.competenceMonth, row.invoice.referenceMonth, row.dueDate, row.displayStatus]).toEqual([
      '2026-11',
      '2026-12',
      '2026-12',
      '2026-12-01',
      'invoice_open',
    ]);
    expect(find(await occ('2026-12'), 'Tênis')).toBeUndefined();
  });

  it('compra depois do fechamento: mesmo mês do gasto, fatura dois meses depois', async () => {
    await create({ accountId: nu, description: 'Jaqueta', amountCents: 20000, date: '2026-11-27' });
    const row = find(await occ('2026-11'), 'Jaqueta');
    expect([row.chargeMonth, row.invoice.referenceMonth]).toEqual(['2026-11', '2027-01']);
  });

  it('parcelada: cada parcela no seu mês do gasto, nas faturas seguintes', async () => {
    const item = await create({ form: 'installment', accountId: nu, description: 'Notebook', amountCents: 300000, installments: 3, date: '2026-11-10' });
    expect(item.occurrences.map((o: Row) => [o.installmentLabel, o.chargeMonth, o.invoice.referenceMonth])).toEqual([
      ['1/3', '2026-11', '2026-12'],
      ['2/3', '2026-12', '2027-01'],
      ['3/3', '2027-01', '2027-02'],
    ]);
    expect(find(await occ('2027-01'), 'Notebook').installmentLabel).toBe('3/3');
  });

  it('fora do crédito, o mês do gasto é o próprio mês e acompanha a data p/ pagamento', async () => {
    const item = await create({ method: 'boleto', description: 'Luz', amountCents: 15000, date: '2026-11-03', dueDate: '2026-11-20' });
    expect(item.occurrences[0]).toMatchObject({ competenceMonth: '2026-11', chargeMonth: '2026-11' });
    const row = find(await occ('2026-11'), 'Luz');
    const item2 = await c.get(c.w(`/items/${item.id}`));
    const detail = item2.json();
    const res = await c.put(c.w(`/items/${item.id}`), {
      occurrenceId: row.id,
      type: 'expense',
      form: 'single',
      description: 'Luz',
      method: 'boleto',
      amountCents: 15000,
      date: detail.entryDate,
      dueDate: '2026-12-05',
      version: row.version,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences[0]).toMatchObject({ competenceMonth: '2026-12', chargeMonth: '2026-12' });
  });

  it('a navegação começa no mês da compra mais antiga', async () => {
    const d = await signedIn(env, 'nav@example.com', 'Nav');
    const k = await card(d);
    // 30/08 é depois do fechamento de 25/08: cai na fatura de out (fecha 25/09).
    await create({ accountId: k, description: 'Antiga', amountCents: 1000, date: '2026-08-30' }, d);
    expect(((await d.get(d.w('/months'))).json() as Row).firstMonth).toBe('2026-08');
  });
});

describe('recorrente no crédito pelo mês da cobrança', () => {
  it('a cobrança do mês é gravada; a do mês seguinte é prevista no mês dela', async () => {
    const item = await create({ form: 'recurring', accountId: nu, description: 'Música', amountCents: 2190, startMonth: '2026-11', day: 28 });
    const nov = find(await occ('2026-11'), 'Música');
    expect([nov.projected, nov.chargeMonth, nov.invoice.referenceMonth]).toEqual([false, '2026-11', '2027-01']);
    const dec = find(await occ('2026-12'), 'Música');
    expect([dec.projected, dec.chargeMonth, dec.competenceMonth]).toEqual([true, '2026-12', '2027-02']);
    expect(find(await occ('2027-01'), 'Música').chargeMonth).toBe('2027-01');
    // O detalhe mostra a cobrança de novembro e a próxima prevista.
    const detail = (await c.get(c.w(`/items/${item.id}`))).json();
    expect(detail.occurrences.map((o: Row) => [o.chargeMonth, o.projected])).toEqual([
      ['2026-11', false],
      ['2026-12', true],
    ]);
  });

  it('"Só este mês" na cobrança de novembro sai do total da fatura de janeiro', async () => {
    const before = await invoice('2027-01', nu);
    const nov = find(await occ('2026-11'), 'Música');
    expect((await c.post(c.w(`/occurrences/${nov.id}/cancel`))).statusCode).toBe(200);
    expect(before.itemsCents - (await invoice('2027-01', nu)).itemsCents).toBe(2190);
    expect(find(await occ('2026-12'), 'Música').projected).toBe(true);
  });
});

describe('bloco de faturas', () => {
  it('cada fatura mostra o período das compras', async () => {
    const dec = await invoice('2026-12', nu);
    expect([dec.closingDate, dec.purchasesFrom, dec.purchasesTo]).toEqual(['2026-11-25', '2026-10-25', '2026-11-24']);
  });
});

describe('resumo: consumo no previsto, caixa no realizado', () => {
  it('compras no cartão contam no mês da compra; o pagamento da fatura conta só no caixa', async () => {
    const d = await signedIn(env, 'consumo@example.com', 'Consumo');
    const k = await card(d);
    await create({ method: 'pix', description: 'Mercado', amountCents: 100000, date: '2026-11-02', alreadyPaid: true }, d);
    await create({ method: 'boleto', description: 'Condomínio', amountCents: 50000, date: '2026-11-02', dueDate: '2026-11-20' }, d);
    await create({ accountId: k, description: 'Presente', amountCents: 30000, date: '2026-11-10' }, d);
    await create({ accountId: k, description: 'Jantar de outubro', amountCents: 40000, date: '2026-10-10' }, d);
    await create({ type: 'income', method: 'transfer', description: 'Salário', amountCents: 300000, date: '2026-11-01', dueDate: '2026-11-01', alreadyPaid: true }, d);
    await create({ type: 'income', method: 'transfer', description: 'Freela', amountCents: 200000, date: '2026-11-25', dueDate: '2026-11-25' }, d);

    // A fatura de nov (compras de out) está atrasada: aparece no bloco, não no "em atraso" dos gastos.
    expect((await summary('2026-11', d)).expense.lateCents).toBe(0);
    const nov = await invoice('2026-11', k, d);
    expect(nov.late).toBe(true);
    expect((await d.post(d.w(`/invoices/${nov.id}/payments`), { realAmountCents: 40000, amountCents: 40000, paidAt: '2026-11-02' })).statusCode).toBe(201);

    const s = await summary('2026-11', d);
    expect(s.expense).toEqual({ paidCents: 100000, pendingCents: 80000, lateCents: 0, forecastCents: 180000 });
    expect(s.income).toMatchObject({ receivedCents: 300000, pendingCents: 200000, forecastCents: 500000 });
    expect(s.balance).toEqual({ forecastCents: 320000, realizedCents: 160000 });
    // Outubro: a compra conta inteira, já paga (a fatura dela foi paga).
    expect((await summary('2026-10', d)).expense).toEqual({ paidCents: 40000, pendingCents: 0, lateCents: 0, forecastCents: 40000 });
  });

  it('saldo transferido não conta de novo; o ajuste da fatura conta no mês dela', async () => {
    const d = await signedIn(env, 'saldo@example.com', 'Saldo');
    const k = await card(d);
    await create({ accountId: k, description: 'TV', amountCents: 100000, date: '2026-10-05' }, d);
    const nov = await invoice('2026-11', k, d);
    // O banco cobrou R$ 1.100,00 (R$ 100,00 de juros) e a pessoa pagou R$ 500,00: R$ 600,00 vão para a fatura de dez.
    const paid = (await d.post(d.w(`/invoices/${nov.id}/payments`), { realAmountCents: 110000, amountCents: 50000, paidAt: '2026-11-02' })).json();
    expect([paid.status, paid.carriedToMonth]).toEqual(['carried', '2026-12']);
    expect((await summary('2026-10', d)).expense).toMatchObject({ paidCents: 100000, forecastCents: 100000 });
    expect((await summary('2026-11', d)).expense).toMatchObject({ paidCents: 10000, pendingCents: 0, forecastCents: 10000 });
    const dec = await summary('2026-12', d);
    expect(dec.expense.forecastCents).toBe(0);
    // A linha do saldo continua na tabela de dez (é da fatura de dez), só não conta como gasto.
    expect(find(await occ('2026-12', d), 'Saldo restante da fatura nov/2026 · Nubank').expectedCents).toBe(60000);
  });
});
