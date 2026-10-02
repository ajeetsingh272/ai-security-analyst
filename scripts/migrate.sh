#!/usr/bin/env bash
# Applies Postgres migrations and ClickHouse DDL against the dev stack.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${POSTGRES_URL:=postgres://sentinel:sentinel@localhost:5432/sentinel}"
: "${CLICKHOUSE_URL:=http://localhost:8123}"

echo "── Postgres ──"
for f in db/postgres/migrations/*.sql; do
  [ -e "$f" ] || { echo "no migrations yet"; break; }
  echo "applying $(basename "$f")"
  psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "── ClickHouse ──"
for f in db/clickhouse/*.sql; do
  [ -e "$f" ] || { echo "no DDL yet"; break; }
  echo "applying $(basename "$f")"
  curl -sS --fail-with-body "$CLICKHOUSE_URL" --data-binary "@$f" > /dev/null
done

echo "migrations ok"
