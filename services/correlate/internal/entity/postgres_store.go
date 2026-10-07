package entity

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore is the real, production-backing Store — every query
// goes through sentineldb.WithTenantContext, the same RLS-enforcing
// path every other tenant-scoped Go write in this system uses
// (ADR-0008).
//
// AC4's <5ms p99 budget is why every method here is ONE round trip
// regardless of how many aliases are involved: FindEntitiesByAliases
// uses unnest() to match an arbitrary number of (type, value) pairs in
// a single indexed query against entity_aliases' own
// (tenant_id, alias_type, alias_value) unique index, and LinkAliases
// inserts every given alias in one multi-row INSERT the same way —
// neither one issues a separate round trip per alias.
type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func (s *PostgresStore) FindEntitiesByAliases(ctx context.Context, tenantID string, aliases []Alias) (map[Alias]string, error) {
	types := make([]string, len(aliases))
	values := make([]string, len(aliases))
	for i, a := range aliases {
		types[i] = string(a.Type)
		values[i] = a.Value
	}

	rows, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) ([]struct {
		AliasType  string
		AliasValue string
		EntityID   string
	}, error) {
		rows, err := tx.Query(ctx,
			`SELECT ea.alias_type, ea.alias_value, ea.entity_id
			 FROM entity_aliases ea
			 JOIN unnest($1::text[], $2::text[]) AS u(alias_type, alias_value)
			   ON ea.alias_type = u.alias_type AND ea.alias_value = u.alias_value`,
			types, values,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		var out []struct {
			AliasType  string
			AliasValue string
			EntityID   string
		}
		for rows.Next() {
			var r struct {
				AliasType  string
				AliasValue string
				EntityID   string
			}
			if err := rows.Scan(&r.AliasType, &r.AliasValue, &r.EntityID); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("entity: finding entities by aliases: %w", err)
	}

	result := make(map[Alias]string, len(rows))
	for _, r := range rows {
		result[Alias{Type: AliasType(r.AliasType), Value: r.AliasValue}] = r.EntityID
	}
	return result, nil
}

// ResolveFast implements FastResolver — see that interface's own doc
// comment for why this exists. Mirrors Resolver.settle's own decision
// algorithm exactly (0 distinct entities found -> create+link; 1 ->
// link any new aliases; >1 -> merge, then link) but inside ONE
// transaction, which is what actually clears AC4's budget.
func (s *PostgresStore) ResolveFast(ctx context.Context, tenantID, entityType string, aliases []Alias) (*Entity, error) {
	types := make([]string, len(aliases))
	values := make([]string, len(aliases))
	for i, a := range aliases {
		types[i] = string(a.Type)
		values[i] = a.Value
	}

	id, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		rows, err := tx.Query(ctx,
			`SELECT ea.alias_type, ea.alias_value, ea.entity_id
			 FROM entity_aliases ea
			 JOIN unnest($1::text[], $2::text[]) AS u(alias_type, alias_value)
			   ON ea.alias_type = u.alias_type AND ea.alias_value = u.alias_value`,
			types, values,
		)
		if err != nil {
			return "", err
		}
		found := map[Alias]string{}
		for rows.Next() {
			var at, av, eid string
			if err := rows.Scan(&at, &av, &eid); err != nil {
				rows.Close()
				return "", err
			}
			found[Alias{Type: AliasType(at), Value: av}] = eid
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return "", err
		}

		seen := map[string]bool{}
		var distinct []string
		for _, eid := range found {
			if !seen[eid] {
				seen[eid] = true
				distinct = append(distinct, eid)
			}
		}

		var unseen []Alias
		for _, a := range aliases {
			if _, ok := found[a]; !ok {
				unseen = append(unseen, a)
			}
		}

		switch len(distinct) {
		case 0:
			var id string
			if err := tx.QueryRow(ctx,
				`INSERT INTO entities (tenant_id, entity_type, status) VALUES ($1, $2, 'resolved') RETURNING id`,
				tenantID, entityType,
			).Scan(&id); err != nil {
				return "", err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO entity_aliases (tenant_id, entity_id, alias_type, alias_value)
				 SELECT $1, $2, u.alias_type, u.alias_value
				 FROM unnest($3::text[], $4::text[]) AS u(alias_type, alias_value)`,
				tenantID, id, types, values,
			); err != nil {
				return "", err
			}
			return id, nil

		case 1:
			canonicalID := distinct[0]
			if err := linkUnseenTx(ctx, tx, tenantID, canonicalID, unseen); err != nil {
				return "", err
			}
			return canonicalID, nil

		default:
			sort.Strings(distinct)
			canonicalID := distinct[0]
			for _, other := range distinct[1:] {
				if err := mergeEntitiesTx(ctx, tx, tenantID, other, canonicalID,
					"co-occurring aliases resolved to one entity", "system", actorSystem); err != nil {
					return "", err
				}
			}
			if err := linkUnseenTx(ctx, tx, tenantID, canonicalID, unseen); err != nil {
				return "", err
			}
			return canonicalID, nil
		}
	})
	if err != nil {
		return nil, fmt.Errorf("entity: resolving (fast path): %w", err)
	}
	return &Entity{ID: id, EntityType: entityType, Status: StatusResolved}, nil
}

func linkUnseenTx(ctx context.Context, tx pgx.Tx, tenantID, entityID string, unseen []Alias) error {
	if len(unseen) == 0 {
		return nil
	}
	types := make([]string, len(unseen))
	values := make([]string, len(unseen))
	for i, a := range unseen {
		types[i] = string(a.Type)
		values[i] = a.Value
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO entity_aliases (tenant_id, entity_id, alias_type, alias_value)
		 SELECT $1, $2, u.alias_type, u.alias_value
		 FROM unnest($3::text[], $4::text[]) AS u(alias_type, alias_value)`,
		tenantID, entityID, types, values,
	)
	return err
}

func mergeEntitiesTx(ctx context.Context, tx pgx.Tx, tenantID, fromEntityID, intoEntityID, reason, actorType, actorID string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM entity_aliases WHERE entity_id = $1`, fromEntityID)
	if err != nil {
		return err
	}
	var movedIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		movedIDs = append(movedIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `UPDATE entity_aliases SET entity_id = $1 WHERE entity_id = $2`, intoEntityID, fromEntityID); err != nil {
		return err
	}
	if len(movedIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE entities SET status = 'resolved' WHERE id = $1`, intoEntityID); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO entity_merges (tenant_id, from_entity_id, into_entity_id, moved_alias_ids, reason, actor_type, actor_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		tenantID, fromEntityID, intoEntityID, movedIDs, reason, actorType, actorID,
	)
	return err
}

func (s *PostgresStore) CreateEntity(ctx context.Context, tenantID, entityType, status string) (string, error) {
	id, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO entities (tenant_id, entity_type, status) VALUES ($1, $2, $3) RETURNING id`,
			tenantID, entityType, status,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		return "", fmt.Errorf("entity: creating entity: %w", err)
	}
	return id, nil
}

func (s *PostgresStore) CreateEntityWithAliases(ctx context.Context, tenantID, entityType, status string, aliases []Alias) (string, error) {
	types := make([]string, len(aliases))
	values := make([]string, len(aliases))
	for i, a := range aliases {
		types[i] = string(a.Type)
		values[i] = a.Value
	}

	id, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		if err := tx.QueryRow(ctx,
			`INSERT INTO entities (tenant_id, entity_type, status) VALUES ($1, $2, $3) RETURNING id`,
			tenantID, entityType, status,
		).Scan(&id); err != nil {
			return "", err
		}
		if len(aliases) > 0 {
			if _, err := tx.Exec(ctx,
				`INSERT INTO entity_aliases (tenant_id, entity_id, alias_type, alias_value)
				 SELECT $1, $2, u.alias_type, u.alias_value
				 FROM unnest($3::text[], $4::text[]) AS u(alias_type, alias_value)`,
				tenantID, id, types, values,
			); err != nil {
				return "", err
			}
		}
		return id, nil
	})
	if err != nil {
		return "", fmt.Errorf("entity: creating entity with aliases: %w", err)
	}
	return id, nil
}

func (s *PostgresStore) LinkAliases(ctx context.Context, tenantID, entityID string, aliases []Alias) error {
	types := make([]string, len(aliases))
	values := make([]string, len(aliases))
	for i, a := range aliases {
		types[i] = string(a.Type)
		values[i] = a.Value
	}

	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`INSERT INTO entity_aliases (tenant_id, entity_id, alias_type, alias_value)
			 SELECT $1, $2, u.alias_type, u.alias_value
			 FROM unnest($3::text[], $4::text[]) AS u(alias_type, alias_value)`,
			tenantID, entityID, types, values,
		)
		return struct{}{}, execErr
	})
	if err != nil {
		return fmt.Errorf("entity: linking aliases to %s: %w", entityID, err)
	}
	return nil
}

func (s *PostgresStore) MergeEntities(ctx context.Context, tenantID, fromEntityID, intoEntityID, reason, actorType, actorID string) (string, error) {
	mergeID, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		// Snapshot exactly which aliases are about to move, inside the
		// same transaction as the move itself — this is what makes
		// reversal exact (ADR-0011) rather than "whatever is on the
		// target entity when someone later asks to undo it".
		rows, err := tx.Query(ctx, `SELECT id FROM entity_aliases WHERE entity_id = $1`, fromEntityID)
		if err != nil {
			return "", err
		}
		var movedIDs []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return "", err
			}
			movedIDs = append(movedIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return "", err
		}

		if _, err := tx.Exec(ctx, `UPDATE entity_aliases SET entity_id = $1 WHERE entity_id = $2`, intoEntityID, fromEntityID); err != nil {
			return "", err
		}
		if len(movedIDs) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE entities SET status = 'resolved' WHERE id = $1`, intoEntityID); err != nil {
				return "", err
			}
		}

		var mergeID string
		err = tx.QueryRow(ctx,
			`INSERT INTO entity_merges (tenant_id, from_entity_id, into_entity_id, moved_alias_ids, reason, actor_type, actor_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING id`,
			tenantID, fromEntityID, intoEntityID, movedIDs, reason, actorType, actorID,
		).Scan(&mergeID)
		return mergeID, err
	})
	if err != nil {
		return "", fmt.Errorf("entity: merging %s into %s: %w", fromEntityID, intoEntityID, err)
	}
	return mergeID, nil
}

