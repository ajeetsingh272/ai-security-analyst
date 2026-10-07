//go:build integration

package cluster

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func createTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"P3-02 probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// T5: "The brief's BEC scenario — impossible travel then inbox rule —
// produces exactly one case." The real published timeline (02:14
// impossible travel, 02:17 inbox rule, 3 minutes apart, same user) —
// both signals carry the same entity (confirmed live at the
// services/detect/internal/worker layer, worker_test.go's own
// TestEvaluate_SignalCarriesEntityWhenEventHasUserId: an in-stream
// signal now carries EntityID when its event has one, which is what
// makes an in-stream inbox-rule signal clusterable with a windowed
// impossible-travel signal at all).
func TestPostgresStore_BECScenarioProducesExactlyOneCase(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	c := NewClusterer(NewPostgresStore(pool), DefaultWindow)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 2, 14, 0, 0, time.UTC)
	const impossibleTravelRuleID = "8f1a2b3c-0001-4a00-9000-000000000008"
	const inboxRuleID = "8f1a2b3c-0001-4a00-9000-000000000001"
	const entityID = "priya@northwind.example"

	travelSignal := Signal{
		DedupeKey: tenantID + ":" + impossibleTravelRuleID + ":" + entityID,
		SignalID:  "sig-travel", RuleID: impossibleTravelRuleID,
		EntityType: "user", EntityID: entityID, Severity: "high",
		EventIDs: []string{"evt-travel-1", "evt-travel-2"}, DetectedAt: base, // 02:14
	}
	inboxSignal := Signal{
		DedupeKey: tenantID + ":" + inboxRuleID + ":evt-inbox-1",
		SignalID:  "sig-inbox", RuleID: inboxRuleID,
		EntityType: "user", EntityID: entityID, Severity: "medium",
		EventIDs: []string{"evt-inbox-1"}, DetectedAt: base.Add(3 * time.Minute), // 02:17
	}

	id1, err := c.Cluster(ctx, tenantID, travelSignal)
	if err != nil {
		t.Fatalf("Cluster (impossible travel): %v", err)
	}
	id2, err := c.Cluster(ctx, tenantID, inboxSignal)
	if err != nil {
		t.Fatalf("Cluster (inbox rule): %v", err)
	}

	if id1 != id2 {
		t.Fatalf("impossible-travel and inbox-rule signals landed in DIFFERENT cases (%s, %s), want exactly one case", id1, id2)
	}

	var signalCount int
	var windowEnd *time.Time
	if err := pool.QueryRow(context.Background(), `SELECT signal_count, window_end FROM cases WHERE id = $1`, id1).Scan(&signalCount, &windowEnd); err != nil {
		t.Fatalf("reading case row: %v", err)
	}
	if signalCount != 2 {
		t.Errorf("signal_count = %d, want 2", signalCount)
	}
	if windowEnd != nil {
		t.Errorf("window_end = %v, want nil (case still open)", windowEnd)
	}

	var caseSignalCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM case_signals WHERE case_id = $1`, id1).Scan(&caseSignalCount); err != nil {
		t.Fatalf("counting case_signals: %v", err)
	}
	if caseSignalCount != 2 {
		t.Errorf("case_signals rows = %d, want 2", caseSignalCount)
	}
}

// Real-Postgres counterpart to T4's own in-memory proof: a quiet
// period sweep against the real table closes exactly the cases it
// should, and leaves the case_transitions trail behind.
//
// P3-07/TG3: a single medium-severity signal's own score never
// crosses any plan tier's escalation threshold, so this case —
// unchanged from P3-03's own original fixture — now DISMISSES on
// quiet timeout rather than closing. That is the intended, correct
// behaviour this ticket introduces, not a regression: this case was
// never going to be escalated, so quiet-timing it out is exactly the
// "non-escalated" path AC1 requires a machine-readable reason for.
// TestPostgresStore_EscalatedCaseStillClosesOnQuietTimeout below
// covers the other branch.
func TestPostgresStore_CloseQuietCasesRecordsDismissalForNonEscalatedCase(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	c := NewClusterer(NewPostgresStore(pool), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	caseID, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "priya", Severity: "medium",
		EventIDs: []string{"evt-1"}, DetectedAt: base,
	})
	if err != nil {
		t.Fatalf("Cluster: %v", err)
	}

	closed, err := c.CloseQuietCases(ctx, tenantID, 30*time.Minute, base.Add(31*time.Minute))
	if err != nil {
		t.Fatalf("CloseQuietCases: %v", err)
	}
	if closed != 1 {
		t.Fatalf("closed = %d, want 1", closed)
	}

	var toState, reason string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_state, reason FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1`, caseID,
	).Scan(&toState, &reason); err != nil {
		t.Fatalf("reading the latest case_transitions row: %v", err)
	}
	if toState != "dismissed" {
		t.Errorf("to_state = %q, want %q (this case's score never crossed any escalation threshold)", toState, "dismissed")
	}
	if reason != "below_escalation_threshold" {
		t.Errorf("reason = %q, want the machine-readable %q", reason, "below_escalation_threshold")
	}

	// P3-03/AC5: this transition — shipped in P3-02, before the audit
	// writer existed — must now have a matching audit_log entry,
	// written in the same transaction as the case_transitions row.
	var auditCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE subject_type = 'case' AND subject_id = $1 AND action = 'case.transition'`, caseID,
	).Scan(&auditCount); err != nil {
		t.Fatalf("counting audit_log: %v", err)
	}
	if auditCount != 2 { // one for the 'open' transition, one for 'dismissed'
		t.Errorf("audit_log entries for case %s = %d, want 2", caseID, auditCount)
	}
}

// The other branch: a case whose score DID cross the escalation
// threshold still closes normally on quiet timeout — it was never a
// hidden dismissal to begin with. Forced over the threshold directly
// via UPDATE, the same way scoring's own weights are deliberately not
// re-derived here (this test is about CloseQuietCases' own branching,
// not about scoring.Score's correctness, which has its own suite).
func TestPostgresStore_EscalatedCaseStillClosesOnQuietTimeout(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	c := NewClusterer(NewPostgresStore(pool), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	caseID, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "priya", Severity: "critical",
		EventIDs: []string{"evt-1"}, DetectedAt: base,
	})
	if err != nil {
		t.Fatalf("Cluster: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE cases SET score = 999 WHERE id = $1`, caseID); err != nil {
		t.Fatalf("forcing score above threshold: %v", err)
	}

	closed, err := c.CloseQuietCases(ctx, tenantID, 30*time.Minute, base.Add(31*time.Minute))
	if err != nil {
		t.Fatalf("CloseQuietCases: %v", err)
	}
	if closed != 1 {
		t.Fatalf("closed = %d, want 1", closed)
	}

	var toState string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1`, caseID,
	).Scan(&toState); err != nil {
		t.Fatalf("reading the latest case_transitions row: %v", err)
	}
	if toState != "closed" {
		t.Errorf("to_state = %q, want %q (this case's score crossed the escalation threshold)", toState, "closed")
	}
}

// P3-04: a case's stored score is recomputed, in the same transaction,
// every time a signal joins it — real Postgres, not the pure
// scoring.Score unit tests alone. A second signal in a different
// ATT&CK tactic (credential-access, then persistence) must raise the
// stored score; flagging the case's own entity as high-criticality
// must raise it further.
func TestPostgresStore_ScoreIsRecomputedAsSignalsJoinAndEntityIsFlagged(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	c := NewClusterer(NewPostgresStore(pool), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)

	caseID, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "dana", Severity: "medium",
		EventIDs: []string{"evt-1"}, DetectedAt: base,
		MitreIDs: []string{"T1110.003"}, // credential-access
	})
	if err != nil {
		t.Fatalf("Cluster (first signal): %v", err)
	}

	scoreAfterFirst := readCaseScore(t, pool, caseID)

	if _, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-2:s2", SignalID: "s2", RuleID: "rule-2",
		EntityType: "user", EntityID: "dana", Severity: "medium",
		EventIDs: []string{"evt-2"}, DetectedAt: base.Add(5 * time.Minute),
		MitreIDs: []string{"T1136.003"}, // persistence — a second kill-chain stage
	}); err != nil {
		t.Fatalf("Cluster (second signal): %v", err)
	}

	scoreAfterSecond := readCaseScore(t, pool, caseID)
	if scoreAfterSecond <= scoreAfterFirst {
		t.Fatalf("score after a second kill-chain stage (%v) did not exceed the score after the first signal (%v)", scoreAfterSecond, scoreAfterFirst)
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO entity_criticality (tenant_id, entity_type, entity_id, criticality) VALUES ($1, 'user', 'dana', 'high')`,
		tenantID,
	); err != nil {
		t.Fatalf("flagging entity criticality: %v", err)
	}
	if _, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-3:s3", SignalID: "s3", RuleID: "rule-3",
		EntityType: "user", EntityID: "dana", Severity: "medium",
		EventIDs: []string{"evt-3"}, DetectedAt: base.Add(10 * time.Minute),
	}); err != nil {
		t.Fatalf("Cluster (third signal, after flagging criticality): %v", err)
	}

	scoreAfterFlagged := readCaseScore(t, pool, caseID)
	if scoreAfterFlagged <= scoreAfterSecond {
		t.Fatalf("score after flagging the entity high-criticality (%v) did not exceed the score before (%v)", scoreAfterFlagged, scoreAfterSecond)
	}

	var componentsJSON []byte
	if err := pool.QueryRow(ctx, `SELECT score_components FROM cases WHERE id = $1`, caseID).Scan(&componentsJSON); err != nil {
		t.Fatalf("reading score_components: %v", err)
	}
	var components map[string]float64
	if err := json.Unmarshal(componentsJSON, &components); err != nil {
		t.Fatalf("unmarshalling score_components: %v", err)
	}
	var sum float64
	for _, v := range components {
		sum += v
	}
	if sum != scoreAfterFlagged {
		t.Errorf("stored score_components sum to %v, want the stored score %v", sum, scoreAfterFlagged)
	}
	if components["entityCriticality"] == 0 {
		t.Error("expected a non-zero entityCriticality component after flagging the entity high")
	}
	if components["killChainProgression"] == 0 {
		t.Error("expected a non-zero killChainProgression component after the second kill-chain stage")
	}
}

func readCaseScore(t *testing.T, pool *pgxpool.Pool, caseID string) float64 {
	t.Helper()
	var score float64
	if err := pool.QueryRow(context.Background(), `SELECT score FROM cases WHERE id = $1`, caseID).Scan(&score); err != nil {
		t.Fatalf("reading score for case %s: %v", caseID, err)
	}
	return score
}
