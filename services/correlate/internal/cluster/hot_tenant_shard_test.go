package cluster

import (
	"context"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
)

// P3-10: hot-tenant correlation sharding readiness. Phase 7's own
// hot-tenant split re-keys a tenant's events.normalized messages to
// "tenant_id:shard_n" once that tenant crosses an EPS threshold
// (docs/architecture/overview.md §3.3) — but neither
// services/detect's worker nor this package's own consumer loop
// (cmd/correlate/main.go) ever reads a Kafka message's KEY, only its
// JSON value, and Clusterer/Signal carry no shard field at all.
// Window-merging across a hot-tenant's shards is therefore not
// something this package needs to IMPLEMENT — it is something this
// package must never accidentally BREAK, by starting to key
// clustering on anything shard-related. These tests lock that
// invariant in as a real regression gate, not just a design note.
//
// T1 (below) and TestPostgresStore_OpenCaseSurvivesHotTenantShardMidStream
// (postgres_store_integration_test.go, T3) are two sides of the same
// claim at two different layers: InMemoryStore (pure, no I/O) and the
// real PostgresStore (real Postgres), respectively.

// T1: signals across two shards for one tenant cluster into one case.
// The two signals below are constructed from what the UPSTREAM Kafka
// key would have been for each (tenant_id:0 and tenant_id:1) — parsed
// back via sentinelstream.ParseTenantShardKey, exactly as a
// shard-aware future caller would, to prove both keys resolve to the
// identical real tenant_id Clusterer actually clusters on.
func TestCluster_HotTenantShardReadiness_SignalsAcrossTwoShardsClusterIntoOneCase(t *testing.T) {
	rawTenantID := "33333333-3333-3333-3333-333333333333"
	tenantFromShard0, shard0, err := sentinelstream.ParseTenantShardKey(sentinelstream.TenantShardKey(rawTenantID, 0))
	if err != nil {
		t.Fatalf("ParseTenantShardKey (shard 0): %v", err)
	}
	tenantFromShard1, shard1, err := sentinelstream.ParseTenantShardKey(sentinelstream.TenantShardKey(rawTenantID, 1))
	if err != nil {
		t.Fatalf("ParseTenantShardKey (shard 1): %v", err)
	}
	if shard0 == shard1 {
		t.Fatalf("test fixture itself is broken: both signals resolved to the same shard (%d)", shard0)
	}
	if tenantFromShard0 != tenantFromShard1 {
		t.Fatalf("different shard keys for the same tenant resolved to different tenant ids: %q vs %q", tenantFromShard0, tenantFromShard1)
	}

	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	id1, err := c.Cluster(ctx, tenantFromShard0, Signal{
		DedupeKey: tenantFromShard0 + ":rule-1:shard0-sig", SignalID: "shard0-sig", RuleID: "rule-1",
		EntityType: "user", EntityID: "hot-tenant-entity", Severity: "medium",
		EventIDs: []string{"evt-shard0"}, DetectedAt: base,
	})
	if err != nil {
		t.Fatalf("Cluster (shard 0 signal): %v", err)
	}
	id2, err := c.Cluster(ctx, tenantFromShard1, Signal{
		DedupeKey: tenantFromShard1 + ":rule-1:shard1-sig", SignalID: "shard1-sig", RuleID: "rule-1",
		EntityType: "user", EntityID: "hot-tenant-entity", Severity: "medium",
		EventIDs: []string{"evt-shard1"}, DetectedAt: base.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("Cluster (shard 1 signal): %v", err)
	}

	if id1 != id2 {
		t.Fatalf("signals whose upstream keys named different shards of the same tenant produced two cases (%s, %s), want one", id1, id2)
	}
}

// T2: an unsharded tenant (no shard suffix on its own upstream key at
// all) behaves identically to before — proven by the fact that every
// other test in this package already clusters signals with a plain
// tenant_id, never going through ParseTenantShardKey at all, and
// passes unchanged. This test makes the equivalence explicit: a plain
// tenant_id and that same tenant_id's own explicit shard-0 form
// cluster into the SAME case when mixed together, confirming
// "unsharded" really is indistinguishable from "shard 0" to Clusterer.
func TestCluster_HotTenantShardReadiness_UnshardedTenantBehavesIdenticallyToShardZero(t *testing.T) {
	rawTenantID := "44444444-4444-4444-4444-444444444444"
	tenantFromImplicitShard, _, err := sentinelstream.ParseTenantShardKey(rawTenantID) // no suffix at all
	if err != nil {
		t.Fatalf("ParseTenantShardKey (no suffix): %v", err)
	}
	tenantFromExplicitShard0, _, err := sentinelstream.ParseTenantShardKey(sentinelstream.TenantShardKey(rawTenantID, 0))
	if err != nil {
		t.Fatalf("ParseTenantShardKey (explicit shard 0): %v", err)
	}
	if tenantFromImplicitShard != rawTenantID || tenantFromImplicitShard != tenantFromExplicitShard0 {
		t.Fatalf("got (%q, %q), want both equal to %q", tenantFromImplicitShard, tenantFromExplicitShard0, rawTenantID)
	}

	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	id1, err := c.Cluster(ctx, tenantFromImplicitShard, Signal{
		DedupeKey: rawTenantID + ":rule-1:unsharded-sig", SignalID: "unsharded-sig", RuleID: "rule-1",
		EntityType: "user", EntityID: "plain-entity", Severity: "medium",
		EventIDs: []string{"evt-plain"}, DetectedAt: base,
	})
	if err != nil {
		t.Fatalf("Cluster (implicit shard): %v", err)
	}
	id2, err := c.Cluster(ctx, tenantFromExplicitShard0, Signal{
		DedupeKey: rawTenantID + ":rule-1:explicit-shard0-sig", SignalID: "explicit-shard0-sig", RuleID: "rule-1",
		EntityType: "user", EntityID: "plain-entity", Severity: "medium",
		EventIDs: []string{"evt-explicit"}, DetectedAt: base.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("Cluster (explicit shard 0): %v", err)
	}
	if id1 != id2 {
		t.Fatalf("an unsharded tenant id and its own explicit shard-0 form produced two different cases (%s, %s)", id1, id2)
	}
}
