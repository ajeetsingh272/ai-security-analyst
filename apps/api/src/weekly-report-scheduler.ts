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
import { listTenantsDueForWeeklyReport, withTenantContext, WeeklyReportRepository } from '@sentinel/db';
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

export async function runWeeklyReportSweep(pool: Pool, resendConfig: ResendConfig | undefined, logger: SchedulerLogger): Promise<void> {
  const today = new Date().getUTCDay();
  const dueTenantIds = await listTenantsDueForWeeklyReport(pool, today);

  for (const tenantId of dueTenantIds) {
    try {
      if (await hasAlreadySentToday(pool, tenantId)) continue;
      const report = await generateWeeklyReport(pool, tenantId, new Date());
      if (resendConfig) await sendWeeklyReportEmail(pool, resendConfig, tenantId, report);
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
