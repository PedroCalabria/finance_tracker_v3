import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  addMonths,
  compareDates,
  dateInMonth,
  firstInstallmentDue,
  installmentDueDates,
  monthOf,
  recurringRule,
  splitInstallments,
  type ISODate,
  type ItemCreateInput,
  type ItemDetail,
  type ItemEditInput,
  type ItemUpdateInput,
  type Month,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { accounts, items, occurrences, payments } from '../db/schema';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { getAccountChecked, getCategoryChecked } from './catalog';
import type { Clock } from './clock';
import { ensureInvoice, invoiceMonthFor } from './invoice-core';
import { buildRows, getOccurrenceChecked, patchOccurrence, projectedRow } from './occurrences';
import { chargeMonthFor, ensureMaterialized, materializeProjection, parseProjectionId, projectionId, projectionsFor } from './projections';

/**
 * Itens = regras de lançamento (ADR-0004). Criar um item grava suas ocorrências:
 * todas as parcelas de uma vez; recorrentes até o mês atual (o resto é projeção).
 */

type ItemRec = typeof items.$inferSelect;
type AccountRec = typeof accounts.$inferSelect;

interface NewOcc {
  competenceMonth: Month;
  installmentNumber: number | null;
  expectedCents: number;
  dueDate: ISODate | null;
  invoiceId: string | null;
}

export async function createItem(db: DB, walletId: string, input: ItemCreateInput, userId: string, clock: Clock): Promise<ItemDetail> {
  return db.transaction((tx) => createItemTx(tx, walletId, input, userId, clock));
}

/** Mesma regra de `createItem`, dentro de uma transação já aberta (importação, ADR-0010). */
export async function createItemTx(
  tx: Tx,
  walletId: string,
  input: ItemCreateInput,
  userId: string,
  clock: Clock,
  /** Uso interno (importação de fatura): a 1ª ocorrência no crédito vai para esta fatura, seja qual for a regra compra × fechamento. */
  opts: { invoiceMonth?: Month } = {},
): Promise<ItemDetail> {
  await getCategoryChecked(tx, walletId, input.categoryId, input.type);
  const account = await accountForMethod(tx, walletId, input.method, input.accountId);
  const credit = input.method === 'credit';
  const form = input.form;
  const [item] = await tx
    .insert(items)
    .values({ walletId, ...ruleFields(input, account), createdBy: userId })
    .returning();
  await writeOccurrences(
    tx,
    walletId,
    item!,
    account,
    { amountCents: input.amountCents, installments: input.installments ?? null, dueDate: input.dueDate ?? null, note: input.note ?? null, invoiceMonth: opts.invoiceMonth },
    clock,
  );

  // "Já foi pago?" = sim: quita o que já venceu (fora do crédito) com o valor previsto.
  if (input.alreadyPaid && !credit) {
    const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item!.id) });
    const notAfterToday = (d: ISODate) => (compareDates(d, clock.today) > 0 ? clock.today : d);
    for (const o of occs) {
      // Única: paga na data informada. Parcelas/meses: só os que já venceram, na data do vencimento.
      const reference = o.dueDate ?? `${o.competenceMonth}-01`;
      if (form !== 'single' && compareDates(reference, clock.today) > 0) continue;
      const paidAt = notAfterToday(form === 'single' ? input.date! : reference);
      await tx.insert(payments).values({ walletId, occurrenceId: o.id, paidAt, amountCents: o.expectedCents, groupId: randomUUID(), paidBy: userId });
      await tx.update(occurrences).set({ status: 'paid' }).where(eq(occurrences.id, o.id));
    }
  }
  return getItemDetail(tx, walletId, item!.id, clock);
}

