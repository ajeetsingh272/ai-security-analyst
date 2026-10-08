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

  async function shutdown(): Promise<void> {
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
