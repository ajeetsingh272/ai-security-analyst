package scoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Recompute recomputes a case's score FROM SCRATCH, from its current
// case_signals and the case's own entity's entity_criticality row, and
// persists it to cases.score/score_components — inside tx, the SAME
// transaction a caller's own case_signals/case_transitions write
// already runs in, so a case's score is always consistent with the
// signal set that produced it (never a stale score left over from
// before the latest signal joined).
//
// Recomputing from the full current set, rather than patching the
// previous score incrementally, is deliberate: it is the only way
// Score's own determinism (AC5) extends to the STORED value too —
// there is no accumulated-drift path to get wrong.
//
// tx must already be running as sentinel_app with app.tenant_id set to
// tenantID, exactly as lifecycle.Writer.Transition and
// sentinelaudit.Writer.WriteTx both already require.
func Recompute(ctx context.Context, tx pgx.Tx, tenantID, caseID string) error {
	in, err := gatherInput(ctx, tx, tenantID, caseID)
	if err != nil {
		return fmt.Errorf("scoring: gathering input for case %s: %w", caseID, err)
	}

	result := Score(in)
	componentsJSON, err := json.Marshal(result.Components)
	if err != nil {
		return fmt.Errorf("scoring: marshalling components for case %s: %w", caseID, err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE cases SET score = $1, score_components = $2 WHERE tenant_id = $3 AND id = $4`,
		result.Total, componentsJSON, tenantID, caseID,
	); err != nil {
		return fmt.Errorf("scoring: storing score for case %s: %w", caseID, err)
	}
	return nil
}

func gatherInput(ctx context.Context, tx pgx.Tx, tenantID, caseID string) (Input, error) {
	rows, err := tx.Query(ctx,
		`SELECT severity, mitre_ids FROM case_signals WHERE tenant_id = $1 AND case_id = $2`,
		tenantID, caseID,
	)
	if err != nil {
		return Input{}, err
	}
	defer rows.Close()

	var in Input
	for rows.Next() {
		var severity string
		var mitreIDs []string
		if err := rows.Scan(&severity, &mitreIDs); err != nil {
			return Input{}, err
		}
		in.SignalCount++
		in.Severities = append(in.Severities, Severity(severity))
		in.MitreIDs = append(in.MitreIDs, mitreIDs...)
	}
	if err := rows.Err(); err != nil {
		return Input{}, err
	}

	in.EntityCriticality, err = entityCriticality(ctx, tx, tenantID, caseID)
	if err != nil {
		return Input{}, err
	}
	// BaselineDeviation is left at its zero value — P3-05's own
	// placeholder, see scoring.go's own doc comment on Input.
	return in, nil
}

// entityCriticality looks up the case's own entity (cases.entity_ids,
// as "entityType:entityID" — the same raw pair case_signals and
// cluster.go already key on, not a resolved internal/entity UUID; see
// 0011_case_scoring.sql's own doc comment for why). An entityless case
// — or one whose entity has no entity_criticality row at all — is
// CriticalityNormal, never an error.
func entityCriticality(ctx context.Context, tx pgx.Tx, tenantID, caseID string) (Criticality, error) {
	var entityIDs []string
	if err := tx.QueryRow(ctx, `SELECT entity_ids FROM cases WHERE tenant_id = $1 AND id = $2`, tenantID, caseID).Scan(&entityIDs); err != nil {
		return "", err
	}
	if len(entityIDs) == 0 {
		return CriticalityNormal, nil
	}
	entityType, entityID, ok := strings.Cut(entityIDs[0], ":")
	if !ok {
		return CriticalityNormal, nil
	}

	var criticality string
	err := tx.QueryRow(ctx,
		`SELECT criticality FROM entity_criticality WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3`,
		tenantID, entityType, entityID,
	).Scan(&criticality)
	if errors.Is(err, pgx.ErrNoRows) {
		return CriticalityNormal, nil
	}
	if err != nil {
		return "", err
	}
	return Criticality(criticality), nil
}
