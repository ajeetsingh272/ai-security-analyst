#!/usr/bin/env bash
# Enforces the detection content rules from CONTRIBUTING.md:
#   - every rule declares a MITRE ATT&CK technique
#   - every rule has a positive AND a negative fixture
#   - the committed generated code (P2-02, services/detect/internal/detectgen)
#     actually matches what regenerating from the current rules/fixtures
#     produces right now
#
# A rule without a negative fixture is a false-positive generator. CI blocks it.
set -euo pipefail
cd "$(dirname "$0")/.."

rules_dir=detections/rules
fixtures_dir=detections/fixtures
fail=0
count=0

shopt -s nullglob globstar
for rule in "$rules_dir"/**/*.yml "$rules_dir"/**/*.yaml; do
  count=$((count + 1))
  id=$(basename "$rule"); id="${id%.*}"

  if ! grep -qE '^\s*-?\s*attack\.t[0-9]{4}' "$rule" && ! grep -qiE 'technique:\s*T[0-9]{4}' "$rule"; then
    echo "ERROR ${rule}: no MITRE ATT&CK technique declared"
    fail=1
  fi

  [ -f "${fixtures_dir}/${id}.positive.json" ] || { echo "ERROR ${rule}: missing ${id}.positive.json"; fail=1; }
  [ -f "${fixtures_dir}/${id}.negative.json" ] || { echo "ERROR ${rule}: missing ${id}.negative.json — a rule without a negative fixture is a false-positive generator"; fail=1; }
done

if [ "$count" -eq 0 ]; then
  echo "no detection rules yet (expected before P2)"
  exit 0
fi

echo "checked ${count} rule(s)"

# P2-02 AC/T4: "Regenerating produces no diff when inputs are unchanged."
# sigmac-gen itself also fails the build for a missing fixture or MITRE id
# (it calls the same sigmac.Parse/GenerateSource this ticket's own unit
# tests exercise directly) — running it here is this check's second,
# independent proof that the COMMITTED output is what today's inputs
# actually produce, not just that it was once produced correctly.
if [ -d services/detect/internal/detectgen ]; then
  echo "regenerating compiled detection rules..."
  if ! (cd services/detect && go run ./cmd/sigmac-gen); then
    echo "ERROR: sigmac-gen failed to regenerate — see its own error above"
    fail=1
  elif ! git diff --exit-code -- services/detect/internal/detectgen; then
    echo "ERROR: regenerating produced a diff — commit 'go run ./cmd/sigmac-gen' output (run it from services/detect)"
    fail=1
  else
    echo "generated code is current"
  fi
fi

exit $fail
