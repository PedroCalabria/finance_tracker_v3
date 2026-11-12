import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import {
  addMonths,
  compareDates,
  dateInMonth,
  firstInstallmentDue,
  installmentDueDates,
  monthOf,
  paidTargets,
  recurringRule,
  reimbursementInput,
  splitInstallments,
  type ISODate,
  type ItemCreateInput,
  type ItemDetail,
  type ItemEditInput,
  type ItemUpdateInput,
  type Month,
  type NewSequence,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { accounts, categories, invoicePayments, invoices, items, occurrences, payments, people } from '../db/schema';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { getAccountChecked, getCategoryChecked, getPersonChecked } from './catalog';
import type { Clock } from './clock';
import { chargeMonthResolver, ensureInvoice, invoiceMonthFor } from './invoice-core';
import { payInvoiceTx } from './invoices';
import { buildRows, getOccurrenceChecked, patchOccurrence, projectedRow, refreshStatus } from './occurrences';
import { ensureMaterialized, materializeProjection, invoiceOverrides, parseProjectionId, projectionId, projectionsFor, ruleMonthFor, slotFor } from './projections';

/**
 * Itens = regras de lançamento (ADR-0004). Criar um item grava suas ocorrências:
 * todas as parcelas de uma vez; recorrentes até o mês atual (o resto é projeção).
 */

type ItemRec = typeof items.$inferSelect;
type AccountRec = typeof accounts.$inferSelect;

interface NewOcc {
  competenceMonth: Month;
  /** Mês do gasto (no crédito, o do período de compras da fatura; fora dele, igual a `competenceMonth`). */
  chargeMonth: Month;
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
  opts: {
    /** Uso interno (importação de fatura): a 1ª ocorrência no crédito vai para esta fatura, seja qual for a regra compra × fechamento. */
    invoiceMonth?: Month;
    /** Entrada de reembolso: a despesa que a gerou. */
    reimbursesItemId?: string;
  } = {},
): Promise<ItemDetail> {
  await getCategoryChecked(tx, walletId, input.categoryId, input.type);
  await getPersonChecked(tx, walletId, input.personId);
  const account = await accountForMethod(tx, walletId, input.method, input.accountId);
  const credit = input.method === 'credit';
  const form = input.form;
  const [item] = await tx
    .insert(items)
    .values({ walletId, ...ruleFields(input, account), personId: input.personId ?? null, reimbursesItemId: opts.reimbursesItemId ?? null, createdBy: userId })
    .returning();
  await writeOccurrences(
    tx,
    walletId,
    item!,
    account,
    {
      amountCents: input.amountCents,
      installments: input.installments ?? null,
      dueDate: input.dueDate ?? null,
      note: input.note ?? null,
      invoiceMonth: opts.invoiceMonth,
    },
    clock,
  );

  if (form === 'installment') {
    // Parcelada: "As parcelas de meses anteriores já foram pagas?" (`alreadyPaid` não vale aqui).
    if (input.pastInstallmentsPaid) await payPastInstallments(tx, walletId, item!, userId, clock);
  } else if (input.alreadyPaid && !credit) {
    // "Já foi pago?" = sim: quita o que já venceu (fora do crédito) com o valor previsto.
    const occs = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item!.id) });
    const notAfterToday = (d: ISODate) => (compareDates(d, clock.today) > 0 ? clock.today : d);
    for (const o of occs) {
      // Única: paga na data informada. Meses da recorrente: só os que já venceram, na data do vencimento.
      const reference = o.dueDate ?? `${o.competenceMonth}-01`;
      if (form !== 'single' && compareDates(reference, clock.today) > 0) continue;
      const paidAt = notAfterToday(form === 'single' ? input.date! : reference);
      await tx.insert(payments).values({ walletId, occurrenceId: o.id, paidAt, amountCents: o.expectedCents, groupId: randomUUID(), paidBy: userId });
      await tx.update(occurrences).set({ status: 'paid' }).where(eq(occurrences.id, o.id));
    }
  }

  if (input.createReimbursement) await createReimbursement(tx, walletId, item!, input, userId, clock);
  return getItemDetail(tx, walletId, item!.id, clock);
}

