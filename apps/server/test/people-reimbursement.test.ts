import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/**
 * Pessoas e responsável, reembolso de gasto de terceiros, parcelas de meses
 * anteriores pagas no cadastro e o previsto do resumo (ADR-0004, ADR-0005).
 * Hoje: 03/11/2026.
 */
let env: TestEnv;
let c: Client;
let conta: string;
/** Fecha dia 10, vence dia 17. */
let ouro: string;
/** Fecha dia 25, vence dia 5. */
let nu: string;
let maria: string;
let joao: string;

type Row = Record<string, any>;
const occ = async (month: string, type = 'expense'): Promise<Row[]> => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Row[], d: string) => rows.find((r) => r.description === d)!;
const post = (body: Record<string, unknown>, cl: Client = c) => cl.post(cl.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
const create = async (body: Record<string, unknown>, cl: Client = c) => {
  const res = await post(body, cl);
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
const detail = async (id: string) => (await c.get(c.w(`/items/${id}`))).json();
const person = async (name: string) => (await c.post(c.w('/people'), { name })).json().id as string;
const invoice = async (month: string, card: string) => ((await c.get(c.w(`/invoices?month=${month}`))).json() as Row[]).find((i) => i.account.id === card && i.referenceMonth === month);

/** Corpo da edição como a tela envia, com as mudanças por cima. */
const edit = async (row: Row, changes: Record<string, unknown>) => {
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
/** A entrada de reembolso vinculada a uma despesa. */
const reimbursementOf = async (expenseId: string) => {
  const r = (await detail(expenseId)).reimbursement;
  return r ? detail(r.id) : null;
};

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  conta = (await c.post(c.w('/accounts'), { name: 'Conta BB', bank: 'Banco do Brasil', kind: 'account' })).json().id;
  ouro = (await c.post(c.w('/accounts'), { name: 'Ourocard', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 10, dueDay: 17 })).json().id;
  nu = (await c.post(c.w('/accounts'), { name: 'Nubank', bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 5 })).json().id;
  maria = await person('Maria');
  joao = await person('João');
});
afterAll(async () => env.close());

describe('pessoas', () => {
  it('cria, lista em ordem, renomeia e recusa nome repetido', async () => {
    const ana = (await c.post(c.w('/people'), { name: '  Ana  ' })).json();
    expect(ana).toMatchObject({ name: 'Ana', archived: false });
    expect(((await c.get(c.w('/people'))).json() as Row[]).map((p) => p.name)).toEqual(['Ana', 'João', 'Maria']);
    const dup = await c.post(c.w('/people'), { name: 'maria' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'duplicate', message: 'Já existe uma pessoa com esse nome.' });
    expect((await c.patch(c.w(`/people/${ana.id}`), { name: 'Ana Paula' })).json().name).toBe('Ana Paula');
    expect((await c.patch(c.w(`/people/${ana.id}`), { name: 'MARIA' })).statusCode).toBe(409);
    expect((await c.post(c.w('/people'), { name: ' ' })).statusCode).toBe(400);
  });

  it('remover sem uso apaga; em uso arquiva e o lançamento continua com ela', async () => {
    const bia = await person('Bia');
    expect((await c.del(c.w(`/people/${bia}`))).json()).toEqual({ archived: false });
    expect(((await c.get(c.w('/people?all=1'))).json() as Row[]).some((p) => p.id === bia)).toBe(false);

    const caio = await person('Caio');
    await create({ type: 'income', method: 'transfer', description: 'Aluguel do Caio', amountCents: 50000, date: '2026-11-10', dueDate: '2026-11-10', personId: caio });
    expect((await c.del(c.w(`/people/${caio}`))).json()).toEqual({ archived: true });
    expect(((await c.get(c.w('/people'))).json() as Row[]).some((p) => p.id === caio)).toBe(false);
    expect(((await c.get(c.w('/people?all=1'))).json() as Row[]).find((p) => p.id === caio)).toMatchObject({ archived: true });
    expect(find(await occ('2026-11', 'income'), 'Aluguel do Caio').person).toEqual({ id: caio, name: 'Caio' });
    // Arquivada: não vale num lançamento novo...
    const res = await post({ description: 'Novo do Caio', amountCents: 100, date: '2026-11-03', personId: caio });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'validation', fields: { personId: 'Essa pessoa foi removida. Escolha outra.' } });
    // ...mas continua valendo na edição do lançamento que já era dela.
    const row = find(await occ('2026-11', 'income'), 'Aluguel do Caio');
    expect((await edit(row, { personId: caio, description: 'Aluguel do Caio (sala)' })).statusCode).toBe(200);
  });

  it('isola carteiras: ninguém acessa as pessoas de outro, nem usa uma pessoa de outra carteira', async () => {
    const other = await signedIn(env, 'outra@example.com', 'Outra');
    expect((await other.get(c.w('/people'))).statusCode).toBe(403);
    const res = await post({ description: 'Alheio', amountCents: 100, date: '2026-11-03', personId: maria }, other);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields.personId).toBe('Pessoa não encontrada.');
  });
});

