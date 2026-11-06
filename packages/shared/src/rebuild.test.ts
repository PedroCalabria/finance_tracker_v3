import { describe, expect, it } from 'vitest';
import { paidTargets, type PaidTargetsInput } from './index';

const base = { typeChanged: false, toCredit: false } as const;
const run = (i: Partial<PaidTargetsInput> & Pick<PaidTargetsInput, 'fromForm' | 'paid' | 'to'>) => paidTargets({ ...base, ...i });
const single = (month: string) => ({ competenceMonth: month, installmentNumber: null });
const parcel = (n: number, month: string) => ({ competenceMonth: month, installmentNumber: n });

describe('edição estrutural: onde cada ocorrência paga vai parar', () => {
  it('sem pagamentos, qualquer mudança cabe (inclusive tipo e crédito)', () => {
    expect(paidTargets({ fromForm: 'single', typeChanged: true, toCredit: true, paid: [], to: { form: 'single' } })).toEqual({ ok: true, targets: [] });
  });

  it('única paga vira recorrente que começa no mesmo mês ou antes', () => {
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'recurring', startMonth: '2026-10', endMonth: null } })).toEqual({
      ok: true,
      targets: [{ installmentNumber: null, competenceMonth: '2026-10' }],
    });
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'recurring', startMonth: '2026-08', endMonth: null } }).ok).toBe(true);
  });

  it('recorrente que começa depois do mês pago é recusada, citando o mês', () => {
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'recurring', startMonth: '2026-11', endMonth: null } })).toEqual({
      ok: false,
      message: 'O mês pago de out/2026 ficaria antes do novo mês de início. Comece até out/2026 ou desfaça o pagamento.',
    });
  });

  it('recorrente → recorrente: cita o primeiro mês pago fora; respeita o fim', () => {
    const paid = [single('2026-11'), single('2026-09')];
    const r = run({ fromForm: 'recurring', paid, to: { form: 'recurring', startMonth: '2026-12', endMonth: null } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('set/2026') });
    expect(run({ fromForm: 'recurring', paid, to: { form: 'recurring', startMonth: '2026-09', endMonth: '2026-10' } })).toMatchObject({
      ok: false,
      message: 'O mês pago de nov/2026 ficaria depois do fim da recorrência. Desfaça o pagamento antes ou cadastre de novo.',
    });
  });

  it('devolve os destinos na mesma ordem dos pagamentos recebidos', () => {
    const r = run({ fromForm: 'recurring', paid: [single('2026-11'), single('2026-09')], to: { form: 'recurring', startMonth: '2026-08', endMonth: null } });
    expect(r).toEqual({
      ok: true,
      targets: [
        { installmentNumber: null, competenceMonth: '2026-11' },
        { installmentNumber: null, competenceMonth: '2026-09' },
      ],
    });
  });

  it('única paga vira parcelada: vai para a parcela do mesmo mês', () => {
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'installment', months: ['2026-10', '2026-11', '2026-12'] } })).toEqual({
      ok: true,
      targets: [{ installmentNumber: 1, competenceMonth: '2026-10' }],
    });
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'installment', months: ['2026-09', '2026-10', '2026-11'] } })).toEqual({
      ok: true,
      targets: [{ installmentNumber: 2, competenceMonth: '2026-10' }],
    });
  });

  it('sem parcela no mês pago, recusa', () => {
    expect(run({ fromForm: 'single', paid: [single('2026-10')], to: { form: 'installment', months: ['2026-11', '2026-12'] } })).toEqual({
      ok: false,
      message: 'O pagamento de out/2026 não teria parcela no mesmo mês. Ajuste a data da 1ª parcela ou desfaça o pagamento.',
    });
  });

  it('parcelada → parcelada: pelo número, mesmo que os meses mudem', () => {
    expect(run({ fromForm: 'installment', paid: [parcel(1, '2026-11')], to: { form: 'installment', months: ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04'] } })).toEqual({
      ok: true,
      targets: [{ installmentNumber: 1, competenceMonth: '2026-12' }],
    });
  });

  it('parcela paga que deixaria de existir é recusada', () => {
    expect(run({ fromForm: 'installment', paid: [parcel(4, '2027-02')], to: { form: 'installment', months: ['2026-11', '2026-12', '2027-01'] } })).toEqual({
      ok: false,
      message: 'A parcela 4 já foi paga e deixaria de existir. Mantenha pelo menos 4 parcelas ou desfaça o pagamento.',
    });
  });

  it('parcelada → recorrente: pelo mês, dentro do intervalo', () => {
    const paid = [parcel(1, '2026-10'), parcel(2, '2026-11')];
    expect(run({ fromForm: 'installment', paid, to: { form: 'recurring', startMonth: '2026-10', endMonth: null } }).ok).toBe(true);
    expect(run({ fromForm: 'installment', paid, to: { form: 'recurring', startMonth: '2026-11', endMonth: null } }).ok).toBe(false);
  });

  it('para única: um pagamento vira a única; dois não cabem', () => {
    expect(run({ fromForm: 'recurring', paid: [single('2026-10')], to: { form: 'single' } })).toEqual({ ok: true, targets: [{ installmentNumber: null, competenceMonth: null }] });
    expect(run({ fromForm: 'recurring', paid: [single('2026-10'), single('2026-11')], to: { form: 'single' } })).toEqual({
      ok: false,
      message: 'Este lançamento tem mais de um mês pago e não cabe numa compra única. Desfaça os pagamentos antes ou cadastre de novo.',
    });
  });

  it('dois pagamentos no mesmo destino são recusados', () => {
    // Parcelas movidas à mão para o mesmo mês, virando recorrente.
    expect(run({ fromForm: 'installment', paid: [parcel(1, '2026-10'), parcel(2, '2026-10')], to: { form: 'recurring', startMonth: '2026-10', endMonth: null } })).toEqual({
      ok: false,
      message: 'Dois pagamentos cairiam no mesmo mês. Desfaça um deles antes ou cadastre de novo.',
    });
  });

  it('troca de tipo ou passagem para o crédito com pagamento: recusa', () => {
    const to = { form: 'single' } as const;
    expect(paidTargets({ fromForm: 'single', typeChanged: true, toCredit: false, paid: [single('2026-10')], to })).toMatchObject({ ok: false, message: expect.stringContaining('despesa e entrada') });
    expect(paidTargets({ fromForm: 'single', typeChanged: false, toCredit: true, paid: [single('2026-10')], to })).toMatchObject({ ok: false, message: expect.stringContaining('fatura') });
  });
});
