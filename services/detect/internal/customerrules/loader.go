package customerrules

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ActiveRule is one active row's own id, owning tenant, and raw Sigma
// YAML — enough for Loader to parse and cache it, keyed by tenant.
type ActiveRule struct {
	ID       string
	TenantID string
	RuleYAML string
}

// RuleSource is what Loader actually depends on — an interface, not
// PostgresSource directly, so refreshOnce's own filtering (bad YAML
// skipped, re-validated against ADR-0012 §1's limits) has a unit test
// that needs no real Postgres, the same "interface at the consumer"
// pattern services/detect/internal/hotfix.RuleSource already uses.
type RuleSource interface {
	ActiveRules(ctx context.Context) ([]ActiveRule, error)
}

// PostgresSource reads customer_rules across every active tenant,
// mirroring services/correlate/cmd/correlate/main.go's own
// runQuietPeriodSweep: the tenant ID LIST comes from the pool's
// default connection (not sensitive data — an index, not tenant
// content), but every row of actual tenant data is read through
// sentineldb.WithTenantContext, one tenant at a time, so RLS enforces
// the boundary even if this loop had a bug. No privileged
// cross-tenant Postgres role is needed — exactly the same reasoning
// apps/api/src/retention-sweep.ts and plan-usage-sweep.ts already
// apply on the TypeScript side, now on the Go side for the first time.
type PostgresSource struct {
	pool *pgxpool.Pool
}

func NewPostgresSource(pool *pgxpool.Pool) *PostgresSource {
	return &PostgresSource{pool: pool}
}

func (s *PostgresSource) ActiveRules(ctx context.Context) ([]ActiveRule, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM tenants WHERE status = 'active'`)
	if err != nil {
		return nil, err
	}
	var tenantIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		tenantIDs = append(tenantIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []ActiveRule
	for _, tenantID := range tenantIDs {
		tenantRules, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) ([]ActiveRule, error) {
			rows, err := tx.Query(ctx, `SELECT id, rule_yaml FROM customer_rules WHERE tenant_id = $1 AND status = 'active'`, tenantID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			var tr []ActiveRule
			for rows.Next() {
				var id, ruleYAML string
				if err := rows.Scan(&id, &ruleYAML); err != nil {
					return nil, err
				}
				tr = append(tr, ActiveRule{ID: id, TenantID: tenantID, RuleYAML: ruleYAML})
			}
			return tr, rows.Err()
		})
		if err != nil {
			return nil, err
		}
		out = append(out, tenantRules...)
	}
	return out, nil
}

// LoadedRule pairs a parsed rule with the customer_rules.id it was
// loaded from — the worker needs BOTH: sigmac.Rule.ID (the YAML's own
// internal id) for the emitted Signal's RuleID, exactly like the
// compiled and hotfix paths already report; RowID for
// SuspensionTracker/activator.go's own writes, which key on the
// Postgres row (`WHERE id = $1`), not on whatever a tenant happened to
// put in their YAML's own id: field — the two are never assumed to be
// the same string.
type LoadedRule struct {
	RowID string
	Rule  *sigmac.Rule
}

// Loader holds the current active, parsed, re-validated customer-rule
// set, cached per tenant — refreshed on its own ticker (Run), read
// lock-free (Active) from the worker's own hot path. Mirrors
// services/detect/internal/hotfix.Loader's exact atomic-swap shape.
type Loader struct {
	source RuleSource
	log    *slog.Logger
	rules  atomic.Pointer[map[string][]LoadedRule]
}

func NewLoader(source RuleSource, log *slog.Logger) *Loader {
	if log == nil {
		log = slog.Default()
	}
	empty := map[string][]LoadedRule{}
	l := &Loader{source: source, log: log}
	l.rules.Store(&empty)
	return l
}

// Active returns tenantID's own current rule set — never nil, possibly
// empty. ADR-0012 §4: this lookup is itself part of the tenant-
// isolation guarantee — a rule is only ever returned for the exact
// tenant asked for, never for any other key in the underlying map.
func (l *Loader) Active(tenantID string) []LoadedRule {
	return (*l.rules.Load())[tenantID]
}

// Run refreshes the snapshot immediately, then on every tick, until
// ctx is cancelled. A refresh failure logs and keeps serving the
// PREVIOUS snapshot — the same fail-open-on-stale-data principle
// hotfix.Loader and go/sentinelenrich.Refresher already apply.
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
	stored, err := l.source.ActiveRules(ctx)
	if err != nil {
		l.log.Error("customerrules: refreshing active rules, keeping previous snapshot", "err", err)
		return
	}

	byTenant := make(map[string][]LoadedRule)
	for _, s := range stored {
		// Re-validated here, not just re-parsed: a row only reaches
		// 'active' status via the activator (activator.go), which
		// already ran this exact check, but re-running it on every
		// refresh means a FUTURE tightening of ADR-0012 §1's limits
		// takes effect on the next refresh, not only for newly
		// submitted rules — the same "never trust a status column
		// alone" caution this package applies throughout.
		r, err := Validate(s.ID, s.RuleYAML)
		if err != nil {
			l.log.Error("customerrules: previously-active rule no longer validates, skipping", "row_id", s.ID, "tenant_id", s.TenantID, "err", err)
			continue
		}
		byTenant[s.TenantID] = append(byTenant[s.TenantID], LoadedRule{RowID: s.ID, Rule: r})
	}
	l.rules.Store(&byTenant)
}
