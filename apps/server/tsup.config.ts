import fs from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main-api.ts', 'src/main-worker.ts', 'src/main-migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // O pacote compartilhado é TypeScript puro: entra no bundle.
  noExternal: ['@ff/shared'],
  // As migrações SQL viajam junto com o bundle (lidas por src/db/migrate.ts),
  // e o arquivo da thread de extração de PDF também.
  onSuccess: async () => {
    fs.cpSync('drizzle', 'dist/drizzle', { recursive: true });
    // A extração do PDF roda numa worker thread a partir deste arquivo (ADR-0010).
    fs.copyFileSync('src/imports/pdf-text.worker.mjs', 'dist/pdf-text.worker.mjs');
  },
});
