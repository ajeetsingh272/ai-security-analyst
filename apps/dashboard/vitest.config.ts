/**
 * Default config — unit tests only. `e2e/**` is Playwright's own test
 * suite (playwright.config.ts, repo root), not vitest's — without this
 * exclude, vitest's default glob also matches `*.spec.ts` and tries to run
 * those files itself, which fails immediately since they call Playwright's
 * `test` API, not vitest's.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
  },
});
