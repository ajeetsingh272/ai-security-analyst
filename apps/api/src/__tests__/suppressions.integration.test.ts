/**
 * P2-10 — the full HTTP round trip for /suppressions, against the real
 * Postgres and Redis the dev stack provides. T4 ("creating a suppression
 * without a reason is rejected") gets its end-to-end proof here, on top of
 * the pure-unit proof in packages/db's own suppressions-repository.test.ts.
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
let analystUserId: string;
let analystEmail: string;
let readOnlyUserId: string;
let readOnlyEmail: string;

/** Same RLS-bypass fixture pattern as connectors.integration.test.ts's own
 * asAdmin. */
async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
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

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/sign-in',
    payload: { email, password: KNOWN_PASSWORD },
  });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  return cookie;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  analystUserId = randomUUID();
  analystEmail = `p2-10-analyst-${analystUserId}@example.invalid`;
  readOnlyUserId = randomUUID();
  readOnlyEmail = `p2-10-readonly-${readOnlyUserId}@example.invalid`;

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P2-10 probe tenant', 'trial']),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      analystUserId,
      analystEmail,
      passwordHash,
    ]),
  );
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      readOnlyUserId,
      readOnlyEmail,
      passwordHash,
    ]),
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'analyst')`, [tenantId, analystUserId]),
    tenantId,
  );
  await asAdmin(
    (c) =>
      c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [
        tenantId,
        readOnlyUserId,
      ]),
    tenantId,
  );

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [analystUserId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyUserId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /suppressions', () => {
  it('T4: rejects a blank reason with 400', async () => {
    const cookie = await signIn(analystEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
      payload: { ruleId: 'rule-blank-reason', reason: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'reason_required' });
  });

  it('rejects a read_only caller with 403', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
      payload: { ruleId: 'rule-rbac', reason: 'a perfectly good reason' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a suppression, audit-logs it, and lists it as active', async () => {
    const cookie = await signIn(analystEmail);
    const createRes = await app.inject({
      method: 'POST',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
      payload: { ruleId: 'rule-create', entityId: 'user-42', reason: 'known benign batch job' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { suppression: Record<string, unknown> };
    expect(created.suppression['ruleId']).toBe('rule-create');
    expect(created.suppression['entityId']).toBe('user-42');
    expect(created.suppression['suppressedCount']).toBe(0);

    const auditRows = await asAdmin(
      (c) =>
        c.query(
          `SELECT action, subject_id FROM audit_log WHERE action = 'suppression.create' AND subject_id = $1`,
          [created.suppression['id']],
        ),
      tenantId,
    );
    expect(auditRows.rows).toHaveLength(1);

    const listRes = await app.inject({
      method: 'GET',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listed = (listRes.json() as { suppressions: Array<Record<string, unknown>> }).suppressions;
    expect(listed.some((s) => s['id'] === created.suppression['id'])).toBe(true);
  });

  it('revoking removes it from the active list', async () => {
    const cookie = await signIn(analystEmail);
    const createRes = await app.inject({
      method: 'POST',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
      payload: { ruleId: 'rule-revoke', reason: 'temporary noise during a migration' },
    });
    const { suppression } = createRes.json() as { suppression: { id: string } };

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/suppressions/${suppression.id}/revoke`,
      cookies: { sentinel_session: cookie },
    });
    expect(revokeRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: '/suppressions',
      cookies: { sentinel_session: cookie },
    });
    const listed = (listRes.json() as { suppressions: Array<Record<string, unknown>> }).suppressions;
    expect(listed.some((s) => s['id'] === suppression.id)).toBe(false);
  });

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/suppressions' });
    expect(res.statusCode).toBe(401);
  });
});
