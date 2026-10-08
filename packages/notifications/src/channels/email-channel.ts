/**
 * P5-08: email via Resend (https://resend.com/docs/api-reference/emails/send-email) —
 * "the universal fallback channel." AC5 ("a plain-text alternative is
 * always included") is enforced at the TYPE level here, not by
 * convention: `EmailMessageContent.text` is required, not optional,
 * so a caller cannot construct a well-typed send that omits it.
 *
 * Checks the same recipient opt-out store WhatsApp's channel does
 * (OptoutChecker, @sentinel/notifications' own shared interface) —
 * P5-08's own bounce-handling webhook (apps/api's resend-webhook.ts)
 * records a hard bounce there too, since "stop sending to an address
 * that bounced" and "stop sending to an address that opted out" are
 * the same operational fact from this channel's point of view.
 *
 * No real Resend account/API key or verified sending domain exists in
 * this environment — this channel's logic is fully unit-tested
 * against a mocked `fetch`; T1 ("delivery succeeds with passing
 * authentication checks") needs a real verified domain's SPF/DKIM/
 * DMARC records to mean anything, which is honestly unexercised here,
 * the same disclosed gap every other real provider in this codebase
 * has (WhatsApp, Slack, M365).
 */
import type { NotificationChannel, OptoutChecker } from '../types.js';

export interface EmailMessageContent {
  to: string;
  from: string;
  subject: string;
  html: string;
  /** AC5 — required, never optional. */
  text: string;
}

export interface EmailConfig {
  apiKey: string;
  apiBaseUrl?: string;
}

export class EmailRecipientOptedOutError extends Error {
  constructor(recipient: string) {
    super(`recipient ${recipient} has opted out of (or hard-bounced on) email alerts for this tenant`);
    this.name = 'EmailRecipientOptedOutError';
  }
}

export function buildEmailChannel(config: EmailConfig, optouts: OptoutChecker): NotificationChannel<EmailMessageContent> {
  const apiBaseUrl = config.apiBaseUrl ?? 'https://api.resend.com';

  return {
    id: 'email',
    async send(_tenantId: string, content: EmailMessageContent): Promise<void> {
      if (await optouts.isOptedOut('email', content.to)) {
        throw new EmailRecipientOptedOutError(content.to);
      }

      const response = await fetch(`${apiBaseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: content.from, to: content.to, subject: content.subject, html: content.html, text: content.text }),
      });

      if (response.ok) return;
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Resend send failed (${response.status}): ${body.message ?? 'unknown error'}`);
    },
  };
}

export type DomainVerificationStatus = 'pending' | 'verified' | 'failed';

export interface DomainVerificationResult {
  status: DomainVerificationStatus;
  /** AC1: SPF, DKIM, DMARC — each checked independently, since a
   * domain can be "pending" overall while individual records are
   * already fine, and the reverse. */
  records: Array<{ type: 'SPF' | 'DKIM' | 'DMARC'; status: DomainVerificationStatus }>;
}

/** AC1: "SPF, DKIM and DMARC are configured and verified" — checked
 * against Resend's own domain-verification API
 * (https://resend.com/docs/api-reference/domains/get-domain) rather
 * than assumed from having set DNS records once; a record can regress
 * (TTL expiry, a DNS provider change) without anyone touching this
 * codebase again. */
export async function checkDomainVerification(config: EmailConfig, domainId: string): Promise<DomainVerificationResult> {
  const apiBaseUrl = config.apiBaseUrl ?? 'https://api.resend.com';
  const response = await fetch(`${apiBaseUrl}/domains/${domainId}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Resend domain lookup failed (${response.status})`);
  }
  const body = (await response.json()) as { status: DomainVerificationStatus; records: Array<{ record: string; status: DomainVerificationStatus }> };
  return {
    status: body.status,
    records: body.records
      .filter((r): r is { record: 'SPF' | 'DKIM' | 'DMARC'; status: DomainVerificationStatus } => r.record === 'SPF' || r.record === 'DKIM' || r.record === 'DMARC')
      .map((r) => ({ type: r.record, status: r.status })),
  };
}
