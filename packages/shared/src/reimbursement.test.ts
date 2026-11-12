import { describe, expect, it } from 'vitest';
import { itemCreateInput, reimbursementInput, type ReimbursedExpense } from './index';

const PERSON = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CARD = '33333333-3333-4333-8333-333333333333';
const base = { description: 'Tênis', amountCents: 30000, personId: PERSON } as const;
const expense = (e: Partial<ReimbursedExpense> & Pick<ReimbursedExpense, 'form' | 'method'>): ReimbursedExpense => ({ ...base, ...e });

/** A entrada gerada precisa passar no mesmo contrato do cadastro. */
const valid = (i: ReturnType<typeof reimbursementInput>) => expect(itemCreateInput.safeParse(i).success).toBe(true);

describe('reembolso: entrada gerada por uma despesa de outra pessoa', () => {
  it('única fora do crédito: data do recebimento = data p/ pagamento ou, sem ela, a data', () => {
    const withDue = reimbursementInput(expense({ form: 'single', method: 'boleto', date: '2026-11-03', dueDate: '2026-11-20', accountId: ACCOUNT }));
    expect(withDue).toEqual({
      type: 'income',
      form: 'single',
      description: 'Tênis',
      amountCents: 30000,
      method: 'pix',
      accountId: ACCOUNT,
      personId: PERSON,
      date: '2026-11-20',
      dueDate: '2026-11-20',
    });
    valid(withDue);
    const noDue = reimbursementInput(expense({ form: 'single', method: 'pix', date: '2026-11-03' }));
    expect(noDue).toMatchObject({ date: '2026-11-03', dueDate: '2026-11-03', accountId: null });
    valid(noDue);
  });

  it('única no crédito: recebe no dia da compra, no mês do gasto, sem conta', () => {
    const r = reimbursementInput(expense({ form: 'single', method: 'credit', date: '2026-11-12', chargeMonth: '2026-11', accountId: CARD }));
    expect(r).toMatchObject({ form: 'single', method: 'pix', accountId: null, date: '2026-11-12', dueDate: '2026-11-12' });
    valid(r);
    // Compra de 30/10 depois do fechamento (dia 28): conta em novembro, e o reembolso também.
    expect(reimbursementInput(expense({ form: 'single', method: 'credit', date: '2026-10-30', chargeMonth: '2026-11', accountId: CARD }))).toMatchObject({
      date: '2026-11-30',
      dueDate: '2026-11-30',
    });
  });

  it('parcelada fora do crédito: mesma 1ª data e mesmo nº de parcelas', () => {
    const r = reimbursementInput(expense({ form: 'installment', method: 'boleto', installments: 3, date: '2027-01-31', accountId: ACCOUNT }));
    expect(r).toMatchObject({ form: 'installment', installments: 3, date: '2027-01-31', accountId: ACCOUNT, amountCents: 30000 });
    expect(r).not.toHaveProperty('dueDate');
    valid(r);
  });

  it('parcelada no crédito: 1ª parcela no mês do gasto da 1ª, as demais nos meses seguintes', () => {
    const r = reimbursementInput(expense({ form: 'installment', method: 'credit', installments: 3, date: '2026-11-12', chargeMonth: '2026-11', accountId: CARD }));
    expect(r).toMatchObject({ form: 'installment', installments: 3, date: '2026-11-12', accountId: null, method: 'pix' });
    valid(r);
    expect(reimbursementInput(expense({ form: 'installment', method: 'credit', installments: 3, date: '2027-01-31', chargeMonth: '2027-02', accountId: CARD }))).toMatchObject({
      date: '2027-02-28',
    });
  });

  it('recorrente fora do crédito: mesmo mês de início, mesmo dia e "valor varia"', () => {
    const r = reimbursementInput(expense({ form: 'recurring', method: 'pix', startMonth: '2026-11', day: 10, variableAmount: true, accountId: ACCOUNT }));
    expect(r).toMatchObject({ form: 'recurring', startMonth: '2026-11', day: 10, variableAmount: true, accountId: ACCOUNT });
    expect(r).not.toHaveProperty('date');
    valid(r);
  });

  it('recorrente no crédito: começa no mês do gasto da 1ª cobrança, no dia da cobrança', () => {
    const r = reimbursementInput(expense({ form: 'recurring', method: 'credit', startMonth: '2026-11', day: 10, chargeMonth: '2026-11', accountId: CARD }));
    expect(r).toMatchObject({ form: 'recurring', startMonth: '2026-11', day: 10, accountId: null, variableAmount: false });
    valid(r);
    // Cobrança dia 28 num cartão que fecha dia 25: a de 28/11 conta em dezembro.
    expect(reimbursementInput(expense({ form: 'recurring', method: 'credit', startMonth: '2026-11', day: 28, chargeMonth: '2026-12', accountId: CARD }))).toMatchObject({
      startMonth: '2026-12',
      day: 28,
    });
  });
});

describe('cadastro com reembolso: validação', () => {
  const ok = { type: 'expense', form: 'single', description: 'X', method: 'pix', amountCents: 100, date: '2026-11-03' } as const;
  const issues = (i: object) => {
    const r = itemCreateInput.safeParse(i);
    return r.success ? {} : Object.fromEntries(r.error.issues.map((x) => [x.path.join('.'), x.message]));
  };

  it('pede a pessoa', () => {
    expect(issues({ ...ok, createReimbursement: true })).toEqual({ personId: 'Escolha a pessoa.' });
    expect(issues({ ...ok, createReimbursement: true, personId: PERSON })).toEqual({});
  });

  it('só em despesas', () => {
    expect(issues({ ...ok, type: 'income', createReimbursement: true, personId: PERSON })).toHaveProperty('createReimbursement');
  });

  it('recorrente fora do crédito precisa do dia', () => {
    const rec = { ...ok, form: 'recurring', date: undefined, startMonth: '2026-11', createReimbursement: true, personId: PERSON };
    expect(issues(rec)).toEqual({ day: 'Informe o dia: o reembolso usa o mesmo dia.' });
    expect(issues({ ...rec, day: 10 })).toEqual({});
    expect(issues({ ...rec, createReimbursement: false })).toEqual({});
  });
});
