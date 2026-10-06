// Package sentinelconnector is P1-01's connector framework: one interface a
// new source implements (docs/architecture/overview.md §3.1), a scheduler
// that runs registered connectors per tenant on an interval with per-tenant
// failure isolation, and a Postgres-backed cursor store whose commit
// ordering is governed by ADR-0010 — a cursor advances only after its batch
// has been durably acknowledged by the stream.
//
// What this package deliberately does NOT do: talk to Redpanda directly
// (P1-05's job — see Publisher below for the seam), implement a real
// connector for any vendor (P1-02/03's job), or produce fully OCSF-conformant
// events (P1-04's job — see the ocsf subpackage's own doc comment). P1-01 is
// the framework these plug into, not any one of them.
package sentinelconnector

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// ErrConsentRevoked is the sentinel error a Connector's Fetch or HealthCheck
// should wrap (via fmt.Errorf("...: %w", ErrConsentRevoked)) when a vendor
// API signals that the tenant has revoked this connector's access (e.g.
// M365 returning 401/invalid_grant after an admin removes consent) — the
// scheduler (P1-11) maps this to the connectors table's 'revoked' status
// distinctly from a merely transient failure, so the health endpoint can
// tell "needs the tenant to re-authorise" apart from "vendor API is having
// a bad day."
var ErrConsentRevoked = errors.New("sentinelconnector: connector consent revoked")

// ConnectorID identifies a connector implementation — "m365",
// "google_workspace", etc. — matching the `kind` check constraint on the
// `connectors` table (db/postgres/migrations/0001_foundation.sql).
type ConnectorID string

// Cursor is a connector's opaque checkpoint — M365's blob id, Google's
// startTime+pageToken, or anything else a connector needs to resume exactly
// where it left off. json.RawMessage (not a plain []byte alias) so pgx's
// JSON codec sends/receives it as the connector_cursors.cursor JSONB column
// directly, with no manual marshal/unmarshal step in the cursor store; this
// package never looks inside the value itself.
type Cursor json.RawMessage

// RawEvent is one unprocessed record as fetched from a vendor API, before
// OCSF normalisation. Payload is the vendor's own wire format — this package
// does not parse it; Normalise is what turns it into something this system
// understands.
type RawEvent struct {
	TenantID  string
	Payload   []byte
	FetchedAt int64 // Unix seconds; connectors should treat this as informational, not authoritative — the vendor's own event timestamp belongs inside Payload.
}

// Batch is what one Fetch call returns: zero or more raw events. A vendor
// API's own pagination (if any) is the connector's internal concern — Fetch
// is expected to walk every page belonging to one cursor advance and return
// the fully-collected result, so the scheduler never needs to know a given
// vendor paginates at all. If a future connector's pages are too large to
// hold in memory at once, that is a reason to extend this type with an
// explicit "more at this cursor" signal — not something assumed here ahead
// of a real connector that actually needs it.
type Batch struct {
	Events []RawEvent
}

// Connector is the one interface a new source implements — the literal
// shape from docs/architecture/overview.md §3.1, kept identical rather than
// adapted, so that doc stays the single source of truth for what a
// connector looks like.
//
// Fetch MUST be idempotent for a given cursor (ADR-0010): the scheduler's
// recovery path after any crash between publish and cursor-commit is
// re-calling Fetch with the OLD cursor, and republishing whatever it
// returns. A connector whose Fetch has side effects that aren't safe to
// repeat (e.g. a vendor API that deletes-on-read) cannot satisfy this
// contract and needs a different design, not an exception to it.
type Connector interface {
	ID() ConnectorID
	Fetch(ctx context.Context, cur Cursor) (Batch, Cursor, error)
	Normalise(raw RawEvent) ([]ocsf.Event, error)
	HealthCheck(ctx context.Context) error
}
