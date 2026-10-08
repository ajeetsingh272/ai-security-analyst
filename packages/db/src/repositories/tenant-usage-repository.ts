/**
 * P6-10: per-tenant seat and event-volume metering, and the durable
 * plan-limit status apps/api's plan-usage-sweep.ts writes and
 * weekly-report-scheduler.ts reads (0027_tenant_plan_status.sql).
 *
 * "Event volume" is metered against `case_signals` — a real, already
 * tenant-scoped Postgres table — not true raw ingested-event counts,
 * which live only in ClickHouse (`sentinel.events`), unavailable in
 * this sandbox. This is a disclosed proxy, not a silent approximation:
 * it undercounts by whatever the detection pipeline's own
 * signal-to-event reduction ratio is, the same ratio
 * `services/correlate/internal/reduction` already tracks for its own
 * `daily_reduction` metric in production.
 */
import type { Pool } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';

export type PlanLimitStatus = 'ok' | 'soft_exceeded' | 'hard_exceeded';

export interface TenantPlanStatusRow {
  tenantId: string;
  seatsStatus: PlanLimitStatus;
  eventVolumeStatus: PlanLimitStatus;
  costStatus: PlanLimitStatus;
  evaluatedAt: string;
  softNotifiedAt: string | null;
}

function mapStatusRow(row: Record<string, unknown>): TenantPlanStatusRow {
  return {
    tenantId: String(row['tenant_id']),
    seatsStatus: row['seats_status'] as PlanLimitStatus,
    eventVolumeStatus: row['event_volume_status'] as PlanLimitStatus,
    costStatus: row['cost_status'] as PlanLimitStatus,
    evaluatedAt: new Date(row['evaluated_at'] as string | Date).toISOString(),
    softNotifiedAt: row['soft_notified_at'] == null ? null : new Date(row['soft_notified_at'] as string | Date).toISOString(),
  };
}

export interface UpsertPlanStatusInput {
  seatsStatus: PlanLimitStatus;
  eventVolumeStatus: PlanLimitStatus;
  costStatus: PlanLimitStatus;
  /** Set only when this call is ALSO recording a notification having
   * just been sent for the current bad streak — omitted (left as
   * whatever it already was) on every other evaluation, which is what
   * keeps a tenant that stays exceeded for days from being re-notified
   * every single sweep. */
  markSoftNotified?: boolean;
  /** Set when this tenant is back to fully 'ok' on every axis — clears
   * `soft_notified_at` so a FUTURE escalation (after returning to ok)
   * notifies again, rather than staying permanently silenced by a
   * notification sent for a now-resolved, unrelated earlier breach. */
  resetNotified?: boolean;
}

export class TenantUsageRepository extends TenantScopedRepository {
  /** `memberships` has no "seat" concept distinct from a row — one
   * membership is one seat, by definition. */
  async countSeats(): Promise<number> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ count: string }>('SELECT count(*) AS count FROM memberships');
      return Number(rows[0]?.count ?? 0);
    });
  }

  async countEventVolumeSince(since: Date): Promise<number> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM case_signals WHERE detected_at >= $1',
        [since.toISOString()],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async getStatus(): Promise<TenantPlanStatusRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT tenant_id, seats_status, event_volume_status, cost_status, evaluated_at, soft_notified_at
           FROM tenant_plan_status WHERE tenant_id = $1`,
        [this.tenantId],
      );
      return rows.length > 0 ? mapStatusRow(rows[0]) : null;
    });
  }

  async upsertStatus(input: UpsertPlanStatusInput): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO tenant_plan_status (tenant_id, seats_status, event_volume_status, cost_status, evaluated_at, soft_notified_at)
         VALUES ($1, $2, $3, $4, now(), CASE WHEN $5 THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id) DO UPDATE SET
           seats_status = EXCLUDED.seats_status,
           event_volume_status = EXCLUDED.event_volume_status,
           cost_status = EXCLUDED.cost_status,
           evaluated_at = now(),
           soft_notified_at = CASE
             WHEN $5 THEN now()
             WHEN $6 THEN NULL
             ELSE tenant_plan_status.soft_notified_at
           END`,
        [this.tenantId, input.seatsStatus, input.eventVolumeStatus, input.costStatus, input.markSoftNotified ?? false, input.resetNotified ?? false],
      );
    });
  }
}

export interface TenantUsageSummary {
  tenantId: string;
  name: string;
  plan: string;
  seatCount: number;
  eventVolume: number;
  costUsd: number;
  seatsStatus: PlanLimitStatus;
  eventVolumeStatus: PlanLimitStatus;
  costStatus: PlanLimitStatus;
}

/**
 * The operations margin view's own cross-tenant read — deliberately a
 * plain `pool.query`, not a `TenantScopedRepository` method, mirroring
 * `listTenantsWithPendingDegradedCases`/`listTenantsDueForWeeklyReport`'s
 * own established pattern: a platform-wide view that spans every
 * tenant by its very nature goes through the pool's own default
 * connection, never a single tenant's RLS-scoped context. Computed
 * live, on every call — a tenant's own usage counts and the sweep's
 * last-evaluated status can be read together without requiring the
 * sweep to have just run, so the view is never stale.
 */
export async function listTenantUsageSummaries(pool: Pool): Promise<TenantUsageSummary[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    name: string;
    plan: string;
    seat_count: string;
    event_volume: string;
    cost_usd: string | null;
    seats_status: PlanLimitStatus | null;
    event_volume_status: PlanLimitStatus | null;
    cost_status: PlanLimitStatus | null;
  }>(`
    SELECT
      t.id AS tenant_id, t.name, t.plan,
      COALESCE(m.seat_count, 0) AS seat_count,
      COALESCE(s.event_volume, 0) AS event_volume,
      COALESCE(l.cost_usd, 0) AS cost_usd,
      p.seats_status, p.event_volume_status, p.cost_status
    FROM tenants t
    LEFT JOIN (SELECT tenant_id, count(*) AS seat_count FROM memberships GROUP BY tenant_id) m ON m.tenant_id = t.id
    LEFT JOIN (SELECT tenant_id, count(*) AS event_volume FROM case_signals WHERE detected_at >= now() - INTERVAL '1 day' GROUP BY tenant_id) s ON s.tenant_id = t.id
    LEFT JOIN (SELECT tenant_id, sum(cost_usd) AS cost_usd FROM llm_usage WHERE recorded_at >= now() - INTERVAL '1 day' GROUP BY tenant_id) l ON l.tenant_id = t.id
    LEFT JOIN tenant_plan_status p ON p.tenant_id = t.id
    ORDER BY t.name
  `);

  return rows.map((row) => ({
    tenantId: row.tenant_id,
    name: row.name,
    plan: row.plan,
    seatCount: Number(row.seat_count),
    eventVolume: Number(row.event_volume),
    costUsd: Number(row.cost_usd ?? 0),
    seatsStatus: row.seats_status ?? 'ok',
    eventVolumeStatus: row.event_volume_status ?? 'ok',
    costStatus: row.cost_status ?? 'ok',
  }));
}

/** The sweep's own cross-tenant read — same pattern as
 * `listTenantUsageSummaries` above, limited to active tenants since a
 * suspended/churned tenant's usage is not evaluated going forward. */
export async function listActiveTenantIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active'`);
  return rows.map((r) => r.id);
}
