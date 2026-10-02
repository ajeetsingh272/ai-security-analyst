# ADR-0008: Shared infrastructure with row-level-security isolation

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P0

## Context

Target scale is 10,000 tenants. A cross-tenant data leak in a *security* product is not an
ordinary bug — it is the end of the company. Customers are handing us the complete audit
trail of their business, and MSP customers are handing us their clients' trails too.

At the same time, constraint C1 forbids dedicated infrastructure per tenant at the entry
tier. ₹4,000/month does not pay for a dedicated database.

The realistic threat is not an attacker breaching our perimeter. It is a developer writing
`SELECT * FROM cases WHERE id = $1` and forgetting `AND tenant_id = $2`. That bug will be
written. The design must make it harmless rather than rely on it never happening.

## Decision

Shared infrastructure, defence in depth, with isolation enforced **below** the application
layer so that application bugs cannot breach it.

**1. `tenant_id` on every row.** No exceptions — including audit, metrics and feature flags.

**2. Postgres row-level security.** Enabled and forced on every tenant-scoped table. The
application connects as a role *without* `BYPASSRLS` and sets the tenant per transaction:

```sql
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cases
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

A forgotten `WHERE tenant_id` returns **zero rows** instead of another customer's data. The
bug becomes a visible empty screen, not an invisible breach.

**3. ClickHouse row policies.** The same guarantee at the event store, with the tenant bound
to the query user.

**4. Per-tenant envelope encryption.** Connector credentials and OAuth refresh tokens are
encrypted with a per-tenant DEK, itself wrapped by a KEK in KMS. A stolen database dump
without KMS access yields nothing usable.

**5. Tenant context is established once, at the edge.** Middleware resolves the tenant from
the authenticated session and opens the transaction with `app.tenant_id` set. Handlers
cannot reach the database outside that context — a repository constructed without a tenant
context throws at construction time.

**6. Isolation is tested on every pull request.** A standing integration test provisions two
tenants, writes data as each, then attempts to read across the boundary through *every*
public API surface and asserts empty results. New endpoints are added to it by convention
and the test fails if an endpoint is unregistered.

**7. An escape hatch exists.** Routing indirection is in place from day one so an enterprise
tenant can later be pinned to a dedicated ClickHouse shard and consumer group without an
application rewrite. Built in Phase 7, designed for now.

## Alternatives considered

### A: Database per tenant

The strongest isolation, and genuinely appealing for a security product. Rejected on
operations and cost: 10,000 Postgres databases means 10,000 migration targets, connection
pools and backup jobs. Migration alone becomes a distributed systems problem. This is the
right model at 100 enterprise tenants, not at 10,000 small ones.

### B: Schema per tenant

A middle path. Rejected for similar reasons at a smaller scale — Postgres performance
degrades noticeably past a few thousand schemas, and migrations remain an N-target problem.

### C: Application-layer filtering only

What most SaaS products do. Rejected outright: it makes the single most likely developer
error into a data breach. For a product whose subject matter is security, defence that
depends on remembering a `WHERE` clause is not defensible to a customer or an auditor.

## Consequences

### Good

- The most likely developer mistake produces an empty result, not a leak
- Isolation is auditable: the policies are inspectable in the schema
- Economically viable at the entry price point
- One migration target, one backup, one monitoring surface
- A path to dedicated infrastructure for enterprise tenants without a rewrite

### Bad

- RLS carries a query planning cost — measurable, roughly 3–8% on our access patterns
- Debugging is harder: a query returning nothing may be a policy, not a bug. Tooling must
  surface the active tenant context clearly, and does
- Background jobs that legitimately span tenants need a privileged role, which becomes a
  carefully reviewed exception rather than the default
- A noisy tenant can still affect shared resources — handled by quotas, not isolation

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| A table is created without RLS | A CI check enumerates tenant-scoped tables and fails if any lacks `FORCE ROW LEVEL SECURITY` |
| Privileged cross-tenant role is misused | Separate role, separate credentials, every use audited; usable only from designated job workers |
| ClickHouse policy and Postgres policy drift | Both generated from one tenant-scoping manifest in `packages/schema` |
| Noisy-neighbour resource exhaustion | Per-tenant EPS quotas, query timeouts, and token-bucket rate limits at ingest |

## Revisit when

A single tenant exceeds ~5% of total platform load, or a compliance regime (e.g. a regulated
customer's data residency requirement) mandates physical separation. Either triggers the
Phase 7 dedicated-shard path, not a redesign.
