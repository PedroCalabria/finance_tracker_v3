import { addMonths, diffMonths, isISODate, monthOf, type ISODate } from '../dates';
import type { ImportLine } from './types';

/** Utilitários de texto e números dos leitores (ADR-0010). Nada usa ponto flutuante. */

/** "1.234,56" → 123456. Aceita sinal na frente. Devolve null se não for valor. */
export function parseCents(text: string): number | null {
  const m = /^\s*(-)?\s*(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const cents = Number(m[2]!.replace(/\./g, '')) * 100 + Number(m[3]);
  return m[1] ? -cents : cents;
}

/** "-123.45" (OFX) → -12345. Aceita vírgula decimal, que alguns bancos usam. */
export function parseCentsDot(text: string): number | null {
  const m = /^\s*([+-])?\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

/** Maiúsculas, sem acentos, espaços colapsados. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const keepLast2 = (digits: string) => `${'•'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;

/**
 * Mascara CPF e CNPJ (com ou sem pontuação) e sequências isoladas de 11 ou 14
 * dígitos, mantendo os 2 últimos. O resto da descrição fica como veio do banco.
 */
export function maskTaxIds(text: string): string {
  return text
    .replace(/(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, (m) => keepLast2(m.replace(/\D/g, '')))
    .replace(/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, (m) => keepLast2(m.replace(/\D/g, '')))
    .replace(/(?<!\d)(\d{14}|\d{11})(?!\d)/g, (m) => keepLast2(m));
}

/** Mostra só o fim de um identificador: "123456-7" → "••56-7". */
export function maskTail(id: string, keep = 4): string {
  return id.length <= keep ? id : `••${id.slice(-keep)}`;
}

/** Descrição normalizada para a impressão digital (D7). */
export function normalizeForFingerprint(description: string): string {
  return normalizeText(description);
}

/** Preenche `order`: 1, 2, … entre linhas com mesma data, valor, sentido, documento e descrição. */
export function assignOrder<T extends Pick<ImportLine, 'date' | 'amountCents' | 'direction' | 'document' | 'description' | 'order'>>(lines: T[]): T[] {
  const seen = new Map<string, number>();
  for (const l of lines) {
    const key = [l.date, l.amountCents, l.direction, l.document ?? '', normalizeForFingerprint(l.description)].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    l.order = n;
  }
  return lines;
}

/**
 * Data completa de uma compra da fatura, que vem só como "dd/mm" (D2). Escolhe o
 * ano em que a data fica até o fechamento e mais perto do mês esperado: o do
 * fechamento, ou, numa parcela "xx/yy", xx − 1 meses antes.
 */
export function inferPurchaseDate(dayMonth: string, anchor: ISODate, parcelN = 1): ISODate | null {
  const m = /^(\d{2})\/(\d{2})$/.exec(dayMonth.trim());
  if (!m) return null;
  const expected = addMonths(monthOf(anchor), -(Math.max(1, parcelN) - 1));
  const anchorYear = Number(anchor.slice(0, 4));
  const backYears = 2 + Math.ceil(parcelN / 12);
  let best: { date: ISODate; dist: number } | null = null;
  for (let y = anchorYear; y >= anchorYear - backYears; y--) {
    const date = `${y}-${m[2]}-${m[1]}`;
    if (!isISODate(date) || date > anchor) continue;
    const dist = Math.abs(diffMonths(expected, monthOf(date)));
    if (!best || dist < best.dist) best = { date, dist };
  }
  return best?.date ?? null;
}

/** "dd/mm/aaaa" → "aaaa-mm-dd" (ou null). */
export function brDate(text: string): ISODate | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isISODate(iso) ? iso : null;
}
