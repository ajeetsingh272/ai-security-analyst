package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/lifecycle"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/scoring"
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
	// publisher is P4-01's own addition — may be nil (every caller
	// that predates it and does not care about publishing); see
	// CaseEventPublisher's own doc comment for the full contract.
	publisher CaseEventPublisher
}

func NewPostgresStore(pool *pgxpool.Pool, publisher CaseEventPublisher) *PostgresStore {
	return &PostgresStore{pool: pool, lifecycle: lifecycle.NewWriter(sentinelaudit.NewWriter(pool)), publisher: publisher}
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
	var shouldPublish bool
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
		if err := scoring.Recompute(ctx, tx, tenantID, caseID); err != nil {
			return "", err
		}
		published, err := s.markEscalatedIfPending(ctx, tx, tenantID, caseID)
		if err != nil {
			return "", err
		}
		shouldPublish = published
		return caseID, nil
	})
	if err != nil {
		return "", fmt.Errorf("cluster: creating case: %w", err)
	}
	s.publishEscalatedBestEffort(ctx, shouldPublish, tenantID, id)
	return id, nil
}

func (s *PostgresStore) AddSignalToCase(ctx context.Context, tenantID, caseID string, sig Signal) (bool, error) {
	var shouldPublish bool
	added, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(ctx,
			`INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, event_ids, detected_at, mitre_ids)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			 ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
			tenantID, caseID, sig.DedupeKey, sig.SignalID, sig.RuleID, sig.EntityType, sig.EntityID, sig.Severity, sig.EventIDs, sig.DetectedAt, nonNil(sig.MitreIDs),
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
		if err := scoring.Recompute(ctx, tx, tenantID, caseID); err != nil {
			return false, err
		}
		published, err := s.markEscalatedIfPending(ctx, tx, tenantID, caseID)
		if err != nil {
			return false, err
		}
		shouldPublish = published
		return true, nil
	})
	if err != nil {
		return false, fmt.Errorf("cluster: adding signal to case %s: %w", caseID, err)
	}
	s.publishEscalatedBestEffort(ctx, shouldPublish, tenantID, caseID)
	return added, nil
}

// markEscalatedIfPending returns true exactly once per case: the
// first call for which the case's own CURRENT score (as
// scoring.Recompute, called just before this, stored it) is at or
// above tenantID's own escalation threshold. Safe to call every time
// a signal joins a case, including ones that already escalated long
// ago — cases.escalated_at IS NULL is the actual guard (a plain
// UPDATE ... WHERE ... IS NULL, inside the SAME transaction this
// case's own score was just written in), not anything checked before
// this function runs, so it can never return true twice for the same
// case even under a theoretical concurrent call.
//
// escalated_at means ONLY "decided, exactly once" — it says nothing
// about whether the publish that's about to be attempted actually
// succeeds. See publishEscalatedBestEffort's own doc comment for why
// that distinction is load-bearing, not pedantic (0014's own doc
// comment has the full story: a version of this code that set
// escalated_at AND treated it as "already published" lost every
// publish failure permanently, confirmed by a dedicated test).
func (s *PostgresStore) markEscalatedIfPending(ctx context.Context, tx pgx.Tx, tenantID, caseID string) (bool, error) {
	var plan string
	if err := s.pool.QueryRow(ctx, `SELECT plan FROM tenants WHERE id = $1`, tenantID).Scan(&plan); err != nil {
		return false, fmt.Errorf("reading plan for tenant %s: %w", tenantID, err)
	}
	threshold := scoring.EscalationThreshold(scoring.PlanTier(plan))

	var score *float64
	if err := tx.QueryRow(ctx, `SELECT score FROM cases WHERE tenant_id = $1 AND id = $2`, tenantID, caseID).Scan(&score); err != nil {
		return false, err
	}
	if score == nil || *score < threshold {
		return false, nil
	}

	tag, err := tx.Exec(ctx, `UPDATE cases SET escalated_at = now() WHERE tenant_id = $1 AND id = $2 AND escalated_at IS NULL`, tenantID, caseID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// publishEscalatedBestEffort is the fast path's own publish attempt —
// deliberately AFTER the transaction above has already committed
// (never inside it: a Kafka produce is not transactional with
// Postgres, and should not hold a DB transaction open while it
// retries or times out). On success, escalated_published_at is set —
// the ONLY thing that marks a case as actually delivered, distinct
// from escalated_at (which only marks "decided"). A failed publish
// here is logged, not returned as an error (the case is already
// correctly scored and stored regardless), and leaves
// escalated_published_at NULL, which is exactly what
// CloseQuietCases' own catch-up sweep looks for.
func (s *PostgresStore) publishEscalatedBestEffort(ctx context.Context, shouldPublish bool, tenantID, caseID string) {
	if !shouldPublish || s.publisher == nil {
		return
	}
	if err := s.publisher.PublishEscalated(ctx, tenantID, caseID); err != nil {
		slog.Error("publishing escalated case failed; CloseQuietCases will retry", "tenant_id", tenantID, "case_id", caseID, "err", err)
		return
	}
	if _, err := s.pool.Exec(ctx, `UPDATE cases SET escalated_published_at = now() WHERE id = $1 AND escalated_published_at IS NULL`, caseID); err != nil {
		slog.Error("recording successful publish failed; CloseQuietCases will re-publish (a harmless duplicate)", "tenant_id", tenantID, "case_id", caseID, "err", err)
	}
}

// CloseQuietCases closes every tenant-open case whose signals have
// gone quiet. P3-07/TG3: a case whose score never crossed its
// tenant's own escalation threshold is DISMISSED (with a machine-
// readable reason), not merely closed — "every non-escalated signal
// records a machine-readable dismissal reason" (AC1) applies here
// specifically, since quiet-timeout is the only path that concludes a
// case in this phase (no triage/investigation pipeline exists yet to
// dismiss one actively). A case whose score DID cross the threshold
// still closes exactly as it did before this ticket — it was never a
// "hidden" dismissal to begin with.
func (s *PostgresStore) CloseQuietCases(ctx context.Context, tenantID string, quietPeriod time.Duration, asOf time.Time) (int, error) {
	var plan string
	if err := s.pool.QueryRow(ctx, `SELECT plan FROM tenants WHERE id = $1`, tenantID).Scan(&plan); err != nil {
		return 0, fmt.Errorf("cluster: reading plan for tenant %s: %w", tenantID, err)
	}
	threshold := scoring.EscalationThreshold(scoring.PlanTier(plan))

	type quietCasesResult struct {
		closed    int
		toPublish []string
	}
	result, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (quietCasesResult, error) {
		rows, err := tx.Query(ctx,
			`SELECT cs.case_id, MAX(cs.detected_at) AS last_detected, c.score
			 FROM case_signals cs
			 JOIN cases c ON c.id = cs.case_id AND c.window_end IS NULL
			 WHERE cs.tenant_id = $1
			 GROUP BY cs.case_id, c.score
			 HAVING $2 - MAX(cs.detected_at) > $3`,
			tenantID, asOf, quietPeriod,
		)
		if err != nil {
			return quietCasesResult{}, err
		}
		type candidate struct {
			id    string
			last  time.Time
			score *float64
		}
		var toClose []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.id, &c.last, &c.score); err != nil {
				rows.Close()
				return quietCasesResult{}, err
			}
			toClose = append(toClose, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return quietCasesResult{}, err
		}

		for _, c := range toClose {
			windowEnd := c.last.Add(quietPeriod)
			if _, err := tx.Exec(ctx, `UPDATE cases SET window_end = $1 WHERE id = $2`, windowEnd, c.id); err != nil {
				return quietCasesResult{}, err
			}

			escalated := c.score != nil && *c.score >= threshold
			if escalated {
				if err := s.lifecycle.Transition(ctx, tx, tenantID, c.id, lifecycle.StateClosed, sentinelaudit.ActorSystem, "correlate", "quiet period elapsed with no new signal"); err != nil {
					return quietCasesResult{}, err
				}
			} else {
				if err := s.lifecycle.Transition(ctx, tx, tenantID, c.id, lifecycle.StateDismissed, sentinelaudit.ActorSystem, "correlate", string(lifecycle.ReasonBelowEscalationThreshold)); err != nil {
					return quietCasesResult{}, err
				}
			}
		}

		// The catch-up path (CaseEventPublisher's own doc comment): any
		// case in this tenant already DECIDED escalated (escalated_at
		// set) but never successfully PUBLISHED (escalated_published_at
		// still NULL) — a fast-path producer error, a process restart
		// between that decision and the publish attempt — gets a retry
		// here, on this same periodic sweep, rather than needing a
		// dedicated outbox job. The actual escalated_published_at
		// marking happens in publishEscalatedBestEffort below, exactly
		// like the fast path's own call — this query only finds
		// candidates, it does not claim or mark anything itself.
		// Deliberately NOT scoped to toClose/window_end IS NULL above:
		// an escalated case still actively receiving signals (not yet
		// quiet) should be published just as eagerly as one that
		// already quieted out, so this is its own, separate query over
		// the whole tenant.
		pubRows, err := tx.Query(ctx, `SELECT id FROM cases WHERE tenant_id = $1 AND escalated_at IS NOT NULL AND escalated_published_at IS NULL`, tenantID)
		if err != nil {
			return quietCasesResult{}, err
		}
		var toPublish []string
		for pubRows.Next() {
			var id string
			if err := pubRows.Scan(&id); err != nil {
				pubRows.Close()
				return quietCasesResult{}, err
			}
			toPublish = append(toPublish, id)
		}
		pubRows.Close()
		if err := pubRows.Err(); err != nil {
			return quietCasesResult{}, err
		}

		return quietCasesResult{closed: len(toClose), toPublish: toPublish}, nil
	})
	if err != nil {
		return 0, fmt.Errorf("cluster: closing quiet cases: %w", err)
	}
	for _, caseID := range result.toPublish {
		s.publishEscalatedBestEffort(ctx, true, tenantID, caseID)
	}
	return result.closed, nil
}

func insertCaseSignal(ctx context.Context, tx pgx.Tx, tenantID, caseID string, sig Signal) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, event_ids, detected_at, mitre_ids)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		tenantID, caseID, sig.DedupeKey, sig.SignalID, sig.RuleID, sig.EntityType, sig.EntityID, sig.Severity, sig.EventIDs, sig.DetectedAt, nonNil(sig.MitreIDs),
	)
	return err
}

// nonNil coerces a nil slice to an empty one — pgx encodes a nil Go
// slice as SQL NULL, not an empty array, which case_signals.mitre_ids'
// own NOT NULL constraint rejects for the (common) case of a signal
// with no MITRE tag at all.
func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
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
