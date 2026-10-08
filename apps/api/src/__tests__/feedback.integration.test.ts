/**
 * P6-12 — against the real Postgres and Redis the dev stack provides.
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
let userEmail: string;
let caseId: string;

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (scopedTenantId) await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopedTenantId]);
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

async function signIn(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('sign-in did not return a session cookie');
  return cookie;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  tenantId = randomUUID();
  const userId = randomUUID();
  userEmail = `p6-12-feedback-${userId}@example.invalid`;
  const passwordHash = await hashPassword(KNOWN_PASSWORD);

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P6-12 feedback probe tenant', 'trial']));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, userEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, userId]), tenantId);

  caseId = await asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'high', 'False positive probe case', now(), 1) RETURNING id`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, detected_at)
       VALUES ($1, $2, 'dedupe-1', 'signal-1', 'noisy_login_rule', 'user', 'entity-1', 'high', now())`,
      [tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  }, tenantId);

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /feedback', () => {
  it('rejects an invalid subject type', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      cookies: { sentinel_session: cookie },
      payload: { subjectType: 'not_a_real_type', subjectId: caseId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_subject_type' });
  });

  it('records helpful feedback without creating a tuning backlog item', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      cookies: { sentinel_session: cookie },
      payload: { subjectType: 'case', subjectId: caseId, isFalsePositive: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { feedback: { isFalsePositive: boolean }; tuningBacklogItem: unknown };
    expect(body.feedback.isFalsePositive).toBe(false);
    expect(body.tuningBacklogItem).toBeNull();
  });

  it('T2: a false-positive report on a case automatically creates a tuning backlog item referencing the case and its rule', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      cookies: { sentinel_session: cookie },
      payload: { subjectType: 'case', subjectId: caseId, isFalsePositive: true, comment: 'This was routine admin activity, not an attack.' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tuningBacklogItem: { id: string; caseId: string; ruleId: string | null; status: string; source: string } };
    expect(body.tuningBacklogItem).not.toBeNull();
    expect(body.tuningBacklogItem.caseId).toBe(caseId);
    expect(body.tuningBacklogItem.ruleId).toBe('noisy_login_rule');
    expect(body.tuningBacklogItem.status).toBe('open');
    expect(body.tuningBacklogItem.source).toBe('customer_feedback');

    // Proof against the real table, not just the route's own response.
    const rows = await asAdmin(
      (c) => c.query(`SELECT case_id, rule_id, status FROM tuning_backlog_items WHERE case_id = $1`, [caseId]),
      tenantId,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!['rule_id']).toBe('noisy_login_rule');
  });

  it('a false-positive report on a weekly report (not a case) never creates a tuning backlog item', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      cookies: { sentinel_session: cookie },
      payload: { subjectType: 'weekly_report', subjectId: randomUUID(), isFalsePositive: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tuningBacklogItem: unknown };
    expect(body.tuningBacklogItem).toBeNull();
  });

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'POST', url: '/feedback', payload: { subjectType: 'case', subjectId: caseId } });
    expect(res.statusCode).toBe(401);
  });
});
