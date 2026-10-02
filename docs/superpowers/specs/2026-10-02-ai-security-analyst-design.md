# Design — Sentinel, AI Security Analyst

- **Date:** 2026-10-02
- **Status:** Approved
- **Source:** `AI-Security-Analyst-Simple-Explainer.pdf` (Pratik Soni, July 2026)

This is the approved design that the repository was generated from. The detailed
treatment lives in [`docs/architecture/overview.md`](../../architecture/overview.md)
and the ADRs; this document records *what was agreed and why*, so the decisions
remain traceable to the conversation that produced them.

---

## Decisions taken at the outset

| Decision | Choice | Rationale |
|---|---|---|
| Repository | `ajeetsingh272/ai-security-analyst`, private | The brief is marked Confidential and contains pricing and go-to-market strategy |
| Stack | TypeScript monorepo + Go data plane | Throughput where it matters, velocity where it matters ([ADR-0001](../../adr/0001-monorepo-polyglot.md)) |
| Scope of this pass | Plan, board and full scaffold; no business logic | Business logic is Phase 1+ work executed against the tickets |
| Progress reporting | GitHub Pages dashboard, auto-rebuilt | Always current without manual upkeep |

---

## Reframing the scale requirement

The request was "scalable for a million users". That is the wrong unit for this
product and designing to it literally would have produced the wrong system.

The load driver is **tenants × events per second**. A million monitored
identities is ~10,000 tenants averaging 100 identities each, producing ~500
million events/day — roughly 6,000 EPS sustained and 30,000 at peak. Those are
the numbers the architecture is sized against, and they are what the load tests
assert.

The distinction matters because end-user count barely affects this system, while
event volume determines everything: the event store, the stream partitioning,
the detection engine design and the entire cost model.

---

## The four constraints everything follows from

**C1 · Unit economics.** Cost of goods under ₹1,800/tenant/month against
₹4,000–30,000 revenue. This single constraint forbids running an LLM over the
event stream, forbids an OLTP database as the event store, and forbids
per-tenant infrastructure at the entry tier.

**C2 · Trust is the product.** The buyer cannot verify a security claim. One
confident fabrication loses the account. Every AI claim must be mechanically
traceable to a logged event.

**C3 · Alert fatigue is the incumbents' failure mode.** Fewer than 10 of every
100 raw signals may reach a human, and the reduction must be deterministic and
measurable — not an emergent property of a prompt.

**C4 · The AI is an availability risk.** A third-party LLM API is the least
reliable dependency in the system and must not sit on the critical path of
critical detection.

---

## Architecture summary

Seven planes: connectors → ingest/normalisation (OCSF) → stream (Redpanda) →
detection (compiled Sigma, plus windowed ClickHouse queries) → correlation
(entity graph → cases) → AI analyst (tiered models + grounding validator) →
response (approvals, playbooks, audit).

Three decisions deserve emphasis, because they are where this design departs
from the obvious implementation:

**Correlation, not the AI, is the noise filter.** Signals cluster into cases
deterministically before any model is invoked. The AI explains and judges what
survives; it does not decide what is worth looking at. This is what makes C1 and
C3 simultaneously satisfiable.

**Grounding is code, not a prompt.** The model emits claims carrying
`evidence_ref` arrays. A validator re-queries ClickHouse for each referenced
event, scoped to the tenant, and fails the entire report if any reference does
not resolve. "Do not hallucinate" is not a control. A query returning zero rows
is.

**Critical rules bypass the AI entirely.** They publish to the alert channel in
parallel with entering correlation, so a critical detection reaches the customer
even with the analyst plane completely down. Covered by a chaos test, not by an
assurance.

---

## Correction to the proposed timeline

The brief proposed Month 1 for ingest plus 40 detections and Month 1.5 for the
full AI analyst. That ordering is right; the sizing is roughly **2–3×
optimistic** for a production multi-tenant SaaS holding customer security
telemetry.

The gap is not the happy path — a demo of M365 ingest and a dozen rules genuinely
is a few weeks. The gap is tenant isolation that survives an audit, checkpointing
that does not lose events during a vendor outage, detection rules with negative
fixtures, an approval path that cannot be replayed, and an audit log an insurer
will accept. For a security product those are not polish; they are the product.

The plan keeps the brief's sequence exactly and sizes it honestly:
**P0–P6 ≈ 26 weeks to pilot-ready**, with cuttable scope marked. See
[`docs/roadmap.md`](../../roadmap.md).

---

## UI/UX direction

"Control Room" — industrial-utilitarian, dark-first. Bricolage Grotesque for
display, Archivo for interface, IBM Plex Mono for every machine-generated value,
so monospace reliably means *machine fact*.

Two choices are load-bearing rather than stylistic:

- The severity ramp runs **blue→magenta**, not green→red, because the
  conventional ramp collapses into indistinguishable yellows for ~8% of men.
  Severity is always hue **plus** icon **plus** label, enforced at the component
  API with no colour-only variant.
- One colour, `verified` green, is reserved exclusively for grounded evidence
  and used nowhere else in the product — making the central promise visible, and
  its absence conspicuous.

Full specification: [`docs/design/ui-ux-spec.md`](../ui-ux-spec.md).

---

## Deliverables from this pass

1. Private repository with a polyglot monorepo scaffold
2. Architecture overview, 8 ADRs, UI/UX spec, roadmap, getting-started
3. `planning/` as machine-readable source of truth — 95 tickets, 348 test cases
4. GitHub Project board, milestones and labels generated from `planning/`
5. CI pipelines, Docker Compose dev stack, Postgres and ClickHouse schemas
6. Live progress dashboard on GitHub Pages

## Explicitly out of scope

Endpoint agent · custom ML anomaly detection · automatic response without
approval by default · on-premise deployment · SIEM replacement positioning.
Reasoning for each is in
[`docs/architecture/overview.md` §8](../../architecture/overview.md).
