import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { notificationSettingsInput, type NotificationSettings } from '@ff/shared';
import type { AppContext } from '../../context';
import { notificationSettings } from '../../db/schema';
import { makeRequireUser } from '../auth-plugin';
import { parse } from '../errors';

/** Configurações de aviso por usuário (ADR-0007). */
export async function settingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireUser = makeRequireUser(ctx);

  app.get('/api/me/notification-settings', { preHandler: requireUser }, async (req): Promise<NotificationSettings> => {
    const row = await ctx.db.query.notificationSettings.findFirst({ where: eq(notificationSettings.userId, req.userId) });
    return { enabled: row?.enabled ?? true, sendHour: row?.sendHour ?? 8, leadBusinessDays: row?.leadBusinessDays ?? 1 };
  });

  app.patch('/api/me/notification-settings', { preHandler: requireUser }, async (req): Promise<NotificationSettings> => {
    const input = parse(notificationSettingsInput, req.body);
    await ctx.db
      .insert(notificationSettings)
      .values({ userId: req.userId, ...input })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: input });
    return input;
  });
}
