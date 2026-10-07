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

See [`docs/detection-engineering-guide.md`](../detection-engineering-guide.md) for how to write,
map, fixture and tune a rule — written for a new detection engineer, not this document's own
architectural level of detail.

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

**Entity resolution (`services/correlate/internal/entity`, P3-01, ADR-0011).** Tenant-scoped
(identical identifiers in two different tenants never merge — `entities`/`entity_aliases`/
`entity_merges`, full RLS). Aliases known *together* on one signal's own event are the
evidence they name the same person: if they already point at more than one existing entity,
the resolver auto-merges them, attributed to the system. A signal with no identifying
information at all still resolves to a **provisional** entity, never an error — nothing is
ever discarded for lack of identity data. A merge is reversible and audited — not through
`packages/db`'s TypeScript hash chain (which Go has never written to; porting its canonical-
JSON encoding was rejected as its own, separate piece of work, not a P3-01 side effect), but
through `entity_merges`' own append-only record of exactly which aliases moved, so a reversal
is exact rather than "undo everything currently on the target entity." Resolution is a single
Postgres transaction per call (`FastResolver`) — proven directly at under 5ms p99 against real
Postgres with a realistic 1-new-user-in-20 traffic mix, not assumed from the design alone.

**Signal clustering (`services/correlate/internal/cluster`, P3-02).** Consumes `signals`
directly (the first live consumer that topic has had) and clusters by `Signal.EntityType`/
`EntityID` — deliberately not routed through the entity resolver above for this ticket: AC2's
own wording is "signals sharing *any* entity", which the raw identifier `services/detect`
already extracts and places on the signal (both engines now populate it — an in-stream
signal's own `UserId`, when its event has one, not only a windowed rule's group-by key).
Unifying different raw formats for the same person (a UPN and an object id) through the alias
graph is real, separate integration work this ticket's own ACs do not require. A case's
window is **sliding**, not fixed: it stays open as long as signals keep arriving within the
window of the *most recent* one (not the first), closed only once a configurable quiet period
elapses with nothing new — every decision uses the signal's own event time, never wall-clock
processing time, which is what makes replay genuinely deterministic (AC5/T4): replaying the
identical stream faster or slower, or twice, produces the identical case set, proven directly
rather than assumed, including the real BEC scenario (impossible travel, then an inbox rule
three minutes later, same person) collapsing into exactly one case. `cases`/`case_transitions`
(`db/postgres/migrations/0001_foundation.sql`) already had the right shape for this ticket;
only a new `case_signals` join table was needed, to know *which* signals are in a case at all
— without it, idempotent replay has nothing to check a signal's membership against.

A case has a lifecycle: `open → triaging → investigating → awaiting_approval → actioned →
closed`, with `dismissed` reachable from triaging and investigating, and a failed response
action returning `actioned → awaiting_approval` (§6's failure-mode table). One further edge
exists outside that main path: `open → closed` directly, for a case that quiets out before
anything ever triages it — the same "quiet period elapsed" case P3-02's clustering already
produces. State transitions are append-only events in Postgres, so the full history of a case
is reconstructible — required for the audit guarantee.

**Case lifecycle (`services/correlate/internal/lifecycle`, P3-03, TG6).** The legal-transition
graph above is enforced in one place, `IsLegalTransition`, not re-checked ad hoc at each call
site; an illegal transition is rejected before anything is written. `Writer.Transition` appends
the `case_transitions` row and its `go/sentinelaudit` audit entry inside the *same*,
caller-provided transaction — so a transition and its audit record commit or roll back
together, never one without the other. `go/sentinelaudit` is itself a Go port of
`packages/db`'s TypeScript hash chain (`SHA256(prevHash || canonicalJSON(content))`, same 8
hashed fields, same genesis hash) — the thing P3-01's own entity-merge audit trail had
deliberately deferred porting, now done once, properly, and proven cross-language: entries
written entirely by the Go writer pass the real TypeScript `verify-audit-chain.mjs` CLI
unmodified. Both transitions `cluster.PostgresStore` already wrote before this ticket (`open`
on case creation, `closed` on quiet timeout) now go through this same writer, so every
case transition in the system — not only ones added after this ticket — is legality-checked
and audited.

