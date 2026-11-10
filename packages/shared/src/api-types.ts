import type { ISODate, Month } from './dates';
import type { AccountKind, DisplayStatus, InvoiceStatus, ItemForm, ItemType, Method, OccurrenceStatus, SystemKind } from './domain';
import type { StrategySummary } from './debts/compare';
import type { DebtWarning } from './debts/simulate';
import type { DebtCategory, DebtPaymentKind, DebtStrategy, DebtStructure, ExtraEffect, MinPaymentKind } from './debts/types';
import type { GoalProjection, RedeemProjection, SeriesPoint } from './investments/project';
import type { TaxBracketRow } from './investments/taxes';
import type { InvestmentIcon, InvestmentKind, MovementKind, TaxMode, YieldKind } from './investments/types';

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

export interface Person {
  id: string;
  name: string;
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
  /** Responsável; nulo = "Eu". */
  person: { id: string; name: string } | null;
  method: Method;
  account: { id: string; name: string; bank: string; kind: AccountKind } | null;
  /** Mês da ocorrência; no crédito, o mês da fatura. */
  competenceMonth: Month;
  /** Mês do gasto: no crédito, o mês da compra ou da cobrança; fora dele, igual a `competenceMonth`. */
  chargeMonth: Month;
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
  /** "Data" do cadastro (compra ou lançamento). */
  entryDate: ISODate;
  categoryId: string | null;
  accountId: string | null;
  /** Responsável; nulo = "Eu". */
  person: { id: string; name: string } | null;
  /** Despesa: a entrada de reembolso vinculada (enquanto não excluída). */
  reimbursement: { id: string; description: string } | null;
  /** Entrada de reembolso: a despesa que a gerou (enquanto não excluída). */
  reimburses: { id: string; description: string } | null;
  startMonth: Month;
  endMonth: Month | null;
  occurrences: OccurrenceRow[];
}

export interface Summary {
  month: Month;
  isCurrentMonth: boolean;
  /** `forecastCents` = recebido + a receber (o previsto do mês). */
  income: { receivedCents: number; pendingCents: number; lateCents: number; forecastCents: number };
  /** `forecastCents` = pago + a pagar (o previsto do mês). */
  expense: { paidCents: number; pendingCents: number; lateCents: number; forecastCents: number };
  /**
   * `forecastCents` = entradas − gastos − guardar em caixinhas (previsto) + resgatado − amortizar dívidas (previsto).
   * `realizedCents` = caixa, também com os aportes, resgates e amortizações extras feitos (ADR-0012).
   */
  balance: { realizedCents: number; forecastCents: number };
  /**
   * Caixinhas no mês. `plannedCents` é null em meses passados; previsto = realizado nos passados e
   * max(planejado, aportado) no atual e nos futuros. O valor inicial da caixinha fica fora.
   */
  investments: { plannedCents: number | null; depositedCents: number; forecastCents: number; withdrawnCents: number };
  /** Amortização extra de dívidas (as parcelas obrigatórias já estão nos gastos). Mesma regra do previsto. */
  debtExtra: { plannedCents: number | null; paidCents: number; forecastCents: number };
}

