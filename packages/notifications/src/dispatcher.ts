/**
 * P5-01: one interface over every channel, with ordered failover,
 * per-channel retry with backoff, duplicate suppression, and an
 * operational page when nothing could deliver.
 *
 * "Operational page" is, honestly, a structured ERROR log with a
 * `page: true` field — the same deliberately-not-fabricated alerting
 * shape this codebase already uses for a failure with no dedicated
 * paging integration behind it yet (apps/analyst/src/worker.ts's own
 * `handleFailure`/`degradeToRuleOnlyAlert`, and
 * verify-audit-chain.yml's own doc comment making the identical point
 * about GitHub's failed-workflow notification). This is NOT a
 * placeholder to replace later — it is the honestly-scoped version of
 * AC5 until a real paging integration becomes its own ticket.
 */
import type { Logger } from '@sentinel/observability';
import {
  DEFAULT_CHANNEL_ORDER,
  DEFAULT_RETRY,
  type ChannelOrderResolver,
  type DeliveryRecorder,
  type Notification,
  type NotificationChannel,
  type NotificationChannelId,
  type RetryOptions,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** AC2's own fallback when no per-tenant preference exists — exported so
 * a caller that has no real preferences store yet (or a unit test) can
 * use it directly instead of writing a trivial resolver by hand. */
export const staticChannelOrder: ChannelOrderResolver = {
  resolve: async () => [...DEFAULT_CHANNEL_ORDER],
};

export interface NotificationDispatcherDeps {
  readonly channels: readonly NotificationChannel[];
  readonly recorder: DeliveryRecorder;
  readonly channelOrder: ChannelOrderResolver;
  readonly logger: Logger;
  readonly retry?: RetryOptions;
}

export class NotificationDispatcher {
  private readonly channelsById: Map<NotificationChannelId, NotificationChannel>;
  private readonly retry: RetryOptions;

  constructor(private readonly deps: NotificationDispatcherDeps) {
    this.channelsById = new Map(deps.channels.map((c) => [c.id, c]));
    this.retry = deps.retry ?? DEFAULT_RETRY;
  }

  /**
   * Tries each of the tenant's configured channels, in order, until one
   * delivers. A channel delivers once it either sends successfully OR
   * (T4) is found already sent for this exact dedupe key — either way,
   * dispatch stops there and never falls through to a less-preferred
   * channel on top of an already-delivered alert.
   */
  async dispatch(notification: Notification): Promise<void> {
    const order = await this.deps.channelOrder.resolve(notification.tenantId);

    for (const channelId of order) {
      const channel = this.channelsById.get(channelId);
      const content = notification.content[channelId];
      // No implementation registered yet (e.g. WhatsApp/Slack before
      // P5-02/P5-07 ship), or the caller rendered nothing for this
      // channel — neither is a delivery failure, so neither is
      // recorded or retried; the next channel in order gets a turn.
      if (!channel || content === undefined) continue;

      if (await this.deps.recorder.alreadySent(notification.dedupeKey, channelId)) {
        return;
      }

      if (await this.attemptWithRetry(channel, notification, channelId, content)) {
        return;
      }
    }

    this.deps.logger.error(
      { tenant_id: notification.tenantId, dedupe_key: notification.dedupeKey, page: true },
      'notification dispatch exhausted every configured channel without a successful delivery',
    );
  }

  private async attemptWithRetry(
    channel: NotificationChannel,
    notification: Notification,
    channelId: NotificationChannelId,
    content: unknown,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        await channel.send(notification.tenantId, content);
        await this.deps.recorder.recordAttempt({
          dedupeKey: notification.dedupeKey,
          channel: channelId,
          attempt,
          status: 'sent',
          content,
        });
        return true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.deps.recorder.recordAttempt({
          dedupeKey: notification.dedupeKey,
          channel: channelId,
          attempt,
          status: 'failed',
          content,
          error,
        });
        this.deps.logger.warn(
          { tenant_id: notification.tenantId, dedupe_key: notification.dedupeKey, channel: channelId, attempt, err: error },
          'notification delivery attempt failed',
        );
        if (attempt < this.retry.maxAttempts) await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    return false;
  }
}
