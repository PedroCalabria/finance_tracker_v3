import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/** Edição completa de um lançamento (ADR-0004). Hoje nos testes: 03/11/2026. */
let env: TestEnv;
let c: Client;
let bb: string;
let nu: string;
let conta: string;

const occ = async (month: string, type = 'expense') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Array<{ description: string; competenceMonth?: string }>, d: string, month?: string) =>
  rows.find((r) => r.description === d && (!month || r.competenceMonth === month)) as Record<string, any>;
const create = async (body: Record<string, unknown>) => {
  const res = await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
/** Datas como a tela envia: recorrente = mês de início + dia; parcelada fora do crédito = data desta parcela. */
const datesOf = (item: Record<string, any>, row: Record<string, any>) => {
  if (item.form === 'recurring') return { startMonth: item.startMonth, day: item.method === 'credit' ? Number(item.entryDate.slice(8, 10)) : item.dueDay };
  if (item.form === 'installment' && item.method !== 'credit') return { dueDate: row.dueDate };
  return { date: item.entryDate, dueDate: row.invoice ? null : row.dueDate };
};

/** Monta o corpo da edição a partir da linha, como a tela faz, com as mudanças por cima. */
const edit = async (row: Record<string, any>, changes: Record<string, unknown>) => {
  const item = (await c.get(c.w(`/items/${row.itemId}`))).json();
  return c.put(c.w(`/items/${row.itemId}`), {
    occurrenceId: row.id,
    type: item.type,
    form: item.form,
    description: item.description,
    categoryId: item.categoryId,
    method: item.method,
    accountId: item.accountId,
    amountCents: item.form === 'installment' ? item.totalCents : row.expectedCents,
    installments: item.installments,
    occurrenceCents: item.form === 'installment' ? row.expectedCents : undefined,
    variableAmount: item.variableAmount,
    ...datesOf(item, row),
    note: row.note,
    version: row.version,
    ...changes,
  });
};

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  bb = (await c.post(c.w('/accounts'), { name: 'BB Crédito', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 1, dueDay: 8 })).json().id;
  nu = (await c.post(c.w('/accounts'), { name: 'Nubank', bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 1 })).json().id;
  conta = (await c.post(c.w('/accounts'), { name: 'Conta BB', bank: 'Banco do Brasil', kind: 'account' })).json().id;
});
afterAll(async () => env.close());

describe('edição simples', () => {
  it('muda descrição, método, conta e valor sem perder o pagamento', async () => {
    await create({ description: 'Mercado', amountCents: 5000, date: '2026-11-02', alreadyPaid: true });
    const row = find(await occ('2026-11'), 'Mercado');
    const res = await edit(row, { description: 'Supermercado', method: 'debit', accountId: conta, amountCents: 5500, note: 'faltou o pão' });
    expect(res.statusCode).toBe(200);
    const after = find(await occ('2026-11'), 'Supermercado');
    expect(after.id).toBe(row.id);
    expect([after.method, after.account.id, after.expectedCents, after.payments.length, after.displayStatus, after.note]).toEqual([
      'debit',
      conta,
      5500,
      1,
      'partial',
      'faltou o pão',
    ]);
  });
  it('mudar a data de uma compra única muda o mês', async () => {
    await create({ description: 'Revisão', amountCents: 30000, date: '2026-11-10' });
    const res = await edit(find(await occ('2026-11'), 'Revisão'), { date: '2026-12-05' });
    expect(res.statusCode).toBe(200);
    expect(find(await occ('2026-11'), 'Revisão')).toBeUndefined();
    expect(find(await occ('2026-12'), 'Revisão')).toBeDefined();
  });
  it('recorrente: valor e dia de pagamento valem daqui em diante', async () => {
    await create({ description: 'Academia', form: 'recurring', amountCents: 10000, startMonth: '2026-09', day: 10, method: 'boleto' });
    const res = await edit(find(await occ('2026-11'), 'Academia', '2026-11'), { amountCents: 12000, day: 15 });
    expect(res.statusCode).toBe(200);
    const nov = find(await occ('2026-11'), 'Academia', '2026-11');
    expect([nov.expectedCents, nov.dueDate]).toEqual([12000, '2026-11-15']);
    const dec = find(await occ('2026-12'), 'Academia');
    expect([dec.expectedCents, dec.dueDate]).toEqual([12000, '2026-12-15']);
    const sep = find(await occ('2026-09'), 'Academia');
    expect([sep.expectedCents, sep.dueDate]).toEqual([10000, '2026-09-10']);
  });
});

