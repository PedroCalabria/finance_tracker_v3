import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { AttachmentRef } from '@ff/shared';
import type { AppContext } from '../context';
import { attachments } from '../db/schema';
import { AppError, notFound } from '../http/errors';

/**
 * Comprovantes (ADR-0006): foto ou PDF até 10 MB. Tipo validado pelo conteúdo,
 * HEIC convertido para JPEG, EXIF (inclusive GPS) removido, imagem limitada a
 * 2000 px. Cifrado antes de ir para o storage; download sempre pela API.
 */

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PER_PAYMENT = 5;
const MAX_SIDE = 2000;

interface Processed {
  data: Buffer;
  mime: string;
  ext: string;
}

async function heicToJpeg(input: Buffer): Promise<Buffer> {
  const { default: convert } = await import('heic-convert');
  return Buffer.from(await convert({ buffer: input, format: 'JPEG', quality: 0.85 }));
}

export async function processUpload(input: Buffer): Promise<Processed> {
  if (input.length > MAX_BYTES) throw new AppError(413, 'too_large', 'O arquivo passa de 10 MB.');
  const type = await fileTypeFromBuffer(input);
  const mime = type?.mime ?? '';
  if (mime === 'application/pdf') return { data: input, mime, ext: 'pdf' };
  let image = input;
  if (mime === 'image/heic' || mime === 'image/heif') image = await heicToJpeg(input);
  else if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw new AppError(415, 'unsupported_type', 'Envie uma foto (JPEG, PNG ou HEIC) ou um PDF.');
  }
  // rotate() aplica a orientação do EXIF; sem withMetadata(), o sharp descarta todo o EXIF.
  const pipeline = sharp(image, { failOn: 'error' }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
  if (mime === 'image/png') return { data: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png', ext: 'png' };
  return { data: await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
}

function safeName(original: string, ext: string): string {
  const base = original.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) || 'comprovante';
  return `${base}.${ext}`;
}

/** Upload solto: fica sem vínculo até entrar num pagamento (o job limpa os órfãos após 24 h). */
export async function storeAttachment(ctx: AppContext, walletId: string, userId: string, original: Buffer, filename: string): Promise<AttachmentRef> {
  const processed = await processUpload(original);
  const storageKey = `w/${walletId}/${randomUUID()}`;
  await ctx.storage.put(storageKey, processed.data);
  const [row] = await ctx.db
    .insert(attachments)
    .values({ walletId, storageKey, name: safeName(filename, processed.ext), mime: processed.mime, sizeBytes: processed.data.length, uploadedBy: userId })
    .returning();
  return { id: row!.id, name: row!.name, mime: row!.mime, sizeBytes: row!.sizeBytes };
}

export async function readAttachment(ctx: AppContext, walletId: string, id: string): Promise<{ data: Buffer; name: string; mime: string }> {
  const row = await ctx.db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.walletId, walletId), isNull(attachments.deletedAt)) });
  if (!row) throw notFound('Comprovante');
  return { data: await ctx.storage.get(row.storageKey), name: row.name, mime: row.mime };
}

/** Exclusão lógica; o arquivo é apagado do storage pelo job depois de 30 dias. */
export async function removeAttachment(ctx: AppContext, walletId: string, id: string): Promise<void> {
  const r = await ctx.db
    .update(attachments)
    .set({ deletedAt: new Date() })
    .where(and(eq(attachments.id, id), eq(attachments.walletId, walletId), isNull(attachments.deletedAt)))
    .returning({ id: attachments.id });
  if (r.length === 0) throw notFound('Comprovante');
}

/** Liga um comprovante a um pagamento já existente (grupo) ou a um pagamento de fatura. */
export async function attachToExisting(ctx: AppContext, walletId: string, attachmentId: string, link: { paymentGroupId?: string; invoicePaymentId?: string }): Promise<void> {
  const field = link.paymentGroupId ? attachments.paymentGroupId : attachments.invoicePaymentId;
  const value = link.paymentGroupId ?? link.invoicePaymentId!;
  const [count] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(field, value), isNull(attachments.deletedAt)));
  if ((count?.n ?? 0) >= MAX_PER_PAYMENT) throw new AppError(400, 'too_many', `No máximo ${MAX_PER_PAYMENT} comprovantes por pagamento.`);
  const r = await ctx.db
    .update(attachments)
    .set(link)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.walletId, walletId), isNull(attachments.paymentGroupId), isNull(attachments.invoicePaymentId)))
    .returning({ id: attachments.id });
  if (r.length === 0) throw notFound('Comprovante');
}

/** Limpeza: órfãos com mais de 24 h e excluídos há mais de 30 dias saem do storage. */
export async function purgeAttachments(ctx: AppContext): Promise<number> {
  const now = ctx.now().getTime();
  const orphanCut = new Date(now - 24 * 3600 * 1000);
  const deletedCut = new Date(now - 30 * 86400 * 1000);
  const rows = await ctx.db.query.attachments.findMany({
    where: sql`(${attachments.deletedAt} is not null and ${attachments.deletedAt} < ${deletedCut.toISOString()})
      or (${attachments.deletedAt} is null and ${attachments.paymentGroupId} is null and ${attachments.invoicePaymentId} is null and ${attachments.createdAt} < ${orphanCut.toISOString()})`,
  });
  for (const r of rows) {
    await ctx.storage.delete(r.storageKey).catch((err) => ctx.log.warn({ err, key: r.storageKey }, 'falha ao apagar comprovante'));
    await ctx.db.delete(attachments).where(eq(attachments.id, r.id));
  }
  return rows.length;
}