interface RuleInput {
  type: ItemRec['type'];
  form: ItemRec['form'];
  description: string;
  categoryId?: string | null;
  method: ItemRec['method'];
  amountCents: number;
  installments?: number | null;
  variableAmount?: boolean;
  /** Única: data do cadastro. Parcelada: data da compra (crédito) ou da 1ª parcela (fora do crédito). */
  date?: ISODate | null;
  /** Única fora do crédito: data p/ pagamento. */
  dueDate?: ISODate | null;
  /** Recorrente: mês de início e dia (ADR-0004). */
  startMonth?: Month | null;
  day?: number | null;
}

/** Campos da regra a partir do que foi informado no cadastro (ou na edição que recria os meses). */
function ruleFields(input: RuleInput, account: AccountRec | null) {
  const credit = input.method === 'credit';
  const form = input.form;
  let dates: { dueDay: number | null; entryDate: ISODate; startMonth: Month };
  if (form === 'recurring') {
    dates = recurringRule({ method: input.method, startMonth: input.startMonth!, day: input.day });
  } else {
    // Única fora do crédito: a "data p/ pagamento" define o mês; sem ela, vale a data.
    // Parcelada fora do crédito: a data já é a da 1ª parcela. Crédito: a data da compra.
    const anchor = form === 'single' && !credit ? (input.dueDate ?? input.date!) : input.date!;
    dates = { dueDay: null, entryDate: input.date!, startMonth: monthOf(anchor) };
  }
  return {
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
    ...dates,
  };
}

/** Cartão só com o método Crédito, e o Crédito sempre com cartão. */
async function accountForMethod(tx: Tx, walletId: string, method: ItemRec['method'], accountId: string | null | undefined): Promise<AccountRec | null> {
  const account = await getAccountChecked(tx, walletId, accountId);
  const credit = method === 'credit';
  if (credit && account?.kind !== 'credit_card') throw badRequest('Escolha um cartão de crédito.', { accountId: 'Escolha um cartão de crédito.' });
  if (!credit && account?.kind === 'credit_card') throw badRequest('Cartão de crédito só com o método Crédito.', { accountId: 'Escolha uma conta, não um cartão.' });
  return account;
}

/**
 * Grava as ocorrências de um item recém-gravado (ou recriado): todas as parcelas;
 * recorrentes até o mês atual. A observação vai para a primeira.
 */
