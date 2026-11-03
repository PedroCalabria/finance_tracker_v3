import type { ISODate, Month } from './dates';
import type { AccountKind, DisplayStatus, InvoiceStatus, ItemForm, ItemType, Method, OccurrenceStatus, SystemKind } from './domain';

/** Formas das respostas da API (ADR-0002). */

export interface Me {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  timezone: string;
  wallets: Array<{ id: string; name: string; kind: 'personal' | 'shared'; role: 'owner' | 'editor' }>;
}

export interface Category {
  id: string;
  name: string;
  type: ItemType;
  archived: boolean;
}

export interface Account {
  id: string;
  name: string;
  bank: string;
  kind: AccountKind;
  closingDay: number | null;
  dueDay: number | null;
  archived: boolean;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

export interface PaymentRow {
  id: string;
  paidAt: ISODate;
  amountCents: number;
  groupId: string;
  paidBy: string | null;
  attachments: AttachmentRef[];
}

export interface OccurrenceRow {
  /** Projeções de recorrentes ainda não gravadas têm id "p_<itemId>_<YYYY-MM>". */
  id: string;
  projected: boolean;
  itemId: string;
  type: ItemType;
  form: ItemForm;
  systemKind: SystemKind | null;
  description: string;
  category: { id: string; name: string } | null;
  method: Method;
  account: { id: string; name: string; bank: string; kind: AccountKind } | null;
  competenceMonth: Month;
  installmentNumber: number | null;
  installmentsTotal: number | null;
  /** "Única", "Recorrente" ou "3/5". */
  installmentLabel: string;
  expectedCents: number;
  paidCents: number;
  remainingCents: number;
  dueDate: ISODate | null;
  status: OccurrenceStatus;
  displayStatus: DisplayStatus;
  /** De um mês anterior ao atual e ainda em aberto. */
  late: boolean;
  settledWithDiscount: boolean;
  note: string | null;
  payments: PaymentRow[];
  invoice: { id: string; referenceMonth: Month; status: InvoiceStatus; dueDate: ISODate } | null;
  variableAmount: boolean;
  version: number;
}

export interface ItemDetail {
  id: string;
  type: ItemType;
  form: ItemForm;
  description: string;
  method: Method;
  totalCents: number | null;
  installments: number | null;
  amountCents: number | null;
  variableAmount: boolean;
  dueDay: number | null;
  startMonth: Month;
  endMonth: Month | null;
  occurrences: OccurrenceRow[];
}

export interface Summary {
  month: Month;
  isCurrentMonth: boolean;
  income: { receivedCents: number; pendingCents: number; lateCents: number };
  expense: { paidCents: number; pendingCents: number; lateCents: number };
  balance: { realizedCents: number; forecastCents: number };
}

export interface InvoiceRow {
  id: string;
  account: { id: string; name: string; bank: string };
  referenceMonth: Month;
  closingDate: ISODate;
  dueDate: ISODate;
  status: InvoiceStatus;
  /** Calculado: em aberto com vencimento passado. */
  late: boolean;
  itemsCents: number;
  realAmountCents: number | null;
  totalCents: number;
  paidCents: number;
  itemCount: number;
  payments: Array<{ id: string; paidAt: ISODate; amountCents: number; attachments: AttachmentRef[] }>;
  carriedToMonth: Month | null;
}

export interface MonthsRange {
  currentMonth: Month;
  firstMonth: Month;
  lastMonth: Month;
}

export interface InvoicePreview {
  referenceMonth: Month;
  closingDate: ISODate;
  dueDate: ISODate;
}

export interface NotificationSettings {
  enabled: boolean;
  sendHour: number;
  leadBusinessDays: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
