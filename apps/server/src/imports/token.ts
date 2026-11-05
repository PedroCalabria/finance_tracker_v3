import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { ImportLine, ReadHeader, ReadWarning } from '@ff/shared';
import type { AppContext } from '../context';
import { AppError } from '../http/errors';

/**
 * Prévia assinada (ADR-0010, D5): as linhas lidas voltam para a tela dentro de
 * um token (JSON comprimido + HMAC-SHA256). `suggest` e `confirm` conferem a
 * assinatura, a carteira, a pessoa e a validade, sem guardar nada no servidor
 * entre o envio e a confirmação. Chave derivada de JWT_SECRET (HKDF).
 */

export const PREVIEW_TTL_MS = 2 * 3600 * 1000;

export interface PreviewPayload {
  v: 1;
  walletId: string;
  userId: string;
  readerId: string;
  kind: 'statement' | 'invoice';
  /** Banco do documento (do leitor, ou do próprio OFX). */
  bank: string;
  /** Cabeçalho sem o identificador bruto da conta: só o hash (`importKey`). */
  header: Omit<ReadHeader, 'accountRef'> & { importKey: string | null };
  lines: ImportLine[];
  warnings: ReadWarning[];
  exp: number;
}

const invalid = () => new AppError(400, 'import_preview_invalid', 'Esta prévia expirou. Envie o arquivo de novo.');

function key(ctx: AppContext): Buffer {
  return Buffer.from(hkdfSync('sha256', ctx.config.JWT_SECRET, Buffer.alloc(0), 'ff-import-preview', 32));
}

/** Hash da conta ou do cartão de origem, para lembrar o destino sem guardar o número. */
export function importKeyOf(walletId: string, bank: string, accountRef: string | null): string | null {
  return accountRef ? createHash('sha256').update(`${walletId}:${bank}:${accountRef}`).digest('hex') : null;
}

export function signPreview(ctx: AppContext, payload: Omit<PreviewPayload, 'v' | 'exp'>): string {
  const body = deflateRawSync(Buffer.from(JSON.stringify({ ...payload, v: 1, exp: ctx.now().getTime() + PREVIEW_TTL_MS }))).toString('base64url');
  const mac = createHmac('sha256', key(ctx)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPreview(ctx: AppContext, token: string, walletId: string, userId: string): PreviewPayload {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw invalid();
  const expected = createHmac('sha256', key(ctx)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let payload: PreviewPayload;
  try {
    payload = JSON.parse(inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw invalid();
  }
  if (payload.v !== 1 || payload.walletId !== walletId || payload.userId !== userId || payload.exp < ctx.now().getTime()) throw invalid();
  return payload;
}