async function writeOccurrences(
  tx: Tx,
  walletId: string,
  item: ItemRec,
  account: AccountRec | null,
  input: { amountCents: number; installments: number | null; dueDate: ISODate | null; note: string | null; invoiceMonth?: Month },
  clock: Clock,
): Promise<void> {
  const credit = item.method === 'credit';
  const planned: NewOcc[] = [];
  if (item.form === 'single') {
    if (credit) {
      const inv = await ensureInvoice(tx, account!, input.invoiceMonth ?? (await invoiceMonthFor(tx, account!, item.entryDate)));
      planned.push({ competenceMonth: inv.referenceMonth, installmentNumber: null, expectedCents: input.amountCents, dueDate: inv.dueDate, invoiceId: inv.id });
    } else {
      planned.push({ competenceMonth: monthOf(input.dueDate ?? item.entryDate), installmentNumber: null, expectedCents: input.amountCents, dueDate: input.dueDate, invoiceId: null });
    }
  } else if (item.form === 'installment') {
    const parts = splitInstallments(input.amountCents, input.installments!);
    const firstInvoiceMonth = credit ? (input.invoiceMonth ?? (await invoiceMonthFor(tx, account!, item.entryDate))) : null;
    // Fora do crédito, a data do cadastro é a da 1ª parcela; as demais no mesmo dia dos meses seguintes.
    const dues = credit ? [] : installmentDueDates(item.entryDate, parts.length);
    for (let k = 0; k < parts.length; k++) {
      if (credit) {
        const inv = await ensureInvoice(tx, account!, addMonths(firstInvoiceMonth!, k));
        planned.push({ competenceMonth: inv.referenceMonth, installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: inv.dueDate, invoiceId: inv.id });
      } else {
        planned.push({ competenceMonth: monthOf(dues[k]!), installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: dues[k]!, invoiceId: null });
      }
    }
  }
  if (planned.length) {
    await tx.insert(occurrences).values(planned.map((p, i) => ({ walletId, itemId: item.id, ...p, note: i === 0 ? input.note : null })));
  }
  if (item.form === 'recurring') {
    await ensureMaterialized(tx, walletId, clock);
    if (input.note) {
      const first = await tx.query.occurrences.findFirst({ where: eq(occurrences.itemId, item.id), orderBy: asc(occurrences.competenceMonth) });
      if (first) await tx.update(occurrences).set({ note: input.note }).where(eq(occurrences.id, first.id));
    }
  }
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
    entryDate: item.entryDate,
    categoryId: item.categoryId,
    accountId: item.accountId,
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

/**
 * Edição completa a partir de uma linha (ADR-0004). Mudanças simples (descrição,
 * categoria, método fora do crédito, conta, valor, datas deste mês, observação)
 * são gravadas no lugar e preservam os pagamentos. Mudanças estruturais (tipo,
 * forma, parcelas, valor total, entrar ou sair do crédito, trocar o cartão, data
 * de parcelada ou recorrente) recriam os meses, como num cadastro novo; por isso
 * só valem enquanto não houver pagamento nem fatura paga.
 */
export async function editItem(db: DB, walletId: string, id: string, input: ItemEditInput, clock: Clock): Promise<ItemDetail> {
  return db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.systemKind) throw badRequest('Esse lançamento é criado pela fatura e não pode ser editado.');
    const projected = parseProjectionId(input.occurrenceId);
    if (projected && projected.itemId !== item.id) throw notFound('Lançamento');
    const occ = await getOccurrenceChecked(tx, walletId, await materializeProjection(tx, walletId, input.occurrenceId, clock));
    if (occ.itemId !== item.id) throw notFound('Lançamento');
    if (input.version !== undefined && input.version !== 0 && input.version !== occ.version) throw conflict();

    await getCategoryChecked(tx, walletId, input.categoryId, input.type);
    const account = await accountForMethod(tx, walletId, input.method, input.accountId);
    const credit = input.method === 'credit';
    const wasCredit = item.method === 'credit';
    const structural =
      input.type !== item.type ||
      input.form !== item.form ||
      credit !== wasCredit ||
      (credit && account!.id !== item.accountId) ||
      (input.form === 'installment' && (input.installments !== item.installments || input.amountCents !== item.totalCents)) ||
      datesChanged(item, occ, input);

    if (structural) {
      await rebuild(tx, walletId, item, occ, account, input, clock);
      return getItemDetail(tx, walletId, item.id, clock);
    }

    // Mudança simples: a regra muda no lugar; a linha aberta recebe o que é "deste mês".
    // Só a única fora do crédito tem data p/ pagamento própria aqui; na parcelada mudar a data é estrutural.
    const singleDue = item.form === 'single' && !credit ? (input.dueDate ?? null) : occ.dueDate;
    const patch: Partial<ItemRec> = {
      description: input.description,
      categoryId: input.categoryId ?? null,
      method: input.method,
      accountId: account?.id ?? null,
    };
    if (item.form === 'single' || (item.form === 'installment' && credit)) patch.entryDate = input.date!;
    if (item.form === 'recurring') patch.variableAmount = !!input.variableAmount;
    // Recorrente fora do crédito: o dia vale do mês aberto em diante.
    const newDay = input.day ?? null;
    const dayChanged = item.form === 'recurring' && !credit && newDay !== item.dueDay;
    if (dayChanged) {
      patch.dueDay = newDay;
      patch.entryDate = dateInMonth(item.startMonth, newDay ?? 1);
    }
    await tx
      .update(items)
      .set({ ...patch, version: sql`${items.version} + 1` })
      .where(eq(items.id, item.id));

    const expected = item.form === 'installment' ? input.occurrenceCents : input.amountCents;
    const occPatch: Parameters<typeof patchOccurrence>[3] = {};
    if (expected !== undefined && expected !== occ.expectedCents) occPatch.expectedCents = expected;
    if (item.form === 'single' && !credit && singleDue !== occ.dueDate) occPatch.dueDate = singleDue;
    if (input.note !== undefined && (input.note || null) !== occ.note) occPatch.note = input.note || null;
    // Única fora do crédito: o mês acompanha a data p/ pagamento (ou a data, sem ela).
    if (item.form === 'single' && !credit) {
      const month = monthOf(singleDue ?? input.date!);
      if (month !== occ.competenceMonth) occPatch.competenceMonth = month;
    }
    if (Object.keys(occPatch).length) await patchOccurrence(tx, occ, { ...item, ...patch }, occPatch);
    if (dayChanged) await applyDueDayFrom(tx, item.id, occ.competenceMonth, newDay);
    return getItemDetail(tx, walletId, item.id, clock);
  });
}

