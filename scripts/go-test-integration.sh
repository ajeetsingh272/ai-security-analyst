#!/usr/bin/env bash
# Vets and tests every Go module's integration-tagged tests — the Go
# counterpart to `pnpm test:integration`'s split from `pnpm test`.
#
# Needs a live dev stack (pnpm dev:stack && pnpm db:migrate); separated from
# go-test.sh by the `integration` build tag so the plain `go test ./...` CI
# job (no Postgres available there) never even compiles these files, rather
# than relying on each test to detect and skip itself at runtime.
#
# Gates on real exit codes. Output is not piped anywhere that could swallow a
# failure.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ran_any=0
for dir in services/*/ go/*/; do
  [ -f "${dir}go.mod" ] || continue
  # Not every module has integration-tagged tests (go/sentinelobs,
  # go/sentinelschema do not) — skip silently rather than fail on a module
  # with nothing to run, matching how T:unit/T:integration splits behave
  # elsewhere in this repo.
  if ! grep -rl "^//go:build integration" "$dir" >/dev/null 2>&1; then
    continue
  fi
  ran_any=1
  name=$(basename "$dir")
  echo "── ${name} (integration) ──"
  (
    cd "$dir" || exit 1
    go vet -tags=integration ./... || exit 1
    go test -tags=integration ./... || exit 1
  ) || fail=1
done

if [ "$ran_any" -eq 0 ]; then
  echo "no Go module has integration-tagged tests yet"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "go integration tests FAILED"
  exit 1
fi
echo
echo "go integration tests ok"
