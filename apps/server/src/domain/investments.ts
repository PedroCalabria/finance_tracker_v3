import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  compareDates,
  currentAnchor,
  effectiveMonthlyPpm,
  formatBRL,
  formatDateBR,
  lastDayOf,
  monthOf,
  normalizeInvestmentTerms,
  pastSeries,
  projectInvestment,
  sumSeries,
  taxByBracket,
  taxIfRedeemedAll,
  walkInvestment,
  withdrawalTax,
  type InvestmentAnchorInput,
  type InvestmentCloseInput,
  type InvestmentCreateInput,
  type InvestmentDetail,
  type InvestmentIcon,
  type InvestmentMovementInput,
  type InvestmentMovementUpdateInput,
  type InvestmentOverview,
  type InvestmentRow,
  type InvestmentSettings,
  type InvestmentUpdateInput,
  type ISODate,
  type Month,
  type MovementLite,
} from '@ff/shared';
import type { DB, Tx } from '../db/client';
import { investmentBalanceAnchors, investmentMovements, investments, investmentSettings } from '../db/schema';
import { AppError, conflict, notFound } from '../http/errors';
import type { Clock } from './clock';

/**
 * Investimentos em caixinhas (ADR-0012). Módulo isolado: nada aqui lê ou grava lançamentos, ocorrências,
 * pagamentos ou faturas. O saldo sai da caminhada pelas movimentações e âncoras (`walkInvestment`).
 * Só o resumo do mês lê este módulo (`monthInvestmentTotals`).
 */

type InvRec = typeof investments.$inferSelect;
type MoveRec = typeof investmentMovements.$inferSelect;
type AnchorRec = typeof investmentBalanceAnchors.$inferSelect;

const PAST_MONTHS = 12;
const PROJECTION_MONTHS = 24;

// ---------- Recusas (códigos estáveis, mensagens prontas)

const validation = (field: string, message: string) => new AppError(400, 'validation', message, { [field]: message });
const notAfterToday = (date: ISODate, clock: Clock, field = 'date') => {
  if (compareDates(date, clock.today) > 0) throw validation(field, 'A data não pode ser depois de hoje.');
};
const notActive = () => new AppError(409, 'investment_not_active', 'Esta caixinha está encerrada. Reabra para movimentar.');
const lockedUntil = (date: ISODate) => new AppError(409, 'locked_until', `Só pode resgatar a partir de ${formatDateBR(date)}.`);
const exceedsBalance = (balance: number) =>
  new AppError(409, 'withdrawal_exceeds_balance', `O resgate é maior que o saldo estimado (${formatBRL(balance)}). Se o banco mostra mais, atualize o saldo da caixinha.`);
const beforeInitial = (date: ISODate) =>
  new AppError(409, 'movement_before_initial', `A data não pode ser anterior ao valor inicial (${formatDateBR(date)}).`);
const initialRequired = () => new AppError(409, 'initial_movement_required', 'O valor inicial não pode ser excluído. Edite o valor ou a data.');
const investmentNotFound = () => new AppError(404, 'investment_not_found', 'Caixinha não encontrada.');

// ---------- Carga

interface Loaded {
  inv: InvRec;
  movements: MoveRec[];
  anchors: AnchorRec[];
}

/** Caixinhas não excluídas da carteira com movimentações e âncoras. Consultas em sequência (uma conexão na tx). */
async function load(tx: Tx, walletId: string, ids?: string[]): Promise<Loaded[]> {
  const rows = await tx.query.investments.findMany({
    where: and(eq(investments.walletId, walletId), isNull(investments.deletedAt), ids ? inArray(investments.id, ids) : undefined),
    orderBy: [asc(investments.createdAt), asc(investments.id)],
  });
  if (!rows.length) return [];
  const invIds = rows.map((r) => r.id);
  const movements = await tx
    .select()
    .from(investmentMovements)
    .where(inArray(investmentMovements.investmentId, invIds))
    .orderBy(asc(investmentMovements.date), asc(investmentMovements.createdAt));
  const anchors = await tx.select().from(investmentBalanceAnchors).where(inArray(investmentBalanceAnchors.investmentId, invIds));
  return rows.map((inv) => ({
    inv,
    movements: movements.filter((m) => m.investmentId === inv.id),
    anchors: anchors.filter((a) => a.investmentId === inv.id),
  }));
}

