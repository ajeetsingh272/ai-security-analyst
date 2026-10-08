/**
 * Real Postgres fixtures for the P6-01 e2e suite — the same `asAdmin`
 * pattern apps/api's own integration tests use, reused here because this
 * suite is exercising the SAME real backend (apps/api/src/server.ts,
 * started by playwright.config.ts's webServer), not a mock.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../../api/src/auth/password.ts';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});

export const TEST_PASSWORD = 'p6-01-e2e-password';

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, tenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (tenantId) await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
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

export interface SeededUser {
  tenantId: string;
  userId: string;
  email: string;
}

export async function seedTenantAndUser(role: 'owner' | 'admin' | 'analyst' | 'read_only'): Promise<SeededUser> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const email = `p6-01-e2e-${userId}@example.invalid`;
  const passwordHash = await hashPassword(TEST_PASSWORD);

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, `P6-01 e2e (${role})`, 'trial']));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, email, passwordHash]));
  await asAdmin((c) => c.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenantId, userId, role]), tenantId);

  return { tenantId, userId, email };
}

/** P6-02: a minimal real case, with the initial 'open' transition every
 * real case gets at creation (services/correlate's own lifecycle.Writer)
 * — without it, `state` would come back null and a `state` filter would
 * never match. */
export async function seedCase(tenantId: string, severity: string, title: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, $2, $3, now(), 1) RETURNING id`,
      [tenantId, severity, title],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'e2e fixture')`,
      [tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  }, tenantId);
}

/** Tenants cascade-delete memberships, but `users` is a global table with
 * no tenant_id — left behind otherwise. Deliberately does not close the
 * shared `pool` — several spec files load this same module within one
 * worker process (Playwright reuses a worker across files), so any one
 * file ending the pool in its own `afterAll` would break every other
 * file's fixtures that still needed it. The worker process exiting when
 * the run finishes is what actually releases the connection. */
export async function cleanupUser(user: SeededUser): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [user.tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [user.userId]));
}
