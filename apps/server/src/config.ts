import { z } from 'zod';

/** Variáveis de ambiente validadas na partida. Ver `.env.example` e ADR-0008. */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    APP_URL: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres.'),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    WEB_DIST: z.string().optional(),
    /** Limite de tentativas por IP (login, cadastro, emails). Só desligue em testes. */
    RATE_LIMIT: z.enum(['on', 'off']).default('on'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    /** 32 bytes em base64: chave mestra AES-256-GCM dos comprovantes. Perdê-la = perder os comprovantes. */
    ATTACHMENTS_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'ATTACHMENTS_KEY precisa ter 32 bytes em base64.'),

    EMAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Finanças da Família <avisos@localhost>'),
  })
  .superRefine((c, ctx) => {
    if (c.STORAGE_DRIVER === 's3' && !(c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_DRIVER=s3 exige S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.' });
    }
    if (c.EMAIL_DRIVER === 'resend' && !c.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'EMAIL_DRIVER=resend exige RESEND_API_KEY.' });
    }
  });

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${lines}`);
  }
  const c = parsed.data;
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
