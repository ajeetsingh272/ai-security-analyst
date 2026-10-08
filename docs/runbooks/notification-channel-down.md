# Runbook: notification channel down

**Failure row:** `docs/architecture/overview.md` §6 — "Notification channel down | Failover
WhatsApp to Slack to email to dashboard banner; retry with backoff | Alert eventually
delivered."

**Guarantee at risk:** none directly — this row's own guarantee is that a critical alert is
never simply dropped because one channel is unavailable. The mechanism is
`@sentinel/notifications`' own `NotificationDispatcher` (P5-01): each channel in the
tenant's own configured order is retried with exponential backoff before falling through to
the next, and `dashboard_banner` (the last channel in the default order) needs no external
credentials at all, so it is the floor every alert eventually lands on even if WhatsApp,
Slack and email are all down at once.

## What this means

A tenant's alert is not reaching them on their preferred channel. This can be:

1. **One channel genuinely down** (a provider outage, a revoked/expired connector) — the
   dispatcher is already failing over correctly; nothing is broken, but the tenant should
   know why their WhatsApp went quiet.
2. **Every channel failing** — the dispatcher logs a structured `page: true` error
   ("notification dispatch exhausted every configured channel without a successful
   delivery", `packages/notifications/src/dispatcher.ts`) once the last channel in the
   tenant's own order also fails. This should be rare: `dashboard_banner` has no external
   dependency, so reaching this state means either the tenant's own order omits it, or the
   database itself (`notification_deliveries`) is unreachable — a platform-wide incident, not
   a per-tenant one.

## Diagnose

1. **Find the alert's own delivery history** — every attempt, on every channel, is a row:
   ```sql
   SELECT channel, attempt, status, error, created_at
   FROM notification_deliveries
   WHERE tenant_id = '<tenant-uuid>' AND dedupe_key = '<dedupe-key>'
   ORDER BY created_at ASC;
   ```
   The `error` column on a `failed` row is the channel's own exception message —
   `WhatsAppChannel`/`SlackChannel`/`EmailChannel`'s own thrown errors already say exactly
   what Meta/Slack/Resend returned.
2. **Check the connector's own health** for the failing channel (WhatsApp/Slack/M365 use
   `connectors`; email has no per-tenant connector — it is one platform-wide Resend account):
   ```sql
   SELECT kind, status, last_error FROM connectors WHERE tenant_id = '<tenant-uuid>';
   ```
   `status = 'revoked'` means the tenant (or an operator) disconnected it — see the
   channel-specific connector routes (`/connectors/slack/revoke`, `/connectors/m365/revoke`)
   for how that happens; it is not itself a bug.
3. **Check the recipient opt-out store** — a WhatsApp number or email address that opted out
   (or, for email, hard-bounced — P5-08's own bounce webhook records this the same way) will
   fail every send with `RecipientOptedOutError`/`EmailRecipientOptedOutError`, which is
   correct behaviour, not an outage:
   ```sql
   SELECT channel, recipient, opted_out_at FROM notification_recipient_optouts
   WHERE tenant_id = '<tenant-uuid>';
   ```
4. **If EVERY channel failed**, check whether `dashboard_banner` itself failed too — that
   specific failure means `notification_deliveries`/Postgres itself was unreachable at
   dispatch time, which is a platform incident, not a per-tenant notification problem.

## Mitigate

- **One channel down, dashboard_banner succeeded**: the tenant was still alerted (the
  guarantee held). Fix the underlying channel (re-authorize Slack/M365, check the WhatsApp
  Business account, check Resend's own status page) and tell the tenant their primary
  channel is back.
- **Opt-out/bounce was the cause**: this is not a bug — contact the tenant through a
  DIFFERENT channel (their own failover order already did this) to ask whether the opt-out
  was intentional, and use the opt-in path (`DELETE` on the opt-out, or the recipient
  re-subscribing) if not.
- **Every channel failed, including `dashboard_banner`**: this is a platform incident — the
  database itself was unreachable. File it per the standard incident process; there is no
  tenant-specific fix here.

## Prevent

`NotificationDeliveryRepository.recordAttempt` audits a successful send (`alert_sent`, P5-09)
— cross-reference the audit log, not just `notification_deliveries`, when a tenant disputes
whether they were ever notified at all.