describe('responsável do lançamento', () => {
  it('sem responsável é "Eu" (nulo)', async () => {
    const item = await create({ description: 'Padaria', amountCents: 1200, date: '2026-11-03' });
    expect(item.person).toBeNull();
    expect(find(await occ('2026-11'), 'Padaria').person).toBeNull();
  });

  it('trocar o responsável vale para todas as parcelas, sem recriar meses nem perder pagamento', async () => {
    const item = await create({ form: 'installment', method: 'boleto', description: 'Geladeira', amountCents: 300000, installments: 3, date: '2026-11-03' });
    const first = item.occurrences[0];
    expect((await c.post(c.w(`/occurrences/${first.id}/payments`), { paidAt: '2026-11-03', amountCents: 100000 })).statusCode).toBeLessThan(300);
    const row = find(await occ('2026-11'), 'Geladeira');
    expect((await edit(row, { personId: maria })).statusCode).toBe(200);
    const after = await detail(item.id);
    expect(after.person).toEqual({ id: maria, name: 'Maria' });
    expect(after.occurrences.map((o: Row) => o.id)).toEqual(item.occurrences.map((o: Row) => o.id));
    expect(after.occurrences.every((o: Row) => o.person?.id === maria)).toBe(true);
    expect(after.occurrences[0]).toMatchObject({ status: 'paid', payments: [expect.objectContaining({ amountCents: 100000 })] });
    // Voltar para "Eu".
    expect((await edit(find(await occ('2026-11'), 'Geladeira'), { personId: null })).statusCode).toBe(200);
    expect((await detail(item.id)).person).toBeNull();
  });

  it('a edição estrutural mantém o responsável', async () => {
    const item = await create({ description: 'Academia do João', amountCents: 9900, date: '2026-11-05', personId: joao });
    const row = find(await occ('2026-11'), 'Academia do João');
    const res = await edit(row, { form: 'recurring', startMonth: '2026-11', day: 5, date: null, dueDate: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: item.id, form: 'recurring', person: { id: joao, name: 'João' } });
    expect(find(await occ('2026-12'), 'Academia do João').person).toEqual({ id: joao, name: 'João' });
  });
});

