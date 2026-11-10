import { describe, expect, it } from 'vitest';
import { investmentCloseInput, investmentCreateInput, investmentMovementInput, investmentSettingsInput } from '../index';

const box = {
  name: 'Reserva',
  icon: 'piggy',
  kind: 'savings_box',
  yieldKind: 'cdi',
  cdiShareBp: 10_000,
  taxMode: 'regressive',
  goalCents: 2_000_000,
  monthlyPlanCents: 50_000,
  initialCents: 1_000_000,
  initialDate: '2026-03-10',
} as const;
const paths = (r: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.path.join('.')));

describe('contrato de cadastro de caixinha', () => {
  it('aceita uma caixinha com CDI', () => {
    expect(investmentCreateInput.safeParse(box).success).toBe(true);
  });
  it('recusa ícone fora da lista', () => {
    expect(paths(investmentCreateInput.safeParse({ ...box, icon: 'rocket' }))).toEqual(['icon']);
  });
  it('mês-alvo exige o valor da meta', () => {
    expect(paths(investmentCreateInput.safeParse({ ...box, goalCents: null, goalMonth: '2027-12' }))).toEqual(['goalCents']);
  });
  it('exige o campo do tipo de rendimento', () => {
    expect(paths(investmentCreateInput.safeParse({ ...box, cdiShareBp: null }))).toEqual(['cdiShareBp']);
    expect(paths(investmentCreateInput.safeParse({ ...box, yieldKind: 'fixed' }))).toEqual(['fixedRatePpm']);
    expect(investmentCreateInput.safeParse({ ...box, yieldKind: 'none', cdiShareBp: null }).success).toBe(true);
  });
  it('guardar por mês e valor inicial maiores que zero', () => {
    expect(paths(investmentCreateInput.safeParse({ ...box, monthlyPlanCents: 0, initialCents: 0 })).sort()).toEqual(['initialCents', 'monthlyPlanCents']);
  });
});

describe('contrato de movimentações', () => {
  it('imposto só no resgate e nunca maior que ele', () => {
    expect(investmentMovementInput.safeParse({ date: '2026-11-10', kind: 'withdrawal', amountCents: 10_000, taxCents: 500 }).success).toBe(true);
    expect(paths(investmentMovementInput.safeParse({ date: '2026-11-10', kind: 'withdrawal', amountCents: 10_000, taxCents: 20_000 }))).toEqual(['taxCents']);
    expect(paths(investmentMovementInput.safeParse({ date: '2026-11-10', kind: 'deposit', amountCents: 10_000, taxCents: 1 }))).toEqual(['taxCents']);
  });
  it('encerrar e CDI', () => {
    expect(investmentCloseInput.safeParse({ date: '2026-11-10' }).success).toBe(true);
    expect(investmentSettingsInput.safeParse({ cdiAnnualPpm: 149_000 }).success).toBe(true);
    expect(investmentSettingsInput.safeParse({ cdiAnnualPpm: 0 }).success).toBe(false);
  });
});
