/**
 * P6-07 AC3: "delivered by email." Finds the tenant's own owner (or,
 * absent one, the most senior admin) as the recipient — a weekly
 * summary goes to whoever is accountable for the tenant, not to the
 * specific person who happened to trigger an on-demand generation.
 */
import type { Pool } from 'pg';
import { NotificationOptoutRepository, WeeklyReportRepository, withTenantContext, type WeeklyReportRow } from '@sentinel/db';
import { buildEmailChannel } from '@sentinel/notifications';
import { renderWeeklyReportEmail } from './weekly-report-render.js';

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  apiBaseUrl?: string;
}

export function resendConfigFromEnv(): ResendConfig | undefined {
  const apiKey = process.env['RESEND_API_KEY'];
  const fromAddress = process.env['RESEND_FROM_ADDRESS'];
  if (!apiKey || !fromAddress) return undefined;
  return { apiKey, fromAddress };
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

export async function sendWeeklyReportEmail(pool: Pool, config: ResendConfig, tenantId: string, report: WeeklyReportRow): Promise<void> {
  const recipient = await findRecipientEmail(pool, tenantId);
  if (!recipient) return; // no one to send to — not an error, just nothing to do

  const tenantResult = await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
  const tenantName = tenantResult.rows[0]?.name ?? 'Your tenant';
  const { html, text } = renderWeeklyReportEmail(report, tenantName);

  const optouts = await withTenantContext(tenantId, async () => new NotificationOptoutRepository(pool));
  const channel = buildEmailChannel({ apiKey: config.apiKey, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}) }, optouts);

  await channel.send(tenantId, {
    to: recipient,
    from: config.fromAddress,
    subject: `${tenantName} — weekly security summary`,
    html,
    text,
  });

  await withTenantContext(tenantId, () => new WeeklyReportRepository(pool).markEmailed(report.id));
}
