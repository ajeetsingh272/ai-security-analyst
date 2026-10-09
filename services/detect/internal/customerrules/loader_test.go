package customerrules

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

const tenantARule = `title: Customer probe rule A
id: customer-probe-a
owner_description: A probe rule for the customer-rule loader's own tests.
tags:
  - attack.t1078
logsource:
  product: m365
detection:
  selection:
    Operation: 'Send'
  condition: selection
level: high
`

const tenantBRule = `title: Customer probe rule B
id: customer-probe-b
owner_description: A probe rule for the customer-rule loader's own tests.
tags:
  - attack.t1078
logsource:
  product: m365
detection:
  selection:
    Operation: 'Receive'
  condition: selection
level: high
`

const malformedYAML = `this is not: [valid yaml structure for a rule`

type fakeSource struct {
	rules []ActiveRule
	err   error
}

func (f *fakeSource) ActiveRules(context.Context) ([]ActiveRule, error) {
	return f.rules, f.err
}

// ADR-0012 §4: the loader's own half of strict tenant isolation — two
// tenants' rules loaded in the SAME refresh must never cross into each
// other's Active(tenantID) result.
func TestLoader_RulesAreKeptSeparateByTenant(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []ActiveRule{
		{ID: "customer-probe-a", TenantID: "tenant-a", RuleYAML: tenantARule},
		{ID: "customer-probe-b", TenantID: "tenant-b", RuleYAML: tenantBRule},
	}}, nil)
	l.refreshOnce(context.Background())

	a := l.Active("tenant-a")
	if len(a) != 1 || a[0].RowID != "customer-probe-a" {
		t.Fatalf("tenant-a got %+v, want exactly its own rule", a)
	}
	b := l.Active("tenant-b")
	if len(b) != 1 || b[0].RowID != "customer-probe-b" {
		t.Fatalf("tenant-b got %+v, want exactly its own rule", b)
	}

	// Neither tenant's own slice contains the OTHER tenant's rule id —
	// the direct assertion T2 cares about, not just "lengths matched".
	for _, r := range a {
		if r.RowID == "customer-probe-b" {
			t.Fatal("tenant-a's own Active() leaked tenant-b's rule")
		}
	}
}

func TestLoader_AnUnknownTenantGetsAnEmptySliceNotNilPanic(t *testing.T) {
	l := NewLoader(&fakeSource{}, nil)
	if active := l.Active("no-such-tenant"); len(active) != 0 {
		t.Fatalf("got %+v, want an empty result for a tenant with no active rules", active)
	}
}

func TestLoader_MalformedYAMLSkipped(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []ActiveRule{{ID: "row-1", TenantID: "tenant-a", RuleYAML: malformedYAML}}}, nil)
	l.refreshOnce(context.Background())

	if active := l.Active("tenant-a"); len(active) != 0 {
		t.Fatalf("got %d active rules, want 0 (malformed YAML must be skipped): %+v", len(active), active)
	}
}

// One bad row for a tenant must not prevent a GOOD row for the SAME
// tenant from loading — mirrors hotfix.Loader's identical guarantee.
func TestLoader_OneBadRowDoesNotBlockGoodRows(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []ActiveRule{
		{ID: "row-1", TenantID: "tenant-a", RuleYAML: tenantARule},
		{ID: "row-2", TenantID: "tenant-a", RuleYAML: malformedYAML},
	}}, nil)
	l.refreshOnce(context.Background())

	active := l.Active("tenant-a")
	if len(active) != 1 || active[0].RowID != "row-1" {
		t.Fatalf("got %+v, want exactly the one good rule", active)
	}
}

func TestLoader_RefreshFailureKeepsPreviousSnapshot(t *testing.T) {
	src := &fakeSource{rules: []ActiveRule{{ID: "row-1", TenantID: "tenant-a", RuleYAML: tenantARule}}}
	l := NewLoader(src, nil)
	l.refreshOnce(context.Background())
	if len(l.Active("tenant-a")) != 1 {
		t.Fatalf("setup: expected 1 active rule before the failing refresh")
	}

	src.err = errors.New("postgres unreachable")
	l.refreshOnce(context.Background())

	if active := l.Active("tenant-a"); len(active) != 1 {
		t.Fatalf("got %d active rules after a failed refresh, want the previous snapshot (1) preserved: %+v", len(active), active)
	}
}

func TestLoader_ActiveNeverPanicsBeforeFirstRefresh(t *testing.T) {
	l := NewLoader(&fakeSource{}, nil)
	if active := l.Active("tenant-a"); active == nil && len(active) != 0 {
		t.Fatal("Active() should return an empty, non-panicking result before any refresh ran")
	}
}

func TestLoader_RunRefreshesOnTickAndStopsOnCancel(t *testing.T) {
	src := &fakeSource{rules: []ActiveRule{{ID: "row-1", TenantID: "tenant-a", RuleYAML: tenantARule}}}
	l := NewLoader(src, slog.Default())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.Run(ctx, 10*time.Millisecond)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(l.Active("tenant-a")) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(l.Active("tenant-a")) != 1 {
		t.Fatalf("Run did not load the rule within the deadline, got %d active", len(l.Active("tenant-a")))
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop within 2s of cancellation")
	}
}
