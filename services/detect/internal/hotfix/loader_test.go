package hotfix

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

const validInStreamYAML = `title: Hotfix probe rule
id: hotfix-probe-1
owner_description: A probe rule for the hotfix loader's own tests.
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

const windowedYAML = `title: Hotfix probe windowed rule
id: hotfix-probe-windowed
owner_description: A probe rule for the hotfix loader's own tests.
tags:
  - attack.t1078
logsource:
  product: m365
detection:
  selection:
    Operation: 'Send'
  condition: selection | count() by UserId > 5 within 10m
level: high
`

const malformedYAML = `this is not: [valid yaml structure for a rule`

type fakeSource struct {
	rules []StoredRule
	err   error
}

func (f *fakeSource) ActiveRuleYAML(context.Context) ([]StoredRule, error) {
	return f.rules, f.err
}

func TestLoader_ValidRuleLoads(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []StoredRule{{ID: "row-1", RuleYAML: validInStreamYAML}}}, nil)
	l.refreshOnce(context.Background())

	active := l.Active()
	if len(active) != 1 {
		t.Fatalf("got %d active rules, want 1: %+v", len(active), active)
	}
	if active[0].ID != "hotfix-probe-1" {
		t.Errorf("ID = %q, want hotfix-probe-1", active[0].ID)
	}
}

// ADR-0004's own "small" framing: a windowed (aggregation) rule must
// never load through this path — sigmac.Evaluate silently ignores
// Aggregation, so letting one through would misrepresent what actually
// gets evaluated.
func TestLoader_WindowedRuleSkipped(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []StoredRule{{ID: "row-1", RuleYAML: windowedYAML}}}, nil)
	l.refreshOnce(context.Background())

	if active := l.Active(); len(active) != 0 {
		t.Fatalf("got %d active rules, want 0 (windowed rule must be skipped): %+v", len(active), active)
	}
}

func TestLoader_MalformedYAMLSkipped(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []StoredRule{{ID: "row-1", RuleYAML: malformedYAML}}}, nil)
	l.refreshOnce(context.Background())

	if active := l.Active(); len(active) != 0 {
		t.Fatalf("got %d active rules, want 0 (malformed YAML must be skipped): %+v", len(active), active)
	}
}

// One bad row must not prevent a GOOD row in the same refresh from
// loading — the same "one rule's own problem doesn't take down every
// other rule" doctrine services/detect/internal/worker's own
// safeMatch already applies at evaluation time, here applied at load
// time instead.
func TestLoader_OneBadRowDoesNotBlockGoodRows(t *testing.T) {
	l := NewLoader(&fakeSource{rules: []StoredRule{
		{ID: "row-1", RuleYAML: validInStreamYAML},
		{ID: "row-2", RuleYAML: malformedYAML},
	}}, nil)
	l.refreshOnce(context.Background())

	active := l.Active()
	if len(active) != 1 || active[0].ID != "hotfix-probe-1" {
		t.Fatalf("got %+v, want exactly the one good rule", active)
	}
}

func TestLoader_RefreshFailureKeepsPreviousSnapshot(t *testing.T) {
	src := &fakeSource{rules: []StoredRule{{ID: "row-1", RuleYAML: validInStreamYAML}}}
	l := NewLoader(src, nil)
	l.refreshOnce(context.Background())
	if len(l.Active()) != 1 {
		t.Fatalf("setup: expected 1 active rule before the failing refresh")
	}

	src.err = errors.New("postgres unreachable")
	l.refreshOnce(context.Background())

	if active := l.Active(); len(active) != 1 {
		t.Fatalf("got %d active rules after a failed refresh, want the previous snapshot (1) preserved: %+v", len(active), active)
	}
}

func TestLoader_ActiveNeverNilBeforeFirstRefresh(t *testing.T) {
	l := NewLoader(&fakeSource{}, nil)
	if active := l.Active(); active == nil {
		t.Fatal("Active() returned nil before any refresh ran, want an empty (non-nil) slice")
	}
}

func TestLoader_RunRefreshesOnTickAndStopsOnCancel(t *testing.T) {
	src := &fakeSource{rules: []StoredRule{{ID: "row-1", RuleYAML: validInStreamYAML}}}
	l := NewLoader(src, slog.Default())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		l.Run(ctx, 10*time.Millisecond)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(l.Active()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(l.Active()) != 1 {
		t.Fatalf("Run did not load the rule within the deadline, got %d active", len(l.Active()))
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop within 2s of cancellation")
	}
}
