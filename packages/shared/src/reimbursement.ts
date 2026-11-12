import { dateInMonth, type ISODate, type Month } from './dates';
import type { ItemForm, Method } from './domain';
import type { ItemCreateInput } from './schemas';

/**
 * Entrada de reembolso de uma despesa de outra pessoa (ADR-0004). Regra pura: o
 * servidor completa a categoria ("Gasto de terceiros") e grava o vínculo.
 *
 * As datas caem no mesmo mês do gasto (`charge_month`), para o balanço do mês zerar
 * para aquele gasto: fora do crédito, as datas da despesa; no crédito, o dia da compra
 * (ou da cobrança, na recorrente) no mês do gasto da 1ª cobrança, não o vencimento da fatura.
 */

/** O que importa da despesa recém-cadastrada (o mesmo contrato do cadastro). */
export interface ReimbursedExpense {
  form: ItemForm;
  method: Method;
  description: string;
  amountCents: number;
  installments?: number | null;
  variableAmount?: boolean;
  accountId?: string | null;
  personId?: string | null;
  date?: ISODate | null;
  dueDate?: ISODate | null;
  startMonth?: Month | null;
  day?: number | null;
  /** No crédito: mês do gasto da 1ª cobrança (o da fatura dela, ADR-0005). Sem ele, o mês da compra. */
  chargeMonth?: Month | null;
}

export type ReimbursementInput = Omit<ItemCreateInput, 'categoryId' | 'alreadyPaid' | 'pastInstallmentsPaid' | 'createReimbursement' | 'note'>;

export function reimbursementInput(expense: ReimbursedExpense): ReimbursementInput {
  const credit = expense.method === 'credit';
  // No crédito, o mesmo dia no mês do gasto (compra de 30/10 que conta em novembro: 30/11).
  const inChargeMonth = (date: ISODate) => (credit && expense.chargeMonth ? dateInMonth(expense.chargeMonth, Number(date.slice(8, 10))) : date);
  const base = {
    type: 'income' as const,
    form: expense.form,
    description: expense.description,
    amountCents: expense.amountCents,
    method: 'pix' as const,
    accountId: credit ? null : (expense.accountId ?? null),
    personId: expense.personId ?? null,
  };
  if (expense.form === 'recurring') {
    // No crédito, `day` é o dia da cobrança; fora dele, o do pagamento (obrigatório com reembolso).
    const startMonth = credit && expense.chargeMonth ? expense.chargeMonth : expense.startMonth!;
    return { ...base, variableAmount: !!expense.variableAmount, startMonth, day: expense.day! };
  }
  if (expense.form === 'installment') return { ...base, installments: expense.installments!, date: inChargeMonth(expense.date!) };
  // Única: nas entradas, a própria data é a do recebimento (e vai também como `dueDate`).
  // No crédito, o dia da compra no mês do gasto; fora dele, a data p/ pagamento ou, sem ela, a data.
  const receipt = credit ? inChargeMonth(expense.date!) : (expense.dueDate ?? expense.date!);
  return { ...base, date: receipt, dueDate: receipt };
}
