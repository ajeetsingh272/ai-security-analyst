# ADR-0002: OCSF as the canonical normalised event schema

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P1

## Context

Microsoft, Google, AWS, Azure and every firewall vendor describe the same event — "a user
signed in" — with different field names, different timestamp formats, different identity
representations and different nesting. Detection, correlation and the AI analyst must all
operate on one shape, or every one of them has to know about every vendor.

We also want to use the open Sigma rule corpus rather than authoring ~150 rules from
scratch. Sigma rules are written against named log sources with expected field names, so
whatever schema we choose determines how much translation each borrowed rule needs.

## Decision

Normalise every event to the **Open Cybersecurity Schema Framework (OCSF)** at the connector
boundary, before anything is published to the stream.

- Each connector implements `Normalise(raw) ([]ocsf.Event, error)` — a **pure, total**
  function: no I/O, no clock access, no network
- Unmapped vendor fields are preserved under `unmapped` rather than discarded, so a future
  rule can use them without a re-ingest
- The raw original is archived to S3 regardless, so normalisation bugs are recoverable by
  replay rather than by apologising to the customer
- Schema version is stamped on every event, so mappings can evolve without rewriting history

## Alternatives considered

### A: Homegrown schema

Tempting: minimal, exactly fits our first two connectors, no spec to read. It loses badly
over time. Every new connector forces a schema negotiation; every borrowed Sigma rule needs
a bespoke rewrite; and the eventual "export to the customer's existing SIEM" feature becomes
a mapping project instead of a serialisation choice. We would be maintaining a private
standard as a side business.

### B: Elastic Common Schema (ECS)

A real contender — mature, widely adopted, excellent documentation, and much of the Sigma
corpus already targets it. Lost on governance and trajectory: ECS is vendor-controlled and
its centre of gravity is the Elastic stack, whereas OCSF is vendor-neutral with AWS,
Splunk, CrowdStrike and Palo Alto behind it, and is where new vendor-published mappings are
appearing. Choosing the schema with the stronger network effect matters more than choosing
the one that is slightly more convenient today.

### C: Store raw, normalise at query time

Zero ingest cost and perfect fidelity. Rejected: it pushes vendor-specific logic into every
detection rule and every analyst query, which is exactly the coupling we are trying to
avoid, and it makes query cost unpredictable — the opposite of what constraint C1 needs.

## Consequences

### Good

- Detection, correlation and the analyst are vendor-agnostic by construction
- Sigma rules need a thin field-mapping layer, not a rewrite
- SIEM export, data portability and customer-facing schema documentation come close to free
- Pure normalisation functions are exhaustively testable from recorded fixtures

### Bad

- OCSF is verbose; normalised events are larger than the raw originals (mitigated by
  ClickHouse compression, but it is real bytes on the wire)
- Mapping work is front-loaded on every new connector — roughly a week per source
- OCSF is still evolving; we will absorb breaking spec changes
- Some vendor-specific nuance genuinely does not map and lands in `unmapped`, where rules
  can reach it but less ergonomically

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| OCSF breaking change | Schema version per event; mappings are versioned and additive; old events keep their original version |
| Mapping bug silently corrupts events | Raw archived to S3; replay tooling is a Phase 1 deliverable, not an afterthought |
| Mapping drift between connectors | Shared golden-fixture suite asserting identical OCSF output for equivalent events across sources |

## Revisit when

OCSF adoption stalls — specifically, if a major source we need publishes no OCSF mapping and
the ecosystem has visibly moved elsewhere.
