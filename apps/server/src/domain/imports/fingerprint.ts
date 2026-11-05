import { createHash } from 'node:crypto';
import { normalizeForFingerprint, normalizeText, type ImportLine } from '@ff/shared';

/**
 * Impressão digital de uma linha (ADR-0010, D7): carteira + destino + data +
 * valor + sentido + documento + descrição normalizada + ordem entre linhas
 * idênticas. Reimportar um período sobreposto encontra as mesmas impressões.
 */
export function fingerprintOf(walletId: string, accountId: string, l: Pick<ImportLine, 'date' | 'amountCents' | 'direction' | 'document' | 'description' | 'order'>): string {
  return createHash('sha256')
    .update([walletId, accountId, l.date, l.amountCents, l.direction, l.document ?? '', normalizeForFingerprint(l.description), l.order].join('|'))
    .digest('hex');
}

/** O banco do cartão "bate" com o do documento? ("Banco do Brasil" × "BB", "XP" × "Banco XP S.A"). */
export function sameBank(a: string, b: string): boolean {
  const norm = (s: string) =>
    normalizeText(s)
      .replace(/\bS\.?\s?\/?A\.?$/, '')
      .replace(/^BANCO\s+/, '')
      .replace(/^BB$/, 'DO BRASIL')
      .trim();
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
