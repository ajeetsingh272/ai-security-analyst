/**
 * P6-07: the weekly owner report's own persistence — a generated
 * report (fixed window, same "a forwarded link stays stable" reasoning
 * as 0024_scan_jobs.sql) and a per-tenant schedule setting.
 */
import type { Pool } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';

export interface WeeklyReportRow {
  id: string;
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  headline: string;
  oneImprovement: string | null;
  isQuiet: boolean;
  data: unknown;
  generatedAt: string;
  emailedAt: string | null;
}

function mapRow(row: Record<string, unknown>): WeeklyReportRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    windowStart: new Date(row['window_start'] as string | Date).toISOString(),
    windowEnd: new Date(row['window_end'] as string | Date).toISOString(),
    headline: String(row['headline']),
    oneImprovement: (row['one_improvement'] as string | null) ?? null,
    isQuiet: Boolean(row['is_quiet']),
    data: row['data'],
    generatedAt: new Date(row['generated_at'] as string | Date).toISOString(),
    emailedAt: row['emailed_at'] == null ? null : new Date(row['emailed_at'] as string | Date).toISOString(),
  };
}

export interface CreateWeeklyReportInput {
  windowStart: Date;
  windowEnd: Date;
  headline: string;
  oneImprovement: string | null;
  isQuiet: boolean;
  data: unknown;
}

export class WeeklyReportRepository extends TenantScopedRepository {
  async create(input: CreateWeeklyReportInput): Promise<WeeklyReportRow> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO weekly_reports (tenant_id, window_start, window_end, headline, one_improvement, is_quiet, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, window_start, window_end, headline, one_improvement, is_quiet, data, generated_at, emailed_at`,
        [this.tenantId, input.windowStart, input.windowEnd, input.headline, input.oneImprovement, input.isQuiet, JSON.stringify(input.data)],
      );
      return mapRow(rows[0]!);
    });
  }

  async findById(id: string): Promise<WeeklyReportRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, window_start, window_end, headline, one_improvement, is_quiet, data, generated_at, emailed_at
         FROM weekly_reports WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async listForTenant(limit: number): Promise<WeeklyReportRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, window_start, window_end, headline, one_improvement, is_quiet, data, generated_at, emailed_at
         FROM weekly_reports ORDER BY generated_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(mapRow);
    });
  }

  async markEmailed(id: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query('UPDATE weekly_reports SET emailed_at = now() WHERE id = $1', [id]);
    });
  }
}

export interface ReportSchedule {
  dayOfWeek: number;
  enabled: boolean;
}

const DEFAULT_SCHEDULE: ReportSchedule = { dayOfWeek: 1, enabled: true }; // Monday

export class ReportScheduleRepository extends TenantScopedRepository {
  /** Defaulted rather than requiring a row to already exist — most
   * tenants will never touch this setting, and "no row yet" and
   * "explicitly set to the default" must behave identically. */
  async get(): Promise<ReportSchedule> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ day_of_week: number; enabled: boolean }>(
        'SELECT day_of_week, enabled FROM tenant_report_schedule WHERE tenant_id = $1',
        [this.tenantId],
      );
      return rows[0] ? { dayOfWeek: rows[0].day_of_week, enabled: rows[0].enabled } : DEFAULT_SCHEDULE;
    });
  }

  async upsert(schedule: ReportSchedule): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO tenant_report_schedule (tenant_id, day_of_week, enabled, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id) DO UPDATE SET day_of_week = EXCLUDED.day_of_week, enabled = EXCLUDED.enabled, updated_at = now()`,
        [this.tenantId, schedule.dayOfWeek, schedule.enabled],
      );
    });
  }
}

/**
 * The scheduler's own cross-tenant read — deliberately a plain
 * `pool.query`, not a `TenantScopedRepository` method, mirroring
 * `listTenantsWithPendingDegradedCases`'s own established pattern
 * (degraded-queue-repository.ts): a platform-wide sweep that applies
 * identically to every tenant goes through the pool's own default
 * connection, never `sentinel_app`'s per-tenant RLS-scoped role. A
 * tenant with no `tenant_report_schedule` row yet still gets its
 * default (Monday, enabled) applied via COALESCE, not silently
 * skipped.
 */
export async function listTenantsDueForWeeklyReport(pool: Pool, dayOfWeek: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       LEFT JOIN tenant_report_schedule s ON s.tenant_id = t.id
      WHERE COALESCE(s.day_of_week, $2) = $1 AND COALESCE(s.enabled, true) = true`,
    [dayOfWeek, DEFAULT_SCHEDULE.dayOfWeek],
  );
  return rows.map((r) => r.id);
}
