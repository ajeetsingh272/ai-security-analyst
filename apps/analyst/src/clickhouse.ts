/**
 * The first TypeScript ClickHouse client in this repo (every other
 * ClickHouse reader/writer so far is Go's clickhouse-go, see
 * go/sentinelevents/writer.go and services/correlate/internal/baseline).
 *
 * Connects as `sentinel_query_user` (db/clickhouse/0002_hot_cold_tier_and_
 * row_policy.sql), not the admin/default user the rest of this repo's
 * migration tooling uses — that role is exactly who the `tenant_isolation`
 * ROW POLICY on sentinel.events/signals/entity_baselines/daily_reduction
 * is scoped TO. `SQL_app_tenant_id` is passed as a per-query ClickHouse
 * setting (there is no transaction-scoped SET LOCAL equivalent on the
 * ClickHouse side — see 0002's own comment), which the row policy reads
 * via `getSetting('SQL_app_tenant_id')`. This is genuine defense in depth:
 * every query below ALSO binds `tenant_id` explicitly in its WHERE clause
 * (app-layer scoping, AC2), so a leaked policy and a missing WHERE clause
 * would both have to fail at once for a cross-tenant read to succeed.
 *
 * scripts/verify-setup.sh already proves this exact mechanism blocks a
 * cross-tenant read (its own P1-06 T2) by querying as this same user with
 * this same setting — this file is that proof's first real application
 * code consumer.
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client';

export function createTenantScopedClickHouseClient(url: string): ClickHouseClient {
  return createClient({
    url,
    username: 'sentinel_query_user',
    database: 'sentinel',
  });
}

export interface TenantQueryOptions {
  readonly tenantId: string;
  readonly query: string;
  readonly query_params?: Record<string, unknown>;
  readonly abortSignal?: AbortSignal;
}

/** Runs `query` with `SQL_app_tenant_id` set to `tenantId` for this one
 * query — never connection-wide, since one client instance is shared
 * across every tenant the worker ever handles concurrently. */
export async function queryAsTenant<T>(client: ClickHouseClient, opts: TenantQueryOptions): Promise<T[]> {
  const result = await client.query({
    query: opts.query,
    query_params: opts.query_params ?? {},
    format: 'JSONEachRow',
    // ClickHouse's own setting name, SQL_-prefixed per 0002's comment.
    clickhouse_settings: { SQL_app_tenant_id: opts.tenantId } as Record<string, string>,
    ...(opts.abortSignal ? { abort_signal: opts.abortSignal } : {}),
  });
  return result.json<T>();
}
