import { describe, expect, it } from 'vitest';
import { categoryDefaults, debtCreateInput, normalizeDebtTerms } from '../index';

const PERSON = '11111111-1111-4111-8111-111111111111';
const price = {
  name: 'Empréstimo Banco X',
  category: 'personal_loan',
  structure: 'price',
  monthlyRatePpm: 29900,
  installmentCents: 45000,
  remainingInstallments: 18,
  dueDay: 10,
  acceptsExtra: true,
  anchorDate: '2026-11-05',
  anchorBalanceCents: 680000,
} as const;
const fieldsOf = (r: ReturnType<typeof debtCreateInput.safeParse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join('.')));

describe('contrato de cadastro de dívida', () => {
  it('aceita uma Price completa', () => {
    expect(debtCreateInput.safeParse(price).success).toBe(true);
  });
  it('Price sem parcela', () => {
    expect(fieldsOf(debtCreateInput.safeParse({ ...price, installmentCents: null }))).toEqual(['installmentCents']);
  });
  it('Sem juros com taxa', () => {
    expect(fieldsOf(debtCreateInput.safeParse({ ...price, structure: 'interest_free', monthlyRatePpm: 10000 }))).toEqual(['monthlyRatePpm']);
  });
  it('credor como texto e pessoa ao mesmo tempo', () => {
    expect(fieldsOf(debtCreateInput.safeParse({ ...price, creditorName: 'Banco', creditorPersonId: PERSON }))).toEqual(['creditorName']);
  });
  it('categoria Pessoa exige a pessoa', () => {
    expect(fieldsOf(debtCreateInput.safeParse({ ...price, category: 'person' }))).toEqual(['creditorPersonId']);
  });
  it('taxa acima de 50% a.m.', () => {
    expect(fieldsOf(debtCreateInput.safeParse({ ...price, monthlyRatePpm: 600000 }))).toEqual(['monthlyRatePpm']);
  });
  it('rotativo exige mínimo válido', () => {
    const rev = { ...price, structure: 'revolving', installmentCents: null, remainingInstallments: null, dueDay: null };
    expect(fieldsOf(debtCreateInput.safeParse(rev))).toEqual(['minPaymentKind']);
    expect(fieldsOf(debtCreateInput.safeParse({ ...rev, minPaymentKind: 'percent', minPaymentValue: 50 }))).toEqual(['minPaymentValue']);
    expect(debtCreateInput.safeParse({ ...rev, minPaymentKind: 'percent', minPaymentValue: 150000 }).success).toBe(true);
  });
  it('troca de estrutura limpa os campos de outra estrutura', () => {
    expect(normalizeDebtTerms({ ...price, structure: 'revolving', minPaymentKind: 'percent', minPaymentValue: 150000 })).toEqual({
      structure: 'revolving',
      monthlyRatePpm: 29900,
      installmentCents: null,
      remainingInstallments: null,
      dueDay: null,
      minPaymentKind: 'percent',
      minPaymentValue: 150000,
    });
  });
  it('padrões por categoria', () => {
    expect(categoryDefaults('payroll_loan')).toEqual({ structure: 'price', acceptsExtra: false });
    expect(categoryDefaults('person')).toEqual({ structure: 'interest_free', acceptsExtra: true });
    expect(categoryDefaults('mortgage').structure).toBe('sac');
    expect(categoryDefaults('overdraft').structure).toBe('revolving');
  });
});
