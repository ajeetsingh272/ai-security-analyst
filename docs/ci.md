# Continuous integration

Four workflows gate every pull request. They are separate files so TypeScript and Go
run concurrently, fail independently, and are owned independently — a Go change never
queues behind a TypeScript build, and editing one cannot break the other's trigger.

| Workflow | Gates | Budget |
|---|---|---|
| [`ci-typescript.yml`](../.github/workflows/ci-typescript.yml) | Manifest lint, workflow-filter lint, eslint, `tsc`, unit tests, build, plus a cold clean-clone install and build | 8 min |
| [`ci-go.yml`](../.github/workflows/ci-go.yml) | `go vet`, `go test -race`, golangci-lint, build, detection-rule validation | 8 min |
| [`ci-integration.yml`](../.github/workflows/ci-integration.yml) | Real containers: stack health and persistence, migrations, schema tenancy lint, migrate-from-empty, seed idempotency, data-model drift, isolation suite | 15 min |
| [`ci-planning.yml`](../.github/workflows/ci-planning.yml) | Backlog validity — acceptance criteria, test coverage, dependency ordering, cycle-freedom | 5 min |

[`progress.yml`](../.github/workflows/progress.yml) is not a gate; it rebuilds the
progress dashboard.

## Every gate reports its own exit code

No step pipes test output through `tail` or `grep`. A pipeline's exit status is the
*last* command's, so `pnpm test | tail -5` reports the status of `tail`, which
succeeds at printing a failure. That one habit turns a red build green, and it is the
reason `CONTRIBUTING.md` asks for pasted command output rather than a summary.

## Why no workflow filters on its trigger

None of these workflows uses `on: pull_request: paths:`. Each one always starts, and
an inner `changes` job decides whether the real work runs.

That looks redundant and is not. **A workflow skipped by `on.paths` reports no check
at all, and a required status check that never reports blocks the pull request
permanently** — the merge button waits forever for an answer that is never coming. A
job skipped by `if:` does report, as skipped, which GitHub counts as satisfied.

So path filtering lives one level in, which keeps it compatible with required checks.
`scripts/validate-workflows.mjs` asserts this property, because it is the kind of
thing someone reasonably "tidies up" into a trigger filter years later.

## Path filtering is tested, not trusted

`pnpm workflows:validate` parses the filters out of the workflows and evaluates
change sets against them, asserting both directions:

- a docs-only change reaches **no** job (P0-02 AC3/T3);
- a Go change reaches the Go matrix, a migration reaches the integration job, a
  detection rule reaches rule validation, a lockfile change rebuilds TypeScript.

The second half matters more than it looks. A filter matching nothing would satisfy
"docs-only does not run Go" while silently disabling CI altogether — which is not
hypothetical. Before this check existed, a change under `db/` matched no filter, so
adding a migration ran no jobs at all.

It also enforces two structural rules that are easy to break once workflows are
split across files:

- **every job declares `timeout-minutes`**, so a hang fails in minutes rather than
  burning six hours of runner time;
- **every workflow has its own `concurrency` group.** Sharing one group across files
  makes each push cancel its siblings, which presents as an intermittently flaky
  pipeline and is miserable to diagnose.

## Required status checks — currently blocked

`pnpm ci:protect` applies branch protection to `main`, requiring these checks:

```
typescript   clean-clone   go   detections   integration   planning
```

The `changes · …` filter jobs are deliberately not required: they decide whether work
runs and add no signal of their own.

**This cannot be applied today.** Branch protection and rulesets both require GitHub
Pro, Team or Enterprise on a **private** repository; on the Free plan the API returns:

```
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

`pnpm ci:protect` detects exactly this and exits **2** with that message, rather than
appearing to succeed. This is the same plan limitation that blocks the Pages deploy for
the progress dashboard — see [`progress-dashboard.md`](progress-dashboard.md). Either
make the repository public or upgrade the account, then re-run the command; nothing else
has to change, because the workflows already emit check names matching the list above.

Until then, **P0-02 cannot be closed**: acceptance criterion 5 and tests T1 and T2
("a PR with a deliberately failing test is blocked from merging") all depend on
required checks existing. The pipeline itself is complete and working; the enforcement
layer is the part the plan withholds.

Reviewer requirements are deliberately left off even once protection is available. A
solo maintainer cannot approve their own pull request, so turning on mandatory reviews
would lock the only committer out of the repository. The two-reviewer rule for
`trust-guarantee` tickets (`SECURITY.md`) belongs with CODEOWNERS, in P0-09.

## Adding a gate

1. Add the script to the right package and give it a real exit code.
2. Add a step to the workflow that owns that area.
3. If the gate watches files no existing filter covers, extend the filter **and** add a
   case to `scripts/validate-workflows.mjs`. A gate nothing triggers is not a gate.
4. If it is a new job and protection is ever enabled, add its check name to
   `CONTEXTS` in `scripts/setup-branch-protection.sh`.

## Running the gates locally

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm go:build && pnpm go:test
pnpm workspace:validate && pnpm workflows:validate
pnpm stack:check            # needs the dev stack up
pnpm db:validate && pnpm db:check && pnpm db:docs:check
pnpm verify
```

Two local caveats, both expected:

- **`-race` does not run locally.** It needs cgo and a C compiler. `scripts/go-test.sh`
  skips it with a note; CI is the only place races are actually caught, which is why
  that step must never be weakened.
- **Go may not be on `PATH`** in a fresh shell, which makes `go:build` and `go:test`
  fail with `command not found`. That is an environment problem, not a broken build.
