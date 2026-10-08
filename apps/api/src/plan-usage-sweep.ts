/**
 * P6-10: evaluates every active tenant's own seat count, event
 * volume, and today's LLM spend against its plan's limits
 * (@sentinel/billing), persists the result (0027_tenant_plan_status.sql),
 * and sends a one-time "approaching your limit" notification the
 * first time any axis crosses into soft_exceeded.
 *
 * Same hourly in-process `setInterval` shape as
 * weekly-report-scheduler.ts (itself following apps/analyst/src/
 * main.ts's own established convention) — there is still no shared
 * cron/scheduler infrastructure anywhere in this repo to hook into
 * instead.
 *
 * This sweep does not itself degrade anything — it only evaluates and
 * records. weekly-report-scheduler.ts is what actually ACTS on a
 * hard_exceeded status (skipping that tenant's report email), reading
 * the status this sweep writes. Keeping "evaluate" and "act" in
 * separate files means a tenant's degradation is always driven by the
 * LATEST recorded status, not a decision frozen at the moment this
 * sweep happened to run.
 */
import type { Pool } from 'pg';
import { TenantUsageRepository, LlmUsageRepository, listActiveTenantIds, withTenantContext, NotificationOptoutRepository } from '@sentinel/db';
import { limitsFor, evaluateLimit, worstStatus, type LimitStatus } from '@sentinel/billing';
import { buildEmailChannel } from '@sentinel/notifications';
import type { ResendConfig } from './weekly-report-email.js';

export interface SweepLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

async function findRecipientEmail(pool: Pool, tenantId: string): Promise<string | null> {
  const { rows } = await pool.query<{ email: string | null }>(
    `SELECT u.email FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
      LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.email ?? null;
}

async function notifyApproachingLimit(
  pool: Pool,
  resendConfig: ResendConfig | undefined,
  tenantId: string,
  tenantName: string,
  exceeded: { seats: LimitStatus; eventVolume: LimitStatus; cost: LimitStatus },
): Promise<void> {
  if (!resendConfig) return; // same honest "no email provider configured" gap every other email path already discloses
  const recipient = await findRecipientEmail(pool, tenantId);
  if (!recipient) return;

  const reasons: string[] = [];
  if (exceeded.seats !== 'ok') reasons.push('seat count');
  if (exceeded.eventVolume !== 'ok') reasons.push('daily event volume');
  if (exceeded.cost !== 'ok') reasons.push('LLM usage cost');

  const optouts = await withTenantContext(tenantId, async () => new NotificationOptoutRepository(pool));
  const channel = buildEmailChannel({ apiKey: resendConfig.apiKey, ...(resendConfig.apiBaseUrl ? { apiBaseUrl: resendConfig.apiBaseUrl } : {}) }, optouts);

  await channel.send(tenantId, {
    to: recipient,
    from: resendConfig.fromAddress,
    subject: `${tenantName} — approaching your plan's limit`,
    html: `<p>Your tenant is approaching its plan's limit on: ${reasons.join(', ')}. Review your plan or usage to avoid any disruption.</p>`,
    text: `Your tenant is approaching its plan's limit on: ${reasons.join(', ')}. Review your plan or usage to avoid any disruption.`,
  });
}

export async function runPlanUsageSweep(pool: Pool, resendConfig: ResendConfig | undefined, logger: SweepLogger): Promise<void> {
  const tenantIds = await listActiveTenantIds(pool);

  for (const tenantId of tenantIds) {
    try {
      await withTenantContext(tenantId, async () => {
        const usageRepo = new TenantUsageRepository(pool);
        const llmRepo = new LlmUsageRepository(pool);

        const [plan, seatCount, eventVolume, costUsd, previousStatus] = await Promise.all([
          llmRepo.planTier(),
          usageRepo.countSeats(),
          usageRepo.countEventVolumeSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
          llmRepo.dailySpendUsd(new Date()),
          usageRepo.getStatus(),
        ]);

        const limits = limitsFor(plan);
        const seatsStatus = evaluateLimit(seatCount, limits.seats);
        const eventVolumeStatus = evaluateLimit(eventVolume, limits.eventVolumePerDay);
        // Re-evaluates the SAME spend figure apps/analyst's own
        // cost-budget.ts already checks per-case, against the
        // identical dollar limits (@sentinel/billing's costUsdPerDay
        // mirrors PLAN_BUDGETS by value — see that field's own doc
        // comment for why this can't be a shared import). This
        // tenant's recorded plan-status row is what the margin view
        // and the weekly-report degrade check read, independent of
        // apps/analyst's own in-process enforcement.
        const costStatus = evaluateLimit(costUsd, limits.costUsdPerDay);

        const overallAfter = worstStatus(seatsStatus, eventVolumeStatus, costStatus);
        // Notifies whenever currently non-ok AND no notification has
        // gone out yet for this bad streak — covers a fresh escalation
        // (no previous row, or the previous row was already back to
        // 'ok') AND a status that was recorded on an earlier sweep but
        // never actually delivered (no email provider configured at
        // the time; `canNotify` below was false then) — both cases
        // leave `soft_notified_at` null, which is exactly the signal
        // this checks. `resetNotified` (upsertStatus) clears that
        // field once a tenant returns to 'ok', so a LATER, separate
        // escalation notifies again rather than staying silenced by a
        // now-resolved earlier one.
        const needsNotification = overallAfter !== 'ok' && (previousStatus === null || previousStatus.softNotifiedAt === null);
        // Only marked "notified" once a notification could actually be
        // attempted — with no resendConfig, nothing was sent, and a
        // later sweep (once a provider IS configured) must still treat
        // this as an outstanding, un-notified escalation rather than
        // one silently skipped forever.
        const canNotify = resendConfig !== undefined;

        await usageRepo.upsertStatus({
          seatsStatus,
          eventVolumeStatus,
          costStatus,
          markSoftNotified: needsNotification && canNotify,
          resetNotified: overallAfter === 'ok',
        });

        if (needsNotification && canNotify) {
          const { rows } = await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
          await notifyApproachingLimit(pool, resendConfig, tenantId, rows[0]?.name ?? 'Your tenant', {
            seats: seatsStatus,
            eventVolume: eventVolumeStatus,
            cost: costStatus,
          });
        }

        logger.info({ tenant_id: tenantId, seats_status: seatsStatus, event_volume_status: eventVolumeStatus, cost_status: costStatus }, 'evaluated tenant plan usage');
      });
    } catch (err) {
      logger.error({ tenant_id: tenantId, err: err instanceof Error ? err.message : String(err) }, 'plan usage sweep failed for tenant');
    }
  }
}

export function startPlanUsageSweep(pool: Pool, resendConfig: ResendConfig | undefined, logger: SweepLogger, intervalMs = 60 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    runPlanUsageSweep(pool, resendConfig, logger).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'plan usage sweep failed'),
    );
  }, intervalMs);
  return () => clearInterval(timer);
}
