import { z } from 'zod';
import type { DisplayStatus, ItemForm, ItemType, Method } from '../domain';
import { METHODS } from '../domain';
import type { ISODate, Month } from '../dates';
import type { ImportLine, ReadWarning } from './types';

/** Contratos da importação (ADR-0010, D12), validados nos dois lados. */

const uuid = z.string().uuid();
/** Token assinado da prévia (base64url + HMAC). */
const token = z.string().min(20).max(3_000_000);

export const importSuggestInput = z.object({ token, accountId: uuid });

export const IMPORT_ACTIONS = ['match', 'create', 'invoice_payment', 'ignore'] as const;
export type ImportDecisionAction = (typeof IMPORT_ACTIONS)[number];

export const importDecision = z
  .object({
    index: z.number().int().min(0),
    action: z.enum(IMPORT_ACTIONS),
    /** match: ocorrência (pode ser projeção "p_<itemId>_<mês>"). */
    occurrenceId: z.string().min(1).max(80).optional(),
    /** invoice_payment: fatura paga pela linha. */
    invoiceId: uuid.optional(),
    /** invoice_payment: valor real da fatura (a diferença vira o ajuste). */
    realAmountCents: z.number().int().min(0).optional(),
    create: z
      .object({
        description: z.string().trim().min(1, 'Informe a descrição.').max(120),
        categoryId: uuid.nullish(),
        method: z.enum(METHODS).optional(),
      })
      .optional(),
    /** Recorrente fixa com valor maior: só este mês ou daqui em diante. */
    amountScope: z.enum(['occurrence', 'forward']).optional(),
    /** Valor menor que o restante: desconto ou parcial. */
    settlement: z.enum(['discount', 'partial']).optional(),
  })
  .refine((d) => d.action !== 'match' || !!d.occurrenceId, { message: 'Escolha o lançamento.', path: ['occurrenceId'] })
  .refine((d) => d.action !== 'invoice_payment' || !!d.invoiceId, { message: 'Escolha a fatura.', path: ['invoiceId'] })
  .refine((d) => d.action !== 'create' || !!d.create, { message: 'Informe a descrição.', path: ['create'] });

export const importConfirmInput = z.object({
  token,
  accountId: uuid,
  decisions: z.array(importDecision).max(5000),
  /** Fatura importada: usar as datas do banco e gravar o valor real. */
  invoice: z.object({ useBankDates: z.boolean(), realAmountCents: z.number().int().min(0) }).optional(),
});

export type ImportDecision = z.infer<typeof importDecision>;
export type ImportConfirmInput = z.infer<typeof importConfirmInput>;

// ---------- Respostas

export type ImportAction = ImportDecisionAction | 'already';
export type ImportQuestion = 'amount_scope' | 'settlement';

export type ImportTarget =
  | {
      kind: 'occurrence';
      occurrenceId: string;
      itemId: string;
      description: string;
      type: ItemType;
      form: ItemForm;
      competenceMonth: Month;
      installmentLabel: string;
      expectedCents: number;
      remainingCents: number;
      dueDate: ISODate | null;
      displayStatus: DisplayStatus;
      variableAmount: boolean;
      projected: boolean;
      /** Já pago no app: a linha só será vinculada a este pagamento. */
      alreadyPaid: { paymentId: string; paidAt: ISODate; amountCents: number } | null;
    }
  | {
      kind: 'invoice';
      invoiceId: string;
      accountName: string;
      bank: string;
      referenceMonth: Month;
      dueDate: ISODate;
      totalCents: number;
      paidCents: number;
      realAmountCents: number | null;
      status: 'open' | 'paid' | 'carried';
      /** Já paga com este valor perto da data: a linha só será vinculada. */
      alreadyPaid: { paymentId: string; paidAt: ISODate; amountCents: number } | null;
    };

export interface ImportSuggestion {
  action: ImportAction;
  target: ImportTarget | null;
  alternatives: ImportTarget[];
  questions: ImportQuestion[];
  warnings: string[];
  create: { description: string; method: Method; type: ItemType; categoryId: string | null };
}

export interface ImportLineView extends ImportLine {
  suggestion: ImportSuggestion;
}

export interface ImportInvoiceInfo {
  id: string | null;
  referenceMonth: Month;
  status: 'open' | 'paid' | 'carried';
  appClosingDate: ISODate | null;
  appDueDate: ISODate | null;
  bankClosingDate: ISODate | null;
  bankDueDate: ISODate;
  bankTotalCents: number;
  itemsCents: number;
}

export interface ImportSuggestions {
  accountId: string;
  kind: 'statement' | 'invoice';
  lines: ImportLineView[];
  /** No app, mas não no arquivo: pagamentos (extrato) ou itens (fatura). */
  unmatchedApp: Array<{ occurrenceId: string; description: string; date: ISODate | null; amountCents: number; paidAt: ISODate | null }>;
  invoice: ImportInvoiceInfo | null;
  /** Faturas que uma linha pode pagar (extrato). */
  invoiceTargets: ImportTarget[];
}

export interface ImportDestination {
  id: string;
  name: string;
  bank: string;
  kind: 'account' | 'credit_card';
}

export interface ImportPreview {
  token: string;
  source: { readerId: string; bank: string; kind: 'statement' | 'invoice'; label: string };
  header: {
    periodStart: ISODate | null;
    periodEnd: ISODate | null;
    accountLabel: string | null;
    invoice: { dueDate: ISODate; closingDate: ISODate | null; totalCents: number } | null;
  };
  lineCount: number;
  warnings: ReadWarning[];
  destinations: { options: ImportDestination[]; suggestedAccountId: string | null };
  suggestions: ImportSuggestions | null;
}

export interface ImportConfirmResult {
  batchId: string;
  counts: { paid: number; linked: number; created: number; invoicePaid: number; ignored: number; already: number };
  months: Month[];
}

/**
 * Perguntas que a linha exige ao casar com um lançamento (ADR-0010): valor menor
 * que o restante pede desconto ou parcial; recorrente fixa mais cara pergunta se
 * vale só este mês ou daqui em diante. Variável e "já pago" não perguntam nada.
 */
export function importQuestions(amountCents: number, t: ImportTarget | null): ImportQuestion[] {
  if (!t || t.kind !== 'occurrence' || t.alreadyPaid) return [];
  if (t.form === 'recurring' && t.variableAmount) return [];
  if (amountCents < t.remainingCents) return ['settlement'];
  if (amountCents > t.remainingCents && t.form === 'recurring') return ['amount_scope'];
  return [];
}
