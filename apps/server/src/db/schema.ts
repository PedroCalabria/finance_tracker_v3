import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Esquema do banco (ADR-0004). Convenções:
 * - Dinheiro em centavos (integer). Datas civis em `date`, meses em char(7) "YYYY-MM".
 * - Todo dado financeiro tem `wallet_id`; autorização = ser membro da carteira.
 * - `version` nas tabelas editáveis para controle de concorrência (409 em conflito).
 * - Exclusão lógica via `deleted_at`/`archived_at`.
 */

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const version = () => integer('version').notNull().default(1);
const dateCol = (name: string) => date(name, { mode: 'string' });
const monthCol = (name: string) => char(name, { length: 7 });

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

/** Refresh tokens opacos, guardados como hash; `family_id` agrupa as rotações de um login. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.refreshTokenHash), index('sessions_user_idx').on(t.userId)],
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['verify_email', 'reset_password'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('email_tokens_hash_uq').on(t.tokenHash)],
);

export const wallets = pgTable('wallets', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
  createdAt: createdAt(),
});

export const walletMembers = pgTable(
  'wallet_members',
  {
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.walletId, t.userId] }), index('wallet_members_user_idx').on(t.userId)],
);

export const categories = pgTable(
  'categories',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['expense', 'income'] }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('categories_name_uq').on(t.walletId, t.type, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`)],
);

/** Pessoas da carteira: o "responsável" de um lançamento (nulo = "Eu"). Terceiros, não usuários. */
export const people = pgTable(
  'people',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('people_name_uq').on(t.walletId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
    index('people_wallet_idx').on(t.walletId),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    bank: text('bank').notNull(),
    kind: text('kind', { enum: ['account', 'credit_card'] }).notNull(),
    closingDay: smallint('closing_day'),
    dueDay: smallint('due_day'),
    /** Hash da conta ou do cartão de origem nas importações (ADR-0010): pré-seleciona o destino. */
    importKey: text('import_key'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index('accounts_wallet_idx').on(t.walletId),
    check('accounts_card_days', sql`${t.kind} <> 'credit_card' or (${t.closingDay} is not null and ${t.dueDay} is not null)`),
  ],
);

/** Uma fatura por cartão e mês de VENCIMENTO (reference_month). */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    referenceMonth: monthCol('reference_month').notNull(),
    closingDate: dateCol('closing_date').notNull(),
    dueDate: dateCol('due_date').notNull(),
    /** Valor real informado no pagamento; a diferença vira item de ajuste. */
    realAmountCents: integer('real_amount_cents'),
    status: text('status', { enum: ['open', 'paid', 'carried'] }).notNull().default('open'),
    carriedToInvoiceId: uuid('carried_to_invoice_id'),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invoices_account_month_uq').on(t.accountId, t.referenceMonth), index('invoices_wallet_month_idx').on(t.walletId, t.referenceMonth)],
);

export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
    paidAt: dateCol('paid_at').notNull(),
    amountCents: integer('amount_cents').notNull(),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('invoice_payments_invoice_idx').on(t.invoiceId)],
);

/** A regra de um lançamento. Gera ocorrências (uma por mês ou parcela). */
export const items = pgTable(
  'items',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['expense', 'income'] }).notNull(),
    form: text('form', { enum: ['single', 'installment', 'recurring'] }).notNull(),
    description: text('description').notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    method: text('method', { enum: ['credit', 'debit', 'pix', 'boleto', 'transfer', 'cash'] }).notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** Parcelada: total. */
    totalCents: integer('total_cents'),
    installments: smallint('installments'),
    /** Única e recorrente: valor do mês (regra vigente). */
    amountCents: integer('amount_cents'),
    variableAmount: boolean('variable_amount').notNull().default(false),
    /** Recorrente: dia do vencimento. */
    dueDay: smallint('due_day'),
    /** Data obrigatória do cadastro (compra no crédito). */
    entryDate: dateCol('entry_date').notNull(),
    startMonth: monthCol('start_month').notNull(),
    /** Recorrente encerrada: último mês com ocorrência. */
    endMonth: monthCol('end_month'),
    systemKind: text('system_kind', { enum: ['invoice_adjustment', 'invoice_carryover'] }),
    /** Item de sistema: a fatura que o gerou. */
    sourceInvoiceId: uuid('source_invoice_id'),
    /** Responsável pelo lançamento; nulo = "Eu". */
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    /** Entrada de reembolso: a despesa de outra pessoa que a gerou. */
    reimbursesItemId: uuid('reimburses_item_id').references((): AnyPgColumn => items.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [index('items_wallet_idx').on(t.walletId), index('items_reimburses_idx').on(t.reimbursesItemId)],
);

