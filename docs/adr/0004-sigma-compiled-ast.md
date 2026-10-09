# ADR-0004: Compile Sigma rules to a Go AST at build time

- **Status:** Accepted (partially superseded — see below)
- **Date:** 2026-10-02
- **Phase:** P2
- **Superseded by:** ADR-0012, for customer-authored rules only. This ADR's decision —
  platform-authored rules are compiled to Go at build time — is unchanged and still governs
  the reviewed ~150-rule corpus. ADR-0012 answers the "Revisit when" trigger below for a
  separate class of rule this ADR never covered.

## Context

The detection corpus starts at ~40 rules and grows to ~150+. Every event must be evaluated
against every applicable rule. At 30,000 events/second, 150 rules means 4.5 million rule
evaluations per second if done naively.

Sigma rules are authored as YAML. The obvious implementation — parse the YAML into a
generic matcher and interpret it per event — is roughly an order of magnitude more expensive
per event than compiled predicates, because every evaluation walks an interface-heavy tree
and allocates.

A second problem: a malformed or pathological rule should not reach production. Interpreting
at runtime means a bad rule is discovered by a pager.

## Decision

Sigma rules are **compiled to Go source at build time** by a generator in
`services/detect/internal/sigmac`, and the generated code is committed and compiled into the
detection binary.

- The compiler emits a **field-indexed decision tree**, not 150 independent matchers. Events
  are dispatched on high-selectivity fields first (`class_uid`, `activity_id`,
  `metadata.product`), so a typical event is tested against a handful of candidate rules
  rather than the whole corpus
- Every rule must declare a MITRE ATT&CK technique; the compiler **fails the build** if one
  is missing
- Every rule must have a positive and a negative fixture; the compiler generates a test per
  rule from them, and CI runs those tests
- Rule changes therefore ship as a deployment, not as a database write

## Alternatives considered

### A: Runtime YAML interpretation

Rules become data; they can be added or edited without a deploy, which is operationally
attractive and is what most SIEM products do. Rejected on two counts. Performance: measured
at roughly 8–10× the per-event cost, which translates directly into node count and breaches
constraint C1. Safety: a bad rule reaches production without passing a test, and in a
product whose entire value is trustworthy alerts, an untested rule is an outage.

### B: Compile to a WASM module per rule

Keeps hot-reload while gaining near-native speed. Genuinely interesting, and rejected on
complexity rather than merit: it adds a toolchain, a sandbox, and a debugging story for a
one-to-three-engineer team, to solve a problem (deploy latency for rule changes) that a fast
CI pipeline already solves adequately.

### C: Push detection into ClickHouse entirely

All rules as scheduled SQL. Simple, and already how windowed rules work. Rejected for
stateless rules on latency: a 30-second schedule is 30 seconds of detection delay against a
3-minute end-to-end SLO, and it spends the entire budget on the cheapest part of the
pipeline.

## Consequences

### Good

- Roughly an order of magnitude lower CPU per event than interpretation
- Every rule is type-checked and test-gated before it can reach production
- Unmapped or malformed rules cannot be merged — the build refuses them
- Rules become reviewable code artefacts with full version history and blame

### Bad

- Rule changes require a deploy; the edit-to-production loop is CI-length, not seconds
- No customer-authored custom rules until a separate, sandboxed path is built (Phase 7)
- Generated code inflates the repository and shows up in diffs
- The compiler is a bespoke component we own and must maintain

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| Deploy latency blocks an urgent detection | A small interpreted "hotfix rule" path exists for emergencies, capped at 10 active rules and expiring automatically after 7 days, forcing proper compilation |
| Compiler bug silently breaks a rule | Every rule's generated test runs in CI; a rule that stops firing on its own positive fixture fails the build |
| Sigma upstream syntax changes | Compiler pins a Sigma spec version; upgrades are deliberate, with the full corpus re-tested |

## Revisit when

Customer-authored custom detections become a contractual requirement — that genuinely needs
a sandboxed runtime path, and this ADR should be superseded rather than bent.
