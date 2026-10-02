#!/usr/bin/env bash
# Builds every Go service. Turborepo does not understand the Go graph
# (ADR-0001), so Go gets its own entry point.
set -euo pipefail
cd "$(dirname "$0")/.."
for dir in services/*/; do
  [ -f "${dir}go.mod" ] || continue
  name=$(basename "$dir")
  echo "building ${name}"
  (cd "$dir" && go build -o "../../bin/${name}" ./cmd/...)
done
echo "go build ok"
