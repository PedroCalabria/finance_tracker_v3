import { addDays } from '../../dates';
import { classifyInvoice } from '../classify';
import { assignOrder, brDate, inferPurchaseDate, maskTail, maskTaxIds, normalizeText, parseCents } from '../text';
import type { ImportLine, ImportReader, PdfPage, ReadResult, ReadWarning, SourceDoc, TextItem } from '../types';

/**
 * Fatura do cartão Ourocard (Banco do Brasil) em PDF (ADR-0010, D2).
 *
 * O resumo traz "Vencimento", "Final NNNN" e o total; a lista de lançamentos tem
 * as colunas Data | Descrição | País | Valor, com data "dd/mm" sem ano, valor
 * "R$ 1.234,56" (negativo nos créditos) e títulos de seção sem data
 * ("Supermercados", "Compras parceladas"…). "PARC xx/yy" vem na descrição.
 */

const DAY_MONTH = /^\d{2}\/\d{2}$/;
const MONEY = /^R\$\s*(-?\s*[\d.]+,\d{2})$/;
const PARC = /\bPARC\s+(\d{2})\/(\d{2})\b/;

interface Columns {
  headerY: number;
  data: number;
  descricao: number;
  pais: number;
}

function columnsOf(page: PdfPage): Columns | null {
  const find = (t: string) => page.items.find((i) => normalizeText(i.text) === t);
  const data = find('DATA');
  const desc = find('DESCRICAO');
  const pais = find('PAIS');
  if (!data || !desc || !pais || Math.abs(data.y - desc.y) > 3) return null;
  return { headerY: data.y, data: data.x, descricao: desc.x, pais: pais.x };
}

/** Linhas visuais (mesma altura ±2), de cima para baixo, com os trechos da esquerda para a direita. */
function rowsOf(items: TextItem[]): TextItem[][] {
  const rows: TextItem[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0]!.y - it.y) <= 2);
    if (row) row.push(it);
    else rows.push([it]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

const joined = (doc: { pages: PdfPage[] }) =>
  doc.pages.map((p) => rowsOf(p.items).map((r) => r.map((i) => i.text.trim()).join(' ')).join('\n')).join('\n');

function readInvoice(doc: SourceDoc): ReadResult {
  if (doc.kind !== 'pdf') throw new Error('bb-fatura-pdf: documento não é PDF');
  const text = joined(doc);
  const dueDate = brDate(/Vencimento[\s\S]*?(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? '');
  const closingDate = brDate(/Fatura fechada em\s+(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? '');
  const final = /Final\s+(\d{4})/.exec(text)?.[1] ?? null;
  const totalText = /Total da Fatura\s+R\$\s*(-?[\d.]+,\d{2})/.exec(text)?.[1] ?? null;
  const totalCents = totalText ? parseCents(totalText) : null;
  // As datas da lista não têm ano: a referência é o fechamento (ou o vencimento − 10 dias).
  const anchor = closingDate ?? (dueDate ? addDays(dueDate, -10) : null);

  const lines: ImportLine[] = [];
  const warnings: ReadWarning[] = [];
  let sum = 0;
  let section: string | null = null;
  // A lista começa na página com o cabeçalho de colunas; as seguintes usam as mesmas colunas.
  let c: Columns | null = null;
  let done = false;
  for (const page of doc.pages) {
    if (done) break;
    const cols = columnsOf(page);
    if (cols) c = cols;
    if (!c) continue;
    const pais = c.pais;
    const body = page.items.filter((i) => !cols || i.y < cols.headerY - 2);
    for (const row of rowsOf(body)) {
      const first = row[0]!;
      const rowText = row.map((i) => i.text.trim()).join(' ');
      if (normalizeText(rowText).startsWith('TOTAL DA FATURA')) {
        done = true;
        break;
      }
      const moneyItem = row.find((i) => MONEY.test(i.text.trim()));
      const cents = moneyItem ? parseCents(MONEY.exec(moneyItem.text.trim())![1]!.replace(/\s/g, '')) : null;
      const isDate = Math.abs(first.x - c.data) <= 8 && DAY_MONTH.test(first.text.trim());
      if (!isDate) {
        // Saldo da fatura anterior entra só na conferência; título sem valor vira seção.
        if (cents !== null && /SALDO FATURA ANTERIOR/.test(normalizeText(rowText))) sum += cents;
        else if (cents === null && Math.abs(first.x - c.descricao) <= 8 && row.length === 1) section = first.text.trim();
        continue;
      }
      if (cents === null || !anchor) continue;
      sum += cents;
      const description = row
        .filter((i) => i !== first && i !== moneyItem && i.x < pais - 4)
        .map((i) => i.text.trim())
        .join(' ')
        .replace(/\s+/g, ' ');
      const norm = normalizeText(description);
      // Pagamento da fatura anterior: informativo (o extrato concilia o pagamento).
      if (cents < 0 && /^(PGTO|PAGAMENTO)\b/.test(norm)) continue;
      const parc = PARC.exec(norm);
      const parcel = parc ? { n: Number(parc[1]), of: Number(parc[2]) } : null;
      const date = inferPurchaseDate(first.text.trim(), anchor, parcel?.n ?? 1);
      if (!date) continue;
      const cls = classifyInvoice(description, cents, !!parcel);
      const masked = maskTaxIds(description);
      lines.push({
        index: lines.length,
        date,
        amountCents: Math.abs(cents),
        direction: cents < 0 ? 'credit' : 'debit',
        description: masked,
        document: null,
        hint: cls.hint,
        name: masked.replace(/\s*\bPARC\s+\d{2}\/\d{2}\b/i, '').trim(),
        method: 'credit',
        explanation: cls.explanation,
        ignoreByDefault: cls.ignoreByDefault,
        payeeBank: null,
        section,
        parcel,
        order: 0,
      });
    }
  }
  if (totalCents !== null && sum !== totalCents) {
    warnings.push({ code: 'total_mismatch', message: 'Algumas linhas podem não ter sido lidas corretamente.', date: null, diffCents: totalCents - sum });
  }
  return {
    header: {
      periodStart: null,
      periodEnd: closingDate,
      accountRef: final ? `final ${final}` : null,
      accountLabel: final ? `final ${maskTail(final, 2)}` : null,
      bankName: null,
      invoice: dueDate && totalCents !== null ? { dueDate, closingDate, totalCents } : null,
    },
    lines: assignOrder(lines),
    warnings,
  };
}

export const bbInvoiceReader: ImportReader = {
  id: 'bb-fatura-pdf',
  bank: 'Banco do Brasil',
  kind: 'invoice',
  label: 'Fatura Ourocard (Banco do Brasil)',
  detect: (doc) => {
    if (doc.kind !== 'pdf') return false;
    const all = normalizeText(doc.pages.map((p) => p.items.map((i) => i.text).join(' ')).join(' '));
    return all.includes('OUROCARD') && all.includes('LANCAMENTOS NESTA FATURA');
  },
  read: readInvoice,
};
