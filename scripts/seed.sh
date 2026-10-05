#!/usr/bin/env bash
# Loads development seed data into Postgres.
#
# Separate from migrate.sh on purpose. A migration changes the shape of the
# database and must run everywhere, including production. Seed data is fixture
# content for a developer's machine and for isolation tests, and must never run
# in production. Keeping them in one script is how the second accidentally
# inherits the blast radius of the first.
#
# Idempotent: every statement in the seed files is ON CONFLICT or guarded, so
# re-running is a no-op rather than a duplicate-key failure.
#
# Reaches Postgres the same way migrate.sh does — local psql when present,
# otherwise inside the container — so psql stays off the prerequisite list.
set -euo pipefail
cd "$(dirname "$0")/.."

# Overridable in parts, matching migrate.sh, so the same seed can be loaded into
# a throwaway database for the idempotency check.
: "${POSTGRES_USER:=sentinel}"
: "${POSTGRES_PASSWORD:=sentinel}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5434}"
: "${POSTGRES_DB:=sentinel}"
: "${POSTGRES_URL:=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"

# Refuse to run anywhere that calls itself production. The seed inserts fixed
# UUIDs; colliding with real tenant ids is not a recoverable mistake.
if [ "${NODE_ENV:-development}" = "production" ]; then
  echo "error: refusing to seed with NODE_ENV=production." >&2
  exit 1
fi

if command -v psql >/dev/null 2>&1; then
  PG_MODE=local
elif docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx postgres; then
  PG_MODE=docker
else
  echo "error: no local psql, and the postgres container is not running." >&2
  echo "       start the stack first:  pnpm dev:stack" >&2
  exit 1
fi
echo "postgres via: $PG_MODE"

run_pg() {
  local file=$1
  if [ "$PG_MODE" = local ]; then
    psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -q -f "$file"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q < "$file"
  fi
}

# The seed assumes the schema exists. Failing with "relation does not exist" is
# a worse message than saying so.
has_tenants() {
  local q="SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants';"
  if [ "$PG_MODE" = local ]; then
    [ -n "$(psql "$POSTGRES_URL" -t -A -c "$q" 2>/dev/null)" ]
  else
    [ -n "$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
            psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "$q" 2>/dev/null | tr -d '[:space:]')" ]
  fi
}

if ! has_tenants; then
  echo "error: schema not found. run migrations first:  pnpm db:migrate" >&2
  exit 1
fi

echo "── Seed ──"
shopt -s nullglob
files=(db/postgres/seed/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "  no seed files found"
  exit 0
fi

for f in "${files[@]}"; do
  echo "  loading $(basename "$f")"
  run_pg "$f"
done

echo "seed ok"
