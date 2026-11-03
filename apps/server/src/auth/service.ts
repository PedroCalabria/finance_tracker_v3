import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Me, RegisterInput } from '@ff/shared';
import type { AppContext } from '../context';
import { categories, emailTokens, notificationSettings, sessions, users, walletMembers, wallets } from '../db/schema';
import * as templates from '../email/templates';
import { AppError, unauthorized } from '../http/errors';
import { REFRESH_TTL_DAYS, hashPassword, randomToken, sha256, signAccessToken, verifyPassword } from './crypto';

/** Categorias criadas no cadastro para a pessoa não começar do zero (ADR-0004). */
const DEFAULT_CATEGORIES = {
  expense: ['Casa', 'Alimentação', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Família', 'Outros'],
  income: ['Salário', 'Outros'],
} as const;

const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
/** Reuso de refresh dentro desta janela é tratado como corrida entre abas, não roubo. */
const REUSE_GRACE_MS = 30 * 1000;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const secretOf = (ctx: AppContext) => new TextEncoder().encode(ctx.config.JWT_SECRET);
let dummyHash: Promise<string> | undefined;

export async function register(ctx: AppContext, input: RegisterInput): Promise<void> {
  const existing = await ctx.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${input.email}` });
  if (existing) {
    // Não revela que o email existe: reenvia a verificação se ainda não confirmou.
    if (!existing.emailVerifiedAt) await sendVerification(ctx, existing.id, existing.email, existing.name);
    return;
  }
  const passwordHash = await hashPassword(input.password);
  const user = await ctx.db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash }).returning();
    const [w] = await tx.insert(wallets).values({ name: 'Pessoal', kind: 'personal' }).returning();
    await tx.insert(walletMembers).values({ walletId: w!.id, userId: u!.id, role: 'owner' });
    await tx.insert(notificationSettings).values({ userId: u!.id });
    await tx.insert(categories).values([
      ...DEFAULT_CATEGORIES.expense.map((name) => ({ walletId: w!.id, name, type: 'expense' as const })),
      ...DEFAULT_CATEGORIES.income.map((name) => ({ walletId: w!.id, name, type: 'income' as const })),
    ]);
    return u!;
  });
  await sendVerification(ctx, user.id, user.email, user.name);
}

async function sendVerification(ctx: AppContext, userId: string, email: string, name: string): Promise<void> {
  const token = randomToken();
  await ctx.db.insert(emailTokens).values({
    userId,
    kind: 'verify_email',
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + VERIFY_TTL_MS),
  });
  await ctx.mailer.send(templates.verifyEmail(email, name, `${ctx.config.APP_URL}/verificar-email?token=${token}`));
}

export async function resendVerification(ctx: AppContext, email: string): Promise<void> {
  const user = await ctx.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
  if (user && !user.emailVerifiedAt) await sendVerification(ctx, user.id, user.email, user.name);
}

async function consumeToken(ctx: AppContext, token: string, kind: 'verify_email' | 'reset_password') {
  const row = await ctx.db.query.emailTokens.findFirst({
    where: and(eq(emailTokens.tokenHash, sha256(token)), eq(emailTokens.kind, kind)),
  });
  if (!row || row.usedAt || row.expiresAt <= ctx.now()) {
    throw new AppError(400, 'invalid_token', 'Este link expirou ou já foi usado. Peça um novo.');
  }
  await ctx.db.update(emailTokens).set({ usedAt: ctx.now() }).where(eq(emailTokens.id, row.id));
  return row;
}

export async function verifyEmail(ctx: AppContext, token: string): Promise<void> {
  const row = await consumeToken(ctx, token, 'verify_email');
  await ctx.db.update(users).set({ emailVerifiedAt: ctx.now() }).where(and(eq(users.id, row.userId), isNull(users.emailVerifiedAt)));
}

async function issueSession(ctx: AppContext, userId: string, familyId: string | null, userAgent?: string): Promise<IssuedSession> {
  const refreshToken = randomToken();
  const refreshExpiresAt = new Date(ctx.now().getTime() + REFRESH_TTL_DAYS * 86400 * 1000);
  const [s] = await ctx.db
    .insert(sessions)
    .values({
      userId,
      familyId: familyId ?? sql`gen_random_uuid()`,
      refreshTokenHash: sha256(refreshToken),
      expiresAt: refreshExpiresAt,
      userAgent: userAgent?.slice(0, 300),
    })
    .returning({ id: sessions.id });
  const accessToken = await signAccessToken(secretOf(ctx), userId, s!.id);
  return { accessToken, refreshToken, refreshExpiresAt };
}

export async function login(ctx: AppContext, email: string, password: string, userAgent?: string): Promise<IssuedSession> {
  const user = await ctx.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
  // Compara mesmo sem usuário para não revelar, pelo tempo, quais emails existem.
  dummyHash ??= hashPassword(randomToken());
  const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash), password);
  if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'Email ou senha incorretos.');
  if (!user.emailVerifiedAt) {
    throw new AppError(403, 'email_not_verified', 'Confirme seu email antes de entrar. Enviamos um link quando você se cadastrou.');
  }
  return issueSession(ctx, user.id, null, userAgent);
}

/** Rotação do refresh: cada uso gera um novo; reuso de um antigo revoga a família inteira. */
export async function refresh(ctx: AppContext, refreshToken: string | undefined, userAgent?: string): Promise<IssuedSession> {
  if (!refreshToken) throw unauthorized();
  const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.refreshTokenHash, sha256(refreshToken)) });
  if (!row || row.revokedAt || row.expiresAt <= ctx.now()) throw unauthorized('Sua sessão terminou. Entre de novo.');
  if (row.rotatedAt) {
    if (ctx.now().getTime() - row.rotatedAt.getTime() > REUSE_GRACE_MS) {
      await ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
      ctx.log.warn({ userId: row.userId, familyId: row.familyId }, 'reuso de refresh token: sessão revogada');
    }
    throw unauthorized('Sua sessão terminou. Entre de novo.');
  }
  const updated = await ctx.db
    .update(sessions)
    .set({ rotatedAt: ctx.now() })
    .where(and(eq(sessions.id, row.id), isNull(sessions.rotatedAt)))
    .returning({ id: sessions.id });
  if (updated.length === 0) throw unauthorized('Sua sessão terminou. Entre de novo.');
  return issueSession(ctx, row.userId, row.familyId, userAgent);
}

export async function logout(ctx: AppContext, refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.refreshTokenHash, sha256(refreshToken)) });
  if (row) await ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
}

export async function logoutAll(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Sessão do access token ainda válida? (revogação imediata no "Sair de todos os dispositivos"). */
export async function isSessionActive(ctx: AppContext, sessionId: string): Promise<boolean> {
  const row = await ctx.db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, ctx.now())),
    columns: { id: true },
  });
  return !!row;
}

export async function forgotPassword(ctx: AppContext, email: string): Promise<void> {
  const user = await ctx.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
  if (!user) return; // resposta genérica: não revela se o email existe
  const token = randomToken();
  await ctx.db.insert(emailTokens).values({
    userId: user.id,
    kind: 'reset_password',
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + RESET_TTL_MS),
  });
  await ctx.mailer.send(templates.resetPassword(user.email, user.name, `${ctx.config.APP_URL}/redefinir-senha?token=${token}`));
}

export async function resetPassword(ctx: AppContext, token: string, password: string): Promise<void> {
  const row = await consumeToken(ctx, token, 'reset_password');
  const passwordHash = await hashPassword(password);
  // Redefinir a senha também confirma o email (o link chegou na caixa dele) e derruba as sessões.
  await ctx.db.update(users).set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }).where(eq(users.id, row.userId));
  await logoutAll(ctx, row.userId);
}

export async function getMe(ctx: AppContext, userId: string): Promise<Me> {
  const user = await ctx.db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw unauthorized();
  const rows = await ctx.db
    .select({ id: wallets.id, name: wallets.name, kind: wallets.kind, role: walletMembers.role })
    .from(walletMembers)
    .innerJoin(wallets, eq(wallets.id, walletMembers.walletId))
    .where(eq(walletMembers.userId, userId))
    .orderBy(wallets.createdAt);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    timezone: user.timezone,
    wallets: rows,
  };
}