async function loadOne(tx: Tx, walletId: string, id: string): Promise<Loaded> {
  const [one] = await load(tx, walletId, [id]);
  if (!one) throw investmentNotFound();
  return one;
}

async function readSettings(tx: Tx, walletId: string): Promise<InvestmentSettings> {
  const s = await tx.query.investmentSettings.findFirst({ where: eq(investmentSettings.walletId, walletId) });
  return { cdiAnnualPpm: s?.cdiAnnualPpm ?? null, cdiUpdatedOn: s?.cdiUpdatedOn ?? null };
}

const liteOf = (m: MoveRec): MovementLite => ({ date: m.date, kind: m.kind, amountCents: m.amountCents });
const anchorsOf = (l: Loaded) => l.anchors.map((a) => ({ date: a.date, balanceCents: a.balanceCents }));
const rateOf = (inv: InvRec, s: InvestmentSettings) => effectiveMonthlyPpm(inv, s.cdiAnnualPpm);
const initialOf = (l: Loaded) => l.movements.find((m) => m.kind === 'initial')!;
const isLocked = (inv: InvRec, date: ISODate) => inv.redeemableFrom !== null && compareDates(date, inv.redeemableFrom) < 0;

// ---------- Linhas

function toRow(l: Loaded, s: InvestmentSettings, clock: Clock): InvestmentRow {
  const { inv } = l;
  const rate = rateOf(inv, s);
  const walk = walkInvestment(l.movements.map(liteOf), anchorsOf(l), rate, clock.today);
  const tax = taxIfRedeemedAll(walk, clock.today, inv.taxMode);
  const active = inv.status === 'active';
  const proj = projectInvestment({
    walk,
    ratePpm: rate,
    monthlyPlanCents: active ? inv.monthlyPlanCents : null,
    goalCents: active ? inv.goalCents : null,
    goalMonth: active ? inv.goalMonth : null,
    redeemableFrom: active ? inv.redeemableFrom : null,
    taxMode: inv.taxMode,
    today: clock.today,
    horizonMonths: 0,
  });
  const anchor = currentAnchor(l.anchors);
  const initial = initialOf(l);
  return {
    id: inv.id,
    name: inv.name,
    icon: inv.icon as InvestmentIcon,
    kind: inv.kind,
    yieldKind: inv.yieldKind,
    fixedRatePpm: inv.fixedRatePpm,
    cdiShareBp: inv.cdiShareBp,
    redeemableFrom: inv.redeemableFrom,
    taxMode: inv.taxMode,
    goalCents: inv.goalCents,
    goalMonth: inv.goalMonth,
    monthlyPlanCents: inv.monthlyPlanCents,
    status: inv.status,
    closedOn: inv.closedOn,
    version: inv.version,
    createdAt: inv.createdAt.toISOString(),
    effectiveRatePpm: rate,
    grossCents: walk.grossCents,
    principalCents: walk.principalCents,
    yieldCents: walk.yieldCents,
    taxTodayCents: tax.totalCents,
    netTodayCents: walk.grossCents - tax.totalCents,
    monthlyYieldCents: active ? proj.monthlyYieldCents : 0,
    anchor: anchor ? { date: anchor.date, balanceCents: anchor.balanceCents } : null,
    initial: { date: initial.date, amountCents: initial.amountCents },
    goal: proj.goal,
    atRedeem: proj.atRedeem,
    locked: active && isLocked(inv, clock.today),
    depositedThisMonthCents: l.movements
      .filter((m) => m.kind === 'deposit' && monthOf(m.date) === clock.currentMonth)
      .reduce((sum, m) => sum + m.amountCents, 0),
  };
}

