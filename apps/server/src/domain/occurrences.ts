import { and, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  compareDates,
  remainingCents,
  statusFromPayments,
  type DisplayStatus,
  type ItemType,
  type Month,
  type OccurrenceRow,
  type OccurrenceUpdateInput,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { accounts, attachments, categories, invoices, items, occurrences, payments } from '../db/schema';
import { badRequest, conflict, notFound } from '../http/errors';
import type { Clock } from './clock';
import { ensureMaterialized, materializeProjection, projectionId, projectionsFor, type ProjectedSlot } from './projections';

/**
 * Ocorrências = as linhas da tabela (ADR-0004). Esta camada monta a linha
 * completa (item, categoria, conta, fatura, pagamentos e comprovantes) e o
 * status exibido, que inclui o "Atrasado" calculado.
 */

type OccRec = typeof occurrences.$inferSelect;
type ItemRec = typeof items.$inferSelect;
type InvoiceRec = typeof invoices.$inferSelect;

export interface OccurrenceFilters {
  month: Month;
  type: ItemType;
  recurring?: boolean;
  onlyOpen?: boolean;
  categoryId?: string;
  accountId?: string;
}

function installmentLabel(item: ItemRec, occ: { installmentNumber: number | null }): string {
  if (item.form === 'recurring') return 'Recorrente';
  if (item.form === 'installment' && occ.installmentNumber) return `${occ.installmentNumber}/${item.installments}`;
  return 'Única';
}

function displayStatus(occ: Pick<OccRec, 'status' | 'competenceMonth'>, invoice: InvoiceRec | null, clock: Clock): { status: DisplayStatus; late: boolean } {
  if (occ.status === 'canceled') return { status: 'canceled', late: false };
  if (invoice) {
    if (invoice.status === 'paid') return { status: 'invoice_paid', late: false };
    if (invoice.status === 'carried') return { status: 'invoice_carried', late: false };
    const late = compareDates(invoice.dueDate, clock.today) < 0;
    return { status: late ? 'invoice_late' : 'invoice_open', late };
  }
  if (occ.status === 'paid') return { status: 'paid', late: false };
  const late = occ.competenceMonth < clock.currentMonth;
  return { status: late ? 'late' : occ.status, late };
}

/** Monta as linhas completas a partir de ocorrências gravadas. */
export async function buildRows(tx: Tx, occs: OccRec[], clock: Clock): Promise<OccurrenceRow[]> {
  if (occs.length === 0) return [];
  const itemIds = [...new Set(occs.map((o) => o.itemId))];
  const itemRecs = await tx.query.items.findMany({ where: inArray(items.id, itemIds) });
  const itemById = new Map(itemRecs.map((i) => [i.id, i]));
  const catIds = [...new Set(itemRecs.map((i) => i.categoryId).filter((x): x is string => !!x))];
  const accIds = [...new Set(itemRecs.map((i) => i.accountId).filter((x): x is string => !!x))];
  const invIds = [...new Set(occs.map((o) => o.invoiceId).filter((x): x is string => !!x))];
  // Em sequência: dentro de uma transação a conexão é uma só.
  const cats = catIds.length ? await tx.query.categories.findMany({ where: inArray(categories.id, catIds) }) : [];
  const accs = accIds.length ? await tx.query.accounts.findMany({ where: inArray(accounts.id, accIds) }) : [];
  const invs = invIds.length ? await tx.query.invoices.findMany({ where: inArray(invoices.id, invIds) }) : [];
  const pays = await tx.query.payments.findMany({ where: inArray(payments.occurrenceId, occs.map((o) => o.id)), orderBy: payments.paidAt });
  const groupIds = [...new Set(pays.map((p) => p.groupId))];
  const atts = groupIds.length
    ? await tx.query.attachments.findMany({ where: and(inArray(attachments.paymentGroupId, groupIds), isNull(attachments.deletedAt)) })
    : [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const accById = new Map(accs.map((a) => [a.id, a]));
  const invById = new Map(invs.map((i) => [i.id, i]));

  return occs.map((occ) => {
    const item = itemById.get(occ.itemId)!;
    const cat = item.categoryId ? catById.get(item.categoryId) : undefined;
    const acc = item.accountId ? accById.get(item.accountId) : undefined;
    const inv = occ.invoiceId ? (invById.get(occ.invoiceId) ?? null) : null;
    const myPays = pays.filter((p) => p.occurrenceId === occ.id);
    const paidCents = myPays.reduce((s, p) => s + p.amountCents, 0);
    const { status, late } = displayStatus(occ, inv, clock);
    return {
      id: occ.id,
      projected: false,
      itemId: item.id,
      type: item.type,
      form: item.form,
      systemKind: item.systemKind,
      description: item.description,
      category: cat ? { id: cat.id, name: cat.name } : null,
      method: item.method,
      account: acc ? { id: acc.id, name: acc.name, bank: acc.bank, kind: acc.kind } : null,
      competenceMonth: occ.competenceMonth,
      installmentNumber: occ.installmentNumber,
      installmentsTotal: item.form === 'installment' ? item.installments : null,
      installmentLabel: installmentLabel(item, occ),
      expectedCents: occ.expectedCents,
      paidCents,
      remainingCents: inv ? 0 : remainingCents(occ.expectedCents, paidCents, occ.status),
      dueDate: occ.dueDate,
      status: occ.status,
      displayStatus: status,
      late,
      settledWithDiscount: occ.settledWithDiscount,
      note: occ.note,
      payments: myPays.map((p) => ({
        id: p.id,
        paidAt: p.paidAt,
        amountCents: p.amountCents,
        groupId: p.groupId,
        paidBy: p.paidBy,
        attachments: atts.filter((a) => a.paymentGroupId === p.groupId).map((a) => ({ id: a.id, name: a.name, mime: a.mime, sizeBytes: a.sizeBytes })),
      })),
      invoice: inv ? { id: inv.id, referenceMonth: inv.referenceMonth, status: inv.status, dueDate: inv.dueDate } : null,
      variableAmount: item.variableAmount,
      version: occ.version,
    };
  });
}

/** Linha virtual de uma recorrente projetada (mês futuro). */
export function projectedRow(p: ProjectedSlot, cat: { id: string; name: string } | null): OccurrenceRow {
  const item = p.item;
  return {
    id: projectionId(item.id, p.competenceMonth),
    projected: true,
    itemId: item.id,
    type: item.type,
    form: item.form,
    systemKind: null,
    description: item.description,
    category: cat,
    method: item.method,
    account: p.account ? { id: p.account.id, name: p.account.name, bank: p.account.bank, kind: p.account.kind } : null,
    competenceMonth: p.competenceMonth,
    installmentNumber: null,
    installmentsTotal: null,
    installmentLabel: 'Recorrente',
    expectedCents: p.expectedCents,
    paidCents: 0,
    remainingCents: item.method === 'credit' ? 0 : p.expectedCents,
    dueDate: p.dueDate,
    status: 'pending',
    displayStatus: item.method === 'credit' ? 'invoice_open' : 'pending',
    late: false,
    settledWithDiscount: false,
    note: null,
    payments: [],
    invoice: null,
    variableAmount: item.variableAmount,
    version: 0,
  };
}

const sortRows = (a: OccurrenceRow, b: OccurrenceRow) => {
  // Atrasados primeiro, depois por data p/ pagamento (sem data no fim), depois por nome.
  if (a.late !== b.late) return a.late ? -1 : 1;
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return compareDates(a.dueDate, b.dueDate);
  }
  return a.description.localeCompare(b.description, 'pt-BR');
};

export async function listOccurrences(db: DB, walletId: string, f: OccurrenceFilters, clock: Clock): Promise<OccurrenceRow[]> {
  await ensureMaterialized(db, walletId, clock);
  const monthCond: SQL =
    f.month === clock.currentMonth
      ? // No mês atual também entram os atrasados de meses anteriores (fora do crédito).
        or(
          eq(occurrences.competenceMonth, f.month),
          and(lt(occurrences.competenceMonth, f.month), inArray(occurrences.status, ['pending', 'partial']), isNull(occurrences.invoiceId)),
        )!
      : eq(occurrences.competenceMonth, f.month);
  const conds: SQL[] = [eq(occurrences.walletId, walletId), monthCond, eq(items.type, f.type), isNull(items.deletedAt)];
  if (f.recurring) conds.push(inArray(items.form, ['installment', 'recurring']));
  if (f.categoryId) conds.push(eq(items.categoryId, f.categoryId));
  if (f.accountId) conds.push(eq(items.accountId, f.accountId));
  const recs = await db
    .select({ occ: occurrences })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .where(and(...conds));
  let rows = await buildRows(
    db,
    recs.map((r) => r.occ),
    clock,
  );

  const projections = (await projectionsFor(db, walletId, f.month, clock)).filter(
    (p) => p.item.type === f.type && (!f.categoryId || p.item.categoryId === f.categoryId) && (!f.accountId || p.item.accountId === f.accountId),
  );
  if (projections.length) {
    const cats = await db.query.categories.findMany({ where: eq(categories.walletId, walletId) });
    rows = rows.concat(
      projections.map((p) => {
        const c = cats.find((x) => x.id === p.item.categoryId);
        return projectedRow(p, c ? { id: c.id, name: c.name } : null);
      }),
    );
  }
  if (f.onlyOpen) rows = rows.filter((r) => !['paid', 'canceled', 'invoice_paid', 'invoice_carried'].includes(r.displayStatus));
  return rows.sort(sortRows);
}

export async function getOccurrenceChecked(tx: Tx, walletId: string, id: string): Promise<OccRec> {
  const occ = await tx.query.occurrences.findFirst({ where: and(eq(occurrences.id, id), eq(occurrences.walletId, walletId)) });
  if (!occ) throw notFound('Lançamento');
  return occ;
}

export async function getRow(tx: Tx, walletId: string, id: string, clock: Clock): Promise<OccurrenceRow> {
  const occ = await getOccurrenceChecked(tx, walletId, id);
  return (await buildRows(tx, [occ], clock))[0]!;
}

/**
 * Edita só esta ocorrência (valor previsto, data, observação). Numa recorrente,
 * mudar o valor previsto também muda a regra dali em diante (ADR-0004).
 */
export async function updateOccurrence(db: DB, walletId: string, id: string, input: OccurrenceUpdateInput, clock: Clock): Promise<OccurrenceRow> {
  return db.transaction(async (tx) => {
    const realId = await materializeProjection(tx, walletId, id, clock);
    const occ = await getOccurrenceChecked(tx, walletId, realId);
    if (input.version !== undefined && input.version !== 0 && input.version !== occ.version) throw conflict();
    const item = (await tx.query.items.findFirst({ where: eq(items.id, occ.itemId) }))!;
    if (occ.invoiceId && input.dueDate !== undefined) throw badRequest('No crédito, a data vem do vencimento da fatura.');
    if (item.systemKind && input.expectedCents !== undefined) throw badRequest('Esse valor é calculado pela fatura.');
    await patchOccurrence(tx, occ, item, input);
    return getRow(tx, walletId, occ.id, clock);
  });
}

/**
 * Grava valor previsto, data e observação de uma ocorrência já validada. Numa
 * recorrente, o valor novo vira a regra e os meses seguintes em aberto acompanham.
 */
export async function patchOccurrence(
  tx: Tx,
  occ: OccRec,
  item: ItemRec,
  input: { expectedCents?: number; dueDate?: string | null; note?: string | null; competenceMonth?: Month },
): Promise<void> {
  const patch: Partial<OccRec> = {};
  if (input.expectedCents !== undefined) patch.expectedCents = input.expectedCents;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.note !== undefined) patch.note = input.note || null;
  if (input.competenceMonth !== undefined) patch.competenceMonth = input.competenceMonth;
  await tx
    .update(occurrences)
    .set({ ...patch, version: sql`${occurrences.version} + 1` })
    .where(eq(occurrences.id, occ.id));
  if (input.expectedCents !== undefined && item.form === 'recurring') {
    await tx.update(items).set({ amountCents: input.expectedCents, version: sql`${items.version} + 1` }).where(eq(items.id, item.id));
    // Meses seguintes já gravados e sem pagamento acompanham o novo valor.
    await tx
      .update(occurrences)
      .set({ expectedCents: input.expectedCents })
      .where(
        and(
          eq(occurrences.itemId, item.id),
          sql`${occurrences.competenceMonth} > ${occ.competenceMonth}`,
          eq(occurrences.status, 'pending'),
          sql`not exists (select 1 from payments p where p.occurrence_id = ${occurrences.id})`,
        ),
      );
  }
  if (occ.status !== 'canceled' && !occ.invoiceId && input.expectedCents !== undefined) await refreshStatus(tx, occ.id);
}

/** Recalcula o status gravado a partir dos pagamentos (fora do crédito). */
export async function refreshStatus(tx: Tx, occurrenceId: string): Promise<void> {
  const occ = (await tx.query.occurrences.findFirst({ where: eq(occurrences.id, occurrenceId) }))!;
  if (occ.status === 'canceled' || occ.invoiceId) return;
  const [r] = await tx
    .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(eq(payments.occurrenceId, occ.id));
  const paid = r?.paid ?? 0;
  const discount = paid > 0 && occ.settledWithDiscount;
  await tx
    .update(occurrences)
    .set({ status: statusFromPayments(occ.expectedCents, paid, discount), settledWithDiscount: discount })
    .where(eq(occurrences.id, occ.id));
}
