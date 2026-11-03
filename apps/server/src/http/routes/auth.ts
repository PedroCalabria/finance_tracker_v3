import type { FastifyInstance } from 'fastify';
import { emailOnlyInput, loginInput, registerInput, resetPasswordInput, tokenInput } from '@ff/shared';
import * as auth from '../../auth/service';
import type { AppContext } from '../../context';
import { REFRESH_COOKIE, clearSessionCookies, makeRequireUser, setSessionCookies } from '../auth-plugin';
import { parse } from '../errors';

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireUser = makeRequireUser(ctx);
  // Limite apertado nas rotas que recebem senha ou disparam email.
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', strict, async (req, reply) => {
    await auth.register(ctx, parse(registerInput, req.body));
    return reply.status(202).send({ ok: true });
  });

  app.post('/api/auth/verify-email', strict, async (req, reply) => {
    await auth.verifyEmail(ctx, parse(tokenInput, req.body).token);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/resend-verification', strict, async (req, reply) => {
    await auth.resendVerification(ctx, parse(emailOnlyInput, req.body).email);
    return reply.status(202).send({ ok: true });
  });

  app.post('/api/auth/login', strict, async (req, reply) => {
    const { email, password } = parse(loginInput, req.body);
    const s = await auth.login(ctx, email, password, req.headers['user-agent']);
    setSessionCookies(ctx, reply, s);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const s = await auth.refresh(ctx, req.cookies[REFRESH_COOKIE], req.headers['user-agent']);
      setSessionCookies(ctx, reply, s);
      return reply.send({ ok: true });
    } catch (e) {
      clearSessionCookies(ctx, reply);
      throw e;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.logout(ctx, req.cookies[REFRESH_COOKIE]);
    clearSessionCookies(ctx, reply);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout-all', { preHandler: requireUser }, async (req, reply) => {
    await auth.logoutAll(ctx, req.userId);
    clearSessionCookies(ctx, reply);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/forgot-password', strict, async (req, reply) => {
    await auth.forgotPassword(ctx, parse(emailOnlyInput, req.body).email);
    return reply.status(202).send({ ok: true });
  });

  app.post('/api/auth/reset-password', strict, async (req, reply) => {
    const { token, password } = parse(resetPasswordInput, req.body);
    await auth.resetPassword(ctx, token, password);
    clearSessionCookies(ctx, reply);
    return reply.send({ ok: true });
  });

  app.get('/api/me', { preHandler: requireUser }, async (req) => auth.getMe(ctx, req.userId));
}
