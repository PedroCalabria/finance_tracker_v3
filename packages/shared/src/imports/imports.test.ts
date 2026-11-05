import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignMatches,
  assignOrder,
  brDate,
  classifyInvoice,
  classifyStatement,
  detectSource,
  importConfirmInput,
  inferPurchaseDate,
  maskTaxIds,
  normalizeForFingerprint,
  parseCents,
  parseCentsDot,
  payeeBankOf,
  scoreMatch,
  similarity,
  type MatchCandidate,
  type SourceDoc,
} from './index';

/** Fixtures anonimizadas (ADR-0010): texto posicionado gerado de PDFs reais, sem dados reais. */
const dir = path.join(__dirname, '__fixtures__');
const pdf = (name: string): SourceDoc => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const ofx1252 = (): SourceDoc => ({ kind: 'text', text: new TextDecoder('windows-1252').decode(fs.readFileSync(path.join(dir, 'exemplo.ofx'))) });
const ofxXml = (): SourceDoc => ({ kind: 'text', text: fs.readFileSync(path.join(dir, 'exemplo-v2.ofx'), 'utf8') });
const read = (doc: SourceDoc) => {
  const r = detectSource(doc);
  if (!r) throw new Error('não detectado');
  return { reader: r, ...r.read(doc) };
};
const countBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});

describe('importação: utilitários', () => {
  it('lê valores sem ponto flutuante', () => {
    expect(parseCents('1.234,56')).toBe(123456);
    expect(parseCents('-12.345,67')).toBe(-1234567);
    expect(parseCents('0,05')).toBe(5);
    expect(parseCents('1.234')).toBeNull();
    expect(parseCentsDot('-123.45')).toBe(-12345);
    expect(parseCentsDot('5000.00')).toBe(500000);
    expect(parseCentsDot('12.3')).toBe(1230);
    expect(parseCentsDot('7')).toBe(700);
  });

  it('mascara CPF e CNPJ, com e sem pontuação, mantendo os 2 últimos dígitos', () => {
    expect(maskTaxIds('Pix - Recebido · 14/10 09:15 12345678901 FULANA')).toBe('Pix - Recebido · 14/10 09:15 •••••••••01 FULANA');
    expect(maskTaxIds('123.456.789-09 Fulana')).toBe('•••••••••09 Fulana');
    expect(maskTaxIds('12.345.678/0001-90 EMPRESA')).toBe('••••••••••••90 EMPRESA');
    expect(maskTaxIds('00012345678901 X')).toBe('••••••••••••01 X');
    // Documento de 15 dígitos e telefones de 12 não são CPF/CNPJ.
    expect(maskTaxIds('123456789012345')).toBe('123456789012345');
    expect(maskTaxIds('ZE DELIVERY 551398132992')).toBe('ZE DELIVERY 551398132992');
  });

  it('impressão digital: normaliza a descrição e numera linhas idênticas', () => {
    expect(normalizeForFingerprint('  Pix -  Enviado · João ')).toBe('PIX - ENVIADO · JOAO');
    const lines = assignOrder([
      { date: '2026-10-20', amountCents: 1500, direction: 'debit' as const, document: null, description: 'Pix - Enviado Banca', order: 0 },
      { date: '2026-10-20', amountCents: 1500, direction: 'debit' as const, document: null, description: 'PIX - ENVIADO BANCA', order: 0 },
      { date: '2026-10-20', amountCents: 1600, direction: 'debit' as const, document: null, description: 'Pix - Enviado Banca', order: 0 },
    ]);
    expect(lines.map((l) => l.order)).toEqual([1, 2, 1]);
  });

  it('data da fatura sem ano: até o fechamento, perto do mês esperado (inclusive parcelas)', () => {
    expect(inferPurchaseDate('20/12', '2027-01-26')).toBe('2026-12-20');
    expect(inferPurchaseDate('21/03', '2027-01-26', 11)).toBe('2026-03-21');
    expect(inferPurchaseDate('25/10', '2026-10-26')).toBe('2026-10-25');
    expect(inferPurchaseDate('27/10', '2026-10-26')).toBe('2025-10-27');
    expect(inferPurchaseDate('21/01', '2026-10-26', 9)).toBe('2026-01-21');
    expect(inferPurchaseDate('29/02', '2027-01-26')).toBe('2024-02-29');
    expect(brDate('05/11/2026')).toBe('2026-11-05');
    expect(brDate('31/02/2026')).toBeNull();
  });

  it('classifica pela descrição', () => {
    expect(classifyStatement('BB Rende Fácil · Rende Facil', 'credit')).toMatchObject({ hint: 'investment_sweep', ignoreByDefault: true });
    expect(classifyStatement('Pagto cartão crédito', 'debit').hint).toBe('invoice_payment');
    expect(classifyStatement('Cobrança de I.O.F. · IOF Saldo Devedor Conta', 'debit')).toMatchObject({ hint: 'fee', method: 'debit' });
    expect(classifyStatement('Pagamento BB Finan PF · 123- X', 'debit').hint).toBe('financing');
    expect(classifyStatement('Recebimento de Proventos · EMPRESA', 'credit')).toMatchObject({ hint: 'salary', method: 'transfer' });
    expect(classifyStatement('Pix - Enviado · FULANO', 'debit')).toMatchObject({ hint: 'pix', method: 'pix' });
    expect(classifyStatement('Depósito qualquer', 'credit')).toMatchObject({ hint: 'other', method: 'transfer' });
    expect(classifyInvoice('IOF DIAR ROT PF', 739, false).hint).toBe('fee');
    expect(classifyInvoice('AJUSTE A CREDITO DE JUROS', -5999, false)).toMatchObject({ hint: 'refund', ignoreByDefault: true });
    expect(classifyInvoice('LOJA PARC 02/03', 1000, true).hint).toBe('installment');
    expect(payeeBankOf('BANCO XP S.A')).toBe('XP');
    expect(payeeBankOf('BANCO INTER SA')).toBe('INTER');
    expect(payeeBankOf('ALLIANZ SEGUROS S A')).toBeNull();
  });
});

