/**
 * P1-11 T3 — "Health endpoint reflects a revoked-consent connector as
 * degraded" — against the real Postgres and Redis the dev stack provides.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let userId: string;
let userEmail: string;
let healthyConnectorId: string;
let revokedConnectorId: string;

/** Same RLS-bypass fixture pattern as auth.integration.test.ts's own
 * asAdmin — kept local rather than extracted, since this is the second use
 * of a 12-line helper, not yet a pattern three call sites deep. */
async function asAdmin<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  scopedTenantId?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (scopedTenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopedTenantId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sentinel_session')?.value;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  // See auth.integration.test.ts's own beforeAll for why: fastify.inject()
  // always reports 127.0.0.1, so repeated local runs against a persistent
  // Redis accumulate toward the IP rate limit across unrelated test files.
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  userId = randomUUID();
  userEmail = `p1-11-probe-${userId}@example.invalid`;
  healthyConnectorId = randomUUID();
  revokedConnectorId = randomUUID();

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [
      tenantId,
      'P1-11 probe tenant',
      'trial',
    ]),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      userId,
      userEmail,
      passwordHash,
    ]),
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, userId]),
    tenantId,
  );

  // A healthy connector that HAS synced — go/sentinelconnector's
  // HealthRecorder would have set last_sync_at on a real success.
  await asAdmin(
    (c) =>
      c.query(
        `INSERT INTO connectors (id, tenant_id, kind, status, last_sync_at) VALUES ($1, $2, 'm365', 'healthy', now())`,
        [healthyConnectorId, tenantId],
      ),
    tenantId,
  );
  // A connector whose consent was revoked — exactly what
  // go/sentinelconnector's healthStatusFor(ErrConsentRevoked) writes.
  // last_sync_at stays NULL: this connector never synced before losing
  // access, so its lag must be measured from created_at (same computeLag
  // reasoning as the Go side's T2).
  await asAdmin(
    (c) =>
      c.query(
        `INSERT INTO connectors (id, tenant_id, kind, status, last_error) VALUES ($1, $2, 'google_workspace', 'revoked', 'vendor rejected the token: sentinelconnector: connector consent revoked')`,
        [revokedConnectorId, tenantId],
      ),
    tenantId,
  );

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('GET /connectors/health', () => {
  it('reflects a revoked-consent connector as degraded, and a healthy one as healthy', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { email: userEmail, password: KNOWN_PASSWORD },
    });
    const sessionCookie = cookieFrom(signIn);
    expect(sessionCookie).toBeDefined();

    const res = await app.inject({
      method: 'GET',
      url: '/connectors/health',
      cookies: { sentinel_session: sessionCookie! },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { connectors: Array<Record<string, unknown>> };
    const healthy = body.connectors.find((c) => c['id'] === healthyConnectorId);
    const revoked = body.connectors.find((c) => c['id'] === revokedConnectorId);

    expect(healthy).toBeDefined();
    expect(healthy?.['status']).toBe('healthy');
    expect(healthy?.['reason']).toBeNull();

    expect(revoked).toBeDefined();
    // The actual T3 assertion: a revoked-consent connector is reported as
    // degraded, not as a raw "revoked" the dashboard would have to
    // special-case — with the detail still available in `reason`.
    expect(revoked?.['status']).toBe('degraded');
    expect(revoked?.['reason']).toBe('revoked');
    expect(revoked?.['lastError']).toContain('consent revoked');
    expect(typeof revoked?.['lagSeconds']).toBe('number');
    expect(revoked?.['lagSeconds']).toBeGreaterThanOrEqual(0);
  });

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/connectors/health' });
    expect(res.statusCode).toBe(401);
  });
});
