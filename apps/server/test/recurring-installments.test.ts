import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/** Cadastro de recorrente (mês de início + dia) e de parcelada com data única (ADR-0004). Hoje: 03/11/2026. */
let env: TestEnv;
let c: Client;
let nu: string;

const occ = async (month: string, type = 'expense') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Array<{ description: string; competenceMonth?: string }>, d: string, month?: string) =>
  rows.find((r) => r.description === d && (!month || r.competenceMonth === month)) as Record<string, any>;
const post = (body: Record<string, unknown>) => c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
const create = async (body: Record<string, unknown>) => {
  const res = await post(body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const detail = async (id: string) => (await c.get(c.w(`/items/${id}`))).json();

/** Corpo da edição como a tela envia, com as mudanças por cima. */
const edit = async (row: Record<string, any>, changes: Record<string, unknown>) => {
  const item = await detail(row.itemId);
  const dates =
    item.form === 'recurring'
      ? { startMonth: item.startMonth, day: item.method === 'credit' ? Number(item.entryDate.slice(8, 10)) : item.dueDay }
      : item.form === 'installment' && item.method !== 'credit'
        ? { dueDate: row.dueDate }
        : { date: item.entryDate, dueDate: row.invoice ? null : row.dueDate };
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
    note: row.note,
    version: row.version,
    ...dates,
    ...changes,
  });
};

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  nu = (await c.post(c.w('/accounts'), { name: 'Nubank', bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 1 })).json().id;
});
afterAll(async () => env.close());

