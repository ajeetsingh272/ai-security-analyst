#!/usr/bin/env bash
# Proves two things about the schema, against a throwaway database.
#
#   P0-04 T1 — migrations apply cleanly to an EMPTY database.
#   P0-04 T2 — the seed is idempotent: running it twice leaves identical state.
#
# Why a throwaway database rather than the dev one: the dev database has already
# had every migration applied, so running the migrator against it proves only
# that the ledger skips work. "It worked on my machine" is, in this specific
# case, a statement about a database that was migrated incrementally over weeks.
# Production will be migrated from empty exactly once, and that is the path that
# has never been exercised. This script exercises it on every run.
#
# The schema lint runs against the fresh database too, so the invariant is proven
# on a database built only from the committed migrations, with no manual repair.
#
# Leaves nothing behind: the scratch database is dropped on exit, including on
# failure, so a red run does not poison the next one.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5434}"
: "${POSTGRES_USER:=sentinel}"
: "${POSTGRES_PASSWORD:=sentinel}"
SCRATCH_DB="${SCRATCH_DB:-sentinel_migration_check}"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }

# ── Reach Postgres the same way migrate.sh does ─────────────────────────────
if command -v psql >/dev/null 2>&1; then
  PG_MODE=local
elif docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx postgres; then
  PG_MODE=docker
else
  echo "error: no local psql, and the postgres container is not running." >&2
  echo "       start the stack first:  pnpm dev:stack" >&2
  exit 1
fi

# Administrative statements must not run inside the scratch database, because
# CREATE/DROP DATABASE cannot target the database you are connected to.
admin() {
  if [ "$PG_MODE" = local ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  fi
}

scratch() {
  if [ "$PG_MODE" = local ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$SCRATCH_DB" \
      -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  fi
}

cleanup() {
  admin "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "postgres via: $PG_MODE"
echo "scratch database: $SCRATCH_DB"
echo

# ─────────────────────────────────────────────────────────────────────────────
echo "══ P0-04 T1 · Migrations apply to an empty database ═════════════════════"

cleanup
admin "CREATE DATABASE \"$SCRATCH_DB\";" > /dev/null

# Guard the premise. If the database is not actually empty, a pass below would
# mean nothing, so this is an assertion rather than a comment.
tables_before=$(scratch "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" | tr -d '[:space:]')
if [ "$tables_before" = "0" ]; then
  ok "scratch database starts empty (0 tables in public)"
else
  bad "scratch database is not empty — $tables_before tables already present"
fi

# MIGRATE_SKIP_CLICKHOUSE because ClickHouse DDL is cluster-wide, not per
# Postgres database; re-applying it here would test nothing and slow the run.
if POSTGRES_DB="$SCRATCH_DB" MIGRATE_SKIP_CLICKHOUSE=1 bash scripts/migrate.sh > /tmp/migrate-empty.log 2>&1; then
  applied=$(grep -c '^  apply   ' /tmp/migrate-empty.log || true)
  ok "all migrations applied from empty ($applied file(s))"
else
  bad "migrations failed against an empty database"
  sed 's/^/        /' /tmp/migrate-empty.log
fi

# Re-running must be a no-op. The ledger is the mechanism; this proves it works
# rather than assuming it.
if POSTGRES_DB="$SCRATCH_DB" MIGRATE_SKIP_CLICKHOUSE=1 bash scripts/migrate.sh > /tmp/migrate-again.log 2>&1; then
  if grep -q 'database already up to date' /tmp/migrate-again.log; then
    ok "re-running the migrator is a no-op"
  else
    bad "re-run did not report an up-to-date database"
    sed 's/^/        /' /tmp/migrate-again.log
  fi
else
  bad "re-running the migrator failed"
  sed 's/^/        /' /tmp/migrate-again.log
fi

# The invariant must hold on a database built only from committed migrations.
if POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${SCRATCH_DB}" \
   pnpm --silent --filter @sentinel/db validate > /tmp/validate-empty.log 2>&1; then
  ok "schema lint passes on the freshly migrated database"
else
  bad "schema lint failed on the freshly migrated database"
  sed 's/^/        /' /tmp/validate-empty.log
fi

echo
# ─────────────────────────────────────────────────────────────────────────────
echo "══ P0-04 T2 · Seed is idempotent ════════════════════════════════════════"

# A fingerprint of every seeded table: each row rendered to text, ordered, hashed.
# Ordering by the row's own text makes it independent of physical row order, so a
# difference means the data differs, not that the planner returned it differently.
FINGERPRINT_SQL="
SELECT string_agg(line, E'\n' ORDER BY line) FROM (
  SELECT 'tenants='           || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') AS line FROM tenants t
  UNION ALL SELECT 'users='             || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM users t
  UNION ALL SELECT 'memberships='       || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM memberships t
  UNION ALL SELECT 'msp_links='         || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM msp_links t
  UNION ALL SELECT 'connectors='        || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM connectors t
  UNION ALL SELECT 'connector_cursors=' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM connector_cursors t
  UNION ALL SELECT 'cases='             || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM cases t
  UNION ALL SELECT 'case_transitions='  || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM case_transitions t
  UNION ALL SELECT 'actions='           || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM actions t
) s;"

seed_scratch() {
  POSTGRES_DB="$SCRATCH_DB" bash scripts/seed.sh > "$1" 2>&1
}

if seed_scratch /tmp/seed-1.log; then
  ok "seed loads into a freshly migrated database"
else
  bad "seed failed on first run"
  sed 's/^/        /' /tmp/seed-1.log
fi

fp1=$(scratch "$FINGERPRINT_SQL")

if seed_scratch /tmp/seed-2.log; then
  ok "seed re-runs without error"
else
  bad "seed failed on second run"
  sed 's/^/        /' /tmp/seed-2.log
fi

fp2=$(scratch "$FINGERPRINT_SQL")

if [ -z "$fp1" ]; then
  bad "fingerprint came back empty — the seed inserted nothing"
elif [ "$fp1" = "$fp2" ]; then
  ok "state is byte-identical after a second seed run"
else
  bad "seed is NOT idempotent — state changed on the second run"
  echo "        first run:"
  printf '%s\n' "$fp1" | sed 's/^/          /'
  echo "        second run:"
  printf '%s\n' "$fp2" | sed 's/^/          /'
fi

# Isolation is the reason the seed exists, so check it produced two distinguishable
# tenants rather than merely two rows.
counts=$(scratch "SELECT count(DISTINCT tenant_id) FROM cases;" | tr -d '[:space:]')
if [ "$counts" = "2" ]; then
  ok "cases exist for exactly 2 distinct tenants"
else
  bad "expected cases across 2 tenants, found $counts"
fi

echo
echo "═════════════════════════════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m%d passed, 0 failed\033[0m\n' "$pass"
  echo "  Migrations apply from empty and the seed is idempotent."
  exit 0
fi
printf '  \033[31m%d passed, %d failed\033[0m\n' "$pass" "$fail"
exit 1
