import { sql } from 'drizzle-orm';
import {
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
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [index('items_wallet_idx').on(t.walletId)],
);

/** Um mês concreto de um item. As linhas da tabela da interface. */
export const occurrences = pgTable(
  'occurrences',
  {
    id: id(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
    competenceMonth: monthCol('competence_month').notNull(),
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