export interface InvoiceRow {
  id: string;
  account: { id: string; name: string; bank: string };
  referenceMonth: Month;
  closingDate: ISODate;
  dueDate: ISODate;
  /** Período das compras desta fatura: do fechamento da anterior até a véspera do fechamento desta. */
  purchasesFrom: ISODate;
  purchasesTo: ISODate;
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

/* ---------- Dívidas (ADR-0011) ---------- */

export interface DebtRow {
  id: string;
  name: string;
  category: DebtCategory;
  creditorName: string | null;
  /** Credor que é uma Pessoa da carteira. */
  creditorPerson: { id: string; name: string } | null;
  structure: DebtStructure;
  monthlyRatePpm: number;
  installmentCents: number | null;
  /** Parcelas restantes hoje (contrato − pagamentos de parcela depois de `contractAsOf`). */
  remainingInstallments: number | null;
  /** Parcelas restantes como gravadas no contrato, em `contractAsOf`. */
  contractRemainingInstallments: number | null;
  contractAsOf: ISODate;
  dueDay: number | null;
  minPaymentKind: MinPaymentKind | null;
  minPaymentValue: number | null;
  acceptsExtra: boolean;
  status: 'active' | 'paid_off';
  paidOffOn: ISODate | null;
  position: number | null;
  version: number;
  createdAt: string;
  /** Saldo estimado hoje. */
  balanceCents: number;
  initial: { date: ISODate; balanceCents: number };
  anchor: { date: ISODate; balanceCents: number };
  /** Soma de todos os pagamentos registrados. */
  paidCents: number;
}

export interface DebtAnchorRow {
  id: string;
  date: ISODate;
  balanceCents: number;
}

export interface DebtPaymentRow {
  id: string;
  date: ISODate;
  amountCents: number;
  kind: DebtPaymentKind;
  extraEffect: ExtraEffect | null;
  version: number;
  /** Data ≤ a da âncora vigente: já considerado no saldo informado. */
  beforeAnchor: boolean;
}

export interface DebtDetail extends DebtRow {
  anchors: DebtAnchorRow[];
  payments: DebtPaymentRow[];
}

export interface DebtBudgetRow {
  fromMonth: Month;
  amountCents: number;
}

export interface DebtSettings {
  strategy: DebtStrategy;
  manualOrderSet: boolean;
}

export interface DebtMonthBudget {
  month: Month;
  plannedCents: number | null;
  spentCents: number;
  inProgress: boolean;
}

export interface DebtPlan {
  currentMonth: Month;
  strategy: DebtStrategy;
  manualOrderSet: boolean;
  /** Ids das dívidas ativas na ordem da estratégia. */
  order: string[];
  totals: { balanceCents: number; payoffMonth: Month | null; interestCents: number; budgetCents: number | null };
  perDebt: Array<{ id: string; payoffMonth: Month | null; interestCents: number; timeline: number[] }>;
  comparison: StrategySummary[];
  warnings: DebtWarning[];
  budgetMonths: DebtMonthBudget[];
}

/* ---------- Investimentos em caixinhas (ADR-0012) ---------- */

export interface InvestmentSettings {
  /** CDI anual em milionésimos (14,90% a.a. = 149000); null enquanto a pessoa não informa. */
  cdiAnnualPpm: number | null;
  cdiUpdatedOn: ISODate | null;
}

export interface InvestmentRow {
  id: string;
  name: string;
  icon: InvestmentIcon;
  kind: InvestmentKind;
  yieldKind: YieldKind;
  fixedRatePpm: number | null;
  cdiShareBp: number | null;
  redeemableFrom: ISODate | null;
  taxMode: TaxMode;
  goalCents: number | null;
  goalMonth: Month | null;
  monthlyPlanCents: number | null;
  status: 'active' | 'closed';
  closedOn: ISODate | null;
  version: number;
  createdAt: string;
  /** Taxa mensal usada na estimativa (com o CDI de hoje). */
  effectiveRatePpm: number;
  /** Saldo bruto estimado hoje. */
  grossCents: number;
  /** Aportado líquido (principal que resta). */
  principalCents: number;
  /** Bruto − principal (pode ser negativo). */
  yieldCents: number;
  /** IR + IOF se resgatar tudo hoje. */
  taxTodayCents: number;
  netTodayCents: number;
  /** Rendimento aproximado do próximo mês. */
  monthlyYieldCents: number;
  /** Âncora vigente (saldo informado). */
  anchor: { date: ISODate; balanceCents: number } | null;
  initial: { date: ISODate; amountCents: number };
  goal: GoalProjection | null;
  /** Projeção na data de "resgate a partir de" (só quando ela é futura). */
  atRedeem: RedeemProjection | null;
  /** Antes de "resgate a partir de": resgatar e encerrar são recusados. */
  locked: boolean;
  /** Aportado no mês atual (sem o valor inicial). */
  depositedThisMonthCents: number;
}

export interface InvestmentMovementRow {
  id: string;
  date: ISODate;
  kind: MovementKind;
  amountCents: number;
  taxCents: number | null;
  version: number;
  /** Data ≤ a da âncora vigente: já considerado no saldo informado. */
  beforeAnchor: boolean;
}

export interface InvestmentAnchorRow {
  id: string;
  date: ISODate;
  balanceCents: number;
}

export interface InvestmentDetail extends InvestmentRow {
  movements: InvestmentMovementRow[];
  anchors: InvestmentAnchorRow[];
  /** "Imposto se resgatar hoje" por faixa de IR. */
  taxByBracket: TaxBracketRow[];
}

export type InvestmentWarning = { code: 'cdi_missing'; message: string };

export interface InvestmentOverview {
  currentMonth: Month;
  totals: {
    grossCents: number;
    netCents: number;
    yieldCents: number;
    taxCents: number;
    monthlyPlanCents: number;
    /** Caixinhas ativas com "guardar por mês". */
    planCount: number;
    activeCount: number;
  };
  thisMonth: { plannedCents: number; depositedCents: number };
  /** 12 meses até o atual (todas as caixinhas não excluídas). */
  past: SeriesPoint[];
  /** 24 meses seguintes (só as ativas, com o "guardar por mês"). */
  projection: SeriesPoint[];
  warnings: InvestmentWarning[];
}
