import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  addMonths,
  budgetFor,
  buildPlan,
  compareDates,
  currentAnchor,
  diffMonths,
  effectiveOrder,
  estimateBalance,
  initialAnchor,
  monthOf,
  normalizeDebtTerms,
  orderDebts,
  paidInMonthAfterAnchor,
  recalcAfterExtra,
  remainingInstallments,
  simulatePlan,
  type DebtAnchorInput,
  type DebtBudgetRow,
  type DebtCreateInput,
  type DebtDetail,
  type DebtMonthBudget,
  type DebtPaymentInput,
  type DebtPaymentLite,
  type DebtPaymentUpdateInput,
  type DebtPlan,
  type DebtRow,
  type DebtSettings,
  type DebtStrategy,
  type DebtUpdateInput,
  type ISODate,
  type Month,
  type PlanDebt,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { debtBalanceAnchors, debtBudgets, debtPayments, debts, debtSettings, people } from '../db/schema';
import { AppError, conflict, notFound } from '../http/errors';
import type { Clock } from './clock';

/**
 * Gestão de dívidas (ADR-0011). Módulo isolado: nada aqui lê ou grava lançamentos, ocorrências,
 * pagamentos ou faturas da tabela do mês. O saldo sai da âncora vigente e dos pagamentos próprios.
 */

type DebtRec = typeof debts.$inferSelect;
type AnchorRec = typeof debtBalanceAnchors.$inferSelect;
type PaymentRec = typeof debtPayments.$inferSelect;

const validation = (field: string, message: string) => new AppError(400, 'validation', message, { [field]: message });
const notAfterToday = (date: ISODate, clock: Clock, field = 'date') => {
  if (compareDates(date, clock.today) > 0) throw validation(field, 'A data não pode ser depois de hoje.');
};
const debtNotActive = () => new AppError(409, 'debt_not_active', 'Esta dívida não está ativa.');

const lite = (p: PaymentRec): DebtPaymentLite => ({ date: p.date, amountCents: p.amountCents, kind: p.kind });

interface Loaded {
  debt: DebtRec;
  anchors: AnchorRec[];
  payments: PaymentRec[];
  creditorPerson: { id: string; name: string } | null;
}

/** Carrega dívidas não excluídas da carteira com âncoras, pagamentos e credor. Consultas em sequência (uma conexão na tx). */
async function load(tx: Tx, walletId: string, ids?: string[]): Promise<Loaded[]> {
  const rows = await tx.query.debts.findMany({
    where: and(eq(debts.walletId, walletId), isNull(debts.deletedAt), ids ? inArray(debts.id, ids) : undefined),
    orderBy: [asc(debts.createdAt), asc(debts.id)],
  });
  if (!rows.length) return [];
  const debtIds = rows.map((d) => d.id);
  const anchors = await tx.select().from(debtBalanceAnchors).where(inArray(debtBalanceAnchors.debtId, debtIds));
  const payments = await tx
    .select()
    .from(debtPayments)
    .where(inArray(debtPayments.debtId, debtIds))
    .orderBy(asc(debtPayments.date), asc(debtPayments.createdAt));
  const personIds = [...new Set(rows.map((d) => d.creditorPersonId).filter((x): x is string => !!x))];
  const persons = personIds.length ? await tx.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : [];
  return rows.map((debt) => ({
    debt,
    anchors: anchors.filter((a) => a.debtId === debt.id),
    payments: payments.filter((p) => p.debtId === debt.id),
    creditorPerson: persons.find((p) => p.id === debt.creditorPersonId) ?? null,
  }));
}

async function loadOne(tx: Tx, walletId: string, id: string): Promise<Loaded> {
  const [one] = await load(tx, walletId, [id]);
  if (!one) throw notFound('Dívida');
  return one;
}

