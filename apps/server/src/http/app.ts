import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { decorateRequest } from './auth-plugin';
import { registerErrorHandler } from './errors';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { walletRoutes } from './routes/wallet';

/** Monta a API. Em produção também serve a interface compilada (ADR-0008). */
export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // O log padrão do Fastify registra só método, URL e status: corpo e cookies ficam de fora.
  });
  ctx.log = app.log;

  decorateRequest(app);
  registerErrorHandler(app);
  await app.register(cookie);
  if (ctx.config.RATE_LIMIT === 'on') await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/api/health', async () => ({ ok: true }));
  await authRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await walletRoutes(app, ctx);

  const dist = ctx.config.WEB_DIST ? path.resolve(ctx.config.WEB_DIST) : null;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: false });
    // SPA: qualquer rota que não seja /api devolve o index.html.
    app.get('/*', (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.callNotFound();
      const file = path.join(dist, req.url.split('?')[0]!);
      if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(path.relative(dist, file));
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
