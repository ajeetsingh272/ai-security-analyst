/**
 * Default config — unit tests only. Integration tests need a live Postgres
 * and Redpanda and run under a separate command (vitest.integration.config.ts),
 * so plain `pnpm test` / `pnpm test:unit` never fails just because the dev
 * stack isn't running on whatever machine happens to invoke it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