function toDetail(l: Loaded, s: InvestmentSettings, clock: Clock): InvestmentDetail {
  const row = toRow(l, s, clock);
  const walk = walkInvestment(l.movements.map(liteOf), anchorsOf(l), row.effectiveRatePpm, clock.today);
  return {
    ...row,
    movements: [...l.movements]
      .sort((a, b) => compareDates(b.date, a.date) || b.createdAt.getTime() - a.createdAt.getTime())
      .map((m) => ({
        id: m.id,
        date: m.date,
        kind: m.kind,
        amountCents: m.amountCents,
        taxCents: m.taxCents,
        version: m.version,
        beforeAnchor: row.anchor !== null && compareDates(m.date, row.anchor.date) <= 0,
      })),
    anchors: [...l.anchors].sort((a, b) => compareDates(b.date, a.date)).map((a) => ({ id: a.id, date: a.date, balanceCents: a.balanceCents })),
    taxByBracket: taxByBracket(taxIfRedeemedAll(walk, clock.today, l.inv.taxMode)),
  };
}

async function detail(tx: Tx, walletId: string, id: string, clock: Clock): Promise<InvestmentDetail> {
  return toDetail(await loadOne(tx, walletId, id), await readSettings(tx, walletId), clock);
}

// ---------- Leitura

export async function listInvestments(db: DB, walletId: string, clock: Clock): Promise<InvestmentRow[]> {
  const loaded = await load(db, walletId);
  const s = await readSettings(db, walletId);
  return loaded.map((l) => toRow(l, s, clock));
}

export async function getInvestment(db: DB, walletId: string, id: string, clock: Clock): Promise<InvestmentDetail> {
  return detail(db, walletId, id, clock);
}

/** Totais, "este mês", série dos 12 meses passados, projeção de 24 meses e avisos. */
export async function getOverview(db: DB, walletId: string, clock: Clock): Promise<InvestmentOverview> {
  const loaded = await load(db, walletId);
  const s = await readSettings(db, walletId);
  const rows = loaded.map((l) => toRow(l, s, clock));
  const active = rows.filter((r) => r.status === 'active');
  const past = sumSeries(loaded.map((l) => pastSeries(l.movements.map(liteOf), anchorsOf(l), rateOf(l.inv, s), clock.today, PAST_MONTHS)));
  const projection = sumSeries(
    loaded
      .filter((l) => l.inv.status === 'active')
      .map((l) => {
        const rate = rateOf(l.inv, s);
        const walk = walkInvestment(l.movements.map(liteOf), anchorsOf(l), rate, clock.today);
        return projectInvestment({
          walk,
          ratePpm: rate,
          monthlyPlanCents: l.inv.monthlyPlanCents,
          goalCents: null,
          goalMonth: null,
          redeemableFrom: null,
          taxMode: l.inv.taxMode,
          today: clock.today,
          horizonMonths: PROJECTION_MONTHS,
        }).series;
      }),
  );
  const sum = (xs: InvestmentRow[], f: (r: InvestmentRow) => number) => xs.reduce((acc, r) => acc + f(r), 0);
  const warnings: InvestmentOverview['warnings'] = [];
  if (s.cdiAnnualPpm === null && active.some((r) => r.yieldKind === 'cdi')) {
    warnings.push({ code: 'cdi_missing', message: 'Informe o CDI para estimar o rendimento das caixinhas que rendem % do CDI.' });
  }
  return {
    currentMonth: clock.currentMonth,
    totals: {
      grossCents: sum(active, (r) => r.grossCents),
      netCents: sum(active, (r) => r.netTodayCents),
      yieldCents: sum(active, (r) => r.yieldCents),
      taxCents: sum(active, (r) => r.taxTodayCents),
      monthlyPlanCents: sum(active, (r) => r.monthlyPlanCents ?? 0),
      planCount: active.filter((r) => r.monthlyPlanCents).length,
      activeCount: active.length,
    },
    thisMonth: { plannedCents: sum(active, (r) => r.monthlyPlanCents ?? 0), depositedCents: sum(rows, (r) => r.depositedThisMonthCents) },
    past,
    projection,
    warnings,
  };
}

