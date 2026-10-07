//go:build integration

package noiseratio

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/cluster"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/reduction"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/scoring"
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

// createTenant uses the 'msp' plan deliberately — AC2/AC3's own
// "ratio at least 10:1" and "no benign pattern escalates" need to hold
// for a REAL plan tier's threshold, and MSP's is the lowest
// (scoring.EscalationThreshold), making it the hardest bar for the
// benign signals to clear — if they stay below THIS threshold, they
// stay below every other tier's too.
func createTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, plan) VALUES ($1, 'msp') RETURNING id`,
		"P3-09 noise-ratio probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// replay feeds every signal in the dataset through the real
// Clusterer, in chronological order — the order a real stream would
// actually deliver them, which matters: clustering's own sliding-
// window decision depends on arrival order, not just final content.
func replay(t *testing.T, ctx context.Context, tenantID string, clusterer *cluster.Clusterer, ds Dataset) {
	t.Helper()
	signals := make([]cluster.Signal, len(ds.Signals))
	copy(signals, ds.Signals)
	sort.Slice(signals, func(i, j int) bool { return signals[i].DetectedAt.Before(signals[j].DetectedAt) })

	for _, sig := range signals {
		if _, err := clusterer.Cluster(ctx, tenantID, sig); err != nil {
			t.Fatalf("clustering signal %s: %v", sig.SignalID, err)
		}
	}
}

type measurement struct {
	signalsIn       int
	casesEscalated  int
	escalatedCaseID string // only meaningful when casesEscalated == 1
	nonAttackScores []float64
}

func measure(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string, threshold float64) measurement {
	t.Helper()
	var m measurement
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM case_signals WHERE tenant_id = $1`, tenantID).Scan(&m.signalsIn); err != nil {
		t.Fatalf("counting signals: %v", err)
	}

	rows, err := pool.Query(ctx,
		`SELECT c.id, c.score, bool_or(cs.entity_id = $2) AS is_attack_case
		   FROM cases c JOIN case_signals cs ON cs.case_id = c.id
		  WHERE c.tenant_id = $1
		  GROUP BY c.id, c.score`,
		tenantID, AttackCaseEntityID,
	)
	if err != nil {
		t.Fatalf("querying cases: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var caseID string
		var score *float64
		var isAttack bool
		if err := rows.Scan(&caseID, &score, &isAttack); err != nil {
			t.Fatalf("scanning case row: %v", err)
		}
		s := 0.0
		if score != nil {
			s = *score
		}
		if s >= threshold {
			m.casesEscalated++
			m.escalatedCaseID = caseID
		}
		if !isAttack {
			m.nonAttackScores = append(m.nonAttackScores, s)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating case rows: %v", err)
	}
	return m
}

// T1/T2/T3, all from one replay: separate replays would each pay the
// full dataset's own insert cost again for no real isolation benefit —
// every assertion below reads the SAME, single, deterministic result.
func TestNoiseRatio_ReferenceDatasetAtReducedScale(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	ctx := context.Background()
	threshold := scoring.EscalationThreshold(scoring.PlanMSP)

	weekStart := time.Date(2026, 2, 2, 0, 0, 0, 0, time.UTC) // a Monday
	ds := Build(Reduced, weekStart)

	clusterer := cluster.NewClusterer(cluster.NewPostgresStore(pool, nil), cluster.DefaultWindow)
	replay(t, ctx, tenantID, clusterer, ds)

	m := measure(t, ctx, pool, tenantID, threshold)

	if m.signalsIn != ds.TotalSignalCount {
		t.Fatalf("got %d signals clustered, want %d (the full dataset)", m.signalsIn, ds.TotalSignalCount)
	}

	// T2: the seeded attack sequence yields exactly one escalated case.
	if m.casesEscalated != 1 {
		t.Fatalf("got %d escalated cases, want exactly 1 (the seeded attack)", m.casesEscalated)
	}

	// T3: no benign pattern in the reference set escalates — every
	// non-attack case's own score stayed below threshold.
	for i, score := range m.nonAttackScores {
		if score >= threshold {
			t.Errorf("benign case %d scored %v, at/above threshold %v — a false escalation", i, score, threshold)
		}
	}

	// T1: the reduction ratio on the reference dataset is at least 10:1.
	ratio, ok := reduction.Ratio(uint64(m.signalsIn), uint64(m.casesEscalated))
	if !ok {
		t.Fatal("reduction.Ratio reported not-ok for a non-zero signal count")
	}
	if ratio < 10 {
		t.Fatalf("got reduction ratio %v, want at least 10:1 (signals=%d, escalated=%d)", ratio, m.signalsIn, m.casesEscalated)
	}
	t.Logf("noise-ratio reference dataset (reduced scale): signals=%d escalated=%d ratio=%.1f:1",
		m.signalsIn, m.casesEscalated, ratio)
}
