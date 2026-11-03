import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { ACCESS_TTL_SECONDS, verifyAccessToken } from '../auth/crypto';
import type { IssuedSession } from '../auth/service';
import { isSessionActive } from '../auth/service';
import type { AppContext } from '../context';
import { walletMembers } from '../db/schema';
import { AppError, forbidden, unauthorized } from './errors';

/** Cookies e guardas de rota (ADR-0003). */

export const ACCESS_COOKIE = 'ff_access';
export const REFRESH_COOKIE = 'ff_refresh';
/** O refresh só viaja para as rotas de auth. */
const REFRESH_PATH = '/api/auth';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    sessionId: string;
    walletId: string;
    walletRole: 'owner' | 'editor';
  }
}

export function setSessionCookies(ctx: AppContext, reply: FastifyReply, s: IssuedSession): void {
  const base = { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: 'lax' as const };
  reply.setCookie(ACCESS_COOKIE, s.accessToken, { ...base, path: '/', maxAge: ACCESS_TTL_SECONDS });
  reply.setCookie(REFRESH_COOKIE, s.refreshToken, { ...base, path: REFRESH_PATH, expires: s.refreshExpiresAt });
}

export function clearSessionCookies(ctx: AppContext, reply: FastifyReply): void {
  const base = { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: 'lax' as const };
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
}

export function makeRequireUser(ctx: AppContext) {
  const secret = new TextEncoder().encode(ctx.config.JWT_SECRET);
  return async function requireUser(req: FastifyRequest): Promise<void> {
    const token = req.cookies[ACCESS_COOKIE];
    if (!token) throw unauthorized();
    const r = await verifyAccessToken(secret, token);
    // A interface trata "token_expired" chamando /auth/refresh e repetindo a requisição.
    if (!r.ok) throw new AppError(401, r.reason === 'expired' ? 'token_expired' : 'unauthorized', 'Faça login para continuar.');
    if (!(await isSessionActive(ctx, r.sessionId))) throw unauthorized('Sua sessão terminou. Entre de novo.');
    req.userId = r.userId;
    req.sessionId = r.sessionId;
  };
}

/** Autorização = ser membro da carteira da URL (ADR-0004). Nunca "dono do registro". */
export function makeRequireWallet(ctx: AppContext) {
  return async function requireWallet(req: FastifyRequest): Promise<void> {
    const walletId = (req.params as { walletId?: string }).walletId;
    if (!walletId || !/^[0-9a-f-]{36}$/i.test(walletId)) throw forbidden();
    const m = await ctx.db.query.walletMembers.findFirst({
      where: and(eq(walletMembers.walletId, walletId), eq(walletMembers.userId, req.userId)),
    });
    if (!m) throw forbidden();
    req.walletId = walletId;
    req.walletRole = m.role;
  };
}

export function decorateRequest(app: FastifyInstance): void {
  app.decorateRequest('userId', '');
  app.decorateRequest('sessionId', '');
  app.decorateRequest('walletId', '');
  app.decorateRequest('walletRole', 'editor');
}