function toRow(l: Loaded, clock: Clock): DebtRow {
  const { debt: d } = l;
  const anchor = currentAnchor(l.anchors)!;
  const initial = initialAnchor(l.anchors)!;
  const payments = l.payments.map(lite);
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    creditorName: d.creditorName,
    creditorPerson: l.creditorPerson,
    structure: d.structure,
    monthlyRatePpm: d.monthlyRatePpm,
    installmentCents: d.installmentCents,
    remainingInstallments: remainingInstallments(d.remainingInstallments, d.contractAsOf, payments),
    contractRemainingInstallments: d.remainingInstallments,
    contractAsOf: d.contractAsOf,
    dueDay: d.dueDay,
    minPaymentKind: d.minPaymentKind,
    minPaymentValue: d.minPaymentValue,
    acceptsExtra: d.acceptsExtra,
    status: d.status,
    paidOffOn: d.paidOffOn,
    position: d.position,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    balanceCents: estimateBalance(anchor, d.monthlyRatePpm, payments, clock.today),
    initial: { date: initial.date, balanceCents: initial.balanceCents },
    anchor: { date: anchor.date, balanceCents: anchor.balanceCents },
    paidCents: payments.reduce((s, p) => s + p.amountCents, 0),
  };
}

function toDetail(l: Loaded, clock: Clock): DebtDetail {
  const row = toRow(l, clock);
  return {
    ...row,
    anchors: [...l.anchors].sort((a, b) => compareDates(b.date, a.date)).map((a) => ({ id: a.id, date: a.date, balanceCents: a.balanceCents })),
    payments: [...l.payments]
      .sort((a, b) => compareDates(b.date, a.date) || b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({
        id: p.id,
        date: p.date,
        amountCents: p.amountCents,
        kind: p.kind,
        extraEffect: p.extraEffect,
        version: p.version,
        beforeAnchor: compareDates(p.date, row.anchor.date) <= 0,
      })),
  };
}

/** Pessoa da carteira; arquivada só se já é a atual. */
async function checkPerson(tx: Tx, walletId: string, personId: string | null | undefined, currentId: string | null = null): Promise<void> {
  if (!personId) return;
  const p = await tx.query.people.findFirst({ where: and(eq(people.id, personId), eq(people.walletId, walletId)) });
  if (!p || (p.archivedAt && p.id !== currentId)) throw validation('creditorPersonId', 'Escolha uma pessoa da carteira.');
}

async function nextPosition(tx: Tx, walletId: string): Promise<number> {
  const [r] = await tx.select({ m: max(debts.position) }).from(debts).where(and(eq(debts.walletId, walletId), isNull(debts.deletedAt)));
  return (r?.m ?? 0) + 1;
}

/** Versão conferida: 404 se não existe, 409 `conflict` se mudou. */
async function assertVersion(tx: Tx, walletId: string, id: string, version: number): Promise<DebtRec> {
  const d = await tx.query.debts.findFirst({ where: and(eq(debts.id, id), eq(debts.walletId, walletId), isNull(debts.deletedAt)) });
  if (!d) throw notFound('Dívida');
  if (d.version !== version) throw conflict();
  return d;
}

const bump = { version: sql`${debts.version} + 1` };

// ---------- Dívidas

export async function listDebts(db: DB, walletId: string, clock: Clock): Promise<DebtRow[]> {
  return (await load(db, walletId)).map((l) => toRow(l, clock));
}

export async function getDebt(db: Tx, walletId: string, id: string, clock: Clock): Promise<DebtDetail> {
  return toDetail(await loadOne(db, walletId, id), clock);
}

export async function createDebt(db: DB, walletId: string, input: DebtCreateInput, userId: string, clock: Clock): Promise<DebtDetail> {
  notAfterToday(input.anchorDate, clock, 'anchorDate');
  return db.transaction(async (tx) => {
    await checkPerson(tx, walletId, input.creditorPersonId);
    const [row] = await tx
      .insert(debts)
      .values({
        walletId,
        name: input.name,
        category: input.category,
        creditorName: input.creditorPersonId ? null : input.creditorName || null,
        creditorPersonId: input.creditorPersonId ?? null,
        ...normalizeDebtTerms(input),
        contractAsOf: input.anchorDate,
        acceptsExtra: input.acceptsExtra,
        position: await nextPosition(tx, walletId),
        createdBy: userId,
      })
      .returning();
    await tx.insert(debtBalanceAnchors).values({ walletId, debtId: row!.id, date: input.anchorDate, balanceCents: input.anchorBalanceCents });
    return getDebt(tx, walletId, row!.id, clock);
  });
}

