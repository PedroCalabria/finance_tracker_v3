import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  addDays,
  addMonths,
  formatBRL,
  formatDateBR,
  hourIn,
  reminderDays,
  todayIn,
  type ISODate,
} from '@ff/shared';
import type { AppContext } from '../context';
import { accounts, invoices, items, notificationLog, notificationSettings, occurrences, users, walletMembers } from '../db/schema';
import { clockAt } from '../domain/clock';
import { ensureMaterialized, projectionsFor } from '../domain/projections';
import { button, esc, layout } from '../email/templates';

/**
 * Etapa 7 — resumo diário por email (ADR-0007). Roda de hora em hora; cada
 * usuário recebe no horário que escolheu, no fuso dele, no máximo um por dia.
 * Um vencimento avisa no dia (ou no dia útil anterior, se cair em fim de semana
 * ou feriado) e N dias úteis antes.
 */

export interface DueEntry {
  description: string;
  amountCents: number;
  dueDate: ISODate;
  where: string;
  kind: 'expense' | 'income' | 'invoice';
  when: 'today' | 'soon';
}

/** Janela de busca: a antecedência máxima (5 dias úteis) cabe em 10 dias corridos com feriados. */
const LOOKAHEAD_DAYS = 12;

export async function collectDue(ctx: AppContext, walletId: string, today: ISODate, lead: number): Promise<DueEntry[]> {
  const clock = { today, currentMonth: today.slice(0, 7) };
  await ensureMaterialized(ctx.db, walletId, clock);
  const until = addDays(today, LOOKAHEAD_DAYS);
  const out: DueEntry[] = [];
  const classify = (due: ISODate): 'today' | 'soon' | null => {
    const r = reminderDays(due, lead);
    if (r.onDay === today) return 'today';
    if (r.before === today) return 'soon';
    return null;
  };

  const occs = await ctx.db
    .select({ occ: occurrences, item: items, account: accounts })
    .from(occurrences)
    .innerJoin(items, eq(items.id, occurrences.itemId))
    .leftJoin(accounts, eq(accounts.id, items.accountId))
    .where(
      and(
        eq(occurrences.walletId, walletId),
        isNull(items.deletedAt),
        isNull(occurrences.invoiceId),
        isNotNull(occurrences.dueDate),
        sql`${occurrences.status} in ('pending','partial')`,
        sql`${occurrences.dueDate} between ${today} and ${until}`,
      ),
    );
  for (const { occ, item, account } of occs) {
    const when = classify(occ.dueDate!);
    if (!when) continue;
    const paid = await ctx.db.execute<{ s: number }>(sql`select coalesce(sum(amount_cents),0)::int as s from payments where occurrence_id = ${occ.id}`);
    out.push({
      description: item.description,
      amountCents: Math.max(0, occ.expectedCents - (paid.rows[0]?.s ?? 0)),
      dueDate: occ.dueDate!,
      where: account ? account.name : '',
      kind: item.type,
      when,
    });
  }

  // Recorrentes do mês seguinte ainda não gravadas também avisam (ex.: vence dia 1º).
  for (const p of await projectionsFor(ctx.db, walletId, addMonths(clock.currentMonth, 1), clock)) {
    if (p.item.method === 'credit' || !p.dueDate || p.dueDate > until) continue;
    const when = classify(p.dueDate);
    if (when) out.push({ description: p.item.description, amountCents: p.expectedCents, dueDate: p.dueDate, where: p.account?.name ?? '', kind: p.item.type, when });
  }

  const invs = await ctx.db
    .select({ inv: invoices, account: accounts })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .where(and(eq(invoices.walletId, walletId), eq(invoices.status, 'open'), sql`${invoices.dueDate} between ${today} and ${until}`));
  for (const { inv, account } of invs) {
    const when = classify(inv.dueDate);
    if (!when) continue;
    const r = await ctx.db.execute<{ s: number }>(
      sql`select coalesce(sum(o.expected_cents),0)::int as s from occurrences o join items i on i.id = o.item_id
          where o.invoice_id = ${inv.id} and o.status <> 'canceled' and i.deleted_at is null`,
    );
    const total = r.rows[0]?.s ?? 0;
    if (total <= 0) continue;
    out.push({ description: `Fatura ${account.name}`, amountCents: total, dueDate: inv.dueDate, where: account.bank, kind: 'invoice', when });
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.description.localeCompare(b.description, 'pt-BR')));
}

