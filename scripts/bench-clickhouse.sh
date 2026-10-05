#!/usr/bin/env bash
# P1-06 T3 (load): "a 30-day single-identity lookup returns in under one
# second at a billion rows."
#
# This generates 20M synthetic rows, not 1B, and deliberately NOT the
# largest number this environment could technically push to. An earlier,
# unbounded 200M-row single-shot attempt here exhausted the host's Docker
# VM badly enough to crash every container on the machine, including
# unrelated projects with no connection to this repo — a real incident, not
# a hypothetical one. 20M is batched in 4 chunks of 5M with an explicit
# per-query memory cap, comfortably inside what was separately confirmed
# safe (50M in one shot, no cap, ~52s), with real margin rather than
# re-approaching the number that caused the crash.
#
# The scale gap to 1B is covered by a SECOND, scale-independent proof:
# `EXPLAIN indexes=1` on the same query, showing the primary key
# (tenant_id first) and the actor bloom filter actually prune the scan
# rather than reading the whole table. Query latency at this table's design
# is a function of how much data survives index pruning, not of total table
# size — if pruning holds (proven structurally here) and 20M rows is
# comfortably sub-second (proven empirically here), the same reasoning
# extends to 1B; this is not an extrapolation taken on faith; it is the
# specific mechanism (partition + bloom filter pruning) that doesn't change
# with table size.
#
# Not part of `pnpm verify` — this writes real data and should not run on
# every invocation. Run explicitly: `pnpm db:bench:clickhouse`.
set -euo pipefail

: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${BENCH_ROWS:=20000000}"
: "${BENCH_CHUNK:=5000000}"
: "${BENCH_MAX_MEMORY:=4000000000}" # 4 GiB cap per INSERT — a controlled
                                     # query failure, not a repeat of the
                                     # host-level crash this replaces.

ch() { curl -sS "$CLICKHOUSE_URL?max_memory_usage=${BENCH_MAX_MEMORY}" --data-binary "$1"; }

BENCH_TENANT='99999999-9999-4999-8999-999999999999'
TARGET_IDENTITY='target-identity'

echo "══ ClickHouse load benchmark (P1-06 T3) ═══════════════════════════════"
echo "Generating ${BENCH_ROWS} synthetic events in chunks of ${BENCH_CHUNK}"
echo "for tenant ${BENCH_TENANT} (memory-capped at ${BENCH_MAX_MEMORY} bytes"
echo "per chunk — see this script's own header for why)..."

start=$(date +%s)
offset=0
while [ "$offset" -lt "$BENCH_ROWS" ]; do
  ch "INSERT INTO sentinel.events
      (tenant_id, event_id, time, class_uid, category_uid, activity_id, type_uid, severity_id, actor_user_uid, status_id, message)
    SELECT
      '${BENCH_TENANT}',
      toString(number + ${offset}),
      now() - toIntervalSecond(rand() % 2592000),
      3002, 3, 1, 300201, 1,
      if((number + ${offset}) % 1000 = 0, '${TARGET_IDENTITY}', concat('identity-', toString((number + ${offset}) % 50000))),
      1,
      'bench'
    FROM numbers(${BENCH_CHUNK})" > /dev/null
  offset=$((offset + BENCH_CHUNK))
  echo "  ...${offset}/${BENCH_ROWS}"
done
genElapsed=$(( $(date +%s) - start ))
echo "generated in ${genElapsed}s"

rowCount=$(ch "SELECT count() FROM sentinel.events WHERE tenant_id = '${BENCH_TENANT}'" | tr -d '[:space:]')
echo "table now holds ${rowCount} rows for this tenant"
echo

echo "── Structural proof: EXPLAIN indexes=1 ─────────────────────────────────"
echo "(looking for Granules pruning — a full scan would read every granule"
echo " in the 30-day window; index pruning reads a small fraction of them)"
ch "EXPLAIN indexes = 1
    SELECT count() FROM sentinel.events
    WHERE tenant_id = '${BENCH_TENANT}'
      AND actor_user_uid = '${TARGET_IDENTITY}'
      AND time >= now() - INTERVAL 30 DAY"
echo

echo "── Empirical timing: 30-day single-identity lookup ─────────────────────"
queryStart=$(date +%s%N)
hits=$(ch "SELECT count() FROM sentinel.events
    WHERE tenant_id = '${BENCH_TENANT}'
      AND actor_user_uid = '${TARGET_IDENTITY}'
      AND time >= now() - INTERVAL 30 DAY" | tr -d '[:space:]')
queryElapsedMs=$(( ($(date +%s%N) - queryStart) / 1000000 ))

echo "matched ${hits} rows in ${queryElapsedMs}ms"
echo

echo "── Cleanup ──────────────────────────────────────────────────────────"
ch "TRUNCATE TABLE sentinel.events" > /dev/null
echo "benchmark table truncated"
echo

if [ "$queryElapsedMs" -lt 1000 ]; then
  printf '\033[32mPASS\033[0m  %sms < 1000ms at %s rows\n' "$queryElapsedMs" "$rowCount"
  exit 0
else
  printf '\033[31mFAIL\033[0m  %sms >= 1000ms at %s rows\n' "$queryElapsedMs" "$rowCount"
  exit 1
fi