export async function updateDebt(db: DB, walletId: string, id: string, input: DebtUpdateInput, clock: Clock): Promise<DebtDetail> {
  return db.transaction(async (tx) => {
    const current = await assertVersion(tx, walletId, id, input.version);
    await checkPerson(tx, walletId, input.creditorPersonId, current.creditorPersonId);
    const loaded = await loadOne(tx, walletId, id);
    const nowRemaining = remainingInstallments(current.remainingInstallments, current.contractAsOf, loaded.payments.map(lite));
    const terms = normalizeDebtTerms(input);
    // Mudou o contrato (parcela, parcelas restantes ou estrutura)? Ele passa a valer a partir de hoje.
    const contractChanged =
      terms.structure !== current.structure || terms.installmentCents !== current.installmentCents || terms.remainingInstallments !== nowRemaining;
    await tx
      .update(debts)
      .set({
        name: input.name,
        category: input.category,
        creditorName: input.creditorPersonId ? null : input.creditorName || null,
        creditorPersonId: input.creditorPersonId ?? null,
        ...terms,
        acceptsExtra: input.acceptsExtra,
        ...(contractChanged ? { contractAsOf: clock.today } : {}),
        ...bump,
      })
      .where(eq(debts.id, id));
    return getDebt(tx, walletId, id, clock);
  });
}

export async function deleteDebt(db: DB, walletId: string, id: string): Promise<void> {
  const [row] = await db
    .update(debts)
    .set({ deletedAt: new Date(), ...bump })
    .where(and(eq(debts.id, id), eq(debts.walletId, walletId), isNull(debts.deletedAt)))
    .returning({ id: debts.id });
  if (!row) throw notFound('Dívida');
}

// ---------- Âncoras ("Atualizar saldo")

export async function addAnchor(db: DB, walletId: string, id: string, input: DebtAnchorInput, clock: Clock): Promise<DebtDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const { debt } = await loadOne(tx, walletId, id);
    await tx
      .insert(debtBalanceAnchors)
      .values({ walletId, debtId: id, date: input.date, balanceCents: input.balanceCents })
      .onConflictDoUpdate({ target: [debtBalanceAnchors.debtId, debtBalanceAnchors.date], set: { balanceCents: input.balanceCents } });
    const contract = debt.structure === 'price' || debt.structure === 'sac';
    const withContract = contract && (input.remainingInstallments != null || (debt.structure === 'price' && input.installmentCents != null));
    if (withContract) {
      await tx
        .update(debts)
        .set({
          remainingInstallments: input.remainingInstallments ?? debt.remainingInstallments,
          installmentCents: debt.structure === 'price' ? (input.installmentCents ?? debt.installmentCents) : null,
          contractAsOf: input.date,
          ...bump,
        })
        .where(eq(debts.id, id));
    }
    return getDebt(tx, walletId, id, clock);
  });
}

export async function deleteAnchor(db: DB, walletId: string, id: string, anchorId: string, clock: Clock): Promise<DebtDetail> {
  return db.transaction(async (tx) => {
    const { anchors } = await loadOne(tx, walletId, id);
    if (!anchors.some((a) => a.id === anchorId)) throw notFound('Saldo');
    if (anchors.length <= 1) throw new AppError(409, 'last_anchor', 'A dívida precisa ter pelo menos um saldo informado.');
    await tx.delete(debtBalanceAnchors).where(eq(debtBalanceAnchors.id, anchorId));
    return getDebt(tx, walletId, id, clock);
  });
}

// ---------- Pagamentos

