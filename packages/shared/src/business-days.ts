import { addDays, dayOfWeek, type ISODate } from './dates';

/**
 * Calendário bancário (ADR-0007): segunda a sexta, exceto feriados nacionais,
 * segunda e terça de Carnaval e Sexta-feira Santa. Calculado por ano, sem
 * tabela para manter.
 */

const FIXED: Array<[string, string]> = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['12-25', 'Natal'],
];

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const cache = new Map<number, Map<ISODate, string>>();

export function bankHolidays(year: number): Map<ISODate, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const map = new Map<ISODate, string>();
  for (const [md, name] of FIXED) map.set(`${year}-${md}`, name);
  const easter = easterSunday(year);
  map.set(addDays(easter, -48), 'Carnaval (segunda)');
  map.set(addDays(easter, -47), 'Carnaval (terça)');
  map.set(addDays(easter, -2), 'Sexta-feira Santa');
  cache.set(year, map);
  return map;
}

export function isBusinessDay(date: ISODate): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  return !bankHolidays(Number(date.slice(0, 4))).has(date);
}

/** A própria data, se útil; senão o dia útil anterior. */
export function onOrBeforeBusinessDay(date: ISODate): ISODate {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

export function previousBusinessDay(date: ISODate, count = 1): ISODate {
  let d = date;
  for (let i = 0; i < count; i++) {
    d = addDays(d, -1);
    while (!isBusinessDay(d)) d = addDays(d, -1);
  }
  return d;
}

/**
 * Em que dias um vencimento gera aviso: a data de lembrete (o próprio vencimento
 * ou o dia útil anterior, se cair em fim de semana/feriado) e `lead` dias úteis antes.
 */
export function reminderDays(dueDate: ISODate, lead: number): { onDay: ISODate; before: ISODate | null } {
  const onDay = onOrBeforeBusinessDay(dueDate);
  return { onDay, before: lead > 0 ? previousBusinessDay(onDay, lead) : null };
}