/**
 * As datas mudaram a ponto de recriar os meses? (com a forma igual; mudar a forma já é estrutural)
 * - recorrente: mês de início; no crédito, também o dia da cobrança (muda a fatura de cada mês);
 * - parcelada fora do crédito: a data desta parcela (sem data antes e sem data agora não conta: cadastro antigo);
 * - crédito (única ou parcelada): a data da compra.
 */
function datesChanged(item: ItemRec, occ: typeof occurrences.$inferSelect, input: ItemEditInput): boolean {
  const credit = input.method === 'credit';
  if (input.form === 'recurring') {
    if (input.startMonth !== item.startMonth) return true;
    return credit && input.day !== Number(item.entryDate.slice(8, 10));
  }
  if (input.form === 'installment' && !credit) return (input.dueDate ?? null) !== occ.dueDate;
  return credit && input.date !== item.entryDate;
}

/** Recorrente: o dia novo vale para o mês aberto e para os seguintes já gravados, pendentes e sem pagamento. */
async function applyDueDayFrom(tx: Tx, itemId: string, fromMonth: Month, day: number | null): Promise<void> {
  const later = await tx.query.occurrences.findMany({
    where: and(
      eq(occurrences.itemId, itemId),
      sql`${occurrences.competenceMonth} >= ${fromMonth}`,
      eq(occurrences.status, 'pending'),
      sql`not exists (select 1 from payments p where p.occurrence_id = ${occurrences.id})`,
    ),
  });
  for (const o of later) {
    const due = day ? dateInMonth(o.competenceMonth, day) : null;
    if (due !== o.dueDate) await tx.update(occurrences).set({ dueDate: due, version: sql`${occurrences.version} + 1` }).where(eq(occurrences.id, o.id));
  }
}

