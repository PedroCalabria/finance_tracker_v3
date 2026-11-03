import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  addMonths,
  addMonthsToDate,
  compareDates,
  monthOf,
  splitInstallments,
  type ISODate,
  type ItemCreateInput,
  type ItemDetail,
  type ItemUpdateInput,
  type Month,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { items, occurrences, payments } from '../db/schema';
import { badRequest, conflict, notFound } from '../http/errors';
import { getAccountChecked, getCategoryChecked } from './catalog';
import type { Clock } from './clock';
import { ensureInvoice, invoiceMonthFor } from './invoice-core';
import { buildRows, projectedRow } from './occurrences';
import { ensureMaterialized, projectionsFor } from './projections';

/**
 * Itens = regras de lançamento (ADR-0004). Criar um item grava suas ocorrências:
 * todas as parcelas de uma vez; recorrentes até o mês atual (o resto é projeção).
 */

type ItemRec = typeof items.$inferSelect;

interface NewOcc {
  competenceMonth: Month;
  installmentNumber: number | null;
  expectedCents: number;
  dueDate: ISODate | null;
  invoiceId: string | null;
}

export async function createItem(db: DB, walletId: string, input: ItemCreateInput, userId: string, clock: Clock): Promise<ItemDetail> {
  return db.transaction(async (tx) => {
    await getCategoryChecked(tx, walletId, input.categoryId, input.type);
    const account = await getAccountChecked(tx, walletId, input.accountId);
    const credit = input.method === 'credit';
    if (credit && account?.kind !== 'credit_card') throw badRequest('Escolha um cartão de crédito.', { accountId: 'Escolha um cartão de crédito.' });
    if (!credit && account?.kind === 'credit_card') throw badRequest('Cartão de crédito só com o método Crédito.', { accountId: 'Escolha uma conta, não um cartão.' });

    const form = input.form;
    // Fora do crédito, a "data p/ pagamento" define o mês; sem ela, vale a data do cadastro.
    const anchor = credit ? input.date : (input.dueDate ?? input.date);
    const [item] = await tx
      .insert(items)
      .values({
        walletId,
        type: input.type,
        form,
        description: input.description,
        categoryId: input.categoryId ?? null,
        method: input.method,
        accountId: account?.id ?? null,
        totalCents: form === 'installment' ? input.amountCents : null,
        installments: form === 'installment' ? input.installments! : null,
        amountCents: form === 'installment' ? null : input.amountCents,
        variableAmount: form === 'recurring' ? !!input.variableAmount : false,
        dueDay: form === 'recurring' && !credit && input.dueDate ? Number(input.dueDate.slice(8, 10)) : null,
        entryDate: input.date,
        startMonth: monthOf(anchor),
        createdBy: userId,
      })
      .returning();

    const planned: NewOcc[] = [];
    if (form === 'single') {
      if (credit) {
        const inv = await ensureInvoice(tx, account!, await invoiceMonthFor(tx, account!, input.date));
        planned.push({ competenceMonth: inv.referenceMonth, installmentNumber: null, expectedCents: input.amountCents, dueDate: inv.dueDate, invoiceId: inv.id });
      } else {
        planned.push({ competenceMonth: monthOf(anchor), installmentNumber: null, expectedCents: input.amountCents, dueDate: input.dueDate ?? null, invoiceId: null });
      }
    } else if (form === 'installment') {
      const parts = splitInstallments(input.amountCents, input.installments!);
      const firstInvoiceMonth = credit ? await invoiceMonthFor(tx, account!, input.date) : null;
      for (let k = 0; k < parts.length; k++) {
        if (credit) {
          const inv = await ensureInvoice(tx, account!, addMonths(firstInvoiceMonth!, k));
          planned.push({ competenceMonth: inv.referenceMonth, installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: inv.dueDate, invoiceId: inv.id });
        } else {
          const due = input.dueDate ? addMonthsToDate(input.dueDate, k) : null;
          planned.push({ competenceMonth: due ? monthOf(due) : addMonths(monthOf(input.date), k), installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: due, invoiceId: null });
        }
      }
    }
    if (planned.length) {
      await tx.insert(occurrences).values(planned.map((p, i) => ({ walletId, itemId: item!.id, ...p, note: i === 0 ? (input.note ?? null) : null })));
    }
    if (form === 'recurring') {
      await ensureMaterialized(tx, walletId, clock);
      if (input.note) {
        const first = await tx.query.occurrences.findFirst({ where: eq(occurrences.itemId, item!.id), orderBy: asc(occurrences.competenceMonth) });
        if (first) await tx.update(occurrences).set({ note: input.note }).where(eq(occurrences.id, first.id));
      }
    }

    // "Já foi pago?" = sim: quita o que já venceu (fora do crédito) com o valor previsto.
    if (input.alreadyPaid && !credit) {
      const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item!.id) });
      const notAfterToday = (d: ISODate) => (compareDates(d, clock.today) > 0 ? clock.today : d);
      for (const o of occs) {
        // Única: paga na data informada. Parcelas/meses: só os que já venceram, na data do vencimento.
        const reference = o.dueDate ?? `${o.competenceMonth}-01`;
        if (form !== 'single' && compareDates(reference, clock.today) > 0) continue;
        const paidAt = notAfterToday(form === 'single' ? input.date : reference);
        await tx.insert(payments).values({ walletId, occurrenceId: o.id, paidAt, amountCents: o.expectedCents, groupId: randomUUID(), paidBy: userId });
        await tx.update(occurrences).set({ status: 'paid' }).where(eq(occurrences.id, o.id));
      }
    }
    return getItemDetail(tx, walletId, item!.id, clock);
  });
}

