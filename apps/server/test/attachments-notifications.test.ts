import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDailySummaries } from '../src/jobs/daily-summary';
import { purgeAttachments } from '../src/domain/attachments';
import { setup, signedIn, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let c: Client;

beforeAll(async () => {
  env = await setup();
  c = await signedIn(env);
});
afterAll(async () => env.close());

function multipart(filename: string, mime: string, data: Buffer) {
  const boundary = '----ff' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(path: string, filename: string, mime: string, data: Buffer) {
  const body = multipart(filename, mime, data);
  return env.app.inject({
    method: 'POST',
    url: c.w(path),
    payload: body.payload,
    headers: { 'content-type': body.contentType, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
}

describe('comprovantes', () => {
  it('remove EXIF, reduz a imagem, cifra no storage e devolve pela API', async () => {
    const photo = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#256f73' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'Celular', Model: 'Teste' } } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const res = await upload('/attachments', 'recibo pix.jpg', 'image/jpeg', photo);
    expect(res.statusCode).toBe(201);
    const att = res.json();
    expect(att.name).toBe('recibo pix.jpg');

    // No storage só há bytes cifrados.
    const stored = [...env.storage.blobs.values()][0]!;
    expect(stored.subarray(0, 3).toString()).toBe('FF1');
    expect(stored.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);

    const dl = await c.get(c.w(`/attachments/${att.id}`));
    expect(dl.headers['content-type']).toBe('image/jpeg');
    expect(dl.headers['cache-control']).toBe('private, no-store');
    const meta = await sharp(dl.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width!, meta.height!)).toBe(2000);
  });

  it('liga o comprovante ao pagamento', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    const att = (await upload('/attachments', 'comprovante.png', 'image/png', png)).json();
    const item = (await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', description: 'Diarista', amountCents: 15000, date: '2026-11-03' })).json();
    const occId = item.occurrences[0].id;
    const paid = (await c.post(c.w(`/occurrences/${occId}/payments`), { paidAt: '2026-11-03', amountCents: 15000, attachmentIds: [att.id] })).json()[0];
    expect(paid.payments[0].attachments).toEqual([expect.objectContaining({ id: att.id, mime: 'image/png' })]);
    // o mesmo comprovante não entra em dois pagamentos
    const other = (await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'pix', description: 'Feira', amountCents: 5000, date: '2026-11-03' })).json();
    const again = await c.post(c.w(`/occurrences/${other.occurrences[0].id}/payments`), { paidAt: '2026-11-03', amountCents: 5000, attachmentIds: [att.id] });
    expect(again.statusCode).toBe(400);
  });

  it('recusa o que não é foto nem PDF', async () => {
    const res = await upload('/attachments', 'virus.exe', 'application/octet-stream', Buffer.from('MZ\x90\x00 isto não é imagem'));
    expect(res.statusCode).toBe(415);
  });

  it('aceita PDF como está', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const res = await upload('/attachments', 'boleto.pdf', 'application/pdf', pdf);
    expect(res.statusCode).toBe(201);
    expect(res.json().mime).toBe('application/pdf');
  });

  it('a limpeza apaga órfãos com mais de 24 h', async () => {
    env.setNow('2026-11-05T15:00:00Z');
    const n = await purgeAttachments(env.ctx);
    expect(n).toBeGreaterThan(0);
    env.setNow('2026-11-03T15:00:00Z');
  });
});

describe('resumo diário por email', () => {
  beforeAll(async () => {
    // Vence segunda 09/11: aviso antecipado na sexta 06/11 e no próprio dia.
    await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'boleto', description: 'Condomínio', amountCents: 68000, date: '2026-11-03', dueDate: '2026-11-09' });
    // Vence domingo 15/11 (feriado): lembrete do dia vai para sexta 13/11.
    await c.post(c.w('/items'), { type: 'expense', form: 'single', method: 'boleto', description: 'Escola', amountCents: 120000, date: '2026-11-03', dueDate: '2026-11-15' });
    await c.post(c.w('/items'), { type: 'income', form: 'single', method: 'transfer', description: 'Reembolso', amountCents: 30000, date: '2026-11-03', dueDate: '2026-11-09' });
    await c.patch('/api/me/notification-settings', { enabled: true, sendHour: 8, leadBusinessDays: 1 });
  });

  const sentTo = () => env.mailer.sent.filter((m) => m.subject.includes('vence') || m.subject.includes('receber'));

  it('só envia no horário escolhido, no fuso da pessoa', async () => {
    env.setNow('2026-11-06T10:00:00Z'); // 07h em São Paulo
    expect((await runDailySummaries(env.ctx)).sent).toBe(0);
  });

  it('avisa um dia útil antes, com contas e entradas separadas', async () => {
    env.setNow('2026-11-06T11:00:00Z'); // sexta, 08h em São Paulo
    const before = sentTo().length;
    expect((await runDailySummaries(env.ctx)).sent).toBe(1);
    const mail = sentTo().slice(before)[0]!;
    expect(mail.subject).toBe('1 conta vence em breve');
    expect(mail.text).toContain('Vencem no próximo dia útil:\n- Condomínio · R$ 680,00 · 09/11');
    expect(mail.text).toContain('Você deve receber em breve:\n- Reembolso · R$ 300,00 · 09/11');
    expect(mail.text).toContain('http://app.test/?mes=2026-11');
  });

  it('não envia duas vezes no mesmo dia', async () => {
    const r = await runDailySummaries(env.ctx);
    expect([r.sent, r.skipped]).toEqual([0, 1]);
  });

  it('vencimento em fim de semana e feriado avisa no dia útil anterior', async () => {
    env.setNow('2026-11-13T11:00:00Z'); // sexta 13/11, 08h
    const before = sentTo().length;
    await runDailySummaries(env.ctx);
    const mail = sentTo().slice(before)[0]!;
    expect(mail.text).toContain('Vencem hoje:\n- Escola · R$ 1.200,00 · 15/11');
  });

  it('conta paga não gera aviso', async () => {
    const rows = (await c.get(c.w('/occurrences?month=2026-11'))).json();
    const cond = rows.find((r: { description: string }) => r.description === 'Condomínio');
    await c.post(c.w(`/occurrences/${cond.id}/payments`), { paidAt: '2026-11-06', amountCents: 68000 });
    env.setNow('2026-11-09T11:00:00Z');
    const before = sentTo().length;
    await runDailySummaries(env.ctx);
    const mail = sentTo().slice(before)[0];
    expect(mail?.text ?? '').not.toContain('Condomínio');
    env.setNow('2026-11-03T15:00:00Z');
  });
});