/** Recria os meses de um item com a regra nova, mantendo o id e as observações que ainda fazem sentido. */
async function rebuild(
  tx: Tx,
  walletId: string,
  item: ItemRec,
  occ: typeof occurrences.$inferSelect,
  account: AccountRec | null,
  input: ItemEditInput,
  clock: Clock,
): Promise<void> {
  const old = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id) });
  if (old.length) {
    const paid = await tx.query.payments.findFirst({ where: inArray(payments.occurrenceId, old.map((o) => o.id)), columns: { id: true } });
    if (paid) {
      throw conflict(
        item.form === 'recurring'
          ? 'Essa mudança recalcula todos os meses, mas este lançamento já tem meses pagos. Encerre a recorrência e cadastre de novo.'
          : 'Essa mudança recalcula todos os meses, mas este lançamento já tem pagamento registrado. Desfaça o pagamento antes ou cadastre de novo.',
      );
    }
    const invoiceIds = [...new Set(old.map((o) => o.invoiceId).filter((x): x is string => !!x))];
    if (invoiceIds.length) {
      const closed = await tx.query.invoices.findFirst({
        where: (inv, { and: a, inArray: i, ne }) => a(i(inv.id, invoiceIds), ne(inv.status, 'open')),
        columns: { id: true },
      });
      if (closed) throw conflict('Essa mudança recalcula as faturas, mas parte deste lançamento está numa fatura já paga. Cancele as parcelas futuras e cadastre de novo.');
    }
  }

  const credit = input.method === 'credit';
  // Parcelada fora do crédito: a data da linha aberta, recuada até a 1ª posição, é a da primeira.
  // Se a forma mudou, a linha aberta vira a primeira. Sem data (cadastro antigo), vale a data anterior.
  const position = input.form === item.form && item.form === 'installment' ? (occ.installmentNumber ?? 1) : 1;
  const date =
    input.form === 'installment' && !credit
      ? input.dueDate
        ? firstInstallmentDue(input.dueDate, position)
        : (input.date ?? item.entryDate)
      : (input.date ?? null);
  const k = position - 1;
  // Meses excluídos com "Só este mês" continuam excluídos (recorrente → recorrente).
  const canceledMonths = input.form === 'recurring' && item.form === 'recurring' ? old.filter((o) => o.status === 'canceled').map((o) => o.competenceMonth) : [];

  // Observações antigas voltam para a mesma parcela (ou mês), se a forma não mudou.
  const keyOf = (o: { installmentNumber: number | null; competenceMonth: string }) => (o.installmentNumber ? `#${o.installmentNumber}` : o.competenceMonth);
  const notes = new Map(input.form === item.form ? old.filter((o) => o.note && o.id !== occ.id).map((o) => [keyOf(o), o.note!] as const) : []);

  await tx.delete(occurrences).where(eq(occurrences.itemId, item.id));
  const [updated] = await tx
    .update(items)
    .set({
      ...ruleFields({ ...input, date, dueDate: input.form === 'single' ? input.dueDate : null }, account),
      endMonth: input.form === 'recurring' && item.form === 'recurring' ? item.endMonth : null,
      version: sql`${items.version} + 1`,
    })
    .where(eq(items.id, item.id))
    .returning();
  await writeOccurrences(
    tx,
    walletId,
    updated!,
    account,
    { amountCents: input.amountCents, installments: input.installments ?? null, dueDate: input.form === 'single' && !credit ? (input.dueDate ?? null) : null, note: null },
    clock,
  );
  for (const m of canceledMonths) await cancelMonthIfPresent(tx, walletId, item.id, m, clock);

  const fresh = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id) });
  for (const o of fresh) {
    const note = notes.get(keyOf(o));
    if (note) await tx.update(occurrences).set({ note }).where(eq(occurrences.id, o.id));
  }
  // A observação da linha aberta vai para a ocorrência equivalente na sequência nova.
  if (input.note) {
    let targetId: string | undefined;
    if (input.form === 'single') targetId = fresh[0]?.id;
    else if (input.form === 'installment') targetId = fresh.find((o) => o.installmentNumber === Math.min(k + 1, input.installments!))?.id;
    else {
      targetId = fresh.find((o) => o.competenceMonth === occ.competenceMonth)?.id;
      if (!targetId && occ.competenceMonth > clock.currentMonth) {
        const slots = (await projectionsFor(tx, walletId, occ.competenceMonth, clock)).filter((p) => p.item.id === item.id);
        if (slots.length) targetId = await materializeProjection(tx, walletId, projectionId(item.id, occ.competenceMonth), clock);
      }
    }
    if (targetId) await tx.update(occurrences).set({ note: input.note }).where(eq(occurrences.id, targetId));
  }
}

