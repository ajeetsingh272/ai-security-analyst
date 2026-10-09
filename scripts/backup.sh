#!/usr/bin/env bash
# P7-09 AC1: a full Postgres dump + a full ClickHouse native backup, both
# timestamped, both landing where scripts/restore.sh and the daily scheduled
# job (.github/workflows/backup.yml) both expect them.
#
# Same local-or-docker fallback as scripts/migrate.sh: prefers local
# pg_dump, falls back to the postgres container. ClickHouse always goes
# over its HTTP interface (one BACKUP statement, no clickhouse-client
# dependency) — the same POST-based pattern migrate.sh's own ClickHouse
# section already uses.
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash (MSYS) rewrites a leading /backups/... argument into a
# Windows path before docker even sees it, breaking every `docker
# compose exec ... pg_dump -f /backups/...` call below on a Windows
# dev machine. Ignored entirely outside MSYS, so this is a no-op on
# Linux/macOS/CI.
export MSYS_NO_PATHCONV=1

: "${POSTGRES_USER:=sentinel}"
: "${POSTGRES_PASSWORD:=sentinel}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5434}"
: "${POSTGRES_DB:=sentinel}"
: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"
# Host-side mirror of the postgres container's own /backups mount
# (docker-compose.dev.yml) — pg_dump below always writes to /backups
# INSIDE the container in docker mode, which lands here on the host
# either way, so callers never need to know which mode ran.
: "${BACKUP_DIR:=.backups/postgres}"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
PG_DUMP_NAME="sentinel-${TIMESTAMP}.dump"
CH_BACKUP_NAME="sentinel-${TIMESTAMP}.zip"

mkdir -p "$BACKUP_DIR"

if command -v pg_dump >/dev/null 2>&1; then
  PG_MODE=local
elif docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx postgres; then
  PG_MODE=docker
else
  echo "error: no local pg_dump, and the postgres container is not running." >&2
  echo "       start the stack first:  pnpm dev:stack" >&2
  exit 1
fi
echo "postgres via: $PG_MODE"

echo "── Postgres ──"
START=$(date +%s)
if [ "$PG_MODE" = local ]; then
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "${BACKUP_DIR}/${PG_DUMP_NAME}"
else
  # -Fc (custom format): compressed, and restorable with pg_restore's own
  # --data-only/--disable-triggers combination scripts/restore.sh uses —
  # a plain SQL dump would need a slower, less precise text-based filter
  # to separate schema from data on restore.
  docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "/backups/${PG_DUMP_NAME}"
fi
PG_ELAPSED=$(( $(date +%s) - START ))
echo "  wrote ${BACKUP_DIR}/${PG_DUMP_NAME} in ${PG_ELAPSED}s"

echo "── ClickHouse ──"
START=$(date +%s)
CH_RESPONSE=$(curl -sf "${CLICKHOUSE_URL}/?user=default" --data "BACKUP DATABASE sentinel TO Disk('backups', '${CH_BACKUP_NAME}')")
CH_ELAPSED=$(( $(date +%s) - START ))
echo "  ${CH_RESPONSE}"
echo "  wrote (on the clickhouse container's own chbackups volume) ${CH_BACKUP_NAME} in ${CH_ELAPSED}s"

# AC1's own "monitored success": a manifest the scheduled job
# (.github/workflows/backup.yml) and scripts/restore.sh both read, so
# "which backup is the latest" is never a guess from a directory
# listing's own mtimes.
MANIFEST="${BACKUP_DIR}/latest.json"
cat > "$MANIFEST" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "postgres_dump": "${PG_DUMP_NAME}",
  "postgres_seconds": ${PG_ELAPSED},
  "clickhouse_backup": "${CH_BACKUP_NAME}",
  "clickhouse_seconds": ${CH_ELAPSED}
}
EOF
echo "backup ok — manifest: ${MANIFEST}"
