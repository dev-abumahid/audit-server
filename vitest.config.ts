import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    // Without this, a stale `dist/` from `npm run build` gets picked up too —
    // vitest then runs both the source and compiled copies of every test
    // concurrently, which race on shared state (e.g. disk-writing tests).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/app/**/*.ts'],
      exclude: ['src/__tests__/**', '**/*.test.ts'],
    },
  },
});
