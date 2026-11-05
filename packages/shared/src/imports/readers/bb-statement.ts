import { classifyStatement, payeeBankOf } from '../classify';
import { assignOrder, brDate, maskTail, maskTaxIds, normalizeText, parseCents } from '../text';
import type { ImportLine, ImportReader, PdfPage, ReadResult, ReadWarning, SourceDoc, TextItem } from '../types';

/**
 * Extrato de conta corrente do Banco do Brasil em PDF (ADR-0010, D2).
 *
 * Cada lançamento tem uma linha principal (Dia, Lote, Documento e Valor na mesma
 * altura) e um histórico de até três trechos, que ficam acima, na mesma altura ou
 * abaixo dela. Por isso o agrupamento é pela posição: cada trecho de histórico vai
 * para a linha principal mais próxima na vertical (texto corrido embaralha as colunas).
 */

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const VALUE_RE = /^([\d.]+,\d{2})\s*\(([+-])\)$/;
const MAX_GAP = 14;
const PIX_TIME = /^\d{2}\/\d{2}\s+\d{2}:\d{2}\s+/;

interface Columns {
  headerY: number;
  dia: number;
  lote: number;
  documento: number;
  historico: number;
  valor: number;
}

/** Colunas pelo cabeçalho da página ("Dia | Lote | Documento | Histórico | Valor"). */
function columnsOf(page: PdfPage): Columns | null {
  const find = (t: string) => page.items.find((i) => normalizeText(i.text) === t);
  const dia = find('DIA');
  const hist = find('HISTORICO');
  const valor = find('VALOR');
  if (!dia || !hist || !valor || Math.abs(dia.y - hist.y) > 3) return null;
  return {
    headerY: dia.y,
    dia: dia.x,
    lote: find('LOTE')?.x ?? dia.x + 60,
    documento: find('DOCUMENTO')?.x ?? dia.x + 110,
    historico: hist.x,
    valor: valor.x,
  };
}

/** Linha final do bloco de lançamentos: "Informações Adicionais", se houver nesta página. */
function footerY(page: PdfPage): number {
  const f = page.items.find((i) => normalizeText(i.text).startsWith('INFORMACOES ADICIONAIS'));
  return f ? f.y : -Infinity;
}

interface Record {
  date: string;
  y: number;
  document: string | null;
  value: TextItem | null;
  history: TextItem[];
}

function recordsOf(page: PdfPage, cols: Columns): Record[] {
  const bottom = footerY(page);
  const body = page.items.filter((i) => i.y < cols.headerY - 2 && i.y > bottom + 2);
  const anchors: Record[] = body
    .filter((i) => Math.abs(i.x - cols.dia) <= 6 && DATE_RE.test(i.text.trim()))
    .map((d) => ({ date: d.text.trim(), y: d.y, document: null, value: null, history: [] }));
  if (anchors.length === 0) return [];
  for (const it of body) {
    const text = it.text.trim();
    if (DATE_RE.test(text) && Math.abs(it.x - cols.dia) <= 6) continue;
    if (VALUE_RE.test(text)) {
      const a = anchors.find((r) => Math.abs(r.y - it.y) <= 2);
      if (a) a.value = it;
      continue;
    }
    if (it.x >= cols.documento - 4 && it.x < cols.historico - 4) {
      const a = anchors.find((r) => Math.abs(r.y - it.y) <= 2);
      if (a) a.document = text;
      continue;
    }
    if (it.x >= cols.historico - 6 && it.x < cols.valor - 120) {
      // Histórico: vai para a linha principal mais próxima na vertical.
      let best: Record | null = null;
      for (const a of anchors) if (!best || Math.abs(a.y - it.y) < Math.abs(best.y - it.y)) best = a;
      if (best && Math.abs(best.y - it.y) <= MAX_GAP) best.history.push(it);
    }
  }
  for (const a of anchors) a.history.sort((p, q) => q.y - p.y || p.x - q.x);
  return anchors.sort((p, q) => q.y - p.y);
}

/**
 * Nome sugerido para um lançamento novo: o favorecido (2º trecho, sem o CPF/CNPJ
 * do começo) ou, em tarifas, financiamento e pagamento de fatura, o próprio histórico.
 */
