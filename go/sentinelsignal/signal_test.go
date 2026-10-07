package sentinelsignal

import "testing"

// T4: "customer receives exactly one notification when both paths
// complete successfully" — the data-contract half of that guarantee: a
// bypass alert and its later AI-investigated counterpart must compute
// the identical DedupeKey for the same underlying detection, so a
// future notifier can collapse them. A future notification service's
// own merge logic is out of this package's scope; what IS this
// package's job is that the key itself is stable and deterministic.
func TestNewDedupeKey_StableForSameDetection(t *testing.T) {
	a := NewDedupeKey("tenant-1", "rule-1", "alice", []string{"evt-1", "evt-2"})
	b := NewDedupeKey("tenant-1", "rule-1", "alice", []string{"evt-3"}) // different run, same entity
	if a != b {
		t.Errorf("same tenant/rule/entity produced different keys: %q vs %q", a, b)
	}
}

func TestNewDedupeKey_DiffersForDifferentDetections(t *testing.T) {
	base := NewDedupeKey("tenant-1", "rule-1", "alice", nil)
	cases := []string{
		NewDedupeKey("tenant-2", "rule-1", "alice", nil), // different tenant
		NewDedupeKey("tenant-1", "rule-2", "alice", nil), // different rule
		NewDedupeKey("tenant-1", "rule-1", "bob", nil),   // different entity
	}
	for _, c := range cases {
		if c == base {
			t.Errorf("expected a different key, got the same as base: %q", c)
		}
	}
}

func TestNewDedupeKey_FallsBackToEventIDWithoutEntity(t *testing.T) {
	a := NewDedupeKey("tenant-1", "rule-1", "", []string{"evt-1"})
	b := NewDedupeKey("tenant-1", "rule-1", "", []string{"evt-1"})
	if a != b {
		t.Errorf("expected the same event id to produce the same key: %q vs %q", a, b)
	}
	c := NewDedupeKey("tenant-1", "rule-1", "", []string{"evt-2"})
	if a == c {
		t.Errorf("expected a different event id to produce a different key when there is no entity")
	}
}

func TestNewDedupeKey_NoEntityOrEventIDsStillDeterministic(t *testing.T) {
	a := NewDedupeKey("tenant-1", "rule-1", "", nil)
	b := NewDedupeKey("tenant-1", "rule-1", "", nil)
	if a != b || a == "" {
		t.Errorf("expected a stable, non-empty key even with no entity/event ids, got %q and %q", a, b)
	}
}
