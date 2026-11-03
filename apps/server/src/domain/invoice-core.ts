import { and, eq, gte } from 'drizzle-orm';
import { defaultInvoiceDates, invoiceMonthForPurchase, type InvoiceDates, type ISODate, type Month } from '@ff/shared';
import type { Tx } from '../db/client';
import { accounts, invoices } from '../db/schema';

/** Núcleo das faturas, sem dependências de outros módulos de domínio (ADR-0005). */

type AccountRow = typeof accounts.$inferSelect;
type InvoiceRec = typeof invoices.$inferSelect;

/** Datas ajustadas manualmente do cartão, para calcular em qual fatura cai uma compra. */
async function overridesFor(tx: Tx, accountId: string, from: Month): Promise<Map<Month, InvoiceDates>> {
  const rows = await tx.query.invoices.findMany({
    where: and(eq(invoices.accountId, accountId), gte(invoices.referenceMonth, from)),
    columns: { referenceMonth: true, closingDate: true, dueDate: true },
  });
  return new Map(rows.map((r) => [r.referenceMonth, { closingDate: r.closingDate, dueDate: r.dueDate }]));
}

export async function invoiceMonthFor(tx: Tx, account: AccountRow, purchaseDate: ISODate): Promise<Month> {
  const overrides = await overridesFor(tx, account.id, purchaseDate.slice(0, 7));
  return invoiceMonthForPurchase(purchaseDate, account.closingDay!, account.dueDay!, overrides);
}

/** Busca ou cria (idempotente) a fatura de um cartão num mês. */
export async function ensureInvoice(tx: Tx, account: AccountRow, month: Month): Promise<InvoiceRec> {
  const where = and(eq(invoices.accountId, account.id), eq(invoices.referenceMonth, month));
  const existing = await tx.query.invoices.findFirst({ where });
  if (existing) return existing;
  const d = defaultInvoiceDates(month, account.closingDay!, account.dueDay!);
  await tx
    .insert(invoices)
    .values({ walletId: account.walletId, accountId: account.id, referenceMonth: month, closingDate: d.closingDate, dueDate: d.dueDate })
    .onConflictDoNothing();
  return (await tx.query.invoices.findFirst({ where }))!;
}
