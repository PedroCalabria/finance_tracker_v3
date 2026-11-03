import { bootstrap } from './bootstrap';
import { runMigrations } from './db/migrate';
import { buildApp } from './http/app';

const ctx = bootstrap();
await runMigrations(ctx.db);
const app = await buildApp(ctx, { logger: true });
await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await ctx.close();
    process.exit(0);
  });
}
