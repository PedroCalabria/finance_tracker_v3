import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachments, importBatches, importLines, payments } from '../src/db/schema';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/** Edição estrutural com pagamentos: as ocorrências pagas ficam no lugar equivalente (ADR-0004). Hoje: 03/11/2026. */
let env: TestEnv;
let c: Client;
let conta: string;
let bb: string;

const occ = async (month: string, type = 'expense') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Array<{ description: string; competenceMonth?: string }>, d: string, month?: string) =>
  rows.find((r) => r.description === d && (!month || r.competenceMonth === month)) as Record<string, any>;
const create = async (body: Record<string, unknown>) => {
  const res = await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const detail = async (id: string) => (await c.get(c.w(`/items/${id}`))).json();
/** Paga e devolve a linha atualizada (o pagamento muda a versão). */
const pay = async (row: Record<string, any>, paidAt: string, amountCents = row.expectedCents) => {
  const res = await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt, amountCents });
  if (res.statusCode >= 300) throw new Error(res.body);
  return find(await occ(row.competenceMonth), row.description, row.competenceMonth);
};

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
    ...dates,
    note: row.note,
    version: row.version,
    ...changes,
  });
};
/** Vira recorrente fora do crédito, como a tela envia (sem data/dueDate). */
const toRecurring = (startMonth: string, day: number | null) => ({ form: 'recurring', startMonth, day, date: undefined, dueDate: undefined });

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  conta = (await c.post(c.w('/accounts'), { name: 'Conta Corrente', bank: 'Banco do Brasil', kind: 'account' })).json().id;
  bb = (await c.post(c.w('/accounts'), { name: 'BB Crédito', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 1, dueDay: 8 })).json().id;
});
afterAll(async () => env.close());

describe('única paga vira recorrente', () => {
  it('outubro continua pago, com o mesmo pagamento, comprovante e linha do extrato', async () => {
    await create({ description: 'ASSOC RELIGIOSAS', amountCents: 351800, date: '2026-10-01', dueDate: '2026-10-01', method: 'boleto', accountId: conta, note: 'escola' });
    const oct = await pay(find(await occ('2026-10'), 'ASSOC RELIGIOSAS'), '2026-10-01');
    // Como a importação deixa: linha do extrato ligada à ocorrência e ao pagamento; comprovante no grupo do pagamento.
    const db = env.ctx.db;
    const [payment] = await db.select().from(payments).where(eq(payments.occurrenceId, oct.id));
    const [batch] = await db
      .insert(importBatches)
      .values({ walletId: c.walletId, accountId: conta, readerId: 'bb-extrato', kind: 'statement', counts: { paid: 1 } })
      .returning();
    const [line] = await db
      .insert(importLines)
      .values({
        walletId: c.walletId,
        batchId: batch!.id,
        accountId: conta,
        fingerprint: 'f'.repeat(64),
        lineDate: '2026-10-01',
        amountCents: 351800,
        direction: 'debit',
        description: 'Pagamento de Boleto ASSOC RELIGIOSAS',
        action: 'paid',
        occurrenceId: oct.id,
        paymentId: payment!.id,
        itemId: oct.itemId,
      })
      .returning();
    const [att] = await db
      .insert(attachments)
      .values({ walletId: c.walletId, storageKey: 'k', name: 'boleto.pdf', mime: 'application/pdf', sizeBytes: 10, paymentGroupId: payment!.groupId })
      .returning();

    const res = await edit(oct, toRecurring('2026-10', 1));
    expect(res.statusCode).toBe(200);
    const item = res.json();
    expect([item.id, item.form, item.startMonth, item.dueDay]).toEqual([oct.itemId, 'recurring', '2026-10', 1]);

    const after = find(await occ('2026-10'), 'ASSOC RELIGIOSAS');
    expect([after.id, after.displayStatus, after.paidCents, after.dueDate, after.installmentLabel, after.note]).toEqual([
      oct.id,
      'paid',
      351800,
      '2026-10-01',
      'Recorrente',
      'escola',
    ]);
    const [stillPayment] = await db.select().from(payments).where(eq(payments.id, payment!.id));
    expect(stillPayment!.occurrenceId).toBe(oct.id);
    const [stillLine] = await db.select().from(importLines).where(eq(importLines.id, line!.id));
    expect([stillLine!.occurrenceId, stillLine!.paymentId]).toEqual([oct.id, payment!.id]);
    const [stillAtt] = await db.select().from(attachments).where(eq(attachments.id, att!.id));
    expect(stillAtt!.paymentGroupId).toBe(payment!.groupId);

    // Novembro em diante seguem a regra nova.
    const nov = find(await occ('2026-11'), 'ASSOC RELIGIOSAS');
    expect([nov.expectedCents, nov.dueDate, nov.displayStatus]).toEqual([351800, '2026-11-01', 'pending']);
  });

  it('início depois do mês pago: recusa e nada muda', async () => {
    await create({ description: 'Escola', amountCents: 50000, date: '2026-10-05', dueDate: '2026-10-05', method: 'boleto' });
    const oct = await pay(find(await occ('2026-10'), 'Escola'), '2026-10-05');
    const res = await edit(oct, toRecurring('2026-11', 5));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'payments_not_movable',
      message: 'O mês pago de out/2026 ficaria antes do novo mês de início. Comece até out/2026 ou desfaça o pagamento.',
    });
    const item = await detail(oct.itemId);
    expect(item.form).toBe('single');
    expect(find(await occ('2026-10'), 'Escola').displayStatus).toBe('paid');
  });

  it('o valor novo vale para a linha aberta: pago abaixo vira parcial', async () => {
    await create({ description: 'Luz', amountCents: 10000, date: '2026-10-10', dueDate: '2026-10-10', method: 'boleto' });
    const oct = await pay(find(await occ('2026-10'), 'Luz'), '2026-10-10');
    const res = await edit(oct, { ...toRecurring('2026-10', 10), amountCents: 12000 });
    expect(res.statusCode).toBe(200);
    const after = find(await occ('2026-10'), 'Luz');
    expect([after.id, after.expectedCents, after.paidCents, after.status]).toEqual([oct.id, 12000, 10000, 'partial']);
  });
});

