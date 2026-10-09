/**
 * P7-05 AC5: "storage cost per tenant is measured against the cost
 * model." ClickHouse has no per-tenant byte accounting at all — a
 * physical part (system.parts) can, and in this schema's
 * PARTITION BY toYYYYMMDD(time) scheme routinely does, hold many
 * tenants' rows mixed together, so there is no column to sum bytes
 * from per tenant directly. This measures it the same way P6-10's own
 * event-volume metering already handles an analogous gap (disclosed as
 * a proxy, never presented as exact billing-grade metering): a
 * PROPORTIONAL ALLOCATION — a tenant's own share of a tier's total row
 * count, applied to that tier's own total compressed bytes
 * (system.parts, which IS exact — just not per-tenant).
 *
 * The hot/cold split uses the identical 90-day boundary
 * db/clickhouse/0002_hot_cold_tier_and_row_policy.sql's own TTL clause
 * uses (`TO VOLUME 'cold'` at 90 days) — not a second, independently
 * chosen threshold that could silently drift from the real one.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { computeStorageCostUsd, type StorageCost } from '@sentinel/billing';

interface DiskBytesRow {
  disk_name: string;
  bytes: string; // ClickHouse returns UInt64 as a string over JSONEachRow — see TierRowCountRow's own identical note
}

interface TierRowCountRow {
  hot: string;
  cold: string;
}

async function tierCompressedBytes(clickhouse: ClickHouseClient): Promise<{ hot: number; cold: number }> {
  const result = await clickhouse.query({
    query: `SELECT disk_name, sum(data_compressed_bytes) AS bytes
            FROM system.parts
            WHERE database = 'sentinel' AND table = 'events' AND active
            GROUP BY disk_name`,
    format: 'JSONEachRow',
  });
  const rows = await result.json<DiskBytesRow>();
  const byDisk = new Map(rows.map((r) => [r.disk_name, Number(r.bytes)]));
  // 'default' is the disk name infra/docker/clickhouse-storage.xml's own
  // hot_cold policy gives the local volume (its own <volumes><default> entry) —
  // ClickHouse's own convention, not a name this codebase chose.
  return { hot: byDisk.get('default') ?? 0, cold: byDisk.get('cold') ?? 0 };
}

async function tierRowCounts(clickhouse: ClickHouseClient, tenantId?: string): Promise<{ hot: number; cold: number }> {
  const whereTenant = tenantId ? 'WHERE tenant_id = {tenantId:UUID}' : '';
  const result = await clickhouse.query({
    query: `SELECT
              countIf(time >= now() - INTERVAL 90 DAY) AS hot,
              countIf(time < now() - INTERVAL 90 DAY) AS cold
            FROM sentinel.events
            ${whereTenant}`,
    query_params: tenantId ? { tenantId } : {},
    format: 'JSONEachRow',
  });
  const rows = await result.json<TierRowCountRow>();
  const row = rows[0];
  return { hot: Number(row?.hot ?? 0), cold: Number(row?.cold ?? 0) };
}

/** One tenant's own estimated storage cost — see this file's own doc
 * comment for the proportional-allocation method and its disclosed
 * limits. */
export async function measureTenantStorageCost(adminClickHouse: ClickHouseClient, tenantId: string): Promise<StorageCost> {
  const [tierBytes, totalRows, tenantRows] = await Promise.all([
    tierCompressedBytes(adminClickHouse),
    tierRowCounts(adminClickHouse),
    tierRowCounts(adminClickHouse, tenantId),
  ]);

  const hotBytes = totalRows.hot > 0 ? (tenantRows.hot / totalRows.hot) * tierBytes.hot : 0;
  const coldBytes = totalRows.cold > 0 ? (tenantRows.cold / totalRows.cold) * tierBytes.cold : 0;
  return computeStorageCostUsd(hotBytes, coldBytes);
}
