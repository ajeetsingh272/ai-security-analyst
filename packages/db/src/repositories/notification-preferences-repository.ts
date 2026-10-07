/**
 * P5-01 AC2: "failover order is configurable per tenant and defaults to
 * WhatsApp, Slack, email, dashboard banner." A tenant that has never
 * customised its order has no row in `tenant_notification_preferences`
 * at all — `getChannelOrder` returning the platform default in that case
 * means onboarding a tenant never requires seeding this table, and the
 * default can change for every not-yet-customised tenant at once just by
 * changing the constant here (and the migration's own column default,
 * which governs INSERT ... DEFAULT paths only, not this read path).
 */
import { TenantScopedRepository } from '../tenant-context.js';
import type { NotificationChannelId } from './notification-delivery-repository.js';

export const DEFAULT_CHANNEL_ORDER: readonly NotificationChannelId[] = ['whatsapp', 'slack', 'email', 'dashboard_banner'];

export class NotificationPreferencesRepository extends TenantScopedRepository {
  async getChannelOrder(): Promise<NotificationChannelId[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ channel_order: NotificationChannelId[] }>(
        `SELECT channel_order FROM tenant_notification_preferences WHERE tenant_id = $1`,
        [this.tenantId],
      );
      return rows[0]?.channel_order ?? [...DEFAULT_CHANNEL_ORDER];
    });
  }

  async setChannelOrder(order: NotificationChannelId[]): Promise<void> {
    await this.withTransaction((client) =>
      client.query(
        `INSERT INTO tenant_notification_preferences (tenant_id, channel_order, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (tenant_id) DO UPDATE SET channel_order = EXCLUDED.channel_order, updated_at = now()`,
        [this.tenantId, order],
      ),
    );
  }
}
