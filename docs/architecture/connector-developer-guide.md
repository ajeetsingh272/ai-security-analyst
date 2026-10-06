# Connector developer guide

P1-13's own deliverable: everything a new connector needs, so that adding one is additive
work — no change to ingest, detection or correlation (overview.md §3.1's own claim, proven
here by building a second, trivial connector — generic syslog, `go/sentinelconnector/syslog`
— against this guide alone).

If something in here is wrong or missing, you just found the friction AC4 asks this ticket to
record — see "Friction found while writing this guide" at the bottom, and file (or extend) a
follow-up ticket rather than silently working around it.

## 1. The interface

One Go interface, defined in `go/sentinelconnector/connector.go` and quoted verbatim in
[overview.md §3.1](overview.md#31-connector-plane) so that doc stays the single source of
truth for the shape:

```go
type Connector interface {
    ID() ConnectorID
    Fetch(ctx context.Context, cur Cursor) (Batch, Cursor, error)
    Normalise(raw RawEvent) ([]ocsf.Event, error)
    HealthCheck(ctx context.Context) error
}
```

- **`ID()`** — the literal string matching the `connectors` table's `kind` check constraint
  (`db/postgres/migrations/0001_foundation.sql`). If your source is new, add it to that
  constraint in a migration — this is the one piece of "framework" a new connector is allowed
  to touch, because it's data, not code.
- **`Fetch`** — pull (or drain) everything new since `cur`, normalise nothing yet, return it
  as a `Batch` of `RawEvent` (`TenantID`, `Payload []byte`, `FetchedAt`) plus the cursor to
  resume from next time.
- **`Normalise`** — turn one `RawEvent` into zero or more `ocsf.Event`. See §3 below; this is
  the part with the most rules.
- **`HealthCheck`** — a cheap, side-effect-free call that proves the connector can still do its
  job (a token still refreshes, a listener is still bound). The scheduler never calls this on
  every cycle itself — it's there for an explicit `/connectors/health`-style check.

You register an instance per `(tenant, stream)` with the `Scheduler`
(`go/sentinelconnector/scheduler.go`) at your service's composition root — for the M365 and
syslog connectors, that's `services/ingest/cmd/ingest/main.go`. `Scheduler.Register` is the
**only** framework call a new connector's own wiring ever makes.

## 2. Cursor semantics (ADR-0010)

A cursor is an opaque `json.RawMessage` — the framework never looks inside it. Design it to
hold exactly what your source needs to resume: M365 uses `{lastContentCreated, lastContentId}`
(a vendor blob-id checkpoint); syslog uses `{afterArrivalNanos}` (an internal arrival-time
watermark — see §5 for why a source with no vendor-assigned id needs a different scheme).

**The one rule that matters: `Fetch` must be idempotent for a given cursor.** The scheduler's
crash-recovery path is "call `Fetch` again with the OLD cursor and republish whatever comes
back" (`go/sentinelconnector/scheduler.go`'s `runCycle`) — a cursor only advances *after* a
successful publish (ADR-0010: ["checkpoint after Kafka
ack"](../adr/0010-checkpoint-after-kafka-ack.md)). That makes delivery **at-least-once**, never
exactly-once — duplicates are collapsed downstream by ClickHouse's `ReplacingMergeTree`, keyed
on `(tenant_id, event_id)`. Your job is to make duplicates *harmless*, via a deterministic
`event_id` (§3), not to prevent them — preventing them across a real vendor API boundary isn't
achievable, and pretending otherwise is how a connector ships with a silent correctness bug.

For a **poll-based** source (an API you call), the natural cursor is whatever the vendor's own
pagination/checkpoint primitive is (a blob id, a `nextPageToken`, a `startTime`). For a
**push-based** source (something sends you data, like syslog) there is no vendor checkpoint at
all — see §5, "Push sources don't fit the cursor model as cleanly as poll sources."

## 3. Normalisation rules (ADR-0002, P1-04)

`Normalise` must be **pure and total**: no I/O, no clock, no network, and no input — however
malformed — that makes it error or panic. Enforced by review, and by there being nothing to
inject: a pure function literally cannot reach outside its own arguments. Every event it
produces must carry:

- **`EventID`** — deterministic from the source event, stable across re-normalisation. This is
  SECURITY.md's **TG1 guarantee** ("AI output is never unsourced") made concrete: a later
  phase's grounding validator resolves a claim by this id, forever, so it can never be a random
  UUID or a ULID (both encode generation time or randomness, not source identity — re-running
  normalisation on a replay would mint a NEW id for the same real event, orphaning every claim
  already grounded against the old one). `go/sentinelconnector/m365/ocsf_mapping.go`'s
  `eventID` is the worked example: UUIDv5 (SHA-1, RFC 4122) keyed on
  `(tenant_id, source, stream, vendor_record_id)`, falling back to hashing the entire raw
  payload when there's no vendor id to key on.
- **`SchemaVersion`** — stamp your mapping's own version constant (ADR-0002: "mappings are
  versioned and additive; old events keep their original version"). Bump it only when the
  mapping changes in a way that would alter an *already-stored* event's meaning.
- **`TimeUnixMillis` + `TimeOffset`** — always normalise to UTC, and always retain the source's
  original offset in `TimeOffset` (e.g. `"Z"`, `"+05:30"`) even though the UTC value is what's
  authoritative. Never use `FetchedAt` as the event's own time — that's informational only.
- **`ClassUID` / `CategoryUID` / `ActivityID` / `TypeUID`** — real OCSF values
  (`TypeUID = ClassUID*100 + ActivityID`), checked against the **live** schema at
  <https://schema.ocsf.io/1.3.0/classes/> while you write the mapping — not recalled from memory,
  not guessed from a class name that sounds right. If you have no real mapping for an event (an
  operation you don't recognise, or — like generic syslog — a source with no vendor-specific
  semantic knowledge at all), use `ClassUID` `0` ("uncategorized"). That is an honest "not yet
  classified," never a guess.
- **`Unmapped`** — every field your mapping doesn't translate into a typed field above goes
  here (`map[string]string`, matching `db/clickhouse/0001_events.sql`'s own
  `unmapped Map(String,String)` column), **preserved, never discarded** — including the raw
  payload itself under `Unmapped["_raw"]` when it isn't even parseable. "Pure and total" means
  this function has no acceptable way to just drop data on the floor.

## 4. Testing requirements

This repo's working definition of "integration test" is **multiple real components exercised
together**, not necessarily a real vendor service — a local mock server that implements a
vendor's own *documented* request/response contract counts (see
`go/sentinelconnector/m365/mock_server_test.go`'s own doc comment for the reasoning). That's
the standard this guide expects:

- **Unit tests for `Normalise`**: one golden fixture per event family, asserting the OCSF
  output byte-for-byte (not just "didn't error") — `go/sentinelconnector/m365/ocsf_mapping_test.go`
  is the worked example, including the property test for determinism (call it 200 times, same
  input, same `event_id` every time) and the "malformed input still produces a valid event"
  case.
- **Unit tests for throttling/backoff**, if your source has any — assert the real backoff
  duration was computed correctly using an **injected, non-sleeping** clock, not a real
  `time.Sleep` your test then has to wait out.
- **An integration test for the full `Fetch` → `Normalise` → publish path**, against a mock (or
  real, if cheap and reliable) server for your protocol.
- **A DLQ test**: a malformed unit of input from your source (whatever "malformed" means for
  your protocol) must route to `events.raw.dlq` with the raw bytes intact, and must not block
  everything after it in the same batch.
- **`go test -race`** clean, same as every other Go package in this repo.

## 5. Friction found while writing this guide

AC4 asks for this explicitly — these are gaps this guide's own dry run (building the syslog
connector) actually hit, not hypothetical ones:

1. **Push sources don't fit the cursor model as cleanly as poll sources.** Every poll-based
   connector so far (M365) has a vendor-assigned checkpoint (a blob id) to resume from. A
   push-based source has no such thing — something sends you bytes, and if your process wasn't
   running to receive them, they're just gone; there is no vendor you can ask "what did I miss
   since X?" The syslog connector's answer — an internal arrival-time watermark as the cursor,
   backed by an **in-memory** buffer — correctly avoids re-delivering anything already fetched,
   but anything received-and-buffered-but-not-yet-fetched is lost if the process crashes before
   draining it. **Follow-up ticket filed:** a durable local WAL (or equivalent) for push-based
   connectors' receive buffers, so a crash loses at most what's in flight on the wire, not
   whatever had accumulated in memory. Low priority until a second push-based source exists to
   generalise the design from — building it against one data point would be guessing.
2. **The backpressure mechanism overview.md §3.1 describes for push sources — "per-tenant token
   buckets in Redis... overflow spills to the archive bucket for later replay" — doesn't exist
   in code anywhere yet.** The syslog connector's buffer is an unbounded Go slice behind a
   mutex; a sustained flood from a misbehaving sender grows it without limit. Acceptable for
   this ticket's "trivial second connector" scope (nothing here claims production-readiness for
   a real customer-facing syslog receiver), but a real gap the next connector onto this
   framework — especially the next **push**-based one — will hit immediately. **Follow-up
   ticket filed:** implement §3.1's own documented backpressure mechanism; it's written down,
   just not built.
3. **A generic transport with no vendor-specific semantic knowledge has nothing honest to put
   in `ClassUID`/`ActivityID` beyond `0`.** This isn't a flaw in the framework — it's the
   correct, honest answer — but it means a "trivial" connector can satisfy every AC in this
   ticket while producing events a human analyst still can't act on without the specific
   firewall/device vendor's own field semantics layered on top later. Worth calling out so a
   future reader doesn't mistake "the syslog connector works" for "generic syslog ingestion is
   a complete feature."

## Quickstart checklist

1. Add your source's `kind` to the `connectors` table's check constraint if it's new (a
   migration — the one allowed framework touch).
2. Implement `Connector` in a new package (a subpackage of `go/sentinelconnector`, following
   the `m365`/`syslog` precedent — no new Go module needed unless your source needs a
   dependency the `sentinelconnector` module doesn't already have).
3. Write the golden-fixture `Normalise` tests first — they don't need your fetch/transport
   code to exist yet.
4. Build the fetch/transport layer against a local mock (or real, self-hosted) server/listener
   speaking your source's actual documented protocol.
5. Register it at your service's composition root (`scheduler.Register(...)`) — this is the
   only change to `services/ingest` (or wherever your scheduler runs) a new connector should
   ever need.
6. Run `go vet ./... && go test -race ./...` from your new package's own directory, then the
   same from whatever service you wired the registration into.
