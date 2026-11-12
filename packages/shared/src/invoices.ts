import { addDays, addMonths, compareDates, dateInMonth, daysBetween, type ISODate, type Month, monthOf } from './dates';

/**
 * Regras de fatura (ADR-0005). Uma fatura é identificada pelo mês do VENCIMENTO
 * (reference month). O fechamento é o último dia de fechamento antes do vencimento.
 */

export interface InvoiceDates {
  closingDate: ISODate;
  dueDate: ISODate;
}

export function defaultInvoiceDates(referenceMonth: Month, closingDay: number, dueDay: number): InvoiceDates {
  const dueDate = dateInMonth(referenceMonth, dueDay);
  let closingDate = dateInMonth(referenceMonth, closingDay);
  if (compareDates(closingDate, dueDate) >= 0) closingDate = dateInMonth(addMonths(referenceMonth, -1), closingDay);
  return { closingDate, dueDate };
}

/**
 * Em qual fatura cai uma compra no crédito. Compra feita ANTES do fechamento
 * entra na fatura que fecha; a partir do dia do fechamento, vai para a seguinte.
 * `overrides` traz datas ajustadas manualmente por mês de referência.
 */
export function invoiceMonthForPurchase(
  purchaseDate: ISODate,
  closingDay: number,
  dueDay: number,
  overrides: ReadonlyMap<Month, InvoiceDates> = new Map(),
): Month {
  let month = monthOf(purchaseDate);
  for (let i = 0; i < 3; i++) {
    const dates = overrides.get(month) ?? defaultInvoiceDates(month, closingDay, dueDay);
    if (compareDates(purchaseDate, dates.closingDate) < 0) return month;
    month = addMonths(month, 1);
  }
  return month;
}

/**
 * Mês do gasto (`charge_month`) das compras de uma fatura (ADR-0005): o mês em que cai a
 * maior parte do período de compras dela, do fechamento da anterior até a véspera do seu.
 * Fecha dia 28: compras de 28/10 a 27/11 contam como novembro. Fecha dia 3: compras de
 * 03/10 a 02/11 contam como outubro. Empate (metade em cada mês): o primeiro.
 */
export function invoiceChargeMonth(
  referenceMonth: Month,
  closingDay: number,
  dueDay: number,
  overrides: ReadonlyMap<Month, InvoiceDates> = new Map(),
): Month {
  const closing = (m: Month) => (overrides.get(m) ?? defaultInvoiceDates(m, closingDay, dueDay)).closingDate;
  const from = closing(addMonths(referenceMonth, -1));
  const days = daysBetween(from, closing(referenceMonth));
  return monthOf(addDays(from, Math.max(0, Math.floor((days - 1) / 2))));
}
