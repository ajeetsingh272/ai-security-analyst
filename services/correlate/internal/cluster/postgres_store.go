package cluster

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/lifecycle"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore is the real, production-backing Store — every query
// goes through sentineldb.WithTenantContext (ADR-0008), the same
// RLS-enforcing path every other tenant-scoped Go write in this system
// uses. cases/case_transitions (0001_foundation.sql) are written here
// for the first time from Go — see this package's own doc comment for
// why their shape is treated as fixed, not evolved, by this ticket.
//
// Both transitions this store writes (open, on case creation; closed,
// on quiet timeout) go through lifecycle.Writer rather than a raw
// INSERT — P3-03's own AC5 ("transition events are written in the
// same transaction as the audit entry") applies to these two edges
// just as much as to any state lifecycle.Writer's own callers add
// later, even though they predate that ticket.
type PostgresStore struct {
	pool      *pgxpool.Pool
	lifecycle *lifecycle.Writer
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool, lifecycle: lifecycle.NewWriter(sentinelaudit.NewWriter(pool))}
}

func (s *PostgresStore) FindOpenCaseForEntity(ctx context.Context, tenantID, entityType, entityID string, windowDuration time.Duration, asOf time.Time) (string, bool, error) {
	type result struct {
		id    string
		found bool
	}
	r, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (result, error) {
		var caseID string
		var lastDetected time.Time
		err := tx.QueryRow(ctx,
			`SELECT cs.case_id, MAX(cs.detected_at) AS last_detected
			 FROM case_signals cs
			 JOIN cases c ON c.id = cs.case_id AND c.window_end IS NULL
			 WHERE cs.tenant_id = $1 AND cs.entity_type = $2 AND cs.entity_id = $3
			 GROUP BY cs.case_id
			 ORDER BY last_detected DESC
			 LIMIT 1`,
			tenantID, entityType, entityID,
		).Scan(&caseID, &lastDetected)
		if err == pgx.ErrNoRows {
			return result{}, nil
		}
		if err != nil {
			return result{}, err
		}
		if asOf.Sub(lastDetected) > windowDuration {
			return result{}, nil // the only open case's window has already lapsed
		}
		return result{id: caseID, found: true}, nil
	})
	if err != nil {
		return "", false, fmt.Errorf("cluster: finding open case: %w", err)
	}
	return r.id, r.found, nil
}

func (s *PostgresStore) CreateCaseWithSignal(ctx context.Context, tenantID string, sig Signal) (string, error) {
	id, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		// AC5/T4's own idempotent-replay guarantee, extended to a
		// signal whose ORIGINAL case has since closed (so
		// FindOpenCaseForEntity no longer finds it as an open
		// candidate to join): this signal already has a home — found
		// the hard way, replaying a fresh consumer group against
		// already-processed signals during this ticket's own manual
		// end-to-end verification hit exactly this path and raised a
		// raw unique-constraint error instead of behaving
		// idempotently. Checking first, rather than relying on ON
		// CONFLICT, is what lets this return the ORIGINAL case
		// without creating an orphaned new one first.
		var existingCaseID string
		err := tx.QueryRow(ctx, `SELECT case_id FROM case_signals WHERE tenant_id = $1 AND dedupe_key = $2`, tenantID, sig.DedupeKey).Scan(&existingCaseID)
		if err == nil {
			return existingCaseID, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}

		var entityIDs []string
		if sig.EntityType != "" && sig.EntityID != "" {
			entityIDs = []string{sig.EntityType + ":" + sig.EntityID}
		}

		var caseID string
		if err := tx.QueryRow(ctx,
			`INSERT INTO cases (tenant_id, severity, title, window_start, entity_ids, signal_count)
			 VALUES ($1, $2, $3, $4, $5, 1)
			 RETURNING id`,
			tenantID, sig.Severity, caseTitle(sig), sig.DetectedAt, entityIDs,
		).Scan(&caseID); err != nil {
			return "", err
		}

		if err := s.lifecycle.Transition(ctx, tx, tenantID, caseID, lifecycle.StateOpen, sentinelaudit.ActorSystem, "correlate", "first signal clustered"); err != nil {
			return "", err
		}

		if err := insertCaseSignal(ctx, tx, tenantID, caseID, sig); err != nil {
			return "", err
		}
		return caseID, nil
	})
	if err != nil {
		return "", fmt.Errorf("cluster: creating case: %w", err)
	}
	return id, nil
}

func (s *PostgresStore) AddSignalToCase(ctx context.Context, tenantID, caseID string, sig Signal) (bool, error) {
	added, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(ctx,
			`INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, event_ids, detected_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
			tenantID, caseID, sig.DedupeKey, sig.SignalID, sig.RuleID, sig.EntityType, sig.EntityID, sig.Severity, sig.EventIDs, sig.DetectedAt,
		)
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() == 0 {
			return false, nil // AC5/T4: already present, idempotent no-op
		}
		if _, err := tx.Exec(ctx, `UPDATE cases SET signal_count = signal_count + 1 WHERE id = $1`, caseID); err != nil {
			return false, err
		}
		return true, nil
	})
	if err != nil {
		return false, fmt.Errorf("cluster: adding signal to case %s: %w", caseID, err)
	}
	return added, nil
}

func (s *PostgresStore) CloseQuietCases(ctx context.Context, tenantID string, quietPeriod time.Duration, asOf time.Time) (int, error) {
	closed, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (int, error) {
		rows, err := tx.Query(ctx,
			`SELECT cs.case_id, MAX(cs.detected_at) AS last_detected
			 FROM case_signals cs
			 JOIN cases c ON c.id = cs.case_id AND c.window_end IS NULL
			 WHERE cs.tenant_id = $1
			 GROUP BY cs.case_id
			 HAVING $2 - MAX(cs.detected_at) > $3`,
			tenantID, asOf, quietPeriod,
		)
		if err != nil {
			return 0, err
		}
		type candidate struct {
			id   string
			last time.Time
		}
		var toClose []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.id, &c.last); err != nil {
				rows.Close()
				return 0, err
			}
			toClose = append(toClose, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}

		for _, c := range toClose {
			windowEnd := c.last.Add(quietPeriod)
			if _, err := tx.Exec(ctx, `UPDATE cases SET window_end = $1 WHERE id = $2`, windowEnd, c.id); err != nil {
				return 0, err
			}
			if err := s.lifecycle.Transition(ctx, tx, tenantID, c.id, lifecycle.StateClosed, sentinelaudit.ActorSystem, "correlate", "quiet period elapsed with no new signal"); err != nil {
				return 0, err
			}
		}
		return len(toClose), nil
	})
	if err != nil {
		return 0, fmt.Errorf("cluster: closing quiet cases: %w", err)
	}
	return closed, nil
}

func insertCaseSignal(ctx context.Context, tx pgx.Tx, tenantID, caseID string, sig Signal) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, event_ids, detected_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		tenantID, caseID, sig.DedupeKey, sig.SignalID, sig.RuleID, sig.EntityType, sig.EntityID, sig.Severity, sig.EventIDs, sig.DetectedAt,
	)
	return err
}

// caseTitle is a placeholder human-readable label — P3-04 ("Case
// scoring and escalation threshold") and later tickets own anything
// richer; this ticket only needs a non-null title so the row is usable
// at all.
func caseTitle(sig Signal) string {
	if sig.EntityID == "" {
		return sig.RuleID
	}
	return sig.RuleID + " — " + sig.EntityID
}
