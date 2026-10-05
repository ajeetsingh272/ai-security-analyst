// Package sentinelstream is P1-05: declarative Redpanda topic provisioning
// and a batching, idempotent producer, built against the Kafka protocol
// only (ADR-0003 — no Redpanda-specific extensions, so the transport stays
// swappable for a managed Kafka later).
package sentinelstream

import "time"

// KeyFormat describes how a topic's partition key is built — not a free-text
// convention, so a provisioning or producer bug that gets this wrong is a
// compile-time mismatch against TopicSpec, not a silent runtime one.
type KeyFormat int

const (
	// KeyTenant: tenant_id, or tenant_id:shard_n once a tenant crosses the
	// hot-tenant EPS threshold (overview.md §3.3 — the splitter itself is
	// Phase 7, but the key format carries the shard suffix from day one so
	// that change is non-breaking). shard_n defaults to 0.
	KeyTenant KeyFormat = iota
	// KeyTenantEntity: tenant_id:entity_id (the `signals` topic).
	KeyTenantEntity
	// KeyTenantCase: tenant_id:case_id (the `cases` and `actions` topics).
	KeyTenantCase
)

// TopicSpec is one row of docs/architecture/overview.md §3.3's table,
// verbatim — this file has no values that table doesn't already specify.
type TopicSpec struct {
	Name       string
	Key        KeyFormat
	Partitions int32
	Retention  time.Duration
	// DLQ is this topic's dead-letter topic name, always "<name>.dlq" per
	// the table's own `*.dlq` row (4 partitions, 30d retention, no specific
	// key — a DLQ's ordering guarantee is "a human can find this message",
	// not per-tenant sequencing).
	DLQ string
}

const dlqPartitions int32 = 4

var dlqRetention = 30 * 24 * time.Hour

// MainTopics is the full §3.3 table. P1-05's own producer (Publisher,
// publisher.go) only writes to EventsRaw today — the connector framework
// (P1-01) is ingest's only producer so far — but every topic is provisioned
// now, declaratively, exactly as the ticket's AC asks ("topic creation...
// from the architecture doc"), not only the ones with a writer yet. A later
// phase's producer (detection writing `signals`, response writing
// `actions`) finds its topic already provisioned correctly rather than
// needing its own migration.
var MainTopics = []TopicSpec{
	{Name: "events.raw", Key: KeyTenant, Partitions: 64, Retention: 24 * time.Hour, DLQ: "events.raw.dlq"},
	{Name: "events.normalized", Key: KeyTenant, Partitions: 128, Retention: 72 * time.Hour, DLQ: "events.normalized.dlq"},
	{Name: "signals", Key: KeyTenantEntity, Partitions: 32, Retention: 7 * 24 * time.Hour, DLQ: "signals.dlq"},
	{Name: "cases", Key: KeyTenantCase, Partitions: 16, Retention: 30 * 24 * time.Hour, DLQ: "cases.dlq"},
	{Name: "actions", Key: KeyTenantCase, Partitions: 8, Retention: 30 * 24 * time.Hour, DLQ: "actions.dlq"},
}

// EventsRaw is the one topic P1-01's connector scheduler actually publishes
// to today (see publisher.go's RedpandaPublisher) — named here so main.go
// doesn't hardcode the string "events.raw" at the call site.
const EventsRaw = "events.raw"

// EventsNormalized is what P1-07's ClickHouse writer consumes from. Nothing
// publishes to it yet — P1-04 (OCSF normalisation) is what will, once a
// real connector (P1-02/03, blocked on real OAuth credentials) exists to
// normalise. The topic is provisioned now regardless (topics.go's
// MainTopics), and P1-07's consumer is built and tested against it now too,
// the same "framework ahead of the real producer" sequencing P1-01 and
// P1-05 already established.
const EventsNormalized = "events.normalized"
