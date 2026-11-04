import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { loadConfig } from '../src/config';
import type { AppContext } from '../src/context';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ConsoleMailer } from '../src/email/mailer';
import { buildApp } from '../src/http/app';
import { memoryStorage } from '../src/storage/storage';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/financas_test';

export interface TestEnv {
  ctx: AppContext;
  app: FastifyInstance;
  mailer: ConsoleMailer;
  storage: ReturnType<typeof memoryStorage>;
  setNow: (iso: string) => void;
  close: () => Promise<void>;
}

/** Banco limpo + app montada, com relógio controlável (padrão: 03/11/2026 12h em São Paulo). */
export async function setup(): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    JWT_SECRET: 'x'.repeat(40),
    ATTACHMENTS_KEY: randomBytes(32).toString('base64'),
    APP_URL: 'http://app.test',
    RATE_LIMIT: 'off',
  });
  const { db, pool } = createDb(TEST_DB);
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await runMigrations(db);
  const log = pino({ level: 'silent' });
  const mailer = new ConsoleMailer(log);
  const storage = memoryStorage(Buffer.from(config.ATTACHMENTS_KEY, 'base64'));
  let now = new Date('2026-11-03T15:00:00Z');
  const ctx: AppContext = { config, db, log, mailer, storage, now: () => now };
  const app = await buildApp(ctx);
  ctx.log = log;
  return {
    ctx,
    app,
    mailer,
    storage,
    setNow: (iso) => {
      now = new Date(iso);
    },
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Cliente HTTP de teste que guarda cookies como um navegador. */
export class Client {
  cookies = new Map<string, string>();
  walletId = '';
  constructor(private readonly app: FastifyInstance) {}

  async req(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object | undefined,
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);
  w = (path: string) => `/api/wallets/${this.walletId}${path}`;
}

export function tokenFrom(text: string): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!m) throw new Error(`sem token em: ${text}`);
  return m[1]!;
}

/** Cria conta, confirma email e entra. Devolve um cliente já autenticado. */
export async function signedIn(env: TestEnv, email = 'pedro@example.com', name = 'Pedro'): Promise<Client> {
  const c = new Client(env.app);
  const before = env.mailer.sent.length;
  await c.post('/api/auth/register', { name, email, password: 'senha-forte-1' });
  const mail = env.mailer.sent.slice(before).find((m) => m.to === email)!;
  await c.post('/api/auth/verify-email', { token: tokenFrom(mail.text) });
  const login = await c.post('/api/auth/login', { email, password: 'senha-forte-1' });
  if (login.statusCode !== 200) throw new Error(login.body);
  const me = (await c.get('/api/me')).json();
  c.walletId = me.wallets[0].id;
  return c;
}
