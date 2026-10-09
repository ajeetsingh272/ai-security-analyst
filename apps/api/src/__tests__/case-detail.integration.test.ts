/**
 * P6-03 — GET /cases/:id, GET /cases/:id/evidence and POST
 * /cases/:caseId/actions/:actionId/approve, against the real Postgres
 * and Redis the dev stack provides.
 *
 * The evidence route's ClickHouse round trip itself is covered by a
 * SEPARATE describe block below ("GET /cases/:id/evidence (real
 * ClickHouse)"), against the real dev-stack ClickHouse — P1-06/P7-05's
 * own `infra/docker/clickhouse-storage.xml` wires a real SeaweedFS-
 * backed `cold` disk into this stack, so ClickHouse itself starts fine
 * here; an earlier version of this comment claimed otherwise from a
 * since-resolved, session-specific Windows dynamic-port-exclusion
 * collision, not a standing limitation. The main describe block below
 * still deliberately exercises the route's honest 503 when
 * CLICKHOUSE_URL is unset — the exact degraded-not-crashed contract
 * app.ts's own doc comment promises — using its own `app` instance
 * built without a clickhouseUrl.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { createClient as createClickHouseClient, type ClickHouseClient } from '@clickhouse/client';
import pg, { type PoolClient } from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let analystUserId: string;
let analystEmail: string;
let readOnlyEmail: string;

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
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

async function seedCaseWithSignal(): Promise<string> {
  return asAdmin(async (client) => {
    const caseResult = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'critical', 'P6-03 probe case', now(), 1) RETURNING id`,
      [tenantId],
    );
    const caseId = caseResult.rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered')`,
      [tenantId, caseId],
    );
    await client.query(
      `INSERT INTO case_signals (tenant_id, case_id, signal_id, rule_id, entity_type, entity_id, severity, detected_at, dedupe_key, mitre_ids)
       VALUES ($1, $2, $3, 'rule.impossible-travel', 'user', 'priya@example.com', 'critical', now(), $4, ARRAY['T1078.004'])`,
      [tenantId, caseId, randomUUID(), randomUUID()],
    );
    return caseId;
  }, tenantId);
}

async function createAction(caseId: string, playbook: string): Promise<string> {
  const result = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, $3, '{}'::jsonb, 'single_user') RETURNING id`, [
      tenantId,
      caseId,
      playbook,
    ]),
    tenantId,
  );
  return result.rows[0]!.id;
}

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string {
  const value = res.cookies.find((c) => c.name === 'sentinel_session')?.value;
  if (!value) throw new Error('no session cookie in response');
  return value;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email, password: KNOWN_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  analystUserId = randomUUID();
  analystEmail = `p6-03-analyst-${analystUserId}@example.invalid`;
  readOnlyEmail = `p6-03-readonly-${randomUUID()}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P6-03 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [analystUserId, analystEmail, passwordHash]));
  const readOnlyId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyId, readOnlyEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'analyst')`, [tenantId, analystUserId]), tenantId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyId]), tenantId);

  // No CLICKHOUSE_URL passed — exercises the documented degraded path.
  app = await buildApp({ pool, redis, cookieSecure: false, clickhouseUrl: undefined });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query("DELETE FROM users WHERE email LIKE 'p6-03-%@example.invalid'"));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('GET /cases/:id', () => {
  it('returns the case, its history, and the plain-English MITRE entry for its signal', async () => {
    const caseId = await seedCaseWithSignal();
    const cookie = await signIn(readOnlyEmail);

    const res = await app.inject({ method: 'GET', url: `/cases/${caseId}`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      case: { id: string };
      signals: Array<{ mitreIds: string[] }>;
      transitions: Array<{ toState: string }>;
      mitre: Array<{ id: string; name: string; description: string }>;
      actions: unknown[];
      verdict: unknown;
    };

    expect(body.case.id).toBe(caseId);
    expect(body.transitions.some((t) => t.toState === 'open')).toBe(true);
    expect(body.signals[0]?.mitreIds).toEqual(['T1078.004']);
    expect(body.mitre).toEqual([
      expect.objectContaining({ id: 'T1078.004', name: 'Valid Accounts: Cloud Accounts' }),
    ]);
    expect(body.mitre[0]?.description.length).toBeGreaterThan(0);
    expect(body.verdict).toBeNull(); // no investigation transcript seeded for this case
    expect(body.actions).toEqual([]);
  });

  it('returns 404 for a case that does not exist', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: `/cases/${randomUUID()}`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /cases/:id/evidence', () => {
  it('answers 503, not a crash, when ClickHouse is not configured', async () => {
    const caseId = await seedCaseWithSignal();
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: `/cases/${caseId}/evidence?ids=abc123`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('clickhouse_unconfigured');
  });
});

describe('GET /cases/:id/evidence (real ClickHouse)', () => {
  /** Seeding needs INSERT, which `sentinel_query_user` is never granted
   * (0002's own GRANT SELECT-only) — same reason apps/analyst's own
   * tools.integration.test.ts connects as the default user to seed. */
  const chAdmin: ClickHouseClient = createClickHouseClient({ url: CLICKHOUSE_URL, database: 'sentinel' });
  let chApp: FastifyInstance;
  let chTenantId: string;
  let chReadOnlyEmail: string;

  async function seedEvent(tenantId: string, eventId: string, time: Date, message: string): Promise<void> {
    await chAdmin.insert({
      table: 'events',
      values: [{
        tenant_id: tenantId,
        event_id: eventId,
        time: time.toISOString().replace('T', ' ').replace('Z', ''),
        class_uid: 3002,
        category_uid: 3,
        activity_id: 1,
        severity_id: 1,
        actor_user_uid: 'priya@example.com',
        target_uid: '',
        src_ip: '203.0.113.9',
        status_id: 1,
        message,
      }],
      format: 'JSONEachRow',
    });
  }

  beforeAll(async () => {
    chTenantId = randomUUID();
    const readOnlyId = randomUUID();
    chReadOnlyEmail = `p7-05-readonly-${readOnlyId}@example.invalid`;
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [chTenantId, 'P7-05 evidence tier probe tenant', 'trial']));
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyId, chReadOnlyEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [chTenantId, readOnlyId]), chTenantId);

    chApp = await buildApp({ pool, redis, cookieSecure: false, clickhouseUrl: CLICKHOUSE_URL });
  });

  afterAll(async () => {
    await chAdmin.command({ query: 'ALTER TABLE sentinel.events DELETE WHERE tenant_id = {tenantId:UUID}', query_params: { tenantId: chTenantId }, clickhouse_settings: { mutations_sync: '1' } });
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [chTenantId]));
    await chApp.close();
  });

  it("AC4: an event younger than 90 days is reported as tier 'hot', and tookMs is a real measured duration", async () => {
    const caseId = await asAdmin(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', chTenantId]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'critical', 'P7-05 hot-tier probe case', now(), 1) RETURNING id`,
        [chTenantId],
      );
      return rows[0]!.id;
    }, chTenantId);

    const eventId = `evt-hot-${randomUUID()}`;
    await seedEvent(chTenantId, eventId, new Date(), 'Sign-in from an unfamiliar location');

    // signIn (the outer helper) closes over `app`, which has no
    // CLICKHOUSE_URL configured — this route needs chApp's own
    // ClickHouse-configured instance, so sign in directly against it.
    const chCookieRes = await chApp.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: chReadOnlyEmail, password: KNOWN_PASSWORD } });
    const chCookie = chCookieRes.cookies.find((c) => c.name === 'sentinel_session')?.value;
    if (!chCookie) throw new Error(`sign-in failed against chApp: ${chCookieRes.statusCode} ${chCookieRes.body}`);

    const res = await chApp.inject({ method: 'GET', url: `/cases/${caseId}/evidence?ids=${eventId}`, cookies: { sentinel_session: chCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ id: string; status: string; tier?: string }>; tookMs: number };
    expect(body.results).toEqual([expect.objectContaining({ id: eventId, status: 'found', tier: 'hot' })]);
    expect(body.tookMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.tookMs)).toBe(true);
  });

  it("AC4: an event older than 90 days is reported as tier 'cold'", async () => {
    const caseId = await asAdmin(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', chTenantId]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'critical', 'P7-05 cold-tier probe case', now(), 1) RETURNING id`,
        [chTenantId],
      );
      return rows[0]!.id;
    }, chTenantId);

    const eventId = `evt-cold-${randomUUID()}`;
    const agedTime = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days old — past the 90-day hot boundary
    await seedEvent(chTenantId, eventId, agedTime, 'Historical sign-in, past the hot-tier boundary');

    const chCookieRes = await chApp.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: chReadOnlyEmail, password: KNOWN_PASSWORD } });
    const chCookie = chCookieRes.cookies.find((c) => c.name === 'sentinel_session')?.value;
    if (!chCookie) throw new Error(`sign-in failed against chApp: ${chCookieRes.statusCode} ${chCookieRes.body}`);

    const res = await chApp.inject({ method: 'GET', url: `/cases/${caseId}/evidence?ids=${eventId}`, cookies: { sentinel_session: chCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ id: string; status: string; tier?: string }> };
    expect(body.results).toEqual([expect.objectContaining({ id: eventId, status: 'found', tier: 'cold' })]);
  });
});

