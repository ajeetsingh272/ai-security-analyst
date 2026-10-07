//go:build integration

package cluster

import (
	"context"
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
func TestPostgresStore_CloseQuietCasesRecordsTransition(t *testing.T) {
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

	var transitionCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM case_transitions WHERE case_id = $1 AND to_state = 'closed'`, caseID,
	).Scan(&transitionCount); err != nil {
		t.Fatalf("counting case_transitions: %v", err)
	}
	if transitionCount != 1 {
		t.Errorf("'closed' transitions for case %s = %d, want 1", caseID, transitionCount)
	}
}
