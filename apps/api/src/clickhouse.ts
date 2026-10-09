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

/**
 * P7-05: the one deliberate exception to "every ClickHouse query is
 * tenant-scoped" — a retention sweep that must delete past a
 * PER-TENANT cutoff across every tenant, and a storage-cost estimate
 * that reads `system.parts` (which has no tenant_id column at all,
 * since one physical part can hold many tenants' rows), both need a
 * connection with no row policy applied. Connects as ClickHouse's own
 * `default` user — this dev stack's CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1
 * env var is what makes that user exist with full rights out of the
 * box; nothing else in this codebase creates a second admin identity.
 * Mirrors the exact "privileged role for a background job that
 * legitimately spans tenants" exception ADR-0008's own risk table
 * names for Postgres's platform-wide reads (registerXXXConnectors,
 * findTenantByApiKeyHash) — the identical justification, the Go side's
 * own precedent, applied here to ClickHouse.
 */
export function createAdminClickHouseClient(url: string): ClickHouseClient {
  return createClient({ url, username: 'default', database: 'sentinel' });
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