describe('importação: detecção', () => {
  it('reconhece cada origem pelo conteúdo', () => {
    expect(detectSource(pdf('bb-extrato.json'))?.id).toBe('bb-extrato-pdf');
    expect(detectSource(pdf('bb-fatura.json'))?.id).toBe('bb-fatura-pdf');
    expect(detectSource(ofx1252())?.id).toBe('ofx');
    expect(detectSource(ofxXml())?.id).toBe('ofx');
  });
  it('documento desconhecido não tem leitor', () => {
    expect(detectSource({ kind: 'pdf', pages: [{ width: 595, height: 842, items: [{ x: 10, y: 800, w: 100, text: 'Fatura Banco Qualquer' }] }] })).toBeNull();
    expect(detectSource({ kind: 'text', text: 'Data;Valor;Descrição\n01/10;10,00;X' })).toBeNull();
  });
});

describe('leitor: extrato BB em PDF', () => {
  const r = read(pdf('bb-extrato.json'));

  it('cabeçalho, linhas e conferência com os saldos do dia', () => {
    expect(r.header).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', accountLabel: 'Conta ••72-1', invoice: null });
    expect(r.header.accountRef).toBe('0096-5/442572-1');
    expect(r.lines).toHaveLength(31);
    expect(r.warnings).toEqual([]);
    expect(countBy(r.lines, (l) => l.hint)).toEqual({ salary: 1, debit_card: 2, invoice_payment: 1, pix: 16, boleto: 5, fee: 3, investment_sweep: 1, financing: 2 });
  });

  it('histórico em até três trechos, com o valor da linha principal', () => {
    expect(r.lines[0]).toMatchObject({
      date: '2026-10-01',
      direction: 'credit',
      amountCents: 3618560,
      hint: 'salary',
      description: 'Recebimento de Proventos · ••••••••••••13 ANA CLARA EXEMPLO',
      name: 'ANA CLARA EXEMPLO',
      document: '928111',
    });
    // Nome que quebrou em duas linhas no PDF volta a ser um só.
    expect(r.lines[3]).toMatchObject({ description: 'Pix - Enviado · CARLA FICTICIA DIEGO MODELO SOUZA', amountCents: 764698, method: 'pix' });
    // Prefixo "dd/mm hh:mm" do Pix sai da descrição.
    expect(r.lines[9]).toMatchObject({ date: '2026-10-02', description: 'Pix - Enviado · HUGO EXEMPLAR' });
  });

  it('linhas com tratamento próprio', () => {
    expect(r.lines.find((l) => l.hint === 'investment_sweep')).toMatchObject({ ignoreByDefault: true, explanation: 'Aplicação/resgate automático' });
    expect(r.lines.find((l) => l.payeeBank)).toMatchObject({ payeeBank: 'XP', hint: 'boleto', amountCents: 610200 });
    expect(r.lines.find((l) => l.description.startsWith('Tarifa'))).toMatchObject({ hint: 'fee', name: 'Tarifa Pacote de Serviços', amountCents: 7221 });
    expect(r.lines.filter((l) => l.hint === 'financing').map((l) => l.name)).toEqual(['Pagamento BB Finan PF', 'Pagamento BB Finan PF']);
    expect(r.lines.find((l) => l.hint === 'invoice_payment')).toMatchObject({ description: 'Pagto cartão crédito', amountCents: 9707556 });
    // Saldos e bloco de informações não viram linhas.
    expect(r.lines.some((l) => /^(Saldo|S A L D O)|Informa/i.test(l.description))).toBe(false);
  });

  it('linha perdida aparece na conferência', () => {
    const doc = pdf('bb-extrato.json') as Extract<SourceDoc, { kind: 'pdf' }>;
    const page = doc.pages[0]!;
    const value = page.items.find((i) => i.text === '4,20 (-)')!;
    page.items = page.items.filter((i) => i !== value);
    const broken = read(doc);
    expect(broken.lines).toHaveLength(30);
    expect(broken.warnings[0]).toMatchObject({ code: 'balance_mismatch', date: '2026-10-01', diffCents: -420 });
  });
});