describe('POST /cases/:caseId/actions/:actionId/approve', () => {
  it('approves a non-destructive action with no step-up required, and attempts execution', async () => {
    const caseId = await seedCaseWithSignal();
    const actionId = await createAction(caseId, 'revoke_sessions');
    const cookie = await signIn(analystEmail);

    const res = await app.inject({ method: 'POST', url: `/cases/${caseId}/actions/${actionId}/approve`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, approved: true });
  });

  it('T2/T4 (P5-04 reused): a destructive action is refused without the correct step-up password, and is left untouched', async () => {
    const caseId = await seedCaseWithSignal();
    const actionId = await createAction(caseId, 'disable_user');
    const cookie = await signIn(analystEmail);

    const res = await app.inject({ method: 'POST', url: `/cases/${caseId}/actions/${actionId}/approve`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('step_up_failed');
  });

  it('a destructive action approves with the correct step-up password', async () => {
    const caseId = await seedCaseWithSignal();
    const actionId = await createAction(caseId, 'disable_user');
    const cookie = await signIn(analystEmail);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/actions/${actionId}/approve`,
      cookies: { sentinel_session: cookie },
      payload: { stepUpPassword: KNOWN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, approved: true });
  });

  it('returns 404 for an action that does not belong to this case', async () => {
    const caseId = await seedCaseWithSignal();
    const otherCaseId = await seedCaseWithSignal();
    const actionId = await createAction(otherCaseId, 'revoke_sessions');
    const cookie = await signIn(analystEmail);

    const res = await app.inject({ method: 'POST', url: `/cases/${caseId}/actions/${actionId}/approve`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('a read_only member cannot approve', async () => {
    const caseId = await seedCaseWithSignal();
    const actionId = await createAction(caseId, 'revoke_sessions');
    const cookie = await signIn(readOnlyEmail);

    const res = await app.inject({ method: 'POST', url: `/cases/${caseId}/actions/${actionId}/approve`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
  });
});