/**
 * Parcelas de competência anterior ao mês atual entram pagas (a do mês atual fica em aberto).
 * - Fora do crédito: pagamento do valor previsto, na data p/ pagamento de cada parcela.
 * - No crédito: paga a fatura passada só se ela existe por causa desta compra (aberta, sem
 *   pagamentos e sem itens de outros lançamentos), pelo total, na data do vencimento (ADR-0005).
 *   Abrir um mês já cria faturas vazias, por isso o critério é "sem outros itens", não "criada agora".
 */
async function payPastInstallments(tx: Tx, walletId: string, item: ItemRec, userId: string, clock: Clock): Promise<void> {
  const past = (await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id) })).filter((o) => o.competenceMonth < clock.currentMonth);
  if (item.method !== 'credit') {
    for (const o of past) {
      const paidAt = o.dueDate ?? `${o.competenceMonth}-01`;
      await tx.insert(payments).values({ walletId, occurrenceId: o.id, paidAt, amountCents: o.expectedCents, groupId: randomUUID(), paidBy: userId });
      await tx.update(occurrences).set({ status: 'paid' }).where(eq(occurrences.id, o.id));
    }
    return;
  }
  for (const o of past) {
    if (!o.invoiceId) continue;
    const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, o.invoiceId) });
    if (!inv || inv.status !== 'open') continue;
    const paid = await tx.query.invoicePayments.findFirst({ where: eq(invoicePayments.invoiceId, inv.id), columns: { id: true } });
    if (paid) continue;
    const [others] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(occurrences)
      .innerJoin(items, eq(items.id, occurrences.itemId))
      .where(and(eq(occurrences.invoiceId, inv.id), sql`${occurrences.itemId} <> ${item.id}`, sql`${occurrences.status} <> 'canceled'`, isNull(items.deletedAt)));
    if (others!.n > 0) continue;
    await payInvoiceTx(tx, walletId, inv.id, { realAmountCents: o.expectedCents, amountCents: o.expectedCents, paidAt: inv.dueDate }, userId, clock);
  }
}

export const REIMBURSEMENT_CATEGORY = 'Gasto de terceiros';

/**
 * Despesa de outra pessoa: cria a entrada de reembolso (mesma transação), no mesmo mês
 * do gasto (`reimbursementInput`), com a categoria "Gasto de terceiros" e o vínculo.
 */
async function createReimbursement(tx: Tx, walletId: string, expense: ItemRec, input: ItemCreateInput, userId: string, clock: Clock): Promise<void> {
  const category = await reimbursementCategory(tx, walletId);
  await createItemTx(
    tx,
    walletId,
    {
      ...reimbursementInput({ ...input, personId: expense.personId, chargeMonth: await firstChargeMonth(tx, expense) }),
      categoryId: category.id,
      // Parcelas de meses anteriores seguem a resposta da despesa (histórico). O "Já foi pago?"
      // da única/recorrente não vale: pagar hoje não quer dizer que a pessoa já devolveu.
      pastInstallmentsPaid: input.pastInstallmentsPaid,
    },
    userId,
    clock,
    { reimbursesItemId: expense.id },
  );
}

/** No crédito, o mês do gasto da 1ª cobrança da despesa (o do período de compras da fatura dela). */
async function firstChargeMonth(tx: Tx, expense: ItemRec): Promise<Month | null> {
  if (expense.method !== 'credit' || !expense.accountId) return null;
  if (expense.form === 'recurring') {
    const account = (await tx.query.accounts.findFirst({ where: eq(accounts.id, expense.accountId) })) ?? null;
    return slotFor(expense, account, expense.startMonth, await invoiceOverrides(tx, expense.accountId)).chargeMonth;
  }
  const first = await tx.query.occurrences.findFirst({ where: eq(occurrences.itemId, expense.id), orderBy: [asc(occurrences.installmentNumber)], columns: { chargeMonth: true } });
  return first?.chargeMonth ?? null;
}

