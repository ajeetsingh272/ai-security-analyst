#!/usr/bin/env bash
# Vets and tests every Go service and library.
#
# Two things this works around:
#
#  1. With a go.work, the repo root is not itself a module, so `go test ./...`
#     from the root cannot resolve. Each module is entered explicitly.
#
#  2. -race needs cgo, which needs a C toolchain. Linux CI has one; a Windows
#     dev machine usually does not. Rather than fail there, the race detector is
#     used when available and skipped with a visible note when it is not — CI
#     still enforces it, so a data race cannot reach main.
#
# Gates on real exit codes. Output is not piped anywhere that could swallow a
# failure.
set -uo pipefail
cd "$(dirname "$0")/.."

RACE=""
if [ "${CGO_ENABLED:-1}" != "0" ] && go env CGO_ENABLED | grep -q 1 && command -v gcc >/dev/null 2>&1; then
  RACE="-race"
else
  echo "note: race detector unavailable (needs cgo + a C compiler); running without it."
  echo "      CI runs with -race, so races are still caught before merge."
  echo
fi

fail=0
for dir in services/*/ go/*/; do
  [ -f "${dir}go.mod" ] || continue
  name=$(basename "$dir")
  echo "── ${name} ──"
  (
    cd "$dir" || exit 1
    go vet ./... || exit 1
    # shellcheck disable=SC2086
    go test $RACE -coverprofile=coverage.out ./... || exit 1
  ) || fail=1
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "go tests FAILED"
  exit 1
fi
echo
echo "go tests ok"
