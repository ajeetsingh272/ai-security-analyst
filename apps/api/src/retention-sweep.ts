/**
 * P7-05 AC3/T3: per-plan retention enforcement on top of
 * db/clickhouse/0002_hot_cold_tier_and_row_policy.sql's own shared
 * 365-day table-level `TTL ... DELETE` ceiling. That TTL already
 * hard-deletes everything past 365 days for every tenant regardless of
 * plan; this sweep enforces each tenant's own, possibly SHORTER,
 * `retentionDays` (@sentinel/billing) by issuing a per-tenant
 * `ALTER TABLE ... DELETE` mutation with that tenant's own cutoff —
 * ClickHouse's TTL clause has no per-tenant granularity at all (it is
 * one expression for the whole table), so there is no way to express
 * "delete this one tenant's rows after 90 days" except as an explicit,
 * tenant-scoped mutation run on a schedule.
 *
 * Same hourly in-process `setInterval` shape as plan-usage-sweep.ts
 * (itself following weekly-report-scheduler.ts's own established
 * convention) — there is still no shared cron/scheduler infrastructure
 * anywhere in this repo to hook into instead.
 *
 * Runs on apps/api/src/clickhouse.ts's own createAdminClickHouseClient,
 * the one deliberate exception to "every ClickHouse query is
 * tenant-scoped": sentinel_query_user's row policy only grants SELECT,
 * and a mutation's own WHERE clause reaching across the `tenants` loop
 * (one tenant per iteration, never all at once) is itself the
 * tenant-scoping here — see that function's own doc comment for the
 * full ADR-0008 justification.
 */
import type { Pool } from 'pg';
import type { ClickHouseClient } from '@clickhouse/client';
import { LlmUsageRepository, listActiveTenantIds, withTenantContext } from '@sentinel/db';
import { limitsFor } from '@sentinel/billing';
import type { SweepLogger } from './plan-usage-sweep.js';

export async function runRetentionSweep(pool: Pool, clickhouse: ClickHouseClient, logger: SweepLogger): Promise<void> {
  const tenantIds = await listActiveTenantIds(pool);

  for (const tenantId of tenantIds) {
    try {
      const plan = await withTenantContext(tenantId, async () => new LlmUsageRepository(pool).planTier());
      const retentionDays = limitsFor(plan).retentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // mutations_sync=1: this sweep is a background job on its own
      // hourly interval, not a hot path — waiting for the mutation to
      // actually finish before moving to the next tenant is the
      // correct trade-off here, and is what makes T3's own "run the
      // sweep, then assert count() dropped to 0" verification possible
      // without a separate polling loop.
      await clickhouse.command({
        query: `ALTER TABLE sentinel.events DELETE WHERE tenant_id = {tenantId:UUID} AND time < {cutoff:DateTime64}`,
        // ClickHouse's DateTime64 query-parameter parser wants
        // 'YYYY-MM-DD HH:MM:SS.mmm' (no 'T', no trailing 'Z') — the
        // same conversion every seed helper in this repo's own
        // ClickHouse integration tests already applies to Date.toISOString().
        query_params: { tenantId, cutoff: cutoff.toISOString().replace('T', ' ').replace('Z', '') },
        clickhouse_settings: { mutations_sync: '1' },
      });

      logger.info({ tenant_id: tenantId, plan, retention_days: retentionDays, cutoff: cutoff.toISOString() }, 'enforced tenant retention');
    } catch (err) {
      logger.error({ tenant_id: tenantId, err: err instanceof Error ? err.message : String(err) }, 'retention sweep failed for tenant');
    }
  }
}

export function startRetentionSweep(pool: Pool, clickhouse: ClickHouseClient, logger: SweepLogger, intervalMs = 60 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    runRetentionSweep(pool, clickhouse, logger).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'retention sweep failed'),
    );
  }, intervalMs);
  return () => clearInterval(timer);
}
