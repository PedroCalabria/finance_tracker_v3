import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';

/** Primitivas de autenticação (ADR-0003). */

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

// algorithm 2 = Argon2id (o enum do pacote é const e não atravessa isolatedModules).
const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, ARGON);
export const verifyPassword = (hashed: string, password: string) => verify(hashed, password).catch(() => false);

/** Token opaco aleatório (refresh, verificação de email, redefinição de senha). */
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function signAccessToken(secret: Uint8Array, userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(secret);
}

export type AccessResult = { ok: true; userId: string; sessionId: string } | { ok: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(secret: Uint8Array, token: string): Promise<AccessResult> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return { ok: false, reason: 'invalid' };
    return { ok: true, userId: payload.sub, sessionId: payload.sid };
  } catch (e) {
    return { ok: false, reason: e instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' };
  }
}