async function getItemChecked(tx: Tx, walletId: string, id: string): Promise<ItemRec> {
  const item = await tx.query.items.findFirst({ where: and(eq(items.id, id), eq(items.walletId, walletId), isNull(items.deletedAt)) });
  if (!item) throw notFound('Lançamento');
  return item;
}

/** Item com todas as ocorrências (a subgrid). Recorrentes: passado e mês atual; parceladas: todas. */
export async function getItemDetail(tx: Tx, walletId: string, id: string, clock: Clock): Promise<ItemDetail> {
  const item = await getItemChecked(tx, walletId, id);
  const occs = await tx.query.occurrences.findMany({
    where: and(eq(occurrences.itemId, item.id), item.form === 'recurring' ? lte(occurrences.competenceMonth, clock.currentMonth) : undefined),
    orderBy: [asc(occurrences.competenceMonth), asc(occurrences.installmentNumber)],
  });
  let rows = await buildRows(tx, occs, clock);
  if (item.form === 'recurring') {
    // Mostra também o próximo mês projetado, para a pessoa ver o que vem.
    const next = (await projectionsFor(tx, walletId, addMonths(clock.currentMonth, 1), clock)).filter((p) => p.item.id === item.id);
    rows = rows.concat(next.map((p) => projectedRow(p, rows[0]?.category ?? null)));
  }
  return {
    id: item.id,
    type: item.type,
    form: item.form,
    description: item.description,
    method: item.method,
    totalCents: item.totalCents,
    installments: item.installments,
    amountCents: item.amountCents,
    variableAmount: item.variableAmount,
    dueDay: item.dueDay,
    startMonth: item.startMonth,
    endMonth: item.endMonth,
    occurrences: rows,
  };
}

/** Altera a regra. Em recorrentes, o novo valor vale de `fromMonth` (padrão: mês atual) em diante. */
export async function updateItem(db: DB, walletId: string, id: string, input: ItemUpdateInput, clock: Clock): Promise<ItemDetail> {
  return db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.systemKind) throw badRequest('Esse lançamento é criado pela fatura e não pode ser editado.');
    if (input.categoryId !== undefined) await getCategoryChecked(tx, walletId, input.categoryId, item.type);
    if (input.accountId !== undefined) {
      const acc = await getAccountChecked(tx, walletId, input.accountId);
      if (item.method === 'credit' && acc?.id !== item.accountId) throw badRequest('Para trocar o cartão, mova o lançamento de fatura ou cadastre de novo.');
      if (acc?.kind === 'credit_card') throw badRequest('Escolha uma conta, não um cartão.');
    }
    const patch: Partial<ItemRec> = {};
    if (input.description !== undefined) patch.description = input.description;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.accountId !== undefined) patch.accountId = input.accountId;
    if (input.variableAmount !== undefined && item.form === 'recurring') patch.variableAmount = input.variableAmount;
    if (input.dueDay !== undefined && item.form === 'recurring' && item.method !== 'credit') patch.dueDay = input.dueDay;
    if (input.amountCents !== undefined) {
      if (item.form !== 'recurring') throw badRequest('Para mudar o valor de uma parcela, edite a própria parcela.');
      patch.amountCents = input.amountCents;
    }
    await tx
      .update(items)
      .set({ ...patch, version: sql`${items.version} + 1` })
      .where(eq(items.id, item.id));
    if (item.form === 'recurring' && input.amountCents !== undefined) {
      const from = input.fromMonth ?? clock.currentMonth;
      await tx
        .update(occurrences)
        .set({ expectedCents: input.amountCents })
        .where(
          and(
            eq(occurrences.itemId, item.id),
            sql`${occurrences.competenceMonth} >= ${from}`,
            eq(occurrences.status, 'pending'),
            sql`not exists (select 1 from payments p where p.occurrence_id = ${occurrences.id})`,
          ),
        );
    }
    return getItemDetail(tx, walletId, item.id, clock);
  });
}

