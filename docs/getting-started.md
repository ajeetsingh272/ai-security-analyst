# Getting Started

From a clean machine to a running system. If any step here fails, that is a bug
in this document — open an issue.

---

## 1. Prerequisites

| Tool | Version | Why | Install |
|---|---|---|---|
| **Node.js** | 22 LTS or newer | Dashboard, API, AI analyst, tooling | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **pnpm** | 10+ | Workspace package manager | `corepack enable && corepack prepare pnpm@10 --activate` |
| **Go** | 1.23+ | Ingest, detection and correlation services | [go.dev/dl](https://go.dev/dl/). On Windows without admin rights, `winget install GoLang.Go` fails (no user-scope installer) — download the `.zip`, extract to `%LOCALAPPDATA%\Programs\go`, and add its `bin` to PATH. |
| **Docker** | 24+ with Compose v2 | The whole local data stack | [docker.com](https://docs.docker.com/get-docker/) |
| **Git** | 2.40+ | — | [git-scm.com](https://git-scm.com) |

Optional but recommended:

| Tool | Why |
|---|---|
| **gh** (GitHub CLI) | Regenerating the board from `planning/` via `scripts/sync-board.mjs` |
| **psql** | `scripts/migrate.sh` uses it; Docker exec also works |
| **golangci-lint** | Matches what CI runs, so you find lint failures before pushing |
| **k6** | Load tests under `tests/load/` |

Verify everything at once:

```bash
node --version && pnpm --version && go version && docker --version && git --version
```

### Resource requirements

The dev stack runs ClickHouse, Postgres, Redpanda, Valkey, MinIO and Jaeger.
Budget **8 GB of RAM** for Docker and ~10 GB of disk. On Docker Desktop, raise
the memory limit in Settings → Resources if the stack is being OOM-killed —
ClickHouse is usually the first casualty.

---

## 2. Clone and install

```bash
git clone https://github.com/ajeetsingh272/ai-security-analyst.git
cd ai-security-analyst
pnpm install
```

---

## 3. Configure

```bash
cp .env.example .env
```

Nothing is required to bring the stack up. To exercise the AI analyst you need
at minimum:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The connector credentials (`M365_*`, `GOOGLE_*`) are only needed when you
work on ingest against a real tenant — see §7.

`.env` is gitignored. If you ever find yourself about to commit a credential,
stop: `git diff --cached` first. A leaked connector secret is a customer's
mailbox.

---

## 4. Start the stack

```bash
pnpm dev:stack
```

Brings up, with health checks gating startup order:

| Service | Port | URL | Purpose |
|---|---|---|---|
| Postgres | 5434 | `localhost:5434` | Control plane. 5432 is usually a natively installed Postgres and 5433 is often another project's stack, so this is offset twice. Container-side stays 5432. |
| ClickHouse HTTP | 8123 | <http://localhost:8123/play> | Event store, and the **play UI** for ad-hoc queries |
| ClickHouse native | 9000 | `localhost:9000` | Native protocol, used by the Go data plane |
| Redpanda Kafka | 19092 | `localhost:19092` | Stream. Offset from 9092 so a local Kafka does not collide |
| Redpanda admin | 9644 | <http://localhost:9644> | Cluster health and metrics |
| Redpanda Console | 8080 | <http://localhost:8080> | Topic and message inspection |
| Valkey | 6379 | `localhost:6379` | Cache, locks, rate limits. Durable: started with `--appendonly yes` |
| SeaweedFS S3 | 8333 | `localhost:8333` | Raw archive and cold tier (`sentineldev` / `sentineldev`) |
| SeaweedFS master | 9333 | <http://localhost:9333> | Cluster status UI |
| SeaweedFS filer | 8888 | <http://localhost:8888> | Browsing stored objects |
| ElasticMQ SQS | 9324 | `localhost:9324` | P7-02: a real local SQS-protocol server for the AWS CloudTrail connector |
| ElasticMQ statistics | 9325 | <http://localhost:9325> | Statistics API / UI — also what the healthcheck polls, since the SQS port itself only answers signed requests |
| Event Hubs emulator AMQP | 5672 | `localhost:5672` | P7-03: a real local Event Hubs server for the Azure/Entra ID connector |
| Event Hubs emulator management | 5300 | `localhost:5300` | Emulator's own management port |
| Event Hubs emulator Kafka API | 9093 | `localhost:9093` | Unused by this connector (it speaks AMQP); offset from 9092 the same way Redpanda's own 19092 is |
| Azurite blob | 10000 | `localhost:10000` | The emulator's own required metadata/blob backend |
| Azurite queue | 10001 | `localhost:10001` | Same |
| Azurite table | 10002 | `localhost:10002` | Same |
| Jaeger UI | 16686 | <http://localhost:16686> | Distributed traces |
| OTLP gRPC | 4317 | `localhost:4317` | otel-collector's trace/metric ingest — every service points here, never at Jaeger or Prometheus directly |
| OTLP HTTP | 4318 | `localhost:4318` | Same, over HTTP |
| otel-collector metrics | 8889 | <http://localhost:8889/metrics> | Prometheus-scrapable output, published for ad-hoc debugging (Prometheus itself scrapes this over the Docker network) |
| otel-collector health | 13133 | <http://localhost:13133> | `health_check` extension — the collector's image has no shell, so this is the only way to probe it from outside the container |
| Prometheus | 9090 | <http://localhost:9090> | Metrics storage and ad-hoc PromQL |
| Grafana | 3001 | <http://localhost:3001> | Golden-signal dashboards (`admin` / `sentineldev`). 3000 is the dashboard app's own port (offset here) |

Every published port is listed here, and `pnpm stack:check` fails if one is missing —
an undocumented port is one somebody discovers by having something else break.

Two ports are deliberately **not** published: Redpanda's internal broker listener
(9092) and Jaeger's admin port (14269). Both are reachable inside the Docker network,
which is where the healthchecks run, and neither is useful from the host.

Everything should be healthy within 90 seconds:

```bash
docker compose -f infra/docker/docker-compose.dev.yml ps
```

Then apply schemas:

```bash
pnpm db:migrate
```

Migrations are tracked in a `schema_migrations` ledger, so `db:migrate` is safe
to re-run. Editing a migration that has already been applied is detected by
checksum and refused, rather than silently diverging your schema from production.
To change the schema, add a migration — never edit one that has run.

Then load the development fixtures:

```bash
pnpm db:seed
```

This provisions two tenants — a direct small-business customer and an MSP that
manages it — with deliberately different connectors, case counts and severities.
The difference is the point: with one tenant, every query returns the right rows
by accident, and isolation cannot be observed. The seed is idempotent, and it
refuses to run with `NODE_ENV=production`.

### Schema commands

| Command | What it does |
|---|---|
| `pnpm db:migrate` | Apply pending migrations and ClickHouse DDL |
| `pnpm db:seed` | Load the two-tenant development fixtures |
| `pnpm db:validate` | Assert every tenant-scoped table has a non-null `tenant_id` |
| `pnpm db:check` | Migrate a throwaway database from empty; assert the seed is idempotent |
| `pnpm db:docs` | Regenerate `docs/architecture/data-model.md` from the live schema |
| `pnpm db:docs:check` | Fail if that document is out of date |
| `pnpm db:pull` | Regenerate the typed Drizzle schema in `packages/db` |

### Stack and CI commands

| Command | What it does |
|---|---|
| `pnpm stack:check` | Assert every service is healthy, the debug UIs answer, ports are documented, and named volumes survive a restart |
| `pnpm stack:check:cold` | The above, plus remove the volumes and time a genuine cold start against the 90-second budget. **Destructive** — re-run `db:migrate` and `db:seed` afterwards |
| `pnpm workflows:validate` | Assert the CI path filters route correctly, e.g. a docs-only change runs no jobs |
| `pnpm ci:protect` | Apply required status checks to `main`. Currently exits 2 — branch protection needs GitHub Pro on a private repo (see [`ci.md`](ci.md)) |

Two of those deserve a note. `pnpm db:check` builds a scratch database and
migrates it from nothing, because your development database was migrated
incrementally and therefore proves nothing about the path production will take
exactly once. And `pnpm db:pull` runs one way only: the SQL migrations are the
source of truth, and the generated TypeScript is a reading of the result. Never
run `drizzle-kit generate` or `push` here — both would treat the generated file
as authoritative and drop every policy, trigger and grant they cannot express.

Finally, confirm the environment is not merely running but *enforcing* the
product guarantees:

```bash
pnpm verify
```

This provisions two tenants, runs a query with no `tenant_id` filter, and asserts
you get back only your own rows; attempts an `UPDATE` and a `DELETE` on the audit
log and asserts both are refused; and checks that a duplicate `event_id` collapses
in ClickHouse. 19 checks, all of them evidence rather than assertion.

---

## 5. Run

```bash
pnpm dev          # TypeScript apps (dashboard :3000, API :4000)
pnpm go:build     # Go services into bin/
```

---

## 6. Verify your setup

Run what CI runs. Each gates on a real exit code — if one of these passes
locally and fails in CI, that is worth investigating rather than retrying.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm go:test
pnpm detections:validate
```

Tear down when you are done. `-v` also removes the volumes:

```bash
pnpm dev:stack:down
```

---

## 7. Connecting a real Microsoft 365 tenant

Only needed for ingest work. **Use a Microsoft developer tenant, never a
production one** — you will be reading an organisation's complete audit trail.

1. Create a free [Microsoft 365 Developer tenant](https://developer.microsoft.com/microsoft-365/dev-program)
2. Register an application in Entra ID → App registrations
3. Add **application** permissions (not delegated):
   `ActivityFeed.Read`, `AuditLog.Read.All`, `Directory.Read.All`
4. Grant admin consent
5. Create a client secret and put the values in `.env`
6. Set the redirect URI to `http://localhost:3000/api/connectors/m365/callback`

Every scope above is read-only. If you find yourself needing a write scope for
ingest, that is a design discussion, not a configuration change.

---

## 8. Project planning workflow

`planning/` is the source of truth for the board, the roadmap and the progress
dashboard. Edit it, then regenerate — never edit a generated issue body by hand,
because the next sync overwrites it.

```bash
node scripts/validate-backlog.mjs      # always run before syncing
node scripts/sync-board.mjs --dry-run  # preview
node scripts/sync-board.mjs            # create/update issues, milestones, board
node tools/progress/build.mjs          # build the progress page into site/
```

`sync-board.mjs` is idempotent and resumable — a run interrupted by a rate limit
is safe to repeat.

---

## 9. Where to go next

| You want to | Read |
|---|---|
| Understand the system | [`docs/architecture/overview.md`](architecture/overview.md) |
| Know why something is the way it is | [`docs/adr/`](adr/) |
| See what is being built and when | [`docs/roadmap.md`](roadmap.md) |
| Build UI | [`docs/design/ui-ux-spec.md`](design/ui-ux-spec.md) |
| Write a detection rule | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Pick up work | The [project board](https://github.com/users/ajeetsingh272/projects) |

---

## 10. Troubleshooting

**ClickHouse exits immediately.** Almost always memory. Raise Docker's limit to
8 GB. Check with `docker compose -f infra/docker/docker-compose.dev.yml logs clickhouse`.

**Port already in use.** Postgres is on host port **5434**, not 5432: a natively
installed Postgres usually owns 5432, and other local project stacks frequently
take 5433. If something else collides, change the host-side port in
`infra/docker/docker-compose.dev.yml` — never the container-side one.

To find the culprit on Windows:

```powershell
Get-NetTCPConnection -LocalPort 5434 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

**A service is `unhealthy` but its logs look fine.** Check whether its
healthcheck uses `localhost`. Inside containers on Docker Desktop/WSL2,
`localhost` resolves to `::1` only, and most of these images bind IPv4 — so the
check fails permanently against a service that is up. Every healthcheck in the
compose file uses `127.0.0.1` for this reason.

**Object storage is SeaweedFS, not MinIO.** MinIO restricted their Docker Hub
images, so `docker pull minio/minio` now fails with `unauthorized` on a clean
machine. SeaweedFS speaks the same S3 API and is freely pullable. S3 endpoint is
`http://localhost:8333`, credentials `sentineldev` / `sentineldev`.

**`go build ./...` fails from the repo root.** Expected: with a `go.work` the
root is not itself a module. Use `pnpm go:build` / `pnpm go:test`, which enter
each module explicitly.

**`-race requires cgo`.** The race detector needs a C compiler, which Windows
lacks by default. `scripts/go-test.sh` skips it with a note and CI still runs
with `-race`, so races are caught before merge.

**Redpanda unhealthy.** It needs a moment longer than the others on first start
while it initialises its data directory. If it persists:
`docker compose -f infra/docker/docker-compose.dev.yml down -v` and start again.

**A query returns nothing and you are sure the data is there.** Row-level
security is almost certainly doing its job — `app.tenant_id` is not set for your
transaction. This is the designed behaviour from [ADR-0008](adr/0008-tenant-isolation.md):
a missing tenant filter returns zero rows rather than another customer's data.

**`pnpm install` fails on a fresh clone.** Check Node is 22+. `corepack enable`
if pnpm is not found.
