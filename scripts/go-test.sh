#!/usr/bin/env bash
# Gates on the real exit code. Output is not piped anywhere that could
# swallow a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for dir in services/*/; do
  [ -f "${dir}go.mod" ] || continue
  name=$(basename "$dir")
  echo "── ${name} ──"
  (cd "$dir" && go vet ./... && go test -race -coverprofile=coverage.out ./...) || fail=1
done
exit $fail
