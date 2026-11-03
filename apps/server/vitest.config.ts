import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Os arquivos compartilham o mesmo banco de teste: um de cada vez.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
