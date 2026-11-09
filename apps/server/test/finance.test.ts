import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';

/** Hoje nos testes: terça, 03/11/2026 (São Paulo). */
let env: TestEnv;
let c: Client;
let cards: { bb: string; nu: string };
let conta: string;

const occ = async (month: string, type = 'expense', extra = '') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}${extra}`))).json();
const find = (rows: Array<{ description: string }>, d: string) => rows.find((r) => r.description === d) as Record<string, any>;
const summary = async (month: string) => (await c.get(c.w(`/summary?month=${month}`))).json();
const create = async (body: Record<string, unknown>) => {
  const res = await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
  const bb = (await c.post(c.w('/accounts'), { name: 'BB Crédito', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 1, dueDay: 8 })).json();
  const nu = (await c.post(c.w('/accounts'), { name: 'Nubank', bank: 'Nubank', kind: 'credit_card', closingDay: 25, dueDay: 1 })).json();
  conta = (await c.post(c.w('/accounts'), { name: 'Conta BB', bank: 'Banco do Brasil', kind: 'account' })).json().id;
  cards = { bb: bb.id, nu: nu.id };
});
afterAll(async () => env.close());

describe('cadastros', () => {
  it('exige dias de fechamento e vencimento em cartões', async () => {
    const res = await c.post(c.w('/accounts'), { name: 'X', bank: 'Y', kind: 'credit_card' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields.closingDay).toBeDefined();
  });
  it('arquiva categoria em uso e apaga a sem uso', async () => {
    const cat = (await c.post(c.w('/categories'), { name: 'Pets', type: 'expense' })).json();
    expect((await c.post(c.w('/categories'), { name: 'pets', type: 'expense' })).statusCode).toBe(409);
    await create({ description: 'Ração', amountCents: 9000, date: '2026-11-02', categoryId: cat.id });
    expect((await c.del(c.w(`/categories/${cat.id}`))).json()).toEqual({ archived: true });
    const tmp = (await c.post(c.w('/categories'), { name: 'Temporária', type: 'income' })).json();
    expect((await c.del(c.w(`/categories/${tmp.id}`))).json()).toEqual({ archived: false });
  });
});

describe('lançamentos únicos', () => {
  it('pix já pago nasce pago na data informada', async () => {
    await create({ description: 'Vinho', amountCents: 8990, date: '2026-11-02', method: 'debit', accountId: conta, alreadyPaid: true });
    const r = find(await occ('2026-11'), 'Vinho');
    expect(r.displayStatus).toBe('paid');
    expect(r.payments[0].paidAt).toBe('2026-11-02');
    expect(r.installmentLabel).toBe('Única');
  });
  it('sem data p/ pagamento cai no mês do cadastro', async () => {
    await create({ description: 'Presente', amountCents: 5000, date: '2026-11-20' });
    expect(find(await occ('2026-11'), 'Presente').dueDate).toBeNull();
  });
  it('a data p/ pagamento define o mês', async () => {
    await create({ description: 'IPVA', amountCents: 120000, date: '2026-11-03', dueDate: '2026-12-10', method: 'boleto' });
    expect(find(await occ('2026-11'), 'IPVA')).toBeUndefined();
    expect(find(await occ('2026-12'), 'IPVA').dueDate).toBe('2026-12-10');
  });
});

describe('parcelas', () => {
  it('divide o total e arredonda na última', async () => {
    const item = await create({ description: 'Empréstimo da tia', form: 'installment', amountCents: 100000, installments: 3, date: '2026-11-05' });
    expect(item.occurrences.map((o: any) => [o.installmentLabel, o.expectedCents, o.dueDate])).toEqual([
      ['1/3', 33333, '2026-11-05'],
      ['2/3', 33333, '2026-12-05'],
      ['3/3', 33334, '2027-01-05'],
    ]);
  });
  it('paga várias parcelas de uma vez com o mesmo comprovante', async () => {
    const row = find(await occ('2026-11'), 'Empréstimo da tia');
    const wrong = await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-03', amountCents: 50000, payNext: 1 });
    expect(wrong.statusCode).toBe(400);
    const ok = await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-03', amountCents: 66666, payNext: 1 });
    expect(ok.statusCode).toBe(201);
    const rows = ok.json();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.payments[0].groupId)).size).toBe(1);
    expect(find(await occ('2026-12'), 'Empréstimo da tia').displayStatus).toBe('paid');
  });
  it('cancelar a compra cancela só as parcelas futuras em aberto', async () => {
    const item = await create({ description: 'Curso', form: 'installment', amountCents: 60000, installments: 3, date: '2026-10-10' });
    const first = item.occurrences[0];
    await c.post(c.w(`/occurrences/${first.id}/payments`), { paidAt: '2026-10-10', amountCents: 20000 });
    const after = (await c.post(c.w(`/items/${item.id}/cancel`))).json();
    expect(after.occurrences.map((o: any) => o.displayStatus)).toEqual(['paid', 'canceled', 'canceled']);
  });
});

describe('pagamentos', () => {
  it('pagamento menor exige dizer se é desconto ou parcial', async () => {
    await create({ description: 'Conserto', amountCents: 45000, date: '2026-11-03', dueDate: '2026-11-04' });
    const row = find(await occ('2026-11'), 'Conserto');
    const r1 = await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-03', amountCents: 20000 });
    expect(r1.json().error.code).toBe('settlement_required');
    const r2 = (await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-03', amountCents: 20000, settlement: 'partial' })).json()[0];
    expect([r2.displayStatus, r2.remainingCents]).toEqual(['partial', 25000]);
    const r3 = (await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-04', amountCents: 24000, settlement: 'discount' })).json()[0];
    expect([r3.displayStatus, r3.remainingCents, r3.settledWithDiscount]).toEqual(['paid', 0, true]);
    // desmarcar volta a parcial
    const undone = (await c.del(c.w(`/payments/${r3.payments[1].id}`))).json();
    expect([undone.displayStatus, undone.settledWithDiscount]).toEqual(['partial', false]);
  });
  it('pagar mais que o previsto mostra o valor pago', async () => {
    await create({ description: 'Luz atrasada', amountCents: 17210, date: '2026-11-01', dueDate: '2026-11-02', method: 'boleto' });
    const row = find(await occ('2026-11'), 'Luz atrasada');
    const r = (await c.post(c.w(`/occurrences/${row.id}/payments`), { paidAt: '2026-11-02', amountCents: 18740 })).json()[0];
    expect([r.displayStatus, r.paidCents, r.expectedCents]).toEqual(['paid', 18740, 17210]);
  });
});

describe('recorrentes e projeções', () => {
  it('grava até o mês atual, marca atrasados e projeta o futuro', async () => {
    await create({ description: 'Internet', form: 'recurring', amountCents: 12000, startMonth: '2026-09', day: 20, method: 'boleto' });
    const nov = await occ('2026-11');
    const internet = nov.filter((r: any) => r.description === 'Internet');
    // set e out atrasados aparecem em novembro, mais a de novembro
    expect(internet.map((r: any) => [r.competenceMonth, r.displayStatus])).toEqual([
      ['2026-09', 'late'],
      ['2026-10', 'late'],
      ['2026-11', 'pending'],
    ]);
    const dec = find(await occ('2026-12'), 'Internet');
    expect(dec.projected).toBe(true);
    expect(dec.id).toMatch(/^p_/);
    expect(dec.dueDate).toBe('2026-12-20');
  });
  it('mudar o valor de um mês muda a regra dali em diante', async () => {
    const rows = (await occ('2026-11')).filter((r: any) => r.description === 'Internet' && !r.late);
    await c.patch(c.w(`/occurrences/${rows[0].id}`), { expectedCents: 13000 });
    expect(find(await occ('2026-12'), 'Internet').expectedCents).toBe(13000);
    expect((await occ('2026-10')).find((r: any) => r.description === 'Internet').expectedCents).toBe(12000);
  });
  it('pagar uma projeção grava a ocorrência', async () => {
    const dec = find(await occ('2026-12'), 'Internet');
    const res = await c.post(c.w(`/occurrences/${dec.id}/payments`), { paidAt: '2026-11-03', amountCents: 13000 });
    expect(res.statusCode).toBe(201);
    const after = find(await occ('2026-12'), 'Internet');
    expect([after.projected, after.displayStatus]).toEqual([false, 'paid']);
  });
  it('valor variável copia o último valor pago', async () => {
    const item = await create({ description: 'Água', form: 'recurring', amountCents: 9000, variableAmount: true, startMonth: '2026-10', day: 5, method: 'boleto' });
    const oct = item.occurrences.find((o: any) => o.competenceMonth === '2026-10');
    await c.post(c.w(`/occurrences/${oct.id}/payments`), { paidAt: '2026-10-05', amountCents: 11250 });
    expect(find(await occ('2026-12'), 'Água').expectedCents).toBe(11250);
  });
  it('"este e os próximos" num mês previsto mantém os anteriores', async () => {
    const item = await create({ description: 'Academia', form: 'recurring', amountCents: 9900, startMonth: '2026-11', day: 10 });
    const dec = find(await occ('2026-12'), 'Academia');
    expect((await c.post(c.w(`/items/${item.id}/end`), { occurrenceId: dec.id })).statusCode).toBe(200);
    expect(find(await occ('2026-12'), 'Academia')).toBeUndefined();
    expect(find(await occ('2027-01'), 'Academia')).toBeUndefined();
    expect(find(await occ('2026-11'), 'Academia')).toBeDefined();
  });
  it('entradas prometidas com marcar como recebido', async () => {
    await c.post(c.w('/items'), { type: 'income', form: 'recurring', description: 'Salário', amountCents: 650000, startMonth: '2026-11', day: 5, method: 'transfer' });
    const sal = find(await occ('2026-11', 'income'), 'Salário');
    expect(sal.displayStatus).toBe('pending');
    await c.post(c.w(`/occurrences/${sal.id}/payments`), { paidAt: '2026-11-05', amountCents: 650000 });
  });
});

describe('cartão e faturas', () => {
  it('compra antes do fechamento entra na fatura que fecha; no dia, vai para a seguinte', async () => {
    const before = (await c.get(c.w(`/invoice-preview?account=${cards.bb}&date=2026-10-31`))).json();
    const onDay = (await c.get(c.w(`/invoice-preview?account=${cards.bb}&date=2026-11-01`))).json();
    expect([before.referenceMonth, before.dueDate]).toEqual(['2026-11', '2026-11-08']);
    expect([onDay.referenceMonth, onDay.dueDate]).toEqual(['2026-12', '2026-12-08']);
  });
  it('itens no crédito não têm botão de pagar e herdam o status da fatura', async () => {
    await create({ description: 'Pizza', method: 'credit', accountId: cards.bb, amountCents: 8000, date: '2026-10-30' });
    await create({ description: 'Seguro do carro', method: 'credit', accountId: cards.bb, form: 'installment', amountCents: 90000, installments: 2, date: '2026-10-15' });
    // Na tabela, a compra fica no mês em que foi feita (out); a fatura é a de nov.
    const pizza = find(await occ('2026-10'), 'Pizza');
    expect([pizza.displayStatus, pizza.dueDate, pizza.invoice.referenceMonth, pizza.chargeMonth]).toEqual(['invoice_open', '2026-11-08', '2026-11', '2026-10']);
    expect(find(await occ('2026-11'), 'Pizza')).toBeUndefined();
    const res = await c.post(c.w(`/occurrences/${pizza.id}/payments`), { paidAt: '2026-11-03', amountCents: 8000 });
    expect(res.json().error.code).toBe('credit_item');
    // Parcela 2 gasta em nov (compra de out + 1), na fatura de dez.
    const second = find(await occ('2026-11'), 'Seguro do carro');
    expect([second.installmentLabel, second.invoice.referenceMonth]).toEqual(['2/2', '2026-12']);
  });
  it('valor real diferente gera ajuste; pagamento parcial transfere o saldo', async () => {
    const invs = (await c.get(c.w('/invoices?month=2026-11'))).json();
    const bb = invs.find((i: any) => i.account.id === cards.bb);
    expect(bb.itemsCents).toBe(8000 + 45000);
    // fatura real veio R$ 540,00 (anuidade), pagou R$ 400,00
    const paid = (await c.post(c.w(`/invoices/${bb.id}/payments`), { realAmountCents: 54000, amountCents: 40000, paidAt: '2026-11-03' })).json();
    expect([paid.status, paid.totalCents, paid.paidCents, paid.carriedToMonth]).toEqual(['carried', 54000, 40000, '2026-12']);
    const nov = await occ('2026-11');
    expect(find(nov, 'Ajuste da fatura').expectedCents).toBe(1000);
    expect(find(await occ('2026-10'), 'Pizza').displayStatus).toBe('invoice_carried');
    const carry = find(await occ('2026-12'), 'Saldo restante da fatura nov/2026 · BB Crédito');
    expect(carry.expectedCents).toBe(14000);
    // fatura encerrada não aceita outro pagamento
    expect((await c.post(c.w(`/invoices/${bb.id}/payments`), { realAmountCents: 54000, amountCents: 14000, paidAt: '2026-11-03' })).statusCode).toBe(409);
    // desfazer reabre e remove o saldo transferido
    expect((await c.del(c.w(`/invoice-payments/${paid.payments[0].id}`))).statusCode).toBe(204);
    expect(find(await occ('2026-12'), 'Saldo restante da fatura nov/2026 · BB Crédito')).toBeUndefined();
    const reopened = (await c.get(c.w('/invoices?month=2026-11'))).json().find((i: any) => i.account.id === cards.bb);
    expect(reopened.status).toBe('open');
  });
  it('pagamento total quita a fatura', async () => {
    const bb = (await c.get(c.w('/invoices?month=2026-11'))).json().find((i: any) => i.account.id === cards.bb);
    const paid = (await c.post(c.w(`/invoices/${bb.id}/payments`), { realAmountCents: 54000, amountCents: 54000, paidAt: '2026-11-08' })).json();
    expect(paid.status).toBe('paid');
    expect(find(await occ('2026-10'), 'Pizza').displayStatus).toBe('invoice_paid');
  });
  it('mover um item para outra fatura', async () => {
    await create({ description: 'Farmácia', method: 'credit', accountId: cards.nu, amountCents: 4590, date: '2026-11-20' });
    const row = find(await occ('2026-11'), 'Farmácia');
    expect(row.invoice.referenceMonth).toBe('2026-12');
    const moved = (await c.patch(c.w(`/occurrences/${row.id}/invoice`), { referenceMonth: '2027-01' })).json();
    // Mover de fatura não muda o mês do gasto.
    expect([moved.competenceMonth, moved.dueDate, moved.chargeMonth]).toEqual(['2027-01', '2027-01-01', '2026-11']);
  });
  it('recorrente no crédito entra nas faturas e projeta nos meses futuros', async () => {
    await create({ description: 'Netflix', form: 'recurring', method: 'credit', accountId: cards.nu, amountCents: 5590, startMonth: '2026-11', day: 15 });
    const fut = (await c.get(c.w('/invoices?month=2027-02'))).json().find((i: any) => i.account.id === cards.nu);
    expect(fut.itemsCents).toBe(5590);
  });
});

describe('resumo do mês', () => {
  it('mostra realizado e previsto e soma os atrasados', async () => {
    const s = await summary('2026-11');
    expect(s.isCurrentMonth).toBe(true);
    // atrasos: Internet set + out (12000 cada) + Curso? (cancelado, não)
    expect(s.expense.lateCents).toBe(24000);
    expect(s.income.receivedCents).toBe(650000);
    expect(s.balance.forecastCents).toBe(s.income.forecastCents - s.expense.forecastCents);
    expect(s.expense.forecastCents).toBe(s.expense.paidCents + s.expense.pendingCents);
    const future = await summary('2027-01');
    expect(future.expense.lateCents).toBe(0);
    expect(future.expense.pendingCents).toBeGreaterThan(0);
  });
  it('navega até 6 meses à frente ou a última parcela', async () => {
    const r = (await c.get(c.w('/months'))).json();
    expect(r).toEqual({ currentMonth: '2026-11', firstMonth: '2026-09', lastMonth: '2027-05' });
  });
});

describe('exclusão e concorrência', () => {
  it('exclusão lógica tira o item das telas', async () => {
    const item = await create({ description: 'Duplicado', amountCents: 1000, date: '2026-11-03' });
    expect((await c.del(c.w(`/items/${item.id}`))).statusCode).toBe(204);
    expect(find(await occ('2026-11'), 'Duplicado')).toBeUndefined();
  });
  it('edição com versão antiga recebe 409', async () => {
    const row = find(await occ('2026-11'), 'Presente');
    await c.patch(c.w(`/occurrences/${row.id}`), { note: 'Aniversário', version: row.version });
    const stale = await c.patch(c.w(`/occurrences/${row.id}`), { note: 'Outra', version: row.version });
    expect(stale.statusCode).toBe(409);
  });
});
