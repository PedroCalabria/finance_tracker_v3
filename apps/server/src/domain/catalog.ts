import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Account, AccountInput, Category, CategoryInput } from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { accounts, categories, items } from '../db/schema';
import { AppError, badRequest, notFound } from '../http/errors';

/** Etapa 2 — cadastros de categorias e de contas/cartões. */

const toCategory = (c: typeof categories.$inferSelect): Category => ({ id: c.id, name: c.name, type: c.type, archived: !!c.archivedAt });
const toAccount = (a: typeof accounts.$inferSelect): Account => ({
  id: a.id,
  name: a.name,
  bank: a.bank,
  kind: a.kind,
  closingDay: a.closingDay,
  dueDay: a.dueDay,
  archived: !!a.archivedAt,
});

/** O Drizzle embrulha o erro do Postgres em `cause`. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur && typeof cur === 'object'; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: string }).code === '23505') return true;
  }
  return false;
}

export async function listCategories(db: DB, walletId: string, includeArchived = false): Promise<Category[]> {
  const rows = await db.query.categories.findMany({
    where: and(eq(categories.walletId, walletId), includeArchived ? undefined : isNull(categories.archivedAt)),
    orderBy: [asc(categories.type), asc(sql`lower(${categories.name})`)],
  });
  return rows.map(toCategory);
}

export async function createCategory(db: DB, walletId: string, input: CategoryInput): Promise<Category> {
  try {
    const [row] = await db.insert(categories).values({ walletId, ...input }).returning();
    return toCategory(row!);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'duplicate', 'Já existe uma categoria com esse nome.', { name: 'Já existe uma categoria com esse nome.' });
    throw e;
  }
}

export async function renameCategory(db: DB, walletId: string, id: string, name: string): Promise<Category> {
  try {
    const [row] = await db
      .update(categories)
      .set({ name, version: sql`${categories.version} + 1` })
      .where(and(eq(categories.id, id), eq(categories.walletId, walletId)))
      .returning();
    if (!row) throw notFound('Categoria');
    return toCategory(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'duplicate', 'Já existe uma categoria com esse nome.');
    throw e;
  }
}

/** Categoria em uso é arquivada (some do select, continua nos lançamentos); sem uso, é apagada. */
export async function removeCategory(db: DB, walletId: string, id: string): Promise<{ archived: boolean }> {
  const cat = await db.query.categories.findFirst({ where: and(eq(categories.id, id), eq(categories.walletId, walletId)) });
  if (!cat) throw notFound('Categoria');
  const used = await db.query.items.findFirst({ where: eq(items.categoryId, id), columns: { id: true } });
  if (used) {
    await db.update(categories).set({ archivedAt: new Date() }).where(eq(categories.id, id));
    return { archived: true };
  }
  await db.delete(categories).where(eq(categories.id, id));
  return { archived: false };
}

export async function listAccounts(db: DB, walletId: string, includeArchived = false): Promise<Account[]> {
  const rows = await db.query.accounts.findMany({
    where: and(eq(accounts.walletId, walletId), includeArchived ? undefined : isNull(accounts.archivedAt)),
    orderBy: [asc(accounts.kind), asc(sql`lower(${accounts.name})`)],
  });
  return rows.map(toAccount);
}

export async function createAccount(db: DB, walletId: string, input: AccountInput): Promise<Account> {
  const isCard = input.kind === 'credit_card';
  const [row] = await db
    .insert(accounts)
    .values({
      walletId,
      name: input.name,
      bank: input.bank,
      kind: input.kind,
      closingDay: isCard ? input.closingDay! : null,
      dueDay: isCard ? input.dueDay! : null,
    })
    .returning();
  return toAccount(row!);
}

/** Mudar os dias padrão vale para faturas ainda não criadas; as existentes mantêm suas datas. */
export async function updateAccount(
  db: DB,
  walletId: string,
  id: string,
  patch: { name?: string; bank?: string; closingDay?: number; dueDay?: number },
): Promise<Account> {
  const current = await db.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.walletId, walletId)) });
  if (!current) throw notFound('Conta');
  if (current.kind !== 'credit_card' && (patch.closingDay !== undefined || patch.dueDay !== undefined)) {
    throw badRequest('Só cartões têm dia de fechamento e vencimento.');
  }
  const [row] = await db
    .update(accounts)
    .set({ ...patch, version: sql`${accounts.version} + 1` })
    .where(eq(accounts.id, id))
    .returning();
  return toAccount(row!);
}

/** Contas nunca são apagadas: são arquivadas para não quebrar o histórico. */
export async function archiveAccount(db: DB, walletId: string, id: string): Promise<void> {
  const r = await db
    .update(accounts)
    .set({ archivedAt: new Date() })
    .where(and(eq(accounts.id, id), eq(accounts.walletId, walletId)))
    .returning({ id: accounts.id });
  if (r.length === 0) throw notFound('Conta');
}

export async function getCategoryChecked(tx: Tx, walletId: string, id: string | null | undefined, type: 'expense' | 'income') {
  if (!id) return null;
  const c = await tx.query.categories.findFirst({ where: and(eq(categories.id, id), eq(categories.walletId, walletId)) });
  if (!c) throw badRequest('Categoria não encontrada.', { categoryId: 'Categoria não encontrada.' });
  if (c.type !== type) throw badRequest('Essa categoria é de outro tipo.', { categoryId: 'Essa categoria é de outro tipo.' });
  return c;
}

export async function getAccountChecked(tx: Tx, walletId: string, id: string | null | undefined) {
  if (!id) return null;
  const a = await tx.query.accounts.findFirst({ where: and(eq(accounts.id, id), eq(accounts.walletId, walletId)) });
  if (!a) throw badRequest('Conta não encontrada.', { accountId: 'Conta não encontrada.' });
  return a;
}