describe('leitor: fatura Ourocard em PDF', () => {
  const r = read(pdf('bb-fatura.json'));

  it('cabeçalho e conferência com o total', () => {
    expect(r.header).toMatchObject({ accountLabel: 'final ••04', invoice: { dueDate: '2026-11-05', closingDate: '2026-10-26', totalCents: 2231842 } });
    expect(r.header.accountRef).toBe('final 5604');
    expect(r.lines).toHaveLength(77);
    expect(r.warnings).toEqual([]);
    expect(countBy(r.lines, (l) => l.hint)).toEqual({ refund: 1, purchase: 43, fee: 2, installment: 31 });
  });

  it('compras, seções, parcelas com o ano certo e crédito a decidir', () => {
    expect(r.lines[0]).toMatchObject({ hint: 'refund', direction: 'credit', amountCents: 4913, ignoreByDefault: true, section: 'Pagamentos/Créditos' });
    expect(r.lines[1]).toMatchObject({ date: '2026-10-07', direction: 'debit', amountCents: 3770, description: 'LOJA ALFA CIDADE', section: 'Educação', method: 'credit' });
    expect(r.lines[4]).toMatchObject({ date: '2026-09-24' });
    expect(r.lines[46]).toMatchObject({ date: '2026-01-21', parcel: { n: 9, of: 10 }, name: 'APP KAPPA CIDADE', section: 'Compras parceladas' });
    expect(r.lines.filter((l) => l.hint === 'fee').map((l) => l.description)).toEqual(['IOF DIAR ROT PF REF.09/26', 'IOF ADIC ROT PF REF.09/26']);
    // Saldo anterior e pagamento da fatura anterior não viram linhas.
    expect(r.lines.some((l) => /SALDO FATURA|PGTO/.test(l.description))).toBe(false);
  });

  it('linha perdida aparece na conferência', () => {
    const doc = pdf('bb-fatura.json') as Extract<SourceDoc, { kind: 'pdf' }>;
    const page = doc.pages[2]!;
    const value = page.items.find((i) => i.text === 'R$ 467,32')!;
    page.items = page.items.filter((i) => i !== value);
    expect(read(doc).warnings[0]).toMatchObject({ code: 'total_mismatch', diffCents: 46732 });
  });
});

describe('leitor: OFX', () => {
  it('SGML 1.x em Windows-1252', () => {
    const r = read(ofx1252());
    expect(r.header).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', bankName: 'Banco do Brasil', accountLabel: 'Conta ••65-4' });
    expect(r.lines).toHaveLength(7);
    expect(r.lines[0]).toMatchObject({ date: '2026-10-05', direction: 'debit', amountCents: 12345, document: 'OFX0001', hint: 'pix' });
    expect(r.lines[1]).toMatchObject({ description: 'Tarifa Pacote de Serviços', hint: 'fee' });
    expect(r.lines[2]!.hint).toBe('invoice_payment');
    expect(r.lines[3]).toMatchObject({ payeeBank: 'XP', description: 'Pagamento de Boleto · BANCO XP S.A' });
    expect(r.lines[4]).toMatchObject({ direction: 'credit', hint: 'salary', description: 'Recebimento de Proventos ••••••••••••90 EMPRESA EXEMPLO' });
  });
  it('XML 2.x em UTF-8', () => {
    const r = read(ofxXml());
    expect(r.header).toMatchObject({ bankName: 'Nubank', periodStart: '2026-11-01', periodEnd: '2026-11-15' });
    expect(r.lines.map((l) => [l.date, l.direction, l.amountCents, l.description, l.hint])).toEqual([
      ['2026-11-03', 'debit', 8990, 'Compra no débito · Mercado & Cia', 'debit_card'],
      ['2026-11-05', 'credit', 25000, 'Pix recebido · Fulana •••••••••09', 'pix'],
    ]);
  });
});