describe('recorrente: mês de início + dia', () => {
  it('despesa fora do crédito sem dia: meses sem data p/ pagamento', async () => {
    const item = await create({ description: 'Mesada', form: 'recurring', amountCents: 5000, startMonth: '2026-11' });
    expect([item.startMonth, item.dueDay]).toEqual(['2026-11', null]);
    expect(find(await occ('2026-11'), 'Mesada').dueDate).toBeNull();
    expect(find(await occ('2026-12'), 'Mesada').dueDate).toBeNull();
  });

  it('dia 31 vira o último dia nos meses curtos', async () => {
    await create({ description: 'Aluguel', form: 'recurring', amountCents: 200000, startMonth: '2027-01', day: 31, method: 'boleto' });
    expect(find(await occ('2026-12'), 'Aluguel')).toBeUndefined();
    expect(find(await occ('2027-01'), 'Aluguel').dueDate).toBe('2027-01-31');
    expect(find(await occ('2027-02'), 'Aluguel').dueDate).toBe('2027-02-28');
    expect(find(await occ('2027-03'), 'Aluguel').dueDate).toBe('2027-03-31');
  });

  it('entrada e crédito exigem o dia; o contrato antigo é recusado', async () => {
    const income = await post({ type: 'income', form: 'recurring', method: 'transfer', description: 'Salário', amountCents: 500000, startMonth: '2026-11' });
    expect(income.statusCode).toBe(400);
    expect(income.json().error.fields.day).toBe('Informe o dia do recebimento.');
    const card = await post({ form: 'recurring', method: 'credit', accountId: nu, description: 'Spotify', amountCents: 2190, startMonth: '2026-11' });
    expect(card.json().error.fields.day).toBe('Informe o dia da cobrança.');
    const old = await post({ form: 'recurring', description: 'Velho', amountCents: 100, date: '2026-11-03' });
    expect(old.json().error.fields.startMonth).toBe('Informe o mês de início.');
  });

  it('entrada: o dia do recebimento vale para todos os meses', async () => {
    await create({ type: 'income', form: 'recurring', method: 'transfer', description: 'Salário', amountCents: 500000, startMonth: '2026-11', day: 5 });
    expect(find(await occ('2026-11', 'income'), 'Salário').dueDate).toBe('2026-11-05');
    expect(find(await occ('2026-12', 'income'), 'Salário').dueDate).toBe('2026-12-05');
  });

  it('mudar o dia vale do mês aberto em diante e preserva o mês pago', async () => {
    await create({ description: 'Internet', form: 'recurring', amountCents: 12000, startMonth: '2026-10', day: 10, method: 'boleto' });
    const oct = find(await occ('2026-10'), 'Internet');
    await c.post(c.w(`/occurrences/${oct.id}/payments`), { paidAt: '2026-10-10', amountCents: 12000 });
    const res = await edit(find(await occ('2026-11'), 'Internet', '2026-11'), { day: 15 });
    expect(res.statusCode).toBe(200);
    const after = find(await occ('2026-10'), 'Internet');
    expect([after.id, after.dueDate, after.displayStatus]).toEqual([oct.id, '2026-10-10', 'paid']);
    expect(find(await occ('2026-11'), 'Internet', '2026-11').dueDate).toBe('2026-11-15');
    expect(find(await occ('2026-12'), 'Internet').dueDate).toBe('2026-12-15');
    // Sem dia: os meses dali em diante ficam sem data.
    await edit(find(await occ('2026-11'), 'Internet', '2026-11'), { day: null });
    expect(find(await occ('2026-11'), 'Internet', '2026-11').dueDate).toBeNull();
    expect(find(await occ('2026-12'), 'Internet').dueDate).toBeNull();
  });

  it('mudar o mês de início recria os meses; o mês pago fica, e não pode ficar antes do início', async () => {
    const item = await create({ description: 'Seguro', form: 'recurring', amountCents: 8000, startMonth: '2026-11', day: 5, method: 'boleto' });
    const res = await edit(find(await occ('2026-11'), 'Seguro'), { startMonth: '2026-09' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(item.id);
    expect(find(await occ('2026-09'), 'Seguro').dueDate).toBe('2026-09-05');
    const sep = find(await occ('2026-09'), 'Seguro');
    await c.post(c.w(`/occurrences/${sep.id}/payments`), { paidAt: '2026-09-05', amountCents: 8000 });
    const refused = await edit(find(await occ('2026-11'), 'Seguro', '2026-11'), { startMonth: '2026-10' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'payments_not_movable',
      message: 'O mês pago de set/2026 ficaria antes do novo mês de início. Comece até set/2026 ou desfaça o pagamento.',
    });
    // Antecipar de novo: setembro continua pago (mesma ocorrência), agosto nasce pendente.
    const ok = await edit(find(await occ('2026-11'), 'Seguro', '2026-11'), { startMonth: '2026-08' });
    expect(ok.statusCode).toBe(200);
    expect([find(await occ('2026-09'), 'Seguro').id, find(await occ('2026-09'), 'Seguro').displayStatus]).toEqual([sep.id, 'paid']);
    expect(find(await occ('2026-08'), 'Seguro').displayStatus).not.toBe('paid');
  });

  it('salvar sem mexer num item do modelo antigo não recria os meses', async () => {
    // Antes, a recorrente guardava a "Data" do cadastro (03/09) separada do dia do vencimento (20).
    const item = await create({ description: 'Condomínio', form: 'recurring', amountCents: 70000, startMonth: '2026-09', day: 20, method: 'boleto' });
    await env.ctx.db.execute(sql`update items set entry_date = '2026-09-03' where id = ${item.id}`);
    const sep = find(await occ('2026-09'), 'Condomínio');
    await c.post(c.w(`/occurrences/${sep.id}/payments`), { paidAt: '2026-09-20', amountCents: 70000 });
    const nov = find(await occ('2026-11'), 'Condomínio', '2026-11');
    const res = await edit(nov, { note: 'reajuste em janeiro' });
    expect(res.statusCode).toBe(200);
    expect(find(await occ('2026-11'), 'Condomínio', '2026-11').id).toBe(nov.id);
  });

  it('no crédito, mudar o dia da cobrança recria os meses', async () => {
    const item = await create({ description: 'Netflix', form: 'recurring', method: 'credit', accountId: nu, amountCents: 5590, startMonth: '2026-10', day: 15 });
    const before = (await detail(item.id)).occurrences.map((o: any) => o.id);
    const row = find(await occ('2026-11'), 'Netflix');
    const res = await edit(row, { day: 28 });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.entryDate).toBe('2026-10-28');
    expect(after.occurrences.map((o: any) => o.id)).not.toEqual(before);
  });

  it('meses excluídos com "Só este mês" continuam excluídos depois de recriar', async () => {
    await create({ description: 'Faxina', form: 'recurring', amountCents: 15000, startMonth: '2026-10', day: 5, method: 'pix' });
    const nov = find(await occ('2026-11'), 'Faxina', '2026-11');
    expect((await c.post(c.w(`/occurrences/${nov.id}/cancel`))).statusCode).toBe(200);
    const jan = find(await occ('2027-01'), 'Faxina');
    expect((await c.post(c.w(`/occurrences/${jan.id}/cancel`))).statusCode).toBe(200);
    const res = await edit(find(await occ('2026-12'), 'Faxina'), { startMonth: '2026-09' });
    expect(res.statusCode).toBe(200);
    expect(find(await occ('2026-11'), 'Faxina', '2026-11').displayStatus).toBe('canceled');
    expect(find(await occ('2027-01'), 'Faxina').displayStatus).toBe('canceled');
    expect(find(await occ('2026-09'), 'Faxina').displayStatus).toBe('late');
  });
});

describe('parcelada fora do crédito: uma data só', () => {
  it('31/01 em 3 vezes: mesmo dia, último dia nos meses curtos; a data é a entry_date', async () => {
    const item = await create({ description: 'Geladeira', form: 'installment', amountCents: 30000, installments: 3, date: '2027-01-31', method: 'boleto' });
    expect(item.entryDate).toBe('2027-01-31');
    expect(item.occurrences.map((o: any) => [o.installmentLabel, o.competenceMonth, o.dueDate, o.expectedCents])).toEqual([
      ['1/3', '2027-01', '2027-01-31', 10000],
      ['2/3', '2027-02', '2027-02-28', 10000],
      ['3/3', '2027-03', '2027-03-31', 10000],
    ]);
  });

  it('entrada parcelada: a data é a do recebimento da 1ª parcela', async () => {
    const item = await create({ type: 'income', form: 'installment', method: 'transfer', description: 'Venda do carro', amountCents: 2000000, installments: 2, date: '2026-11-05' });
    expect(item.occurrences.map((o: any) => [o.competenceMonth, o.dueDate])).toEqual([
      ['2026-11', '2026-11-05'],
      ['2026-12', '2026-12-05'],
    ]);
  });

  it('mudar a data da 3ª parcela recria a partir da 1ª', async () => {
    const item = await create({ description: 'Notebook', form: 'installment', amountCents: 500000, installments: 5, date: '2026-11-10', method: 'boleto' });
    const third = find(await occ('2027-01'), 'Notebook');
    expect(third.dueDate).toBe('2027-01-10');
    const res = await edit(third, { dueDate: '2027-01-20' });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.id).toBe(item.id);
    expect(after.entryDate).toBe('2026-11-20');
    expect(after.occurrences.map((o: any) => o.dueDate)).toEqual(['2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20', '2027-03-20']);
  });

  it('parcelada antiga sem data: editar só a descrição não recria nem perde pagamento', async () => {
    const item = await create({ description: 'Bicicleta', form: 'installment', amountCents: 60000, installments: 3, date: '2026-11-03', method: 'boleto' });
    await env.ctx.db.execute(sql`update occurrences set due_date = null where item_id = ${item.id}`);
    const first = find(await occ('2026-11'), 'Bicicleta');
    await c.post(c.w(`/occurrences/${first.id}/payments`), { paidAt: '2026-11-03', amountCents: 20000 });
    const res = await edit(find(await occ('2026-11'), 'Bicicleta'), { description: 'Bicicleta aro 29' });
    expect(res.statusCode).toBe(200);
    const after = find(await occ('2026-11'), 'Bicicleta aro 29');
    expect([after.id, after.displayStatus, after.dueDate]).toEqual([first.id, 'paid', null]);
  });
});
