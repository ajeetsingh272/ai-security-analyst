/**
 * P3-07 (TG3) T1/T3 — the real digest and challenge paths, against a
 * real database. Mirrors tenant-isolation.integration.test.ts's own
 * asAdmin/asTenant fixture pattern.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
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

/** Full fixture for P6-02's list()/filterOptions(): a case, its initial
 * 'open' transition (every real case gets exactly this at creation —
 * see list()'s own doc comment), an entity with a human-readable alias,
 * and one case_signal carrying a rule_id — everything list()'s filters
 * and filterOptions() actually query against. */
async function seedListCase(opts: {
  severity: string;
  score: number;
  state: string;
  createdAt: Date;
  ruleId: string;
  entityAlias: string;
}): Promise<{ caseId: string; entityId: string }> {
  return asAdmin(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);

    const entityResult = await client.query<{ id: string }>(
      `INSERT INTO entities (tenant_id, entity_type, status) VALUES ($1, 'user', 'resolved') RETURNING id`,
      [tenantId],
    );
    const entityId = entityResult.rows[0]!.id;
    await client.query(
      `INSERT INTO entity_aliases (tenant_id, entity_id, alias_type, alias_value) VALUES ($1, $2, 'email', $3)`,
      [tenantId, entityId, opts.entityAlias],
    );

    const caseResult = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, score, title, window_start, entity_ids, signal_count, created_at)
       VALUES ($1, $2, $3, 'P6-02 list probe', $4, ARRAY[$5]::text[], 1, $4)
       RETURNING id`,
      [tenantId, opts.severity, opts.score, opts.createdAt, entityId],
    );
    const caseId = caseResult.rows[0]!.id;

    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered', $3)`,
      [tenantId, caseId, opts.createdAt],
    );
    if (opts.state !== 'open') {
      await client.query(
        `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
         VALUES ($1, $2, 'open', $3, 'human', 'p6-02-probe', 'list test fixture', $4)`,
        [tenantId, caseId, opts.state, opts.createdAt],
      );
    }

    await client.query(
      `INSERT INTO case_signals (tenant_id, case_id, signal_id, rule_id, entity_type, entity_id, severity, detected_at, dedupe_key)
       VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8)`,
      [tenantId, caseId, randomUUID(), opts.ruleId, entityId, opts.severity, opts.createdAt, randomUUID()],
    );

    return { caseId, entityId };
  });
}

describe('CasesRepository.list / filterOptions', () => {
  it('T1: severity, state, entity, rule and date-range filters each produce the correct result set, and ranking sorts by severity then score', async () => {
    const critical = await seedListCase({
      severity: 'critical',
      score: 90,
      state: 'open',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      ruleId: 'rule.impossible-travel',
      entityAlias: 'critical-user@example.invalid',
    });
    const highLowerScore = await seedListCase({
      severity: 'high',
      score: 99, // higher raw score than the critical case, but severity still ranks first
      state: 'investigating',
      createdAt: new Date('2026-04-02T00:00:00.000Z'),
      ruleId: 'rule.mailbox-rule-created',
      entityAlias: 'high-user@example.invalid',
    });
    const dismissedLow = await seedListCase({
      severity: 'low',
      score: 10,
      state: 'dismissed',
      createdAt: new Date('2026-01-01T00:00:00.000Z'), // well outside the date-range filter test below
      ruleId: 'rule.impossible-travel',
      entityAlias: 'low-user@example.invalid',
    });

    await withTenantContext(tenantId, async () => {
      const repo = new CasesRepository(pool);

      // This file's other describe blocks share the SAME tenantId and
      // leave their own fixture cases behind — so every assertion below
      // checks membership of these 3 known ids, never exact-equals the
      // whole result set, which would otherwise be polluted by whatever
      // those other blocks already seeded (confirmed the hard way: an
      // exact-equals version of the `state: 'dismissed'` assertion below
      // first failed against 6 unrelated dismissed cases from earlier
      // blocks in this same file).

      // Unfiltered: ranked critical, then high, then low — NOT by raw
      // score, which would have put the high-severity case first.
      const all = await repo.list({}, 1, 500);
      const allIds = all.items.map((i) => i.id);
      expect(allIds.indexOf(critical.caseId)).toBeLessThan(allIds.indexOf(highLowerScore.caseId));
      expect(allIds.indexOf(highLowerScore.caseId)).toBeLessThan(allIds.indexOf(dismissedLow.caseId));

      const bySeverity = await repo.list({ severity: 'critical' }, 1, 50);
      const bySeverityIds = bySeverity.items.map((i) => i.id);
      expect(bySeverityIds).toContain(critical.caseId);
      expect(bySeverityIds).not.toContain(highLowerScore.caseId);
      expect(bySeverityIds).not.toContain(dismissedLow.caseId);

      const byState = await repo.list({ state: 'dismissed' }, 1, 50);
      const byStateIds = byState.items.map((i) => i.id);
      expect(byStateIds).toContain(dismissedLow.caseId);
      expect(byStateIds).not.toContain(critical.caseId);
      expect(byStateIds).not.toContain(highLowerScore.caseId);

      const byEntity = await repo.list({ entityId: highLowerScore.entityId }, 1, 50);
      const byEntityIds = byEntity.items.map((i) => i.id);
      expect(byEntityIds).toContain(highLowerScore.caseId);
      expect(byEntityIds).not.toContain(critical.caseId);
      expect(byEntityIds).not.toContain(dismissedLow.caseId);

      const byRule = await repo.list({ ruleId: 'rule.impossible-travel' }, 1, 50);
      const byRuleIds = byRule.items.map((i) => i.id);
      expect(byRuleIds).toContain(critical.caseId);
      expect(byRuleIds).toContain(dismissedLow.caseId);
      expect(byRuleIds).not.toContain(highLowerScore.caseId);

      const byDateRange = await repo.list(
        { createdAfter: '2026-03-25T00:00:00.000Z', createdBefore: '2026-04-30T23:59:59.000Z' },
        1,
        50,
      );
      const byDateRangeIds = byDateRange.items.map((i) => i.id);
      expect(byDateRangeIds).toContain(critical.caseId);
      expect(byDateRangeIds).toContain(highLowerScore.caseId);
      expect(byDateRangeIds).not.toContain(dismissedLow.caseId);
    });
  });

  it('paginates correctly: page size and total are both honoured', async () => {
    await withTenantContext(tenantId, async () => {
      const repo = new CasesRepository(pool);
      const firstPage = await repo.list({}, 1, 2);
      expect(firstPage.items.length).toBeLessThanOrEqual(2);
      expect(firstPage.total).toBeGreaterThanOrEqual(3); // at least the 3 cases seeded above

      const secondPage = await repo.list({}, 2, 2);
      const firstIds = new Set(firstPage.items.map((i) => i.id));
      for (const item of secondPage.items) {
        expect(firstIds.has(item.id)).toBe(false); // no overlap between pages
      }
    });
  });

  it('filterOptions() returns human-readable entity labels and the distinct rule ids actually in use', async () => {
    const options = await withTenantContext(tenantId, () => new CasesRepository(pool).filterOptions());

    expect(options.entities.some((e) => e.label === 'critical-user@example.invalid')).toBe(true);
    expect(options.rules.some((r) => r.value === 'rule.impossible-travel')).toBe(true);
    expect(options.rules.some((r) => r.value === 'rule.mailbox-rule-created')).toBe(true);
  });
});
