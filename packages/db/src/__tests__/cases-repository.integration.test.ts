/**
 * P3-07 (TG3) T1/T3 — the real digest and challenge paths, against a
 * real database. Mirrors tenant-isolation.integration.test.ts's own
 * asAdmin/asTenant fixture pattern.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createControlPlanePool, withTenantContext, CasesRepository } from '../index.js';

let pool: Pool;
let tenantId: string;

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
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

/** Seeds one case with a full open→dismissed transition history, dated
 * on `day`, with `reason` as the dismissal's own machine-readable
 * code. Mirrors what services/correlate/internal/cluster's
 * CloseQuietCases now actually writes for a non-escalated case
 * (P3-07) — raw SQL here deliberately, since this suite tests
 * CasesRepository's own READ/challenge paths, not the Go writer that
 * already has its own tests. */
async function seedDismissedCase(day: Date, reason: string, signalCount: number): Promise<string> {
  return asAdmin(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count)
       VALUES ($1, 'medium', 'P3-07 probe case', $2, $3)
       RETURNING id`,
      [tenantId, day, signalCount],
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
  });
}

beforeAll(async () => {
  pool = createControlPlanePool();
  const result = await asAdmin((c) =>
    c.query<{ id: string }>(
      `INSERT INTO tenants (name, plan) VALUES ('P3-07 digest probe', 'trial') RETURNING id`,
    ),
  );
  tenantId = result.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await pool.end();
});

describe('CasesRepository.dailyDismissalDigest', () => {
  it('T1: every dismissed case for the day appears, grouped by reason', async () => {
    const day = new Date('2026-03-01T00:00:00.000Z');
    await seedDismissedCase(day, 'below_escalation_threshold', 3);
    await seedDismissedCase(day, 'below_escalation_threshold', 5);
    await seedDismissedCase(day, 'duplicate_entity', 2);
    // A case dismissed on a DIFFERENT day must not pollute this day's digest.
    await seedDismissedCase(new Date('2026-03-02T00:00:00.000Z'), 'below_escalation_threshold', 99);

    const digest = await withTenantContext(tenantId, () => new CasesRepository(pool).dailyDismissalDigest(day));

    const byReason = new Map(digest.map((r) => [r.reason, r]));
    expect(byReason.get('below_escalation_threshold')).toEqual({
      reason: 'below_escalation_threshold',
      caseCount: 2,
      signalCount: 8, // 3 + 5
    });
    expect(byReason.get('duplicate_entity')).toEqual({
      reason: 'duplicate_entity',
      caseCount: 1,
      signalCount: 2,
    });
    // The other day's case (signalCount 99) must not appear anywhere.
    const totalSignals = digest.reduce((sum, r) => sum + r.signalCount, 0);
    expect(totalSignals).toBe(10);
  });

  it('a day with no dismissals returns an empty digest, not an error', async () => {
    const digest = await withTenantContext(tenantId, () =>
      new CasesRepository(pool).dailyDismissalDigest(new Date('2099-01-01T00:00:00.000Z')),
    );
    expect(digest).toEqual([]);
  });
});

describe('CasesRepository.challengeDismissal', () => {
  it('T3: reopens the case to triaging and writes an audit entry', async () => {
    const day = new Date('2026-03-05T00:00:00.000Z');
    const caseId = await seedDismissedCase(day, 'below_escalation_threshold', 1);

    const reopened = await withTenantContext(tenantId, () =>
      new CasesRepository(pool).challengeDismissal(caseId, 'analyst-probe', 'looked like real lateral movement'),
    );
    expect(reopened?.id).toBe(caseId);

    const state = await withTenantContext(tenantId, () => new CasesRepository(pool).currentState(caseId));
    expect(state).toBe('triaging');

    const audit = await asAdmin(async (c) => {
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      return c.query(
        `SELECT actor_type, actor_id, action FROM audit_log
         WHERE tenant_id = $1 AND subject_type = 'case' AND subject_id = $2 AND action = 'case.transition'`,
        [tenantId, caseId],
      );
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'human', actor_id: 'analyst-probe', action: 'case.transition' });
  });

  it('returns null for a case that is not currently dismissed', async () => {
    const day = new Date('2026-03-06T00:00:00.000Z');
    const caseId = await asAdmin(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count)
         VALUES ($1, 'medium', 'still open', $2, 1) RETURNING id`,
        [tenantId, day],
      );
      await client.query(
        `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
         VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered', $3)`,
        [tenantId, rows[0]!.id, day],
      );
      return rows[0]!.id;
    });

    const result = await withTenantContext(tenantId, () =>
      new CasesRepository(pool).challengeDismissal(caseId, 'analyst-probe', 'trying anyway'),
    );
    expect(result).toBeNull();
  });
});
