package worker

import (
	"context"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelenrich"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

func TestFlatten(t *testing.T) {
	wev := wireEvent{
		TenantID:    "tenant-1",
		EventID:     "evt-1",
		ClassUID:    3002,
		CategoryUID: 3,
		ActivityID:  1,
		SeverityID:  2,
		Metadata:    map[string]string{"product": "m365", "operation": "New-InboxRule"},
		Unmapped:    map[string]string{"UserId": "user@example.com"},
	}

	flat := flatten(wev, nil)

	want := map[string]string{
		"tenant_id":          "tenant-1",
		"class_uid":          "3002",
		"category_uid":       "3",
		"activity_id":        "1",
		"severity_id":        "2",
		"metadata.event_id":  "evt-1",
		"metadata.product":   "m365",
		"metadata.operation": "New-InboxRule",
		"unmapped.UserId":    "user@example.com",
	}
	if len(flat) != len(want) {
		t.Fatalf("flatten() produced %d keys, want %d: %v", len(flat), len(want), flat)
	}
	for k, v := range want {
		if flat[k] != v {
			t.Errorf("flat[%q] = %q, want %q", k, flat[k], v)
		}
	}
}

type fakeEnricher struct {
	byIP map[string]sentinelenrich.Classification
}

func (f fakeEnricher) Lookup(ip string) sentinelenrich.Classification {
	return f.byIP[ip]
}

// P2-09: flatten attaches enrichment fields when the event carries a
// ClientIP, and only then — proven directly against a fake Enricher so
// this test needs no real feeds at all.
func TestFlatten_AttachesEnrichmentWhenClientIPPresent(t *testing.T) {
	enricher := fakeEnricher{byIP: map[string]sentinelenrich.Classification{
		"198.51.100.7": {IsTorExit: true, Country: "RO", ASN: 64500, ASName: "Example Exit Operator"},
	}}
	wev := wireEvent{
		TenantID: "tenant-1", EventID: "evt-1",
		Unmapped: map[string]string{"ClientIP": "198.51.100.7"},
	}

	flat := flatten(wev, enricher)

	if flat["metadata.is_anonymous_proxy"] != "true" {
		t.Errorf("metadata.is_anonymous_proxy = %q, want true", flat["metadata.is_anonymous_proxy"])
	}
	if flat["metadata.is_vpn"] != "false" {
		t.Errorf("metadata.is_vpn = %q, want false", flat["metadata.is_vpn"])
	}
	if flat["metadata.geo_country"] != "RO" {
		t.Errorf("metadata.geo_country = %q, want RO", flat["metadata.geo_country"])
	}
	if flat["metadata.geo_asn"] != "64500" {
		t.Errorf("metadata.geo_asn = %q, want 64500", flat["metadata.geo_asn"])
	}
}

func TestFlatten_NoEnrichmentFieldsWithoutClientIP(t *testing.T) {
	enricher := fakeEnricher{byIP: map[string]sentinelenrich.Classification{}}
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1"}

	flat := flatten(wev, enricher)

	for _, k := range []string{"metadata.is_anonymous_proxy", "metadata.is_vpn", "metadata.is_hosting_provider", "metadata.geo_country", "metadata.geo_asn"} {
		if _, ok := flat[k]; ok {
			t.Errorf("flat[%q] is set, want absent when the event has no ClientIP", k)
		}
	}
}

func TestFlatten_NilEnricherAttachesNothing(t *testing.T) {
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", Unmapped: map[string]string{"ClientIP": "198.51.100.7"}}
	flat := flatten(wev, nil)
	if _, ok := flat["metadata.is_anonymous_proxy"]; ok {
		t.Error("expected no enrichment fields with a nil Enricher")
	}
}

// buildTestTree builds a two-rule tree: one ordinary rule that matches on
// class_uid "3001", and one whose compiled predicate always panics —
// synthesized by hand the same way
// services/detect/internal/dispatch's own load_test.go builds synthetic
// rules, so this test needs no real corpus or fixtures.
func buildTestTree(t *testing.T) *dispatch.Tree {
	t.Helper()

	okRule := &sigmac.Rule{
		ID:       "ok-rule",
		Slug:     "ok-rule",
		Title:    "OK rule",
		Level:    "medium",
		MitreIDs: []string{"attack.t1078"},
		LogSource: sigmac.LogSource{
			Product: "m365",
		},
		Selections: map[string]sigmac.Selection{
			"selection": {
				Name: "selection",
				Fields: []sigmac.FieldMatch{
					{SigmaField: "class_uid", OCSFPath: "class_uid", Modifier: sigmac.ModEquals, Values: []string{"3001"}},
				},
			},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
		Engine:    sigmac.EngineInStream,
	}
	panicRule := &sigmac.Rule{
		ID:       "panic-rule",
		Slug:     "panic-rule",
		Title:    "Panic rule",
		Level:    "high",
		MitreIDs: []string{"attack.t1078"},
		LogSource: sigmac.LogSource{
			Product: "m365",
		},
		Selections: map[string]sigmac.Selection{
			"selection": {
				Name: "selection",
				Fields: []sigmac.FieldMatch{
					{SigmaField: "class_uid", OCSFPath: "class_uid", Modifier: sigmac.ModEquals, Values: []string{"3001"}},
				},
			},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
		Engine:    sigmac.EngineInStream,
	}

	compiled := []detectgen.CompiledRule{
		{
			ID: "ok-rule", Title: "OK rule", Level: "medium", MitreIDs: []string{"attack.t1078"}, Engine: "in-stream",
			Matches: func(ev map[string]string) bool { return ev["class_uid"] == "3001" },
		},
		{
			ID: "panic-rule", Title: "Panic rule", Level: "high", MitreIDs: []string{"attack.t1078"}, Engine: "in-stream",
			Matches: func(ev map[string]string) bool { panic("boom") },
		},
	}

	tree, err := dispatch.Build([]*sigmac.Rule{okRule, panicRule}, compiled, dispatch.Options{})
	if err != nil {
		t.Fatalf("dispatch.Build: %v", err)
	}
	return tree
}

// T4: an evaluation panic is recovered, routed to a failure the caller can
// DLQ, and the worker continues — proven here by checking the OTHER
// candidate rule (ok-rule) still runs and still matches against the same
// event the panicking rule was also a candidate for.
func TestEvaluate_RecoversPanicAndContinues(t *testing.T) {
	tree := buildTestTree(t)
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", ClassUID: 3001, Metadata: map[string]string{"product": "m365"}}

	signals, failures := evaluate(context.Background(), tree, wev, nil, nil)

	if len(failures) != 1 || failures[0].RuleID != "panic-rule" {
		t.Fatalf("failures = %v, want exactly one failure for panic-rule", failures)
	}
	if failures[0].Err == nil {
		t.Fatal("failures[0].Err is nil, want the recovered panic wrapped as an error")
	}

	if len(signals) != 1 || signals[0].RuleID != "ok-rule" {
		t.Fatalf("signals = %v, want exactly one signal for ok-rule", signals)
	}
}

func TestEvaluate_SignalCarriesEventRuleAndTenant(t *testing.T) {
	tree := buildTestTree(t)
	wev := wireEvent{TenantID: "tenant-42", EventID: "evt-99", ClassUID: 3001, Metadata: map[string]string{"product": "m365"}}

	signals, _ := evaluate(context.Background(), tree, wev, nil, nil)

	if len(signals) != 1 {
		t.Fatalf("got %d signals, want 1", len(signals))
	}
	sig := signals[0]
	if len(sig.EventIDs) != 1 || sig.EventIDs[0] != "evt-99" {
		t.Errorf("EventIDs = %v, want [evt-99]", sig.EventIDs)
	}
	if sig.TenantID != "tenant-42" {
		t.Errorf("TenantID = %q, want tenant-42", sig.TenantID)
	}
	if sig.RuleID != "ok-rule" {
		t.Errorf("RuleID = %q, want ok-rule", sig.RuleID)
	}
	if sig.Severity != "medium" {
		t.Errorf("Severity = %q, want medium", sig.Severity)
	}
	if len(sig.MitreIDs) != 1 || sig.MitreIDs[0] != "attack.t1078" {
		t.Errorf("MitreIDs = %v, want [attack.t1078]", sig.MitreIDs)
	}
	if sig.SignalID == "" {
		t.Error("SignalID is empty, want a generated id")
	}
}

// evaluate must never surface a "windowed"-engine rule's own match as a
// signal — that rule's compiled predicate only checks its base selection,
// not the count/within clause the separate windowed engine (not yet
// built) is responsible for; firing here would be a premature signal on
// the first qualifying event rather than the Nth within the window.
func TestEvaluate_SkipsWindowedEngineRules(t *testing.T) {
	windowedRule := &sigmac.Rule{
		ID: "windowed-rule", Slug: "windowed-rule", Title: "Windowed rule", Level: "high",
		MitreIDs:  []string{"attack.t1530"},
		LogSource: sigmac.LogSource{Product: "m365"},
		Selections: map[string]sigmac.Selection{
			"selection": {Name: "selection", Fields: []sigmac.FieldMatch{
				{SigmaField: "class_uid", OCSFPath: "class_uid", Modifier: sigmac.ModEquals, Values: []string{"3001"}},
			}},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
		Engine:    sigmac.EngineWindowed,
	}
	compiled := []detectgen.CompiledRule{
		{ID: "windowed-rule", Title: "Windowed rule", Level: "high", MitreIDs: []string{"attack.t1530"}, Engine: "windowed",
			Matches: func(ev map[string]string) bool { return ev["class_uid"] == "3001" }},
	}
	tree, err := dispatch.Build([]*sigmac.Rule{windowedRule}, compiled, dispatch.Options{})
	if err != nil {
		t.Fatalf("dispatch.Build: %v", err)
	}

	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", ClassUID: 3001, Metadata: map[string]string{"product": "m365"}}
	signals, failures := evaluate(context.Background(), tree, wev, nil, nil)

	if len(signals) != 0 || len(failures) != 0 {
		t.Fatalf("signals=%v failures=%v, want both empty — windowed rule must be skipped by the in-stream worker", signals, failures)
	}
}

func TestEvaluate_NoCandidateProducesNoSignalsOrFailures(t *testing.T) {
	tree := buildTestTree(t)
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-2", ClassUID: 9999, Metadata: map[string]string{"product": "m365"}}

	signals, failures := evaluate(context.Background(), tree, wev, nil, nil)

	if len(signals) != 0 || len(failures) != 0 {
		t.Fatalf("signals=%v failures=%v, want both empty for a non-matching class_uid", signals, failures)
	}
}

// P2-12/ADR-0004: fakeHotfixRules is a HotfixRules test double — no
// Postgres, no real hotfix.Loader, just a fixed slice, the same
// "interface at the consumer" pattern fakeEnricher above already uses.
type fakeHotfixRules struct{ rules []*sigmac.Rule }

func (f fakeHotfixRules) Active() []*sigmac.Rule { return f.rules }

func TestEvaluate_HotfixRuleMatchEmitsSignal(t *testing.T) {
	tree := buildTestTree(t) // no candidates will match; proves the hotfix path is independent of dispatch
	hotfix := fakeHotfixRules{rules: []*sigmac.Rule{{
		ID: "hotfix-1", Title: "Hotfix probe", Level: "high", MitreIDs: []string{"attack.t1078"},
		OwnerDescription: "A probe hotfix rule.",
		Selections: map[string]sigmac.Selection{
			"selection": {Name: "selection", Fields: []sigmac.FieldMatch{
				{SigmaField: "Operation", OCSFPath: "metadata.operation", Modifier: sigmac.ModEquals, Values: []string{"UrgentOp"}},
			}},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
	}}}

	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", ClassUID: 9999, Metadata: map[string]string{"product": "m365", "operation": "UrgentOp"}}
	signals, failures := evaluate(context.Background(), tree, wev, nil, hotfix)

	if len(failures) != 0 {
		t.Fatalf("failures = %v, want none", failures)
	}
	if len(signals) != 1 {
		t.Fatalf("got %d signals, want 1: %+v", len(signals), signals)
	}
	if signals[0].RuleID != "hotfix-1" || signals[0].Engine != engineHotfix {
		t.Errorf("signal = %+v, want RuleID=hotfix-1 Engine=%s", signals[0], engineHotfix)
	}
}

func TestEvaluate_NilHotfixRulesEmitsNothingExtra(t *testing.T) {
	tree := buildTestTree(t)
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", ClassUID: 9999, Metadata: map[string]string{"product": "m365"}}

	signals, failures := evaluate(context.Background(), tree, wev, nil, nil)

	if len(signals) != 0 || len(failures) != 0 {
		t.Fatalf("signals=%v failures=%v, want both empty with a nil HotfixRules", signals, failures)
	}
}

// Compiled-corpus candidates and hotfix rules are independent sources
// feeding the SAME signals slice — a hotfix match for one rule must not
// crowd out or interfere with a genuine compiled match for a different
// rule against the same event.
func TestEvaluate_HotfixAndCompiledBothMatchSameEvent(t *testing.T) {
	tree := buildTestTree(t) // has ok-rule, matches class_uid "3001"
	hotfix := fakeHotfixRules{rules: []*sigmac.Rule{{
		ID: "hotfix-1", Title: "Hotfix probe", Level: "high",
		Selections: map[string]sigmac.Selection{
			"selection": {Name: "selection", Fields: []sigmac.FieldMatch{
				{SigmaField: "class_uid", OCSFPath: "class_uid", Modifier: sigmac.ModEquals, Values: []string{"3001"}},
			}},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
	}}}

	// buildTestTree's own candidates for class_uid 3001 are ok-rule
	// (matches) and panic-rule (always panics, by construction) — the
	// panic is expected here and unrelated to the hotfix path; this
	// test only cares that the hotfix match ADDS a signal alongside it.
	wev := wireEvent{TenantID: "tenant-1", EventID: "evt-1", ClassUID: 3001, Metadata: map[string]string{"product": "m365"}}
	signals, failures := evaluate(context.Background(), tree, wev, nil, hotfix)

	if len(failures) != 1 || failures[0].RuleID != "panic-rule" {
		t.Fatalf("failures = %v, want exactly one, from panic-rule", failures)
	}
	if len(signals) != 2 {
		t.Fatalf("got %d signals, want 2 (one compiled from ok-rule, one hotfix): %+v", len(signals), signals)
	}
}

// P3-02's own need: an in-stream signal must carry an entity when the
// underlying event has one, mirroring windowed's own
// entityTypeFromGroupField convention ("UserId" -> "user").
func TestEntityFromFlatEvent_ExtractsUserIdWhenPresent(t *testing.T) {
	entityType, entityID := entityFromFlatEvent(map[string]string{"unmapped.UserId": "priya@northwind.example"})
	if entityType != "user" || entityID != "priya@northwind.example" {
		t.Errorf("got (%q, %q), want (user, priya@northwind.example)", entityType, entityID)
	}
}

func TestEntityFromFlatEvent_EmptyWhenNoCandidateFieldPresent(t *testing.T) {
	entityType, entityID := entityFromFlatEvent(map[string]string{"metadata.operation": "New-InboxRule"})
	if entityType != "" || entityID != "" {
		t.Errorf("got (%q, %q), want (\"\", \"\") — no candidate field present", entityType, entityID)
	}
}

// evaluate() itself must surface this on the Signal — the actual
// integration point P3-02's own clustering depends on.
func TestEvaluate_SignalCarriesEntityWhenEventHasUserId(t *testing.T) {
	tree := buildTestTree(t)
	wev := wireEvent{
		TenantID: "tenant-1", EventID: "evt-1", ClassUID: 3001,
		Metadata: map[string]string{"product": "m365"},
		Unmapped: map[string]string{"UserId": "priya@northwind.example"},
	}
	signals, _ := evaluate(context.Background(), tree, wev, nil, nil)
	if len(signals) != 1 {
		t.Fatalf("got %d signals, want 1", len(signals))
	}
	if signals[0].EntityType != "user" || signals[0].EntityID != "priya@northwind.example" {
		t.Errorf("EntityType/EntityID = %q/%q, want user/priya@northwind.example", signals[0].EntityType, signals[0].EntityID)
	}
	// DedupeKey must stay event-based, not switch to entity-based, for
	// an in-stream signal — see evaluate()'s own comment for why
	// (P2-08/TG4's existing notifier-collapsing semantics).
	if signals[0].DedupeKey != sentinelsignal.NewDedupeKey("tenant-1", "ok-rule", "", []string{"evt-1"}) {
		t.Errorf("DedupeKey = %q, want the event-based form unaffected by the new EntityID", signals[0].DedupeKey)
	}
}