/** A categoria de entrada "Gasto de terceiros" da carteira (ativa); criada na primeira vez. */
async function reimbursementCategory(tx: Tx, walletId: string) {
  const where = and(
    eq(categories.walletId, walletId),
    eq(categories.type, 'income'),
    isNull(categories.archivedAt),
    sql`lower(${categories.name}) = lower(${REIMBURSEMENT_CATEGORY})`,
  );
  const existing = await tx.query.categories.findFirst({ where });
  if (existing) return existing;
  const [created] = await tx.insert(categories).values({ walletId, name: REIMBURSEMENT_CATEGORY, type: 'income' }).returning();
  return created!;
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
  /**
   * Edição estrutural (única/parcelada): diz quais linhas planejadas reaproveitam uma
   * ocorrência paga já existente (índice → id). Essas são atualizadas, não inseridas.
   */
  reuse?: (planned: NewOcc[]) => Map<number, string>,
): Promise<void> {
  const credit = item.method === 'credit';
  const planned: NewOcc[] = [];
  // No crédito, o mês do gasto é o do período de compras da fatura (ADR-0005), não o do vencimento.
  const firstInvoiceMonth = credit && item.form !== 'recurring' ? (input.invoiceMonth ?? (await invoiceMonthFor(tx, account!, item.entryDate))) : null;
  const charge = firstInvoiceMonth ? await chargeMonthResolver(tx, account!, firstInvoiceMonth) : null;
  if (item.form === 'single') {
    if (credit) {
      const inv = await ensureInvoice(tx, account!, firstInvoiceMonth!);
      planned.push({ competenceMonth: inv.referenceMonth, chargeMonth: charge!(inv.referenceMonth), installmentNumber: null, expectedCents: input.amountCents, dueDate: inv.dueDate, invoiceId: inv.id });
    } else {
      const month = monthOf(input.dueDate ?? item.entryDate);
      planned.push({ competenceMonth: month, chargeMonth: month, installmentNumber: null, expectedCents: input.amountCents, dueDate: input.dueDate, invoiceId: null });
    }
  } else if (item.form === 'installment') {
    const parts = splitInstallments(input.amountCents, input.installments!);
    // Fora do crédito, a data do cadastro é a da 1ª parcela; as demais no mesmo dia dos meses seguintes.
    const dues = credit ? [] : installmentDueDates(item.entryDate, parts.length);
    for (let k = 0; k < parts.length; k++) {
      if (credit) {
        const inv = await ensureInvoice(tx, account!, addMonths(firstInvoiceMonth!, k));
        planned.push({ competenceMonth: inv.referenceMonth, chargeMonth: charge!(inv.referenceMonth), installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: inv.dueDate, invoiceId: inv.id });
      } else {
        const month = monthOf(dues[k]!);
        planned.push({ competenceMonth: month, chargeMonth: month, installmentNumber: k + 1, expectedCents: parts[k]!, dueDate: dues[k]!, invoiceId: null });
      }
    }
  }
  if (planned.length) {
    const reused = reuse ? reuse(planned) : new Map<number, string>();
    // Primeiro as reaproveitadas (saem da posição antiga), depois as novas: sem colisão nos índices únicos.
    for (const [i, occurrenceId] of reused) {
      const p = planned[i]!;
      await tx
        .update(occurrences)
        .set({ ...p, version: sql`${occurrences.version} + 1` })
        .where(eq(occurrences.id, occurrenceId));
    }
    const rows = planned.map((p, i) => ({ walletId, itemId: item.id, ...p, note: i === 0 ? input.note : null })).filter((_, i) => !reused.has(i));
    if (rows.length) await tx.insert(occurrences).values(rows);
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
    // Recorrentes: as cobranças gravadas até o mês seguinte (mês do gasto; no crédito, a cobrança
    // deste mês pode contar no seguinte) e, abaixo, a próxima prevista.
    where: and(eq(occurrences.itemId, item.id), item.form === 'recurring' ? lte(occurrences.chargeMonth, addMonths(clock.currentMonth, 1)) : undefined),
    orderBy: [asc(occurrences.competenceMonth), asc(occurrences.installmentNumber)],
  });
  let rows = await buildRows(tx, occs, clock);
  // Em sequência: dentro de uma transação a conexão é uma só.
  const personRec = item.personId ? await tx.query.people.findFirst({ where: eq(people.id, item.personId) }) : undefined;
  const person = personRec ? { id: personRec.id, name: personRec.name } : null;
  if (item.form === 'recurring') {
    // Mostra também o próximo mês projetado, para a pessoa ver o que vem.
    const last = occs.reduce((m, o) => (o.chargeMonth > m ? o.chargeMonth : m), clock.currentMonth);
    const next = (await projectionsFor(tx, walletId, addMonths(last, 1), clock, 'charge')).filter((p) => p.item.id === item.id);
    rows = rows.concat(next.map((p) => projectedRow(p, rows[0]?.category ?? null, person)));
  }
  // Vínculo do reembolso, nos dois sentidos; item excluído não aparece.
  const reimbursement = await tx.query.items.findFirst({
    where: and(eq(items.reimbursesItemId, item.id), isNull(items.deletedAt)),
    columns: { id: true, description: true },
  });
  const reimburses = item.reimbursesItemId
    ? await tx.query.items.findFirst({ where: and(eq(items.id, item.reimbursesItemId), isNull(items.deletedAt)), columns: { id: true, description: true } })
    : undefined;
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
    person,
    reimbursement: reimbursement ?? null,
    reimburses: reimburses ?? null,
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
    // Responsável: mudança simples, vale para o lançamento inteiro e não mexe no item vinculado.
    if (input.personId !== undefined && (input.personId ?? null) !== item.personId) {
      await getPersonChecked(tx, walletId, input.personId, item.personId);
      await tx.update(items).set({ personId: input.personId ?? null }).where(eq(items.id, item.id));
    }
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