describe('casamento', () => {
  const cand = (over: Partial<MatchCandidate>): MatchCandidate => ({
    key: 'k',
    date: '2026-10-07',
    month: '2026-10',
    amountCents: 21000,
    description: 'Conta de luz',
    variable: false,
    tolerant: false,
    ...over,
  });
  const line = { date: '2026-10-07', amountCents: 21000, description: 'Pagamento conta luz · COMPANHIA DE LUZ' };

  it('valor igual e mesma data passa do limiar; fora da janela não casa', () => {
    expect(scoreMatch(line, cand({}), 7)!.score).toBeGreaterThanOrEqual(0.8);
    expect(scoreMatch(line, cand({ date: '2026-10-20' }), 7)).toBeNull();
    expect(scoreMatch(line, cand({ amountCents: 20000 }), 7)).toBeNull();
  });
  it('variável aceita até ±50%; fixa ou parcela até ±20%', () => {
    expect(scoreMatch({ ...line, amountCents: 30000 }, cand({ variable: true }), 7)!.score).toBeGreaterThanOrEqual(0.6);
    expect(scoreMatch({ ...line, amountCents: 24000 }, cand({ tolerant: true }), 7)!.exactAmount).toBe(false);
    expect(scoreMatch({ ...line, amountCents: 30000 }, cand({ tolerant: true }), 7)).toBeNull();
  });
  it('sem data p/ pagamento: vale o mesmo mês', () => {
    expect(scoreMatch(line, cand({ date: null }), 7)!.score).toBeGreaterThan(0.6);
    expect(scoreMatch(line, cand({ date: null, month: '2026-11' }), 7)).toBeNull();
  });
  it('a parcela "xx/yy" igual ganha bônus', () => {
    const p = { ...line, description: 'LOJA PARC 06/10', parcel: { n: 6, of: 10 } };
    const a = scoreMatch(p, cand({ parcel: { n: 6, of: 10 }, description: 'Óculos' }), 3)!.score;
    const b = scoreMatch(p, cand({ parcel: { n: 5, of: 10 }, description: 'Óculos' }), 3)!.score;
    // Com valor e data iguais o score já é 0,8; o bônus leva ao teto (1).
    expect(a).toBe(1);
    expect(b).toBeCloseTo(0.8);
  });
  it('semelhança ignora palavras genéricas', () => {
    expect(similarity('Pix - Enviado · ACADEMIA FORMA', 'Academia')).toBeGreaterThan(0.5);
    expect(similarity('Pix - Enviado · FULANO', 'Pix - Enviado · BELTRANO')).toBe(0);
  });
  it('cada lançamento casa com uma linha só', () => {
    const s = (score: number) => ({ score, exactAmount: true, dayDiff: 0 });
    const out = assignMatches(
      new Map([
        [0, [{ key: 'a', score: s(0.7) }]],
        [1, [{ key: 'a', score: s(0.9) }, { key: 'b', score: s(0.65) }]],
        [2, [{ key: 'c', score: s(0.5) }]],
      ]),
    );
    expect(out.get(1)!.best?.key).toBe('a');
    expect(out.get(0)!.best).toBeNull();
    expect(out.get(0)!.alternatives.map((x) => x.key)).toEqual(['a']);
    expect(out.get(2)!.best).toBeNull();
  });
});

describe('contrato da confirmação', () => {
  it('cada ação exige o seu alvo', () => {
    const base = { token: 'x'.repeat(30), accountId: '00000000-0000-4000-8000-000000000000' };
    expect(importConfirmInput.safeParse({ ...base, decisions: [{ index: 0, action: 'match' }] }).success).toBe(false);
    expect(importConfirmInput.safeParse({ ...base, decisions: [{ index: 0, action: 'invoice_payment' }] }).success).toBe(false);
    expect(importConfirmInput.safeParse({ ...base, decisions: [{ index: 0, action: 'create' }] }).success).toBe(false);
    expect(importConfirmInput.safeParse({ ...base, decisions: [{ index: 0, action: 'ignore' }, { index: 1, action: 'match', occurrenceId: 'p_x_2026-10' }] }).success).toBe(true);
  });
});
