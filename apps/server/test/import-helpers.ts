/**
 * PDFs sintéticos para os testes da importação (ADR-0010), escritos à mão, sem
 * dependência: texto em Helvetica posicionado como nos documentos do BB. Só
 * dados fictícios.
 */

export interface PdfText {
  x: number;
  y: number;
  text: string;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** PDF mínimo válido: uma página por lista de textos (A4, fonte Helvetica WinAnsi). */
export function pdfFromPages(pages: PdfText[][]): Buffer {
  const objs: string[] = [];
  /** Devolve o número do objeto (a contagem começa em 1). */
  const add = (body: string) => objs.push(body);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const items of pages) {
    const stream = items.map((t) => `BT /F1 9 Tf 1 0 0 1 ${t.x} ${t.y} Tm (${esc(t.text)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const money = (cents: number) => {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(abs % 100).padStart(2, '0')}`;
};

export interface StatementLine {
  /** "dd/mm/aaaa" */
  date: string;
  doc: string;
  /** Histórico (1º trecho) e favorecido (2º trecho, opcional). */
  h1: string;
  h2?: string;
  /** Positivo = crédito (+), negativo = débito (-). */
  cents: number;
}

/** Extrato de conta corrente no layout do BB, com "Saldo do dia" calculado. */
export function statementPdf(opts: { agencia?: string; conta?: string; start: string; end: string; opening?: number; lines: StatementLine[] }): Buffer {
  const items: PdfText[] = [
    { x: 25, y: 803, text: 'Extrato de Conta Corrente' },
    { x: 25, y: 783, text: 'Cliente: FULANO DE TAL' },
    { x: 20, y: 767, text: `Período: ${opts.start.slice(0, 2)} a ${opts.end}` },
    { x: 220, y: 767, text: `Agência: ${opts.agencia ?? '1234-5'}` },
    { x: 304, y: 767, text: `Conta: ${opts.conta ?? '99999-9'}` },
    { x: 30, y: 740, text: 'Lançamentos' },
    { x: 30, y: 726, text: 'Dia' },
    { x: 99, y: 726, text: 'Lote' },
    { x: 148, y: 726, text: 'Documento' },
    { x: 265, y: 726, text: 'Histórico' },
    { x: 550, y: 726, text: 'Valor' },
  ];
  let y = 711;
  let balance = opts.opening ?? 0;
  const value = (c: number) => `${money(c)} (${c < 0 ? '-' : '+'})`;
  items.push({ x: 30, y, text: opts.lines[0]?.date ?? opts.end }, { x: 265, y, text: 'Saldo Anterior' }, { x: 520, y, text: value(balance) });
  y -= 24;
  opts.lines.forEach((l, i) => {
    items.push({ x: 30, y, text: l.date }, { x: 99, y, text: '13105' }, { x: 148, y, text: l.doc }, { x: 520, y, text: value(l.cents) });
    items.push({ x: 265, y: y + 5, text: l.h1 });
    if (l.h2) items.push({ x: 265, y: y - 6, text: l.h2 });
    balance += l.cents;
    y -= 24;
    const next = opts.lines[i + 1];
    if (!next || next.date !== l.date) {
      items.push({ x: 30, y, text: l.date }, { x: 99, y, text: '13105' }, { x: 265, y, text: 'Saldo do dia' }, { x: 518, y, text: value(balance) });
      y -= 20;
    }
  });
  items.push({ x: 30, y, text: opts.end }, { x: 265, y, text: 'S A L D O' }, { x: 518, y, text: value(balance) });
  if (y < 40) throw new Error('extrato de teste longo demais para uma página');
  return pdfFromPages([items]);
}

export interface InvoiceLine {
  /** "dd/mm" */
  dm: string;
  desc: string;
  /** Positivo = compra; negativo = crédito. */
  cents: number;
  section?: string;
}

/** Fatura Ourocard no layout do BB, com "Total da Fatura" calculado. */
export function invoicePdf(opts: { final?: string; due: string; closing: string; previous?: number; lines: InvoiceLine[] }): Buffer {
  const previous = opts.previous ?? 0;
  // O saldo anterior e o pagamento dele se anulam: o total é a soma dos lançamentos.
  const total = opts.lines.reduce((s, l) => s + l.cents, 0);
  const page1: PdfText[] = [
    { x: 40, y: 748, text: 'Olá, Fulano, esta é sua fatura de' },
    { x: 399, y: 748, text: 'OUROCARD ELO NANQUIM' },
    { x: 522, y: 748, text: `Final ${opts.final ?? '4321'}` },
    { x: 399, y: 728, text: 'Resumo da fatura' },
    { x: 240, y: 725, text: 'Vencimento' },
    { x: 240, y: 703, text: opts.due },
    { x: 399, y: 647, text: 'Total' },
    { x: 515, y: 647, text: `R$ ${money(total)}` },
  ];
  const page2: PdfText[] = [
    { x: 40, y: 432, text: 'Fatura fechada em' },
    { x: 155, y: 432, text: opts.closing },
    { x: 50, y: 354, text: 'Lançamentos nesta fatura' },
    { x: 48, y: 266, text: 'FULANO DE TAL (Cartão 4321)' },
    { x: 48, y: 250, text: 'Data' },
    { x: 82, y: 250, text: 'Descrição' },
    { x: 442, y: 250, text: 'País' },
    { x: 524, y: 250, text: 'Valor' },
  ];
  const page3: PdfText[] = [];
  let y = 234;
  let page = page2;
  const row = (texts: PdfText[]) => {
    if (y < 40) {
      page = page3;
      y = 766;
    }
    page.push(...texts.map((t) => ({ ...t, y })));
    y -= 16;
  };
  if (previous) {
    row([{ x: 82, y: 0, text: 'SALDO FATURA ANTERIOR' }, { x: 446, y: 0, text: 'BR' }, { x: 503, y: 0, text: `R$ ${money(previous)}` }]);
    row([{ x: 82, y: 0, text: 'Pagamentos/Créditos' }]);
    row([{ x: 48, y: 0, text: '01/10' }, { x: 82, y: 0, text: 'PGTO. CASH AG.' }, { x: 446, y: 0, text: 'BR' }, { x: 499, y: 0, text: `R$ -${money(previous)}` }]);
  }
  let section: string | undefined;
  for (const l of opts.lines) {
    if (l.section && l.section !== section) {
      section = l.section;
      row([{ x: 82, y: 0, text: l.section }]);
    }
    row([{ x: 48, y: 0, text: l.dm }, { x: 82, y: 0, text: l.desc }, { x: 446, y: 0, text: 'BR' }, { x: 510, y: 0, text: `R$ ${l.cents < 0 ? '-' : ''}${money(l.cents)}` }]);
  }
  row([{ x: 48, y: 0, text: 'Total da Fatura' }, { x: 490, y: 0, text: `R$ ${money(total)}` }]);
  return pdfFromPages(page3.length ? [page1, page2, page3] : [page1, page2]);
}

/** Corpo multipart (sem dependência) para `app.inject`. A senha vai antes do arquivo. */
export function multipart(file: Buffer, filename: string, fields: Record<string, string> = {}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----ffimport' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
