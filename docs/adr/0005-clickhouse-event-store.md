# ADR-0005: ClickHouse for events, Postgres for the control plane

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P1

## Context

Two datasets with opposite characteristics:

**Events** — ~500M rows/day, ~600 GB/day raw, write-once, never updated, read analytically
("every sign-in for this identity in the last 30 days", "distinct countries for this tenant
this week"). Must retain 90 days hot and 12 months cold. Query latency under one second on
billions of rows.

**Control plane** — tenants, users, connectors, cases, approvals, audit, billing. Thousands
to millions of rows. Heavily relational, transactional, frequently updated, and legally
consequential: an approval that is recorded twice, or lost, is a serious product failure.

One database that does both well does not exist at a price compatible with constraint C1.

## Decision

Use both, with an explicit boundary.

**ClickHouse** for events, signals and aggregates:
- `MergeTree` family; `ReplacingMergeTree` keyed on `(tenant_id, event_id)` to collapse the
  duplicates that at-least-once ingest guarantees
- Partitioned by day, ordered by `(tenant_id, time, event_id)` — tenant first, because every
  query is tenant-scoped
- TTL moves partitions older than 90 days to S3 cold storage; queries span tiers transparently
- Row policies enforce tenant isolation at the storage layer

**Postgres 16** for the control plane:
- Row-level security on every tenant-scoped table
- Append-only, hash-chained audit table with no `UPDATE`/`DELETE` grant
- Drizzle for schema and migrations

**The boundary rule:** nothing that requires a transaction lives in ClickHouse, and nothing
produced at per-event volume lives in Postgres. When a feature seems to need both, it needs
redesigning.

## Alternatives considered

### A: Postgres with TimescaleDB for everything

One database, one backup story, one operational skill set, real transactions. Rejected on
cost and compression: at 500M rows/day, Timescale's storage and query cost for our analytical
patterns is roughly 8–10× ClickHouse's. That difference alone would consume the entire gross
margin described in the business plan.

### B: Elasticsearch / OpenSearch

The traditional SIEM choice, with excellent full-text search and a mature security ecosystem.
Rejected on cost and operations: JVM heap tuning, shard management and index lifecycle are a
standing operational burden, and storage cost per ingested GB is far above ClickHouse. Our
queries are structured and analytical, not full-text — we would be paying for an inverted
index we barely use.

### C: S3 and DuckDB / Athena query-on-demand

Cheapest possible storage, no cluster to run. Rejected on latency: multi-second cold queries
are incompatible with the interactive dashboard and with windowed detection rules running
every 30 seconds. It remains the right answer for the **cold** tier, which is why cold data
lands in S3.

## Consequences

### Good

- 10–15× compression; ~4.5 TB hot for 90 days of 500M events/day
- Sub-second analytical queries over billions of rows
- Roughly 1/10 the storage cost of a row store for this access pattern
- Transactional integrity where it legally matters, in Postgres
- Each store is used for exactly what it is good at

### Bad

- Two databases to operate, back up, monitor and secure
- No joins across the boundary — the application composes results, and some queries need two
  round trips
- ClickHouse has no real `UPDATE`; corrections are handled by versioned inserts and collapse
- Eventual consistency between the stores is visible, e.g. a case may reference an event that
  is still merging. The UI must tolerate this, and does

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| Developer puts transactional data in ClickHouse | The boundary rule is in `CONTRIBUTING.md` and checked in review; schema changes need an approver |
| ClickHouse merge pressure at peak ingest | Batched inserts (never per-row), async insert mode, monitored merge queue depth with an alert |
| Cross-store inconsistency surfaces to users | UI tolerates a missing event reference for up to 60 s and shows a "still indexing" state rather than an error |

## Revisit when

Hot data exceeds ~50 TB (sharding strategy needs rework), or ClickHouse Cloud pricing drops
below the cost of self-managing it.
