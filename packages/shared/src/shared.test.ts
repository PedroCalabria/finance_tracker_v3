import { describe, expect, it } from 'vitest';
import {
  addMonths,
  addMonthsToDate,
  bankHolidays,
  dateInMonth,
  defaultInvoiceDates,
  diffMonths,
  easterSunday,
  formatBRL,
  formatMonthLong,
  invoiceMonthForPurchase,
  isBusinessDay,
  onOrBeforeBusinessDay,
  parseBRL,
  parseDateBR,
  reminderDays,
  splitInstallments,
  statusFromPayments,
  todayIn,
} from './index';

describe('dinheiro', () => {
  it('formata em reais', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });
  it('lê o que a pessoa digita', () => {
    expect(parseBRL('1.234,56')).toBe(123456);
    expect(parseBRL('R$ 12')).toBe(1200);
    expect(parseBRL('12,5')).toBe(1250);
    expect(parseBRL('12.50')).toBe(1250);
    expect(parseBRL('1.000')).toBe(100000);
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL('1,234')).toBeNull();
  });
  it('divide parcelas com o arredondamento na última', () => {
    expect(splitInstallments(10000, 3)).toEqual([3333, 3333, 3334]);
    expect(splitInstallments(90000, 2)).toEqual([45000, 45000]);
    expect(splitInstallments(100, 3).reduce((a, b) => a + b)).toBe(100);
  });
});

describe('datas', () => {
  it('soma meses atravessando o ano', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(diffMonths('2026-11', '2027-02')).toBe(3);
  });
  it('limita o dia ao fim do mês', () => {
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28');
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
  });
  it('lê datas no formato brasileiro', () => {
    expect(parseDateBR('05/11/2026')).toBe('2026-11-05');
    expect(parseDateBR('31/02/2026')).toBeNull();
  });
  it('escreve o mês por extenso', () => {
    expect(formatMonthLong('2026-11')).toBe('Novembro de 2026');
  });
  it('calcula a data civil no fuso', () => {
    expect(todayIn('America/Sao_Paulo', new Date('2026-11-04T02:00:00Z'))).toBe('2026-11-03');
  });
});

describe('calendário bancário', () => {
  it('calcula a Páscoa', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });
  it('inclui Carnaval e Sexta-feira Santa', () => {
    const h = bankHolidays(2026);
    expect(h.has('2026-02-16')).toBe(true);
    expect(h.has('2026-02-17')).toBe(true);
    expect(h.has('2026-04-03')).toBe(true);
    expect(h.has('2026-11-20')).toBe(true);
  });
  it('pula fim de semana e feriado', () => {
    expect(isBusinessDay('2026-11-14')).toBe(false); // sábado
    expect(onOrBeforeBusinessDay('2026-11-15')).toBe('2026-11-13'); // domingo e feriado → sexta
  });
  it('avisa no dia útil anterior', () => {
    // vencimento numa segunda: aviso antecipado na sexta
    expect(reminderDays('2026-11-09', 1)).toEqual({ onDay: '2026-11-09', before: '2026-11-06' });
    // vencimento no sábado: lembrete do dia vai para sexta, antecipado para quinta
    expect(reminderDays('2026-11-07', 1)).toEqual({ onDay: '2026-11-06', before: '2026-11-05' });
  });
});

describe('faturas', () => {
  it('fecha no mesmo mês quando o fechamento vem antes do vencimento', () => {
    expect(defaultInvoiceDates('2026-11', 1, 8)).toEqual({ closingDate: '2026-11-01', dueDate: '2026-11-08' });
  });
  it('fecha no mês anterior quando o fechamento é depois do dia de vencimento', () => {
    expect(defaultInvoiceDates('2026-11', 25, 1)).toEqual({ closingDate: '2026-10-25', dueDate: '2026-11-01' });
  });
  it('compra antes do fechamento entra na fatura que fecha', () => {
    expect(invoiceMonthForPurchase('2026-10-31', 1, 8)).toBe('2026-11');
  });
  it('compra no dia do fechamento vai para a seguinte', () => {
    expect(invoiceMonthForPurchase('2026-11-01', 1, 8)).toBe('2026-12');
    expect(invoiceMonthForPurchase('2026-11-03', 1, 8)).toBe('2026-12');
    expect(invoiceMonthForPurchase('2026-11-25', 25, 1)).toBe('2027-01');
    expect(invoiceMonthForPurchase('2026-11-24', 25, 1)).toBe('2026-12');
  });
  it('respeita datas ajustadas no mês', () => {
    const overrides = new Map([['2026-12', { closingDate: '2026-11-28', dueDate: '2026-12-08' }]]);
    expect(invoiceMonthForPurchase('2026-11-27', 1, 8, overrides)).toBe('2026-12');
  });
});

describe('status', () => {
  it('deriva do total pago', () => {
    expect(statusFromPayments(45000, 0, false)).toBe('pending');
    expect(statusFromPayments(45000, 20000, false)).toBe('partial');
    expect(statusFromPayments(45000, 40000, true)).toBe('paid');
    expect(statusFromPayments(45000, 46000, false)).toBe('paid');
  });
});