/** Reaplica "Só este mês" depois de recriar os meses, se o mês ainda existir na sequência nova. */
async function cancelMonthIfPresent(tx: Tx, walletId: string, itemId: string, month: Month, clock: Clock): Promise<void> {
  let id = (
    await tx.query.occurrences.findFirst({
      where: and(eq(occurrences.itemId, itemId), eq(occurrences.competenceMonth, month), isNull(occurrences.installmentNumber)),
      columns: { id: true },
    })
  )?.id;
  if (!id && month > clock.currentMonth) {
    const slots = (await projectionsFor(tx, walletId, month, clock)).filter((p) => p.item.id === itemId);
    if (slots.length) id = await materializeProjection(tx, walletId, projectionId(itemId, month), clock);
  }
  if (id) await tx.update(occurrences).set({ status: 'canceled' }).where(eq(occurrences.id, id));
}

/**
 * "Este e os próximos" (ADR-0004): encerra a recorrência no mês de cobrança anterior
 * ao da ocorrência escolhida (que pode ser projeção) e apaga os meses dali em diante.
 * Recusa se houver pagamento, ou fatura não aberta, nesse mês ou depois. Na primeira
 * ocorrência equivale a excluir toda a recorrência: devolve `null`.
 */
export async function endRecurringFrom(db: DB, walletId: string, id: string, occurrenceId: string, clock: Clock): Promise<ItemDetail | null> {
  return db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.form !== 'recurring') throw new AppError(400, 'not_recurring', 'Só lançamentos recorrentes podem ser encerrados.');
    let month: Month;
    const projected = parseProjectionId(occurrenceId);
    if (projected) {
      if (projected.itemId !== item.id) throw notFound('Lançamento');
      month = projected.month;
    } else {
      const occ = await getOccurrenceChecked(tx, walletId, occurrenceId);
      if (occ.itemId !== item.id) throw notFound('Lançamento');
      month = occ.competenceMonth;
    }

    const later = await tx.query.occurrences.findMany({ where: and(eq(occurrences.itemId, item.id), gte(occurrences.competenceMonth, month)) });
    if (later.length) {
      const paid = await tx.query.payments.findFirst({ where: inArray(payments.occurrenceId, later.map((o) => o.id)), columns: { id: true } });
      const invoiceIds = [...new Set(later.map((o) => o.invoiceId).filter((x): x is string => !!x))];
      const closed = invoiceIds.length
        ? await tx.query.invoices.findFirst({ where: (inv, { and: a, inArray: i, ne }) => a(i(inv.id, invoiceIds), ne(inv.status, 'open')), columns: { id: true } })
        : undefined;
      if (paid || closed) throw conflict('Há pagamento neste mês ou depois. Desfaça esses pagamentos antes de encerrar.', 'later_months_paid');
    }

    const charge = await chargeMonthFor(tx, item, month);
    if (charge <= item.startMonth) {
      await softDelete(tx, item);
      return null;
    }
    await tx
      .update(items)
      .set({ endMonth: addMonths(charge, -1), version: sql`${items.version} + 1` })
      .where(eq(items.id, item.id));
    await tx.delete(occurrences).where(and(eq(occurrences.itemId, item.id), gte(occurrences.competenceMonth, month)));
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
    await softDelete(tx, item);
  });
}

/** Exclusão lógica, recusada se alguma parte estiver numa fatura já paga. */
async function softDelete(tx: Tx, item: ItemRec): Promise<void> {
  const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id), columns: { invoiceId: true } });
  const invoiceIds = [...new Set(occs.map((o) => o.invoiceId).filter((x): x is string => !!x))];
  if (invoiceIds.length) {
    const closed = await tx.query.invoices.findFirst({
      where: (inv, { and: a, inArray: i, ne }) => a(i(inv.id, invoiceIds), ne(inv.status, 'open')),
      columns: { id: true },
    });
    if (closed) {
      throw conflict(
        item.form === 'recurring'
          ? 'Esta recorrência tem um mês numa fatura já paga. Use "Este e os próximos" num mês em aberto para encerrá-la.'
          : 'Este lançamento está numa fatura já paga. Cancele as parcelas futuras em vez de excluir.',
      );
    }
  }
  await tx.update(items).set({ deletedAt: new Date(), version: sql`${items.version} + 1` }).where(eq(items.id, item.id));
}
