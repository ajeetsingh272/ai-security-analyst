/**
 * Unit tests against a mocked `fetch` — proves the request this
 * channel builds (Block Kit shape, Approve/Call Me First buttons,
 * failure surfacing). Never calls the real Slack API: no app
 * credentials exist in this environment (see slack-channel.ts's own
 * doc comment) — T1 ("posts a test alert" against a real workspace)
 * is honestly un-exercised, not faked here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSlackChannel } from '../channels/slack-channel.js';

const config = { botAccessToken: 'xoxb-test-token', apiBaseUrl: 'https://example.invalid/api' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Slack channel', () => {
  it('posts a message with Approve and Call Me First buttons when an approval value is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildSlackChannel(config);
    await channel.send('tenant-1', {
      channelId: 'C123',
      title: 'Critical: impossible travel',
      bodyMarkdown: 'Priya signed in from Russia 2 minutes after Seattle.',
      approveValue: 'signed-approval-token',
      callMeFirstValue: 'signed-approval-token-call-me-first',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.invalid/api/chat.postMessage');
    expect(init.headers.Authorization).toBe('Bearer xoxb-test-token');

    const body = JSON.parse(init.body);
    expect(body.channel).toBe('C123');
    const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions');
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0]).toMatchObject({ action_id: 'approve', value: 'signed-approval-token', style: 'primary' });
    expect(actionsBlock.elements[1]).toMatchObject({ action_id: 'call_me_first', value: 'signed-approval-token-call-me-first' });
  });

  it('a digest alert with no approval value has no action buttons at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildSlackChannel(config);
    await channel.send('tenant-1', { channelId: 'C123', title: 'Daily digest', bodyMarkdown: '3 cases today' });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false);
  });

  it('surfaces a Slack API error (ok: false) as a thrown error, not a silent success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildSlackChannel(config);
    await expect(channel.send('tenant-1', { channelId: 'C-gone', title: 'x', bodyMarkdown: 'y' })).rejects.toThrow('channel_not_found');
  });

  it('surfaces an HTTP-level failure as a thrown error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildSlackChannel(config);
    await expect(channel.send('tenant-1', { channelId: 'C123', title: 'x', bodyMarkdown: 'y' })).rejects.toThrow('Slack chat.postMessage failed (500)');
  });
});
