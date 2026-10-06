#!/usr/bin/env bash
# Builds every Go service and library into bin/ (or verifies it compiles,
# for a library with nothing to put there).
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

# services/*/ are the runnable services; go/*/ are shared Go libraries
# (go/sentinelschema — P0-11's generated contracts). A library with no cmd/
# of its own falls through to `go build ./...`, which still verifies it
# compiles without needing a binary name to write into bin/.
mkdir -p bin
for dir in services/*/ go/*/; do
  [ -f "${dir}go.mod" ] || continue
  name=$(basename "$dir")
  echo "building ${name}${EXT}"
  (cd "$dir" && go build -o "../../bin/${name}${EXT}" ./cmd/... 2>/dev/null || go build ./...)
done
echo "go build ok"
