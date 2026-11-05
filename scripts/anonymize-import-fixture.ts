/**
 * Gera uma fixture ANONIMIZADA de texto posicionado a partir de um PDF real de
 * extrato ou fatura do BB (ADR-0010, D14). Uso só em desenvolvimento:
 *
 *   npx tsx scripts/anonymize-import-fixture.ts <arquivo.pdf> <saida.json> [semente]
 *
 * Mantém posições, ordem e os rótulos fixos do banco ("Pix - Enviado",
 * "PARC 09/10", "IOF …"); troca nomes, endereço, CPF/CNPJ, documentos, agência,
 * conta, final do cartão, código de barras e valores. Saldos do dia, saldo final
 * e total da fatura são recalculados para a conferência dos leitores continuar
 * fechando. REVISE A SAÍDA À MÃO antes de commitar: o script não substitui a revisão.
 */
import fs from 'node:fs';
import { extractPdfText } from '../apps/server/src/imports/pdf-text.worker.mjs';
import { detectSource, normalizeText, type PdfPage, type SourceDoc, type TextItem } from '../packages/shared/src/imports';

const [input, output, seedArg] = process.argv.slice(2);
if (!input || !output) {
  console.error('Uso: npx tsx scripts/anonymize-import-fixture.ts <arquivo.pdf> <saida.json> [semente]');
  process.exit(1);
}

