/**
 * P5-02: WhatsApp Cloud API delivery with interactive approval buttons.
 *
 * No real WhatsApp Business sandbox credentials exist in this
 * environment (WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN are
 * unset here, same honestly-scoped situation Phase 4 had with
 * ANTHROPIC_API_KEY) — this channel is fully implemented and its logic
 * is fully unit-tested against a mocked `fetch`, but T1 ("delivered
 * against the sandbox with buttons rendered") has never been exercised
 * against the real Meta endpoint.
 *
 * Message TEMPLATES themselves (AC1: "approved message templates cover
 * critical, high and digest alert types") are not created here — Meta
 * requires templates to go through ITS OWN business-verification and
 * approval process before they can be sent at all, which cannot happen
 * in a sandbox with no real WhatsApp Business Account. `TEMPLATES`
 * below is the exact shape that would be submitted for that approval
 * (name, category, body variable count) — what this channel sends is
 * only ever a reference to an already-approved template by name, never
 * ad-hoc text (the Cloud API does not allow sending free text to a
 * user outside their own 24-hour session window, which an unsolicited
 * security alert always is).
 *
 * Buttons: Meta's "quick reply" buttons on an approved template carry a
 * fixed, pre-approved LABEL (e.g. "Approve") but an opaque `payload`
 * string this channel controls at send time. Each outbound alert with
 * an action attached gets exactly 3 buttons — Approve, Call Me First,
 * Stop these alerts — which is the Cloud API's own maximum for quick
 * reply buttons. The opt-out button carries no action id (there may be
 * no action on this particular alert; the recipient opting out is
 * still meaningful on a plain informational alert) while the other two
 * are meaningless without one — see `renderWhatsAppContent` below for
 * which fields are required when.
 */
import type { Logger } from '@sentinel/observability';
import type { NotificationChannel, NotificationChannelId } from '../types.js';

export type WhatsAppTemplateName = 'sentinel_critical_alert' | 'sentinel_high_alert' | 'sentinel_daily_digest';

/** The exact shape that would be submitted to Meta for template
 * approval — see the file's own doc comment for why this cannot be a
 * live call in this environment. `bodyParamCount` is the number of
 * `{{n}}` placeholders the approved body text itself declares; a
 * mismatch between this and the params actually sent is Meta error
 * 132000, handled below as a template-rejection, not a generic retry. */
export const TEMPLATES: Record<WhatsAppTemplateName, { category: 'UTILITY'; bodyParamCount: number; hasActionButtons: boolean }> = {
  sentinel_critical_alert: { category: 'UTILITY', bodyParamCount: 3, hasActionButtons: true },
  sentinel_high_alert: { category: 'UTILITY', bodyParamCount: 3, hasActionButtons: true },
  sentinel_daily_digest: { category: 'UTILITY', bodyParamCount: 1, hasActionButtons: false },
};

export interface WhatsAppMessageContent {
  /** E.164, digits only, no leading '+' — the Cloud API's own expected format. */
  recipientPhone: string;
  templateName: WhatsAppTemplateName;
  languageCode: string;
  bodyParams: string[];
  /** Required whenever `TEMPLATES[templateName].hasActionButtons` — an
   * alert with nothing to approve (e.g. the digest) has none. */
  actionId?: string;
}

export class RecipientOptedOutError extends Error {
  constructor(recipient: string) {
    super(`recipient ${recipient} has opted out of WhatsApp alerts for this tenant`);
    this.name = 'RecipientOptedOutError';
  }
}

export interface OptoutChecker {
  isOptedOut(channel: NotificationChannelId, recipient: string): Promise<boolean>;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Overridable for tests; defaults to the real Graph API host. */
  apiBaseUrl?: string;
}

/** Documented Meta WhatsApp Cloud API error codes for a rejected or
 * malformed TEMPLATE specifically (param count/name/approval-state
 * problems) — distinguished from a transport/rate-limit failure so
 * AC5 ("surfaced to operations, not silently retried") fires exactly
 * when the problem is the template itself, which retrying never fixes. */
const TEMPLATE_REJECTION_CODES = new Set([131008, 132000, 132001, 132005, 132007]);

export function buildWhatsAppChannel(config: WhatsAppConfig, optouts: OptoutChecker, logger: Logger): NotificationChannel<WhatsAppMessageContent> {
  const apiBaseUrl = config.apiBaseUrl ?? 'https://graph.facebook.com/v20.0';

  return {
    id: 'whatsapp',
    async send(tenantId: string, content: WhatsAppMessageContent): Promise<void> {
      if (await optouts.isOptedOut('whatsapp', content.recipientPhone)) {
        throw new RecipientOptedOutError(content.recipientPhone);
      }

      const template = TEMPLATES[content.templateName];
      const components: unknown[] = [{ type: 'body', parameters: content.bodyParams.map((text) => ({ type: 'text', text })) }];
      if (template.hasActionButtons) {
        if (!content.actionId) throw new Error(`${content.templateName} requires an actionId to render its approval buttons`);
        const buttons: Array<{ payload: string }> = [
          { payload: `approve:${tenantId}:${content.actionId}` },
          { payload: `call_me_first:${tenantId}:${content.actionId}` },
        ];
        buttons.forEach((b, index) => {
          components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: b.payload }] });
        });
      }
      // Every alert, regardless of whether it carries an action, offers
      // a way to stop future ones — the last button slot.
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(components.length - 1),
        parameters: [{ type: 'payload', payload: `optout:${tenantId}` }],
      });

      const body = {
        messaging_product: 'whatsapp',
        to: content.recipientPhone,
        type: 'template',
        template: { name: content.templateName, language: { code: content.languageCode }, components },
      };

      const response = await fetch(`${apiBaseUrl}/${config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) return;

      const errorBody = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
      const code = errorBody.error?.code;
      if (code !== undefined && TEMPLATE_REJECTION_CODES.has(code)) {
        logger.error(
          { tenant_id: tenantId, template: content.templateName, meta_error_code: code, meta_error_message: errorBody.error?.message, page: true },
          'WhatsApp template rejected by Meta — operator action needed (template missing/unapproved/param mismatch), retrying will not help',
        );
      }
      throw new Error(`WhatsApp send failed (${response.status}): ${errorBody.error?.message ?? 'unknown error'}`);
    },
  };
}