export async function addPayment(db: DB, walletId: string, id: string, input: DebtPaymentInput, userId: string, clock: Clock): Promise<DebtDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const { debt } = l;
    if (debt.status !== 'active') throw debtNotActive();
    const contract = debt.structure === 'price' || debt.structure === 'sac';
    if (input.kind === 'extra' && !debt.acceptsExtra) throw new AppError(409, 'extra_not_allowed', 'Esta dívida não aceita amortização extra.');
    if (input.kind === 'extra' && contract && !input.extraEffect) throw validation('extraEffect', 'Escolha reduzir prazo ou reduzir parcela.');
    const effect = input.kind === 'extra' && contract ? input.extraEffect! : null;

    const anchor = currentAnchor(l.anchors)!;
    const before = l.payments.map(lite);
    await tx.insert(debtPayments).values({
      walletId,
      debtId: id,
      date: input.date,
      amountCents: input.amountCents,
      kind: input.kind,
      extraEffect: effect,
      paidBy: userId,
    });

    // Amortização extra em Price/SAC: grava o contrato confirmado (ou o sugerido, se não veio) a partir da data do pagamento.
    if (effect) {
      let next = input.contract ?? null;
      if (!next && compareDates(input.date, anchor.date) > 0) {
        const nowRemaining = remainingInstallments(debt.remainingInstallments, debt.contractAsOf, before);
        const balanceBefore = estimateBalance(anchor, debt.monthlyRatePpm, before, input.date);
        next = recalcAfterExtra(
          { structure: debt.structure, monthlyRatePpm: debt.monthlyRatePpm, installmentCents: debt.installmentCents, remainingInstallments: nowRemaining },
          balanceBefore,
          Math.max(0, balanceBefore - input.amountCents),
          effect,
        );
      }
      if (next) {
        await tx
          .update(debts)
          .set({
            installmentCents: debt.structure === 'price' ? (next.installmentCents ?? debt.installmentCents) : null,
            remainingInstallments: next.remainingInstallments ?? debt.remainingInstallments,
            contractAsOf: input.date,
            ...bump,
          })
          .where(eq(debts.id, id));
      }
    }
    return getDebt(tx, walletId, id, clock);
  });
}

export async function updatePayment(
  db: DB,
  walletId: string,
  id: string,
  paymentId: string,
  input: DebtPaymentUpdateInput,
  clock: Clock,
): Promise<DebtDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const pay = l.payments.find((p) => p.id === paymentId);
    if (!pay) throw notFound('Pagamento');
    if (pay.version !== input.version) throw conflict();
    if (input.kind === 'extra' && !l.debt.acceptsExtra) throw new AppError(409, 'extra_not_allowed', 'Esta dívida não aceita amortização extra.');
    // O contrato não volta sozinho (ADR-0011): só o pagamento muda.
    await tx
      .update(debtPayments)
      .set({
        date: input.date,
        amountCents: input.amountCents,
        kind: input.kind,
        extraEffect: input.kind === 'extra' ? pay.extraEffect : null,
        version: sql`${debtPayments.version} + 1`,
      })
      .where(eq(debtPayments.id, paymentId));
    return getDebt(tx, walletId, id, clock);
  });
}

export async function deletePayment(db: DB, walletId: string, id: string, paymentId: string, clock: Clock): Promise<DebtDetail> {
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    if (!l.payments.some((p) => p.id === paymentId)) throw notFound('Pagamento');
    await tx.delete(debtPayments).where(eq(debtPayments.id, paymentId));
    return getDebt(tx, walletId, id, clock);
  });
}

// ---------- Quitar e reabrir

export async function payOff(db: DB, walletId: string, id: string, input: { date: ISODate; finalPayment?: boolean }, userId: string, clock: Clock): Promise<DebtDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    if (l.debt.status !== 'active') throw debtNotActive();
    if (input.finalPayment) {
      const balance = estimateBalance(currentAnchor(l.anchors)!, l.debt.monthlyRatePpm, l.payments.map(lite), input.date);
      if (balance > 0) {
        await tx.insert(debtPayments).values({ walletId, debtId: id, date: input.date, amountCents: balance, kind: 'installment', paidBy: userId });
      }
    }
    await tx.update(debts).set({ status: 'paid_off', paidOffOn: input.date, ...bump }).where(eq(debts.id, id));
    return getDebt(tx, walletId, id, clock);
  });
}

export async function reopen(db: DB, walletId: string, id: string, clock: Clock): Promise<DebtDetail> {
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    if (l.debt.status === 'active') return getDebt(tx, walletId, id, clock);
    await tx
      .update(debts)
      .set({ status: 'active', paidOffOn: null, position: await nextPosition(tx, walletId), ...bump })
      .where(eq(debts.id, id));
    return getDebt(tx, walletId, id, clock);
  });
}

// ---------- Estratégia e ordem manual

async function readSettings(tx: Tx, walletId: string): Promise<DebtSettings> {
  const s = await tx.query.debtSettings.findFirst({ where: eq(debtSettings.walletId, walletId) });
  return { strategy: s?.strategy ?? 'avalanche', manualOrderSet: s?.manualOrderSet ?? false };
}

