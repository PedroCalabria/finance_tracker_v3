import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { addMonths, defaultInvoiceDates, invoiceChargeMonth, invoiceMonthForPurchase, type InvoiceDates, type ISODate, type Month } from '@ff/shared';
import type { Tx } from '../db/client';
import { accounts, invoices, items, occurrences } from '../db/schema';

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

/**
 * Mês do gasto das faturas de um cartão (`invoiceChargeMonth`, com as datas ajustadas).
 * Todo item no crédito que não é de sistema tem o mês do gasto da sua fatura (ADR-0005).
 */
export async function chargeMonthResolver(tx: Tx, account: AccountRow, from: Month): Promise<(referenceMonth: Month) => Month> {
  const overrides = await overridesFor(tx, account.id, addMonths(from, -1));
  return (referenceMonth) => invoiceChargeMonth(referenceMonth, account.closingDay!, account.dueDay!, overrides);
}

/**
 * Recalcula o mês do gasto dos itens destas faturas (depois de mover item ou ajustar datas).
 * "Ajuste" e "Saldo restante" da fatura ficam como estão: contam pelo mês da fatura.
 */
export async function syncChargeMonths(tx: Tx, account: AccountRow, referenceMonths: Month[]): Promise<void> {
  if (!referenceMonths.length) return;
  const charge = await chargeMonthResolver(tx, account, referenceMonths.reduce((a, b) => (a < b ? a : b)));
  for (const month of referenceMonths) {
    const inv = await tx.query.invoices.findFirst({ where: and(eq(invoices.accountId, account.id), eq(invoices.referenceMonth, month)), columns: { id: true } });
    if (!inv) continue;
    await tx
      .update(occurrences)
      .set({ chargeMonth: charge(month), version: sql`${occurrences.version} + 1` })
      .where(
        and(
          eq(occurrences.invoiceId, inv.id),
          sql`${occurrences.chargeMonth} <> ${charge(month)}`,
          inArray(occurrences.itemId, tx.select({ id: items.id }).from(items).where(isNull(items.systemKind))),
        ),
      );
  }
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
