package sentinelstream

import "testing"

func TestTenantKeyDefaultsToShardZero(t *testing.T) {
	got := TenantKey("tenant-a")
	if want := "tenant-a:0"; got != want {
		t.Fatalf("TenantKey(%q) = %q, want %q", "tenant-a", got, want)
	}
}

func TestTenantShardKeyUsesGivenShard(t *testing.T) {
	got := TenantShardKey("tenant-a", 7)
	if want := "tenant-a:7"; got != want {
		t.Fatalf("TenantShardKey(%q, 7) = %q, want %q", "tenant-a", got, want)
	}
}

// P3-10 T2: an unsharded key (no ":shard_n" suffix at all — what every
// tenant uses before Phase 7's hot-tenant split ever activates for it)
// parses identically to an explicit shard 0.
func TestParseTenantShardKey_UnshardedKeyIsShardZero(t *testing.T) {
	tenantID, shard, err := ParseTenantShardKey("tenant-a")
	if err != nil {
		t.Fatalf("ParseTenantShardKey: %v", err)
	}
	if tenantID != "tenant-a" || shard != 0 {
		t.Fatalf("got (%q, %d), want (%q, 0)", tenantID, shard, "tenant-a")
	}
}

func TestParseTenantShardKey_RoundTripsThroughTenantShardKey(t *testing.T) {
	for _, shard := range []int{0, 1, 7, 42} {
		key := TenantShardKey("tenant-a", shard)
		tenantID, gotShard, err := ParseTenantShardKey(key)
		if err != nil {
			t.Fatalf("ParseTenantShardKey(%q): %v", key, err)
		}
		if tenantID != "tenant-a" || gotShard != shard {
			t.Errorf("ParseTenantShardKey(%q) = (%q, %d), want (%q, %d)", key, tenantID, gotShard, "tenant-a", shard)
		}
	}
}

func TestParseTenantShardKey_NonNumericSuffixIsAnError(t *testing.T) {
	if _, _, err := ParseTenantShardKey("tenant-a:not-a-number"); err == nil {
		t.Fatal("expected an error for a non-numeric shard suffix")
	}
}

func TestTenantEntityKeyFormat(t *testing.T) {
	got := TenantEntityKey("tenant-a", "entity-1")
	if want := "tenant-a:entity-1"; got != want {
		t.Fatalf("TenantEntityKey = %q, want %q", got, want)
	}
}

func TestTenantCaseKeyFormat(t *testing.T) {
	got := TenantCaseKey("tenant-a", "case-1")
	if want := "tenant-a:case-1"; got != want {
		t.Fatalf("TenantCaseKey = %q, want %q", got, want)
	}
}

// Every main topic's DLQ must follow the "<name>.dlq" convention the
// architecture table's own `*.dlq` row implies — checked here so a typo in
// topics.go (e.g. "events.raw-dlq") fails fast, not silently at
// provisioning time against a live broker.
func TestEveryTopicHasAConsistentlyNamedDLQ(t *testing.T) {
	for _, spec := range MainTopics {
		if want := spec.Name + ".dlq"; spec.DLQ != want {
			t.Fatalf("topic %s: DLQ = %q, want %q", spec.Name, spec.DLQ, want)
		}
	}
}

// The architecture table (overview.md §3.3) is the one source of truth for
// these numbers — this test exists so an accidental edit to topics.go is
// caught immediately rather than only at the next manual doc cross-check.
func TestMainTopicsMatchArchitectureTable(t *testing.T) {
	want := map[string]struct {
		partitions int32
		retentionH float64
	}{
		"events.raw":        {64, 24},
		"events.normalized": {128, 72},
		"signals":           {32, 7 * 24},
		"cases":             {16, 30 * 24},
		"actions":           {8, 30 * 24},
		"alerts.critical":   {8, 30 * 24},
	}
	if len(MainTopics) != len(want) {
		t.Fatalf("expected %d main topics, got %d", len(want), len(MainTopics))
	}
	for _, spec := range MainTopics {
		w, ok := want[spec.Name]
		if !ok {
			t.Fatalf("unexpected topic %q not in the architecture table", spec.Name)
		}
		if spec.Partitions != w.partitions {
			t.Fatalf("%s: partitions = %d, want %d", spec.Name, spec.Partitions, w.partitions)
		}
		if spec.Retention.Hours() != w.retentionH {
			t.Fatalf("%s: retention = %v, want %vh", spec.Name, spec.Retention, w.retentionH)
		}
	}
}
