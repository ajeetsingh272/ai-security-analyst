package sentinelaudit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ActorType mirrors packages/db's own ActorType — the set of values
// audit_log's own CHECK constraint accepts.
type ActorType string

const (
	ActorHuman     ActorType = "human"
	ActorAI        ActorType = "ai"
	ActorSystem    ActorType = "system"
	ActorConnector ActorType = "connector"
)

// EntryInput mirrors packages/db's own AuditEntryInput.
type EntryInput struct {
	ActorType   ActorType
	ActorID     string
	Action      string
	SubjectType string
	SubjectID   string
	// Payload must be built only from the types CanonicalJSON accepts
	// (string, bool, nil, int, int64, float64, []any, map[string]any)
	// — never a secret or a credential (that redaction boundary is
	// enforced upstream, not here, mirroring packages/db's own writer).
	Payload any
	// OccurredAt overrides the generated timestamp — for tests that
	// need a deterministic value; production call sites should leave
	// this unset.
	OccurredAt time.Time
}

// WrittenEntry mirrors packages/db's own WrittenAuditEntry.
type WrittenEntry struct {
	ID         string
	OccurredAt string
	EntryHash  []byte
}

// occurredAtFormat must match JS's own `new Date().toISOString()`
// EXACTLY — occurredAt is a HASHED field, so any formatting
// difference produces a different hash for the identical instant.
// time.RFC3339Nano (tried first) strips trailing zero fractional
// digits, so a round-second timestamp would print with no decimal
// point at all; toISOString() always prints exactly 3 digits and
// always 'Z'. The zeros in this format string are a literal, not a
// precision specifier — that's what forces exactly 3 digits every
// time, truncating (never rounding) anything beyond.
const occurredAtFormat = "2006-01-02T15:04:05.000Z"

// Writer ports packages/db/src/audit/audit-log-writer.ts's own
// AuditLogWriter.insert exactly — same pg_advisory_xact_lock-keyed-by
// -tenant concurrency guard (for the identical reason: sentinel_app
// lacks UPDATE on audit_log, so SELECT...FOR UPDATE is unusable; see
// that file's own doc comment), same "read last entry_hash, compute,
// insert" sequence, same reliance on an application-generated
// occurredAt rather than the column's DEFAULT now() (the hash must
// cover a value known before the row exists).
//
// WriteTx is the one method callers needing AC5's own "the transition
// and its audit entry commit atomically or not at all" actually use —
// it takes an ALREADY-OPEN transaction (the same one the caller is
// about to write its own row in, e.g. case_transitions), rather than
// opening its own, which is what makes that atomicity possible at all.
type Writer struct {
	pool *pgxpool.Pool
}

func NewWriter(pool *pgxpool.Pool) *Writer {
	return &Writer{pool: pool}
}

// Insert opens its own transaction — for a call site that has no
// other write to commit atomically alongside the audit entry. Case
// transitions (AC5) use WriteTx instead, inside their own transaction.
func (w *Writer) Insert(ctx context.Context, tenantID string, input EntryInput) (WrittenEntry, error) {
	entry, err := sentineldb.WithTenantContext(ctx, w.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (WrittenEntry, error) {
		return writeEntry(ctx, tx, tenantID, input)
	})
	if err != nil {
		return WrittenEntry{}, fmt.Errorf("sentinelaudit: inserting entry: %w", err)
	}
	return entry, nil
}

// WriteTx writes one audit entry inside tx — an ALREADY-OPEN
// transaction the caller controls, so the entry commits (or rolls
// back) atomically with whatever else that transaction does. tx must
// already be running as sentinel_app with app.tenant_id set to
// tenantID (i.e. obtained via sentineldb.WithTenantContext, the same
// transaction a case_transitions INSERT would use) — this method does
// not establish tenant context itself, deliberately: establishing it
// twice inside one transaction would be redundant at best and a
// silent no-op at worst, since SET LOCAL ROLE only takes effect once
// per transaction.
func (w *Writer) WriteTx(ctx context.Context, tx pgx.Tx, tenantID string, input EntryInput) (WrittenEntry, error) {
	entry, err := writeEntry(ctx, tx, tenantID, input)
	if err != nil {
		return WrittenEntry{}, fmt.Errorf("sentinelaudit: writing entry in transaction: %w", err)
	}
	return entry, nil
}

