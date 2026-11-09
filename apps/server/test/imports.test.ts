import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client, TestEnv } from './helpers';
import { setup, signedIn } from './helpers';
import { invoicePdf, multipart, pdfFromPages, statementPdf } from './import-helpers';

/** Importação de extratos e faturas (ADR-0010). Hoje nos testes: 03/11/2026. Só dados fictícios. */
let env: TestEnv;

const send = async (c: Client, file: Buffer, fields: Record<string, string> = {}, name = 'arquivo.pdf') => {
  const { payload, headers } = multipart(file, name, fields);
  return env.app.inject({
    method: 'POST',
    url: c.w('/imports/preview'),
    payload,
    headers: { ...headers, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
};
const count = async (table: string) => Number(((await env.ctx.db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0] as { n: number }).n);
const occ = async (c: Client, month: string, type = 'expense') => (await c.get(c.w(`/occurrences?month=${month}&type=${type}`))).json();
const find = (rows: Array<{ description: string; competenceMonth?: string }>, d: string, month?: string) =>
  rows.find((r) => r.description === d && (!month || r.competenceMonth === month)) as Record<string, any>;
const create = async (c: Client, body: Record<string, unknown>) => {
  const res = await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', ...body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
};
/** Decisões = sugestões, com ajustes por índice. */
const decisionsOf = (lines: any[], over: Record<number, Record<string, unknown>> = {}) =>
  lines
    .filter((l) => l.suggestion.action !== 'already')
    .map((l) => {
      const s = l.suggestion;
      const base: Record<string, unknown> = { index: l.index, action: s.action };
      if (s.action === 'match') base.occurrenceId = s.target.occurrenceId;
      if (s.action === 'invoice_payment') base.invoiceId = s.target.invoiceId;
      if (s.action === 'create') base.create = { description: s.create.description, categoryId: s.create.categoryId, method: s.create.method };
      return { ...base, ...(over[l.index] ?? {}) };
    });

beforeAll(async () => {
  env = await setup();
});
afterAll(async () => env.close());

describe('envio do arquivo', () => {
  let c: Client;
  beforeAll(async () => {
    c = await signedIn(env, 'rotas@example.com', 'Rotas');
  });

  it('recusa o que não é PDF nem OFX, e arquivo grande demais', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]), Buffer.alloc(64)]);
    const r1 = await send(c, jpeg, {}, 'extrato.pdf');
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe('import_unsupported_file');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)]);
    const r2 = await send(c, big);
    expect(r2.statusCode).toBe(413);
    expect(r2.json().error.message).toBe('O arquivo passa de 10 MB.');
  });

  it('PDF com senha: pede, recusa a errada e abre com a certa', async () => {
    const file = fs.readFileSync(path.join(__dirname, 'fixtures', 'extrato-com-senha.pdf'));
    const r1 = await send(c, file);
    expect([r1.statusCode, r1.json().error.code]).toEqual([422, 'pdf_password_required']);
    const r2 = await send(c, file, { password: 'errada' });
    expect([r2.statusCode, r2.json().error.code, r2.json().error.message]).toEqual([422, 'pdf_password_incorrect', 'Senha incorreta.']);
    const r3 = await send(c, file, { password: 'segredo' });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().source.readerId).toBe('bb-extrato-pdf');
    expect(r3.json().lineCount).toBe(1);
  });

  it('documento sem leitor', async () => {
    const r = await send(c, pdfFromPages([[{ x: 40, y: 800, text: 'Fatura do Banco Qualquer' }]]));
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'import_unknown_source']);
  });

  it('a prévia não grava nada', async () => {
    const before = await Promise.all(['items', 'payments', 'import_lines', 'import_batches', 'attachments'].map(count));
    const file = statementPdf({ start: '01/10/2026', end: '31/10/2026', lines: [{ date: '05/10/2026', doc: '1', h1: 'Pix - Enviado', h2: 'FULANO', cents: -1000 }] });
    expect((await send(c, file)).statusCode).toBe(200);
    expect(await Promise.all(['items', 'payments', 'import_lines', 'import_batches', 'attachments'].map(count))).toEqual(before);
    expect(env.storage.blobs.size).toBe(0);
  });
});

