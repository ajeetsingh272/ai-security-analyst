# Architecture Decision Records

An ADR records a decision that was expensive to make and would be expensive to reverse.
If a choice could be changed in an afternoon, it does not need one.

Each record states the decision, the context that forced it, the alternatives that were
genuinely considered, and the consequences — **including the bad ones**. An ADR that lists
no downsides has not been thought through.

## Status values

| Status | Meaning |
|---|---|
| Proposed | Under discussion, not yet binding |
| Accepted | Binding. Code must conform. |
| Superseded | Replaced by a later ADR, which must be linked |
| Deprecated | No longer applies, nothing replaced it |

## Index

| # | Decision | Status | Phase |
|---|---|---|---|
| [0001](./0001-monorepo-polyglot.md) | Polyglot monorepo: TypeScript product plane, Go data plane | Accepted | P0 |
| [0002](./0002-ocsf-event-schema.md) | OCSF as the canonical normalised event schema | Accepted | P1 |
| [0003](./0003-redpanda-over-kafka.md) | Redpanda as the stream transport | Accepted | P1 |
| [0004](./0004-sigma-compiled-ast.md) | Compile Sigma rules to a Go AST at build time | Accepted | P2 |
| [0005](./0005-clickhouse-event-store.md) | ClickHouse as the event store, Postgres as the control plane | Accepted | P1 |
| [0006](./0006-llm-tiering-and-grounding.md) | Tiered LLM routing with a deterministic grounding validator | Accepted | P4 |
| [0007](./0007-approval-tokens-and-audit.md) | Signed single-use approval tokens and a hash-chained audit log | Accepted | P5 |
| [0008](./0008-tenant-isolation.md) | Shared infrastructure with row-level security isolation | Accepted | P0 |

## Writing a new ADR

Copy [`template.md`](./template.md), number it sequentially, and open it as a PR. Debate
happens in review while the status is Proposed. Merging sets it to Accepted and makes it
binding on the codebase.

Superseding an ADR is normal and healthy. Silently violating one is not.
