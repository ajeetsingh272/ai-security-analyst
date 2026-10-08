/**
 * P5-07: Slack delivery with interactive approval blocks — "the same
 * approval semantics as WhatsApp" (the ticket's own words), but
 * Slack's buttons carry whatever opaque string the caller gives them
 * (unlike WhatsApp's own `approve:<tenant>:<action>` scheme) — this
 * ticket depends on P5-03 specifically so that string can be a real
 * signed approval token (@sentinel/approval-tokens), not a bare
 * reference; this package stays ignorant of what a token even is, the
 * same decoupling @sentinel/approval-tokens' own NonceStore interface
 * already establishes.
 *
 * No real Slack app (client id/secret) exists in this environment —
 * this channel's logic is fully unit-tested against a mocked `fetch`;
 * T1 ("installation flow completes and posts a test alert" against a
 * real Slack workspace) is honestly unexercised, the same disclosed
 * gap m365-oauth.ts/whatsapp-channel.ts already have for their own
 * providers.
 */
import type { NotificationChannel } from '../types.js';

export interface SlackBlock {
  type: string;
  text?: { type: 'mrkdwn' | 'plain_text'; text: string };
  elements?: Array<{ type: 'button'; text: { type: 'plain_text'; text: string }; action_id: string; value: string; style?: 'primary' | 'danger' }>;
}

export interface SlackMessageContent {
  channelId: string;
  title: string;
  bodyMarkdown: string;
  /** Opaque — the caller's own signed approval token when there is a
   * real action to approve; omitted entirely (no buttons at all) for
   * an alert with nothing to decide, e.g. a digest. */
  approveValue?: string;
  callMeFirstValue?: string;
}

export interface SlackConfig {
  botAccessToken: string;
  /** Overridable for tests; defaults to the real Slack API host. */
  apiBaseUrl?: string;
}

function buildBlocks(content: SlackMessageContent): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${content.title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: content.bodyMarkdown } },
  ];
  if (content.approveValue) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve', value: content.approveValue, style: 'primary' },
        ...(content.callMeFirstValue ? [{ type: 'button' as const, text: { type: 'plain_text' as const, text: 'Call Me First' }, action_id: 'call_me_first', value: content.callMeFirstValue }] : []),
      ],
    });
  }
  return blocks;
}

export function buildSlackChannel(config: SlackConfig): NotificationChannel<SlackMessageContent> {
  const apiBaseUrl = config.apiBaseUrl ?? 'https://slack.com/api';

  return {
    id: 'slack',
    async send(_tenantId: string, content: SlackMessageContent): Promise<void> {
      const response = await fetch(`${apiBaseUrl}/chat.postMessage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.botAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: content.channelId, blocks: buildBlocks(content), text: content.title }),
      });

      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(`Slack chat.postMessage failed (${response.status}): ${body.error ?? 'unknown error'}`);
      }
    },
  };
}