**Case scoring (`services/correlate/internal/scoring`, P3-04).** Cases are scored
deterministically before the LLM sees them, from five components that always sum to exactly
the stored total (so a score is explainable after the fact, not just a number): entity
criticality, signal count, highest constituent severity, MITRE kill-chain progression, and
tenant baseline deviation. Kill-chain progression counts *distinct ATT&CK tactics* across a
case's signals, via `go/sentinelattck` — a case spanning Initial Access *and* Persistence
outranks two single-stage cases with the same signal count. `go/sentinelattck` is
`services/detect/internal/attck`'s own pinned technique catalogue, moved to a standalone
module in this ticket: Go's `internal/` visibility rule meant `services/correlate` could
never import it directly, and duplicating an 8800-line pinned data file across two modules
was the wrong fix — `services/detect/internal/attck` now re-exports this shared module's
symbols under their original names, with zero behaviour change (its own full test suite
passes unmodified). Entity criticality is a `high`/`normal` flag keyed by the same raw
`(tenant_id, entity_type, entity_id)` pair `cases`/`case_signals` already use, not by
`internal/entity`'s own resolved identity graph — unifying those two identity
representations remains the separate, not-yet-done integration work P3-02's own notes
already named. Tenant baseline deviation is a named component that always contributes 0 for
now — a deliberate placeholder for P3-05 ("Entity baselines for anomaly context"), not a
silent omission. The escalation threshold is a small, reviewable table keyed by tenant plan
tier, keyed by `tenants.plan`'s own real values (`msp`, `small_business`, `startup`, `trial` —
an MSP tenant escalates soonest), not yet exposed as a per-tenant override. A
case's score is recomputed from its *entire* current signal set every time a signal joins
it, in the same transaction as that signal's own write — recomputing from scratch rather
than patching incrementally is what keeps the stored score consistent with Score's own
determinism guarantee, with no accumulated-drift path to get wrong.

