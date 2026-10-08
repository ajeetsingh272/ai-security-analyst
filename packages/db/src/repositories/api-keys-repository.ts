/**
 * P6-09: the public API's own auth mechanism (0026_api_keys.sql).
 * `findApiKeyByHash`/`touchApiKeyLastUsed` are standalone, NOT
 * `TenantScopedRepository` methods — same precedent as
 * `listTenantsDueForWeeklyReport` (weekly-report-repository.ts): the
 * whole point of looking a key up by its hash is to discover which
 * tenant it belongs to, so that lookup necessarily runs BEFORE any
 * tenant context exists to scope it by. Every other operation here
 * (create/list/revoke, once a tenant's own dashboard session is
 * managing its own keys) goes through the normal tenant-scoped path.
 */
import type { Pool } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';

export type ApiKeyScope = 'read' | 'write';

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

function mapRow(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    name: String(row['name']),
    keyPrefix: String(row['key_prefix']),
    scopes: row['scopes'] as ApiKeyScope[],
    createdBy: String(row['created_by']),
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
    lastUsedAt: row['last_used_at'] == null ? null : new Date(row['last_used_at'] as string | Date).toISOString(),
    revokedAt: row['revoked_at'] == null ? null : new Date(row['revoked_at'] as string | Date).toISOString(),
    revokedBy: (row['revoked_by'] as string | null) ?? null,
  };
}

const SELECT_COLUMNS = 'id, tenant_id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at, revoked_by';

export interface CreateApiKeyInput {
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  createdBy: string;
}

export class ApiKeysRepository extends TenantScopedRepository {
  async create(input: CreateApiKeyInput): Promise<ApiKeyRow> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SELECT_COLUMNS}`,
        [this.tenantId, input.name, input.keyPrefix, input.keyHash, input.scopes, input.createdBy],
      );
      return mapRow(rows[0]);
    });
  }

  async listActive(): Promise<ApiKeyRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
      );
      return rows.map(mapRow);
    });
  }

  async revoke(id: string, revokedBy: string): Promise<ApiKeyRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SELECT_COLUMNS}`,
        [id, revokedBy],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}

/**
 * The pre-tenant-context lookup that bootstraps everything else: given
 * a raw API key's SHA-256 hash, find which tenant (if any) it belongs
 * to, and whether it's still live. A plain `pool.query` with no `SET
 * LOCAL ROLE sentinel_app` — see this file's own doc comment for why
 * that's the correct, established pattern here, not a shortcut around
 * RLS. Returns `null` for an unknown OR revoked key; the caller (P6-09
 * T4) must reject both identically and immediately, not distinguish
 * them in the response (that would let an attacker learn whether a
 * guessed key ever existed).
 */
export async function findApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKeyRow | null> {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Fire-and-forget bookkeeping, not part of the request's own success
 * path — a failed update here must never fail the request it's
 * attached to. Also a plain `pool.query`: the tenant context for THIS
 * particular request is already known by the time this runs, but a
 * dedicated tenant-scoped repository instance for a single UPDATE by
 * primary key (already uniquely identifying the row) would add
 * transaction overhead for no additional safety. */
export async function touchApiKeyLastUsed(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
}

/**
 * Maps a key's own (read/write) scopes onto the dashboard's existing
 * ascending Role scale, so every existing `requireRole(...)` check and
 * `TenantScopedRepository` call works unmodified for an API-key-
 * authenticated request — no parallel permission system to keep in
 * sync. 'write' maps to 'analyst' (the same bar every existing
 * mutating route already sets for a human user), not 'admin': a public
 * API key is deliberately capped below tenant/user management
 * regardless of its own scopes. Typed as the two specific literals it
 * can ever return (not the apps/api `Role` type itself — @sentinel/db
 * has no dependency on apps/api, same "separate deployables" reasoning
 * as every wire-contract type apps/dashboard duplicates rather than
 * imports); both literals are members of that type, so callers can
 * assign the result directly into a `Role`-typed field.
 */
export function apiKeyScopesToRole(scopes: ApiKeyScope[]): 'read_only' | 'analyst' {
  return scopes.includes('write') ? 'analyst' : 'read_only';
}