/** Um mês concreto de um item. As linhas da tabela da interface. */
export const occurrences = pgTable(
  'occurrences',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
    /** Mês da ocorrência; no crédito, o mês da FATURA (ADR-0005). */
    competenceMonth: monthCol('competence_month').notNull(),
    /** Mês do gasto: no crédito, o da compra ou cobrança; fora dele, igual a `competence_month` (ADR-0004). */
    chargeMonth: monthCol('charge_month').notNull(),
    installmentNumber: smallint('installment_number'),
    expectedCents: integer('expected_cents').notNull(),
    dueDate: dateCol('due_date'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['pending', 'partial', 'paid', 'canceled'] }).notNull().default('pending'),
    settledWithDiscount: boolean('settled_with_discount').notNull().default(false),
    note: text('note'),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('occurrences_item_month_uq').on(t.itemId, t.competenceMonth).where(sql`${t.installmentNumber} is null`),
    uniqueIndex('occurrences_item_installment_uq').on(t.itemId, t.installmentNumber).where(sql`${t.installmentNumber} is not null`),
    index('occurrences_wallet_month_idx').on(t.walletId, t.competenceMonth),
    index('occurrences_wallet_charge_idx').on(t.walletId, t.chargeMonth),
    index('occurrences_invoice_idx').on(t.invoiceId),
  ],
);

/** Pagamentos de uma ocorrência. `group_id` une as parcelas pagas juntas e seus comprovantes. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    occurrenceId: uuid('occurrence_id').notNull().references(() => occurrences.id, { onDelete: 'cascade' }),
    paidAt: dateCol('paid_at').notNull(),
    amountCents: integer('amount_cents').notNull(),
    groupId: uuid('group_id').notNull(),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('payments_occurrence_idx').on(t.occurrenceId), index('payments_group_idx').on(t.groupId)],
);

/** Comprovantes cifrados no storage. Ligados a um grupo de pagamento OU a um pagamento de fatura. */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    paymentGroupId: uuid('payment_group_id'),
    invoicePaymentId: uuid('invoice_payment_id').references(() => invoicePayments.id, { onDelete: 'set null' }),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_group_idx').on(t.paymentGroupId), index('attachments_invoice_payment_idx').on(t.invoicePaymentId)],
);

export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  sendHour: smallint('send_hour').notNull().default(8),
  leadBusinessDays: smallint('lead_business_days').notNull().default(1),
});

/** Garante um único envio por usuário, dia e tipo, mesmo que o job rode duas vezes. */
export const notificationLog = pgTable(
  'notification_log',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: dateCol('day').notNull(),
    kind: text('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    itemCount: integer('item_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.kind] })],
);

/**
 * Importação confirmada de extrato ou fatura (ADR-0010). Não guarda o arquivo
 * nem linhas não confirmadas: só a origem, o destino, o período e as contagens.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    readerId: text('reader_id').notNull(),
    kind: text('kind', { enum: ['statement', 'invoice'] }).notNull(),
    periodStart: dateCol('period_start'),
    periodEnd: dateCol('period_end'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('import_batches_wallet_idx').on(t.walletId, t.createdAt)],
);

/**
 * Linha confirmada (inclusive ignorada) com a impressão digital que impede
 * duplicar numa reimportação, e o vínculo com o que ela gerou ou casou.
 */
