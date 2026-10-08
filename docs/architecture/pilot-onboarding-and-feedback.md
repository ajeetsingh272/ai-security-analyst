# Pilot onboarding and feedback instrumentation (P6-12)

## Onboarding funnel

There is no dedicated "signup" moment anywhere in this product —
tenants are always created out-of-band (direct SQL, by whoever
provisions a new pilot customer), never through a product signup flow.
`tenants.created_at` is therefore the only honest t0 for this funnel;
this ticket does not invent a fictitious `auth.sign_up` audit event to
paper over that gap.

From there, the funnel reads real events straight from `audit_log` —
the same durable, queryable "this happened" ledger every other funnel
in this repo already uses (P6-05's scan funnel, P6-07's report
funnel), rather than a Prometheus/OTel counter, since no
otel-collector can run in this sandbox:

- **`onboarding.connector_connect_started`** (new) — written in
  `GET /connectors/m365/connect`, only once the real OAuth config
  check has passed (a 503 here means nothing actually started).
- **`connector.consent_granted`** (already existed, P1-02/P6-04) —
  "first connector connected."
- **First case** — derived as `MIN(cases.created_at)` for the tenant;
  there is no dedicated `case.created` audit action (case creation is
  Go-side, `services/correlate`, which only audits `case.transition`
  entries, not a first-creation moment specifically), and adding one
  would mean touching that already-stable pipeline for a reporting-only
  need — out of this ticket's scope, disclosed rather than silently
  worked around.

A tenant with the "started" event but never the "connected" one is
this funnel's own concrete, queryable drop-off point
(`OnboardingFunnelSummary.droppedOffAtConnector`).

### T1's own honest scope

The ticket's own T1 label ("e2e") would mean driving a real browser
through the full Microsoft OAuth hop. That's impossible without a real
Entra app registration — the identical, already-disclosed gap every
M365-related test in this repo carries (see `m365-connector.
integration.test.ts`'s and `connectors.spec.ts`'s own doc comments).
`onboarding-funnel.integration.test.ts` proves the identical real HTTP
round trip (connect → callback) against the same mock Microsoft token
endpoint those existing tests already use, and asserts the funnel's
events land in `audit_log` in the right order — the established
substitute for this exact gap, not a new one invented here.

## In-product feedback

`feedback` (new table) attaches a rating to a `case` or a
`weekly_report` — `FeedbackWidget.client.tsx`, shown on both the case
detail page and each weekly report card. `POST /feedback` is
`read_only`-gated (surfacing your own experience is not a privileged
action, same bar every other read-adjacent write in this API sets).

## Tuning backlog

A false-positive report on a **case** automatically creates one
`tuning_backlog_items` row, in the same transaction as the feedback
itself (`FeedbackRepository.create`) — never a separate, skippable
step. The candidate `rule_id` is whichever rule this case's own FIRST
signal carries (a case can have signals from more than one rule; this
is a disclosed, simple heuristic, not a claim that it is always the
single responsible rule).

This is deliberately a **human-reviewed queue**, not an automatic
write to `suppressions` or `hotfix_rules` — false-positive feedback
queues a candidate for review; it never silently changes what the
detection engine does on its own.

## Pilot dashboard

`GET /ops/pilot` is gated identically to P6-10's own `/ops/margin`
(P2-12's `PLATFORM_OPS_TENANT_ID` pattern): the caller must be admin
of Sentinel's own designated operations tenant, not merely admin of
any customer tenant. No dashboard UI was built for this — the API
surface alone satisfies the AC, the same precedent `/ops/margin`
itself already established. It returns, per tenant: signup time, time
to first connector, time to first case, the drop-off flag, and
feedback/false-positive/open-tuning-backlog counts — computed live on
every call via a single cross-tenant query
(`listOnboardingFunnelSummaries`), the same "plain `pool.query`,
bypasses RLS for a platform-wide read" pattern `/ops/margin`'s own
`listTenantUsageSummaries` already established.

There is no separate "is this tenant a pilot customer" flag anywhere
in the schema — at this stage every tenant in this product effectively
is a pilot customer, so the dashboard shows every tenant rather than
inventing a new boolean column with nothing yet to distinguish.