// Gerador determinístico (mulberry32): a mesma semente gera a mesma fixture.
let state = Number(seedArg ?? 42) >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
/** Troca cada dígito; o mesmo original vira sempre o mesmo número (agência e conta iguais em todas as páginas). */
const digitMap = new Map<string, string>();
const digits = (s: string) => {
  if (!digitMap.has(s)) digitMap.set(s, s.replace(/\d/g, () => String(int(0, 9))));
  return digitMap.get(s)!;
};
const money = (cents: number) => {
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${reais},${String(abs % 100).padStart(2, '0')}`;
};
/** Valor aleatório na mesma ordem de grandeza do original. */
const fakeCents = (orig: number) => {
  const abs = Math.abs(orig);
  const digitsCount = String(Math.max(1, Math.floor(abs / 100))).length;
  const max = 10 ** digitsCount * 100 - 1;
  const min = digitsCount === 1 ? 100 : 10 ** (digitsCount - 1) * 100;
  return int(min, max);
};

const PEOPLE = ['ANA CLARA EXEMPLO', 'BRUNO TESTE SILVA', 'CARLA FICTICIA', 'DIEGO MODELO SOUZA', 'ELISA AMOSTRA', 'FABIO DEMO LIMA', 'GABRIELA PROVA', 'HUGO EXEMPLAR', 'IRENE SIMULADA', 'JOAO FICTICIO'];
const SHOPS = ['LOJA ALFA', 'MERCADO BETA', 'PADARIA GAMA', 'FARMACIA DELTA', 'POSTO EPSILON', 'RESTAURANTE ZETA', 'LIVRARIA ETA', 'ACADEMIA TETA', 'CURSO IOTA', 'APP KAPPA', 'SERVICO LAMBDA', 'COMERCIO MI'];
const mapped = new Map<string, string>();
const pick = (list: string[], key: string) => {
  if (!mapped.has(key)) mapped.set(key, list[mapped.size % list.length]!);
  return mapped.get(key)!;
};

/** Rótulos do banco que ficam como estão (definem dicas e regras dos leitores). */
const KEEP = new Set(
  [
    'Extrato de Conta Corrente', 'Lançamentos', 'Dia', 'Lote', 'Documento', 'Histórico', 'Valor', 'Saldo Anterior', 'Saldo do dia', 'S A L D O',
    'Pix - Enviado', 'Pix - Recebido', 'Pagamento de Boleto', 'Pagamento conta luz', 'Compra com Cartão', 'Pagto cartão crédito', 'Recebimento de Proventos',
    'Cobrança de I.O.F.', 'IOF Saldo Devedor Conta', 'BB Rende Fácil', 'Rende Facil', 'Tarifa Pacote de Serviços', 'Cobrança de Juros',
    'Juros Saldo Devedor Conta', 'Pagamento BB Finan PF', 'BANCO XP S.A', 'RENOVÁVEL', 'Informações Adicionais', 'Informações Complementares - CET (*)',
    'Data', 'Descrição', 'País', 'BR', 'SALDO FATURA ANTERIOR', 'Pagamentos/Créditos', 'AJUSTE A CREDITO DE JUROS', 'Total da Fatura', 'Lançamentos nesta fatura',
  ].map(normalizeText),
);

const VALUE_ST = /^([\d.]+,\d{2})\s*\(([+-])\)$/;
const VALUE_INV = /^R\$\s*(-?)([\d.]+,\d{2})$/;
const cents = (s: string) => Number(s.replace(/\./g, '').replace(',', ''));

function rows(page: PdfPage): TextItem[][] {
  const out: TextItem[][] = [];
  for (const it of [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const r = out.find((x) => Math.abs(x[0]!.y - it.y) <= 2);
    if (r) r.push(it);
    else out.push([it]);
  }
  for (const r of out) r.sort((a, b) => a.x - b.x);
  return out;
}

/** Texto livre (nomes, endereço, favorecido): troca dígitos e nomes, mantém prefixo de hora e "PARC". */
function scrubFree(text: string, list: string[]): string {
  const t = text.trim();
  if (KEEP.has(normalizeText(t))) return text;
  if (/^Cobrança referente \d{2}\/\d{2}\/\d{4}$/.test(t)) return text;
  const timeMatch = /^(\d{2}\/\d{2}) \d{2}:\d{2} /.exec(t);
  // A hora da transação também é trocada; o dia fica (define a data da linha).
  const time = timeMatch ? `${timeMatch[1]} ${String(int(6, 22)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')} ` : '';
  let rest = t.slice(timeMatch ? timeMatch[0].length : 0);
  const parc = /\bPARC \d{2}\/\d{2}\b/.exec(rest)?.[0] ?? '';
  rest = rest.replace(/\bPARC \d{2}\/\d{2}\b/, '').trim();
  const lead = /^[\d./-]{5,}/.exec(rest)?.[0];
  const prefix = lead ? `${digits(lead)} ` : '';
  const body = lead ? rest.slice(lead.length).trim() : rest;
  const name = /[A-Za-zÀ-ú]/.test(body) ? pick(list, normalizeText(body)) : digits(body);
  return `${time}${prefix}${name}${parc ? ` ${parc}` : ''}`.trim();
}

const doc = await extractPdfText(fs.readFileSync(input));
const reader = detectSource(doc);
if (!reader || (reader.id !== 'bb-extrato-pdf' && reader.id !== 'bb-fatura-pdf')) {
  console.error('Só sei anonimizar extrato e fatura do BB.');
  process.exit(1);
}
const changed = new Set<string>();
const set = (it: TextItem, text: string) => {
  if (text !== it.text) changed.add(it.text.trim());
  it.text = text;
};

if (reader.id === 'bb-extrato-pdf') {
  let balance = 0;
  for (const page of doc.pages) {
    const header = page.items.find((i) => normalizeText(i.text) === 'HISTORICO');
    for (const row of rows(page)) {
      for (const it of row) {
        const t = it.text.trim();
        if (t.startsWith('Cliente:')) set(it, 'Cliente: FULANO DE TAL EXEMPLO');
        else if (/^Agência:/.test(t)) set(it, `Agência: ${digits(t.slice(9))}`);
        else if (/^Conta:/.test(t)) set(it, `Conta: ${digits(t.slice(7))}`);
        else if (header && it.y < header.y && it.x < header.x - 4 && /^\d+$/.test(t)) set(it, digits(t)); // lote e documento
        else if (header && Math.abs(it.x - header.x) <= 8 && !VALUE_ST.test(t)) set(it, scrubFree(t, PEOPLE));
      }
      const value = row.find((i) => VALUE_ST.test(i.text.trim()));
      if (!value) continue;
      const m = VALUE_ST.exec(value.text.trim())!;
      const label = normalizeText(row.find((i) => header && Math.abs(i.x - header.x) <= 8)?.text ?? '');
      let next: number;
      if (label === 'SALDO ANTERIOR') next = balance = int(0, 500000) * (rand() < 0.5 ? -1 : 1);
      else if (label === 'SALDO DO DIA' || label === 'S A L D O') next = balance;
      else {
        const signedNew = fakeCents(cents(m[1]!)) * (m[2] === '-' ? -1 : 1);
        balance += signedNew;
        next = signedNew;
      }
      set(value, `${money(Math.abs(next))} (${next < 0 ? '-' : '+'})`);
    }
    // Bloco informativo do fim (limite, CET): valores em reais trocados; taxas (%) ficam.
    for (const it of page.items) {
      const t = it.text.trim();
      if (!VALUE_ST.test(t) && !t.includes('%') && /\d,\d{2}/.test(t)) set(it, it.text.replace(/\d{1,3}(?:\.\d{3})*,\d{2}/g, () => money(int(100, 2000000))));
    }
  }
} else {
  const final = String(int(1000, 9999));
  let previous = 0;
  let total = 0;
  let inList = false;
  for (const page of doc.pages) {
    for (const row of rows(page)) {
      const first = row[0]!;
      const rowNorm = normalizeText(row.map((i) => i.text).join(' '));
      if (rowNorm.startsWith('DATA DESCRICAO')) inList = true;
      for (const it of row) {
        const t = it.text.trim();
        if (/Final \d{4}/.test(t)) set(it, t.replace(/Final \d{4}/, `Final ${final}`));
        else if (/\(Cartão \d{4}\)/.test(t)) set(it, `FULANO DE TAL (Cartão ${final})`);
        else if (/^Olá, /.test(t)) set(it, t.replace(/^Olá, [^,]+,/, 'Olá, Fulano,'));
        else if (/\d{5}\.\d{5} \d{5}\.\d{6}/.test(t)) set(it, digits(t));
        else if (page === doc.pages[0] && it.y > 780) set(it, it.x < 100 ? 'Fulano de Tal' : 'RUA EXEMPLO 100, BAIRRO, CIDADE, UF - 00000000');
      }
      const value = row.find((i) => VALUE_INV.test(i.text.trim()));
      if (inList && rowNorm.startsWith('TOTAL DA FATURA') && value) {
        set(value, `R$ ${money(total)}`);
        inList = false;
        continue;
      }
      if (inList && value) {
        const m = VALUE_INV.exec(value.text.trim())!;
        const neg = m[1] === '-';
        let next: number;
        if (rowNorm.startsWith('SALDO FATURA ANTERIOR')) next = previous = fakeCents(cents(m[2]!));
        else if (neg && /^\d{2}\/\d{2} (PGTO|PAGAMENTO)/.test(rowNorm)) next = -previous;
        else next = fakeCents(cents(m[2]!)) * (neg ? -1 : 1);
        total += next;
        set(value, `R$ ${money(next)}`);
        // Descrição: estabelecimento fictício, mantendo "PARC xx/yy" e os encargos.
        const descs = row.filter((i) => i !== first && i !== value && normalizeText(i.text) !== 'BR');
        descs.forEach((d, k) => {
          const dn = normalizeText(d.text);
          if (KEEP.has(dn) || /^(IOF|JUROS|PGTO)/.test(dn)) return; // rótulos do banco ficam
          if (k === 0) set(d, scrubFree(d.text, SHOPS));
          else set(d, `${/\bPARC \d{2}\/\d{2}\b/.exec(d.text)?.[0] ?? ''} CIDADE`.trim());
        });
        if (first && /^\d{2}\/\d{2}$/.test(first.text.trim()) === false && !KEEP.has(normalizeText(first.text))) set(first, scrubFree(first.text, SHOPS));
      } else if (!inList) {
        for (const it of row) if (/\d{1,3}(?:\.\d{3})*,\d{2}/.test(it.text) && !/%/.test(it.text)) set(it, it.text.replace(/\d{1,3}(?:\.\d{3})*,\d{2}/g, () => money(int(100, 5000000))));
      }
    }
  }
  // Resumo da primeira página: o total acompanha o total recalculado.
  for (const row of rows(doc.pages[0]!)) {
    if (normalizeText(row[0]!.text) === 'TOTAL' || (row.length >= 2 && normalizeText(row.map((i) => i.text).join(' ')).includes(' TOTAL R$'))) {
      const v = row.find((i) => VALUE_INV.test(i.text.trim()));
      if (v) set(v, `R$ ${money(total)}`);
    }
  }
}

// Conferência: a fixture tem que ser lida sem avisos e com o mesmo número de linhas.
const before = reader.read(await extractPdfText(fs.readFileSync(input)));
const after = reader.read(doc);
if (after.lines.length !== before.lines.length) throw new Error(`linhas: ${before.lines.length} → ${after.lines.length}`);
if (after.warnings.length) throw new Error(`a fixture não fecha: ${JSON.stringify(after.warnings)}`);
// Nenhum texto trocado pode sobrar na saída.
const out = JSON.stringify(doc);
const leaks = [...changed].filter((t) => t.length >= 4 && out.includes(t));
if (leaks.length) throw new Error(`textos originais ainda presentes: ${leaks.length}`);
fs.writeFileSync(output, JSON.stringify(doc, null, 1) + '\n');
console.log(`fixture gravada: ${after.lines.length} linhas, ${changed.size} textos trocados. Revise à mão antes de commitar.`);
