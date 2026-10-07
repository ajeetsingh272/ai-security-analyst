package cluster

import "context"

// CaseEventPublisher publishes a message to the `cases` topic the
// first time a case's score crosses its tenant's own escalation
// threshold (P4-01) — the gap that existed until this ticket: nothing
// in this system had ever published a case anywhere, only ever
// written one to Postgres. PostgresStore calls this at most once per
// case (cases.escalated_at is the idempotency guard), from two call
// sites: right after scoring.Recompute inside
// CreateCaseWithSignal/AddSignalToCase's own transaction (the fast
// path — most cases are published within the same request that
// escalated them), and from CloseQuietCases' own periodic sweep (the
// catch-up path, for a fast-path publish that failed or was never
// attempted — a producer error, a process restart mid-flight).
//
// May be nil: a Store constructed with a nil publisher (every
// existing test that predates P4-01 and does not care about
// publishing) simply never attempts to publish, which is a safe,
// backward-compatible default — not an error.
type CaseEventPublisher interface {
	PublishEscalated(ctx context.Context, tenantID, caseID string) error
}
