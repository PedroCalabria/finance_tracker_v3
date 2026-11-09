import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import journal from '../drizzle/meta/_journal.json';
import { TEST_DB } from './helpers';

/** API e worker sobem juntos e os dois aplicam as migrações (docker-compose). */
describe('migrações', () => {
  const a = createDb(TEST_DB);
  const b = createDb(TEST_DB);
  afterAll(async () => {
    await a.pool.end();
    await b.pool.end();
  });

  it('dois processos ao mesmo tempo num banco vazio: um espera o outro, ninguém falha', async () => {
    await a.pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
    await expect(Promise.all([runMigrations(a.db), runMigrations(b.db), runMigrations(a.db)])).resolves.toBeDefined();
    // Cada migração do journal aplicada uma única vez.
    const applied = await a.pool.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(applied.rows[0].n).toBe(journal.entries.length);
    const tables = await a.pool.query("select count(*)::int as n from information_schema.tables where table_name in ('import_batches', 'import_lines', 'people')");
    expect(tables.rows[0].n).toBe(3);
    // Lock liberado: rodar de novo é instantâneo e não muda nada.
    await runMigrations(b.db);
  });
});
