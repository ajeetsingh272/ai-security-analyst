/**
 * Read side of the connectors table for P1-11 ("Ingest observability —
 * lag, EPS and connector health", AC4: "Connector health is visible through
 * the API for the dashboard to render"). The write side — status/
 * last_error/last_sync_at — is go/sentinelconnector's HealthRecorder
 * (P1-01, extended by P1-11); this repository only reads what that
 * scheduler already writes.
 *
 * Same RLS-reliant pattern as CasesRepository: no WHERE tenant_id clause,
 * the current tenant's isolation comes entirely from TenantScopedRepository's
 * `SET LOCAL app.tenant_id`.
 */
import { TenantScopedRepository } from '../tenant-context.js';

/** The connectors table's own status enum (0001_foundation.sql's check
 * constraint) — what go/sentinelconnector's HealthRecorder actually writes. */
export type ConnectorDbStatus = 'pending' | 'healthy' | 'degraded' | 'revoked' | 'error';

/** The simplified, external health vocabulary this API exposes: a revoked
 * or otherwise-failing connector is reported as "degraded" to the dashboard
 * (P1-11 T3) — the raw DB status (e.g. "revoked") is still available in
 * `reason` for anything that wants the finer-grained detail, but the
 * primary `status` field intentionally does not grow a case for every DB
 * enum value the dashboard would then have to special-case. */
export type ConnectorApiStatus = 'pending' | 'healthy' | 'degraded';

export interface ConnectorHealth {
  id: string;
  kind: string;
  status: ConnectorApiStatus;
  /** The raw DB status when it differs from `status` (e.g. "revoked"),
   * null when status is already the full story (healthy/pending). */
  reason: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  /** Seconds since the last successful cycle, or since the connector was
   * created if it has never had one — mirrors go/sentinelconnector's
   * computeLag exactly, so the API and the OTel gauge never disagree about
   * what "lag" means for a connector that has never produced events. */
  lagSeconds: number;
}

function toApiStatus(dbStatus: ConnectorDbStatus): ConnectorApiStatus {
  if (dbStatus === 'pending' || dbStatus === 'healthy') return dbStatus;
  return 'degraded';
}

function computeLagSeconds(now: Date, createdAt: Date, lastSyncAt: Date | null): number {
  const baseline = lastSyncAt ?? createdAt;
  return Math.max(0, Math.floor((now.getTime() - baseline.getTime()) / 1000));
}

interface ConnectorRow {
  id: string;
  kind: string;
  status: ConnectorDbStatus;
  last_error: string | null;
  last_sync_at: string | null;
  created_at: string;
}

function mapRow(row: ConnectorRow, now: Date): ConnectorHealth {
  const dbStatus = row.status;
  const lastSyncAt = row.last_sync_at ? new Date(row.last_sync_at) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: toApiStatus(dbStatus),
    reason: dbStatus === toApiStatus(dbStatus) ? null : dbStatus,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at,
    lagSeconds: computeLagSeconds(now, new Date(row.created_at), lastSyncAt),
  };
}

export class ConnectorsRepository extends TenantScopedRepository {
  async findHealth(): Promise<ConnectorHealth[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        'SELECT id, kind, status, last_error, last_sync_at, created_at FROM connectors ORDER BY created_at ASC',
      );
      const now = new Date();
      return rows.map((row) => mapRow(row, now));
    });
  }

  /** P5-05: the encrypted credentials blob for this tenant's connector
   * of the given kind, still healthy — null for "never connected,"
   * "revoked," or anything else not currently usable. Decrypting it is
   * TenantCredentialVault's own job (this repository has no KMS
   * dependency), the same read/decrypt split m365-connector.ts's own
   * callback handler already uses. */
  async getHealthyCredentials(kind: string): Promise<Buffer | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ credentials: Buffer | null }>(
        `SELECT credentials FROM connectors WHERE kind = $1 AND status = 'healthy'`,
        [kind],
      );
      return rows[0]?.credentials ?? null;
    });
  }
}
