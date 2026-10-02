# ADR-0003: Redpanda as the stream transport

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P1

## Context

Ingest, detection, correlation and the analyst must be decoupled by a durable log so that a
slow or failed stage never drops events and never blocks the one upstream of it. The
required properties: durability, replay from an offset, per-tenant ordering, consumer
groups, and back-pressure. Peak throughput is ~30,000 events/second.

The operating team at the relevant phases is one to three engineers. Operational cost is
therefore a first-class selection criterion, not a footnote.

## Decision

**Redpanda**, speaking the Kafka API, with topics partitioned by `tenant_id`.

We write against the Kafka protocol only — no Redpanda-specific extensions — so the
transport remains swappable for managed Kafka or MSK if circumstances change.

## Alternatives considered

### A: Apache Kafka (self-managed)

The reference implementation and the largest ecosystem. Rejected on operational load: JVM
tuning, partition rebalancing, and (for older deployments) ZooKeeper are a meaningful
fraction of one engineer's attention, and we do not have that engineer to spare before
Phase 6. Redpanda is a single binary with no JVM and benchmarks at lower tail latency for
this workload.

### B: AWS SQS / SNS

Genuinely zero-operations, which is attractive. Rejected on capability: no replay from an
arbitrary offset, no consumer groups with ordered partitions, and no log compaction. Replay
is not a nice-to-have here — it is how we recover from a normalisation bug and how the free
"10-minute historical scan" works. SQS would force us to rebuild replay on top of S3.

### C: NATS JetStream

Lightweight, excellent latency, pleasant to operate. Rejected on ecosystem: the Kafka
protocol gives us ClickHouse's native Kafka engine, mature Go and TypeScript clients, and a
migration path to any managed Kafka. NATS would narrow our options for a modest gain.

## Consequences

### Good

- One binary, no JVM, no ZooKeeper — roughly a third of Kafka's operational cost at our size
- Kafka wire protocol keeps the entire client and tooling ecosystem available
- Lower p99 latency than Kafka in published benchmarks for this message profile
- ClickHouse can consume directly via its Kafka table engine, removing a hop

### Bad

- Smaller community; fewer answers available when something goes wrong at 3am
- Single-vendor open-source core — a licence or direction change is a real risk
- Some Kafka ecosystem tooling assumes JVM internals and does not work
- Less battle-tested at extreme scale than Kafka, though far above our ceiling

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| Vendor licence change | We use only the Kafka protocol; migration to MSK or Confluent is a config change, and this constraint is enforced in code review |
| Hot tenant pins a partition | Key format reserves a shard suffix (`tenant_id:shard_n`) from day one; the splitter ships in Phase 7 without a breaking change |
| Operational unfamiliarity | Runbook in `docs/runbooks/`; failure drills are part of the Phase 1 exit criteria |

## Revisit when

Sustained throughput exceeds ~100k EPS, or a compliance requirement forces a specific
managed Kafka offering.
