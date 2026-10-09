#!/usr/bin/env bash
# P7-09 T1/T2/T3: runs a REAL backup, a REAL restore (into the disposable
# "*_restore_drill" targets scripts/restore.sh defaults to — never the
# live database), and proves it, rather than asserting it. This IS the
# quarterly drill AC3 asks for, runnable on demand, not just documentation
# describing one.
#
#   pnpm backup:verify
#
# Every check asks the real, restored system a question and compares the
# answer — same "prove it, don't assert it" doctrine scripts/check-stack.sh
# already established for this repo's own dev-stack verification.
set -uo pipefail
cd "$(dirname "$0")/.."

: "${POSTGRES_USER:=sentinel}"
: "${POSTGRES_PASSWORD:=sentinel}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5434}"
: "${POSTGRES_DB:=sentinel}"
: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"
: "${PG_TARGET_DB:=${POSTGRES_DB}_restore_drill}"
: "${CH_TARGET_DB:=sentinel_restore_drill}"
# AC2's own RTO targets, justified in docs/runbooks/backup-and-restore.md —
# repeated here as the actual gate this script enforces, not a number that
# only exists in prose.
: "${POSTGRES_RTO_SECONDS:=600}"
: "${CLICKHOUSE_RTO_SECONDS:=600}"

PASS=0
FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note(){ printf '        %s\n' "$1"; }

# Same local-or-docker fallback as scripts/migrate.sh/backup.sh — this
# sandbox has no local psql, so every one of these calls actually
# exercises the docker branch, not just the one someone happens to have
# a local client installed to test.
if command -v psql >/dev/null 2>&1; then
  PG_MODE=local
else
  PG_MODE=docker
fi

psql_db() {
  local db=$1 sql=$2
  if [ "$PG_MODE" = local ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db" -t -A -c "$sql" 2>/dev/null
  else
    docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
      psql -U "$POSTGRES_USER" -d "$db" -t -A -c "$sql" 2>/dev/null
  fi
}
pg_live()   { psql_db "$POSTGRES_DB" "$1"; }
pg_target() { psql_db "$PG_TARGET_DB" "$1"; }
ch_query()  { curl -sf "${CLICKHOUSE_URL}/?user=default" --data "$1"; }

echo "══ T1/T2: a real backup, then a real restore, timed ══════════════════════"
BACKUP_START=$(date +%s)
if bash scripts/backup.sh > /tmp/p7-09-backup.log 2>&1; then
  ok "scripts/backup.sh completed"
else
  bad "scripts/backup.sh failed — see /tmp/p7-09-backup.log"
  cat /tmp/p7-09-backup.log >&2
  exit 1
fi
BACKUP_ELAPSED=$(( $(date +%s) - BACKUP_START ))
note "backup took ${BACKUP_ELAPSED}s"

RESTORE_START=$(date +%s)
if bash scripts/restore.sh > /tmp/p7-09-restore.log 2>&1; then
  ok "scripts/restore.sh completed"
else
  bad "scripts/restore.sh failed — see /tmp/p7-09-restore.log"
  cat /tmp/p7-09-restore.log >&2
  exit 1
fi
RESTORE_ELAPSED=$(( $(date +%s) - RESTORE_START ))
note "restore took ${RESTORE_ELAPSED}s"

if [ "$RESTORE_ELAPSED" -le "$POSTGRES_RTO_SECONDS" ]; then
  ok "T1: restore completed within the stated Postgres RTO (${RESTORE_ELAPSED}s <= ${POSTGRES_RTO_SECONDS}s)"
else
  bad "T1: restore exceeded the stated Postgres RTO (${RESTORE_ELAPSED}s > ${POSTGRES_RTO_SECONDS}s)"
fi

echo
echo "══ T2: Postgres and ClickHouse data reconciles after restore ═════════════"
for table in tenants audit_log users cases; do
  live=$(pg_live "SELECT count(*) FROM ${table};" | tr -d '[:space:]')
  target=$(pg_target "SELECT count(*) FROM ${table};" | tr -d '[:space:]')
  if [ -n "$live" ] && [ "$live" = "$target" ]; then
    ok "postgres.${table}: live=${live} restored=${target}"
  else
    bad "postgres.${table}: live=${live} restored=${target} — MISMATCH"
  fi
done

ch_live=$(ch_query "SELECT count() FROM sentinel.events" | tr -d '[:space:]')
ch_restored=$(ch_query "SELECT count() FROM ${CH_TARGET_DB}.events" | tr -d '[:space:]')
if [ -n "$ch_live" ] && [ "$ch_live" = "$ch_restored" ]; then
  ok "clickhouse.events: live=${ch_live} restored=${ch_restored}"
else
  bad "clickhouse.events: live=${ch_live} restored=${ch_restored} — MISMATCH"
fi

echo
echo "══ T3: the audit chain verifies against the RESTORED database ═══════════"
if POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${PG_TARGET_DB}" \
   pnpm --filter @sentinel/db verify:audit-chain > /tmp/p7-09-chain.log 2>&1; then
  ok "ADR-0007's own hash-chain verifier passes against the restored database"
else
  bad "audit chain verification FAILED against the restored database — see /tmp/p7-09-chain.log"
  tail -20 /tmp/p7-09-chain.log >&2
fi

echo
echo "── cleanup: dropping the disposable restore-drill targets ──"
psql_db postgres "DROP DATABASE IF EXISTS ${PG_TARGET_DB};" >/dev/null 2>&1
ch_query "DROP DATABASE IF EXISTS ${CH_TARGET_DB}" >/dev/null 2>&1

echo
echo "═════════════════════════════════════════════════════════════════════════"
echo -e "  \033[32m${PASS} passed\033[0m, \033[31m${FAIL} failed\033[0m"
if [ "$FAIL" -ne 0 ]; then
  echo "backup/restore verification FAILED"
  exit 1
fi
echo "Backup/restore verified: a real backup was taken, a real restore completed within the stated RTO, data reconciles, and the audit chain verifies."
