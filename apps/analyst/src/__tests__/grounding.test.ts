/**
 * P4-04 T1/T2/T3/T4 — the grounding validator, with a fake ClickHouse
 * client (no real infra) standing in for `sentinel.events`. A fake is
 * legitimate here specifically because the REAL tenant isolation this
 * function relies on (T3) is ClickHouse's own row policy, already
 * proven for real by scripts/verify-setup.sh's own P1-06 T2 and by
 * query_events' own tools.integration.test.ts (P4-02) — what THIS file
 * needs to prove is `validateGrounding`'s own logic: that whatever rows
 * come back (or don't) are turned into the right pass/fail verdict.
 */
import { describe, expect, it } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Verdict } from '@sentinel/schema';
import { validateGrounding, formatGroundingErrors } from '../grounding.js';

function fakeClickHouseClient(rows: Array<{ event_id: string; time: string }>): ClickHouseClient {
  return {
    query: async () => ({ json: async () => rows }),
  } as unknown as ClickHouseClient;
}

function verdictWithEvidence(evidenceRef: string[]): Verdict {
  return {
    severity: 'high',
    title: 'Probe',
    claims: [{ text: 'A claim', evidenceRef }],
    attackChain: [],
    recommendedActions: [],
  };
}

const WINDOW = { start: '2026-01-01 00:00:00.000', end: '2026-01-02 00:00:00.000' };

describe('validateGrounding', () => {
  it('T1: a fully grounded report (every evidenceRef resolves, inside the window) passes', async () => {
    const ch = fakeClickHouseClient([{ event_id: 'evt_1', time: '2026-01-01 12:00:00.000' }]);
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdictWithEvidence(['evt_1']));
    expect(result.ok).toBe(true);
  });

  it('T2: a report with one fabricated event id fails entirely, not just that claim', async () => {
    const ch = fakeClickHouseClient([{ event_id: 'evt_1', time: '2026-01-01 12:00:00.000' }]);
    const verdict: Verdict = {
      severity: 'high',
      title: 'Probe',
      claims: [
        { text: 'A real claim', evidenceRef: ['evt_1'] },
        { text: 'A fabricated claim', evidenceRef: ['evt_does_not_exist'] },
      ],
      attackChain: [],
      recommendedActions: [],
    };
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ claimIndex: 1, eventId: 'evt_does_not_exist', reason: 'not_found' }]);
    }
  });

  it("T3: a real event id belonging to a DIFFERENT tenant is indistinguishable from fabricated — this function never learns it exists", async () => {
    // The fake client stands in for ClickHouse's own row policy already
    // having filtered the row out server-side (query_events' own
    // tools.integration.test.ts proves that filtering for real) — from
    // this function's point of view, "belongs to another tenant" and
    // "never existed" must produce the identical outcome, since any
    // difference would itself leak that the id exists somewhere.
    const ch = fakeClickHouseClient([]); // the other tenant's row never comes back
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdictWithEvidence(['evt_belongs_to_tenant_b']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.reason).toBe('not_found');
    }
  });

  it('T4: a real event outside the case window fails validation', async () => {
    const ch = fakeClickHouseClient([{ event_id: 'evt_1', time: '2026-01-05 00:00:00.000' }]); // after window.end
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdictWithEvidence(['evt_1']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ claimIndex: 0, eventId: 'evt_1', reason: 'outside_window' }]);
    }
  });

  it('an event exactly at windowStart is inside the window (inclusive lower bound)', async () => {
    const ch = fakeClickHouseClient([{ event_id: 'evt_1', time: '2026-01-01 00:00:00.000' }]);
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdictWithEvidence(['evt_1']));
    expect(result.ok).toBe(true);
  });

  it('a null windowEnd (still-open case) has no upper bound', async () => {
    const ch = fakeClickHouseClient([{ event_id: 'evt_1', time: '2027-06-01 00:00:00.000' }]);
    const result = await validateGrounding(ch, 'tenant-a', { start: WINDOW.start, end: null }, verdictWithEvidence(['evt_1']));
    expect(result.ok).toBe(true);
  });

  it('a verdict with no evidence at all trivially passes (nothing to resolve)', async () => {
    const ch = fakeClickHouseClient([]);
    const result = await validateGrounding(ch, 'tenant-a', WINDOW, verdictWithEvidence([]));
    expect(result.ok).toBe(true);
  });

  it('formatGroundingErrors produces a readable, per-claim message', () => {
    const message = formatGroundingErrors([{ claimIndex: 2, eventId: 'evt_x', reason: 'not_found' }]);
    expect(message).toContain('claim 2');
    expect(message).toContain('evt_x');
  });
});