/** Encerra uma recorrente: o último mês com ocorrência é `lastMonth`; as seguintes sem pagamento somem. */
export async function endRecurring(db: DB, walletId: string, id: string, lastMonth: Month, clock: Clock): Promise<ItemDetail> {
  return db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.form !== 'recurring') throw badRequest('Só lançamentos recorrentes podem ser encerrados.');
    if (lastMonth < addMonths(item.startMonth, -1)) throw badRequest('O encerramento precisa ser depois do início.');
    await tx.update(items).set({ endMonth: lastMonth, version: sql`${items.version} + 1` }).where(eq(items.id, item.id));
    await tx
      .delete(occurrences)
      .where(
        and(
          eq(occurrences.itemId, item.id),
          gt(occurrences.competenceMonth, lastMonth),
          sql`not exists (select 1 from payments p where p.occurrence_id = ${occurrences.id})`,
        ),
      );
    return getItemDetail(tx, walletId, item.id, clock);
  });
}

/** Compra cancelada: parcelas futuras sem pagamento ficam "Cancelado"; as pagas permanecem. */
export async function cancelInstallments(db: DB, walletId: string, id: string, clock: Clock): Promise<ItemDetail> {
  return db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.form !== 'installment') throw badRequest('Só compras parceladas podem ser canceladas.');
    const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id) });
    const invoiceIds = [...new Set(occs.map((o) => o.invoiceId).filter((x): x is string => !!x))];
    const closed = invoiceIds.length
      ? await tx.query.invoices.findMany({ where: (inv, { and: a, inArray: i, ne }) => a(i(inv.id, invoiceIds), ne(inv.status, 'open')), columns: { id: true } })
      : [];
    const closedIds = new Set(closed.map((c) => c.id));
    const toCancel = occs.filter(
      (o) => o.status === 'pending' && o.competenceMonth >= clock.currentMonth && !(o.invoiceId && closedIds.has(o.invoiceId)),
    );
    const withPayments = toCancel.length
      ? await tx.query.payments.findMany({ where: inArray(payments.occurrenceId, toCancel.map((o) => o.id)), columns: { occurrenceId: true } })
      : [];
    const paidIds = new Set(withPayments.map((p) => p.occurrenceId));
    const ids = toCancel.filter((o) => !paidIds.has(o.id)).map((o) => o.id);
    if (ids.length === 0) throw conflict('Não há parcelas futuras em aberto para cancelar.');
    await tx.update(occurrences).set({ status: 'canceled', version: sql`${occurrences.version} + 1` }).where(inArray(occurrences.id, ids));
    return getItemDetail(tx, walletId, item.id, clock);
  });
}

/** Exclusão lógica: o item some das telas; pagamentos e comprovantes ficam no banco. */
export async function deleteItem(db: DB, walletId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.systemKind) throw badRequest('Esse lançamento é criado pela fatura. Desfaça o pagamento da fatura para removê-lo.');
    const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id), columns: { invoiceId: true } });
    const invoiceIds = [...new Set(occs.map((o) => o.invoiceId).filter((x): x is string => !!x))];
    if (invoiceIds.length) {
      const closed = await tx.query.invoices.findFirst({
        where: (inv, { and: a, inArray: i, ne }) => a(i(inv.id, invoiceIds), ne(inv.status, 'open')),
        columns: { id: true },
      });
      if (closed) throw conflict('Este lançamento está numa fatura já paga. Cancele as parcelas futuras em vez de excluir.');
    }
    await tx.update(items).set({ deletedAt: new Date(), version: sql`${items.version} + 1` }).where(eq(items.id, item.id));
  });
}
