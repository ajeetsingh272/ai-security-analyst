/**
 * P5-02 AC4: per-(tenant, channel, recipient) opt-in/opt-out, recorded
 * for real rather than just honored in memory — so a recipient who
 * opted out still reads as opted out after a process restart, and so
 * "recorded" (the acceptance criterion's own word) has an actual row
 * behind it a compliance reviewer could query.
 */
import { TenantScopedRepository } from '../tenant-context.js';
import type { NotificationChannelId } from './notification-delivery-repository.js';

export class NotificationOptoutRepository extends TenantScopedRepository {
  async isOptedOut(channel: NotificationChannelId, recipient: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM notification_recipient_optouts WHERE tenant_id = $1 AND channel = $2 AND recipient = $3`,
        [this.tenantId, channel, recipient],
      );
      return rows.length > 0;
    });
  }

  async optOut(channel: NotificationChannelId, recipient: string): Promise<void> {
    await this.withTransaction((client) =>
      client.query(
        `INSERT INTO notification_recipient_optouts (tenant_id, channel, recipient) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, channel, recipient) DO NOTHING`,
        [this.tenantId, channel, recipient],
      ),
    );
  }

  async optIn(channel: NotificationChannelId, recipient: string): Promise<void> {
    await this.withTransaction((client) =>
      client.query(`DELETE FROM notification_recipient_optouts WHERE tenant_id = $1 AND channel = $2 AND recipient = $3`, [this.tenantId, channel, recipient]),
    );
  }
}
