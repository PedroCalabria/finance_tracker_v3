import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import type { DB } from './client';

/** Chave do advisory lock das migrações (número fixo qualquer, só deste app). */
const MIGRATION_LOCK = 724_310_001;

/** Pasta das migrations: ao lado do código-fonte em dev, copiada para dist no build. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === 'dist' ? path.join(here, 'drizzle') : path.resolve(here, '../../drizzle');
}

/**
 * API e worker sobem juntos e os dois aplicam as migrações: sem trava, os dois
 * tentam o mesmo CREATE TABLE e um cai ("pg_type_typname_nsp_index"). O advisory
 * lock (numa conexão só, porque ele é da sessão) faz o segundo esperar e encontrar
 * tudo aplicado.
 */
export async function runMigrations(db: DB): Promise<void> {
  const client = await (db as DB & { $client: pg.Pool }).$client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
