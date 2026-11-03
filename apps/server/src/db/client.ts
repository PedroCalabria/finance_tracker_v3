import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type DB = NodePgDatabase<typeof schema>;
/** Transação ou conexão: os serviços aceitam os dois. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0] | DB;

// `date` volta como string "YYYY-MM-DD", sem passar por Date (evita erro de fuso).
pg.types.setTypeParser(1082, (v) => v);

export function createDb(url: string): { db: DB; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

export { schema };
