/**
 * P6-12 T1/T3 — against the real Postgres and Redis the dev stack
 * provides.
 *
 * T1's own literal "e2e" label would mean driving a real browser
 * through the full Microsoft OAuth hop — impossible without a real
 * Entra app registration (the same disclosed gap every M365-related
 * test in this repo already carries; see m365-connector.integration.
 * test.ts's own doc comment and connectors.spec.ts's e2e-suite
 * equivalent disclosure). This proves the identical real HTTP
 * round trip (connect -> callback) against a mock Microsoft token
 * endpoint instead, and asserts the funnel's own events land in
 * audit_log in the right order — the honest substitute this
 * codebase's own established precedent already uses for this exact
 * gap, not a new one invented for this ticket.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';
import { startMockM365TokenEndpoint, type MockM365TokenEndpoint } from './mock-m365-token-endpoint.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let mock: MockM365TokenEndpoint;
const kmsMasterKey = randomBytes(32).toString('base64');

const KNOWN_PASSWORD = 'correct horse battery staple';

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

interface SeededAdmin {
  tenantId: string;
  email: string;
}

async function makeAdminTenant(name: string, createdAt?: Date): Promise<SeededAdmin> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const email = `p6-12-${name}-${userId}@example.invalid`;
  const passwordHash = await hashPassword(KNOWN_PASSWORD);

  if (createdAt) {
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan, created_at) VALUES ($1, $2, $3, $4)', [tenantId, `P6-12 ${name}`, 'trial', createdAt]));
  } else {
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, `P6-12 ${name}`, 'trial']));
  }
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, email, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, userId]), tenantId);

  return { tenantId, email };
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  process.env['KMS_LOCAL_MASTER_KEY'] = kmsMasterKey;
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('T1: onboarding funnel events fire at each step of the connector flow', () => {
  let app: FastifyInstance;
  let tenant: SeededAdmin;

  beforeEach(async () => {
    mock = await startMockM365TokenEndpoint();
    app = await buildApp({
      pool,
      redis,
      cookieSecure: false,
      m365OAuthConfig: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'https://sentinel.example.invalid/connectors/m365/callback',
        authorityBaseUrl: mock.authorityBaseUrl,
      },
    });
    tenant = await makeAdminTenant('funnel-events');
  });

  afterEach(async () => {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenant.tenantId]));
    await app.close();
    await mock.close();
  });

  it('connector_connect_started fires on /connect, and consent_granted fires on a successful /callback, in that order', async () => {
    const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: tenant.email, password: KNOWN_PASSWORD } });
    const cookie = cookieFrom(signInRes)!;

    const connectRes = await app.inject({ method: 'GET', url: '/connectors/m365/connect', cookies: { sentinel_session: cookie } });
    expect(connectRes.statusCode).toBe(302);
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/connectors/m365/callback?code=real-looking-auth-code&state=${state}`,
      cookies: { sentinel_session: cookie },
    });
    expect(callbackRes.statusCode).toBe(302);

    const audit = await asAdmin(
      (c) => c.query<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id ASC`, [tenant.tenantId]),
      tenant.tenantId,
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions.indexOf('onboarding.connector_connect_started')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('connector.consent_granted')).toBeGreaterThan(actions.indexOf('onboarding.connector_connect_started'));
  });

  it("a tenant that starts but never completes the connect flow is a real, queryable drop-off — never audited as connected", async () => {
    const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: tenant.email, password: KNOWN_PASSWORD } });
    const cookie = cookieFrom(signInRes)!;

    await app.inject({ method: 'GET', url: '/connectors/m365/connect', cookies: { sentinel_session: cookie } });
    // No callback — the admin-consent screen was abandoned.

    const audit = await asAdmin(
      (c) => c.query<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1`, [tenant.tenantId]),
      tenant.tenantId,
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('onboarding.connector_connect_started');
    expect(actions).not.toContain('connector.consent_granted');
  });
});

describe('T3: GET /ops/pilot reflects seeded metric values correctly', () => {
  let app: FastifyInstance;
  let opsTenant: SeededAdmin;
  let customerTenant: SeededAdmin;
  let caseId: string;

  beforeAll(async () => {
    opsTenant = await makeAdminTenant('ops-tenant');

    // An exact, known signup instant this test can compute deltas
    // against — not "whatever now() happened to be."
    const signupAt = new Date('2026-01-01T00:00:00.000Z');
    customerTenant = await makeAdminTenant('pilot-customer', signupAt);

    // A case created exactly 2 hours after signup — an exact,
    // predictable timeToFirstCaseSeconds, not merely "some positive
    // number."
    const firstCaseAt = new Date(signupAt.getTime() + 2 * 60 * 60 * 1000);
    caseId = await asAdmin(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, created_at) VALUES ($1, 'high', 'Pilot funnel probe case', $2, 1, $2) RETURNING id`,
        [customerTenant.tenantId, firstCaseAt],
      );
      return rows[0]!.id;
    }, customerTenant.tenantId);

    // One helpful + one false-positive report — feeds both the
    // feedback counters and (via the false-positive one) the open
    // tuning-backlog counter.
    app = await buildApp({ pool, redis, cookieSecure: false, opsTenantId: opsTenant.tenantId });
    const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: customerTenant.email, password: KNOWN_PASSWORD } });
    const customerCookie = cookieFrom(signInRes)!;
    await app.inject({ method: 'POST', url: '/feedback', cookies: { sentinel_session: customerCookie }, payload: { subjectType: 'case', subjectId: caseId, isFalsePositive: false } });
    await app.inject({ method: 'POST', url: '/feedback', cookies: { sentinel_session: customerCookie }, payload: { subjectType: 'case', subjectId: caseId, isFalsePositive: true, comment: 'benign' } });
  });

  afterAll(async () => {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [opsTenant.tenantId]));
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [customerTenant.tenantId]));
    await app.close();
  });

  it("reflects this tenant's exact seeded time-to-first-case and feedback counts", async () => {
    const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: opsTenant.email, password: KNOWN_PASSWORD } });
    const opsCookie = cookieFrom(signInRes)!;

    const res = await app.inject({ method: 'GET', url: '/ops/pilot', cookies: { sentinel_session: opsCookie } });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      tenants: Array<{
        tenantId: string;
        timeToFirstCaseSeconds: number | null;
        timeToFirstConnectorSeconds: number | null;
        droppedOffAtConnector: boolean;
        feedbackCount: number;
        falsePositiveCount: number;
        openTuningBacklogCount: number;
      }>;
    };
    const mine = body.tenants.find((t) => t.tenantId === customerTenant.tenantId);
    expect(mine).toBeDefined();
    expect(mine!.timeToFirstCaseSeconds).toBe(2 * 60 * 60);
    expect(mine!.timeToFirstConnectorSeconds).toBeNull(); // never connected in this describe block
    expect(mine!.droppedOffAtConnector).toBe(false); // never even started — not the same as a drop-off
    expect(mine!.feedbackCount).toBe(2);
    expect(mine!.falsePositiveCount).toBe(1);
    expect(mine!.openTuningBacklogCount).toBe(1);
  });

  it('refuses an admin who is not the designated ops tenant', async () => {
    const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: customerTenant.email, password: KNOWN_PASSWORD } });
    const customerCookie = cookieFrom(signInRes)!;
    const res = await app.inject({ method: 'GET', url: '/ops/pilot', cookies: { sentinel_session: customerCookie } });
    expect(res.statusCode).toBe(403);
  });
});
