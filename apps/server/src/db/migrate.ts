import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { DB } from './client';

/** Pasta das migrations: ao lado do código-fonte em dev, copiada para dist no build. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === 'dist' ? path.join(here, 'drizzle') : path.resolve(here, '../../drizzle');
}

export async function runMigrations(db: DB): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
