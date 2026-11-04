import { z } from 'zod';
import { isISODate, isMonth } from './dates';
import { ACCOUNT_KINDS, ITEM_FORMS, ITEM_TYPES, METHODS } from './domain';

/** Contratos de entrada da API, validados nos dois lados (ADR-0002). */

export const isoDate = z.string().refine(isISODate, 'Data inválida.');
export const month = z.string().refine(isMonth, 'Mês inválido.');
const cents = z.number().int().safe();
const positiveCents = cents.positive('O valor precisa ser maior que zero.');
const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email('Email inválido.').max(254);
const password = z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.').max(200);

export const registerInput = z.object({ name: z.string().trim().min(1, 'Informe seu nome.').max(120), email, password });
export const loginInput = z.object({ email, password: z.string().min(1).max(200) });
export const emailOnlyInput = z.object({ email });
export const tokenInput = z.object({ token: z.string().min(16).max(200) });
export const resetPasswordInput = z.object({ token: z.string().min(16).max(200), password });

export const categoryInput = z.object({ name: z.string().trim().min(1, 'Informe o nome.').max(60), type: z.enum(ITEM_TYPES) });
export const categoryUpdate = z.object({ name: z.string().trim().min(1).max(60) });

const day = z.number().int().min(1).max(31);
export const accountInput = z
  .object({
    name: z.string().trim().min(1, 'Informe o nome.').max(60),
    bank: z.string().trim().min(1, 'Informe o banco.').max(60),
    kind: z.enum(ACCOUNT_KINDS),
    closingDay: day.nullish(),
    dueDay: day.nullish(),
  })
  .refine((a) => a.kind !== 'credit_card' || (a.closingDay != null && a.dueDay != null), {
    message: 'Cartões precisam de dia de fechamento e de vencimento.',
    path: ['closingDay'],
  });
export const accountUpdate = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  bank: z.string().trim().min(1).max(60).optional(),
  closingDay: day.optional(),
  dueDay: day.optional(),
});

export const itemCreateInput = z
  .object({
    type: z.enum(ITEM_TYPES),
    form: z.enum(ITEM_FORMS),
    description: z.string().trim().min(1, 'Informe o serviço.').max(120),
    categoryId: uuid.nullish(),
    method: z.enum(METHODS),
    accountId: uuid.nullish(),
    /** Única e recorrente: valor do mês. Parcelada: valor TOTAL. */
    amountCents: positiveCents,
    installments: z.number().int().min(2).max(120).nullish(),
    variableAmount: z.boolean().optional(),
    /** "Data" obrigatória do cadastro (compra ou lançamento). */
    date: isoDate,
    /** "Data p/ pagamento", opcional. Ignorada no crédito (vem da fatura). */
    dueDate: isoDate.nullish(),
    alreadyPaid: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((i) => i.form !== 'installment' || (i.installments ?? 0) >= 2, { message: 'Informe o número de parcelas.', path: ['installments'] })
  .refine((i) => i.method !== 'credit' || i.type === 'expense', { message: 'Crédito só vale para despesas.', path: ['method'] })
  .refine((i) => i.method !== 'credit' || !!i.accountId, { message: 'Escolha o cartão.', path: ['accountId'] });

export const itemUpdateInput = z.object({
  description: z.string().trim().min(1).max(120).optional(),
  categoryId: uuid.nullable().optional(),
  accountId: uuid.nullable().optional(),
  /** Recorrente: novo valor a partir de `fromMonth`. */
  amountCents: positiveCents.optional(),
  variableAmount: z.boolean().optional(),
  dueDay: day.nullable().optional(),
  fromMonth: month.optional(),
});

/**
 * Edição completa a partir de uma linha da tabela (ADR-0004). Os campos têm o
 * sentido do cadastro, exceto os "deste mês": `dueDate`, `note` e
 * `occurrenceCents` valem para a ocorrência `occurrenceId`.
 */
export const itemEditInput = z
  .object({
    /** Linha aberta pela pessoa (pode ser projeção "p_<itemId>_<mês>"). */
    occurrenceId: z.string().min(1).max(80),
    type: z.enum(ITEM_TYPES),
    form: z.enum(ITEM_FORMS),
    description: z.string().trim().min(1, 'Informe o serviço.').max(120),
    categoryId: uuid.nullish(),
    method: z.enum(METHODS),
    accountId: uuid.nullish(),
    /** Única: valor. Recorrente: valor deste mês em diante. Parcelada: valor TOTAL. */
    amountCents: positiveCents,
    installments: z.number().int().min(2).max(120).nullish(),
    /** Parcelada: valor desta parcela (ignorado se o total ou o número de parcelas mudar). */
    occurrenceCents: positiveCents.optional(),
    variableAmount: z.boolean().optional(),
    date: isoDate,
    /** Data p/ pagamento DESTE mês. Ignorada no crédito. */
    dueDate: isoDate.nullish(),
    note: z.string().trim().max(500).nullish(),
    version: z.number().int().optional(),
  })
  .refine((i) => i.form !== 'installment' || (i.installments ?? 0) >= 2, { message: 'Informe o número de parcelas.', path: ['installments'] })
  .refine((i) => i.method !== 'credit' || i.type === 'expense', { message: 'Crédito só vale para despesas.', path: ['method'] })
  .refine((i) => i.method !== 'credit' || !!i.accountId, { message: 'Escolha o cartão.', path: ['accountId'] });

export const itemEndInput = z.object({ lastMonth: month });

export const occurrenceUpdateInput = z.object({
  expectedCents: positiveCents.optional(),
  dueDate: isoDate.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  version: z.number().int().optional(),
});

export const paymentInput = z.object({
  paidAt: isoDate,
  amountCents: positiveCents,
  /** Só quando o valor é menor que o restante: quitado com desconto ou parcial. */
  settlement: z.enum(['discount', 'partial']).optional(),
  /** Pagar também as próximas N parcelas (parceladas). */
  payNext: z.number().int().min(0).max(119).optional(),
  attachmentIds: z.array(uuid).max(5).optional(),
});

export const paymentUpdateInput = z.object({ paidAt: isoDate.optional(), amountCents: positiveCents.optional() });

export const invoicePaymentInput = z.object({
  realAmountCents: cents,
  amountCents: positiveCents,
  paidAt: isoDate,
  attachmentIds: z.array(uuid).max(5).optional(),
});

export const invoiceUpdateInput = z.object({ closingDate: isoDate, dueDate: isoDate });
export const moveInvoiceInput = z.object({ referenceMonth: month });

export const notificationSettingsInput = z.object({
  enabled: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  leadBusinessDays: z.number().int().min(0).max(5),
});

export const occurrencesQuery = z.object({
  month,
  type: z.enum(ITEM_TYPES).default('expense'),
  recurring: z.coerce.boolean().optional(),
  onlyOpen: z.coerce.boolean().optional(),
  categoryId: uuid.optional(),
  accountId: uuid.optional(),
});

export type RegisterInput = z.infer<typeof registerInput>;
export type CategoryInput = z.infer<typeof categoryInput>;
export type AccountInput = z.infer<typeof accountInput>;
export type ItemCreateInput = z.infer<typeof itemCreateInput>;
export type ItemUpdateInput = z.infer<typeof itemUpdateInput>;
export type ItemEditInput = z.infer<typeof itemEditInput>;
export type OccurrenceUpdateInput = z.infer<typeof occurrenceUpdateInput>;
export type PaymentInput = z.infer<typeof paymentInput>;
export type InvoicePaymentInput = z.infer<typeof invoicePaymentInput>;
export type NotificationSettingsInput = z.infer<typeof notificationSettingsInput>;
