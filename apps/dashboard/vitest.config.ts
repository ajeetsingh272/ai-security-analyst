/**
 * Default config — unit tests only. `e2e/**` is Playwright's own test
 * suite (playwright.config.ts, repo root), not vitest's — without this
 * exclude, vitest's default glob also matches `*.spec.ts` and tries to run
 * those files itself, which fails immediately since they call Playwright's
 * `test` API, not vitest's.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig.json's own `jsx: "preserve"` is correct for Next's build
  // pipeline (SWC does the real transform), but vitest runs outside
  // that pipeline — without overriding esbuild's own jsx mode here,
  // JSX in a test file is left untransformed, "React is not defined."
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/components/__tests__/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
  },
});
