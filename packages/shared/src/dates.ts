/**
 * Datas trafegam como strings ISO: dia "YYYY-MM-DD", mês "YYYY-MM" (ADR-0004).
 * Nada aqui usa o fuso do processo: as contas são feitas em UTC sobre a data civil.
 */

export type ISODate = string; // YYYY-MM-DD
export type Month = string; // YYYY-MM

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export const isISODate = (s: string): boolean => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && toISO(parseISO(s)) === s;
export const isMonth = (s: string): boolean => MONTH_RE.test(s) && Number(s.slice(5)) >= 1 && Number(s.slice(5)) <= 12;

function parseISO(s: ISODate): Date {
  return new Date(`${s}T00:00:00Z`);
}
function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function monthOf(date: ISODate): Month {
  return date.slice(0, 7);
}

export function addMonths(month: Month, n: number): Month {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

export function diffMonths(from: Month, to: Month): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

export function daysInMonth(month: Month): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Dia 31 em fevereiro vira o último dia do mês. */
export function dateInMonth(month: Month, day: number): ISODate {
  const d = Math.min(Math.max(1, day), daysInMonth(month));
  return `${month}-${String(d).padStart(2, '0')}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = parseISO(date);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

/** Mesmo dia nos meses seguintes, limitado ao fim do mês. */
export function addMonthsToDate(date: ISODate, n: number): ISODate {
  return dateInMonth(addMonths(monthOf(date), n), Number(date.slice(8, 10)));
}

export function dayOfWeek(date: ISODate): number {
  return parseISO(date).getUTCDay(); // 0 = domingo
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Data civil de agora num fuso IANA ("America/Sao_Paulo"). */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Hora local (0–23) de agora num fuso IANA. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(h);
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-11" → "Novembro de 2026" */
export function formatMonthLong(month: Month): string {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${month.slice(0, 4)}`;
}

/** "2026-10" → "out" ; com ano → "out/2026" */
export function formatMonthShort(month: Month, withYear = false): string {
  const name = (MONTHS[Number(month.slice(5, 7)) - 1] ?? '').slice(0, 3);
  return withYear ? `${name}/${month.slice(0, 4)}` : name;
}

/** "2026-11-05" → "05/11/2026"; curto → "05/11" */
export function formatDateBR(date: ISODate, short = false): string {
  const [y, m, d] = date.split('-');
  return short ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** "05/11/2026" → "2026-11-05" (null se inválida). */
export function parseDateBR(input: string): ISODate | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}