describe('edição que recria os meses', () => {
  it('compra única no pix vira parcelada no crédito, com o mesmo item', async () => {
    const item = await create({ description: 'TV', amountCents: 300000, date: '2026-11-03' });
    const res = await edit(find(await occ('2026-11'), 'TV'), { form: 'installment', installments: 3, method: 'credit', accountId: nu });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.id).toBe(item.id);
    expect(after.occurrences.map((o: any) => [o.installmentLabel, o.expectedCents, o.invoice?.referenceMonth])).toEqual([
      ['1/3', 100000, '2026-12'],
      ['2/3', 100000, '2027-01'],
      ['3/3', 100000, '2027-02'],
    ]);
  });
  it('trocar o cartão leva a compra para a fatura do outro cartão', async () => {
    await create({ description: 'Fone', amountCents: 25000, date: '2026-11-03', method: 'credit', accountId: bb });
    // Compra de nov: fica na tabela de nov, com a fatura de dez.
    const row = find(await occ('2026-11'), 'Fone');
    expect([row.account.id, row.invoice.referenceMonth]).toEqual([bb, '2026-12']);
    const res = await edit(row, { accountId: nu });
    expect(res.statusCode).toBe(200);
    const moved = find(await occ('2026-11'), 'Fone');
    expect([moved.account.id, moved.invoice.referenceMonth]).toEqual([nu, '2026-12']);
  });
  it('mais parcelas a partir da 2ª: a data dela define a primeira', async () => {
    await create({ description: 'Sofá', form: 'installment', amountCents: 90000, installments: 3, date: '2026-11-05', method: 'boleto' });
    const second = find(await occ('2026-12'), 'Sofá');
    const res = await edit(second, { installments: 4, dueDate: '2026-12-07', note: 'renegociado' });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences.map((o: any) => [o.installmentLabel, o.expectedCents, o.dueDate, o.note])).toEqual([
      ['1/4', 22500, '2026-11-07', null],
      ['2/4', 22500, '2026-12-07', 'renegociado'],
      ['3/4', 22500, '2027-01-07', null],
      ['4/4', 22500, '2027-02-07', null],
    ]);
  });
  it('com pagamento registrado, a única paga vira a parcela do mesmo mês e guarda o pagamento', async () => {
    await create({ description: 'Pizza', amountCents: 8000, date: '2026-11-02', alreadyPaid: true });
    const before = find(await occ('2026-11'), 'Pizza');
    const res = await edit(before, { form: 'installment', installments: 2, amountCents: 16000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences.map((o: any) => [o.id === before.id, o.installmentLabel, o.expectedCents, o.paidCents, o.displayStatus])).toEqual([
      [true, '1/2', 8000, 8000, 'paid'],
      [false, '2/2', 8000, 0, 'pending'],
    ]);
  });
  it('com pagamento registrado, trocar despesa por entrada é recusado e explica', async () => {
    await create({ description: 'Pastel', amountCents: 1500, date: '2026-11-02', alreadyPaid: true });
    const res = await edit(find(await occ('2026-11'), 'Pastel'), { type: 'income', method: 'transfer', dueDate: '2026-11-02' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'payments_not_movable', message: expect.stringMatching(/despesa e entrada/) });
    expect(find(await occ('2026-11'), 'Pastel').displayStatus).toBe('paid');
  });
  it('despesa vira entrada', async () => {
    await create({ description: 'Reembolso', amountCents: 4000, date: '2026-11-03' });
    const res = await edit(find(await occ('2026-11'), 'Reembolso'), { type: 'income', method: 'transfer', dueDate: '2026-11-03' });
    expect(res.statusCode).toBe(200);
    expect(find(await occ('2026-11'), 'Reembolso')).toBeUndefined();
    expect(find(await occ('2026-11', 'income'), 'Reembolso').dueDate).toBe('2026-11-03');
  });
});