describe('conciliação de extrato', () => {
  let c: Client;
  let conta: string;
  let bbCard: string;
  let xpCard: string;
  let file: Buffer;
  let preview: any;

  beforeAll(async () => {
    c = await signedIn(env, 'extrato@example.com', 'Extrato');
    conta = (await c.post(c.w('/accounts'), { name: 'Conta BB', bank: 'Banco do Brasil', kind: 'account' })).json().id;
    bbCard = (await c.post(c.w('/accounts'), { name: 'Ourocard', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 25, dueDay: 5 })).json().id;
    xpCard = (await c.post(c.w('/accounts'), { name: 'Cartão XP', bank: 'XP', kind: 'credit_card', closingDay: 20, dueDay: 28 })).json().id;
    // Fatura de outubro do BB (vence 05/10) e do XP (vence 28/10).
    await create(c, { description: 'Compra BB', method: 'credit', accountId: bbCard, amountCents: 150000, date: '2026-09-10' });
    await create(c, { description: 'Compra XP', method: 'credit', accountId: xpCard, amountCents: 80010, date: '2026-10-05' });
    await create(c, { description: 'Internet', form: 'recurring', method: 'boleto', accountId: conta, amountCents: 12000, startMonth: '2026-10', day: 10 });
    await create(c, { description: 'Água', form: 'recurring', method: 'boleto', accountId: conta, amountCents: 9000, variableAmount: true, startMonth: '2026-10', day: 15 });
    await create(c, { description: 'Academia', method: 'pix', accountId: conta, amountCents: 9900, date: '2026-10-05', alreadyPaid: true });
    await create(c, { description: 'Financiamento energia', form: 'installment', installments: 3, method: 'debit', accountId: conta, amountCents: 255000, date: '2026-10-22' });
    await create(c, { description: 'Mercado', method: 'debit', accountId: conta, amountCents: 31000, date: '2026-10-12', alreadyPaid: true });
    file = statementPdf({
      start: '01/10/2026',
      end: '31/10/2026',
      opening: 1_000_000,
      lines: [
        { date: '01/10/2026', doc: '9001', h1: 'Pagto cartão crédito', cents: -150000 },
        { date: '05/10/2026', doc: '9002', h1: 'Pix - Enviado', h2: '05/10 07:00 ACADEMIA FORMA', cents: -9900 },
        { date: '10/10/2026', doc: '9003', h1: 'Pagamento de Boleto', h2: 'NET INTERNET', cents: -13500 },
        { date: '13/10/2026', doc: '9004', h1: 'Tarifa Pacote de Serviços', h2: 'Cobrança referente 13/10/2026', cents: -3000 },
        { date: '15/10/2026', doc: '9005', h1: 'Pagamento conta agua', h2: 'COMPANHIA DE AGUA', cents: -11250 },
        { date: '16/10/2026', doc: '9006', h1: 'Pix - Enviado', h2: '16/10 20:13 LOJA EXEMPLO', cents: -4000 },
        { date: '20/10/2026', doc: '9007', h1: 'BB Rende Fácil', h2: 'Rende Facil', cents: 100000 },
        { date: '22/10/2026', doc: '9008', h1: 'Pagamento BB Finan PF', h2: '123456789-BB CREDITO ENERGIA', cents: -85000 },
        { date: '28/10/2026', doc: '9009', h1: 'Pagamento de Boleto', h2: 'BANCO XP S.A', cents: -80010 },
      ],
    });
    const res = await send(c, file);
    expect(res.statusCode).toBe(200);
    preview = res.json();
  });

  it('detecta a origem, pré-seleciona a única conta do BB e sugere cada linha', () => {
    expect(preview.source).toMatchObject({ readerId: 'bb-extrato-pdf', kind: 'statement', bank: 'Banco do Brasil' });
    expect(preview.header).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', accountLabel: 'Conta ••99-9' });
    expect(preview.warnings).toEqual([]);
    expect(preview.destinations.options.map((o: any) => o.id)).toEqual([conta]);
    expect(preview.destinations.suggestedAccountId).toBe(conta);
    const s = preview.suggestions.lines.map((l: any) => [l.suggestion.action, l.suggestion.target?.description ?? l.suggestion.target?.accountName ?? null, l.suggestion.questions]);
    expect(s).toEqual([
      ['invoice_payment', 'Ourocard', []],
      ['match', 'Academia', []],
      ['match', 'Internet', ['amount_scope']],
      ['create', null, []],
      ['match', 'Água', []],
      ['create', null, []],
      ['ignore', null, []],
      ['match', 'Financiamento energia', []],
      ['invoice_payment', 'Cartão XP', []],
    ]);
    expect(preview.suggestions.lines[1].suggestion.target.alreadyPaid).toMatchObject({ amountCents: 9900, paidAt: '2026-10-05' });
    expect(preview.suggestions.lines[3].suggestion.create).toMatchObject({ description: 'Tarifa Pacote de Serviços', method: 'debit', type: 'expense' });
    expect(preview.suggestions.lines[5].suggestion.create).toMatchObject({ description: 'LOJA EXEMPLO', method: 'pix' });
    // Pago no app no período, mas sem linha no extrato.
    expect(preview.suggestions.unmatchedApp.map((u: any) => [u.description, u.paidAt])).toEqual([['Mercado', '2026-10-12']]);
  });

  it('sem resposta para "só este mês ou daqui em diante", nada é gravado', async () => {
    const before = await count('payments');
    const res = await c.post(c.w('/imports/confirm'), { token: preview.token, accountId: conta, decisions: decisionsOf(preview.suggestions.lines) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'amount_scope_required', fields: { 'decisions.2': expect.any(String) } });
    expect(await count('payments')).toBe(before);
  });

  it('confirma tudo numa transação', async () => {
    const res = await c.post(c.w('/imports/confirm'), {
      token: preview.token,
      accountId: conta,
      decisions: decisionsOf(preview.suggestions.lines, { 2: { amountScope: 'occurrence' }, 5: { create: { description: 'Loja Exemplo', method: 'pix' } } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toEqual({ paid: 3, linked: 1, created: 2, invoicePaid: 2, ignored: 1, already: 0 });
    const oct = await occ(c, '2026-10');
    // Recorrente fixa, só este mês: outubro pago com o valor do banco, a regra continua.
    expect(find(oct, 'Internet')).toMatchObject({ expectedCents: 13500, paidCents: 13500, displayStatus: 'paid' });
    expect(find(await occ(c, '2026-11'), 'Internet', '2026-11').expectedCents).toBe(12000);
    // Variável: o mês vale o que o banco cobrou, e o próximo começa com ele.
    expect(find(oct, 'Água')).toMatchObject({ expectedCents: 11250, displayStatus: 'paid' });
    expect(find(oct, 'Água').payments[0].paidAt).toBe('2026-10-15');
    expect(find(await occ(c, '2026-12'), 'Água').expectedCents).toBe(11250);
    // Parcela: a próxima em aberto.
    expect(find(oct, 'Financiamento energia')).toMatchObject({ installmentLabel: '1/3', displayStatus: 'paid' });
    // Já pago: só vinculou, sem segundo pagamento.
    expect(find(oct, 'Academia').payments).toHaveLength(1);
    // Novas: despesas únicas pagas na data da linha, na conta.
    expect(find(oct, 'Tarifa Pacote de Serviços')).toMatchObject({ method: 'debit', displayStatus: 'paid', account: expect.objectContaining({ id: conta }) });
    expect(find(oct, 'Loja Exemplo').payments[0].paidAt).toBe('2026-10-16');
    // Pagamento de fatura vira pagamento da fatura, não despesa.
    const bbInv = (await c.get(c.w('/invoices?month=2026-10'))).json().find((i: any) => i.account.id === bbCard);
    expect([bbInv.status, bbInv.paidCents]).toEqual(['paid', 150000]);
    const xpInv = (await c.get(c.w('/invoices?month=2026-10'))).json().find((i: any) => i.account.id === xpCard);
    expect(xpInv.status).toBe('paid');
    expect(find(oct, 'Pagto cartão crédito')).toBeUndefined();
    expect(await count('import_lines')).toBe(9);
  });

  it('reimportar não duplica: tudo "já conciliado"', async () => {
    const payments = await count('payments');
    const again = (await send(c, file)).json();
    expect(again.suggestions.lines.every((l: any) => l.suggestion.action === 'already')).toBe(true);
    const res = await c.post(c.w('/imports/confirm'), { token: again.token, accountId: conta, decisions: again.suggestions.lines.map((l: any) => ({ index: l.index, action: 'ignore' })) });
    expect(res.json().counts.already).toBe(9);
    expect(await count('payments')).toBe(payments);
  });

  it('período sobreposto: só as linhas novas', async () => {
    const overlap = statementPdf({
      start: '15/10/2026',
      end: '15/11/2026',
      opening: 1_000_000,
      lines: [
        { date: '16/10/2026', doc: '9006', h1: 'Pix - Enviado', h2: '16/10 20:13 LOJA EXEMPLO', cents: -4000 },
        { date: '02/11/2026', doc: '9100', h1: 'Pix - Enviado', h2: '02/11 08:00 PADARIA NOVA', cents: -1500 },
      ],
    });
    const p = (await send(c, overlap)).json();
    expect(p.suggestions.lines.map((l: any) => l.suggestion.action)).toEqual(['already', 'create']);
  });

  it('prévia adulterada ou vencida é recusada, e confirmar duas vezes não duplica', async () => {
    const [body, mac] = preview.token.split('.');
    // Troca o 1º caractere (6 bits inteiros): mexer no fim do base64 pode cair só nos bits de preenchimento.
    const forged = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}.${mac}`;
    const r1 = await c.post(c.w('/imports/confirm'), { token: forged, accountId: conta, decisions: [] });
    expect(r1.json().error.code).toBe('import_preview_invalid');
    env.setNow('2026-11-03T18:00:00Z');
    const r2 = await c.post(c.w('/imports/suggest'), { token: preview.token, accountId: conta });
    expect([r2.statusCode, r2.json().error.message]).toEqual([400, 'Esta prévia expirou. Envie o arquivo de novo.']);
    env.setNow('2026-11-03T15:00:00Z');
  });
});

describe('extrato: casos isolados', () => {
  let c: Client;
  let conta: string;
  beforeAll(async () => {
    c = await signedIn(env, 'casos@example.com', 'Casos');
    conta = (await c.post(c.w('/accounts'), { name: 'Conta', bank: 'Banco do Brasil', kind: 'account' })).json().id;
  });

  it('recorrente fixa mais cara "daqui em diante" muda a regra; valor menor pede desconto ou parcial', async () => {
    await create(c, { description: 'Seguro', form: 'recurring', method: 'boleto', accountId: conta, amountCents: 20000, startMonth: '2026-10', day: 19 });
    await create(c, { description: 'Escola', method: 'boleto', accountId: conta, amountCents: 50000, date: '2026-10-08' });
    const p = (
      await send(
        c,
        statementPdf({
          start: '01/10/2026',
          end: '31/10/2026',
          lines: [
            { date: '08/10/2026', doc: '1', h1: 'Pagamento de Boleto', h2: 'ESCOLA EXEMPLO', cents: -45000 },
            { date: '19/10/2026', doc: '2', h1: 'Pagamento de Boleto', h2: 'SEGURADORA', cents: -22000 },
          ],
        }),
      )
    ).json();
    expect(p.suggestions.lines.map((l: any) => l.suggestion.questions)).toEqual([['settlement'], ['amount_scope']]);
    const noSettlement = await c.post(c.w('/imports/confirm'), { token: p.token, accountId: conta, decisions: decisionsOf(p.suggestions.lines, { 1: { amountScope: 'forward' } }) });
    expect(noSettlement.json().error).toMatchObject({ code: 'settlement_required', fields: { 'decisions.0': expect.any(String) } });
    const ok = await c.post(c.w('/imports/confirm'), { token: p.token, accountId: conta, decisions: decisionsOf(p.suggestions.lines, { 0: { settlement: 'discount' }, 1: { amountScope: 'forward' } }) });
    expect(ok.statusCode).toBe(200);
    const oct = await occ(c, '2026-10');
    expect(find(oct, 'Escola')).toMatchObject({ displayStatus: 'paid', settledWithDiscount: true, paidCents: 45000 });
    expect(find(await occ(c, '2026-11'), 'Seguro', '2026-11').expectedCents).toBe(22000);
  });

  it('mês previsto é gravado antes de receber o pagamento; linhas idênticas viram duas', async () => {
    await create(c, { description: 'Clube', form: 'recurring', method: 'pix', accountId: conta, amountCents: 7000, startMonth: '2026-11', day: 1 });
    const p = (
      await send(
        c,
        statementPdf({
          start: '01/11/2026',
          end: '30/11/2026',
          lines: [
            { date: '20/11/2026', doc: '7', h1: 'Pix - Enviado', h2: 'BANCA', cents: -1500 },
            { date: '20/11/2026', doc: '7', h1: 'Pix - Enviado', h2: 'BANCA', cents: -1500 },
            { date: '30/11/2026', doc: '8', h1: 'Pix - Enviado', h2: '30/11 09:00 CLUBE ESPORTIVO', cents: -7000 },
          ],
        }),
      )
    ).json();
    const clube = p.suggestions.lines[2].suggestion;
    expect([clube.action, clube.target.projected, clube.target.occurrenceId]).toEqual(['match', true, expect.stringMatching(/^p_.+_2026-12$/)]);
    const res = await c.post(c.w('/imports/confirm'), { token: p.token, accountId: conta, decisions: decisionsOf(p.suggestions.lines) });
    expect(res.json().counts).toMatchObject({ created: 2, paid: 1 });
    const dec = find(await occ(c, '2026-12'), 'Clube');
    expect([dec.projected, dec.displayStatus]).toEqual([false, 'paid']);
    const again = (await send(c, statementPdf({ start: '01/11/2026', end: '30/11/2026', lines: [{ date: '20/11/2026', doc: '7', h1: 'Pix - Enviado', h2: 'BANCA', cents: -1500 }, { date: '20/11/2026', doc: '7', h1: 'Pix - Enviado', h2: 'BANCA', cents: -1500 }] }))).json();
    expect(again.suggestions.lines.map((l: any) => l.suggestion.action)).toEqual(['already', 'already']);
  });

  it('confirmação dupla da mesma prévia não duplica', async () => {
    const f = statementPdf({ start: '01/10/2026', end: '31/10/2026', lines: [{ date: '25/10/2026', doc: '55', h1: 'Pix - Enviado', h2: 'BAR', cents: -3300 }] });
    const p = (await send(c, f)).json();
    const body = { token: p.token, accountId: conta, decisions: decisionsOf(p.suggestions.lines) };
    expect((await c.post(c.w('/imports/confirm'), body)).json().counts.created).toBe(1);
    const second = (await c.post(c.w('/imports/confirm'), body)).json();
    expect(second.counts).toMatchObject({ created: 0, already: 1 });
    expect(find(await occ(c, '2026-10'), 'BAR').payments).toHaveLength(1);
  });
});

describe('conciliação de fatura', () => {
  let c: Client;
  let card: string;
  let card2: string;
  let preview: any;
  let pdf: Buffer;

  beforeAll(async () => {
    c = await signedIn(env, 'fatura@example.com', 'Fatura');
    card = (await c.post(c.w('/accounts'), { name: 'Ourocard', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 25, dueDay: 5 })).json().id;
    card2 = (await c.post(c.w('/accounts'), { name: 'Ourocard 2', bank: 'Banco do Brasil', kind: 'credit_card', closingDay: 25, dueDay: 5 })).json().id;
    await create(c, { description: 'Mercado', method: 'credit', accountId: card, amountCents: 25000, date: '2026-10-12' });
    await create(c, { description: 'Óculos', form: 'installment', installments: 10, method: 'credit', accountId: card, amountCents: 100000, date: '2026-06-10' });
    await create(c, { description: 'Farmácia', method: 'credit', accountId: card, amountCents: 3000, date: '2026-10-20' });
    await create(c, { description: 'Streaming', form: 'recurring', method: 'credit', accountId: card, amountCents: 5590, startMonth: '2026-10', day: 15 });
    pdf = invoicePdf({
      final: '4321',
      due: '05/11/2026',
      closing: '26/10/2026',
      previous: 100000,
      lines: [
        { dm: '02/10', desc: 'AJUSTE A CREDITO DE JUROS', cents: -2000, section: 'Pagamentos/Créditos' },
        { dm: '12/10', desc: 'MERCADO BOM', cents: 25000, section: 'Supermercados' },
        { dm: '15/10', desc: 'STREAMING EXEMPLO', cents: 5590, section: 'Lazer' },
        { dm: '26/10', desc: 'COMPRA PERTO', cents: 8000, section: 'Lazer' },
        { dm: '01/10', desc: 'IOF DIAR ROT PF', cents: 739, section: 'Outros lançamentos' },
        { dm: '10/06', desc: 'OTICA EXEMPLO PARC 05/10', cents: 10000, section: 'Compras parceladas' },
        { dm: '21/03', desc: 'LOJA ANTIGA PARC 08/10', cents: 12000, section: 'Compras parceladas' },
        { dm: '20/10', desc: 'LOJA NOVA PARC 01/03', cents: 5000, section: 'Compras parceladas' },
      ],
    });
    preview = (await send(c, pdf)).json();
  });

  it('identifica a fatura pelo vencimento; com dois cartões do BB, a pessoa escolhe', async () => {
    expect(preview.source).toMatchObject({ readerId: 'bb-fatura-pdf', kind: 'invoice' });
    expect(preview.header.invoice).toEqual({ dueDate: '2026-11-05', closingDate: '2026-10-26', totalCents: 64329 });
    expect(preview.destinations.options.map((o: any) => o.id).sort()).toEqual([card, card2].sort());
    expect(preview.destinations.suggestedAccountId).toBeNull();
    const wrong = await c.post(c.w('/imports/suggest'), { token: preview.token, accountId: (await c.post(c.w('/accounts'), { name: 'Conta', bank: 'BB', kind: 'account' })).json().id });
    expect(wrong.json().error.code).toBe('import_wrong_destination');
    preview.suggestions = (await c.post(c.w('/imports/suggest'), { token: preview.token, accountId: card })).json();
    expect(preview.suggestions.invoice).toMatchObject({ referenceMonth: '2026-11', appClosingDate: '2026-10-25', bankClosingDate: '2026-10-26', bankTotalCents: 64329 });
  });

  it('sugere casar compras, parcelas e recorrentes, criar o resto e ignorar créditos', () => {
    const s = preview.suggestions.lines.map((l: any) => [l.description, l.suggestion.action, l.suggestion.target?.description ?? null]);
    expect(s).toEqual([
      ['AJUSTE A CREDITO DE JUROS', 'ignore', null],
      ['MERCADO BOM', 'match', 'Mercado'],
      ['STREAMING EXEMPLO', 'match', 'Streaming'],
      ['COMPRA PERTO', 'create', null],
      ['IOF DIAR ROT PF', 'create', null],
      ['OTICA EXEMPLO PARC 05/10', 'match', 'Óculos'],
      ['LOJA ANTIGA PARC 08/10', 'create', null],
      ['LOJA NOVA PARC 01/03', 'create', null],
    ]);
    expect(preview.suggestions.lines[5].suggestion.target.installmentLabel).toBe('5/10');
    expect(preview.suggestions.unmatchedApp.map((u: any) => u.description)).toEqual(['Farmácia']);
  });

  it('confirma: itens nesta fatura, só as parcelas restantes, datas e valor real do banco', async () => {
    const res = await c.post(c.w('/imports/confirm'), {
      token: preview.token,
      accountId: card,
      decisions: decisionsOf(preview.suggestions.lines),
      invoice: { useBankDates: true, realAmountCents: 64329 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toMatchObject({ linked: 3, created: 4, ignored: 1 });
    const inv = (await c.get(c.w('/invoices?month=2026-11'))).json().find((i: any) => i.account.id === card && i.referenceMonth === '2026-11');
    expect([inv.closingDate, inv.realAmountCents, inv.status]).toEqual(['2026-10-26', 64329, 'open']);
    // Na tabela, cada compra fica no mês em que foi feita (out); todas na fatura de nov.
    const oct = await occ(c, '2026-10');
    expect(find(oct, 'COMPRA PERTO').invoice.referenceMonth).toBe('2026-11');
    // "PARC 08/10" de uma compra de março: a 1ª importada é gasta em outubro (março + 7).
    const antiga = find(oct, 'LOJA ANTIGA');
    expect([antiga.installmentLabel, antiga.expectedCents, antiga.note, antiga.chargeMonth, antiga.invoice.referenceMonth]).toEqual([
      '1/3',
      12000,
      'Parcelas 8 a 10 de 10 (importado da fatura)',
      '2026-10',
      '2026-11',
    ]);
    expect(find(await occ(c, '2026-12'), 'LOJA ANTIGA')).toMatchObject({ installmentLabel: '3/3', invoice: expect.objectContaining({ referenceMonth: '2027-01' }) });
    expect(find(oct, 'LOJA NOVA').installmentLabel).toBe('1/3');
    expect(find(oct, 'IOF DIAR ROT PF').expectedCents).toBe(739);
    // O valor real gravado vem preenchido no pagamento e cria o ajuste pela diferença.
    const paid = (await c.post(c.w(`/invoices/${inv.id}/payments`), { realAmountCents: inv.realAmountCents, amountCents: 64329, paidAt: '2026-11-03' })).json();
    expect(paid.status).toBe('paid');
    // Itens do app: 250 + 55,90 + 80 + 7,39 + 100 + 120 + 50 + 30 (Farmácia, sem linha) = 693,29; banco: 643,29.
    expect(find(await occ(c, '2026-11'), 'Ajuste da fatura').expectedCents).toBe(-5000);
  });

  it('o destino fica lembrado pela fatura de origem', async () => {
    const again = (await send(c, pdf)).json();
    expect(again.destinations.suggestedAccountId).toBe(card);
    expect(again.suggestions.lines.every((l: any) => l.suggestion.action === 'already')).toBe(true);
  });

  it('fatura já paga: não cria itens nela', async () => {
    const other = invoicePdf({ final: '4321', due: '05/11/2026', closing: '26/10/2026', lines: [{ dm: '18/10', desc: 'LOJA TARDIA', cents: 1000 }] });
    const p = (await send(c, other)).json();
    const line = p.suggestions.lines[0];
    expect([line.suggestion.action, line.suggestion.warnings[0]]).toEqual(['ignore', 'Esta fatura já foi paga no app: não dá para criar itens nela.']);
    const res = await c.post(c.w('/imports/confirm'), {
      token: p.token,
      accountId: card,
      decisions: [{ index: 0, action: 'create', create: { description: 'LOJA TARDIA' } }],
    });
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'invoice_closed']);
  });
});

describe('OFX', () => {
  it('lê o OFX em Windows-1252 e pré-seleciona pelo banco do arquivo', async () => {
    const c = await signedIn(env, 'ofx@example.com', 'Ofx');
    const conta = (await c.post(c.w('/accounts'), { name: 'Conta BB', bank: 'Banco do Brasil', kind: 'account' })).json().id;
    const ofx = fs.readFileSync(path.join(__dirname, '../../../packages/shared/src/imports/__fixtures__/exemplo.ofx'));
    const p = (await send(c, ofx, {}, 'extrato.ofx')).json();
    expect(p.source).toMatchObject({ readerId: 'ofx', bank: 'Banco do Brasil' });
    expect(p.destinations.suggestedAccountId).toBe(conta);
    expect(p.suggestions.lines[1]).toMatchObject({ description: 'Tarifa Pacote de Serviços', hint: 'fee' });
    expect(p.suggestions.lines[4].description).toBe('Recebimento de Proventos ••••••••••••90 EMPRESA EXEMPLO');
  });
});
