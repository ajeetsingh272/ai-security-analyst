/**
 * P5-01 T3/T4: the queryable delivery history behind the notification
 * dispatcher's own failover engine (@sentinel/notifications). One row per
 * delivery ATTEMPT, never overwritten — `recordAttempt` always INSERTs,
 * so a channel that failed twice before succeeding keeps both failures
 * visible alongside the eventual success, which is what "every attempt
 * is recorded" (AC3) actually means.
 *
 * `alreadySent` backs T4 (duplicate suppression) at the application
 * level, checked BEFORE a channel is attempted — the migration's own
 * partial unique index on (tenant_id, dedupe_key, channel) WHERE status
 * = 'sent' is the real enforcement underneath it, the same
 * defence-in-depth relationship `approval_nonces`' PRIMARY KEY has to
 * P5-03's own single-use check.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export type NotificationChannelId = 'whatsapp' | 'slack' | 'email' | 'dashboard_banner';
export type DeliveryStatus = 'sent' | 'failed';

export interface RecordDeliveryAttemptInput {
  dedupeKey: string;
  channel: NotificationChannelId;
  attempt: number;
  status: DeliveryStatus;
  content?: unknown;
  error?: string;
}

export interface DeliveryAttemptRow {
  id: string;
  channel: NotificationChannelId;
  attempt: number;
  status: DeliveryStatus;
  content: unknown;
  error: string | null;
  createdAt: string;
}

export class NotificationDeliveryRepository extends TenantScopedRepository {
  async recordAttempt(input: RecordDeliveryAttemptInput): Promise<void> {
    await this.withTransaction((client) =>
      client.query(
        `INSERT INTO notification_deliveries (tenant_id, dedupe_key, channel, attempt, status, content, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [this.tenantId, input.dedupeKey, input.channel, input.attempt, input.status, input.content === undefined ? null : JSON.stringify(input.content), input.error ?? null],
      ),
    );
  }

  /** T4: has this (alert, channel) pair already been delivered successfully? */
  async alreadySent(dedupeKey: string, channel: NotificationChannelId): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM notification_deliveries WHERE tenant_id = $1 AND dedupe_key = $2 AND channel = $3 AND status = 'sent' LIMIT 1`,
        [this.tenantId, dedupeKey, channel],
      );
      return rows.length > 0;
    });
  }

  /** AC4: "delivery status is queryable per alert" — every attempt across
   * every channel for one dedupe key, oldest first. */
  async listForDedupeKey(dedupeKey: string): Promise<DeliveryAttemptRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        channel: NotificationChannelId;
        attempt: number;
        status: DeliveryStatus;
        content: unknown;
        error: string | null;
        created_at: string;
      }>(
        `SELECT id, channel, attempt, status, content, error, created_at FROM notification_deliveries
         WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY created_at ASC`,
        [this.tenantId, dedupeKey],
      );
      return rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        attempt: r.attempt,
        status: r.status,
        content: r.content,
        error: r.error,
        createdAt: r.created_at,
      }));
    });
  }
}
