# ADR-0010: Cursors commit only after durable Kafka acknowledgement

- **Status:** Accepted
- **Date:** 2026-10-05
- **Phase:** P1
- **Supersedes / Superseded by:** —

## Context

`docs/architecture/overview.md`'s connector-plane section has described this contract since
Phase 0 planning — "cursors live in Postgres, committed only after the batch is durably
written to Kafka" — but it was never promoted to an ADR. Two places in the codebase already
cite it as "ADR-0002" (`services/ingest/cmd/ingest/main.go`'s header comment, and
`db/postgres/migrations/0001_foundation.sql`'s comment on `connector_cursors`). ADR-0002 is
"OCSF as the canonical normalised event schema" — a real decision, but not this one. Nothing
in the repository actually governs checkpointing with the weight an ADR carries.

P1-01 is the first ticket to turn this from a paragraph in an overview doc into executable
code (`go/sentinelconnector`'s scheduler and cursor store), so this is the point where the
contract needs to be unambiguous rather than implied, and the wrong citations need to stop
propagating into new code that copies them without checking.

The forcing question: what does a connector's cursor advance mean, and what three-way failure
(API fetch, Kafka write, Postgres commit) can quietly turn into silent data loss or silent
duplication if the ordering is wrong?

## Decision

A connector's cursor for a stream advances **if and only if** the batch fetched at that
cursor has already been durably acknowledged by the stream (today: Redpanda's Kafka-API
acknowledgement; ADR-0003). The write order is always:

1. `Connector.Fetch` returns a batch and the cursor that would follow it
2. The batch is published and the publisher's ack is awaited
3. Only after a successful ack does the cursor store commit the new cursor to Postgres

If step 2 fails or the process dies before step 3, the next scheduler run re-fetches from the
**old** cursor and republishes the same batch. This is deliberately **at-least-once**, not
exactly-once: making a vendor API, a distributed log and a relational database agree
atomically across a process crash is not achievable without a distributed transaction
coordinator this system does not have, and should not be made to depend on. Duplicates that
result are collapsed downstream in ClickHouse by `ReplacingMergeTree` keyed on
`(tenant_id, event_id)` — a problem solved once, centrally, rather than guarded against at
every connector.

The corollary this forces on every connector implementation: `Fetch` must be idempotent for a
given cursor (fetching the same cursor twice returns the same or a safely-re-publishable
batch), because re-fetching after a crash is the recovery path, not an edge case.

## Alternatives considered

### A: Commit the cursor before publishing

Would make a crash between the two steps lose the batch silently instead of duplicating it —
worse for a security product, where a missed authentication log is a worse failure mode than
a duplicate one. Rejected outright.

### B: Two-phase commit across Kafka and Postgres

Would give exactly-once semantics, but Kafka's own transaction protocol does not extend to an
external Postgres instance's transaction, so this would mean either rolling a custom
distributed-commit protocol or adopting a saga pattern with its own compensating-action
complexity — for a guarantee (exactly-once) this system does not actually need, since
ClickHouse already has to dedupe for other reasons (replays, backfills). Rejected as
complexity bought for a guarantee already provided elsewhere.

### C: Idempotency keys instead of ReplacingMergeTree dedup

Embedding a dedup key in the publish step itself (Kafka idempotent producer) would prevent
*broker-level* duplicate writes, but does nothing for the case this ADR is actually about —
re-fetching and re-publishing a whole batch after a crash, which is an application-level
retry, not a producer-level one. Complementary, not a substitute; the idempotent producer is
still used (ADR-0003) but does not change this decision.

## Consequences

### Good

- A crash at any point between fetch and cursor-commit has one well-defined recovery path:
  re-run from the last committed cursor. No special-cased crash-recovery logic per connector.
- The failure mode under a crash is a duplicate event, which is cheap and already handled, not
  a silent gap in a customer's audit trail, which is not recoverable after the fact.
- `Connector.Fetch`'s idempotency requirement is checkable per connector in isolation (P1-01's
  T1/T2), rather than only provable by an end-to-end chaos test.

### Bad

- Every connector author must reason about idempotent re-fetch, not just "fetch new stuff" —
  a real cognitive cost documented in the connector developer guide (P1-13).
- ClickHouse permanently carries the deduplication burden; it cannot be removed later without
  re-opening this decision.
- At-least-once means downstream consumers of the raw stream (not just ClickHouse) must also
  tolerate duplicates if any are added later — a constraint this ADR imposes on future work.

### Risks and how they are mitigated

| Risk | Mitigation | Owner |
|---|---|---|
| A connector's `Fetch` is accidentally non-idempotent (e.g. a cursor encoding a "delete after read" vendor call) | P1-01's T1/T2 unit tests assert cursor-advance-only-after-ack against a fake publisher; code review checks new connectors against this ADR explicitly | Connector author + reviewer |
| `ReplacingMergeTree` dedup silently masks a *different* bug (connector re-publishing without a crash) | P1-11's per-connector health/EPS metrics make abnormal republish volume visible | P1-11 |
| A future connector type cannot tolerate even transient duplicates (e.g. a push-based webhook counted as billing events) | Flagged here explicitly: this ADR's guarantee is at-least-once, not exactly-once — such a source needs its own idempotency layer, not an exception to this contract | Future connector author |

## Revisit when

A connector source is added whose vendor API makes `Fetch` idempotency genuinely unachievable
(a true push-only webhook with no replay capability), or ClickHouse's dedup cost becomes
measurable at scale — either is a reason to reopen this, not silently special-case around it.