function nameOf(hint: string, head: string, rest: string): string {
  if (!rest || ['fee', 'financing', 'invoice_payment', 'investment_sweep'].includes(hint)) return head;
  return maskTaxIds(rest).replace(/^•+\d{2}\s+/, '') || head;
}

const signed = (v: TextItem): number => {
  const m = VALUE_RE.exec(v.text.trim())!;
  const cents = parseCents(m[1]!)!;
  return m[2] === '-' ? -cents : cents;
};

function readStatement(doc: SourceDoc): ReadResult {
  if (doc.kind !== 'pdf') throw new Error('bb-extrato-pdf: documento não é PDF');
  const all = doc.pages.map((p) => p.items.map((i) => i.text).join(' ')).join(' ');
  const period = /Per[ií]odo:\s*(\d{2})(?:\/(\d{2}))?(?:\/(\d{4}))?\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(all);
  const agencia = /Ag[eê]ncia:\s*([\d-]+)/.exec(all)?.[1] ?? null;
  const conta = /Conta:\s*([\d-]+)/.exec(all)?.[1] ?? null;
  const periodEnd = period ? `${period[6]}-${period[5]}-${period[4]}` : null;
  const periodStart = period ? `${period[3] ?? period[6]}-${period[2] ?? period[5]}-${period[1]}` : null;

  const lines: ImportLine[] = [];
  const warnings: ReadWarning[] = [];
  let balance: number | null = null;
  for (const page of doc.pages) {
    const cols = columnsOf(page);
    if (!cols) continue;
    for (const r of recordsOf(page, cols)) {
      if (!r.value) continue;
      const date = brDate(r.date);
      if (!date) continue;
      const parts = r.history.map((h) => h.text.trim()).filter(Boolean);
      const head = normalizeText(parts[0] ?? '');
      const cents = signed(r.value);
      if (head === 'SALDO ANTERIOR') {
        balance = cents;
        continue;
      }
      if (head === 'SALDO DO DIA' || head === 'S A L D O' || head === 'SALDO') {
        if (balance !== null && balance !== cents) {
          warnings.push({ code: 'balance_mismatch', message: 'Algumas linhas podem não ter sido lidas corretamente.', date, diffCents: cents - balance });
        }
        balance = cents;
        continue;
      }
      if (balance !== null) balance += cents;
      const rest = parts.slice(1).join(' ').replace(PIX_TIME, '').trim();
      const description = maskTaxIds(rest ? `${parts[0]} · ${rest}` : (parts[0] ?? ''));
      const direction = cents < 0 ? 'debit' : 'credit';
      const cls = classifyStatement(description, direction);
      const payeeBank = cls.hint === 'boleto' && rest ? payeeBankOf(rest) : null;
      lines.push({
        index: lines.length,
        date,
        amountCents: Math.abs(cents),
        direction,
        description,
        document: r.document,
        hint: cls.hint,
        name: nameOf(cls.hint, parts[0] ?? '', rest),
        method: cls.method,
        explanation: cls.explanation,
        ignoreByDefault: cls.ignoreByDefault,
        payeeBank,
        section: null,
        parcel: null,
        order: 0,
      });
    }
  }
  return {
    header: {
      periodStart,
      periodEnd,
      accountRef: agencia && conta ? `${agencia}/${conta}` : null,
      accountLabel: conta ? `Conta ${maskTail(conta)}` : null,
      bankName: null,
      invoice: null,
    },
    lines: assignOrder(lines),
    warnings,
  };
}

export const bbStatementReader: ImportReader = {
  id: 'bb-extrato-pdf',
  bank: 'Banco do Brasil',
  kind: 'statement',
  label: 'Extrato do Banco do Brasil',
  detect: (doc) =>
    doc.kind === 'pdf' &&
    doc.pages.some((p) => p.items.some((i) => normalizeText(i.text) === 'EXTRATO DE CONTA CORRENTE')) &&
    doc.pages.some((p) => columnsOf(p) !== null),
  read: readStatement,
};
