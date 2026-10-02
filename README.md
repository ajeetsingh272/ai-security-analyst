<div align="center">

# Sentinel — AI Security Analyst

**An autonomous security operations centre for companies that can never afford one.**

Watches Microsoft 365, Google Workspace, cloud and firewall activity around the clock ·
Collapses alert noise into a handful of real cases · Investigates each one with an LLM that
is *mechanically forbidden from guessing* · Explains it in plain English · Fixes it on one tap.

[![TypeScript](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-typescript.yml/badge.svg)](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-typescript.yml)
[![Go](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-go.yml/badge.svg)](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-go.yml)
[![Integration](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-integration.yml/badge.svg)](https://github.com/ajeetsingh272/ai-security-analyst/actions/workflows/ci-integration.yml)
[![Tickets](https://img.shields.io/badge/backlog-95%20tickets%20%C2%B7%20348%20tests-38BDF8)](https://github.com/users/ajeetsingh272/projects/2)

</div>

---

## The problem

A small business generates hundreds of thousands of security-relevant log records a day and
reads none of them. A human analyst costs ₹8–25 lakh a year and you need three for 24/7
cover. Managed services start at ₹1.5 lakh a month. The affordable tools emit hundreds of
unexplained alerts until the owner mutes notifications — which is indistinguishable from
having no security at all.

The cameras are recording. Nobody is watching the footage.

## What this does

| | |
|---|---|
| **Watches** | Connects to M365, Google Workspace, AWS/Azure and firewalls over official APIs. Nothing is installed on employee machines. |
| **Detects** | ~150 behaviour rules compiled from the open Sigma library, every one mapped to a MITRE ATT&CK technique. |
| **Correlates** | Joins related signals about the same identity or host into a single case, deterministically — before any AI is involved. |
| **Investigates** | An LLM analyst pulls history, checks baselines, assigns severity, and writes the report a senior analyst would write. |
| **Proves** | Every sentence carries a reference to a real logged event. A validator re-queries the event store and rejects reports that cannot be proven. |
| **Acts** | Sends the case to WhatsApp/Slack/email with an Approve button. Executes the fix only after a human taps it. |

## The one design rule

> Cheap deterministic machinery does the heavy watching. Expensive intelligence is spent
> only on the few cases that earn it.

Rules and ClickHouse process ~500 million events a day. The LLM sees a few dozen correlated
cases per tenant per day. That ratio is the entire business model — it is what keeps cost of
goods near ₹1,000–1,800 per tenant per month against ₹4,000–30,000 of revenue.

## Architecture

```
  CONNECTORS          INGEST            STREAM           DETECTION         CORRELATION
 ┌──────────┐      ┌──────────┐      ┌─────────┐      ┌───────────┐     ┌────────────┐
 │ M365     │      │ poll +   │      │         │      │ Sigma AST │     │  entity    │
 │ GWS      │─────▶│ checkpnt │─────▶│Redpanda │─────▶│ in-stream │────▶│  graph →   │
 │ AWS/Azure│      │ normalise│      │ by      │      │     +     │     │  CASES     │
 │ Firewall │      │ to OCSF  │      │ tenant  │      │ windowed  │     │            │
 └──────────┘      └────┬─────┘      └─────────┘      │ ClickHouse│     └──────┬─────┘
                        │                             └─────┬─────┘            │
                        ▼                                   │ critical         ▼
                  ┌───────────┐                             │ bypass    ┌────────────┐
                  │ClickHouse │◀────────────────────────────┘           │ AI ANALYST │
                  │ 90d hot   │                                         │ + tools    │
                  │  → S3     │◀────── enrichment queries ──────────────│ + GROUNDING│
                  └───────────┘                                         │  VALIDATOR │
                                                                        └──────┬─────┘
   ┌────────────────────────────────────────────────────────────────────────┐  │
   │  RESPONSE  ·  WhatsApp / Slack / email  ·  signed approval token       │◀─┘
   │            ·  playbook executor  ·  hash-chained immutable audit log   │
   └────────────────────────────────────────────────────────────────────────┘
```

Read [`docs/architecture/overview.md`](docs/architecture/overview.md) for the full
treatment, [`docs/architecture/data-model.md`](docs/architecture/data-model.md) for
the control-plane schema as the database actually reports it — including which
tables are tenant-scoped and which role can bypass isolation — and
[`docs/adr/`](docs/adr/) for why each choice was made.

## Scale targets

The load unit is **tenants × events per second**, not end users.

| Dimension | Target |
|---|---|
| Tenants | 10,000 |
| Monitored identities | 1,000,000 |
| Events/day | ~500M (6k EPS sustained, 30k EPS peak) |
| Cases reaching the LLM | 20–50 / tenant / day |
| p95 critical alert latency | < 3 minutes |
| Signal-to-case reduction | ≥ 10:1 |

## Repository layout

```
apps/
  dashboard/      Next.js 15 — tenant console + MSP multi-client view
  api/            NestJS — control plane, OAuth, approvals, reports
  analyst/        TypeScript worker — LLM investigation loop + grounding validator
services/
  ingest/         Go — connector pollers, OCSF normalisation, checkpointing
  detect/         Go — compiled Sigma evaluation + windowed correlation queries
  correlate/      Go — entity graph, signal clustering, case lifecycle
packages/
  design-tokens/  Control Room theme — colours, type, spacing, severity ramp
  ui/             Shared React components built on the tokens
  schema/         OCSF event types, case/signal contracts, shared Zod schemas
detections/
  rules/          Sigma rules, MITRE-mapped
  fixtures/       Positive + negative test events for every rule
db/               ClickHouse DDL and Postgres migrations
infra/            Docker Compose (dev), Terraform + Kubernetes (prod)
docs/             Architecture, ADRs, data model, threat model, UI/UX spec
tools/progress/   Generator for the live project progress dashboard
```

## Getting started

Requires Node 22+, pnpm 10+, Go 1.23+, Docker.

```bash
pnpm install
cp .env.example .env          # fill in at minimum ANTHROPIC_API_KEY
pnpm dev:stack                # ClickHouse, Postgres, Redpanda, Redis, SeaweedFS
pnpm db:migrate
pnpm dev
```

Dashboard on <http://localhost:3000>, API on <http://localhost:4000>.

Full setup including connector OAuth registration:
[`docs/getting-started.md`](docs/getting-started.md).

Build caching, and how to enable the shared Remote Cache:
[`docs/build-cache.md`](docs/build-cache.md).

What CI gates and why path filtering lives in a job rather than a trigger:
[`docs/ci.md`](docs/ci.md).

## Project status & planning

This repository is in **Phase 0 — Foundation**. Everything is planned before it is built.

- **[Progress dashboard](docs/progress-dashboard.md)** — phase completion, burndown,
  ticket and test-case status, rebuilt automatically on every board change.
  *(The GitHub Pages deploy is blocked until the repo is public or on GitHub Pro —
  see that document for the three options.)*
- **[Project board](https://github.com/users/ajeetsingh272/projects/2)** — 95 tickets,
  each with acceptance criteria and test cases
- **[Roadmap](docs/roadmap.md)** — eight phases, scope and honest sizing
- **[Design spec](docs/superpowers/specs/2026-10-02-ai-security-analyst-design.md)** —
  the approved design this repository was generated from

| | |
|---|---|
| Tickets | 95 |
| Test cases | 348 |
| Story points | 502 |
| Phases | 8 (~34 weeks; ~26 to pilot-ready) |

`planning/` is the source of truth. Edit it, then run `node scripts/sync-board.mjs`
to regenerate issues, milestones and the board — never edit a generated issue body
by hand.

## Trust guarantees

Six product promises, each enforced by code and covered by tests rather than by policy.
They are listed in [`SECURITY.md`](SECURITY.md). Weakening one requires an ADR.

## Licence

Proprietary and confidential. See [`LICENSE`](LICENSE).
