import { defineConfig } from '@playwright/test';

const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// P6-01's e2e suite needs a REAL running API process and a REAL running
// dashboard dev server — `apps/api` only ever had `buildApp()` for
// `app.inject()` in-process tests before this ticket (see server.ts's own
// doc comment); this is the first thing in the repo to actually run both
// as separate processes and talk to each other over real HTTP, same as
// production.
export default defineConfig({
  testDir: 'apps/dashboard/e2e',
  fullyParallel: false, // tests share one seeded Postgres/Redis; parallel workers would race fixture creation/cleanup
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: [
    {
      command: 'pnpm --filter @sentinel/api exec tsx src/server.ts',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      env: { POSTGRES_URL, REDIS_URL, API_PORT: '4000' },
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @sentinel/dashboard dev',
      url: 'http://localhost:3000',
      reuseExistingServer: true,
      env: { API_BASE_URL: 'http://localhost:4000' },
      timeout: 60_000,
    },
  ],
});
