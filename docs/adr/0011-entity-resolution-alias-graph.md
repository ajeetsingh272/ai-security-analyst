# ADR-0011: Entity resolution via co-occurring aliases, with a dedicated merge audit trail

- **Status:** Accepted
- **Date:** 2026-10-07
- **Phase:** P3
- **Supersedes / Superseded by:** —

## Context

P3-01 is the first ticket of the correlation plane (`docs/architecture/overview.md` §3.6) and the
first thing `services/correlate` actually does — until now it was a bare HTTP health-check
scaffold with two `// TODO(P3-01)` / `// TODO(P3-02)` markers. Its job: resolve a signal's own
identifiers — a UPN, an Azure AD object id, a primary or proxy email address — to one canonical
entity, so a case (P3-02) correlates signals about the same real person rather than three signals
about what looks like three different ones because one M365 operation logged a UPN and another
logged an object id for the identical user.

Two forcing questions this ticket has to answer that the ticket text itself leaves open:

1. **How does the system learn that two differently-shaped identifiers are the same person?**
   Nothing in this phase integrates a live directory sync (Microsoft Graph's own `GetUser`,
   which would return every alias for a known object id) — that is out of scope here and not
   named as a dependency.
2. **"An alias merge is reversible and audited" (AC5) — audited where?** Every existing audit
   write in this system (`packages/db/src/audit/audit-log-writer.ts`) is TypeScript, hash-chained
   (`prev_hash`/`entry_hash`, `ADR-0007`/TG6), and has never been written to from Go. This ticket's
   merge/reversal would be the first Go-side write to that chain.

## Decision

**1. Co-occurrence is the evidence.** A single resolution call takes a tenant id, an entity type,
and the *set* of aliases known simultaneously from one signal's own underlying event (e.g. a
UserId and an ObjectId that both appear on the same M365 audit record). If those aliases already
point at more than one existing entity, that co-occurrence is itself the proof they are the same
real entity, and the resolver merges them automatically, attributed to the system (not a human).
No external identity source is required for this ticket; a richer one (Graph API sync, an admin
UI for manual merges) can feed the same `Resolve`/`Merge` calls later without changing this
decision — it is additive, not a prerequisite.

**2. An alias with no type information, or a resolution call with no aliases at all, produces a
*provisional* entity, never an error** (AC3) — `entities.status` is `'provisional'` for a bare,
unlinked stub and `'resolved'` for anything with at least one alias attached. Nothing is ever
rejected or dropped for lack of identifying information; a provisional entity is still a valid
correlation target (P3-02 can still cluster signals against it by Signal.EntityID alone), just
one the system hasn't yet connected to a named identity.

**3. Merge/reversal gets its own dedicated, append-only table (`entity_merges`), not a Go port of
the TypeScript hash chain.** Each row records `from_entity_id`/`into_entity_id`, the exact set of
alias row ids moved (`moved_alias_ids`), a mandatory `reason`, `actor_type`/`actor_id` (mirroring
`AuditLogWriter`'s own `actorType`/`actorId` convention closely enough to stay familiar, without
sharing its storage), and `reversed_at`/`reversed_by` for the reversal itself. The row **is** the
audit record — permanent, attributed, queryable — and reversal is exact: it moves precisely the
alias ids this merge moved, not "every alias currently on the target entity," so a later, unrelated
merge into the same entity can never be undone by someone else's reversal.

## Alternatives considered

### A: Port the TypeScript canonical-JSON + SHA256 hash chain to Go

Would give one unified, chain-verified audit log across both languages. Rejected for this ticket:
`scripts/canonical-json.mjs`/`chain-verifier.mjs` encode a specific JSON canonicalisation (key
ordering, number formatting) that a Go reimplementation could drift from in a way that compiles,
runs, and silently produces a chain `scripts/chain-verifier.mjs` itself cannot verify — exactly the
kind of bug that is invisible until an actual tamper investigation needs the chain to hold. A
faithful, tested Go port of that encoding is real, scoped work in its own right, not something to
absorb as a side effect of P3-01. Revisit when a second Go service needs the same guarantee (see
**Revisit when**) — at that point the port is worth doing once, deliberately, not twice by
accident.

### B: Require an exact identifier-type match to resolve (no co-occurrence merge)

Would mean a UPN and an object id for the same person are simply never connected — correlation
would never see them as one entity by the resolver alone, defeating AC1 outright. Rejected: this
is the literal case AC1 names.

### C: Fuzzy/probabilistic matching (e.g. email-local-part similarity to a UPN)

Would resolve more cases without needing co-occurrence, but introduces false merges with no
direct evidence behind them — exactly what AC5 is guarding against ("a bad merge corrupts
correlation"). Rejected for this ticket: co-occurrence is evidence actually present in the data;
similarity is an inference that can be wrong in ways this system cannot detect or attribute.

## Consequences

### Good

- Resolution needs nothing beyond what a signal's own event already carries — no new connector,
  no new external dependency, no new scope added to P1's connector plane.
- A provisional entity is never a dead end: P3-02 clusters against `EntityID` regardless of
  whether it ever gained a real alias, so under-identified signals still correlate with each other.
- Reversal is exact and non-destructive to unrelated merges, because the moved-alias-id snapshot
  is taken once, at merge time, inside the same transaction that performs the move.

### Bad

- Two genuinely different tenants' aliases can never cross-contaminate (RLS, `0009_entities.sql`),
  but the entity/alias audit trail now lives in a SEPARATE table from every other audit event in
  this system — a future cross-plane audit view (e.g. "everything a given user id did or had done
  to it") has to query two places, not one, until or unless Alternative A is revisited.
- The co-occurrence heuristic can still merge incorrectly if a single event genuinely conflates
  two different people's identifiers (a shared/service mailbox's own audit record naming both an
  owner and a delegate, for instance) — AC5's reversibility is the safety net for exactly this,
  not a guarantee the heuristic never fires wrongly.

### Risks and how they are mitigated

| Risk | Mitigation | Owner |
|---|---|---|
| A bad auto-merge silently corrupts correlation before anyone notices | Every merge is reversible by exact alias-id snapshot (T4); `entity_merges` is queryable to audit which merges were system-attributed vs human | P3-02 (first real consumer) + a future admin-facing merge review surface |
| `entity_merges` audit trail diverges further from `audit_log`'s own conventions over time as more Go services need to write audit events | Revisit Alternative A once a second Go service needs an audit write — port the canonical-JSON chain once, deliberately | Whoever ships that second Go-side audit write |
| Resolution latency (AC4, <5ms p99) regresses as the alias table grows | `(tenant_id, alias_type, alias_value)` is the table's own unique constraint, so lookups stay a single indexed point-query regardless of table size; proven directly with a real-Postgres benchmark, not assumed | P3-01's own integration test |

## Revisit when

A second Go service needs to write an audited, attributable event and the two-audit-trails split
(`audit_log` for TypeScript, `entity_merges` for this one thing) becomes real duplicated
infrastructure rather than a one-off — that is the point to port the hash chain to Go once,
properly, and migrate `entity_merges` into it rather than maintaining both indefinitely.
