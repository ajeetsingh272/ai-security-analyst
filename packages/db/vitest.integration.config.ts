/**
 * Integration tests — need a live Postgres (pnpm dev:stack, then db:migrate
 * and db:seed). Run via `pnpm test:integration`, never by plain `pnpm test`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Each test opens its own pool/transactions against a shared database;
    // running files in parallel workers risks two suites' transactions
    // interleaving in ways the isolation assertions can't distinguish from a
    // real bug. Sequential is slower and correct.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
