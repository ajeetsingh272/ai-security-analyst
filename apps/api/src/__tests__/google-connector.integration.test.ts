/**
 * P7-01 — the full admin-consent flow (connect → callback → revoke)
 * against real Postgres, real Redis, and a LOCAL MOCK of Google's token
 * endpoint (mock-google-token-endpoint.ts) that speaks the real
 * documented contract. Mirrors m365-connector.integration.test.ts's own
 * structure and disclosed gap (T1: "consent flow... against a Google test
 * tenant" — proven here against the mock instead; see that file's doc
 * comment for the identical framing applied to the first identity
 * connector).
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
import { LocalKMS, TenantCredentialVault, withTenantContext } from '@sentinel/db';
import { startMockGoogleTokenEndpoint, type MockGoogleTokenEndpoint } from './mock-google-token-endpoint.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;
let mock: MockGoogleTokenEndpoint;
const kmsMasterKey = randomBytes(32).toString('base64');

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let userId: string;
let userEmail: string;

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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  process.env['KMS_LOCAL_MASTER_KEY'] = kmsMasterKey;

  tenantId = randomUUID();
  userId = randomUUID();
  userEmail = `p7-01-probe-${userId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P7-01 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, userEmail, passwordHash]));
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, userId]),
    tenantId,
  );
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  await redis.quit();
  await pool.end();
});

beforeEach(async () => {
  mock = await startMockGoogleTokenEndpoint();
  app = await buildApp({
    pool,
    redis,
    cookieSecure: false,
    googleOAuthConfig: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://sentinel.example.invalid/connectors/google/callback',
      tokenEndpointBaseUrl: mock.tokenEndpointBaseUrl,
    },
  });
});

afterEach(async () => {
  await app.close();
  await mock.close();
});

async function signIn(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('sign-in did not return a session cookie');
  return cookie;
}

describe('GET /connectors/google/connect', () => {
  it('returns 503 when no Google Cloud OAuth client is configured', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, googleOAuthConfig: undefined });
    try {
      const cookie = await (async () => {
        const res = await unconfiguredApp.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
        return cookieFrom(res)!;
      })();
      const res = await unconfiguredApp.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('google_not_configured');
    } finally {
      await unconfiguredApp.close();
    }
  });

  it("redirects to the real authorize URL shape, scoped to this admin's tenant via server-side state", async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('rejects a read_only member — admin is the minimum required role', async () => {
    const readOnlyUserId = randomUUID();
    const readOnlyEmail = `p7-01-readonly-${readOnlyUserId}@example.invalid`;
    const readOnlyPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, readOnlyPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]), tenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: readOnlyEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(403);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyUserId]));
    }
  });
});

// T1 (the integration half against a mock honouring Google's documented
// contract — there is no real Workspace test tenant available in this
// environment; see this file's own doc comment).
describe('the full connect -> callback flow (T1)', () => {
  it('stores an encrypted, decryptable credential and audits consent granted', async () => {
    const cookie = await signIn();

    const connectRes = await app.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/connectors/google/callback?code=real-looking-auth-code&state=${state}`,
      cookies: { sentinel_session: cookie },
    });
    expect(callbackRes.statusCode).toBe(302);
    const redirectUrl = new URL(callbackRes.headers.location as string);
    expect(redirectUrl.pathname).toBe('/connectors');
    expect(redirectUrl.searchParams.get('google')).toBe('connected');
    expect(mock.exchangedCodes).toContain('real-looking-auth-code');

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'google_workspace']), tenantId);
    expect(rows[0].status).toBe('healthy');
    expect(Buffer.isBuffer(rows[0].credentials)).toBe(true);
    expect(rows[0].dek_id).toBeTruthy();

    const kms = new LocalKMS(kmsMasterKey);
    const decrypted = await withTenantContext(tenantId, () => new TenantCredentialVault(pool, kms).decryptCredentials(rows[0].credentials));
    expect(decrypted['refreshToken']).toContain('real-looking-auth-code');

    const audit = await asAdmin((c) => c.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'connector.consent_granted' ORDER BY id DESC LIMIT 1", [tenantId]), tenantId);
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects a reused or forged state', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'GET',
      url: '/connectors/google/callback?code=whatever&state=not-a-real-state',
      cookies: { sentinel_session: cookie },
    });
    expect(res.statusCode).toBe(302);
    const redirectUrl = new URL(res.headers.location as string);
    expect(redirectUrl.searchParams.get('google')).toBe('error');
    expect(redirectUrl.searchParams.get('reason')).toBe('invalid_or_expired_state');
  });

  it('surfaces a declined consent as a redirect back into the wizard, not a 500', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

    const res = await app.inject({
      method: 'GET',
      url: `/connectors/google/callback?error=access_denied&error_description=The+admin+declined&state=${state}`,
      cookies: { sentinel_session: cookie },
    });
    expect(res.statusCode).toBe(302);
    const redirectUrl = new URL(res.headers.location as string);
    expect(redirectUrl.searchParams.get('google')).toBe('error');
    expect(redirectUrl.searchParams.get('reason')).toBe('consent_declined');
  });
});

describe('POST /connectors/google/revoke', () => {
  it('deletes the stored credentials, marks the connector revoked, and audits it', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/google/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/connectors/google/callback?code=to-be-revoked&state=${state}`, cookies: { sentinel_session: cookie } });

    const revokeRes = await app.inject({ method: 'POST', url: '/connectors/google/revoke', cookies: { sentinel_session: cookie } });
    expect(revokeRes.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'google_workspace']), tenantId);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].credentials).toBeNull();
    expect(rows[0].dek_id).toBeNull();

    const audit = await asAdmin((c) => c.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'connector.consent_revoked' ORDER BY id DESC LIMIT 1", [tenantId]), tenantId);
    expect(audit.rows).toHaveLength(1);
  });

  it('returns 404 for a tenant that never connected Google Workspace at all', async () => {
    const neverConnectedTenantId = randomUUID();
    const neverConnectedUserId = randomUUID();
    const neverConnectedEmail = `p7-01-never-${neverConnectedUserId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [neverConnectedTenantId, 'P7-01 never-connected probe', 'trial']));
    const neverConnectedPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [neverConnectedUserId, neverConnectedEmail, neverConnectedPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [neverConnectedTenantId, neverConnectedUserId]), neverConnectedTenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: neverConnectedEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'POST', url: '/connectors/google/revoke', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [neverConnectedTenantId]));
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [neverConnectedUserId]));
    }
  });
});
