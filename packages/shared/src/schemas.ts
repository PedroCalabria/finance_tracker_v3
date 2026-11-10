import { z } from 'zod';
import { isISODate, isMonth } from './dates';
import { ACCOUNT_KINDS, ITEM_FORMS, ITEM_TYPES, METHODS } from './domain';
import { MAX_DEBT_INSTALLMENTS } from './debts/contract';
import { MAX_MONTHLY_RATE_PPM } from './debts/rates';
import { DEBT_CATEGORIES, DEBT_STRATEGIES, DEBT_STRUCTURES } from './debts/types';
import { INVESTMENT_ICONS, INVESTMENT_KINDS, MAX_CDI_ANNUAL_PPM, MAX_CDI_SHARE_BP, MAX_FIXED_RATE_PPM, TAX_MODES, YIELD_KINDS } from './investments/types';

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

export const personInput = z.object({ name: z.string().trim().min(1, 'Informe o nome.').max(60) });
export const personUpdate = personInput;

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

/**
 * Datas do lançamento conforme a forma (ADR-0004), conferidas nos dois lados:
 * - recorrente: `startMonth` + `day` (dia obrigatório na entrada e no crédito); sem `date`/`dueDate`;
 * - única e parcelada: `date` (na parcelada fora do crédito, a data da 1ª parcela); sem `startMonth`/`day`.
 */
interface DatesShape {
  type: (typeof ITEM_TYPES)[number];
  form: (typeof ITEM_FORMS)[number];
  method: (typeof METHODS)[number];
  date?: string | null;
  dueDate?: string | null;
  startMonth?: string | null;
  day?: number | null;
}
function checkDates(i: DatesShape, ctx: z.RefinementCtx, mode: 'create' | 'edit'): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (i.form === 'recurring') {
    if (!i.startMonth) issue('startMonth', 'Informe o mês de início.');
    if (i.day == null && i.method === 'credit') issue('day', 'Informe o dia da cobrança.');
    else if (i.day == null && i.type === 'income') issue('day', 'Informe o dia do recebimento.');
    if (i.date != null) issue('date', 'Recorrentes usam mês de início e dia, não data.');
    if (i.dueDate != null) issue('dueDate', 'Recorrentes usam mês de início e dia, não data.');
    return;
  }
  if (i.startMonth != null) issue('startMonth', 'Só recorrentes têm mês de início.');
  if (i.day != null) issue('day', 'Só recorrentes têm dia fixo.');
  // Na edição de parcelada fora do crédito vale a data desta parcela (`dueDate`); `date` pode faltar.
  const datelessEdit = mode === 'edit' && i.form === 'installment' && i.method !== 'credit';
  if (!i.date && !datelessEdit) issue('date', 'Informe a data.');
}

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
    /** Única: "Data" do cadastro. Parcelada: data da compra (crédito) ou da 1ª parcela (fora do crédito). */
    date: isoDate.nullish(),
    /** Única fora do crédito: "Data p/ pagamento", opcional. Ignorada nas outras formas. */
    dueDate: isoDate.nullish(),
    /** Recorrente: mês da primeira ocorrência (no crédito, da primeira cobrança). */
    startMonth: month.nullish(),
    /** Recorrente: dia do pagamento/recebimento (fora do crédito) ou da cobrança (crédito). */
    day: z.number({ invalid_type_error: 'Dia entre 1 e 31.' }).int('Dia entre 1 e 31.').min(1, 'Dia entre 1 e 31.').max(31, 'Dia entre 1 e 31.').nullish(),
    /** "Já foi pago?" da única e da recorrente. Ignorado na parcelada (vale `pastInstallmentsPaid`). */
    alreadyPaid: z.boolean().optional(),
    /** Parcelada: quita as parcelas de meses anteriores ao atual (no crédito, as faturas passadas só desta compra). */
    pastInstallmentsPaid: z.boolean().optional(),
    /** Responsável; nulo = "Eu". */
    personId: uuid.nullish(),
    /** Despesa de outra pessoa: cria a entrada de reembolso vinculada (ADR-0004). */
    createReimbursement: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .superRefine((i, ctx) => checkDates(i, ctx, 'create'))
  .superRefine((i, ctx) => {
    if (!i.createReimbursement) return;
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (i.type !== 'expense') issue('createReimbursement', 'Só despesas geram reembolso.');
    else if (!i.personId) issue('personId', 'Escolha a pessoa.');
    else if (i.form === 'recurring' && i.method !== 'credit' && i.day == null) issue('day', 'Informe o dia: o reembolso usa o mesmo dia.');
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
    /** Única: data do cadastro. Parcelada no crédito: data da compra. Ignorada na parcelada fora do crédito. */
    date: isoDate.nullish(),
    /** Data p/ pagamento DESTE mês (única) ou DESTA parcela (parcelada). Ignorada no crédito e nas recorrentes. */
    dueDate: isoDate.nullish(),
    /** Recorrente: mês de início (mudar recria os meses). */
    startMonth: month.nullish(),
    /** Recorrente: dia; fora do crédito vale do mês aberto em diante. */
    day: z.number({ invalid_type_error: 'Dia entre 1 e 31.' }).int('Dia entre 1 e 31.').min(1, 'Dia entre 1 e 31.').max(31, 'Dia entre 1 e 31.').nullish(),
    note: z.string().trim().max(500).nullish(),
    /** Responsável (mudança simples). Ausente = não muda; nulo = "Eu". */
    personId: uuid.nullish(),
    version: z.number().int().optional(),
  })
  .superRefine((i, ctx) => checkDates(i, ctx, 'edit'))
  .refine((i) => i.form !== 'installment' || (i.installments ?? 0) >= 2, { message: 'Informe o número de parcelas.', path: ['installments'] })
  .refine((i) => i.method !== 'credit' || i.type === 'expense', { message: 'Crédito só vale para despesas.', path: ['method'] })
  .refine((i) => i.method !== 'credit' || !!i.accountId, { message: 'Escolha o cartão.', path: ['accountId'] });