// ---------- Caixinhas

async function assertVersion(tx: Tx, walletId: string, id: string, version: number): Promise<InvRec> {
  const inv = await tx.query.investments.findFirst({ where: and(eq(investments.id, id), eq(investments.walletId, walletId), isNull(investments.deletedAt)) });
  if (!inv) throw investmentNotFound();
  if (inv.version !== version) throw conflict();
  return inv;
}

const bump = { version: sql`${investments.version} + 1` };

function fieldsOf(input: InvestmentCreateInput | InvestmentUpdateInput) {
  return {
    name: input.name,
    icon: input.icon,
    kind: input.kind,
    ...normalizeInvestmentTerms({ yieldKind: input.yieldKind, fixedRatePpm: input.fixedRatePpm ?? null, cdiShareBp: input.cdiShareBp ?? null }),
    redeemableFrom: input.redeemableFrom ?? null,
    taxMode: input.taxMode,
    goalCents: input.goalCents ?? null,
    goalMonth: input.goalMonth ?? null,
    monthlyPlanCents: input.monthlyPlanCents ?? null,
  };
}

export async function createInvestment(db: DB, walletId: string, input: InvestmentCreateInput, userId: string, clock: Clock): Promise<InvestmentDetail> {
  notAfterToday(input.initialDate, clock, 'initialDate');
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(investments).values({ walletId, ...fieldsOf(input), createdBy: userId }).returning();
    await tx.insert(investmentMovements).values({
      walletId,
      investmentId: row!.id,
      date: input.initialDate,
      kind: 'initial',
      amountCents: input.initialCents,
      createdBy: userId,
    });
    return detail(tx, walletId, row!.id, clock);
  });
}

export async function updateInvestment(db: DB, walletId: string, id: string, input: InvestmentUpdateInput, clock: Clock): Promise<InvestmentDetail> {
  return db.transaction(async (tx) => {
    await assertVersion(tx, walletId, id, input.version);
    await tx.update(investments).set({ ...fieldsOf(input), ...bump }).where(eq(investments.id, id));
    return detail(tx, walletId, id, clock);
  });
}

export async function deleteInvestment(db: DB, walletId: string, id: string): Promise<void> {
  const [row] = await db
    .update(investments)
    .set({ deletedAt: new Date(), ...bump })
    .where(and(eq(investments.id, id), eq(investments.walletId, walletId), isNull(investments.deletedAt)))
    .returning({ id: investments.id });
  if (!row) throw investmentNotFound();
}

/** Encerrar: resgata o saldo estimado na data (ou o valor confirmado), com o imposto estimado (ou o informado). */
export async function closeInvestment(db: DB, walletId: string, id: string, input: InvestmentCloseInput, userId: string, clock: Clock): Promise<InvestmentDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const { inv } = l;
    if (inv.status !== 'active') throw notActive();
    if (isLocked(inv, input.date)) throw lockedUntil(inv.redeemableFrom!);
    const initial = initialOf(l);
    if (compareDates(input.date, initial.date) < 0) throw beforeInitial(initial.date);
    const s = await readSettings(tx, walletId);
    const walk = walkInvestment(l.movements.map(liteOf), anchorsOf(l), rateOf(inv, s), input.date);
    const amount = input.amountCents ?? walk.grossCents;
    if (amount > walk.grossCents) throw exceedsBalance(walk.grossCents);
    if (amount > 0) {
      const tax = input.taxCents ?? withdrawalTax(walk, amount, input.date, inv.taxMode).totalCents;
      await tx.insert(investmentMovements).values({
        walletId,
        investmentId: id,
        date: input.date,
        kind: 'withdrawal',
        amountCents: amount,
        taxCents: Math.min(tax, amount),
        createdBy: userId,
      });
    }
    await tx.update(investments).set({ status: 'closed', closedOn: input.date, ...bump }).where(eq(investments.id, id));
    return detail(tx, walletId, id, clock);
  });
}

