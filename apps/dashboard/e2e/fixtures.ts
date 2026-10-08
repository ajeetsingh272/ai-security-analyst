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

/** P6-06: a bare client tenant (no user of its own needed — the MSP
 * console only ever reads cases inside it, never signs a real user
 * into it directly). */
export async function seedClientTenant(name: string): Promise<string> {
  const tenantId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, name, 'trial']));
  return tenantId;
}

export async function linkMspClient(mspTenantId: string, clientTenantId: string): Promise<void> {
  await asAdmin((c) => c.query('INSERT INTO msp_links (msp_tenant_id, client_tenant_id) VALUES ($1, $2)', [mspTenantId, clientTenantId]), mspTenantId);
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

/** P6-03: a real, approvable action row for a case — `revoke_sessions`
 * requires no step-up (P5-04's own DESTRUCTIVE_PLAYBOOKS set), so this
 * is the one usable for a plain "click Approve" e2e test without also
 * exercising the step-up password prompt. */
export async function seedAction(tenantId: string, caseId: string, playbook: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, $3, '{}'::jsonb, 'single_user') RETURNING id`,
      [tenantId, caseId, playbook],
    );
    return rows[0]!.id;
  }, tenantId);
}

/** P6-04: a connector row in a given status, without driving the real
 * OAuth flow (which needs a real Entra app registration this sandbox
 * doesn't have — the flow's own backend half is proven separately
 * against a mock Microsoft token endpoint, apps/api/src/__tests__/
 * mock-m365-token-endpoint.ts). This is for exercising the wizard's
 * OWN rendering of each connector state. */
export async function seedConnector(tenantId: string, status: 'healthy' | 'revoked' | 'error'): Promise<void> {
  await asAdmin(
    (c) =>
      c.query(
        `INSERT INTO connectors (tenant_id, kind, status, last_sync_at, last_error)
         VALUES ($1, 'm365', $2, now(), $3)`,
        [tenantId, status, status === 'error' ? 'simulated failure for e2e' : null],
      ),
    tenantId,
  );
}

/** P6-05 T4: the funnel's own real evidence — reads straight from
 * audit_log rather than trusting the UI's own claim that something
 * happened. */
export async function auditActionsFor(tenantId: string, subjectId: string): Promise<string[]> {
  return asAdmin(
    (c) => c.query<{ action: string }>(`SELECT action FROM audit_log WHERE subject_id = $1 ORDER BY id ASC`, [subjectId]).then((r) => r.rows.map((row) => row.action)),
    tenantId,
  );
}

/** P6-08: a case already dismissed by a rule ('system') or by Sentinel's
 * own AI triage ('ai'), with a given reason — exactly the shape
 * `dailyDismissalDigest` groups by (actor_type, reason). */
export async function seedDismissedCase(tenantId: string, actorType: 'system' | 'ai', reason: string, title: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'low', $2, now(), 1) RETURNING id`,
      [tenantId, title],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'e2e fixture')`,
      [tenantId, caseId],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, 'open', 'dismissed', $3, $4, $5)`,
      [tenantId, caseId, actorType, actorType === 'ai' ? 'sentinel-analyst' : 'correlate', reason],
    );
    return caseId;
  }, tenantId);
}

/** P6-08: a real, revocable suppression row. */
export async function seedSuppression(tenantId: string, createdByUserId: string, ruleId: string, reason: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO suppressions (tenant_id, rule_id, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 days') RETURNING id`,
      [tenantId, ruleId, reason, createdByUserId],
    );
    return rows[0]!.id;
  }, tenantId);
}

/** P6-07: a weekly report row, seeded directly so a read_only viewer's
 * page (which cannot itself call POST /reports/weekly) has something
 * real to render. */
export async function seedWeeklyReport(tenantId: string, headline: string, oneImprovement: string | null): Promise<void> {
  await asAdmin(
    (c) =>
      c.query(
        `INSERT INTO weekly_reports (tenant_id, window_start, window_end, headline, one_improvement, is_quiet, data)
         VALUES ($1, now() - interval '7 days', now(), $2, $3, $4, $5::jsonb)`,
        [tenantId, headline, oneImprovement, oneImprovement === null, JSON.stringify({ totalCases: 0, bySeverity: {}, actionsByStatus: {}, entitiesAffected: 0, topCase: null })],
      ),
    tenantId,
  );
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

export async function cleanupTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}
