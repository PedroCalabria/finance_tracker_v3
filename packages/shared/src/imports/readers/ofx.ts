import { isISODate } from '../../dates';
import { classifyStatement, payeeBankOf } from '../classify';
import { assignOrder, maskTail, maskTaxIds, parseCentsDot } from '../text';
import type { ImportLine, ImportReader, ReadResult, SourceDoc } from '../types';

/**
 * OFX de conta corrente de qualquer banco (ADR-0010, D2): SGML (1.x) e XML (2.x).
 * Parser tolerante por blocos <STMTTRN>, sem depender de tags de fechamento nas
 * folhas. A decodificação (CHARSET 1252/UTF-8) é feita no servidor.
 */

/** Códigos de banco (COMPE) mais comuns, para pré-selecionar o destino. */
const BANKS: Record<string, string> = {
  '001': 'Banco do Brasil',
  '033': 'Santander',
  '077': 'Inter',
  '104': 'Caixa',
  '237': 'Bradesco',
  '260': 'Nubank',
  '341': 'Itaú',
  '348': 'XP',
  '102': 'XP',
  '336': 'C6',
  '756': 'Sicoob',
};

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1]!.trim() : null;
};
const ofxDate = (v: string | null): string | null => {
  if (!v || !/^\d{8}/.test(v)) return null;
  const d = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return isISODate(d) ? d : null;
};
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function readOfx(doc: SourceDoc): ReadResult {
  if (doc.kind !== 'text') throw new Error('ofx: documento não é texto');
  const text = doc.text;
  const acct = /<BANKACCTFROM>([\s\S]*?)(<\/BANKACCTFROM>|<BANKTRANLIST>)/i.exec(text)?.[1] ?? text;
  const bankId = tag(acct, 'BANKID');
  const acctId = tag(acct, 'ACCTID');
  const org = tag(text, 'ORG');
  const lines: ImportLine[] = [];
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
    const block = m[1]!;
    const date = ofxDate(tag(block, 'DTPOSTED'));
    const cents = parseCentsDot(tag(block, 'TRNAMT') ?? '');
    if (!date || cents === null || cents === 0) continue;
    const name = decodeEntities(tag(block, 'NAME') ?? '');
    const memo = decodeEntities(tag(block, 'MEMO') ?? '');
    const raw = [name, memo && memo !== name ? memo : ''].filter(Boolean).join(' · ') || (tag(block, 'TRNTYPE') ?? 'Lançamento');
    const description = maskTaxIds(raw);
    const direction = cents < 0 ? 'debit' : 'credit';
    const trnType = (tag(block, 'TRNTYPE') ?? '').toUpperCase();
    const cls = classifyStatement(`${raw} ${trnType === 'FEE' || trnType === 'SRVCHG' ? 'TARIFA' : ''}`, direction);
    lines.push({
      index: lines.length,
      date,
      amountCents: Math.abs(cents),
      direction,
      description,
      document: tag(block, 'FITID') ?? tag(block, 'CHECKNUM'),
      hint: cls.hint,
      name: maskTaxIds(memo || name || raw),
      method: cls.method,
      explanation: cls.explanation,
      ignoreByDefault: cls.ignoreByDefault,
      payeeBank: cls.hint === 'boleto' ? (payeeBankOf(memo) ?? payeeBankOf(name)) : null,
      section: null,
      parcel: null,
      order: 0,
    });
  }
  const list = /<BANKTRANLIST>([\s\S]*?)<STMTTRN>/i.exec(text)?.[1] ?? '';
  return {
    header: {
      periodStart: ofxDate(tag(list, 'DTSTART')),
      periodEnd: ofxDate(tag(list, 'DTEND')),
      accountRef: acctId ? `${bankId ?? ''}/${acctId}` : null,
      accountLabel: acctId ? `Conta ${maskTail(acctId.replace(/\s/g, ''))}` : null,
      bankName: (bankId && BANKS[bankId.padStart(3, '0').slice(-3)]) || org || null,
      invoice: null,
    },
    lines: assignOrder(lines),
    warnings: [],
  };
}

export const ofxReader: ImportReader = {
  id: 'ofx',
  bank: 'OFX',
  kind: 'statement',
  label: 'Extrato OFX',
  detect: (doc) => doc.kind === 'text' && /^\s*(?:\uFEFF)?\s*(?:OFXHEADER|<\?xml[\s\S]{0,200}?<\?OFX|<OFX>)/i.test(doc.text.slice(0, 2000)),
  read: readOfx,
};
