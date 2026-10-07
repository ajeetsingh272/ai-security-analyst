/**
 * P3-07 (TG3) — the full HTTP round trip for /dismissals/digest and
 * POST /cases/:id/challenge, against the real Postgres and Redis the
 * dev stack provides. Mirrors suppressions.integration.test.ts's own
 * fixture pattern exactly.
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

/** Mirrors what services/correlate/internal/cluster's CloseQuietCases
 * (P3-07) actually writes for a non-escalated case. */
async function seedDismissedCase(day: Date, reason: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count)
       VALUES ($1, 'medium', 'P3-07 api probe case', $2, 1) RETURNING id`,
      [tenantId, day],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered', $3)`,
      [tenantId, caseId, day],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, 'open', 'dismissed', 'system', 'correlate', $3, $4)`,
      [tenantId, caseId, reason, day],
    );
    return caseId;
  }, tenantId);
}

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sentinel_session')?.value;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email, password: KNOWN_PASSWORD } });
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
  analystEmail = `p3-07-analyst-${analystUserId}@example.invalid`;
  readOnlyUserId = randomUUID();
  readOnlyEmail = `p3-07-readonly-${readOnlyUserId}@example.invalid`;

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P3-07 probe tenant', 'trial']),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [analystUserId, analystEmail, passwordHash]),
  );
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, passwordHash]),
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'analyst')`, [tenantId, analystUserId]),
    tenantId,
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]),
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

describe('GET /dismissals/digest', () => {
  it('T1: lists dismissals grouped by reason for the requested day', async () => {
    const day = '2026-04-01';
    await seedDismissedCase(new Date(`${day}T00:00:00.000Z`), 'below_escalation_threshold');
    await seedDismissedCase(new Date(`${day}T00:00:00.000Z`), 'below_escalation_threshold');

    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: `/dismissals/digest?day=${day}`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { day: string; digest: Array<{ reason: string; caseCount: number }> };
    expect(body.day).toBe(day);
    expect(body.digest.find((r) => r.reason === 'below_escalation_threshold')?.caseCount).toBe(2);
  });

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/dismissals/digest' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed day', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/dismissals/digest?day=not-a-date', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cases/:id/challenge', () => {
  it('T3: reopens a dismissed case and audits the challenge', async () => {
    const caseId = await seedDismissedCase(new Date('2026-04-02T00:00:00.000Z'), 'below_escalation_threshold');
    const cookie = await signIn(analystEmail);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/challenge`,
      cookies: { sentinel_session: cookie },
      payload: { reason: 'this looked like real credential stuffing, not noise' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { case: { id: string } }).case.id).toBe(caseId);

    const state = await asAdmin(
      (c) => c.query<{ to_state: string }>('SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1', [caseId]),
      tenantId,
    );
    expect(state.rows[0]?.to_state).toBe('triaging');

    const audit = await asAdmin(
      (c) =>
        c.query(
          `SELECT actor_id FROM audit_log WHERE subject_type = 'case' AND subject_id = $1 AND action = 'case.transition'`,
          [caseId],
        ),
      tenantId,
    );
    expect(audit.rows.some((r) => r.actor_id === analystUserId)).toBe(true);
  });

  it('rejects a blank reason with 400', async () => {
    const caseId = await seedDismissedCase(new Date('2026-04-03T00:00:00.000Z'), 'below_escalation_threshold');
    const cookie = await signIn(analystEmail);
    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/challenge`,
      cookies: { sentinel_session: cookie },
      payload: { reason: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'reason_required' });
  });

  it('rejects a read_only caller with 403', async () => {
    const caseId = await seedDismissedCase(new Date('2026-04-04T00:00:00.000Z'), 'below_escalation_threshold');
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/challenge`,
      cookies: { sentinel_session: cookie },
      payload: { reason: 'a perfectly good reason' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for a case that is not currently dismissed', async () => {
    const cookie = await signIn(analystEmail);
    const res = await app.inject({
      method: 'POST',
      url: `/cases/${randomUUID()}/challenge`,
      cookies: { sentinel_session: cookie },
      payload: { reason: 'trying anyway' },
    });
    expect(res.statusCode).toBe(404);
  });
});
