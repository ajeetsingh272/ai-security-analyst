/**
 * P5-01: the channel-agnostic contract. `NotificationChannel` has
 * exactly one method on purpose — AC1 ("adding a channel does not
 * change calling code") only holds if a new channel is a new class that
 * implements this interface and gets registered, never a new branch
 * inside the dispatcher itself.
 */

export type NotificationChannelId = 'whatsapp' | 'slack' | 'email' | 'dashboard_banner';

/** AC2's own default, before any tenant customises it. */
export const DEFAULT_CHANNEL_ORDER: readonly NotificationChannelId[] = ['whatsapp', 'slack', 'email', 'dashboard_banner'];

/**
 * One channel's own delivery mechanism. `send` throws on failure — the
 * dispatcher never inspects a return value to decide success, so a
 * channel cannot accidentally report success by returning normally
 * while having done nothing.
 */
export interface NotificationChannel<TContent = unknown> {
  readonly id: NotificationChannelId;
  send(tenantId: string, content: TContent): Promise<void>;
}

/**
 * One alert to deliver. `content` carries whatever each channel needs —
 * the caller is the one that knows how to render a report for WhatsApp
 * vs. Slack vs. email (apps/analyst's own report-channels.ts already
 * does exactly this), so the dispatcher stays ignorant of report shape
 * entirely. A channel absent from `content` is skipped, same as a
 * channel with no implementation registered — neither is a delivery
 * failure, both are just "this alert has nothing to send on that
 * channel."
 */
export interface Notification {
  readonly tenantId: string;
  /** T4: identifies "this alert" for duplicate suppression — the
   * caller's responsibility to make stable (e.g. `${caseId}:${verdictId}`),
   * since only the caller knows what makes two dispatches "the same alert." */
  readonly dedupeKey: string;
  readonly content: Partial<Record<NotificationChannelId, unknown>>;
}

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 200 };

/** The storage seam — satisfied for real by
 * @sentinel/db's NotificationDeliveryRepository, and by an in-memory
 * fake in this package's own unit tests. Kept as an interface (not an
 * import of @sentinel/db) so this package has no runtime dependency on
 * Postgres at all. */
export interface DeliveryRecorder {
  alreadySent(dedupeKey: string, channel: NotificationChannelId): Promise<boolean>;
  recordAttempt(input: {
    dedupeKey: string;
    channel: NotificationChannelId;
    attempt: number;
    status: 'sent' | 'failed';
    content?: unknown;
    error?: string;
  }): Promise<void>;
}

export interface ChannelOrderResolver {
  resolve(tenantId: string): Promise<NotificationChannelId[]>;
}
