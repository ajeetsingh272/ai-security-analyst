/**
 * Pure unit tests — fake channels, fake in-memory recorder, no real
 * infra. T4 (duplicate suppression against a real unique constraint)
 * and the real delivery-row shape are proved against actual Postgres in
 * dispatcher.integration.test.ts instead; this file proves the
 * failover/retry/paging LOGIC itself, fast and infra-free, the same
 * "fakePublisher" discipline services/correlate's own tests already
 * established for this kind of test double.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@sentinel/observability';
import { NotificationDispatcher, staticChannelOrder } from '../dispatcher.js';
import type { DeliveryRecorder, NotificationChannel, NotificationChannelId } from '../types.js';

const logger = createLogger({ service: 'notifications-test' });
const TENANT = '11111111-1111-1111-1111-111111111111';

class FakeChannel implements NotificationChannel {
  calls: unknown[] = [];
  constructor(
    public readonly id: NotificationChannelId,
    private readonly behavior: 'always_succeed' | 'always_fail' = 'always_succeed',
  ) {}

  async send(_tenantId: string, content: unknown): Promise<void> {
    this.calls.push(content);
    if (this.behavior === 'always_fail') throw new Error(`${this.id}: simulated failure`);
  }
}

class FakeRecorder implements DeliveryRecorder {
  sent = new Set<string>();
  attempts: Array<{ dedupeKey: string; channel: NotificationChannelId; attempt: number; status: 'sent' | 'failed'; content?: unknown; error?: string }> = [];

  async alreadySent(dedupeKey: string, channel: NotificationChannelId): Promise<boolean> {
    return this.sent.has(`${dedupeKey}:${channel}`);
  }

  async recordAttempt(input: {
    dedupeKey: string;
    channel: NotificationChannelId;
    attempt: number;
    status: 'sent' | 'failed';
    content?: unknown;
    error?: string;
  }): Promise<void> {
    this.attempts.push(input);
    if (input.status === 'sent') this.sent.add(`${input.dedupeKey}:${input.channel}`);
  }
}

function dispatcher(channels: NotificationChannel[], recorder: FakeRecorder, retry = { maxAttempts: 2, baseDelayMs: 1 }) {
  return new NotificationDispatcher({ channels, recorder, channelOrder: staticChannelOrder, logger, retry });
}

describe('NotificationDispatcher', () => {
  it('T1: primary channel failure falls through to the secondary', async () => {
    const whatsapp = new FakeChannel('whatsapp', 'always_fail');
    const slack = new FakeChannel('slack', 'always_succeed');
    const recorder = new FakeRecorder();

    await dispatcher([whatsapp, slack], recorder).dispatch({
      tenantId: TENANT,
      dedupeKey: 'case-1:critical',
      content: { whatsapp: 'wa-text', slack: { blocks: [] } },
    });

    expect(whatsapp.calls).toHaveLength(2); // retried up to maxAttempts before failing over
    expect(slack.calls).toEqual([{ blocks: [] }]);
    expect(recorder.sent.has('case-1:critical:slack')).toBe(true);
    expect(recorder.sent.has('case-1:critical:whatsapp')).toBe(false);
  });

  it('T2: all channels failing raises an operational page', async () => {
    const whatsapp = new FakeChannel('whatsapp', 'always_fail');
    const slack = new FakeChannel('slack', 'always_fail');
    const recorder = new FakeRecorder();
    // Spying in place (not spreading `logger` into a plain object) —
    // pino's own methods close over internal symbols on `this` that a
    // shallow copy silently drops, breaking every OTHER method on the
    // copy even though the override itself works.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await new NotificationDispatcher({
      channels: [whatsapp, slack],
      recorder,
      channelOrder: staticChannelOrder,
      logger,
      retry: { maxAttempts: 1, baseDelayMs: 1 },
    }).dispatch({ tenantId: TENANT, dedupeKey: 'case-2:critical', content: { whatsapp: 'x', slack: { blocks: [] } } });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: true, dedupe_key: 'case-2:critical' }),
      expect.stringContaining('exhausted every configured channel'),
    );
    errorSpy.mockRestore();
  });

  it('T3: delivery attempts are recorded with their outcome', async () => {
    const whatsapp = new FakeChannel('whatsapp', 'always_fail');
    const slack = new FakeChannel('slack', 'always_succeed');
    const recorder = new FakeRecorder();

    await dispatcher([whatsapp, slack], recorder).dispatch({
      tenantId: TENANT,
      dedupeKey: 'case-3:critical',
      content: { whatsapp: 'x', slack: { blocks: [] } },
    });

    const whatsappAttempts = recorder.attempts.filter((a) => a.channel === 'whatsapp');
    expect(whatsappAttempts).toHaveLength(2);
    expect(whatsappAttempts.every((a) => a.status === 'failed')).toBe(true);
    expect(whatsappAttempts[0]!.error).toContain('simulated failure');

    const slackAttempts = recorder.attempts.filter((a) => a.channel === 'slack');
    expect(slackAttempts).toEqual([{ dedupeKey: 'case-3:critical', channel: 'slack', attempt: 1, status: 'sent', content: { blocks: [] } }]);
  });

  it('skips a channel with no registered implementation without recording an attempt', async () => {
    const email = new FakeChannel('email', 'always_succeed');
    const recorder = new FakeRecorder();

    // whatsapp/slack have content but no registered channel (pre-P5-02/07) —
    // must fall through to email silently, not be treated as a failure.
    await dispatcher([email], recorder).dispatch({
      tenantId: TENANT,
      dedupeKey: 'case-4:critical',
      content: { whatsapp: 'x', slack: { blocks: [] }, email: '<html/>' },
    });

    expect(recorder.attempts.filter((a) => a.channel === 'whatsapp' || a.channel === 'slack')).toHaveLength(0);
    expect(email.calls).toEqual(['<html/>']);
  });

  it('a channel with no content for this notification is skipped, not failed', async () => {
    const whatsapp = new FakeChannel('whatsapp', 'always_succeed');
    const recorder = new FakeRecorder();

    // Only whatsapp content provided; slack/email/dashboard_banner absent.
    await dispatcher([whatsapp], recorder).dispatch({ tenantId: TENANT, dedupeKey: 'case-5:critical', content: { whatsapp: 'x' } });

    expect(recorder.attempts).toEqual([{ dedupeKey: 'case-5:critical', channel: 'whatsapp', attempt: 1, status: 'sent', content: 'x' }]);
  });
});
