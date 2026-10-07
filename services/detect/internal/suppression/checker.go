// Package suppression is P2-10's own addition (TG3: "Nothing is hidden —
// dismissals are surfaced"). It answers exactly one question — "has an
// analyst suppressed this rule, for this entity (or every entity), right
// now?" — and nothing else: creating, listing, revoking and renewing a
// suppression is apps/api's job (packages/db's SuppressionsRepository),
// since that is tenant-facing control-plane CRUD, not a hot-path decision
// the detection engine itself needs to make.
//
// AC3 ("suppressed signals are still stored and counted, just not
// escalated") is enforced by the CALLERS of Checker (worker.handleRecord,
// windowed.runOnce), not here: a Checker only reports suppressed/not, it
// never decides what a caller does with that answer.
package suppression

import (
	"context"
	"fmt"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Checker is what worker/windowed actually depend on — an interface, not
// PostgresChecker directly, so their own unit tests can prove "a suppressed
// critical signal skips the bypass" without a running Postgres, the same
// way sentinelconnector.CursorStorer lets the scheduler's tests run without
// a broker.
type Checker interface {
	// IsSuppressed reports whether (ruleID, entityID) is currently
	// suppressed for tenantID. entityID is "" for a signal with no entity
	// (every in-stream signal today) — a suppression with a NULL
	// entity_id still matches it, since NULL means "every entity for
	// this tenant+rule", not "only a signal with no entity".
	IsSuppressed(ctx context.Context, tenantID, ruleID, entityID string) (bool, string, error)
}

// PostgresChecker checks the real suppressions table (0006_suppressions.sql)
// through sentineldb.WithTenantContext — the same RLS-enforcing path every
// other tenant-scoped read in this system uses (ADR-0008).
type PostgresChecker struct {
	pool *pgxpool.Pool
}

func NewPostgresChecker(pool *pgxpool.Pool) *PostgresChecker {
	return &PostgresChecker{pool: pool}
}

type suppressionResult struct {
	id         string
	suppressed bool
}

// IsSuppressed matches a row whose entity_id is either NULL (a tenant+rule
// -wide suppression) or exactly equal to entityID. Passing entityID == ""
// for an in-stream signal does not accidentally match a windowed
// suppression scoped to one specific, different, non-empty entity — "" only
// ever equals a literal empty-string entity_id, which this table never
// stores (the column is nullable, not defaulted to empty), so only the
// IS NULL branch can match a signal with no entity at all.
//
// A match also increments the row's own suppressed_count, atomically, in
// the same statement — AC5's "the dashboard shows active suppressions and
// what they have suppressed". `signals` has no consumer persisting it
// anywhere queryable yet (that's the correlation plane's own future job),
// so this running count is the honest, in-scope answer to "what": how many
// signals this suppression has silenced so far.
func (c *PostgresChecker) IsSuppressed(ctx context.Context, tenantID, ruleID, entityID string) (bool, string, error) {
	r, err := sentineldb.WithTenantContext(ctx, c.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (suppressionResult, error) {
		var id string
		err := tx.QueryRow(ctx,
			`WITH matched AS (
			   SELECT id FROM suppressions
			   WHERE rule_id = $1
			     AND (entity_id = $2 OR entity_id IS NULL)
			     AND revoked_at IS NULL
			     AND expires_at > now()
			   ORDER BY entity_id NULLS LAST
			   LIMIT 1
			 )
			 UPDATE suppressions SET suppressed_count = suppressed_count + 1
			 WHERE id = (SELECT id FROM matched)
			 RETURNING id`,
			ruleID, entityID,
		).Scan(&id)
		if err == pgx.ErrNoRows {
			return suppressionResult{}, nil
		}
		if err != nil {
			return suppressionResult{}, err
		}
		return suppressionResult{id: id, suppressed: true}, nil
	})
	if err != nil {
		return false, "", fmt.Errorf("suppression: checking %s/%s: %w", ruleID, entityID, err)
	}
	return r.suppressed, r.id, nil
}

// InMemoryChecker is a Checker test double — no Postgres, just a map keyed
// by tenantID+ruleID+entityID plus a separate wildcard set keyed by
// tenantID+ruleID (entityID == ""), mirroring the real table's NULL-means-
// every-entity semantics without needing SQL to express it.
type InMemoryChecker struct {
	scoped   map[string]string // tenantID/ruleID/entityID -> suppression id
	wildcard map[string]string // tenantID/ruleID -> suppression id
}

func NewInMemoryChecker() *InMemoryChecker {
	return &InMemoryChecker{scoped: map[string]string{}, wildcard: map[string]string{}}
}

// Suppress registers a suppression for the test to exercise. entityID == ""
// registers a tenant+rule-wide (wildcard) suppression.
func (c *InMemoryChecker) Suppress(tenantID, ruleID, entityID, suppressionID string) {
	if entityID == "" {
		c.wildcard[tenantID+"/"+ruleID] = suppressionID
		return
	}
	c.scoped[tenantID+"/"+ruleID+"/"+entityID] = suppressionID
}

func (c *InMemoryChecker) IsSuppressed(_ context.Context, tenantID, ruleID, entityID string) (bool, string, error) {
	if id, ok := c.wildcard[tenantID+"/"+ruleID]; ok {
		return true, id, nil
	}
	if entityID != "" {
		if id, ok := c.scoped[tenantID+"/"+ruleID+"/"+entityID]; ok {
			return true, id, nil
		}
	}
	return false, "", nil
}
