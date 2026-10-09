package customerrules

import (
	"context"
	"testing"
)

type fakeSuspensionStore struct {
	suspended []string // "tenantID\x00ruleID"
}

func (f *fakeSuspensionStore) Suspend(_ context.Context, tenantID, ruleID string) error {
	f.suspended = append(f.suspended, key(tenantID, ruleID))
	return nil
}

func (f *fakeSuspensionStore) wasSuspended(tenantID, ruleID string) bool {
	for _, k := range f.suspended {
		if k == key(tenantID, ruleID) {
			return true
		}
	}
	return false
}

// T1's own runtime half: a rule that is consistently over budget is
// suspended, not evaluated forever.
func TestSuspensionTracker_SuspendsAfterFiveConsecutiveTimeouts(t *testing.T) {
	store := &fakeSuspensionStore{}
	tr := NewSuspensionTracker(store, nil)

	for i := 0; i < maxConsecutiveTimeouts-1; i++ {
		tr.Record(context.Background(), "tenant-a", "rule-1", true)
	}
	if store.wasSuspended("tenant-a", "rule-1") {
		t.Fatal("rule should not be suspended before reaching the threshold")
	}

	tr.Record(context.Background(), "tenant-a", "rule-1", true)
	if !store.wasSuspended("tenant-a", "rule-1") {
		t.Fatal("rule should be suspended exactly at the threshold")
	}
}

// A non-timing-out evaluation resets the streak — intermittent GC
// pressure must not eventually suspend a genuinely fine rule.
func TestSuspensionTracker_ANonTimeoutResetsTheStreak(t *testing.T) {
	store := &fakeSuspensionStore{}
	tr := NewSuspensionTracker(store, nil)

	for i := 0; i < maxConsecutiveTimeouts-1; i++ {
		tr.Record(context.Background(), "tenant-a", "rule-1", true)
	}
	tr.Record(context.Background(), "tenant-a", "rule-1", false) // resets

	for i := 0; i < maxConsecutiveTimeouts-1; i++ {
		tr.Record(context.Background(), "tenant-a", "rule-1", true)
	}
	if store.wasSuspended("tenant-a", "rule-1") {
		t.Fatal("rule should not be suspended — the earlier streak was reset by a non-timeout")
	}
}

// ADR-0012 §4's own argument, applied to this bookkeeping: one
// tenant's timeouts must never count toward another tenant's own
// streak, even for the identical rule id.
func TestSuspensionTracker_TenantsAreTrackedIndependently(t *testing.T) {
	store := &fakeSuspensionStore{}
	tr := NewSuspensionTracker(store, nil)

	for i := 0; i < maxConsecutiveTimeouts; i++ {
		tr.Record(context.Background(), "tenant-a", "rule-1", true)
	}
	if !store.wasSuspended("tenant-a", "rule-1") {
		t.Fatal("tenant-a's rule-1 should be suspended")
	}
	if store.wasSuspended("tenant-b", "rule-1") {
		t.Fatal("tenant-b's own rule-1 must not be suspended by tenant-a's timeouts")
	}
}
