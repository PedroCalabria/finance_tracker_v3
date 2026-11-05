import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/** Excluir recorrente: só este mês, este e os próximos, toda a recorrência (ADR-0004). Hoje: 03/11/2026. */
let env: TestEnv;
let c: Client;
let bb: string;
let nu: string;

const occ = async (month: string, type = 'expense') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const rowsOf = (rows: Array<{ description: string }>, d: string) => rows.filter((r) => r.description === d) as Array<Record<string, any>>;
const find = (rows: Array<{ description: string; competenceMonth?: string }>, d: string, month?: string) =>
  rows.find((r) => r.description === d && (!month || r.competenceMonth === month)) as Record<string, any>;
const summary = async (month: string) => (await c.get(c.w(`/summary?month=${month}`))).json();
const invoice = async (month: string, account: string) => (await c.get(c.w(`/invoices?month=${month}`))).json().find((i: any) => i.account.id === account);
const create = async (body: Record<string, unknown>) => {
  const res = await c.post(c.w('/items'), { type: 'expense', form: 'recurring', method: 'boleto', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const cancel = (id: string) => c.post(c.w(`/occurrences/${id}/cancel`));
const endFrom = (itemId: string, occurrenceId: string) => c.post(c.w(`/items/${itemId}/end`), { occurrenceId });

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  bb = (await c.post(c.w('/accounts'), { name: 'BB Crédito', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 1, dueDay: 8 })).json().id;
  nu = (await c.post(c.w('/accounts'), { name: 'Nubank', bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 1 })).json().id;
});
afterAll(async () => env.close());

describe('só este mês', () => {
  it('mês atrasado sem pagamento: fica Cancelado, sai dos atrasados e dos cards, e não volta', async () => {
    await create({ description: 'Internet', amountCents: 12000, startMonth: '2026-10', day: 20 });
    const before = await summary('2026-11');
    const oct = rowsOf(await occ('2026-11'), 'Internet').find((r) => r.competenceMonth === '2026-10')!;
    expect(oct.displayStatus).toBe('late');
    const res = await cancel(oct.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().displayStatus).toBe('canceled');
    // Não aparece mais como atrasado no mês atual.
    expect(rowsOf(await occ('2026-11'), 'Internet').map((r) => r.competenceMonth)).toEqual(['2026-11']);
    const after = await summary('2026-11');
    expect(before.expense.lateCents - after.expense.lateCents).toBe(12000);
    expect(before.expense.pendingCents - after.expense.pendingCents).toBe(12000);
    // Nova leitura (ensureMaterialized) não recria outubro.
    const octRows = rowsOf(await occ('2026-10'), 'Internet');
    expect(octRows.map((r) => [r.id, r.displayStatus])).toEqual([[oct.id, 'canceled']]);
    // Idempotente.
    expect((await cancel(oct.id)).statusCode).toBe(200);
  });

  it('mês previsto: é gravado já cancelado e não volta como projeção', async () => {
    await create({ description: 'Academia', amountCents: 9900, startMonth: '2026-11', day: 10 });
    const feb = find(await occ('2027-02'), 'Academia');
    expect(feb.projected).toBe(true);
    const res = await cancel(feb.id);
    expect(res.statusCode).toBe(200);
    expect([res.json().projected, res.json().displayStatus]).toEqual([false, 'canceled']);
    const rows = rowsOf(await occ('2027-02'), 'Academia');
    expect(rows.map((r) => [r.projected, r.displayStatus])).toEqual([[false, 'canceled']]);
    expect((await summary('2027-02')).expense.pendingCents).toBe((await summary('2027-03')).expense.pendingCents - 9900);
  });

  it('mês com pagamento: recusa e explica', async () => {
    await create({ description: 'Luz', amountCents: 20000, startMonth: '2026-11', day: 15 });
    const nov = find(await occ('2026-11'), 'Luz');
    await c.post(c.w(`/occurrences/${nov.id}/payments`), { paidAt: '2026-11-03', amountCents: 5000, settlement: 'partial' });
    const res = await cancel(nov.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'month_has_payment', message: 'Este mês já tem pagamento. Desfaça o pagamento antes de excluir o mês.' });
    expect(find(await occ('2026-11'), 'Luz').displayStatus).toBe('partial');
  });

  it('no crédito com a fatura aberta: o total da fatura diminui', async () => {
    // Cobrança no dia 15: outubro cai na fatura de novembro do BB (fecha dia 1).
    await create({ description: 'Streaming', method: 'credit', accountId: bb, amountCents: 3990, startMonth: '2026-10', day: 15 });
    const before = await invoice('2026-11', bb);
    const row = find(await occ('2026-11'), 'Streaming');
    expect(row.invoice.referenceMonth).toBe('2026-11');
    expect((await cancel(row.id)).statusCode).toBe(200);
    expect(before.itemsCents - (await invoice('2026-11', bb)).itemsCents).toBe(3990);
  });

  it('no crédito numa fatura paga: recusa (mês gravado e mês previsto)', async () => {
    // BB fecha dia 1: a cobrança de 20/10 vai para a fatura de novembro (gravada); a de 20/11, para a de dezembro (prevista).
    await create({ description: 'Jornal', method: 'credit', accountId: bb, amountCents: 2500, startMonth: '2026-10', day: 20 });
    const nov = await invoice('2026-11', bb);
    expect((await c.post(c.w(`/invoices/${nov.id}/payments`), { realAmountCents: nov.totalCents, amountCents: nov.totalCents, paidAt: '2026-11-03' })).statusCode).toBe(201);
    const recorded = find(await occ('2026-11'), 'Jornal');
    expect(recorded.displayStatus).toBe('invoice_paid');
    const res = await cancel(recorded.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'month_in_paid_invoice',
      message: 'Este mês está numa fatura já paga. Desfaça o pagamento da fatura antes de excluir o mês.',
    });
    // Mês previsto numa fatura já paga: gravar a projeção não basta para escapar da regra.
    const dec = await invoice('2026-12', bb);
    expect((await c.post(c.w(`/invoices/${dec.id}/payments`), { realAmountCents: dec.totalCents, amountCents: dec.totalCents, paidAt: '2026-11-03' })).statusCode).toBe(201);
    const projected = find(await occ('2026-12'), 'Jornal');
    expect(projected.projected).toBe(true);
    expect((await cancel(projected.id)).json().error.code).toBe('month_in_paid_invoice');
    expect(find(await occ('2026-12'), 'Jornal').projected).toBe(true);
  });

  it('lançamento que não é recorrente: recusa', async () => {
    await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', description: 'Pizza', amountCents: 8000, date: '2026-11-02' });
    const res = await cancel(find(await occ('2026-11'), 'Pizza').id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_recurring');
  });
});

