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
  // As migrações SQL viajam junto com o bundle (lidas por src/db/migrate.ts).
  onSuccess: async () => {
    fs.cpSync('drizzle', 'dist/drizzle', { recursive: true });
  },
});
