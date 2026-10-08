/**
 * P6-09 T1 — "the generated specification matches actual endpoint
 * behaviour." Not just "the spec exists": for every documented /v1
 * response, this makes a REAL request against the REAL app and
 * validates the actual JSON response against that same operation's
 * own schema (via ajv) — so a route handler drifting from its own
 * declared `schema` (the thing @fastify/swagger reads to build the
 * spec in the first place) is caught here, not just trusted.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import Ajv from 'ajv';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';
import { filterToV1 } from '../openapi.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let adminUserId: string;
let adminEmail: string;
let rawApiKey: string;
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

/** The generated spec's own structure is only as typed as @fastify/
 * swagger's own return type lets it be (`unknown` once re-cast via
 * filterToV1) — this reaches into exactly the two levels this test
 * needs (one operation's response schema for a given status code),
 * nothing more. */
function responseSchemaFor(spec: Record<string, unknown>, path: string, status: string): object {
  const paths = spec['paths'] as Record<string, Record<string, { responses: Record<string, { content: { 'application/json': { schema: object } } }> }>>;
  return paths[path]!['get']!.responses[status]!.content['application/json'].schema;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  tenantId = randomUUID();
  adminUserId = randomUUID();
  adminEmail = `p6-09-openapi-${adminUserId}@example.invalid`;
  const passwordHash = await hashPassword(KNOWN_PASSWORD);

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P6-09 openapi probe tenant', 'trial']));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminUserId, adminEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, adminUserId]), tenantId);
  // CasesRepository.list's own query inner-joins against the case's
  // latest case_transitions row — a case with none is dropped from
  // list results entirely, not just shown with a null state (see
  // api-keys.integration.test.ts's own seedCase for the full note).
  caseId = await asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'critical', 'A real documented case', now(), 1) RETURNING id`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'test fixture')`,
      [tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  }, tenantId);

  app = await buildApp({ pool, redis, cookieSecure: false });

  const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: adminEmail, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(signInRes)!;
  const keyRes = await app.inject({ method: 'POST', url: '/api-keys', cookies: { sentinel_session: cookie }, payload: { name: 'openapi test key' } });
  rawApiKey = (keyRes.json() as { rawKey: string }).rawKey;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [adminUserId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('generated OpenAPI spec', () => {
  it('documents exactly the registered /v1 routes', () => {
    const spec = filterToV1(app.swagger() as unknown as Record<string, unknown>);
    const paths = Object.keys(spec['paths'] as Record<string, unknown>);
    expect(paths.sort()).toEqual(['/v1/cases', '/v1/cases/{id}', '/v1/reports/weekly'].sort());
  });

  it('T1: a real GET /v1/cases response validates against the spec\'s own documented 200 schema', async () => {
    const spec = filterToV1(app.swagger() as unknown as Record<string, unknown>);
    const responseSchema = responseSchemaFor(spec, '/v1/cases', '200');

    const res = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawApiKey } });
    expect(res.statusCode).toBe(200);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(responseSchema);
    const valid = validate(res.json());
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('T1: a real GET /v1/cases/{id} response validates against the spec\'s own documented 200 schema', async () => {
    const spec = filterToV1(app.swagger() as unknown as Record<string, unknown>);
    const responseSchema = responseSchemaFor(spec, '/v1/cases/{id}', '200');

    const res = await app.inject({ method: 'GET', url: `/v1/cases/${caseId}`, headers: { 'x-api-key': rawApiKey } });
    expect(res.statusCode).toBe(200);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(responseSchema);
    expect(validate(res.json())).toBe(true);
  });

  it('T1: a real 404 response validates against the spec\'s own documented 404 schema', async () => {
    const spec = filterToV1(app.swagger() as unknown as Record<string, unknown>);
    const responseSchema = responseSchemaFor(spec, '/v1/cases/{id}', '404');

    const res = await app.inject({ method: 'GET', url: `/v1/cases/${randomUUID()}`, headers: { 'x-api-key': rawApiKey } });
    expect(res.statusCode).toBe(404);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(responseSchema);
    expect(validate(res.json())).toBe(true);
  });

  it('T1: a real GET /v1/reports/weekly response validates against the spec\'s own documented 200 schema', async () => {
    const spec = filterToV1(app.swagger() as unknown as Record<string, unknown>);
    const responseSchema = responseSchemaFor(spec, '/v1/reports/weekly', '200');

    const res = await app.inject({ method: 'GET', url: '/v1/reports/weekly', headers: { 'x-api-key': rawApiKey } });
    expect(res.statusCode).toBe(200);

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(responseSchema);
    expect(validate(res.json())).toBe(true);
  });
});