**Entity baselines (`services/correlate/internal/baseline`, P3-05).** Per-entity behavioural
baselines — usual countries, ASNs, devices, sign-in-hour distribution, typical data-transfer
volume — computed from `sentinel.events` into `sentinel.entity_baselines`
(`AggregatingMergeTree`, already shaped for this in P1-06), merged over a rolling 30-day
window. Below a minimum-observation floor a baseline is explicitly `Valid: false` — never
silently treated as "nothing unusual" *or* "everything is anomalous" — so a new hire's first
week never generates an anomaly purely from novelty. Recomputation is incremental: a Postgres
watermark (`baseline_cursors`, mirroring `connector_cursors`' own role) tracks what has
already been folded in per tenant, and each run only reads/writes events since that point —
proven to produce the identical merged result a full rescan would, since ClickHouse's own
aggregate-state merge combinators guarantee it. `GetBaseline` is, deliberately, the future
`get_entity_baseline(entity, metric)` investigation tool named in §3.7, built ahead of any
tool-calling framework existing to invoke it (none exists anywhere in this repo yet) — a
plain, well-documented function a later phase wires in, not a framework this ticket invents.
P3-04's own `baselineDeviation` score component is still the documented 0 placeholder after
this ticket, not wired to a real value: doing so needs per-signal geography/device context
(`go/sentinelsignal.Signal` carries neither today), a separate wire-format change outside
this ticket's own scope — `GetBaseline` gives scoring something real to deviate against, but
connecting the two is still open, future work.

**The 10:1 SLO (`services/correlate/internal/reduction`, P3-06, TG3).**
`signals / cases_escalated` is computed per tenant per day
(`services/correlate/internal/reduction`) and exported as the `correlate_reduction_ratio`
Prometheus gauge; Grafana alerts when it drops below 8:1
(`infra/docker/grafana-provisioning/alerting/reduction-ratio.yml`), visible platform-wide and
per-tenant on its own operations dashboard. `signals` is a count of every `case_signals` row
for the day — deliberately with no suppression-status filter of any kind: TG3 ("nothing is
hidden") means a suppressed signal (still stored and counted since P2-10) cannot quietly fall
out of the denominator to make the ratio look healthier than it is. `cases_escalated` uses
P3-04's own `scoring.EscalationThreshold` for that tenant's plan tier, which is why this
ticket depends on P3-04 specifically. The historical record lives in ClickHouse's own
`sentinel.daily_reduction` (pre-built by P1-06) for backfill and trend analysis — a dedicated
CLI (`cmd/backfill-reduction`) reuses the identical counting logic the live daily sweep uses,
over any explicit date range, idempotently (a rerun deletes any existing row for that
tenant/day first, since the table's own `SummingMergeTree` engine would otherwise double-count
a repeated insert). A tenant with zero signals that day reports nothing to the gauge at all,
rather than a misleading ratio of 0 — a quiet tenant is not a degraded one. A genuine
degradation (as opposed to a single noisy rule caught and suppressed the same day) is
documented as a product incident, not a tuning task — see
[`docs/runbooks/reduction-ratio-degraded.md`](../runbooks/reduction-ratio-degraded.md).

**Dismissed-signal digest (P3-07, TG3).** Every non-escalated case carries a machine-readable
dismissal reason, never free prose — `below_escalation_threshold` today, the one reason this
phase's own machinery can produce (`cluster.CloseQuietCases` now dismisses a case whose score
never crossed the threshold, rather than merely closing it; a case that DID escalate still
closes exactly as before — it was never hidden to begin with). `dismissed` is no longer a
terminal lifecycle state: `dismissed → triaging` is a new legal edge
(`services/correlate/internal/lifecycle`) specifically for a human challenging an
auto-dismissal, which reopens the case and writes its own audit entry — the identical AC5
("transition and audit entry in the same transaction") P3-03 already established, now also
true from TypeScript (`CasesRepository.challengeDismissal`, `apps/api`'s own
`POST /cases/:id/challenge`), via `writeAuditEntryTx` — `AuditLogWriter.insert`'s own
transactional core, extracted so a caller already holding a transaction can write an audit
entry inside it rather than opening a second one. No signal or case is ever deleted: a
dismissal is an append-only transition like every other, so a case's full history —
including every past dismissal and every challenge — is always reconstructible. The digest
itself (`GET /dismissals/digest`) is retrievable through the API for any tenant and day;
`apps/dashboard` has no real UI framework yet (the same gap `routes/suppressions.ts` already
documents for its own dashboard requirement), so the API response is the real, tested
deliverable here, not a placeholder standing in for a UI that doesn't exist.

**Noise-ratio replay harness (`services/correlate/internal/noiseratio`, P3-09).** The P3 exit
criterion — 10:1 signal-to-case reduction — as an executable test: a reference week of
signals (benign noise that *should* cluster into low-scoring cases, benign noise that stays
isolated and still must not escalate, and one seeded BEC-shaped attack sequence) replayed
through the real `cluster`/`scoring`/`lifecycle` packages against real Postgres, then measured
with `reduction.Ratio` itself — the identical function the production SLO job uses, so this
test and that job can never quietly disagree about what "the ratio" means. Deliberately
replays signals directly (`[]cluster.Signal`), not through Kafka or `services/detect`'s own
rule engine like `go/sentinelreplay` (P1-09) does for raw events — this harness's own claim is
about correlation's behaviour at a realistic mix and scale, already-covered territory (Kafka
delivery, rule matching) is not re-proven here. Runs at two scales: `Reduced` (~80 signals) on
every PR, inside the normal `go test -tags=integration ./...` sweep; `Full` (~900 signals, a
closer approximation of a real week) nightly only, behind its own `noiseratio_full` build tag
(mirroring P2-11's own `loadtest` tag split, for the identical "too slow for every PR, still
worth running regularly" reason) — `.github/workflows/noise-ratio-nightly.yml`. Building this
harness is also what caught a real, previously-undetected bug: `scoring.PlanTier`'s own
`pro`/`enterprise` constants never matched `tenants.plan`'s real CHECK constraint (`msp`,
`startup`, `small_business`, `trial`) at all — every non-trial tenant's escalation threshold
had silently been falling through to the conservative default since P3-04. Fixed at its
source (`scoring/threshold.go`), caught only because this test inserts a real tenant against
the real schema rather than a synthetic one.

