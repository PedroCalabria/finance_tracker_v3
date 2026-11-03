import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { DB } from './db/client';
import type { Mailer } from './email/mailer';
import type { Storage } from './storage/storage';

/** Dependências compartilhadas por rotas, serviços e jobs. */
export interface AppContext {
  config: Config;
  db: DB;
  mailer: Mailer;
  storage: Storage;
  log: FastifyBaseLogger;
  /** Relógio injetável para testes. */
  now: () => Date;
}
