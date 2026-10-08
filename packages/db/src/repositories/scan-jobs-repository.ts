/**
 * P6-05: the free 7-day security scan's own persisted record. See
 * 0024_scan_jobs.sql's own doc comment for why this is persisted at
 * all (a stable, forwardable report) and for the honest disclosure
 * that creating a row here does not itself trigger go/sentinelreplay's
 * historical re-ingestion — that trigger is a disclosed, out-of-scope
 * gap, not something this class pretends to do.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export interface ScanJobRow {
  id: string;
  tenantId: string;
  status: 'running' | 'completed' | 'failed';
  windowStart: string;
  windowEnd: string;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

function mapRow(row: Record<string, unknown>): ScanJobRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    status: row['status'] as ScanJobRow['status'],
    windowStart: new Date(row['window_start'] as string | Date).toISOString(),
    windowEnd: new Date(row['window_end'] as string | Date).toISOString(),
    createdBy: String(row['created_by']),
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
    completedAt: row['completed_at'] == null ? null : new Date(row['completed_at'] as string | Date).toISOString(),
    error: (row['error'] as string | null) ?? null,
  };
}

export class ScanJobsRepository extends TenantScopedRepository {
  /** `windowEnd` is normally "now" and `windowStart` "now minus 7
   * days" — passed in rather than computed here so a test can assert
   * against a fixed, known window instead of racing the clock. */
  async create(windowStart: Date, windowEnd: Date, createdBy: string): Promise<ScanJobRow> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO scan_jobs (tenant_id, window_start, window_end, created_by, status, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', now())
         RETURNING id, tenant_id, status, window_start, window_end, created_by, created_at, completed_at, error`,
        [this.tenantId, windowStart, windowEnd, createdBy],
      );
      return mapRow(rows[0]!);
    });
  }

  async findById(id: string): Promise<ScanJobRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, status, window_start, window_end, created_by, created_at, completed_at, error
         FROM scan_jobs WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
