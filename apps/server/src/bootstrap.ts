import pino from 'pino';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { createDb } from './db/client';
import { createMailer } from './email/mailer';
import { createStorage } from './storage/storage';

/** Monta o contexto a partir das variáveis de ambiente (API, worker e migração usam o mesmo). */
export function bootstrap(): AppContext & { close: () => Promise<void> } {
  const config = loadConfig();
  const log = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });
  const { db, pool } = createDb(config.DATABASE_URL);
  return {
    config,
    db,
    log,
    mailer: createMailer(config, log),
    storage: createStorage(config),
    now: () => new Date(),
    close: () => pool.end(),
  };
}
