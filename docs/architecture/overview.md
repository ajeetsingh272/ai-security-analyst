# Architecture Overview

> Status: approved · Last updated: 2026-10-02 · Owner: Platform

This document explains how Sentinel is put together and, more importantly, why. Every
significant choice has a corresponding ADR in [`../adr/`](../adr/).

---

## 1. Design constraints

Four constraints drive the entire design. Everything else follows from them.

**C1 — Unit economics.** Cost of goods must stay under ₹1,800 per tenant per month against
₹4,000–30,000 of revenue. This forbids running an LLM over the event stream, forbids a
general-purpose OLTP database as the event store, and forbids per-tenant dedicated infra at
the entry tier.

**C2 — Trust is the product.** The buyer is a non-technical owner who cannot verify a
security claim. If the system is confidently wrong once, the account is lost. Every AI claim
must be mechanically traceable to a logged event.

**C3 — Alert fatigue is the failure mode of the incumbents.** The product is only
differentiated if fewer than 10 of every 100 raw signals reach a human. Noise reduction must
be deterministic and measurable, not an emergent property of a prompt.

**C4 — The AI is an availability risk.** A third-party LLM API is the least reliable
dependency in the system. Critical detection must not be on its critical path.

---

## 2. Scale model

The load unit is tenants × events/second. "A million users" means ~10,000 tenants averaging
100 monitored identities.

| Quantity | Derivation | Value |
|---|---|---|
| Identities | 10,000 tenants × 100 | 1,000,000 |
| Events/identity/day | M365 audit + sign-in + file + mail | ~500 |
| Events/day | | 500,000,000 |
| Sustained EPS | 500M / 86,400 | ~5,800 |
| Peak EPS | 5× business-hours concentration | ~30,000 |
| Raw bytes/day | 500M × ~1.2 KB | ~600 GB |
| ClickHouse hot (90d, ~12× compressed) | | ~4.5 TB |
| Signals/day | ~0.2% of events hit a rule | ~1,000,000 |
| Cases/day after correlation | ≥10:1 reduction | ~100,000 |
| LLM invocations/day | cases × 1.3 (triage + investigate) | ~130,000 |

That last row is the one that must be defended. 130,000 LLM calls/day across 10,000 tenants
is 13 calls per tenant per day. At tiered routing with prompt caching this lands inside C1.
If correlation ever stops reducing 10:1, the business model breaks before the architecture
does — which is why the reduction ratio is a monitored SLO, not an aspiration.

---

## 3. The seven planes

### 3.1 Connector plane

Per-source adapters that speak each vendor's audit API. All read-only wherever the vendor
offers a read-only scope.

| Source | API | Mode | Notes |
|---|---|---|---|
| Microsoft 365 | Management Activity API + Graph `auditLogs` | Poll (webhook for subscription notifications) | Content blobs are fetched by URL; blob IDs are the checkpoint |
| Google Workspace | Admin SDK Reports API | Poll | Cursor is `startTime` plus page token |
| AWS | CloudTrail to EventBridge to SQS | Push | Lowest latency source |
| Azure / Entra ID | Diagnostic settings to Event Hub | Push | |
| Firewalls / network | Syslog (RFC 5424) over TLS | Push | Only source requiring customer-side config |

Every connector implements one Go interface, so adding a source is additive work — no change
to ingest, detection or correlation.

```go
type Connector interface {
    ID() ConnectorID
    Fetch(ctx context.Context, cur Cursor) (Batch, Cursor, error)
    Normalise(raw RawEvent) ([]ocsf.Event, error)
    HealthCheck(ctx context.Context) error
}
```

**Checkpointing.** Cursors live in Postgres, committed only after the batch is durably
written to Kafka. The contract is at-least-once delivery; duplicates are collapsed
downstream by ClickHouse `ReplacingMergeTree` keyed on `(tenant_id, event_id)`. Exactly-once
across a vendor API boundary is not achievable, so we make duplicates harmless instead of
pretending to prevent them. See [ADR-0010](../adr/0010-checkpoint-after-kafka-ack.md).

**Back-pressure.** A tenant that suddenly emits 50× its normal volume — usually a
misconfiguration, occasionally an attack — must not starve other tenants. Per-tenant token
buckets in Redis throttle fetch rate, and overflow spills to the archive bucket for later
replay rather than being dropped.

### 3.2 Normalisation plane — OCSF

All events are normalised to the **Open Cybersecurity Schema Framework** before they touch
the stream. See [ADR-0002](../adr/0002-ocsf-event-schema.md).

