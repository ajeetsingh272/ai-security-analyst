/**
 * Default config — unit tests only. Integration tests need a live Postgres
 * and Redis and run under a separate command (vitest.integration.config.ts),
 * so plain `pnpm test` / `pnpm test:unit` never fails just because the dev
 * stack isn't running on whatever machine happens to invoke it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    // password.test.ts's own scrypt-backed hashing is deliberately slow
    // and memory-hard (that IS the security property) — on a loaded CI
    // runner this comfortably exceeds vitest's 5s default for a test
    // doing several hash/verify calls in one case, failing with no code
    // regression at all (confirmed on a real CI run, not reproduced
    // locally since this sandbox's own hardware happened to be fast
    // enough). Raised generously rather than tuned to exactly one slow
    // test, since the root cause (shared CI runner variance) applies to
    // every scrypt-backed test in this suite, not just one of them.
    testTimeout: 20_000,
  },
});
