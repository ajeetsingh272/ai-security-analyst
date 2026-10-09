#!/usr/bin/env bash
# P7-09 AC3/T1/T2/T3: restores the latest backup (scripts/backup.sh's own
# manifest) into a TARGET database/database-name — by default a disposable
# "*_restore_drill" name, never the live sentinel/sentinel database, so
# running this script is safe to do routinely (AC3's own "at least
# quarterly") without any risk of destroying real data.
#
# A TRUE disaster-recovery restore (the live database is actually gone)
# sets RESTORE_TARGET_IS_LIVE=yes and points POSTGRES_DB/CH_TARGET_DB at
# the real names — docs/runbooks/backup-and-restore.md's own Procedure
# section is the authoritative walkthrough for that path, not this
# script's default behaviour.
#
# Real procedure, confirmed by hand against this repo's own real dev
# stack before being written into this script (not assumed):
#   1. Postgres: create the target database fresh, run db/postgres's OWN
#      migrations against it (schema + roles + grants — ADR-0009's own
#      "SQL owns the schema", not a copy of the schema baked into the
#      dump), THEN pg_restore --data-only (the dump has no schema to
#      conflict with what migrations already created).
#   2. schema_migrations itself is the one table EXCLUDED from the data
#      restore (truncated first) — it's bookkeeping about which
#      migrations ran, which the fresh migrate.sh run above already
#      populated correctly for a database that has every migration
#      applied; restoring the OLD backup's own copy on top would just
#      re-insert the same ledger rows pg_restore's own duplicate-key
#      error would otherwise reject.
#   3. ClickHouse: RESTORE DATABASE sentinel AS <target> FROM Disk(...)
#      — AS, not a bare RESTORE, so a drill never touches the live
#      `sentinel` database at all.
set -euo pipefail
cd "$(dirname "$0")/.."
# See scripts/backup.sh's own identical comment — Git Bash/MSYS path
# rewriting breaks /backups/... arguments passed through docker compose
# exec on a Windows dev machine; a no-op elsewhere.
export MSYS_NO_PATHCONV=1

: "${POSTGRES_USER:=sentinel}"
: "${POSTGRES_PASSWORD:=sentinel}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5434}"
: "${POSTGRES_DB:=sentinel}"
: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"
: "${BACKUP_DIR:=.backups/postgres}"
: "${RESTORE_TARGET_IS_LIVE:=no}"
: "${PG_TARGET_DB:=${POSTGRES_DB}_restore_drill}"
: "${CH_TARGET_DB:=sentinel_restore_drill}"

MANIFEST="${BACKUP_DIR}/latest.json"
if [ ! -f "$MANIFEST" ]; then
  echo "error: no ${MANIFEST} — run scripts/backup.sh first." >&2
  exit 1
fi
PG_DUMP_NAME=$(node -pe "require('./${MANIFEST}').postgres_dump")
CH_BACKUP_NAME=$(node -pe "require('./${MANIFEST}').clickhouse_backup")
echo "restoring from manifest: postgres=${PG_DUMP_NAME} clickhouse=${CH_BACKUP_NAME}"

if [ "$RESTORE_TARGET_IS_LIVE" = yes ]; then
  echo "!! RESTORE_TARGET_IS_LIVE=yes — this will DROP and recreate ${PG_TARGET_DB} / ${CH_TARGET_DB} for real. !!"
  echo "!! This is the true disaster-recovery path. Ctrl-C now if this is not what you intend. !!"
  sleep 5
fi

if command -v pg_dump >/dev/null 2>&1; then
  PG_MODE=local
elif docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx postgres; then
  PG_MODE=docker
else
  echo "error: no local psql/pg_restore, and the postgres container is not running." >&2
  exit 1
fi
echo "postgres via: $PG_MODE"

psql_admin() {
  if [ "$PG_MODE" = local ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"
  else
    docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
      psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"
  fi
}

echo "── Postgres: recreating ${PG_TARGET_DB} ──"
START=$(date +%s)
psql_admin -c "DROP DATABASE IF EXISTS ${PG_TARGET_DB};" -c "CREATE DATABASE ${PG_TARGET_DB};"

echo "  applying real schema migrations (ADR-0009: SQL owns the schema)"
POSTGRES_DB="$PG_TARGET_DB" MIGRATE_SKIP_CLICKHOUSE=1 bash scripts/migrate.sh >/dev/null

if [ "$PG_MODE" = local ]; then
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$PG_TARGET_DB" -v ON_ERROR_STOP=1 -q -c "TRUNCATE schema_migrations;"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$PG_TARGET_DB" --data-only --disable-triggers "${BACKUP_DIR}/${PG_DUMP_NAME}"
else
  docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U "$POSTGRES_USER" -d "$PG_TARGET_DB" -v ON_ERROR_STOP=1 -q -c "TRUNCATE schema_migrations;"
  docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    pg_restore -U "$POSTGRES_USER" -d "$PG_TARGET_DB" --data-only --disable-triggers "/backups/${PG_DUMP_NAME}"
fi
PG_ELAPSED=$(( $(date +%s) - START ))
echo "  restored ${PG_TARGET_DB} in ${PG_ELAPSED}s"

echo "── ClickHouse: restoring AS ${CH_TARGET_DB} ──"
START=$(date +%s)
curl -sf "${CLICKHOUSE_URL}/?user=default" --data "DROP DATABASE IF EXISTS ${CH_TARGET_DB}" >/dev/null
curl -sf "${CLICKHOUSE_URL}/?user=default" --data "RESTORE DATABASE sentinel AS ${CH_TARGET_DB} FROM Disk('backups', '${CH_BACKUP_NAME}')"
echo
CH_ELAPSED=$(( $(date +%s) - START ))
echo "  restored ${CH_TARGET_DB} in ${CH_ELAPSED}s"

echo
echo "restore ok — postgres: ${PG_ELAPSED}s, clickhouse: ${CH_ELAPSED}s"
echo "verify with:  pnpm backup:verify"
