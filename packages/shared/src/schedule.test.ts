import { describe, expect, it } from 'vitest';
import { chargeMonthOf, firstInstallmentDue, installmentDueDates, itemCreateInput, itemEditInput, itemEndInput, recurringRule } from './index';

const base = { description: 'Academia', amountCents: 10000 };
const errorsOf = (r: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('regra da recorrente (mês de início + dia)', () => {
  it('despesa fora do crédito sem dia: sem data p/ pagamento, mês começa no dia 1', () => {
    expect(recurringRule({ method: 'pix', startMonth: '2026-11', day: null })).toEqual({ startMonth: '2026-11', dueDay: null, entryDate: '2026-11-01' });
  });
  it('fora do crédito, o dia é o do pagamento; 31 fica guardado como 31', () => {
    expect(recurringRule({ method: 'boleto', startMonth: '2027-02', day: 31 })).toEqual({ startMonth: '2027-02', dueDay: 31, entryDate: '2027-02-28' });
  });
  it('no crédito, o dia é o da cobrança e fica só na entryDate', () => {
    expect(recurringRule({ method: 'credit', startMonth: '2026-11', day: 20 })).toEqual({ startMonth: '2026-11', dueDay: null, entryDate: '2026-11-20' });
  });
});

describe('datas das parcelas fora do crédito', () => {
  it('mesmo dia nos meses seguintes; 31 vira o último dia sem "andar" o dia', () => {
    expect(installmentDueDates('2027-01-31', 4)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(installmentDueDates('2026-11-30', 3)).toEqual(['2026-11-30', '2026-12-30', '2027-01-30']);
  });
  it('a data de uma parcela, recuada até a 1ª posição, é a da primeira', () => {
    expect(firstInstallmentDue('2027-01-20', 3)).toBe('2026-11-20');
    expect(firstInstallmentDue('2027-01-20', 1)).toBe('2027-01-20');
  });
});

describe('contrato de datas do lançamento', () => {
  it('recorrente exige mês de início; o dia é obrigatório na entrada e no crédito', () => {
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'recurring', method: 'pix' }))).toEqual({ startMonth: 'Informe o mês de início.' });
    expect(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'recurring', method: 'pix', startMonth: '2026-11' }).success).toBe(true);
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'income', form: 'recurring', method: 'transfer', startMonth: '2026-11' }))).toEqual({
      day: 'Informe o dia do recebimento.',
    });
    const card = '00000000-0000-4000-8000-000000000000';
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'recurring', method: 'credit', accountId: card, startMonth: '2026-11' }))).toEqual({
      day: 'Informe o dia da cobrança.',
    });
  });

  it('recorrente não aceita mais data (contrato antigo)', () => {
    const r = itemCreateInput.safeParse({ ...base, type: 'expense', form: 'recurring', method: 'pix', date: '2026-11-03', dueDate: '2026-11-10' });
    expect(errorsOf(r)).toEqual({
      startMonth: 'Informe o mês de início.',
      date: 'Recorrentes usam mês de início e dia, não data.',
      dueDate: 'Recorrentes usam mês de início e dia, não data.',
    });
  });

  it('dia fora de 1–31 é recusado', () => {
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'recurring', method: 'pix', startMonth: '2026-11', day: 32 }))).toEqual({ day: 'Dia entre 1 e 31.' });
  });

  it('única e parcelada exigem data e não aceitam mês de início nem dia', () => {
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'installment', installments: 3, method: 'boleto' }))).toEqual({ date: 'Informe a data.' });
    expect(errorsOf(itemCreateInput.safeParse({ ...base, type: 'expense', form: 'single', method: 'pix', date: '2026-11-03', startMonth: '2026-11', day: 5 }))).toEqual({
      startMonth: 'Só recorrentes têm mês de início.',
      day: 'Só recorrentes têm dia fixo.',
    });
  });

  it('na edição de parcelada fora do crédito vale a data desta parcela, sem "date"', () => {
    const r = itemEditInput.safeParse({ ...base, occurrenceId: 'x', type: 'expense', form: 'installment', installments: 3, method: 'boleto', dueDate: '2026-12-10' });
    expect(r.success).toBe(true);
  });

  it('"este e os próximos" recebe a ocorrência escolhida', () => {
    expect(itemEndInput.safeParse({ occurrenceId: 'p_00000000-0000-4000-8000-000000000000_2027-01' }).success).toBe(true);
    expect(itemEndInput.safeParse({ lastMonth: '2026-11' }).success).toBe(false);
  });
});

describe('mês do gasto no crédito', () => {
  it('única: o mês da compra, seja qual for a fatura', () => {
    expect(chargeMonthOf({ purchaseDate: '2026-11-10' })).toBe('2026-11');
    expect(chargeMonthOf({ purchaseDate: '2026-11-27', installment: null })).toBe('2026-11');
  });
  it('parcela k: k − 1 meses depois, inclusive na virada do ano', () => {
    expect([1, 2, 3].map((k) => chargeMonthOf({ purchaseDate: '2026-11-10', installment: k }))).toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('parcelas antigas importadas da fatura ("PARC 05/10" de julho): a partir do mês da 1ª importada', () => {
    const first = '2026-11'; // julho + (5 − 1)
    expect([1, 2, 6].map((k) => chargeMonthOf({ purchaseDate: '2026-07-15', installment: k, firstChargeMonth: first }))).toEqual(['2026-11', '2026-12', '2027-04']);
  });
});
