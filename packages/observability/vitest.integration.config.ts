/**
 * Integration tests — need the dev stack's otel-collector and Jaeger
 * (`pnpm dev:stack`) plus a Go toolchain on PATH to build and run the
 * ingest service. Run via `pnpm test:integration`, never by plain
 * `pnpm test`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
