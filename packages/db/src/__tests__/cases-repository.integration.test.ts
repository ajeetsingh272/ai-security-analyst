/**
 * P3-07 (TG3) T1/T3 — the real digest and challenge paths, against a
 * real database. Mirrors tenant-isolation.integration.test.ts's own
 * asAdmin/asTenant fixture pattern.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createControlPlanePool, withTenantContext, CasesRepository, AiDismissalEmptyReasonError } from '../index.js';

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
      actorType: 'system',
      reason: 'below_escalation_threshold',
      caseCount: 2,
      signalCount: 8, // 3 + 5
    });
    expect(byReason.get('duplicate_entity')).toEqual({
      actorType: 'system',
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

/** An open case with no dismissal yet — P4-12's own tests dismiss it
 * themselves via `recordAiDismissal`, rather than seeding the
 * dismissal transition directly the way `seedDismissedCase` does for
 * the rule-based (P3-07) tests above. */
async function seedOpenCase(day: Date, signalCount: number): Promise<string> {
  return asAdmin(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count)
       VALUES ($1, 'medium', 'P4-12 probe case', $2, $3)
       RETURNING id`,
      [tenantId, day, signalCount],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, NULL, 'triaging', 'system', 'correlate', 'escalated', $3)`,
      [tenantId, caseId, day],
    );
    return caseId;
  });
}

describe('CasesRepository.recordAiDismissal (P4-12)', () => {
  it("T1: an AI dismissal appears in that day's digest with its own stated reason, distinguishable from a rule-based dismissal", async () => {
    // recordAiDismissal is real application code — it stamps
    // occurred_at at now(), unlike seedDismissedCase's own raw-SQL
    // fixture (which backdates it for the P3-07 tests above), so this
    // test's own "day" has to be today for both halves to land in the
    // same digest window.
    const day = new Date();
    const caseId = await seedOpenCase(day, 4);
    await seedDismissedCase(day, 'below_escalation_threshold', 3); // a rule-based dismissal, same day

    await withTenantContext(tenantId, () => new CasesRepository(pool).recordAiDismissal(caseId, 'Routine travel for this user, not malicious'));

    const digest = await withTenantContext(tenantId, () => new CasesRepository(pool).dailyDismissalDigest(day));
    const aiRow = digest.find((r) => r.actorType === 'ai');
    const systemRow = digest.find((r) => r.actorType === 'system');
    expect(aiRow).toEqual({ actorType: 'ai', reason: 'Routine travel for this user, not malicious', caseCount: 1, signalCount: 4 });
    expect(systemRow?.actorType).toBe('system'); // AC3: distinguishable in the same digest
  });

  it('T3: a dismissal recorded without a reason fails validation', async () => {
    const day = new Date('2026-04-02T00:00:00.000Z');
    const caseId = await seedOpenCase(day, 1);
    await expect(withTenantContext(tenantId, () => new CasesRepository(pool).recordAiDismissal(caseId, ''))).rejects.toThrow(
      AiDismissalEmptyReasonError,
    );
    await expect(withTenantContext(tenantId, () => new CasesRepository(pool).recordAiDismissal(caseId, '   '))).rejects.toThrow(
      AiDismissalEmptyReasonError,
    );

    // The failed attempt wrote nothing — currentState is still whatever it was before.
    const state = await withTenantContext(tenantId, () => new CasesRepository(pool).currentState(caseId));
    expect(state).toBe('triaging');
  });

  it('T2: a customer can challenge an AI dismissal from the digest, reopening the case and auditing the action', async () => {
    const day = new Date('2026-04-03T00:00:00.000Z');
    const caseId = await seedOpenCase(day, 2);
    await withTenantContext(tenantId, () => new CasesRepository(pool).recordAiDismissal(caseId, 'Looked like normal business travel'));

    // challengeDismissal is P3-07's own existing mechanism (AC5 there,
    // AC4 here) — unchanged by this ticket, and this test is exactly
    // the proof that it already works identically for an AI dismissal,
    // since it only ever checks "is the case currently dismissed,"
    // never which actor_type dismissed it.
    const reopened = await withTenantContext(tenantId, () =>
      new CasesRepository(pool).challengeDismissal(caseId, 'customer-probe', 'this was actually suspicious'),
    );
    expect(reopened?.id).toBe(caseId);
    const state = await withTenantContext(tenantId, () => new CasesRepository(pool).currentState(caseId));
    expect(state).toBe('triaging');

    const audit = await asAdmin(async (c) => {
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      return c.query(`SELECT actor_type, actor_id FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 AND action = 'case.transition'`, [
        tenantId,
        caseId,
      ]);
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'human', actor_id: 'customer-probe' });
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