export const importLines = pgTable(
  'import_lines',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull().references(() => importBatches.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    lineDate: dateCol('line_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    direction: text('direction', { enum: ['credit', 'debit'] }).notNull(),
    /** Como veio do banco, com CPF/CNPJ mascarados. */
    description: text('description').notNull(),
    document: text('document'),
    action: text('action', { enum: ['paid', 'linked', 'created', 'invoice_paid', 'ignored'] }).notNull(),
    occurrenceId: uuid('occurrence_id').references(() => occurrences.id, { onDelete: 'set null' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    invoicePaymentId: uuid('invoice_payment_id').references(() => invoicePayments.id, { onDelete: 'set null' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('import_lines_fingerprint_uq').on(t.walletId, t.accountId, t.fingerprint),
    index('import_lines_payment_idx').on(t.paymentId),
    index('import_lines_occurrence_idx').on(t.occurrenceId),
  ],
);

/* ---------- Dívidas (ADR-0011): módulo isolado da tabela do mês ---------- */

/**
 * Dívida da carteira. O contrato (parcela, parcelas restantes, dia) tem a forma dos campos de `items`
 * para receber depois um `item_id` nulo (vínculo com a tabela do mês). O saldo NÃO vem do ledger:
 * sai das âncoras e dos pagamentos próprios.
 */
export const debts = pgTable(
  'debts',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category', {
      enum: ['card_installment', 'overdraft', 'personal_loan', 'payroll_loan', 'vehicle_financing', 'mortgage', 'person', 'other'],
    }).notNull(),
    creditorName: text('creditor_name'),
    creditorPersonId: uuid('creditor_person_id').references(() => people.id, { onDelete: 'set null' }),
    structure: text('structure', { enum: ['price', 'sac', 'revolving', 'interest_free'] }).notNull(),
    /** Taxa mensal composta em milionésimos da fração (2,99% a.m. = 29900). */
    monthlyRatePpm: integer('monthly_rate_ppm').notNull(),
    installmentCents: integer('installment_cents'),
    remainingInstallments: smallint('remaining_installments'),
    dueDay: smallint('due_day'),
    minPaymentKind: text('min_payment_kind', { enum: ['fixed', 'percent'] }),
    /** Centavos (fixed) ou milionésimos do saldo (percent). */
    minPaymentValue: integer('min_payment_value'),
    /** Data a que o contrato se refere: parcelas de pagamentos posteriores descontam `remaining_installments`. */
    contractAsOf: dateCol('contract_as_of').notNull(),
    acceptsExtra: boolean('accepts_extra').notNull(),
    status: text('status', { enum: ['active', 'paid_off'] }).notNull().default('active'),
    paidOffOn: dateCol('paid_off_on'),
    /** Posição na "Minha ordem". */
    position: integer('position'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index('debts_wallet_idx').on(t.walletId).where(sql`${t.deletedAt} is null`),
    check('debts_creditor_one', sql`${t.creditorName} is null or ${t.creditorPersonId} is null`),
    check('debts_interest_free_rate', sql`${t.structure} <> 'interest_free' or ${t.monthlyRatePpm} = 0`),
    check('debts_rate_range', sql`${t.monthlyRatePpm} between 0 and 500000`),
  ],
);

/** "Saldo em dd/mm/aaaa" informado pela pessoa. A mais antiga é o saldo inicial; a mais recente, a vigente. */
export const debtBalanceAnchors = pgTable(
  'debt_balance_anchors',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    debtId: uuid('debt_id').notNull().references(() => debts.id, { onDelete: 'cascade' }),
    date: dateCol('date').notNull(),
    balanceCents: integer('balance_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('debt_anchors_debt_date_uq').on(t.debtId, t.date)],
);

/** Pagamentos de dívidas, separados de `payments` (pronto para um `occurrence_id` nulo no vínculo futuro). */
export const debtPayments = pgTable(
  'debt_payments',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    debtId: uuid('debt_id').notNull().references(() => debts.id, { onDelete: 'cascade' }),
    date: dateCol('date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    kind: text('kind', { enum: ['installment', 'extra'] }).notNull(),
    extraEffect: text('extra_effect', { enum: ['reduce_term', 'reduce_installment'] }),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [index('debt_payments_wallet_date_idx').on(t.walletId, t.date), index('debt_payments_debt_idx').on(t.debtId)],
);

/** Orçamento mensal para dívidas: "a partir de AAAA-MM: valor" (vale até a próxima vigência). */
export const debtBudgets = pgTable(
  'debt_budgets',
  {
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    fromMonth: monthCol('from_month').notNull(),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [primaryKey({ columns: [t.walletId, t.fromMonth] })],
);

/** Estratégia de prioridade da carteira. */
export const debtSettings = pgTable('debt_settings', {
  walletId: uuid('wallet_id')
    .primaryKey()
    .references(() => wallets.id, { onDelete: 'cascade' }),
  strategy: text('strategy', { enum: ['avalanche', 'snowball', 'manual'] }).notNull().default('avalanche'),
  manualOrderSet: boolean('manual_order_set').notNull().default(false),
});

/* ---------- Investimentos em caixinhas (ADR-0012). Isolados do ledger: só o resumo do mês os lê. ---------- */

/** Caixinha da carteira. Prefixado em milionésimos ao mês; % do CDI em centésimos de ponto (100% = 10000). */
export const investments = pgTable(
  'investments',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon').notNull(),
    kind: text('kind', { enum: ['savings_box', 'treasury', 'lci_lca', 'poupanca', 'other'] }).notNull(),
    yieldKind: text('yield_kind', { enum: ['fixed', 'cdi', 'none'] }).notNull(),
    fixedRatePpm: integer('fixed_rate_ppm'),
    cdiShareBp: integer('cdi_share_bp'),
    /** "Só a partir de": nulo = a qualquer momento. */
    redeemableFrom: dateCol('redeemable_from'),
    taxMode: text('tax_mode', { enum: ['regressive', 'exempt'] }).notNull(),
    goalCents: integer('goal_cents'),
    goalMonth: monthCol('goal_month'),
    /** "Guardar por mês" (vale o valor atual; meses passados usam o realizado). */
    monthlyPlanCents: integer('monthly_plan_cents'),
    status: text('status', { enum: ['active', 'closed'] }).notNull().default('active'),
    closedOn: dateCol('closed_on'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index('investments_wallet_idx').on(t.walletId).where(sql`${t.deletedAt} is null`),
    check('investments_fixed_rate', sql`(${t.yieldKind} = 'fixed') = (${t.fixedRatePpm} is not null) and coalesce(${t.fixedRatePpm}, 0) between 0 and 100000`),
    check('investments_cdi_share', sql`(${t.yieldKind} = 'cdi') = (${t.cdiShareBp} is not null) and coalesce(${t.cdiShareBp}, 1) between 1 and 30000`),
    check('investments_goal', sql`${t.goalMonth} is null or ${t.goalCents} is not null`),
    check('investments_goal_positive', sql`${t.goalCents} is null or ${t.goalCents} > 0`),
    check('investments_plan_positive', sql`${t.monthlyPlanCents} is null or ${t.monthlyPlanCents} > 0`),
  ],
);

/** Valor inicial, aportes e resgates. O inicial conta no rendimento e no imposto, não no resumo do mês. */
export const investmentMovements = pgTable(
  'investment_movements',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    investmentId: uuid('investment_id').notNull().references(() => investments.id, { onDelete: 'cascade' }),
    date: dateCol('date').notNull(),
    kind: text('kind', { enum: ['initial', 'deposit', 'withdrawal'] }).notNull(),
    /** Aporte: o que entrou; resgate: o que saiu da caixinha (bruto). */
    amountCents: integer('amount_cents').notNull(),
    /** Só no resgate: impostos retidos (IR + IOF). */
    taxCents: integer('tax_cents'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('investment_movements_initial_uq').on(t.investmentId).where(sql`${t.kind} = 'initial'`),
    index('investment_movements_wallet_date_idx').on(t.walletId, t.date),
    index('investment_movements_investment_idx').on(t.investmentId),
    check('investment_movements_amount', sql`${t.amountCents} > 0`),
    check('investment_movements_tax', sql`(${t.kind} = 'withdrawal' or ${t.taxCents} is null) and coalesce(${t.taxCents}, 0) between 0 and ${t.amountCents}`),
  ],
);

/** "Saldo em dd/mm/aaaa" da caixinha: alinha a estimativa ao banco. */
export const investmentBalanceAnchors = pgTable(
  'investment_balance_anchors',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    investmentId: uuid('investment_id').notNull().references(() => investments.id, { onDelete: 'cascade' }),
    date: dateCol('date').notNull(),
    balanceCents: integer('balance_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('investment_anchors_date_uq').on(t.investmentId, t.date), check('investment_anchors_balance', sql`${t.balanceCents} >= 0`)],
);

/** CDI anual estimado da carteira, em milionésimos (14,90% a.a. = 149000). */
export const investmentSettings = pgTable('investment_settings', {
  walletId: uuid('wallet_id')
    .primaryKey()
    .references(() => wallets.id, { onDelete: 'cascade' }),
  cdiAnnualPpm: integer('cdi_annual_ppm'),
  cdiUpdatedOn: dateCol('cdi_updated_on'),
});
