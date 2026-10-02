#!/usr/bin/env bash
# Builds every Go service into bin/.
#
# Turborepo does not understand the Go module graph (ADR-0001), so Go gets its
# own entry point. With a go.work the repo root is not itself a module, so each
# module is entered explicitly rather than relying on `./...` from the root.
set -euo pipefail
cd "$(dirname "$0")/.."

# `go build -o <name>` writes exactly that name, so Windows needs the extension
# added or the result is not executable.
EXT=""
case "$(go env GOOS)" in
  windows) EXT=".exe" ;;
esac

mkdir -p bin
for dir in services/*/; do
  [ -f "${dir}go.mod" ] || continue
  name=$(basename "$dir")
  echo "building ${name}${EXT}"
  (cd "$dir" && go build -o "../../bin/${name}${EXT}" ./cmd/...)
done
echo "go build ok"
