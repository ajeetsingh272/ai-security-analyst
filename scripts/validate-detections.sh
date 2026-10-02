#!/usr/bin/env bash
# Enforces the detection content rules from CONTRIBUTING.md:
#   - every rule declares a MITRE ATT&CK technique
#   - every rule has a positive AND a negative fixture
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
exit $fail
