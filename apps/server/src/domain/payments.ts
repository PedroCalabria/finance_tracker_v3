import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { type OccurrenceRow, type PaymentInput } from '@ff/shared';
import type { DB } from '../db/client';
import { attachments, items, occurrences, payments } from '../db/schema';
import { AppError, badRequest, notFound } from '../http/errors';
import type { Clock } from './clock';
import { linkAttachments } from './invoices';
import { buildRows, getOccurrenceChecked, refreshStatus } from './occurrences';
import { materializeProjection } from './projections';

/**
 * Etapa 4 — pagamentos fora do crédito (ADR-0004). O status gravado sai da soma
 * dos pagamentos contra o previsto; "quitado com desconto" marca pago mesmo abaixo.
 */

export async function addPayment(db: DB, walletId: string, occurrenceId: string, input: PaymentInput, userId: string, clock: Clock): Promise<OccurrenceRow[]> {
  return db.transaction(async (tx) => {
    const realId = await materializeProjection(tx, walletId, occurrenceId, clock);
    const occ = await getOccurrenceChecked(tx, walletId, realId);
    if (occ.invoiceId) throw new AppError(409, 'credit_item', 'No crédito, o pagamento é feito pela fatura do cartão.');
    if (occ.status === 'canceled') throw badRequest('Esta parcela foi cancelada.');
    if (occ.status === 'paid') throw new AppError(409, 'already_paid', 'Este lançamento já está pago. Use o lápis para editar o pagamento.');
    const item = (await tx.query.items.findFirst({ where: eq(items.id, occ.itemId) }))!;
    const groupId = randomUUID();

    // Várias parcelas de uma vez: esta + as próximas N em aberto, cada uma pelo seu restante.
    const targets = [occ];
    if (input.payNext && input.payNext > 0) {
      if (item.form !== 'installment') throw badRequest('Só parcelas podem ser pagas em conjunto.');
      const next = await tx.query.occurrences.findMany({
        where: and(eq(occurrences.itemId, item.id), gt(occurrences.installmentNumber, occ.installmentNumber ?? 0), eq(occurrences.status, 'pending')),
        orderBy: asc(occurrences.installmentNumber),
        limit: input.payNext,
      });
      if (next.length < input.payNext) throw badRequest(`Só há ${next.length} parcela(s) seguinte(s) em aberto.`);
      targets.push(...next);
    }

    const paidSoFar = await paidByOcc(tx, targets.map((t) => t.id));
    const remainingOf = (id: string, expected: number) => Math.max(0, expected - (paidSoFar.get(id) ?? 0));

    if (targets.length > 1) {
      // Em conjunto, cada parcela é quitada pelo seu valor; o total informado precisa bater.
      const total = targets.reduce((s, t) => s + remainingOf(t.id, t.expectedCents), 0);
      if (input.amountCents !== total) throw badRequest('O valor precisa ser a soma das parcelas escolhidas.', { amountCents: 'O valor precisa ser a soma das parcelas.' });
      for (const t of targets) {
        await tx.insert(payments).values({ walletId, occurrenceId: t.id, paidAt: input.paidAt, amountCents: remainingOf(t.id, t.expectedCents), groupId, paidBy: userId });
        await tx.update(occurrences).set({ status: 'paid', version: sql`${occurrences.version} + 1` }).where(eq(occurrences.id, t.id));
      }
    } else {
      const remaining = remainingOf(occ.id, occ.expectedCents);
      if (input.amountCents < remaining && !input.settlement) {
        throw new AppError(400, 'settlement_required', 'O valor é menor que o previsto. Diga se foi quitado com desconto ou se é um pagamento parcial.');
      }
      await tx.insert(payments).values({ walletId, occurrenceId: occ.id, paidAt: input.paidAt, amountCents: input.amountCents, groupId, paidBy: userId });
      const discount = input.amountCents < remaining && input.settlement === 'discount';
      await tx
        .update(occurrences)
        .set({ settledWithDiscount: discount || occ.settledWithDiscount, version: sql`${occurrences.version} + 1` })
        .where(eq(occurrences.id, occ.id));
      await refreshStatus(tx, occ.id);
    }
    if (input.attachmentIds?.length) await linkAttachments(tx, walletId, input.attachmentIds, { paymentGroupId: groupId });
    const updated = await tx.query.occurrences.findMany({ where: inArray(occurrences.id, targets.map((t) => t.id)) });
    return buildRows(tx, updated, clock);
  });
}

async function paidByOcc(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ids: string[]): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: payments.occurrenceId, cents: sql<number>`sum(${payments.amountCents})::int` })
    .from(payments)
    .where(inArray(payments.occurrenceId, ids))
    .groupBy(payments.occurrenceId);
  return new Map(rows.map((r) => [r.id, r.cents]));
}

/** Lápis: corrige data e/ou valor de um pagamento. */
export async function updatePayment(db: DB, walletId: string, paymentId: string, patch: { paidAt?: string; amountCents?: number }, clock: Clock): Promise<OccurrenceRow> {
  return db.transaction(async (tx) => {
    const pay = await tx.query.payments.findFirst({ where: and(eq(payments.id, paymentId), eq(payments.walletId, walletId)) });
    if (!pay) throw notFound('Pagamento');
    await tx.update(payments).set(patch).where(eq(payments.id, pay.id));
    await refreshStatus(tx, pay.occurrenceId);
    const occ = await getOccurrenceChecked(tx, walletId, pay.occurrenceId);
    return (await buildRows(tx, [occ], clock))[0]!;
  });
}

/** Desmarcar: apaga um pagamento (ou todos da ocorrência) e devolve o status a pendente/parcial. */
export async function deletePayment(db: DB, walletId: string, paymentId: string, clock: Clock): Promise<OccurrenceRow> {
  return db.transaction(async (tx) => {
    const pay = await tx.query.payments.findFirst({ where: and(eq(payments.id, paymentId), eq(payments.walletId, walletId)) });
    if (!pay) throw notFound('Pagamento');
    await tx.delete(payments).where(eq(payments.id, pay.id));
    const stillUsed = await tx.query.payments.findFirst({ where: eq(payments.groupId, pay.groupId), columns: { id: true } });
    if (!stillUsed) {
      await tx.update(attachments).set({ deletedAt: new Date() }).where(and(eq(attachments.paymentGroupId, pay.groupId), isNull(attachments.deletedAt)));
    }
    await tx.update(occurrences).set({ settledWithDiscount: false, version: sql`${occurrences.version} + 1` }).where(eq(occurrences.id, pay.occurrenceId));
    await refreshStatus(tx, pay.occurrenceId);
    const occ = await getOccurrenceChecked(tx, walletId, pay.occurrenceId);
    return (await buildRows(tx, [occ], clock))[0]!;
  });
}

export async function clearPayments(db: DB, walletId: string, occurrenceId: string, clock: Clock): Promise<OccurrenceRow> {
  const occ = await getOccurrenceChecked(db, walletId, occurrenceId);
  const pays = await db.query.payments.findMany({ where: eq(payments.occurrenceId, occ.id) });
  let row: OccurrenceRow | null = null;
  for (const p of pays) row = await deletePayment(db, walletId, p.id, clock);
  return row ?? (await buildRows(db, [occ], clock))[0]!;
}