**Hot-tenant sharding readiness (P3-10).** §3.3's own "correlation windows are merged
downstream" claim, made concrete: neither `services/detect`'s worker nor this plane's own
consumer loop (`cmd/correlate/main.go`) ever reads a Kafka message's *key* — only its JSON
value — so the `tenant_id:shard_n` re-keying Phase 7's hot-tenant split applies to
`events.normalized` never reaches `cluster.Signal` or `Clusterer` at all; clustering already
keys purely on `(tenant_id, entity_type, entity_id)`, with no shard dimension to merge in the
first place. `go/sentinelstream.ParseTenantShardKey` (`TenantShardKey`'s own inverse) exists so
that claim stays true on *purpose*, not by accident — the one place shard-suffix parsing is
defined, ready for whatever Phase 7 code eventually needs it, with nothing in today's pipeline
calling it. Locked in with regression tests that simulate a tenant crossing the sharding
threshold mid-stream (two signals for the same entity, keyed as if produced before and after
the split) and confirm they still join one case, against both `InMemoryStore` and real
Postgres — so Phase 7's own hot-tenant split can be a configuration change there, not a
correlation-plane redesign.

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

**The worker skeleton (`apps/analyst`, P4-01).** Consumes `cases` — correlation
(`services/correlate`, P4-01's own other half) now publishes there the moment a case's score
first crosses its tenant's escalation threshold, closing the gap that existed through all of
P3: nothing had ever produced to that topic before. Per-tenant concurrency is a plain
in-process limiter (`TenantConcurrencyLimiter`), not Kafka partition assignment — one
partition can carry many tenants' cases, so the limit has to be enforced at the application
layer regardless of how partitions are assigned. A transient provider failure (Anthropic's own
529 "overloaded", 429, or any 5xx) retries with full-jitter exponential backoff; a permanent
one (or a transient one with its retry budget exhausted) routes to `cases.dlq` and logs a
paging-level alert — the same honestly-scoped "a real alert, not a dedicated paging
integration" shape this repo already uses for its scheduled-workflow alerts. Shutdown drains
every in-flight investigation before disconnecting, proven directly: a dedicated test holds an
investigation open with a gate and asserts `stop()` does not resolve until that gate releases.
Every stage (`case.fetch`, `case.llm_investigation`, `case.investigate`) emits a real span,
verified against this dev stack's own Jaeger, not merely that the OTel API was called — an
early version of that same test called `startActiveSpan` without ever having called
`startTracing()` first, which runs against a no-op tracer and emits nothing at all; caught by
actually querying Jaeger rather than trusting the call site.

The actual investigation step is deliberately minimal: one model call (now with real tool use,
P4-02 below), no tiered routing (P4-05), no prompt caching (P4-05), and only a shape check on
the response (full parsing/validation is P4-03/P4-04) — just enough to prove the worker
skeleton produces *a* `Verdict` (`packages/schema`'s own frozen contract) end to end. No real
`ANTHROPIC_API_KEY` is configured in the dev sandbox this was built in, so the integration
tests substitute a fake `InvestigationModel` at that one seam — every other part of the
pipeline (Kafka consumption and offset commits, Postgres case lookup, concurrency, retry, DLQ
routing, tracing, graceful shutdown) runs against this project's own real infrastructure the
same as everywhere else.

**The investigation tools (P4-02).** Four tools the model can call mid-investigation:
`query_events` and `get_entity_baseline` read ClickHouse directly (`sentinel.events`,
`sentinel.entity_baselines` — `apps/analyst` is this repo's first TypeScript ClickHouse
client; every other reader/writer is Go's clickhouse-go); `get_case_history` reads Postgres
through the same `CasesRepository`/`withTenantContext` the worker already uses;
`lookup_threat_intel` is an honest stub — a repo-wide search found no real threat-intel source
anywhere, so it returns a structured "not configured" result rather than a fabricated match.
None of the four ever accept a tenant id from the model; `tenantId` comes only from the
worker's own trusted `CaseContext`. The ClickHouse tools get real defense in depth, not just an
application-layer `WHERE tenant_id = ...`: they connect as `sentinel_query_user`, the role
`db/clickhouse/0002_hot_cold_tier_and_row_policy.sql`'s `tenant_isolation` ROW POLICY is scoped
to, with `SQL_app_tenant_id` set per query — the exact mechanism `scripts/verify-setup.sh`'s
own P1-06 T2 already proves blocks a cross-tenant read, now exercised by real application code
for the first time. Every tool call is timed, bounded (an oversized result is truncated with
an explicit `truncated` flag, never silently cut), and never throws — a timeout, a bad
argument, or a query failure all become a structured `{error, code, message}` result the model
reads like any other tool result, logged with its arguments either way for replay. The model's
tool-use loop in `investigation-model.ts` is capped at a fixed number of round-trips so a case
that never converges on an answer fails loudly rather than looping (and spending) forever.

**Structured verdict validation (P4-03).** The model's final JSON response is checked against
the Verdict contract for real (`verdict-validation.ts`) — not the duck-typed shape check P4-01
shipped as a placeholder: severity is constrained to its five-value enum, every claim must cite
at least one non-empty `evidenceRef` (an unverifiable claim is rejected here, before the
grounding validator, P4-04, would otherwise re-query the event store for nothing), and every
recommended action's `playbook` is checked against a known-identifier list
(`playbook-registry.ts`). That list is deliberately NOT the real playbook registry — P5-05
("Response playbook registry and executor") owns blast radius, required scopes, step-up
requirements, reversal procedures, and the actual executor; this is only validation, using the
exact six identifiers P5-05's own ticket already names, not invented ahead of that design. A
validation failure (malformed JSON or any schema violation) gives the model exactly one
corrected attempt — the failure is fed back as a plain-language message listing every problem
found in one pass — before the investigation fails outright; a second consecutive failure is
treated the same as `UnparsableVerdictError` always has been, non-retryable.

**Evidence grounding (P4-04, TG1).** "The mechanism the entire product promise rests on," per
the ticket's own description, and deliberately deterministic code, never a model self-check:
every `evidenceRef` a schema-valid Verdict cites is re-queried against `sentinel.events`
(`grounding.ts`), through the exact same `sentinel_query_user` row-policy mechanism `query_events`
(P4-02) uses — a fabricated id and a REAL id belonging to a different tenant produce the
identical "not found" outcome, which is correct: this code must never even hint that a
cross-tenant id exists. Each resolved event's time is also checked against the case's own
`window_start`/`window_end` (open cases have no upper bound yet, so only the lower bound is
enforced). A single unresolvable or out-of-window reference fails the WHOLE report, not just
that claim, and gives the model exactly one more chance — a separate repair budget from
P4-03's own schema repair, since they're different problems. A second consecutive grounding
failure throws a distinguished `GroundingFailedError` that `worker.ts` catches specially: rather
than the DLQ every other failure gets, it degrades to a rule-only alert and pages — honestly
scoped the same way every alert in this codebase is before a real delivery channel exists (no
WhatsApp/Slack/email integration exists before P5's response plane): a real, structured, paged
log line carrying only the case's own deterministic fields, never the verdict's own unverified
claims. The rejection rate itself is a real OTel counter pair (`analyst.grounding.attempts` /
`.rejections`, via `packages/observability`'s new `createMeter`), independently confirmed
reaching Prometheus by querying it directly rather than trusting the counter call site, with a
Grafana alert (`infra/docker/grafana-provisioning/alerting/grounding-rejection-rate.yml`) firing
per-tenant above a 2% rejection rate, mirroring the already-proven `reduction-ratio.yml` pattern.

**Tiered model routing and prompt caching (P4-05).** "The single largest cost lever in the
system," per the ticket's own description. Every non-critical case is triaged on a cheap model
(`triage.ts`'s `AnthropicTriageModel`) before the expensive investigation model ever sees it —
a `dismiss` decision ends the case right there, never reaching `investigate()` at all. A
malformed or unparseable triage response fails safe to `escalate`, never to dismiss: this
file's whole job is cheaply filtering out noise, and the worst outcome of a parsing bug here
would be silently dropping a real case, which is strictly worse than one unnecessary
investigation. Critical-severity cases bypass triage entirely (`worker.ts`'s own routing, before
either model is called) — a case already known to be severe gains nothing from a cheap-model
opinion, only latency. Both tiers share one `tenantContextBlock(tenantId)` function as a
`cache_control: {type: 'ephemeral'}` system-prompt block — the SAME function, not two copies
that could silently drift apart and stop matching byte-for-byte, which is what an Anthropic
prompt cache actually requires to hit. Model identifiers for both tiers are env-configured
(`ANTHROPIC_TRIAGE_MODEL`/`ANTHROPIC_INVESTIGATION_MODEL`), never hardcoded, so swapping either
is a deploy-time change. Cache hit rate is a real counter pair
(`analyst.prompt_cache.calls`/`.hits`, incremented from the Anthropic response's own
`cache_read_input_tokens`), not a derived guess.

**Per-tenant cost budgets (P4-06).** Enforces the unit economics constraint directly: every
real Anthropic call (`cost-budget.ts`'s `recordUsage`) writes a durable `llm_usage` row — one
per call, not a pre-aggregated rollup, so T1's own "token accounting matches the provider's
reported usage" can be checked against an actual row — and increments a real `analyst.llm.cost_usd`
counter in the same place, so the two can never drift apart. Cost itself comes from a
configurable price table (`config/model-prices.json`, USD per million tokens, matching how
providers publish their own pricing) with its own per-token-kind rate, so a cache read's real
discount (P4-05) is visible in the number that matters most: the bill. `PLAN_BUDGETS` mirrors
`services/correlate/internal/scoring/threshold.go`'s own `PlanTier` map almost exactly — the
same four real plan values, the same "an unrecognised tier degrades to the most conservative
configured budget" shape, learned from that Go file's own documented mistake of inventing
fictional tier names that silently never matched the schema. Checked once per case, BEFORE
either model is called, using only what the tenant already spent on earlier cases today: at
1.5x the plan's allowance, an operational alert fires but the case still proceeds normally; at
the hard cap, the case never reaches either model at all and degrades straight to the SAME
rule-only-alert-and-page path P4-04's grounding failures use — reusing that mechanism rather
than building a second one. Cost per tenant is visible on a real Grafana dashboard
(`infra/docker/grafana-provisioning/dashboards/json/llm-cost.json`), alongside the prompt-cache
hit rate and grounding rejection rate it sits next to for the same reason: all three move
together when a tenant's behavior actually changes.

**Plain-English report generation (P4-07).** The customer-facing output, built entirely from an
already-validated, already-grounded Verdict (P4-03/P4-04) — `report.ts`'s own `generateReport`
never calls a model again and never invents content; it only glosses jargon and restructures
what already passed grounding, the same "deterministic code, never a model self-check"
discipline the grounding validator itself applies, now to WRITING a report instead of
validating one. A fixed glossary (`jargon.ts`) explains any technical term inline the first
time it appears, never repeating the gloss on later mentions; a Flesch-Kincaid grade-level
check (`readability.ts`) gates every report before it goes out — calibrated empirically against
a genuinely plain security-report sentence (~8) versus dense, jargon-heavy prose (25+), since
the formula is known to be noisy on short passages and a stricter threshold would fail ordinary
sentences on noise alone. `recommendedActions` are grouped into now/today/later and each
playbook identifier (P4-03's own known-playbook registry) gets a one-line plain description,
falling back to the raw identifier rather than fabricating one for anything unrecognised.
Every statement stays traceable to its own claim's `evidenceRef` (AC3) — carried alongside the
narrative, not woven into it, since narrating "(see evt_abc123)" inline would reintroduce the
same jargon this file exists to remove. Four channel renderers (`report-channels.ts`) turn the
same `Report` into WhatsApp plain text, Slack Block Kit, escaped HTML email, and the dashboard's
own structured JSON — each respecting that channel's real limits (WhatsApp's message cap,
Slack's per-block text cap) with an explicit truncation marker, never a silent cut, and the
email renderer HTML-escapes every piece of report text, since it ultimately traces back to
model-authored claim text that is grounding-validated but never HTML-encoding-trusted. No real
delivery channel exists yet (WhatsApp/Slack/email integration is P5's own response plane), so
the worker renders for all four channels against every real case it processes — proving AC4
against real production traffic, not only a unit-test fixture — and logs the result rather than
sending it, the same honestly-scoped pattern every other not-yet-delivered alert in this
codebase already uses.

**Golden-case eval suite (P4-08).** "How a model or prompt change is proven safe before it
ships." 50 golden cases (`apps/analyst/src/eval/golden-cases.ts`) — generated from 10
true-positive/false-positive/ambiguous templates each instantiated across 5
entities/countries/scores, a standard parameterised-golden-set authoring technique rather than
50 bespoke narratives — each seeding exactly what the real pipeline needs (a `cases` row, a
handful of real `sentinel.events` rows the investigation model's own tools can discover and
cite) to produce a verdict for real. Scoring (`eval/scoring.ts`) is pure and infra-free: triage
correctness, severity accuracy, 100%-grounding (never a lower tolerance — a single unresolved
reference is TG1's own "fails the whole report," not a statistic to average away), and action
appropriateness (does ANY recommended playbook match the case's own expected set, not an
exact-match requirement) are scored per case and aggregated; `checkTolerance` is the one
function a CI exit code comes from, and `detectDrift` separately catches a suite sliding several
points run over run even while still clearing every absolute floor. Results are written as
timestamped snapshots plus a `latest.json` (AC5) so drift is visible without reparsing
filenames. The harness (`eval/runner.ts`) is model-agnostic by construction — real
Anthropic-backed models and a fake model share every line of seeding/scoring code — which is
what let a fake "always dismiss" model prove the suite correctly fails a deliberately degraded
prompt (AC4/T4), and a fake "oracle" model (looks up each case's own known-correct answer,
grounds against a REAL resolved event id) prove the harness's own seeding/grounding/scoring
plumbing at the full 50-case scale against real infra — both verified for real, in this
sandbox, in a few seconds. What has NOT run here: the actual pinned model against all 50 cases
(T1/T2/T3), which needs a real `ANTHROPIC_API_KEY` this sandbox does not have — those tests are
`skipIf`-gated, visibly skipped rather than faked, and `.github/workflows/eval-golden-cases.yml`
runs them for real nightly once that secret is configured, against model identifiers pinned in
the workflow itself (AC3), never an env default that could silently drift.

**Prompt-injection resistance (P4-09, TG1).** "Log content is attacker-controlled... the
analyst must treat all event content as data, never as instruction." Every piece of
log-derived content reaching either model — every tool result (`tools/index.ts`'s own
`executeTool`) and the case's own title — is wrapped in an explicit `<untrusted_data>` delimiter
(`injection-defense.ts`), and both system prompts (`triage.ts`, `investigation-model.ts`) state
plainly that content inside those tags is never an instruction, no matter what it says. Delimiting
happens unconditionally; DETECTION is the separate, narrower mechanism a growing blocklist of
known injection shapes (`ignore previous instructions`, a fake `assistant:` turn, `severity
should be set to info`, `do not alert`, ...) feeds — a match adds a visible security-warning
banner to that specific block and logs the attempt for threat research (AC3/AC5), regardless of
whether the model would have resisted it anyway. Tool arguments get the same boundary check
P4-02's own design already implied: no tool has ever read a tenant id from its own arguments,
only from the worker's trusted `CaseContext` — this ticket makes that explicit and tested (an
injected `tenant_id` key in a tool call's arguments is logged as suspicious and has zero effect,
proven against real ClickHouse row-policy-scoped data, no model required). Whether a REAL model
actually resists a crafted payload (AC2) is a different claim from any of the above and the one
piece this sandbox's missing `ANTHROPIC_API_KEY` cannot verify — those two tests are
`skipIf`-gated and show as skipped, the same honest boundary P4-08's own eval suite already
established for exactly this reason.

**Analyst degradation path (P4-10, TG4/C4).** "The provider being down must degrade the
product, not stop it." `circuit-breaker.ts`'s `CircuitBreaker` — a plain, clock-injectable
state machine, no network or SDK dependency of its own — is shared by both the triage and
investigation calls, since both hit the same underlying Anthropic API: a 503 from either is
equally real evidence the provider itself is down. Three states (`closed`/`open`/`half_open`):
a configured number of consecutive provider failures opens it; after `openDurationMs`, exactly
one trial call is let through; that call's own success closes it again and reports
`recovered: true`, the one edge that should trigger a drain, distinct from an ordinary success
while already closed. A malformed response or a grounding failure is a real problem but never
trips this breaker — only `isProviderFailure` (the same classifier `main.ts` already uses for
retry eligibility) decides that. An open circuit routes the case straight to the SAME
`degradeToRuleOnlyAlert` path P4-04/P4-06 already built (now generalized to take a
reason/detail pair instead of being grounding-specific) and queues it
(`analyst_degraded_queue`, `packages/db`'s `DegradedQueueRepository` — `UNIQUE (tenant_id,
case_id)` makes enqueueing idempotent) rather than losing it to the DLQ. Recovery drains that
queue by re-publishing each pending case back onto `cases`, which this same worker then
genuinely re-investigates through the ordinary pipeline — proven end to end, not just that a
queue row exists: a dedicated test runs a real outage-then-recovery cycle against real
Postgres/Redpanda and confirms the originally-degraded case is later re-investigated exactly
once, with its original degrade alert never duplicated. Circuit state is a live OTel gauge
(`analyst.circuit_breaker.state`, 0/1/2) on the same operations dashboard P4-04/P4-05/P4-06's
own metrics already share (`llm-cost.json`), confirmed live via Grafana's own API after this
dashboard's update auto-provisioned.

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