func writeEntry(ctx context.Context, tx pgx.Tx, tenantID string, input EntryInput) (WrittenEntry, error) {
	occurredAt := input.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}
	// Truncated to millisecond precision BEFORE anything else uses it
	// — not just for the hash's own string, but for the value actually
	// INSERTED into occurred_at too. Both must be derived from the
	// IDENTICAL, already-quantized instant: scripts/verify-audit-
	// chain.mjs re-derives occurredAt from the STORED TIMESTAMPTZ value
	// (`new Date(r.occurred_at).toISOString()`), not from any stored
	// text, and Postgres timestamptz keeps microsecond precision —
	// inserting the UNTRUNCATED time.Time here would let the
	// verifier's own re-derivation disagree with the hash by whatever
	// rounding the driver applies beyond the 3rd decimal digit.
	// Truncating once, up front, removes that ambiguity: there is no
	// sub-millisecond component left for anything downstream to round
	// differently.
	occurredAt = occurredAt.UTC().Truncate(time.Millisecond)
	// Must match JS's own `new Date().toISOString()` EXACTLY —
	// occurredAt is a HASHED field, so any formatting difference
	// produces a different hash for the identical instant. Confirmed
	// directly: time.RFC3339Nano strips trailing zero fractional
	// digits (a round-second timestamp would print with no decimal
	// point at all), but toISOString() always prints exactly 3 digits
	// and always 'Z' — "2006-01-02T15:04:05.000Z" is a literal format
	// (the zeros are NOT a precision specifier), which is what forces
	// exactly 3 digits every time.
	occurredAtStr := occurredAt.Format(occurredAtFormat)

	// pg_advisory_xact_lock, not SELECT ... FOR UPDATE — identical
	// reasoning and identical mechanism to audit-log-writer.ts's own.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, tenantID); err != nil {
		return WrittenEntry{}, err
	}

	var prevHash []byte
	err := tx.QueryRow(ctx,
		`SELECT entry_hash FROM audit_log
		 WHERE tenant_id = current_setting('app.tenant_id')::uuid
		 ORDER BY id DESC LIMIT 1`,
	).Scan(&prevHash)
	if errors.Is(err, pgx.ErrNoRows) {
		prevHash = GenesisHash
	} else if err != nil {
		return WrittenEntry{}, err
	}

	payload := input.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	content := AuditEntryContent{
		TenantID: tenantID, OccurredAt: occurredAtStr,
		ActorType: string(input.ActorType), ActorID: input.ActorID,
		Action: input.Action, SubjectType: input.SubjectType, SubjectID: input.SubjectID,
		Payload: payload,
	}
	entryHash, err := ComputeEntryHash(prevHash, content)
	if err != nil {
		return WrittenEntry{}, err
	}

	// Plain encoding/json for the STORED column, not CanonicalJSON —
	// matching audit-log-writer.ts's own JSON.stringify for the same
	// column. This never needs to match the hash's own encoding byte
	// for byte: Postgres reformats JSONB on disk regardless, and only
	// entry_hash (computed above, from CanonicalJSON) is ever chain-
	// verified — the stored payload's own on-disk bytes are not.
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return WrittenEntry{}, err
	}

	var id string
	err = tx.QueryRow(ctx,
		`INSERT INTO audit_log
		   (tenant_id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, payload, prev_hash, entry_hash)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id`,
		tenantID, occurredAt, string(input.ActorType), input.ActorID, input.Action, input.SubjectType, input.SubjectID,
		payloadJSON, prevHash, entryHash,
	).Scan(&id)
	if err != nil {
		return WrittenEntry{}, err
	}

	return WrittenEntry{ID: id, OccurredAt: occurredAtStr, EntryHash: entryHash}, nil
}
