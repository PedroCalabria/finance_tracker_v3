import PgBoss from 'pg-boss';
import { bootstrap } from './bootstrap';
import { runMigrations } from './db/migrate';
import { purgeAttachments } from './domain/attachments';
import { runDailySummaries } from './jobs/daily-summary';

/**
 * Worker (ADR-0007): processo separado da API, mesma imagem. Usa pg-boss sobre o
 * próprio Postgres — sem Redis. Os jobs são idempotentes e o pg-boss refaz em falha.
 */
const ctx = bootstrap();
await runMigrations(ctx.db);

const boss = new PgBoss({ connectionString: ctx.config.DATABASE_URL, schema: 'pgboss' });
boss.on('error', (err) => ctx.log.error({ err }, 'pg-boss'));
await boss.start();

const JOBS = {
  'daily-summaries': { cron: '0 * * * *', run: () => runDailySummaries(ctx) },
  'purge-attachments': { cron: '30 6 * * *', run: () => purgeAttachments(ctx) },
} as const;

for (const [name, job] of Object.entries(JOBS)) {
  await boss.createQueue(name, { name, retryLimit: 3, retryDelay: 300, retryBackoff: true });
  await boss.schedule(name, job.cron, undefined, { tz: 'UTC' });
  await boss.work(name, async () => {
    const result = await job.run();
    ctx.log.info({ job: name, result }, 'job concluído');
  });
}
ctx.log.info({ jobs: Object.keys(JOBS) }, 'worker iniciado');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await boss.stop({ graceful: true });
    await ctx.close();
    process.exit(0);
  });
}
