# Billing, plans, and usage metering (P6-10)

## Plan tiers

The three real pricing tiers (`tenants.plan`'s own CHECK constraint:
`msp`, `startup`, `small_business`, plus `trial`) are modelled in
`@sentinel/billing` (`packages/billing/src/index.ts`) with:

- **Seat and event-volume limits** (`PLAN_LIMITS`), each with an
  `allowance` (normal usage) and a separately-configured `hardCap`.
- **Modelled monthly revenue** (`PLAN_PRICING`) per tier — `trial` is
  $0.
- **Cost-per-day limits** (`costUsdPerDay`) that intentionally mirror
  `apps/analyst/src/cost-budget.ts`'s own `PLAN_BUDGETS` numbers by
  value (not a shared import — apps/api and apps/analyst are separate
  deployable processes, the same constraint every other wire-contract
  type in this repo is duplicated across). If these two ever drift,
  that's a real bug to fix by hand, not something either file enforces
  against the other.

An unrecognised plan tier always falls back to the MOST conservative
limits and to `trial` pricing — never the most permissive.

## Usage metering

`@sentinel/db`'s `TenantUsageRepository`:

- **Seats** = `COUNT(*) FROM memberships` for the tenant. One
  membership is one seat, by definition — there is no separate "seat"
  concept in this schema.
- **Event volume** = `COUNT(*) FROM case_signals` detected in the last
  24h. This is a **disclosed proxy**, not a silent approximation: true
  raw ingested-event counts live only in ClickHouse
  (`sentinel.events`), which cannot run in this sandbox (blocked S3/
  MinIO dependency, the same gap every P6 ticket touching ClickHouse
  has already hit). `case_signals` undercounts true event volume by
  whatever the detection pipeline's own signal-to-event reduction
  ratio is — the same ratio `services/correlate/internal/reduction`
  already tracks for its own `daily_reduction` metric in production.
- **Cost of goods** = the tenant's own metered LLM spend
  (`llm_usage.cost_usd`, already real, per-tenant data from P4-06).
  This is the dominant, and currently the ONLY measured, variable cost
  component — infrastructure/hosting cost-per-tenant is out of this
  ticket's scope, disclosed rather than estimated with an invented
  number.

## Margin

`computeMargin(plan, cogsUsd)` returns `revenueUsd - cogsUsd` and a
percentage, computed live by `GET /ops/margin` from
`listTenantUsageSummaries` (a single cross-tenant query, same
established "plain `pool.query`, bypasses RLS" pattern as
`listTenantsDueForWeeklyReport`/`listTenantsWithPendingDegradedCases`).
A `$0`-revenue tier (`trial`) reports `marginPct: null` rather than a
divide-by-zero artifact.

## Operations view

`GET /ops/margin` is gated identically to P2-12's own
`PLATFORM_OPS_TENANT_ID` pattern (`hotfix-rules.ts`): the caller must
be `admin`+ **and** acting as Sentinel's own designated operations
tenant, not merely admin of whatever customer tenant their session
happens to belong to. 503 if `PLATFORM_OPS_TENANT_ID` is unset, same
as every other optional integration in this API. No dashboard UI was
built for this view — the API surface alone satisfies the AC, the same
precedent `routes/suppressions.ts`/`routes/dismissals.ts` already
established for a "dashboard" acceptance criterion before a real UI
framework existed.

## Enforcement: graceful degradation, not a hard stop

`apps/api/src/plan-usage-sweep.ts` runs hourly (same in-process
`setInterval` convention as `weekly-report-scheduler.ts`), evaluates
every active tenant's seats/event-volume/cost against its plan's
limits, and persists the result (`tenant_plan_status`).

The sweep itself never blocks anything — it only evaluates and
records. The **one** concrete degradation this MVP implements:
`weekly-report-scheduler.ts` reads the latest recorded status before
sending a tenant's weekly report email, and skips the SEND (not the
report's own generation — the dashboard copy is unaffected) for any
tenant currently `hard_exceeded` on any axis.

This is a deliberately narrow, honest scope boundary: it pauses one
non-essential delivery channel, never detection, ingestion, or the
dashboard itself — reaching into `services/ingest` (Go, ClickHouse-
dependent) or `apps/analyst`'s own already-stable, heavily-tested
investigation worker would have been a much larger, riskier change
this ticket does not make.

## Notification

The sweep sends a one-time "approaching your plan's limit" email
(reusing `@sentinel/notifications`' `buildEmailChannel`, the same
mechanism `weekly-report-email.ts` already uses) the first time a
tenant's overall status becomes non-`ok`. It does not re-notify every
sweep while still in that same bad streak, but DOES notify again after
a tenant returns to `ok` and later re-exceeds a limit — tracked via
`tenant_plan_status.soft_notified_at`, cleared whenever a tenant's
status returns to fully `ok`.