/** "Este e os próximos": encerra a recorrência antes da ocorrência escolhida (pode ser projeção). */
export const itemEndInput = z.object({ occurrenceId: z.string().min(1).max(80) });

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
export type PersonInput = z.infer<typeof personInput>;
export type AccountInput = z.infer<typeof accountInput>;
export type ItemCreateInput = z.infer<typeof itemCreateInput>;
export type ItemUpdateInput = z.infer<typeof itemUpdateInput>;
export type ItemEditInput = z.infer<typeof itemEditInput>;
export type OccurrenceUpdateInput = z.infer<typeof occurrenceUpdateInput>;
export type PaymentInput = z.infer<typeof paymentInput>;
export type InvoicePaymentInput = z.infer<typeof invoicePaymentInput>;
export type NotificationSettingsInput = z.infer<typeof notificationSettingsInput>;

/* ---------- Dívidas (ADR-0011) ---------- */

const ratePpm = z
  .number({ invalid_type_error: 'Informe a taxa.' })
  .int()
  .min(0, 'A taxa não pode ser negativa.')
  .max(MAX_MONTHLY_RATE_PPM, 'A taxa passa do limite de 50% ao mês.');
const installmentsCount = z
  .number({ invalid_type_error: 'Informe as parcelas restantes.' })
  .int()
  .min(1, 'De 1 a 600 parcelas.')
  .max(MAX_DEBT_INSTALLMENTS, 'De 1 a 600 parcelas.');
const dueDay = z.number({ invalid_type_error: 'Dia entre 1 e 31.' }).int('Dia entre 1 e 31.').min(1, 'Dia entre 1 e 31.').max(31, 'Dia entre 1 e 31.');

const debtFields = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(60, 'Até 60 caracteres.'),
  category: z.enum(DEBT_CATEGORIES),
  creditorName: z.string().trim().max(60, 'Até 60 caracteres.').nullish(),
  creditorPersonId: uuid.nullish(),
  structure: z.enum(DEBT_STRUCTURES),
  monthlyRatePpm: ratePpm,
  installmentCents: positiveCents.nullish(),
  remainingInstallments: installmentsCount.nullish(),
  dueDay: dueDay.nullish(),
  minPaymentKind: z.enum(['fixed', 'percent']).nullish(),
  /** Centavos (fixed) ou milionésimos do saldo (percent: 100 = 0,01% a 1.000.000 = 100%). */
  minPaymentValue: z.number().int().positive('Informe o pagamento mínimo.').nullish(),
  acceptsExtra: z.boolean(),
});
type DebtFieldsShape = z.infer<typeof debtFields>;

