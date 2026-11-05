import { addMonthsToDate, dateInMonth, type ISODate, type Month } from './dates';
import type { Method } from './domain';

/**
 * Datas de recorrentes e parceladas (ADR-0004), a partir do que a pessoa
 * preenche no cadastro: a recorrente tem mês de início e dia; a parcelada fora
 * do crédito tem a data p/ pagamento da 1ª parcela.
 */

export interface RecurringRule {
  startMonth: Month;
  /** Dia p/ pagamento ou recebimento de cada mês (fora do crédito). Nulo = sem data, sem lembrete. */
  dueDay: number | null;
  /** No crédito, o dia desta data é o dia da cobrança (define a fatura de cada mês). */
  entryDate: ISODate;
}

/**
 * Regra de uma recorrente. Fora do crédito o dia é o do pagamento (ou do
 * recebimento); no crédito é o da cobrança e fica só na `entryDate`. Dia 31 em
 * meses curtos vira o último dia (na hora de calcular cada mês).
 */
export function recurringRule(input: { method: Method; startMonth: Month; day: number | null | undefined }): RecurringRule {
  const day = input.day ?? null;
  const credit = input.method === 'credit';
  return {
    startMonth: input.startMonth,
    dueDay: credit ? null : day,
    entryDate: dateInMonth(input.startMonth, day ?? 1),
  };
}

/** Datas p/ pagamento das N parcelas fora do crédito: mesmo dia nos meses seguintes (31 → último dia). */
export function installmentDueDates(firstDue: ISODate, n: number): ISODate[] {
  return Array.from({ length: n }, (_, k) => addMonthsToDate(firstDue, k));
}

/** Data da 1ª parcela a partir da data de uma parcela na posição `position` (1 = a primeira). */
export function firstInstallmentDue(thisDue: ISODate, position: number): ISODate {
  return addMonthsToDate(thisDue, -(Math.max(1, position) - 1));
}
