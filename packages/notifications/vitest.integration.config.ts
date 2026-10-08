/**
 * Integration tests — need a live Postgres (pnpm dev:stack, then db:migrate).
 * Run via `pnpm test:integration`, never by plain `pnpm test`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
