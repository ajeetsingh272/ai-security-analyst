package customerrules

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PendingRule is one row awaiting activation — enough to run both
// ADR-0012 §1's validator and §3's fixture check.
type PendingRule struct {
	ID              string
	TenantID        string
	RuleYAML        string
	PositiveFixture sigmac.Event
	NegativeFixture sigmac.Event
}

// ActivatorStore is what Activator depends on — narrowed to an
// interface at the consumer (the same reasoning RuleSource/
// HotfixRules already apply in this codebase) so activation logic has
// a unit test that needs no real Postgres.
type ActivatorStore interface {
	PendingRules(ctx context.Context) ([]PendingRule, error)
	MarkActive(ctx context.Context, tenantID, ruleID string) error
	MarkRejected(ctx context.Context, tenantID, ruleID, reason string) error
}

// PostgresActivatorStore mirrors PostgresSource's own "tenant ID list
// from the default connection, every row of actual data through
// WithTenantContext" shape (ADR-0012 §4) — the activator writes tenant
// data (a status/rejection_reason column), so the write, like the
// read, must go through RLS.
type PostgresActivatorStore struct {
	pool *pgxpool.Pool
}

func NewPostgresActivatorStore(pool *pgxpool.Pool) *PostgresActivatorStore {
	return &PostgresActivatorStore{pool: pool}
}

func (s *PostgresActivatorStore) PendingRules(ctx context.Context) ([]PendingRule, error) {
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

	var out []PendingRule
	for _, tenantID := range tenantIDs {
		pending, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) ([]PendingRule, error) {
			rows, err := tx.Query(ctx,
				`SELECT id, rule_yaml, positive_fixture, negative_fixture FROM customer_rules
				 WHERE tenant_id = $1 AND status = 'pending_validation'`, tenantID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			var pr []PendingRule
			for rows.Next() {
				var id, ruleYAML string
				var posRaw, negRaw []byte
				if err := rows.Scan(&id, &ruleYAML, &posRaw, &negRaw); err != nil {
					return nil, err
				}
				var positive, negative sigmac.Event
				if err := json.Unmarshal(posRaw, &positive); err != nil {
					return nil, err
				}
				if err := json.Unmarshal(negRaw, &negative); err != nil {
					return nil, err
				}
				pr = append(pr, PendingRule{ID: id, TenantID: tenantID, RuleYAML: ruleYAML, PositiveFixture: positive, NegativeFixture: negative})
			}
			return pr, rows.Err()
		})
		if err != nil {
			return nil, err
		}
		out = append(out, pending...)
	}
	return out, nil
}

func (s *PostgresActivatorStore) MarkActive(ctx context.Context, tenantID, ruleID string) error {
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE customer_rules SET status = 'active', validated_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2`, ruleID, tenantID)
		return struct{}{}, err
	})
	return err
}

func (s *PostgresActivatorStore) MarkRejected(ctx context.Context, tenantID, ruleID, reason string) error {
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE customer_rules SET status = 'rejected', rejection_reason = $3, validated_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2`, ruleID, tenantID, reason)
		return struct{}{}, err
	})
	return err
}

// Suspend implements SuspensionTracker's own SuspensionStore
// dependency (ADR-0012 §2) — the same pool, the same tenant-scoped
// write pattern as MarkActive/MarkRejected above, just a different
// caller and a different target status.
func (s *PostgresActivatorStore) Suspend(ctx context.Context, tenantID, ruleID string) error {
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `UPDATE customer_rules SET status = 'suspended_resource_limit', updated_at = now() WHERE id = $1 AND tenant_id = $2`, ruleID, tenantID)
		return struct{}{}, err
	})
	return err
}

// Activator is ADR-0012 §3: the fixture-gated activation gate, run as
// its own background poller (the same "no deploy step in this path to
// gate on, so activation must be an async job instead" reasoning
// ADR-0012 itself gives). A pending rule is validated (§1) and checked
// against its own fixtures (§3) exactly once per poll it is still
// pending; store.MarkActive/MarkRejected makes the transition visible
// to the submitting tenant via apps/api's own GET /customer-rules.
type Activator struct {
	store ActivatorStore
	log   *slog.Logger
}

func NewActivator(store ActivatorStore, log *slog.Logger) *Activator {
	if log == nil {
		log = slog.Default()
	}
	return &Activator{store: store, log: log}
}

// Run polls on its own ticker until ctx is cancelled — the same shape
// hotfix.Loader.Run and customerrules.Loader.Run already use.
func (a *Activator) Run(ctx context.Context, interval time.Duration) {
	a.runOnce(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.runOnce(ctx)
		}
	}
}

func (a *Activator) runOnce(ctx context.Context) {
	pending, err := a.store.PendingRules(ctx)
	if err != nil {
		a.log.Error("customerrules: listing pending rules", "err", err)
		return
	}

	for _, p := range pending {
		if err := a.activateOne(ctx, p); err != nil {
			a.log.Error("customerrules: activation failed unexpectedly, leaving pending for the next poll", "row_id", p.ID, "tenant_id", p.TenantID, "err", err)
		}
	}
}

func (a *Activator) activateOne(ctx context.Context, p PendingRule) error {
	r, err := Validate(p.ID, p.RuleYAML)
	if err != nil {
		a.log.Info("customerrules: rule rejected at validation", "row_id", p.ID, "tenant_id", p.TenantID, "reason", err.Error())
		return a.store.MarkRejected(ctx, p.TenantID, p.ID, err.Error())
	}

	if err := ValidateAgainstFixtures(r, p.PositiveFixture, p.NegativeFixture); err != nil {
		a.log.Info("customerrules: rule rejected at fixture check", "row_id", p.ID, "tenant_id", p.TenantID, "reason", err.Error())
		return a.store.MarkRejected(ctx, p.TenantID, p.ID, err.Error())
	}

	a.log.Info("customerrules: rule activated", "row_id", p.ID, "tenant_id", p.TenantID, "rule_id", r.ID)
	return a.store.MarkActive(ctx, p.TenantID, p.ID)
}
