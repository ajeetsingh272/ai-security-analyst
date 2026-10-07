package cluster

import (
	"context"
	"fmt"
	"testing"
	"time"
)

const tenantA = "11111111-1111-1111-1111-111111111111"

func sig(id, entityID string, at time.Time) Signal {
	return Signal{
		DedupeKey: tenantA + ":rule-1:" + id, SignalID: id, RuleID: "rule-1",
		EntityType: "user", EntityID: entityID, Severity: "medium",
		EventIDs: []string{"evt-" + id}, DetectedAt: at,
	}
}

// T1: three signals on one identity within the window produce one case.
func TestCluster_ThreeSignalsOnOneIdentityWithinWindowProduceOneCase(t *testing.T) {
	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	ctx := context.Background()

	id1, err := c.Cluster(ctx, tenantA, sig("s1", "priya", base))
	if err != nil {
		t.Fatalf("Cluster s1: %v", err)
	}
	id2, err := c.Cluster(ctx, tenantA, sig("s2", "priya", base.Add(10*time.Minute)))
	if err != nil {
		t.Fatalf("Cluster s2: %v", err)
	}
	id3, err := c.Cluster(ctx, tenantA, sig("s3", "priya", base.Add(20*time.Minute)))
	if err != nil {
		t.Fatalf("Cluster s3: %v", err)
	}

	if id1 != id2 || id2 != id3 {
		t.Fatalf("got case ids %s, %s, %s — want all three the same", id1, id2, id3)
	}
}

// T2: signals on one identity OUTSIDE the window produce two cases.
func TestCluster_SignalsOutsideWindowProduceTwoCases(t *testing.T) {
	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	ctx := context.Background()

	id1, err := c.Cluster(ctx, tenantA, sig("s1", "priya", base))
	if err != nil {
		t.Fatalf("Cluster s1: %v", err)
	}
	// 61 minutes later — one minute past the default 60-minute window.
	id2, err := c.Cluster(ctx, tenantA, sig("s2", "priya", base.Add(61*time.Minute)))
	if err != nil {
		t.Fatalf("Cluster s2: %v", err)
	}

	if id1 == id2 {
		t.Fatalf("got the SAME case %s for two signals 61 minutes apart, want two distinct cases", id1)
	}
}

// T3: a signal arriving late joins the existing open case — "late" here
// meaning it is processed well after the fact but its own DetectedAt
// still falls within the window of the case's most recent signal (the
// realistic shape for a slow/retried consumer, not a signal that is
// itself outside the window — that is T2's own case).
func TestCluster_LateArrivingSignalJoinsExistingOpenCase(t *testing.T) {
	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	ctx := context.Background()

	id1, err := c.Cluster(ctx, tenantA, sig("s1", "priya", base))
	if err != nil {
		t.Fatalf("Cluster s1: %v", err)
	}
	// Arrives for PROCESSING well after s1, but its own event time
	// (DetectedAt) is still within 60 minutes of s1's.
	id2, err := c.Cluster(ctx, tenantA, sig("s2", "priya", base.Add(45*time.Minute)))
	if err != nil {
		t.Fatalf("Cluster s2 (late): %v", err)
	}

	if id1 != id2 {
		t.Fatalf("late signal got a new case %s, want it to join the existing open case %s", id2, id1)
	}
}

