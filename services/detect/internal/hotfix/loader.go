// Package hotfix is P2-12 — ADR-0004's own named escape hatch: "a small
// interpreted 'hotfix rule' path for urgent detections exists for
// emergencies, capped at 10 active rules and expiring automatically
// after 7 days, forcing proper compilation."
//
// Creating, listing and revoking a hotfix rule is apps/api's job
// (packages/db's HotfixRulesRepository) — that is tenant-facing (well,
// platform-ops-facing) control-plane CRUD, not something the detection
// engine itself does. This package only reads the currently ACTIVE set
// and makes it evaluatable, mirroring go/sentinelenrich.Refresher's own
// shape: a background ticker refreshes an atomically-swapped snapshot,
// so the worker's own hot path never blocks on Postgres and always
// reads a fully-formed, already-validated rule list.
//
// Evaluation itself reuses sigmac.Evaluate — P2-02's own reference
// interpreter, built as the correctness oracle codegen tests check the
// COMPILED path against. That interpreter already IS "a small
// interpreted rule path"; this package is the plumbing that feeds it
// rules sourced from Postgres instead of the committed corpus, not a
// second interpreter.
package hotfix

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StoredRule is one active row's own id (for error messages — which row
// a parse failure came from) and raw Sigma YAML.
type StoredRule struct {
	ID       string
	RuleYAML string
}

// RuleSource is what Loader actually depends on — an interface, not
// PostgresSource directly, so the filtering logic in refreshOnce (bad
// YAML skipped, a windowed Aggregation skipped) has a unit test that
// needs no real Postgres, the same "interface at the consumer" pattern
// suppression.Checker and sentinelconnector.CursorStorer already use in
// this codebase.
type RuleSource interface {
	ActiveRuleYAML(ctx context.Context) ([]StoredRule, error)
}

// PostgresSource reads hotfix_rules directly — a plain query, not
// sentineldb.WithTenantContext: this table carries no tenant_id and no
// RLS policy (0008_hotfix_rules.sql's own doc comment explains why —
// the AC1 cap is platform-wide, not per-tenant), so there is no tenant
// context to establish and no role switch that would accomplish
// anything here.
type PostgresSource struct {
	pool *pgxpool.Pool
}

func NewPostgresSource(pool *pgxpool.Pool) *PostgresSource {
	return &PostgresSource{pool: pool}
}

func (s *PostgresSource) ActiveRuleYAML(ctx context.Context) ([]StoredRule, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, rule_yaml FROM hotfix_rules WHERE revoked_at IS NULL AND expires_at > now()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []StoredRule
	for rows.Next() {
		var sr StoredRule
		if err := rows.Scan(&sr.ID, &sr.RuleYAML); err != nil {
			return nil, err
		}
		out = append(out, sr)
	}
	return out, rows.Err()
}

// Loader holds the currently active, parsed, validated hotfix rule set
// — refreshed on its own ticker (Run), read lock-free (Active) from the
// worker's own hot path.
type Loader struct {
	source RuleSource
	log    *slog.Logger
	rules  atomic.Pointer[[]*sigmac.Rule]
}

func NewLoader(source RuleSource, log *slog.Logger) *Loader {
	if log == nil {
		log = slog.Default()
	}
	empty := []*sigmac.Rule{}
	l := &Loader{source: source, log: log}
	l.rules.Store(&empty)
	return l
}

// Active returns the current snapshot — never nil, possibly empty.
// Safe to call from any goroutine at any rate; never blocks on
// Postgres, since it only ever reads whatever Run last stored.
func (l *Loader) Active() []*sigmac.Rule {
	return *l.rules.Load()
}

// Run refreshes the snapshot immediately, then on every tick, until ctx
// is cancelled. A refresh failure (Postgres unreachable) logs and keeps
// serving the PREVIOUS snapshot — the same fail-open-on-the-old-data
// principle go/sentinelenrich.Refresher already applies to its own
// feeds, for the identical reason: an infrastructure hiccup in the
// loader must never silently stop every hotfix rule from evaluating.
func (l *Loader) Run(ctx context.Context, interval time.Duration) {
	l.refreshOnce(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.refreshOnce(ctx)
		}
	}
}

func (l *Loader) refreshOnce(ctx context.Context) {
	stored, err := l.source.ActiveRuleYAML(ctx)
	if err != nil {
		l.log.Error("hotfix: refreshing active rules, keeping previous snapshot", "err", err)
		return
	}

	parsed := make([]*sigmac.Rule, 0, len(stored))
	for _, s := range stored {
		r, err := sigmac.Parse(s.ID, []byte(s.RuleYAML))
		if err != nil {
			l.log.Error("hotfix: rule failed to parse, skipping", "row_id", s.ID, "err", err)
			continue
		}
		// This is the one place ADR-0004's own "small" framing is
		// actually enforced in code: a hotfix rule can express an
		// ordinary selection+condition (exactly what sigmac.Evaluate
		// supports), never an aggregation. Allowing one would also be
		// dishonest about what gets evaluated — Evaluate ignores
		// Aggregation entirely, so a hotfix author's own windowed
		// intent would silently degrade to "fires on the first
		// qualifying event" without ever being told that happened.
		if r.Aggregation != nil {
			l.log.Error("hotfix: rule declares a windowed aggregation, skipping — the hotfix path is in-stream only", "row_id", s.ID, "rule_id", r.ID)
			continue
		}
		parsed = append(parsed, r)
	}
	l.rules.Store(&parsed)
}