/** Campos exigidos por estrutura e credor (ADR-0011). Campos de outra estrutura são ignorados (gravados nulos). */
function checkDebt(d: DebtFieldsShape, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (d.creditorName && d.creditorPersonId) issue('creditorName', 'Escolha um credor: o nome ou uma pessoa cadastrada.');
  if (d.category === 'person' && !d.creditorPersonId) issue('creditorPersonId', 'Escolha a pessoa.');
  if (d.structure === 'interest_free' && d.monthlyRatePpm !== 0) issue('monthlyRatePpm', 'Dívida sem juros tem taxa zero.');
  if (d.structure === 'price' && d.installmentCents == null) issue('installmentCents', 'Informe a parcela.');
  if ((d.structure === 'price' || d.structure === 'sac') && d.remainingInstallments == null) issue('remainingInstallments', 'Informe as parcelas restantes.');
  if ((d.structure === 'price' || d.structure === 'sac') && d.dueDay == null) issue('dueDay', 'Informe o dia de vencimento.');
  if (d.structure === 'revolving') {
    if (!d.minPaymentKind) issue('minPaymentKind', 'Informe o pagamento mínimo.');
    else if (d.minPaymentValue == null) issue('minPaymentValue', 'Informe o pagamento mínimo.');
    else if (d.minPaymentKind === 'percent' && (d.minPaymentValue < 100 || d.minPaymentValue > 1_000_000)) {
      issue('minPaymentValue', 'O mínimo vai de 0,01% a 100% do saldo.');
    }
  }
}

export const debtCreateInput = debtFields
  .extend({
    /** Primeira âncora: "saldo em dd/mm/aaaa". */
    anchorDate: isoDate,
    anchorBalanceCents: cents.min(0, 'O saldo não pode ser negativo.'),
  })
  .superRefine(checkDebt);

export const debtUpdateInput = debtFields.extend({ version: z.number().int() }).superRefine(checkDebt);

export const debtAnchorInput = z.object({
  date: isoDate,
  balanceCents: cents.min(0, 'O saldo não pode ser negativo.'),
  /** Price/SAC: contrato informado junto com o saldo (opcional). */
  remainingInstallments: installmentsCount.nullish(),
  installmentCents: positiveCents.nullish(),
});

export const debtPaymentInput = z.object({
  date: isoDate,
  amountCents: positiveCents,
  kind: z.enum(['installment', 'extra']),
  /** Amortização extra em Price/SAC. */
  extraEffect: z.enum(['reduce_term', 'reduce_installment']).nullish(),
  /** Contrato recalculado e confirmado pela pessoa (amortização extra em Price/SAC). */
  contract: z
    .object({ installmentCents: positiveCents.nullish(), remainingInstallments: z.number().int().min(0).max(MAX_DEBT_INSTALLMENTS).nullish() })
    .nullish(),
});
export const debtPaymentUpdateInput = z.object({
  date: isoDate,
  amountCents: positiveCents,
  kind: z.enum(['installment', 'extra']),
  version: z.number().int(),
});

export const debtPayOffInput = z.object({ date: isoDate, finalPayment: z.boolean().optional() });
export const debtOrderInput = z.object({ ids: z.array(uuid).min(1).max(500) });
export const debtSettingsInput = z.object({ strategy: z.enum(DEBT_STRATEGIES) });
export const debtBudgetInput = z.object({ amountCents: cents.min(0, 'O orçamento não pode ser negativo.') });

export type DebtCreateInput = z.infer<typeof debtCreateInput>;
export type DebtUpdateInput = z.infer<typeof debtUpdateInput>;
export type DebtAnchorInput = z.infer<typeof debtAnchorInput>;
export type DebtPaymentInput = z.infer<typeof debtPaymentInput>;
export type DebtPaymentUpdateInput = z.infer<typeof debtPaymentUpdateInput>;

/* ---------- Investimentos em caixinhas (ADR-0012) ---------- */

