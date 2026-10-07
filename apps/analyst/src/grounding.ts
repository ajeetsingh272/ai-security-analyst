/**
 * The evidence grounding validator (P4-04, TG1) — "the mechanism the
 * entire product promise rests on," per the ticket's own description.
 * Deterministic code, never a model self-check: every `evidenceRef` id
 * a Verdict's claims cite is re-queried against `sentinel.events`
 * (ClickHouse), scoped to the case's own tenant via the SAME
 * `sentinel_query_user` + `SQL_app_tenant_id` row-policy mechanism
 * query_events (P4-02) already uses — a fabricated id and a REAL id
 * belonging to a different tenant produce the identical "not found"
 * outcome here, which is the correct behaviour: this code must never
 * even hint that a cross-tenant id exists.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import type { Verdict } from '@sentinel/schema';
import { queryAsTenant } from './clickhouse.js';

export interface CaseWindow {
  readonly start: string;
  /** null for a case still open/accumulating — AC2's "falls within the
   * case time window" has no reasonable upper bound to enforce yet, so
   * only the lower bound (windowStart) is checked in that case; using
   * "now" instead would make the check flaky against clock skew. */
  readonly end: string | null;
}

export type GroundingFailureReason = 'not_found' | 'outside_window';

export interface GroundingError {
  readonly claimIndex: number;
  readonly eventId: string;
  readonly reason: GroundingFailureReason;
}

export type GroundingResult = { ok: true } | { ok: false; errors: GroundingError[] };

interface EventRow {
  event_id: string;
  time: string;
}

/** AC1/AC2/AC3: resolves every evidenceRef against ClickHouse, scoped to
 * the tenant, checks each resolved event's time against the case
 * window, and returns every failure found — not just the first — so a
 * single repair prompt can list the whole problem at once. */
export async function validateGrounding(ch: ClickHouseClient, tenantId: string, window: CaseWindow, verdict: Verdict): Promise<GroundingResult> {
  const allIds = Array.from(new Set(verdict.claims.flatMap((c) => c.evidenceRef)));
  if (allIds.length === 0) return { ok: true };

  const rows = await queryAsTenant<EventRow>(ch, {
    tenantId,
    query: `SELECT event_id, time FROM sentinel.events WHERE tenant_id = {tenantId:UUID} AND event_id IN ({ids:Array(String)})`,
    query_params: { tenantId, ids: allIds },
  });
  const byId = new Map(rows.map((r) => [r.event_id, r.time]));

  const windowStart = new Date(window.start).getTime();
  const windowEnd = window.end ? new Date(window.end).getTime() : null;

  const errors: GroundingError[] = [];
  verdict.claims.forEach((claim, claimIndex) => {
    for (const eventId of claim.evidenceRef) {
      const time = byId.get(eventId);
      if (time === undefined) {
        errors.push({ claimIndex, eventId, reason: 'not_found' });
        continue;
      }
      // ClickHouse's own DateTime64 text form ('YYYY-MM-DD HH:MM:SS.sss')
      // parses fine via Date — no 'T'/'Z' round-trip needed here since
      // this value never goes back INTO a ClickHouse query parameter.
      const eventTime = new Date(time.replace(' ', 'T') + 'Z').getTime();
      if (eventTime < windowStart || (windowEnd !== null && eventTime > windowEnd)) {
        errors.push({ claimIndex, eventId, reason: 'outside_window' });
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

export function formatGroundingErrors(errors: readonly GroundingError[]): string {
  return errors
    .map((e) => `claim ${e.claimIndex}'s evidenceRef "${e.eventId}" ${e.reason === 'not_found' ? 'does not resolve to a real event for this case' : 'resolves to an event outside this case\'s time window'}`)
    .join('; ');
}
