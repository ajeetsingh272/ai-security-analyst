//go:build integration

package cluster

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// createMSPTenant uses the 'msp' plan (scoring.EscalationThreshold's
// own lowest tier, 20) deliberately — these tests need a single
// critical-severity signal's own score (21) to already clear the bar,
// unlike the shared createTenant helper's 'trial' plan (threshold 40),
// which several OTHER tests in this package rely on specifically to
// stay BELOW threshold for a single medium-severity signal.
func createMSPTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, plan) VALUES ($1, 'msp') RETURNING id`,
		"P4-01 publisher probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// fakePublisher is a CaseEventPublisher test double — records every
// call, optionally failing on command, so a test can assert "exactly
// once" and "retried by the catch-up sweep after a failure" without a
// real Kafka broker.
type fakePublisher struct {
	mu       sync.Mutex
	calls    []string // "tenantID:caseID", in call order
	failNext bool
}

func (p *fakePublisher) PublishEscalated(_ context.Context, tenantID, caseID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failNext {
		p.failNext = false
		return errPublishFailed
	}
	p.calls = append(p.calls, tenantID+":"+caseID)
	return nil
}

func (p *fakePublisher) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

var errPublishFailed = &publishTestError{}

type publishTestError struct{}

func (*publishTestError) Error() string { return "fake publisher: simulated failure" }

// A case whose score crosses the escalation threshold on the signal
// that creates it publishes exactly once, and cases.escalated_at is
// set.
func TestPostgresStore_PublishesEscalatedCaseExactlyOnce(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createMSPTenant(t, pool)
	pub := &fakePublisher{}
	c := NewClusterer(NewPostgresStore(pool, pub), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	// critical severity + two distinct ATT&CK tactics clears every
	// plan tier's threshold with real margin (same technique IDs
	// P3-04/P3-09's own tests already use).
	caseID, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "escalate-me", Severity: "critical",
		EventIDs: []string{"evt-1"}, DetectedAt: base, MitreIDs: []string{"T1110.003"},
	})
	if err != nil {
		t.Fatalf("Cluster (first signal): %v", err)
	}
	if _, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-2:s2", SignalID: "s2", RuleID: "rule-2",
		EntityType: "user", EntityID: "escalate-me", Severity: "high",
		EventIDs: []string{"evt-2"}, DetectedAt: base.Add(time.Minute), MitreIDs: []string{"T1136.003"},
	}); err != nil {
		t.Fatalf("Cluster (second signal): %v", err)
	}
	// A third signal after the case has ALREADY escalated must not
	// publish again.
	if _, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-3:s3", SignalID: "s3", RuleID: "rule-3",
		EntityType: "user", EntityID: "escalate-me", Severity: "low",
		EventIDs: []string{"evt-3"}, DetectedAt: base.Add(2 * time.Minute),
	}); err != nil {
		t.Fatalf("Cluster (third signal): %v", err)
	}

	if got := pub.callCount(); got != 1 {
		t.Fatalf("publisher was called %d times, want exactly 1", got)
	}

	var escalatedAt, escalatedPublishedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT escalated_at, escalated_published_at FROM cases WHERE id = $1`, caseID).Scan(&escalatedAt, &escalatedPublishedAt); err != nil {
		t.Fatalf("reading escalated_at/escalated_published_at: %v", err)
	}
	if escalatedAt == nil {
		t.Error("expected escalated_at to be set")
	}
	if escalatedPublishedAt == nil {
		t.Error("expected escalated_published_at to be set after a successful publish")
	}
}

// A case whose score never crosses the threshold never publishes.
func TestPostgresStore_NeverPublishesANonEscalatedCase(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	pub := &fakePublisher{}
	c := NewClusterer(NewPostgresStore(pool, pub), DefaultWindow)
	ctx := context.Background()

	if _, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "never-escalates", Severity: "low",
		EventIDs: []string{"evt-1"}, DetectedAt: time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Cluster: %v", err)
	}
	if got := pub.callCount(); got != 0 {
		t.Errorf("publisher was called %d times, want 0", got)
	}
}

// A fast-path publish that fails is retried by CloseQuietCases' own
// catch-up sweep — proven by forcing the FIRST attempt to fail, then
// running the sweep and confirming a second attempt succeeds and
// escalated_at ends up set.
func TestPostgresStore_CloseQuietCasesRetriesAFailedPublish(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createMSPTenant(t, pool)
	pub := &fakePublisher{failNext: true}
	c := NewClusterer(NewPostgresStore(pool, pub), DefaultWindow)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 2, 0, 0, 0, time.UTC)

	caseID, err := c.Cluster(ctx, tenantID, Signal{
		DedupeKey: tenantID + ":rule-1:s1", SignalID: "s1", RuleID: "rule-1",
		EntityType: "user", EntityID: "retry-me", Severity: "critical",
		EventIDs: []string{"evt-1"}, DetectedAt: base, MitreIDs: []string{"T1110.003"},
	})
	if err != nil {
		t.Fatalf("Cluster: %v", err)
	}
	if got := pub.callCount(); got != 0 {
		t.Fatalf("the forced failure should have prevented any successful call, got %d", got)
	}

	// escalated_at is set regardless of the publish outcome (it means
	// "decided", not "delivered") — escalated_published_at is the one
	// that must still be NULL after a failed attempt.
	var escalatedAt, escalatedPublishedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT escalated_at, escalated_published_at FROM cases WHERE id = $1`, caseID).Scan(&escalatedAt, &escalatedPublishedAt); err != nil {
		t.Fatalf("reading escalated_at/escalated_published_at: %v", err)
	}
	if escalatedAt == nil {
		t.Fatal("escalated_at should be set as soon as the case is decided escalated, regardless of publish outcome")
	}
	if escalatedPublishedAt != nil {
		t.Fatal("escalated_published_at should still be NULL after a failed publish attempt")
	}

	if _, err := c.CloseQuietCases(ctx, tenantID, 30*time.Minute, base.Add(31*time.Minute)); err != nil {
		t.Fatalf("CloseQuietCases: %v", err)
	}

	if got := pub.callCount(); got != 1 {
		t.Fatalf("publisher was called %d times after the catch-up sweep, want exactly 1", got)
	}
	if err := pool.QueryRow(ctx, `SELECT escalated_published_at FROM cases WHERE id = $1`, caseID).Scan(&escalatedPublishedAt); err != nil {
		t.Fatalf("reading escalated_published_at: %v", err)
	}
	if escalatedPublishedAt == nil {
		t.Error("expected escalated_published_at to be set after the catch-up sweep successfully republishes")
	}
}
