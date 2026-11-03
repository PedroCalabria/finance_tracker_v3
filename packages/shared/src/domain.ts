/** Vocabulário do domínio compartilhado entre API e interface (ADR-0004). */

export const ITEM_TYPES = ['expense', 'income'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_FORMS = ['single', 'installment', 'recurring'] as const;
export type ItemForm = (typeof ITEM_FORMS)[number];

/** Crédito só vale para despesas. Transferência e dinheiro existem para entradas e mesadas (ADR-0004). */
export const METHODS = ['credit', 'debit', 'pix', 'boleto', 'transfer', 'cash'] as const;
export type Method = (typeof METHODS)[number];

export const METHOD_LABEL: Record<Method, string> = {
  credit: 'Crédito',
  debit: 'Débito',
  pix: 'Pix',
  boleto: 'Boleto',
  transfer: 'Transferência',
  cash: 'Dinheiro',
};

export const ACCOUNT_KINDS = ['account', 'credit_card'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Status gravado de uma ocorrência fora do crédito. */
export const OCCURRENCE_STATUSES = ['pending', 'partial', 'paid', 'canceled'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Status de fatura gravado. `carried` = parcialmente paga, saldo transferido. */
export const INVOICE_STATUSES = ['open', 'paid', 'carried'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Status exibido (selo). Inclui os calculados: atrasado e os herdados da fatura. */
export type DisplayStatus =
  | 'pending'
  | 'partial'
  | 'paid'
  | 'canceled'
  | 'late'
  | 'invoice_open'
  | 'invoice_late'
  | 'invoice_paid'
  | 'invoice_carried';

export const SYSTEM_KINDS = ['invoice_adjustment', 'invoice_carryover'] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

/** Status gravado a partir do total pago (fora do crédito). */
export function statusFromPayments(expectedCents: number, paidCents: number, settledWithDiscount: boolean): OccurrenceStatus {
  if (paidCents <= 0) return 'pending';
  if (paidCents >= expectedCents || settledWithDiscount) return 'paid';
  return 'partial';
}

/** Restante em aberto de uma ocorrência (0 se quitada, inclusive com desconto). */
export function remainingCents(expectedCents: number, paidCents: number, status: OccurrenceStatus): number {
  if (status === 'paid' || status === 'canceled') return 0;
  return Math.max(0, expectedCents - paidCents);
}