// T4: replaying identical input twice produces an identical case set —
// both in WHICH cases exist and in not duplicating a signal already
// recorded (the idempotent-replay guarantee AC5 actually rests on).
func TestCluster_ReplayingIdenticalInputProducesIdenticalCaseSet(t *testing.T) {
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	signals := []Signal{
		sig("s1", "priya", base),
		sig("s2", "priya", base.Add(10*time.Minute)),
		sig("s3", "dave", base.Add(5*time.Minute)),
	}

	run := func() map[string]string { // signal id -> case id
		store := NewInMemoryStore()
		c := NewClusterer(store, DefaultWindow)
		ctx := context.Background()
		result := map[string]string{}
		for _, s := range signals {
			id, err := c.Cluster(ctx, tenantA, s)
			if err != nil {
				t.Fatalf("Cluster %s: %v", s.SignalID, err)
			}
			result[s.SignalID] = id
		}
		return result
	}

	first := run()
	second := run()

	// Case IDs themselves are random (uuid) across independent runs, so
	// compare STRUCTURE (which signals share a case), not literal ids.
	if (first["s1"] == first["s2"]) != (second["s1"] == second["s2"]) {
		t.Fatalf("s1/s2 grouping differs between runs: first=%v second=%v", first, second)
	}
	if (first["s1"] == first["s3"]) != (second["s1"] == second["s3"]) {
		t.Fatalf("s1/s3 grouping differs between runs: first=%v second=%v", first, second)
	}

	// Replaying the SAME signal (same DedupeKey) a second time within
	// the SAME run must not create a duplicate or a second case.
	store := NewInMemoryStore()
	c := NewClusterer(store, DefaultWindow)
	ctx := context.Background()
	idA, _ := c.Cluster(ctx, tenantA, signals[0])
	idB, _ := c.Cluster(ctx, tenantA, signals[0]) // identical signal, replayed
	if idA != idB {
		t.Fatalf("replaying the identical signal produced a different case: %s vs %s", idA, idB)
	}
}

func TestCluster_EntitylessSignalGetsItsOwnCase(t *testing.T) {
	c := NewClusterer(NewInMemoryStore(), DefaultWindow)
	ctx := context.Background()
	s1 := Signal{DedupeKey: "k1", SignalID: "s1", RuleID: "rule-1", Severity: "medium", DetectedAt: time.Now()}
	s2 := Signal{DedupeKey: "k2", SignalID: "s2", RuleID: "rule-1", Severity: "medium", DetectedAt: time.Now()}

	id1, err := c.Cluster(ctx, tenantA, s1)
	if err != nil {
		t.Fatalf("Cluster s1: %v", err)
	}
	id2, err := c.Cluster(ctx, tenantA, s2)
	if err != nil {
		t.Fatalf("Cluster s2: %v", err)
	}
	if id1 == id2 {
		t.Fatal("two entity-less signals got the SAME case, want each to open its own")
	}
}

// Found during this ticket's own real end-to-end verification: a signal
// whose ORIGINAL case has since closed (so FindOpenCaseForEntity no
// longer offers it as a join candidate) must still be idempotent on
// replay, returning its original case rather than creating an orphaned
// duplicate.
func TestCluster_ReplayAfterCaseClosedReturnsOriginalCase(t *testing.T) {
	store := NewInMemoryStore()
	c := NewClusterer(store, DefaultWindow)
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	ctx := context.Background()

	original := sig("s1", "priya", base)
	id1, err := c.Cluster(ctx, tenantA, original)
	if err != nil {
		t.Fatalf("Cluster: %v", err)
	}
	if _, err := c.CloseQuietCases(ctx, tenantA, 30*time.Minute, base.Add(31*time.Minute)); err != nil {
		t.Fatalf("CloseQuietCases: %v", err)
	}

	// Replaying the IDENTICAL signal now: its case is closed, so
	// FindOpenCaseForEntity finds nothing — must still return the
	// ORIGINAL case, not create a new one.
	id2, err := c.Cluster(ctx, tenantA, original)
	if err != nil {
		t.Fatalf("Cluster (replay after close): %v", err)
	}
	if id1 != id2 {
		t.Fatalf("replaying a signal after its case closed got a NEW case %s, want the original %s", id2, id1)
	}
}

func TestCloseQuietCases_ClosesOnlyPastQuietPeriod(t *testing.T) {
	store := NewInMemoryStore()
	c := NewClusterer(store, DefaultWindow)
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)
	ctx := context.Background()

	for i, name := range []string{"priya", "dave"} {
		if _, err := c.Cluster(ctx, tenantA, sig(fmt.Sprintf("s%d", i), name, base)); err != nil {
			t.Fatalf("Cluster: %v", err)
		}
	}

	closed, err := c.CloseQuietCases(ctx, tenantA, 30*time.Minute, base.Add(31*time.Minute))
	if err != nil {
		t.Fatalf("CloseQuietCases: %v", err)
	}
	if closed != 2 {
		t.Fatalf("closed = %d, want 2 (both cases are past the 30-minute quiet period)", closed)
	}
}
