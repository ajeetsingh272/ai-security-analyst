//go:build integration

package hotfix

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

func createFixtureUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var userID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
		"p2-12-probe-"+time.Now().Format("20060102150405.000000000")+"@example.invalid", "P2-12 probe user",
	).Scan(&userID); err != nil {
		t.Fatalf("creating user fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	return userID
}

// insertHotfixRule writes a real row with createdAgo subtracted from
// created_at — the trigger (0008_hotfix_rules.sql's own
// hotfix_rules_force_expiry_trigger) derives expires_at from WHATEVER
// created_at ends up being, so backdating it this way is how a real
// "created 8 days ago, now expired" row gets simulated without waiting
// 7 real days — the exact same computation a genuinely old row went
// through.
func insertHotfixRule(t *testing.T, pool *pgxpool.Pool, ruleID, ruleYAML, createdBy string, createdAgo time.Duration) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO hotfix_rules (rule_id, rule_title, rule_yaml, reason, created_by, created_at)
		 VALUES ($1, $1, $2, 'P2-12 integration test probe', $3, $4)
		 RETURNING id`,
		ruleID, ruleYAML, createdBy, time.Now().Add(-createdAgo),
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting hotfix rule fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM hotfix_rules WHERE id = $1`, id)
	})
	return id
}

func probeRuleYAML(id string) string {
	return "id: " + id + `
title: P2-12 probe rule
owner_description: A probe rule for the hotfix loader's own integration test.
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
}

// T2: "A hotfix rule stops evaluating after 7 days." A row created 8
// days ago (trigger-derived expires_at: 1 day in the past) must not be
// returned by ActiveRuleYAML at all — proven against the real
// Postgres table and the real trigger, not a mocked expiry check.
func TestPostgresSource_ExpiredRuleIsExcluded(t *testing.T) {
	pool := newTestPool(t)
	userID := createFixtureUser(t, pool)

	expiredID := insertHotfixRule(t, pool, "p2-12-expired", probeRuleYAML("p2-12-expired"), userID, 8*24*time.Hour)
	freshID := insertHotfixRule(t, pool, "p2-12-fresh", probeRuleYAML("p2-12-fresh"), userID, 1*time.Hour)

	source := NewPostgresSource(pool)
	active, err := source.ActiveRuleYAML(context.Background())
	if err != nil {
		t.Fatalf("ActiveRuleYAML: %v", err)
	}

	var sawFresh, sawExpired bool
	for _, r := range active {
		if r.ID == freshID {
			sawFresh = true
		}
		if r.ID == expiredID {
			sawExpired = true
		}
	}
	if !sawFresh {
		t.Errorf("fresh (1h old) hotfix rule not returned by ActiveRuleYAML, want it present")
	}
	if sawExpired {
		t.Errorf("an 8-day-old hotfix rule was returned by ActiveRuleYAML, want it excluded (T2: stops evaluating after 7 days)")
	}
}

// The end-to-end counterpart to the unit tests in loader_test.go,
// against the real table: Loader.Run, backed by a real PostgresSource,
// actually surfaces a freshly created real row through Active().
func TestLoader_RealPostgresSourceLoadsActiveRule(t *testing.T) {
	pool := newTestPool(t)
	userID := createFixtureUser(t, pool)
	insertHotfixRule(t, pool, "p2-12-real-load", probeRuleYAML("p2-12-real-load"), userID, 0)

	l := NewLoader(NewPostgresSource(pool), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go l.Run(ctx, 50*time.Millisecond)

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		for _, r := range l.Active() {
			if r.ID == "p2-12-real-load" {
				return // found it — test passes
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("hotfix rule p2-12-real-load never appeared in Active() within the deadline, got: %+v", l.Active())
}