export async function getSettings(db: DB, walletId: string): Promise<DebtSettings> {
  return readSettings(db, walletId);
}

/** Escolher "Minha ordem" pela primeira vez grava as posições na ordem da avalanche. */
export async function setSettings(db: DB, walletId: string, strategy: DebtStrategy, clock: Clock): Promise<DebtSettings> {
  return db.transaction(async (tx) => {
    const current = await readSettings(tx, walletId);
    let manualOrderSet = current.manualOrderSet;
    if (strategy === 'manual' && !manualOrderSet) {
      const rows = (await load(tx, walletId)).filter((l) => l.debt.status === 'active').map((l) => toRow(l, clock));
      const ordered = orderDebts(rows, 'avalanche');
      await writePositions(tx, ordered.map((r) => r.id));
      manualOrderSet = true;
    }
    await tx
      .insert(debtSettings)
      .values({ walletId, strategy, manualOrderSet })
      .onConflictDoUpdate({ target: debtSettings.walletId, set: { strategy, manualOrderSet } });
    return { strategy, manualOrderSet };
  });
}

async function writePositions(tx: Tx, ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) await tx.update(debts).set({ position: i + 1 }).where(eq(debts.id, id));
}

/** Grava a ordem manual: exatamente as dívidas ativas. */
export async function setOrder(db: DB, walletId: string, ids: string[]): Promise<DebtSettings> {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: debts.id })
      .from(debts)
      .where(and(eq(debts.walletId, walletId), isNull(debts.deletedAt), eq(debts.status, 'active')));
    const expected = new Set(active.map((a) => a.id));
    if (ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some((id) => !expected.has(id))) {
      throw validation('ids', 'A ordem precisa ter todas as dívidas ativas, uma vez cada.');
    }
    await writePositions(tx, ids);
    const s = await readSettings(tx, walletId);
    await tx
      .insert(debtSettings)
      .values({ walletId, strategy: s.strategy, manualOrderSet: true })
      .onConflictDoUpdate({ target: debtSettings.walletId, set: { manualOrderSet: true } });
    return { strategy: s.strategy, manualOrderSet: true };
  });
}

// ---------- Orçamento

export async function listBudgets(db: Tx, walletId: string): Promise<DebtBudgetRow[]> {
  const rows = await db.select().from(debtBudgets).where(eq(debtBudgets.walletId, walletId)).orderBy(asc(debtBudgets.fromMonth));
  return rows.map((b) => ({ fromMonth: b.fromMonth, amountCents: b.amountCents }));
}

export async function putBudget(db: DB, walletId: string, fromMonth: Month, amountCents: number): Promise<DebtBudgetRow[]> {
  await db
    .insert(debtBudgets)
    .values({ walletId, fromMonth, amountCents })
    .onConflictDoUpdate({ target: [debtBudgets.walletId, debtBudgets.fromMonth], set: { amountCents } });
  return listBudgets(db, walletId);
}

export async function deleteBudget(db: DB, walletId: string, fromMonth: Month): Promise<DebtBudgetRow[]> {
  const [row] = await db
    .delete(debtBudgets)
    .where(and(eq(debtBudgets.walletId, walletId), eq(debtBudgets.fromMonth, fromMonth)))
    .returning({ m: debtBudgets.fromMonth });
  if (!row) throw notFound('Orçamento');
  return listBudgets(db, walletId);
}

// ---------- Plano de quitação

const BUDGET_MONTHS_SHOWN = 12;

/** Dívidas ativas na forma da simulação (saldo estimado hoje e o que já foi pago no mês atual depois da âncora). */
function planDebtsOf(loaded: Loaded[], clock: Clock): PlanDebt[] {
  const current = clock.currentMonth;
  const active = loaded.filter((l) => l.debt.status === 'active');
  return active.map((l) => {
    const row = toRow(l, clock);
    return {
      id: row.id,
      name: row.name,
      structure: row.structure,
      monthlyRatePpm: row.monthlyRatePpm,
      installmentCents: row.installmentCents,
      remainingInstallments: row.remainingInstallments,
      minPaymentKind: row.minPaymentKind,
      minPaymentValue: row.minPaymentValue,
      acceptsExtra: row.acceptsExtra,
      balanceCents: row.balanceCents,
      paidThisMonthCents: paidInMonthAfterAnchor(l.payments.map(lite), row.anchor.date, current),
      createdAt: row.createdAt,
      position: row.position,
    };
  });
}