describe('outras formas', () => {
  it('recorrente com um mês pago vira única: a ocorrência paga é a única', async () => {
    await create({ description: 'Curso', form: 'recurring', amountCents: 20000, startMonth: '2026-10', day: 15, method: 'boleto' });
    const oct = await pay(find(await occ('2026-10'), 'Curso'), '2026-10-15');
    const res = await edit(oct, { form: 'single', startMonth: undefined, day: undefined, date: '2026-10-15', dueDate: '2026-10-15' });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences.map((o: any) => [o.id, o.installmentLabel, o.displayStatus])).toEqual([[oct.id, 'Única', 'paid']]);
    expect(find(await occ('2026-11'), 'Curso')).toBeUndefined();
  });

  it('recorrente com dois meses pagos não vira única', async () => {
    await create({ description: 'Gás', form: 'recurring', amountCents: 9000, startMonth: '2026-10', day: 5, method: 'boleto' });
    await pay(find(await occ('2026-10'), 'Gás'), '2026-10-05');
    const nov = await pay(find(await occ('2026-11'), 'Gás', '2026-11'), '2026-11-05');
    const res = await edit(nov, { form: 'single', startMonth: undefined, day: undefined, date: '2026-11-05', dueDate: '2026-11-05' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('payments_not_movable');
  });

  it('parcela paga com mudança de data: continua paga e passa a vencer no dia novo', async () => {
    await create({ description: 'Geladeira', form: 'installment', amountCents: 300000, installments: 3, date: '2026-11-10', method: 'boleto' });
    const first = await pay(find(await occ('2026-11'), 'Geladeira'), '2026-11-10');
    const second = find(await occ('2026-12'), 'Geladeira');
    const res = await edit(second, { dueDate: '2026-12-15' });
    expect(res.statusCode).toBe(200);
    expect(res.json().occurrences.map((o: any) => [o.id === first.id, o.installmentLabel, o.dueDate, o.displayStatus])).toEqual([
      [true, '1/3', '2026-11-15', 'paid'],
      [false, '2/3', '2026-12-15', 'pending'],
      [false, '3/3', '2027-01-15', 'pending'],
    ]);
  });

  it('menos parcelas que a parcela paga: recusa', async () => {
    await create({ description: 'Notebook', form: 'installment', amountCents: 500000, installments: 5, date: '2026-08-10', method: 'boleto' });
    const fourth = await pay(find(await occ('2026-11'), 'Notebook', '2026-11'), '2026-11-10');
    expect(fourth.installmentLabel).toBe('4/5');
    const res = await edit(fourth, { installments: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'payments_not_movable',
      message: 'A parcela 4 já foi paga e deixaria de existir. Mantenha pelo menos 4 parcelas ou desfaça o pagamento.',
    });
  });

  it('paga e passando para o crédito: recusa e nada muda', async () => {
    await create({ description: 'Tênis', amountCents: 40000, date: '2026-11-02', alreadyPaid: true });
    const row = find(await occ('2026-11'), 'Tênis');
    const res = await edit(row, { method: 'credit', accountId: bb, dueDate: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('payments_not_movable');
    const [{ n }] = (await env.ctx.db.execute(sql`select count(*)::int as n from payments where occurrence_id = ${row.id}`)).rows as Array<{ n: number }>;
    expect(n).toBe(1);
  });
});
