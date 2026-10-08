/**
 * P6-07 AC1: "generated weekly per tenant on a configurable schedule."
 * Same in-process `setInterval` shape apps/analyst/src/main.ts already
 * uses for its own daily sweeps (the retention purge, the dismissal
 * digest) — there is no shared cron/scheduler infrastructure anywhere
 * in this codebase to hook into; this follows that established
 * convention rather than inventing a new one.
 *
 * Runs hourly, not daily, specifically SO a tenant's own configured
 * day can be checked promptly after a restart or a schedule change,
 * rather than only once every 24h at whatever moment the process
 * happened to start — "hasAlreadySentToday" is what keeps that hourly
 * cadence from sending twice in the same day.
 */
import type { Pool } from 'pg';
import { listTenantsDueForWeeklyReport, withTenantContext, WeeklyReportRepository, TenantUsageRepository } from '@sentinel/db';
import { worstStatus } from '@sentinel/billing';
import { generateWeeklyReport } from './weekly-report.js';
import { sendWeeklyReportEmail, type ResendConfig } from './weekly-report-email.js';

export interface SchedulerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

const ALREADY_SENT_WINDOW_MS = 20 * 60 * 60 * 1000; // 20h — see this file's own doc comment

async function hasAlreadySentToday(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenantContext(tenantId, async () => {
    const [latest] = await new WeeklyReportRepository(pool).listForTenant(1);
    if (!latest) return false;
    return Date.now() - new Date(latest.generatedAt).getTime() < ALREADY_SENT_WINDOW_MS;
  });
}

/**
 * P6-10's chosen degradation point: a tenant hard-exceeding its plan
 * limits (seats, event volume, or LLM cost — see plan-usage-sweep.ts,
 * which is what actually evaluates and records this) has its weekly
 * report EMAIL paused — the report itself still generates and remains
 * visible on the dashboard. A deliberately narrow, honest MVP scope:
 * this only pauses a non-essential delivery channel, never detection
 * or the dashboard itself, which this file has no reach into anyway.
 */
async function isHardExceeded(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenantContext(tenantId, async () => {
    const status = await new TenantUsageRepository(pool).getStatus();
    if (!status) return false;
    return worstStatus(status.seatsStatus, status.eventVolumeStatus, status.costStatus) === 'hard_exceeded';
  });
}

export async function runWeeklyReportSweep(pool: Pool, resendConfig: ResendConfig | undefined, logger: SchedulerLogger): Promise<void> {
  const today = new Date().getUTCDay();
  const dueTenantIds = await listTenantsDueForWeeklyReport(pool, today);

  for (const tenantId of dueTenantIds) {
    try {
      if (await hasAlreadySentToday(pool, tenantId)) continue;
      const report = await generateWeeklyReport(pool, tenantId, new Date());
      const hardExceeded = await isHardExceeded(pool, tenantId);
      if (resendConfig && !hardExceeded) {
        await sendWeeklyReportEmail(pool, resendConfig, tenantId, report);
      } else if (hardExceeded) {
        logger.info({ tenantId, reportId: report.id }, 'weekly report email paused — tenant is over its plan limit');
      }
      logger.info({ tenantId, reportId: report.id }, 'generated scheduled weekly report');
    } catch (err) {
      logger.error({ tenantId, err: err instanceof Error ? err.message : String(err) }, 'scheduled weekly report generation failed');
    }
  }
}

export function startWeeklyReportScheduler(pool: Pool, resendConfig: ResendConfig | undefined, logger: SchedulerLogger, intervalMs = 60 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    runWeeklyReportSweep(pool, resendConfig, logger).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'weekly report sweep failed'),
    );
  }, intervalMs);
  return () => clearInterval(timer);
}
