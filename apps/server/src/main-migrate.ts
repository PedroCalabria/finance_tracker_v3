import { bootstrap } from './bootstrap';
import { runMigrations } from './db/migrate';

const ctx = bootstrap();
await runMigrations(ctx.db);
ctx.log.info('migrações aplicadas');
await ctx.close();