describe('gasto de outra pessoa: entrada de reembolso', () => {
  it('única no Pix: reembolso a receber na mesma data, com a categoria "Gasto de terceiros"', async () => {
    const expense = await create({
      description: 'Remédio da Maria',
      amountCents: 8000,
      date: '2026-11-03',
      accountId: conta,
      alreadyPaid: true,
      personId: maria,
      createReimbursement: true,
    });
    expect(expense.occurrences[0].status).toBe('paid');
    expect(expense.person).toEqual({ id: maria, name: 'Maria' });
    const income = (await reimbursementOf(expense.id))!;
    expect(income).toMatchObject({
      type: 'income',
      form: 'single',
      description: 'Remédio da Maria',
      method: 'pix',
      accountId: conta,
      amountCents: 8000,
      person: { id: maria, name: 'Maria' },
      reimburses: { id: expense.id, description: 'Remédio da Maria' },
    });
    // Pagar a despesa não quer dizer que a pessoa já devolveu.
    expect(income.occurrences[0]).toMatchObject({ dueDate: '2026-11-03', status: 'pending', competenceMonth: '2026-11' });
    const cats = ((await c.get(c.w('/categories'))).json() as Row[]).filter((x) => x.name === 'Gasto de terceiros');
    expect(cats).toEqual([expect.objectContaining({ type: 'income', id: income.categoryId })]);
  });

  it('a categoria é criada uma vez e reaproveitada', async () => {
    const expense = await create({ method: 'boleto', description: 'Conserto', amountCents: 20000, date: '2026-11-03', dueDate: '2026-11-20', personId: joao, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    // Data p/ pagamento da despesa = data do recebimento do reembolso.
    expect(income.occurrences[0].dueDate).toBe('2026-11-20');
    expect(income.entryDate).toBe('2026-11-20');
    expect(((await c.get(c.w('/categories'))).json() as Row[]).filter((x) => x.name === 'Gasto de terceiros')).toHaveLength(1);
  });

  it('única no crédito: recebe na data da compra, no mesmo mês do gasto, sem conta', async () => {
    const expense = await create({ method: 'credit', accountId: ouro, description: 'Fone da Maria', amountCents: 15000, date: '2026-11-12', personId: maria, createReimbursement: true });
    expect(expense.occurrences[0]).toMatchObject({ chargeMonth: '2026-11', invoice: expect.objectContaining({ referenceMonth: '2026-12' }) });
    const income = (await reimbursementOf(expense.id))!;
    expect(income).toMatchObject({ method: 'pix', accountId: null });
    expect(income.occurrences[0]).toMatchObject({ dueDate: '2026-11-12', competenceMonth: '2026-11', chargeMonth: '2026-11' });
  });

  it('parcelada no crédito: parcelas nos meses do gasto (data da compra)', async () => {
    const expense = await create({
      form: 'installment',
      method: 'credit',
      accountId: ouro,
      description: 'Tênis do João',
      amountCents: 30000,
      installments: 3,
      date: '2026-11-12',
      personId: joao,
      createReimbursement: true,
    });
    const income = (await reimbursementOf(expense.id))!;
    expect(income).toMatchObject({ form: 'installment', installments: 3, totalCents: 30000 });
    expect(income.occurrences.map((o: Row) => [o.installmentLabel, o.dueDate, o.expectedCents])).toEqual([
      ['1/3', '2026-11-12', 10000],
      ['2/3', '2026-12-12', 10000],
      ['3/3', '2027-01-12', 10000],
    ]);
  });

  it('parcelada fora do crédito: mesmas datas', async () => {
    const expense = await create({ form: 'installment', method: 'boleto', accountId: conta, description: 'Curso da Maria', amountCents: 60000, installments: 2, date: '2026-11-20', personId: maria, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    expect(income.accountId).toBe(conta);
    expect(income.occurrences.map((o: Row) => o.dueDate)).toEqual(['2026-11-20', '2026-12-20']);
  });

  it('recorrente fora do crédito: mesmo início e mesmo dia; sem dia é recusada', async () => {
    const noDay = await post({ form: 'recurring', description: 'Streaming', amountCents: 3990, startMonth: '2026-11', personId: maria, createReimbursement: true });
    expect(noDay.statusCode).toBe(400);
    expect(noDay.json().error.fields.day).toBe('Informe o dia: o reembolso usa o mesmo dia.');
    const expense = await create({ form: 'recurring', description: 'Streaming', amountCents: 3990, startMonth: '2026-11', day: 10, variableAmount: true, personId: maria, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    expect(income).toMatchObject({ form: 'recurring', startMonth: '2026-11', dueDay: 10, variableAmount: true, amountCents: 3990 });
    expect(find(await occ('2026-11', 'income'), 'Streaming').dueDate).toBe('2026-11-10');
  });

  it('recorrente no crédito: mesmo mês de início, no dia da cobrança', async () => {
    const expense = await create({ form: 'recurring', method: 'credit', accountId: nu, description: 'Assinatura da Maria', amountCents: 2990, startMonth: '2026-11', day: 28, personId: maria, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    expect(income).toMatchObject({ form: 'recurring', startMonth: '2026-11', dueDay: 28, accountId: null });
    // A cobrança de 28/11 (fatura de jan) e o reembolso ficam os dois em novembro.
    expect(find(await occ('2026-11'), 'Assinatura da Maria')).toMatchObject({ projected: false, invoice: expect.objectContaining({ referenceMonth: '2027-01' }) });
    expect(find(await occ('2026-11', 'income'), 'Assinatura da Maria').dueDate).toBe('2026-11-28');
  });

  it('validação: só despesa, com pessoa', async () => {
    const income = await post({ type: 'income', method: 'transfer', description: 'X', amountCents: 100, date: '2026-11-03', personId: maria, createReimbursement: true });
    expect(income.statusCode).toBe(400);
    expect(income.json().error.fields.createReimbursement).toBe('Só despesas geram reembolso.');
    const noPerson = await post({ description: 'X', amountCents: 100, date: '2026-11-03', createReimbursement: true });
    expect(noPerson.json().error.fields.personId).toBe('Escolha a pessoa.');
  });

  it('cadastro recusado não grava nada', async () => {
    const before = ((await c.get(c.w('/categories'))).json() as Row[]).length;
    const other = await signedIn(env, 'terceira@example.com', 'Terceira');
    const alien = (await other.post(other.w('/accounts'), { name: 'Cartão alheio', bank: 'X', kind: 'credit_card', closingDay: 1, dueDay: 10 })).json().id;
    const res = await post({ method: 'credit', accountId: alien, description: 'Recusado', amountCents: 100, date: '2026-11-03', personId: maria, createReimbursement: true });
    expect(res.statusCode).toBe(400);
    expect(find(await occ('2026-11'), 'Recusado')).toBeUndefined();
    expect(find(await occ('2026-11', 'income'), 'Recusado')).toBeUndefined();
    expect(((await c.get(c.w('/categories'))).json() as Row[]).length).toBe(before);
  });

  it('editar a despesa não muda o reembolso', async () => {
    const expense = await create({ description: 'Presente', amountCents: 8000, date: '2026-11-04', personId: maria, createReimbursement: true });
    const res = await edit(find(await occ('2026-11'), 'Presente'), { amountCents: 9000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().reimbursement).toMatchObject({ description: 'Presente' });
    const income = (await reimbursementOf(expense.id))!;
    expect(income.occurrences[0].expectedCents).toBe(8000);
  });

  it('excluir só o reembolso: a despesa continua e perde o vínculo', async () => {
    const expense = await create({ description: 'Livro', amountCents: 5000, date: '2026-11-04', personId: joao, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    expect((await c.del(c.w(`/items/${income.id}`))).statusCode).toBe(204);
    expect((await detail(expense.id)).reimbursement).toBeNull();
  });

  it('excluir a despesa com e sem o reembolso', async () => {
    const both = await create({ description: 'Jantar', amountCents: 12000, date: '2026-11-04', personId: maria, createReimbursement: true });
    const bothIncome = (await reimbursementOf(both.id))!;
    expect((await c.del(c.w(`/items/${both.id}?withReimbursement=1`))).statusCode).toBe(204);
    expect((await c.get(c.w(`/items/${bothIncome.id}`))).statusCode).toBe(404);
    expect(find(await occ('2026-11', 'income'), 'Jantar')).toBeUndefined();

    const only = await create({ description: 'Almoço', amountCents: 4000, date: '2026-11-04', personId: maria, createReimbursement: true });
    const onlyIncome = (await reimbursementOf(only.id))!;
    expect((await c.del(c.w(`/items/${only.id}`))).statusCode).toBe(204);
    const kept = await detail(onlyIncome.id);
    expect(kept.reimburses).toBeNull();
    expect(find(await occ('2026-11', 'income'), 'Almoço')).toBeDefined();
  });

  it('cancelar as parcelas da despesa não mexe no reembolso', async () => {
    const expense = await create({ form: 'installment', method: 'boleto', description: 'Bicicleta', amountCents: 90000, installments: 3, date: '2026-11-20', personId: joao, createReimbursement: true });
    expect((await c.post(c.w(`/items/${expense.id}/cancel`))).statusCode).toBe(200);
    expect((await detail(expense.id)).occurrences.every((o: Row) => o.status === 'canceled')).toBe(true);
    const income = (await reimbursementOf(expense.id))!;
    expect(income.occurrences.every((o: Row) => o.status === 'pending')).toBe(true);
  });
});

describe('parcelas de meses anteriores', () => {
  it('boleto: meses anteriores pagos no vencimento, o mês atual e os seguintes em aberto', async () => {
    const item = await create({ form: 'installment', method: 'boleto', description: 'Sofá', amountCents: 50000, installments: 5, date: '2026-08-10', pastInstallmentsPaid: true });
    expect(item.occurrences.map((o: Row) => [o.competenceMonth, o.status, o.payments[0]?.paidAt ?? null])).toEqual([
      ['2026-08', 'paid', '2026-08-10'],
      ['2026-09', 'paid', '2026-09-10'],
      ['2026-10', 'paid', '2026-10-10'],
      ['2026-11', 'pending', null],
      ['2026-12', 'pending', null],
    ]);
    expect(item.occurrences[0].payments[0].amountCents).toBe(10000);
  });

  it('a parcela do mês atual fica em aberto mesmo vencida', async () => {
    const item = await create({ form: 'installment', method: 'pix', description: 'Celular', amountCents: 20000, installments: 2, date: '2026-10-02', pastInstallmentsPaid: true });
    expect(item.occurrences.map((o: Row) => [o.dueDate, o.status])).toEqual([
      ['2026-10-02', 'paid'],
      ['2026-11-02', 'pending'],
    ]);
    expect(find(await occ('2026-11'), 'Celular')).toMatchObject({ displayStatus: 'pending', late: false });
  });

  it('com "Não", as parcelas de meses anteriores ficam atrasadas', async () => {
    await create({ form: 'installment', method: 'boleto', description: 'Mesa', amountCents: 30000, installments: 3, date: '2026-09-15', pastInstallmentsPaid: false });
    const late = (await occ('2026-11')).filter((r) => r.description === 'Mesa');
    expect(late.map((r) => [r.competenceMonth, r.displayStatus])).toEqual(
      expect.arrayContaining([
        ['2026-09', 'late'],
        ['2026-10', 'late'],
      ]),
    );
  });

  it('na parcelada, "Já foi pago?" não vale mais', async () => {
    const item = await create({ form: 'installment', method: 'boleto', description: 'Cadeira', amountCents: 20000, installments: 2, date: '2026-10-05', alreadyPaid: true });
    expect(item.occurrences.every((o: Row) => o.status === 'pending')).toBe(true);
  });

  it('crédito: paga só as faturas passadas que existem por causa da compra', async () => {
    const card = (await c.post(c.w('/accounts'), { name: 'Elo', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 10, dueDay: 17 })).json().id;
    // Abrir o mês já cria a fatura vazia de agosto: continua valendo como "só desta compra".
    await c.get(c.w('/invoices?month=2026-08'));
    // Outra compra, ainda em aberto, na fatura de setembro.
    await create({ method: 'credit', accountId: card, description: 'Jantar no cartão', amountCents: 7000, date: '2026-08-20' });
    const item = await create({ form: 'installment', method: 'credit', accountId: card, description: 'TV', amountCents: 600000, installments: 6, date: '2026-07-20', pastInstallmentsPaid: true });
    expect(item.occurrences.map((o: Row) => o.invoice.referenceMonth)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    const aug = await invoice('2026-08', card);
    const sep = await invoice('2026-09', card);
    const oct = await invoice('2026-10', card);
    expect([aug.status, aug.paidCents, aug.realAmountCents, aug.payments.map((p: Row) => p.paidAt)]).toEqual(['paid', 100000, 100000, ['2026-08-17']]);
    expect([sep.status, sep.paidCents, sep.itemsCents]).toEqual(['open', 0, 107000]);
    expect([oct.status, oct.paidCents]).toEqual(['paid', 100000]);
    expect((await invoice('2026-11', card)).status).toBe('open');
    // No mês atual, só setembro aparece como fatura atrasada.
    const lateHere = ((await c.get(c.w('/invoices?month=2026-11'))).json() as Row[]).filter((i) => i.account.id === card && i.late);
    expect(lateHere.map((i) => i.referenceMonth)).toEqual(['2026-09']);
  });

  it('o reembolso segue a mesma resposta', async () => {
    const expense = await create({ form: 'installment', method: 'boleto', description: 'Óculos da Maria', amountCents: 30000, installments: 3, date: '2026-09-10', pastInstallmentsPaid: true, personId: maria, createReimbursement: true });
    const income = (await reimbursementOf(expense.id))!;
    expect(income.occurrences.map((o: Row) => o.status)).toEqual(['paid', 'paid', 'pending']);
    expect(expense.occurrences.map((o: Row) => o.status)).toEqual(['paid', 'paid', 'pending']);
  });
});

describe('resumo do mês: previsto', () => {
  it('previsto = realizado + o que falta, inclusive os atrasados no mês atual', async () => {
    const d = await signedIn(env, 'resumo@example.com', 'Resumo');
    await create({ description: 'Pago', amountCents: 100000, date: '2026-11-02', alreadyPaid: true }, d);
    await create({ method: 'boleto', description: 'A pagar', amountCents: 50000, date: '2026-11-02', dueDate: '2026-11-20' }, d);
    await create({ method: 'boleto', description: 'Atrasada', amountCents: 20000, date: '2026-10-10' }, d);
    await create({ type: 'income', method: 'transfer', description: 'Recebido', amountCents: 300000, date: '2026-11-01', dueDate: '2026-11-01', alreadyPaid: true }, d);
    await create({ type: 'income', method: 'transfer', description: 'A receber', amountCents: 200000, date: '2026-11-25', dueDate: '2026-11-25' }, d);
    const s = (await d.get(d.w('/summary?month=2026-11'))).json();
    expect(s.expense).toEqual({ paidCents: 100000, pendingCents: 70000, lateCents: 20000, forecastCents: 170000 });
    expect(s.income).toEqual({ receivedCents: 300000, pendingCents: 200000, lateCents: 0, forecastCents: 500000 });
    expect(s.balance).toEqual({ realizedCents: 200000, forecastCents: 330000 });
  });
});
