/**
 * Default config — unit tests only. Integration tests (vitest.integration.config.ts)
 * need a live Postgres connection and run under a separate command, so that
 * plain `pnpm test` / `pnpm test:unit` never fails just because Docker isn't
 * running on whatever machine happens to invoke it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