func (s *PostgresStore) ReverseMerge(ctx context.Context, tenantID, mergeID, reversedBy string) error {
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		var fromEntityID string
		var movedAliasIDs []string
		var alreadyReversed bool
		err := tx.QueryRow(ctx,
			`SELECT from_entity_id, moved_alias_ids, reversed_at IS NOT NULL
			 FROM entity_merges WHERE id = $1`,
			mergeID,
		).Scan(&fromEntityID, &movedAliasIDs, &alreadyReversed)
		if errors.Is(err, pgx.ErrNoRows) {
			return struct{}{}, fmt.Errorf("merge %s not found", mergeID)
		}
		if err != nil {
			return struct{}{}, err
		}
		if alreadyReversed {
			return struct{}{}, fmt.Errorf("merge %s already reversed", mergeID)
		}

		// Moves precisely the snapshotted alias ids back — never
		// "every alias currently on the target entity", which could
		// include a later, unrelated merge's own contribution.
		if _, err := tx.Exec(ctx,
			`UPDATE entity_aliases SET entity_id = $1 WHERE id = ANY($2::uuid[])`,
			fromEntityID, movedAliasIDs,
		); err != nil {
			return struct{}{}, err
		}

		_, err = tx.Exec(ctx,
			`UPDATE entity_merges SET reversed_at = now(), reversed_by = $2 WHERE id = $1`,
			mergeID, reversedBy,
		)
		return struct{}{}, err
	})
	if err != nil {
		return fmt.Errorf("entity: reversing merge %s: %w", mergeID, err)
	}
	return nil
}
