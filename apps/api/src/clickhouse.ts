/**
 * P6-03: apps/api's own tenant-scoped ClickHouse reader, for resolving a
 * claim's `evidenceRef` (@sentinel/schema) back to the real raw events
 * that prove it — the literal mechanism behind TG1 ("AI output is never
 * unsourced") made visible in the dashboard.
 *
 * Deliberately NOT imported from apps/analyst/src/clickhouse.ts, which
 * has the identical shape — apps/api and apps/analyst are two separately
 * deployable processes with no dependency between them (same reasoning
 * as apps/dashboard/src/lib/session.ts's own doc comment for why it
 * duplicates apps/api's Role type rather than importing it). The
 * security property this exists for — `SQL_app_tenant_id` plus an
 * explicit `tenant_id` in every query's own WHERE clause, so a leaked
 * row policy and a missing filter would both have to fail at once — is
 * copied exactly, not reinvented.
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
}

export async function queryAsTenant<T>(client: ClickHouseClient, opts: TenantQueryOptions): Promise<T[]> {
  const result = await client.query({
    query: opts.query,
    query_params: opts.query_params ?? {},
    format: 'JSONEachRow',
    clickhouse_settings: { SQL_app_tenant_id: opts.tenantId } as Record<string, string>,
  });
  return result.json<T>();
}