export async function reopenInvestment(db: DB, walletId: string, id: string, clock: Clock): Promise<InvestmentDetail> {
  return db.transaction(async (tx) => {
    const { inv } = await loadOne(tx, walletId, id);
    if (inv.status === 'closed') await tx.update(investments).set({ status: 'active', closedOn: null, ...bump }).where(eq(investments.id, id));
    return detail(tx, walletId, id, clock);
  });
}

// ---------- Movimentações

/** Recusa um resgate na data se a caixinha está travada ou se ele passa do saldo estimado (sem o próprio resgate, na edição). */
function checkWithdrawal(l: Loaded, s: InvestmentSettings, date: ISODate, amount: number, ignoreId?: string): void {
  if (isLocked(l.inv, date)) throw lockedUntil(l.inv.redeemableFrom!);
  const others = l.movements.filter((m) => m.id !== ignoreId).map(liteOf);
  const walk = walkInvestment(others, anchorsOf(l), rateOf(l.inv, s), date);
  if (amount > walk.grossCents) throw exceedsBalance(walk.grossCents);
}

export async function addMovement(
  db: DB,
  walletId: string,
  id: string,
  input: InvestmentMovementInput,
  userId: string,
  clock: Clock,
): Promise<InvestmentDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    if (l.inv.status !== 'active') throw notActive();
    const initial = initialOf(l);
    if (compareDates(input.date, initial.date) < 0) throw beforeInitial(initial.date);
    if (input.kind === 'withdrawal') checkWithdrawal(l, await readSettings(tx, walletId), input.date, input.amountCents);
    await tx.insert(investmentMovements).values({
      walletId,
      investmentId: id,
      date: input.date,
      kind: input.kind,
      amountCents: input.amountCents,
      taxCents: input.kind === 'withdrawal' ? (input.taxCents ?? 0) : null,
      createdBy: userId,
    });
    return detail(tx, walletId, id, clock);
  });
}

export async function updateMovement(
  db: DB,
  walletId: string,
  id: string,
  movementId: string,
  input: InvestmentMovementUpdateInput,
  clock: Clock,
): Promise<InvestmentDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const mov = l.movements.find((m) => m.id === movementId);
    if (!mov) throw notFound('Movimentação');
    if (mov.version !== input.version) throw conflict();
    if (mov.kind === 'initial') {
      // O inicial é o primeiro: nenhuma outra movimentação pode ficar antes dele.
      const first = l.movements.filter((m) => m.id !== mov.id).reduce<ISODate | null>((min, m) => (min === null || m.date < min ? m.date : min), null);
      if (first !== null && compareDates(first, input.date) < 0) {
        throw new AppError(409, 'movement_before_initial', `Há movimentações antes de ${formatDateBR(input.date)}. O valor inicial precisa ser a primeira.`);
      }
    } else {
      const initial = initialOf(l);
      if (compareDates(input.date, initial.date) < 0) throw beforeInitial(initial.date);
    }
    if (mov.kind === 'withdrawal') checkWithdrawal(l, await readSettings(tx, walletId), input.date, input.amountCents, mov.id);
    await tx
      .update(investmentMovements)
      .set({
        date: input.date,
        amountCents: input.amountCents,
        taxCents: mov.kind === 'withdrawal' ? (input.taxCents ?? 0) : null,
        version: sql`${investmentMovements.version} + 1`,
      })
      .where(eq(investmentMovements.id, movementId));
    return detail(tx, walletId, id, clock);
  });
}

export async function deleteMovement(db: DB, walletId: string, id: string, movementId: string, clock: Clock): Promise<InvestmentDetail> {
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const mov = l.movements.find((m) => m.id === movementId);
    if (!mov) throw notFound('Movimentação');
    if (mov.kind === 'initial') throw initialRequired();
    await tx.delete(investmentMovements).where(eq(investmentMovements.id, movementId));
    return detail(tx, walletId, id, clock);
  });
}

