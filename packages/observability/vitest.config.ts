/**
 * Default config — unit tests only. Integration tests need the dev stack's
 * otel-collector/Jaeger (pnpm dev:stack) plus a built ingest binary, and run
 * under a separate command (vitest.integration.config.ts), matching
 * apps/api's split.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