The alternative — a homegrown schema — looks cheaper for the first two connectors and is
ruinous by the tenth. OCSF gives us a published mapping target for every major vendor, makes
the open Sigma rule corpus usable with a thin field-mapping layer instead of a rewrite, and
means a future "export to the customer's SIEM" feature is a serialisation change rather than
a project.

Normalisation is pure and total: `(RawEvent) -> ([]ocsf.Event, error)`, no I/O, no clock, no
network. That makes every mapping exhaustively testable from a recorded fixture, which is
how connector correctness is actually verified.

### 3.3 Stream plane — Redpanda

Kafka API, no ZooKeeper, single binary, roughly a third of the operational cost of running
Kafka ourselves at this size. See [ADR-0003](../adr/0003-redpanda-over-kafka.md).

| Topic | Key | Partitions | Retention |
|---|---|---|---|
| `events.raw` | `tenant_id` | 64 | 24 h |
| `events.normalized` | `tenant_id` | 128 | 72 h |
| `signals` | `tenant_id:entity_id` | 32 | 7 d |
| `cases` | `tenant_id:case_id` | 16 | 30 d |
| `actions` | `tenant_id:case_id` | 8 | 30 d |
| `alerts.critical` | `tenant_id` | 8 | 30 d |
| `*.dlq` | — | 4 | 30 d |

Partitioning by `tenant_id` preserves per-tenant ordering, which correlation depends on.
It also creates the classic hot-partition risk: one 5,000-seat tenant on a 128-partition
topic can pin a single consumer. The mitigation is a **hot-tenant split** — tenants over a
configured EPS threshold are re-keyed to `tenant_id:shard_n`, and their correlation windows
are merged downstream. The threshold and the merge are implemented in Phase 7; the key
format carries the shard suffix from day one so the change is non-breaking.

### 3.4 Event store plane — ClickHouse writer

`services/eventwriter` consumes `events.normalized` and writes to
`sentinel.events` (ADR-0005) in batches, never per-row — the batch sizing
respects whichever of a row-count or a time-window trigger fires first, so
a low-volume tenant's events still land within a bounded delay rather than
waiting indefinitely for a batch to fill. Kafka offsets commit only after
ClickHouse acknowledges the batch durably, mirroring the connector plane's
own checkpoint discipline (ADR-0010) one layer downstream: a crash between
consume and commit replays, never loses, the same at-least-once contract
Detection and ClickHouse's `ReplacingMergeTree` already have to tolerate
regardless.

A single malformed row (a schema violation ClickHouse itself rejects) is
routed to `events.normalized.dlq` rather than retried forever — found
operationally, not designed in advance: an early version retried the whole
batch on any row's failure, which meant one bad row blocked every other
tenant's events behind it indefinitely. The write path is otherwise a plain
batched insert; merge queue depth (`system.parts`/`system.merges`) is
polled and exported as a metric so sustained merge pressure is visible
before it becomes a query latency problem, not after.

### 3.5 Detection plane

Two distinct engines, because one engine cannot do both jobs well.

**Stateless, in-stream (Go).** Sigma rules are **compiled to a Go AST at build time**, not
parsed at runtime. See [ADR-0004](../adr/0004-sigma-compiled-ast.md). Runtime YAML
interpretation costs roughly an order of magnitude more CPU per event; at 30k EPS that is
the difference between three nodes and thirty. The compiler emits a decision tree with
field-indexed predicates so an event is tested against the ~150-rule corpus in a handful of
map lookups rather than 150 independent evaluations.

**Stateful, windowed (ClickHouse).** Impossible travel, brute force, mass download, and
anomaly-vs-baseline rules need a join against history. These run as parameterised ClickHouse
queries on a schedule (30 s to 15 min depending on rule class). Attempting these in a stream
processor means rebuilding a time-series database badly; ClickHouse already is one.

Every rule, in either engine, carries a mandatory MITRE ATT&CK technique ID. CI rejects an
unmapped rule. This is not bureaucracy — the technique ID is what the customer-facing report
cites, and it is what makes the output defensible to the customer's auditor.