/**
 * Recria os meses de um item com a regra nova, mantendo o id e as observações que ainda fazem sentido.
 * Ocorrências com pagamento não são apagadas: ficam (mesmo id, com pagamentos, comprovantes e
 * vínculos de importação) e vão para o lugar equivalente da sequência nova (`paidTargets`).
 */
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
  let kept: typeof old = [];
  if (old.length) {
    const paidRows = await tx.query.payments.findMany({ where: inArray(payments.occurrenceId, old.map((o) => o.id)), columns: { occurrenceId: true } });
    const paidIds = new Set(paidRows.map((p) => p.occurrenceId));
    kept = old.filter((o) => paidIds.has(o.id));
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
  const keptIds = new Set(kept.map((o) => o.id));
  const paidSlots = kept.map((o) => ({ competenceMonth: o.competenceMonth, installmentNumber: o.installmentNumber }));
  const targetsFor = (to: NewSequence) => {
    const r = paidTargets({ fromForm: item.form, typeChanged: input.type !== item.type, toCredit: credit, paid: paidSlots, to });
    if (!r.ok) throw conflict(r.message, 'payments_not_movable');
    return r.targets;
  };
  // Troca de tipo e crédito recusam qualquer que seja a forma: confere antes de mexer em algo.
  if (kept.length && (input.type !== item.type || credit)) targetsFor({ form: 'single' });

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
  // (As ocorrências preservadas guardam a própria observação.)
  const notes = new Map(input.form === item.form ? old.filter((o) => o.note && o.id !== occ.id && !keptIds.has(o.id)).map((o) => [keyOf(o), o.note!] as const) : []);

  await tx.delete(occurrences).where(and(eq(occurrences.itemId, item.id), kept.length ? notInArray(occurrences.id, [...keptIds]) : undefined));
  const [updated] = await tx
    .update(items)
    .set({
      ...ruleFields({ ...input, date, dueDate: input.form === 'single' ? input.dueDate : null }, account),
      endMonth: input.form === 'recurring' && item.form === 'recurring' ? item.endMonth : null,
      version: sql`${items.version} + 1`,
    })
    .where(eq(items.id, item.id))
    .returning();

  // Recorrente: as preservadas viram meses da regra nova antes de gravar; `ensureMaterialized` pula esses meses.
  if (input.form === 'recurring' && kept.length) {
    const targets = targetsFor({ form: 'recurring', startMonth: updated!.startMonth, endMonth: updated!.endMonth });
    for (const [i, o] of kept.entries()) {
      const month = targets[i]!.competenceMonth!;
      await tx
        .update(occurrences)
        .set({
          installmentNumber: null,
          // Preservadas são sempre fora do crédito (crédito não tem pagamento próprio): mês do gasto = mês.
          competenceMonth: month,
          chargeMonth: month,
          dueDate: updated!.dueDay ? dateInMonth(month, updated!.dueDay) : null,
          invoiceId: null,
          // A linha aberta recebe o valor do formulário; os outros meses pagos guardam o que tinham.
          expectedCents: o.id === occ.id ? input.amountCents : o.expectedCents,
          version: sql`${occurrences.version} + 1`,
        })
        .where(eq(occurrences.id, o.id));
    }
  }
  // Única e parcelada: as preservadas recebem a linha planejada equivalente (valor e datas da sequência nova).
  const reuse =
    input.form !== 'recurring' && kept.length
      ? (planned: { competenceMonth: Month }[]) => {
          const targets = targetsFor(input.form === 'single' ? { form: 'single' } : { form: 'installment', months: planned.map((p) => p.competenceMonth) });
          return new Map(kept.map((o, i) => [input.form === 'single' ? 0 : targets[i]!.installmentNumber! - 1, o.id] as const));
        }
      : undefined;
  await writeOccurrences(
    tx,
    walletId,
    updated!,
    account,
    { amountCents: input.amountCents, installments: input.installments ?? null, dueDate: input.form === 'single' && !credit ? (input.dueDate ?? null) : null, note: null },
    clock,
    reuse,
  );
  for (const m of canceledMonths) await cancelMonthIfPresent(tx, walletId, item.id, m, clock);
  for (const o of kept) await refreshStatus(tx, o.id);

  const fresh = await tx.query.occurrences.findMany({ where: eq(occurrences.itemId, item.id) });
  for (const o of fresh) {
    if (keptIds.has(o.id)) continue;
    const note = notes.get(keyOf(o));
    if (note) await tx.update(occurrences).set({ note }).where(eq(occurrences.id, o.id));
  }
  // A observação da linha aberta vai para a ocorrência equivalente na sequência nova
  // (se a linha aberta foi preservada, fica nela mesma).
  if (keptIds.has(occ.id)) {
    if (input.note !== undefined && (input.note || null) !== occ.note) await tx.update(occurrences).set({ note: input.note || null }).where(eq(occurrences.id, occ.id));
  } else if (input.note) {
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

    const charge = await ruleMonthFor(tx, item, month);
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

/**
 * Exclusão lógica: o item some das telas; pagamentos e comprovantes ficam no banco.
 * `withReimbursement`: exclui também a entrada de reembolso vinculada (mesma transação).
 */
export async function deleteItem(db: DB, walletId: string, id: string, opts: { withReimbursement?: boolean } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const item = await getItemChecked(tx, walletId, id);
    if (item.systemKind) throw badRequest('Esse lançamento é criado pela fatura. Desfaça o pagamento da fatura para removê-lo.');
    await softDelete(tx, item);
    if (opts.withReimbursement) {
      const reimbursement = await tx.query.items.findFirst({ where: and(eq(items.reimbursesItemId, item.id), eq(items.walletId, walletId), isNull(items.deletedAt)) });
      if (reimbursement) await softDelete(tx, reimbursement);
    }
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
