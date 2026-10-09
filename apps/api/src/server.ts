/**
 * The control-plane API's real process entrypoint. `buildApp` (app.ts) has
 * existed since P1-11, but nothing before P6-01 ever called `.listen()` on
 * it outside a test — every consumer up to now was `app.inject()`. The
 * dashboard (P6-01) is the first thing that needs an actual running server
 * to talk HTTP to, so this is that: read config from the environment, build
 * a real Pool/Redis client, and listen.
 */
import pg from 'pg';
import { createClient } from 'redis';
import { buildApp } from './app.js';
import { startWeeklyReportScheduler } from './weekly-report-scheduler.js';
import { startPlanUsageSweep } from './plan-usage-sweep.js';
import { startRetentionSweep } from './retention-sweep.js';
import { createAdminClickHouseClient } from './clickhouse.js';
import { resendConfigFromEnv } from './weekly-report-email.js';

async function main(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
    max: Number(process.env.POSTGRES_MAX_CONNECTIONS ?? 20),
  });

  const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  const app = await buildApp({
    pool,
    redis,
    cookieSecure: process.env.NODE_ENV === 'production',
  });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`@sentinel/api listening on :${port}`);

  // P6-07 AC1: the weekly report's own schedule — see this file's own
  // doc comment in weekly-report-scheduler.ts for why an hourly
  // in-process timer, not an external cron.
  const stopWeeklyReportScheduler = startWeeklyReportScheduler(pool, resendConfigFromEnv(), app.log);
  // P6-10: evaluates every active tenant's plan usage hourly — see
  // plan-usage-sweep.ts's own doc comment for why this runs
  // independently of (and does not strictly need to precede) the
  // weekly-report scheduler above, which only reads whatever status
  // this last recorded.
  const stopPlanUsageSweep = startPlanUsageSweep(pool, resendConfigFromEnv(), app.log);
  // P7-05 AC3: enforces each tenant's own plan.retentionDays against
  // ClickHouse directly — see retention-sweep.ts's own doc comment for
  // why this needs the admin client, not the tenant-scoped one `app`
  // itself builds for the evidence route. Only starts when
  // CLICKHOUSE_URL is configured, the same "optional dependency" shape
  // app.ts already uses for the tenant-scoped client.
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  const stopRetentionSweep = clickhouseUrl
    ? startRetentionSweep(pool, createAdminClickHouseClient(clickhouseUrl), app.log)
    : undefined;

  async function shutdown(): Promise<void> {
    stopWeeklyReportScheduler();
    stopPlanUsageSweep();
    stopRetentionSweep?.();
    await app.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('@sentinel/api failed to start', err);
  process.exit(1);
});