**Emergency hotfix rules (services/detect/internal/hotfix, P2-12).** ADR-0004's own named
escape hatch: a small interpreted rule path for urgent detections, capped at 10 active rules
platform-wide and expiring automatically after 7 days with no option to extend in place (the
expiry is enforced by a Postgres trigger, `0008_hotfix_rules.sql`, not application convention —
no INSERT or UPDATE can set `expires_at` to anything other than `created_at + 7 days`).
Evaluation reuses `sigmac.Evaluate`, P2-02's own reference interpreter (the correctness oracle
codegen tests already check the compiled path against) — this package is the plumbing that
feeds it rules sourced from Postgres instead of the committed corpus, not a second interpreter.
A hotfix rule is in-stream only; `Evaluate` ignores `Aggregation` entirely, so a rule declaring
one is rejected at load time rather than silently degraded. Not tenant-scoped — the cap is a
single global count across every tenant combined (`hotfix_rules` carries no `tenant_id`, the
same shape `tenants`/`users` themselves use). "Creating one requires an elevated role" resolves
a real gap: every RBAC role in this system is tenant-scoped, and letting any customer's own
`admin` create a rule affecting every tenant's detection would be a cross-tenant boundary
violation — the fix pins creation to a single designated operations tenant
(`PLATFORM_OPS_TENANT_ID`) rather than inventing a new access-control axis, and audits every
denied attempt, not only successful ones.

**Load testing (services/detect/internal/loadtest, P2-11).** A Go harness — not k6, following
this repo's own established Go-based load/soak convention (go/soaktest, go/sentinelevents/loadtest)
rather than a new JS toolchain — drives real `Worker` instances at a configurable EPS for a
configurable duration, measuring real end-to-end latency (produce time -> `Signal.DetectedAt`,
with no change needed to the hot path itself) and tracking goroutine/heap samples throughout
(`go run ./services/detect/cmd/loadtest -eps=30000 -duration=1h`). A CI-feasible, reduced-scale
profile runs automatically on every PR (its own `loadtest` build tag, run sequentially rather
than alongside the rest of the integration suite — concurrent production at this volume was
proven, directly, to make unrelated tests on the same shared Redpanda intermittently see
duplicate/delayed signals), comparing P50 latency and achieved EPS against a committed baseline
and failing the build on a >10% regression.

Only the in-stream engine is measured — "p99 under 100ms" cannot describe the windowed engine
by construction (its own schedule interval IS 30s-15min). On real infrastructure, sustained 30k
EPS measured p99 around 115-120ms, above the ticket's own 100ms target; P50 (the gate's own
metric) stayed in the tens of milliseconds. This is a genuine finding, not a gap this ticket
silently closed — see the P2-11 PR/issue for the full numbers and the open question of whether
ADR-0010's per-poll-batch commit discipline (traded latency for the crash-safety guarantee
P2-04 established) is itself the tail's dominant cost, which would make this a deliberate,
already-reviewed trade-off showing up for the first time in a real measurement, not a bug.

**The critical bypass.** Rules with `level: critical` publish to `alerts.critical` *directly*
(go/sentinelstream.CriticalAlerts), in parallel with the same signal entering `signals` for
correlation — the same producer client, two independent publishes, neither one gated on the
other's success. If the LLM, correlation, or the whole analyst plane is down, a critical
detection still reaches the customer — degraded to the rule's own `owner_description` (P2-06)
instead of an AI narrative. This satisfies constraint C4 and product guarantee #4 (SECURITY.md).
Both paths carry the same deterministic dedupe key (go/sentinelsignal.Signal.DedupeKey) so a
downstream notifier can collapse a bypass alert and its later AI-investigated counterpart into
one customer-facing notification once that notifier exists.

**Threat-intel enrichment (go/sentinelenrich).** A sign-in's `ClientIP` is resolved against
locally cached feeds — the Tor Project's own bulk exit list, X4BNet's maintained VPN/datacenter
CIDR ranges, and GeoLite2-derived country/ASN tables (sapics/ip-location-db) — refreshed on a
24h schedule and written to disk, so a lookup is always an in-memory map/range search, never a
network call. A feed outage leaves the previously loaded data in place (stale, not silently
empty) and raises an alert rather than degrading detection. Attached only on the in-stream path
today, before dispatch; a windowed rule's own query reads ClickHouse history that does not yet
persist this data, which is why `impossible-travel.yml`'s own true geo-velocity check remains a
documented follow-up rather than something this ticket completed.

**Suppression and allowlisting (services/detect/internal/suppression, TG3).** An analyst can
suppress a noisy rule — scoped to a tenant, a rule, and either one entity or every entity
(`suppressions`, `db/postgres/migrations/0006`) — with a mandatory reason (`apps/api`'s own
`POST /suppressions` rejects a blank one) and a bounded lifetime (expires by default; renewing
records a fresh reason rather than silently extending the old one). A suppressed signal is
**never dropped**: it still publishes to `signals` exactly as any other, with `Suppressed` and
`SuppressionID` disclosed on the record itself (never a silent hole in coverage) — the
suppression only ever gates the critical bypass above, skipping escalation for that one signal
while leaving every other rule's bypass, and the normal signal, untouched. The check
(`suppression.PostgresChecker.IsSuppressed`) fails *open*: if Postgres is unreachable, nothing is
suppressed, deliberately — the same "no dependency that can silence a critical alert" principle
TG4 already established. Each match atomically increments the suppression's own
`suppressed_count` (`0007_suppressions_suppressed_count.sql`), since nothing yet persists
`signals` anywhere queryable — this is the dashboard's honest answer, today, to "what has this
suppression actually suppressed."