export function renderSummary(name: string, today: ISODate, entries: DueEntry[], link: string) {
  const line = (e: DueEntry) => {
    const date = e.dueDate === today ? 'hoje' : formatDateBR(e.dueDate, true);
    return { text: `${e.description} · ${formatBRL(e.amountCents)} · ${date}${e.where ? ` · ${e.where}` : ''}`, e };
  };
  const pay = entries.filter((e) => e.kind !== 'income');
  const receive = entries.filter((e) => e.kind === 'income');
  const sections: Array<[string, DueEntry[]]> = [
    ['Vencem hoje', pay.filter((e) => e.when === 'today')],
    ['Vencem no próximo dia útil', pay.filter((e) => e.when === 'soon')],
    ['Hoje você deve receber', receive.filter((e) => e.when === 'today')],
    ['Você deve receber em breve', receive.filter((e) => e.when === 'soon')],
  ];
  const visible = sections.filter(([, list]) => list.length > 0);
  const html = visible
    .map(
      ([title, list]) =>
        `<h2 style="margin:20px 0 8px;font-size:16px">${esc(title)}</h2><ul style="margin:0;padding-left:20px">${list
          .map((e) => `<li style="margin:4px 0">${esc(line(e).text)}</li>`)
          .join('')}</ul>`,
    )
    .join('');
  const text = visible.map(([title, list]) => `${title}:\n${list.map((e) => `- ${line(e).text}`).join('\n')}`).join('\n\n');
  const count = pay.length;
  const subject = count > 0 ? `${count === 1 ? '1 conta vence' : `${count} contas vencem`} em breve` : 'Valores a receber em breve';
  return {
    subject,
    html: layout(`Olá, ${name}`, `${html}${button(link, 'Abrir o mês')}`),
    text: `Olá, ${name}.\n\n${text}\n\nAbrir o mês: ${link}`,
  };
}

/** Uma rodada do job: envia para quem está no horário configurado agora. */
export async function runDailySummaries(ctx: AppContext): Promise<{ sent: number; skipped: number }> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ user: users, settings: notificationSettings })
    .from(users)
    .innerJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(and(eq(notificationSettings.enabled, true), isNotNull(users.emailVerifiedAt)));
  let sent = 0;
  let skipped = 0;
  for (const { user, settings } of rows) {
    if (hourIn(user.timezone, now) !== settings.sendHour) continue;
    const today = todayIn(user.timezone, now);
    // Reserva o envio antes de mandar: se o job rodar duas vezes, só um passa.
    const reserved = await ctx.db
      .insert(notificationLog)
      .values({ userId: user.id, day: today, kind: 'daily_summary' })
      .onConflictDoNothing()
      .returning({ userId: notificationLog.userId });
    if (reserved.length === 0) {
      skipped++;
      continue;
    }
    try {
      const wallets = await ctx.db.query.walletMembers.findMany({ where: eq(walletMembers.userId, user.id) });
      const entries: DueEntry[] = [];
      for (const w of wallets) entries.push(...(await collectDue(ctx, w.walletId, today, settings.leadBusinessDays)));
      await ctx.db
        .update(notificationLog)
        .set({ itemCount: entries.length })
        .where(and(eq(notificationLog.userId, user.id), eq(notificationLog.day, today), eq(notificationLog.kind, 'daily_summary')));
      if (entries.length === 0) continue; // sem nada a avisar, sem email
      const msg = renderSummary(user.name, today, entries, `${ctx.config.APP_URL}/?mes=${today.slice(0, 7)}`);
      await ctx.mailer.send({ to: user.email, ...msg });
      sent++;
    } catch (err) {
      // Libera a reserva para a próxima tentativa do job.
      await ctx.db
        .delete(notificationLog)
        .where(and(eq(notificationLog.userId, user.id), eq(notificationLog.day, today), eq(notificationLog.kind, 'daily_summary')));
      throw err;
    }
  }
  return { sent, skipped };
}

export const _test = { clockAt };
