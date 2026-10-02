# Security Policy

This product processes customer security telemetry. Security defects here are
customer-impacting by definition. Treat every report as high priority.

## Reporting a vulnerability

Do **not** open a public issue. Email `security@<domain>` with:

- A description of the issue and its impact
- Reproduction steps or a proof of concept
- Affected component and version/commit

You will get an acknowledgement within 2 business days and a remediation plan
within 7.

## Scope

In scope: ingest connectors, detection engine, correlation, AI analyst,
response actions, dashboard, tenant isolation, approval tokens, audit log.

Out of scope: findings against third-party services we integrate with
(report those to the vendor), and issues requiring a compromised developer
machine.

## Our security commitments

These are product guarantees, enforced in code and covered by tests:

| # | Guarantee | Enforced by |
|---|-----------|-------------|
| 1 | AI output is never unsourced | Evidence-grounding validator rejects any report with an unresolvable `evidence_ref` |
| 2 | AI never acts without approval | Response executor requires a signed, time-limited, single-use approval token |
| 3 | Nothing is hidden | Dismissed signals are retained and surfaced in the daily digest |
| 4 | Critical alerts survive AI outage | Rule engine owns a direct alert path that bypasses the analyst |
| 5 | Tenants are isolated | Postgres RLS + ClickHouse row policies + per-tenant credential encryption |
| 6 | The audit log is tamper-evident | Hash-chained, append-only; no UPDATE or DELETE grants |

A change that weakens any of these requires an ADR and explicit sign-off.
