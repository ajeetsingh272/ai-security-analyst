# ADR-0001: Polyglot monorepo — TypeScript product plane, Go data plane

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P0

## Context

The system has two workloads with genuinely different characteristics:

- **Data plane** — ingest, normalisation, detection. Must sustain ~30,000 events/second at
  peak on commodity hardware. CPU and allocation bound. Logic changes slowly.
- **Product plane** — dashboard, API, AI analyst, reports, billing. Throughput is trivial
  (hundreds of requests/second). Iteration speed is everything. Logic changes weekly.

Forcing one language on both means either paying a throughput tax on the data plane or a
velocity tax on the product plane.

A separate consideration: the event schema, case model and signal contract are shared
across both planes. If they live in separate repositories they will drift, and the drift
will be discovered in production.

## Decision

A single repository containing both, with language chosen per plane:

- **Go 1.23** for `services/ingest`, `services/detect`, `services/correlate`
- **TypeScript** for `apps/dashboard` (Next.js 15), `apps/api` (NestJS), `apps/analyst`
- **pnpm workspaces + Turborepo** for the TypeScript graph; **Go modules** alongside
- Shared contracts defined once in `packages/schema` and **code-generated** into Go, so the
  two planes cannot disagree about what a Case is

CI runs language-specific pipelines in parallel, each gated independently.

## Alternatives considered

### A: All-TypeScript

Fastest to build, one language to hire for, simplest CI. Rejected on measured throughput:
Node's per-event cost for the detection hot path is roughly 4–6× Go's, and the GC pauses
show up directly in the p99 alert-latency SLO. At 30k EPS that is the difference between a
three-node and a fifteen-node detection tier — a recurring cost that would breach constraint
C1 permanently, to save a few weeks once.

### B: All-Go

Excellent data plane; a poor trade for the product plane. The dashboard is a rich React
application regardless, so Go would not actually remove the second language — it would just
move the boundary to a worse place and slow down the half of the system that changes most.

### C: Separate repositories per service

Independent deployment and clear ownership, which matters at 50 engineers. At 1–5 engineers
it buys coordination overhead and schema drift. Revisit at team size, not at service count.

## Consequences

### Good

- Each plane uses a language suited to its actual constraint
- One pull request can change a contract and both sides of it, atomically
- Shared schema is generated, so cross-plane drift is a compile error rather than a 3am page
- Single CI definition, single issue tracker, single version history

### Bad

- Contributors need both toolchains installed; onboarding is slower
- Turborepo does not understand the Go graph, so Go caching is handled by a separate script
- Repository grows large; shallow clones and sparse checkout become necessary around Phase 6
- Two dependency ecosystems to patch and audit

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| Schema generation drifts from hand-written Go types | CI regenerates and fails on any diff |
| CI wall-clock grows past the point of usefulness | Turborepo remote cache; Go build cache; path-filtered workflow triggers |
| "Go person" and "TS person" silo | Shared contract package forces both to meet in one place; rotate ownership at phase boundaries |

## Revisit when

The team passes ~15 engineers, or any single service needs a release cadence materially
different from the rest. Either is a genuine signal to split; service count alone is not.