### 3.6 Correlation plane

This is the component that makes the product viable, and it contains no AI.

Signals are resolved to **entities** — identity, host, IP, session, mailbox. An entity
resolver maintains aliases (a user's UPN, object ID, and email are one entity). Signals
sharing an entity within a sliding window (default 60 min, per-rule override) are clustered
into a **Case**.

A case has a lifecycle: `open → triaging → investigating → awaiting_approval → actioned →
closed`, with `dismissed` reachable from triaging and investigating. State transitions are
append-only events in Postgres, so the full history of a case is reconstructible — required
for the audit guarantee.

Cases are scored before the LLM sees them: entity criticality (is this the CFO?), signal
count, highest constituent severity, MITRE kill-chain progression (a case spanning Initial
Access *and* Persistence outranks two separate cases), and tenant baseline deviation. Only
cases above a threshold are escalated to investigation; the rest are triaged by the cheap
model or auto-closed by rule.

**The 10:1 SLO.** `signals_in / cases_escalated` is emitted as a metric per tenant per day
and alerted on. If it degrades, that is a product incident, not a tuning task.

### 3.7 AI analyst plane

A TypeScript worker consuming the `cases` topic. See
[ADR-0006](../adr/0006-llm-tiering-and-grounding.md).

```
case → build context → triage (Haiku 4.5) ──dismiss──▶ daily digest (never silent)
                             │
                          escalate
                             ▼
                    investigate (Opus 5) with tools:
                      query_events(tenant, filter, window)
                      get_entity_baseline(entity, metric)
                      lookup_threat_intel(indicator)
                      get_case_history(entity)
                             ▼
                    structured JSON verdict
                             ▼
              ╔══════════════════════════════════╗
              ║  EVIDENCE GROUNDING VALIDATOR    ║
              ║  every claim.evidence_ref must   ║
              ║  resolve to a real event_id in   ║
              ║  ClickHouse for this tenant      ║
              ╚══════════════════════════════════╝
                      pass ─▶ alert     fail ─▶ retry once ─▶ fail ─▶ rule-only alert
```

**Tiered routing** controls cost: the triage model is cheap and handles the majority that
get dismissed; the investigation model is expensive and sees only what survives. The tenant
context block (org profile, baselines, prior cases, rule descriptions) is identical across
calls for a tenant and is **prompt-cached**, which is the single largest cost lever in the
system.

**The grounding validator is the trust mechanism and it is ordinary code.** The model returns
claims as `{ text, evidence_ref: event_id[] }`. The validator re-queries ClickHouse for each
referenced ID, scoped to the tenant, and confirms it exists and is within the case window.
Any unresolvable reference fails the whole report. The model is never asked to self-certify
and is never trusted to. A prompt that says "do not hallucinate" is not a control; a query
that returns zero rows is.

Failure is explicit, never silent: a report that cannot be grounded twice degrades to a
rule-only alert and pages the on-call. We would rather ship a terse true alert than a fluent
false one.

### 3.8 Response plane

Alerts go to WhatsApp (Meta Cloud API), Slack, and email, carrying an **Approve** action.

The approval token is signed, bound to `(case_id, action_id, tenant_id)`, single-use, and
expires in 15 minutes. Approving a stale or replayed token fails closed. See
[ADR-0007](../adr/0007-approval-tokens-and-audit.md).

Actions are playbooks (`disable_user`, `revoke_sessions`, `delete_inbox_rule`,
`block_ip`, `force_password_reset`, `isolate_device`), each idempotent and each with a
declared blast radius and a reversal procedure. Default is approval-required for everything.
A tenant may pre-approve specific low-risk actions — their choice, recorded in the audit log,
revocable.

The **audit log** is append-only and hash-chained: each entry includes the hash of its
predecessor, so a deletion or edit is detectable. The application role has no `UPDATE` or
`DELETE` grant on that table. Tamper-evidence is a schema property, not a convention.

---

## 4. Data stores

| Store | Holds | Why it, specifically |
|---|---|---|
| **ClickHouse** | Normalised events, signals, aggregates | Columnar, 10–15× compression, sub-second scans over billions of rows, ~1/10 the cost of a row store for this access pattern. Writes are append-only and reads are analytical — the exact shape ClickHouse is built for. |
| **Postgres 16** | Tenants, users, connectors, cases, approvals, audit, billing | Transactional, relational, with row-level security for tenant isolation. Small, high-value, high-integrity data. |
| **Redis / Valkey** | Dedup keys, rate limits, cursor cache, locks, sessions | Sub-millisecond, ephemeral, reconstructible. Nothing here is a source of truth. |
| **S3 / MinIO** | Raw log archive, cold events, generated reports | Compliance retention and replay. Lets us re-run a new detection rule against historical data — the mechanism behind the free "10-minute scan". |

Hot/cold tiering: ClickHouse keeps 90 days on local NVMe and ages older partitions to S3 via
a storage policy. Queries span both transparently; only latency changes.

---

## 5. Multi-tenancy

Shared infrastructure, hard isolation, with an escape hatch for large tenants.

1. **Every row carries `tenant_id`.** No exceptions, including audit and metrics.
2. **Postgres row-level security** is enabled on every tenant-scoped table. The application
   connects as a role that cannot bypass RLS, and sets `app.tenant_id` per transaction. A
   forgotten `WHERE tenant_id = ?` returns zero rows instead of leaking another customer's data.
3. **ClickHouse row policies** enforce the same at the event store.
4. **Per-tenant envelope encryption** for connector credentials: a tenant DEK wrapped by a
   KEK in KMS. A database dump without KMS access yields nothing usable.
5. **Isolation is tested, not assumed.** A standing integration test provisions two tenants,
   writes data as each, and asserts cross-tenant reads return empty across every API surface.
   It runs on every PR.

Enterprise tenants can later be pinned to a dedicated ClickHouse shard and consumer group.
The routing indirection exists from day one; the dedicated deployment is Phase 7 work.

---

## 6. Failure model

| Failure | Behaviour | Guarantee preserved |
|---|---|---|
| Connector API down | Exponential backoff, cursor held, connector health degraded in UI | No data loss — vendor retains audit history |
| Redpanda partition unavailable | Ingest buffers to disk, then sheds to S3 archive for replay | No data loss |
| ClickHouse unavailable | Ingest continues to Kafka; windowed rules pause; in-stream rules unaffected | Critical alerts still fire |
| **LLM API down** | **Triage and investigation pause; critical rule bypass alerts directly** | **Customer still warned** |
| Grounding validation fails twice | Degrade to rule-only alert, page on-call, case flagged for human review | No unsourced claim ever shown |
| Notification channel down | Failover WhatsApp to Slack to email to dashboard banner; retry with backoff | Alert eventually delivered |
| Response action fails | Case returns to `awaiting_approval`, error surfaced with manual steps | Never silently "fixed" |

Every row in this table has a corresponding chaos or integration test. A documented failure
mode without a test is a guess.

---

## 7. Observability

OpenTelemetry throughout, traced end to end on a `trace_id` propagated from the ingested
event to the delivered alert — so "why did this alert take 4 minutes?" is answerable in one
query.

**Golden signals:** ingest lag (per tenant, per connector), EPS, detection evaluation
latency p50/p95/p99, signal-to-case reduction ratio, LLM cost per tenant per day, grounding
rejection rate, alert delivery latency p95, action success rate.

**Alert on:** ingest lag > 5 min, p95 alert latency > 3 min, reduction ratio < 8:1,
grounding rejection > 2%, LLM spend > 1.5× the tenant's plan allowance, any DLQ growth.

Grounding rejection rate deserves particular attention: a rising number means either the
prompt has drifted or the model has changed under us. It is the canary for the product's
central promise.

---

## 8. What is deliberately not being built

Honest scope boundaries, so they are decisions rather than omissions.

- **No endpoint agent.** API-only is a core selling point ("nothing installed"). It costs us
  process-level telemetry. Accepted — Phase 7 may integrate an existing EDR instead.
- **No custom ML anomaly detection.** Statistical baselining only. Supervised models need
  labelled incident data we do not have. Revisit once the pilot has produced a labelled corpus.
- **No automatic response without approval, by default.** Slower, and the correct default for
  a product whose buyer cannot assess a false positive.
- **No on-premise deployment.** Multi-tenant SaaS only until there is a contract that pays for
  the second deployment model.
- **No SIEM replacement positioning.** We are the analyst, not the log warehouse. Fighting
  Splunk on retention is a losing trade.

---

## 9. Related documents

- [Data model](./data-model.md) · [API contracts](./api-contracts.md) ·
  [Threat model](./threat-model.md) · [Detection engineering](./detection-engineering.md)
- [ADR index](../adr/README.md) · [Roadmap](../roadmap.md) ·
  [UI/UX specification](../design/ui-ux-spec.md)