const investmentFields = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(60, 'Até 60 caracteres.'),
  icon: z.enum(INVESTMENT_ICONS, { errorMap: () => ({ message: 'Escolha um dos ícones da lista.' }) }),
  kind: z.enum(INVESTMENT_KINDS),
  yieldKind: z.enum(YIELD_KINDS),
  /** Prefixado: taxa mensal em milionésimos (1% a.m. = 10000). */
  fixedRatePpm: z.number().int().min(0, 'A taxa não pode ser negativa.').max(MAX_FIXED_RATE_PPM, 'A taxa vai até 10% a.m.').nullish(),
  /** % do CDI em centésimos de ponto (100% = 10000). */
  cdiShareBp: z.number().int().min(1, 'Informe o % do CDI.').max(MAX_CDI_SHARE_BP, 'O % do CDI vai até 300%.').nullish(),
  redeemableFrom: isoDate.nullish(),
  taxMode: z.enum(TAX_MODES),
  goalCents: positiveCents.nullish(),
  goalMonth: month.nullish(),
  monthlyPlanCents: positiveCents.nullish(),
});
type InvestmentFieldsShape = z.infer<typeof investmentFields>;

function checkInvestment(d: InvestmentFieldsShape, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (d.yieldKind === 'fixed' && d.fixedRatePpm == null) issue('fixedRatePpm', 'Informe a taxa.');
  if (d.yieldKind === 'cdi' && d.cdiShareBp == null) issue('cdiShareBp', 'Informe o % do CDI.');
  if (d.goalMonth && d.goalCents == null) issue('goalCents', 'Informe o valor da meta para escolher o mês.');
}

export const investmentCreateInput = investmentFields
  .extend({
    /** "Quanto você já tem guardado aqui?" e "Desde quando?" (movimentação inicial). */
    initialCents: positiveCents,
    initialDate: isoDate,
  })
  .superRefine(checkInvestment);

export const investmentUpdateInput = investmentFields.extend({ version: z.number().int() }).superRefine(checkInvestment);

const taxCents = cents.min(0, 'O imposto não pode ser negativo.');
const taxNotAboveAmount = (m: { amountCents: number; taxCents?: number | null }) => m.taxCents == null || m.taxCents <= m.amountCents;
const taxAboveMessage = { message: 'O imposto não pode ser maior que o resgate.', path: ['taxCents'] };

export const investmentMovementInput = z
  .object({
    date: isoDate,
    kind: z.enum(['deposit', 'withdrawal']),
    amountCents: positiveCents,
    /** Só no resgate: impostos retidos (IR + IOF). */
    taxCents: taxCents.nullish(),
  })
  .refine((m) => m.kind === 'withdrawal' || m.taxCents == null, { message: 'Aporte não tem imposto.', path: ['taxCents'] })
  .refine(taxNotAboveAmount, taxAboveMessage);

export const investmentMovementUpdateInput = z
  .object({ date: isoDate, amountCents: positiveCents, taxCents: taxCents.nullish(), version: z.number().int() })
  .refine(taxNotAboveAmount, taxAboveMessage);

export const investmentAnchorInput = z.object({ date: isoDate, balanceCents: cents.min(0, 'O saldo não pode ser negativo.') });

/** Encerrar: resgata o saldo estimado na data (ou os valores confirmados no modal). */
export const investmentCloseInput = z
  .object({ date: isoDate, amountCents: cents.min(0).nullish(), taxCents: taxCents.nullish() })
  .refine((m) => m.amountCents == null || m.taxCents == null || m.taxCents <= m.amountCents, taxAboveMessage);

export const investmentSettingsInput = z.object({
  /** CDI anual em milionésimos (14,90% a.a. = 149000). */
  cdiAnnualPpm: z.number().int().min(1, 'Informe o CDI.').max(MAX_CDI_ANNUAL_PPM, 'O CDI vai até 100% a.a.'),
});

export type InvestmentCreateInput = z.infer<typeof investmentCreateInput>;
export type InvestmentUpdateInput = z.infer<typeof investmentUpdateInput>;
export type InvestmentMovementInput = z.infer<typeof investmentMovementInput>;
export type InvestmentMovementUpdateInput = z.infer<typeof investmentMovementUpdateInput>;
export type InvestmentAnchorInput = z.infer<typeof investmentAnchorInput>;
export type InvestmentCloseInput = z.infer<typeof investmentCloseInput>;