describe('este e os próximos', () => {
  it('a partir de um mês previsto: encerra no anterior e mantém o histórico', async () => {
    const item = await create({ description: 'Escola', amountCents: 100000, startMonth: '2026-08', day: 5 });
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      const r = find(await occ(m), 'Escola', m);
      await c.post(c.w(`/occurrences/${r.id}/payments`), { paidAt: `${m}-05`, amountCents: 100000 });
    }
    const dec = find(await occ('2026-12'), 'Escola');
    const res = await endFrom(item.id, dec.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().endMonth).toBe('2026-11');
    expect(res.json().occurrences.map((o: any) => [o.competenceMonth, o.displayStatus])).toEqual([
      ['2026-08', 'paid'],
      ['2026-09', 'paid'],
      ['2026-10', 'paid'],
      ['2026-11', 'pending'],
    ]);
    expect(find(await occ('2026-12'), 'Escola')).toBeUndefined();
    expect(find(await occ('2027-03'), 'Escola')).toBeUndefined();
  });

  it('com pagamento adiantado depois do mês escolhido: recusa', async () => {
    const item = await create({ description: 'Plano de saúde', amountCents: 50000, startMonth: '2026-11', day: 10 });
    const jan = find(await occ('2027-01'), 'Plano de saúde');
    await c.post(c.w(`/occurrences/${jan.id}/payments`), { paidAt: '2026-11-03', amountCents: 50000 });
    const res = await endFrom(item.id, find(await occ('2026-12'), 'Plano de saúde').id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'later_months_paid', message: 'Há pagamento neste mês ou depois. Desfaça esses pagamentos antes de encerrar.' });
    expect(find(await occ('2027-02'), 'Plano de saúde')).toBeDefined();
  });

  it('no crédito: encerra pela cobrança da fatura escolhida', async () => {
    // Nubank fecha dia 25: a cobrança de 15/12 vai para a fatura de janeiro.
    const item = await create({ description: 'Nuvem', method: 'credit', accountId: nu, amountCents: 1000, startMonth: '2026-10', day: 15 });
    const janRow = find(await occ('2027-01'), 'Nuvem');
    const res = await endFrom(item.id, janRow.id);
    expect(res.statusCode).toBe(200);
    // Encerrar a partir da fatura de janeiro tira a cobrança de 15/12: o último mês de cobrança é novembro.
    expect(res.json().endMonth).toBe('2026-11');
    expect(find(await occ('2026-12'), 'Nuvem')).toBeDefined();
    expect(find(await occ('2027-01'), 'Nuvem')).toBeUndefined();
  });

  it('no primeiro mês: equivale a excluir toda a recorrência', async () => {
    const item = await create({ description: 'Revista', amountCents: 2990, startMonth: '2026-11', day: 1 });
    const res = await endFrom(item.id, find(await occ('2026-11'), 'Revista').id);
    expect(res.statusCode).toBe(204);
    expect((await c.get(c.w(`/items/${item.id}`))).statusCode).toBe(404);
    expect(find(await occ('2026-12'), 'Revista')).toBeUndefined();
  });
});

describe('toda a recorrência', () => {
  it('com meses pagos: some de todos os meses e os pagamentos ficam no banco', async () => {
    const item = await create({ description: 'Celular', amountCents: 6000, startMonth: '2026-09', day: 12 });
    const sep = find(await occ('2026-09'), 'Celular');
    await c.post(c.w(`/occurrences/${sep.id}/payments`), { paidAt: '2026-09-12', amountCents: 6000 });
    expect((await c.del(c.w(`/items/${item.id}`))).statusCode).toBe(204);
    expect(find(await occ('2026-09'), 'Celular')).toBeUndefined();
    expect(find(await occ('2026-12'), 'Celular')).toBeUndefined();
    const kept = await env.ctx.db.execute(sql`select count(*)::int as n from payments where occurrence_id = ${sep.id}`);
    expect((kept.rows[0] as { n: number }).n).toBe(1);
  });

  it('no crédito com mês numa fatura paga: recusa e sugere "Este e os próximos"', async () => {
    const jornal = find(await occ('2026-11'), 'Jornal');
    const res = await c.del(c.w(`/items/${jornal.itemId}`));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Este e os próximos/);
  });
});