// ---------- Âncoras ("Atualizar saldo")

export async function addAnchor(db: DB, walletId: string, id: string, input: InvestmentAnchorInput, clock: Clock): Promise<InvestmentDetail> {
  notAfterToday(input.date, clock);
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    const initial = initialOf(l);
    if (compareDates(input.date, initial.date) < 0) throw beforeInitial(initial.date);
    await tx
      .insert(investmentBalanceAnchors)
      .values({ walletId, investmentId: id, date: input.date, balanceCents: input.balanceCents })
      .onConflictDoUpdate({ target: [investmentBalanceAnchors.investmentId, investmentBalanceAnchors.date], set: { balanceCents: input.balanceCents } });
    return detail(tx, walletId, id, clock);
  });
}

export async function deleteAnchor(db: DB, walletId: string, id: string, anchorId: string, clock: Clock): Promise<InvestmentDetail> {
  return db.transaction(async (tx) => {
    const l = await loadOne(tx, walletId, id);
    if (!l.anchors.some((a) => a.id === anchorId)) throw notFound('Saldo');
    await tx.delete(investmentBalanceAnchors).where(eq(investmentBalanceAnchors.id, anchorId));
    return detail(tx, walletId, id, clock);
  });
}

// ---------- Configuração (CDI)

export async function getSettings(db: DB, walletId: string): Promise<InvestmentSettings> {
  return readSettings(db, walletId);
}

export async function putSettings(db: DB, walletId: string, cdiAnnualPpm: number, clock: Clock): Promise<InvestmentSettings> {
  await db
    .insert(investmentSettings)
    .values({ walletId, cdiAnnualPpm, cdiUpdatedOn: clock.today })
    .onConflictDoUpdate({ target: investmentSettings.walletId, set: { cdiAnnualPpm, cdiUpdatedOn: clock.today } });
  return readSettings(db, walletId);
}

// ---------- Resumo do mês

/**
 * O que as caixinhas mudam no resumo do mês (ADR-0012):
 * - aportado: aportes com data no mês (o valor inicial fica fora: já estava guardado);
 * - resgatado: valor − impostos retidos dos resgates do mês;
 * - planejado: null em meses passados; senão, o "guardar por mês" das ativas (toda caixinha existente foi
 *   criada até o mês atual, então vale para o atual e os futuros).
 * Caixinhas excluídas ficam fora; encerradas entram no realizado.
 */
export async function monthInvestmentTotals(
  db: DB,
  walletId: string,
  month: Month,
  clock: Clock,
): Promise<{ plannedCents: number | null; depositedCents: number; withdrawnCents: number }> {
  const [moves] = await db
    .select({
      deposited: sql<string>`coalesce(sum(case when ${investmentMovements.kind} = 'deposit' then ${investmentMovements.amountCents} else 0 end), 0)`,
      withdrawn: sql<string>`coalesce(sum(case when ${investmentMovements.kind} = 'withdrawal' then ${investmentMovements.amountCents} - coalesce(${investmentMovements.taxCents}, 0) else 0 end), 0)`,
    })
    .from(investmentMovements)
    .innerJoin(investments, eq(investments.id, investmentMovements.investmentId))
    .where(
      and(
        eq(investmentMovements.walletId, walletId),
        isNull(investments.deletedAt),
        gte(investmentMovements.date, `${month}-01`),
        lte(investmentMovements.date, lastDayOf(month)),
      ),
    );
  let plannedCents: number | null = null;
  if (month >= clock.currentMonth) {
    const [p] = await db
      .select({ planned: sql<string>`coalesce(sum(${investments.monthlyPlanCents}), 0)` })
      .from(investments)
      .where(and(eq(investments.walletId, walletId), isNull(investments.deletedAt), eq(investments.status, 'active')));
    plannedCents = Number(p?.planned ?? 0);
  }
  return { plannedCents, depositedCents: Number(moves?.deposited ?? 0), withdrawnCents: Number(moves?.withdrawn ?? 0) };
}