/** Destinado por mês: pagamentos de dívidas não excluídas (ativas e quitadas). */
function spentByMonth(loaded: Loaded[]): Map<Month, number> {
  const spentBy = new Map<Month, number>();
  for (const l of loaded) for (const p of l.payments) spentBy.set(monthOf(p.date), (spentBy.get(monthOf(p.date)) ?? 0) + p.amountCents);
  return spentBy;
}

export async function getPlan(db: DB, walletId: string, clock: Clock): Promise<DebtPlan> {
  const loaded = await load(db, walletId);
  const budgets = await listBudgets(db, walletId);
  const settings = await readSettings(db, walletId);
  const current = clock.currentMonth;
  const planDebts = planDebtsOf(loaded, clock);
  const spentBy = spentByMonth(loaded);

  const plan = buildPlan({
    debts: planDebts,
    budgets,
    currentMonth: current,
    spentThisMonthCents: spentBy.get(current) ?? 0,
    strategy: settings.strategy,
    manualOrderSet: settings.manualOrderSet,
  });

  const firstMonths = [...budgets.map((b) => b.fromMonth), ...spentBy.keys()].filter((m) => m <= current).sort();
  const budgetMonths: DebtMonthBudget[] = [];
  if (firstMonths.length) {
    const span = diffMonths(firstMonths[0]!, current);
    for (let k = Math.max(0, span - BUDGET_MONTHS_SHOWN + 1); k <= span; k++) {
      const m = addMonths(firstMonths[0]!, k);
      budgetMonths.push({ month: m, plannedCents: budgetFor(budgets, m), spentCents: spentBy.get(m) ?? 0, inProgress: m === current });
    }
    budgetMonths.reverse();
  }

  return {
    currentMonth: current,
    strategy: settings.strategy,
    manualOrderSet: settings.manualOrderSet,
    order: plan.order,
    totals: {
      balanceCents: planDebts.reduce((s, d) => s + d.balanceCents, 0),
      payoffMonth: planDebts.some((d) => d.balanceCents > 0) ? plan.simulation.payoffMonth : null,
      interestCents: plan.simulation.totalInterestCents,
      budgetCents: budgetFor(budgets, current),
    },
    perDebt: plan.simulation.perDebt.map((p) => ({ id: p.id, payoffMonth: p.payoffMonth, interestCents: p.interestCents, timeline: p.timeline ?? [] })),
    comparison: plan.comparison,
    warnings: plan.simulation.warnings,
    budgetMonths,
  };
}

/**
 * Amortização extra no resumo do mês (ADR-0011, ADR-0012). As parcelas e mínimos obrigatórios já estão nos
 * gastos da tabela do mês e ficam fora.
 * - pago: pagamentos do tipo `extra` no mês, de dívidas não excluídas;
 * - planejado: null em meses passados; no mês atual, o pago + a sobra que o plano ainda aplica; nos futuros,
 *   a sobra aplicada pela simulação naquele mês (orçamento − obrigatórios, em cascata e limitada aos saldos).
 */
export async function debtExtraForMonth(db: DB, walletId: string, month: Month, clock: Clock): Promise<{ plannedCents: number | null; paidCents: number }> {
  const loaded = await load(db, walletId);
  let paidCents = 0;
  for (const l of loaded) for (const p of l.payments) if (p.kind === 'extra' && monthOf(p.date) === month) paidCents += p.amountCents;
  const current = clock.currentMonth;
  if (month < current) return { plannedCents: null, paidCents };
  const budgets = await listBudgets(db, walletId);
  const settings = await readSettings(db, walletId);
  const sim = simulatePlan({
    debts: effectiveOrder(planDebtsOf(loaded, clock), settings.strategy, settings.manualOrderSet),
    budgets,
    currentMonth: current,
    spentThisMonthCents: spentByMonth(loaded).get(current) ?? 0,
  });
  const extra = sim.extraByMonth[diffMonths(current, month)] ?? 0;
  return { plannedCents: month === current ? paidCents + extra : extra, paidCents };
}
