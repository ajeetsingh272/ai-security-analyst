#!/usr/bin/env bash
# Applies Postgres migrations and ClickHouse DDL.
#
# Postgres migrations are tracked in a schema_migrations ledger, so this is safe
# to re-run: already-applied files are skipped. The ledger also stores a
# checksum, so editing a migration that has already run is caught rather than
# silently ignored — the usual way a developer's schema drifts from production.
#
# Uses the local `psql` when it exists, otherwise runs it inside the Postgres
# container. That keeps `psql` off the prerequisite list — one less thing
# standing between a clean machine and a running stack.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${POSTGRES_URL:=postgres://sentinel:sentinel@localhost:5434/sentinel}"
: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"

# ── Pick how we reach Postgres ──────────────────────────────────────────────
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
    # -T because there is no TTY in CI. ON_ERROR_STOP makes a failed statement
    # a failed migration rather than a partially applied schema.
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U sentinel -d sentinel -v ON_ERROR_STOP=1 -q < "$file"
  fi
}

pg_sql() {
  if [ "$PG_MODE" = local ]; then
    psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U sentinel -d sentinel -v ON_ERROR_STOP=1 -q -t -A -c "$1"
  fi
}

echo "── Postgres ──"

pg_sql "CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );" > /dev/null

shopt -s nullglob
pg_files=(db/postgres/migrations/*.sql)
if [ ${#pg_files[@]} -eq 0 ]; then
  echo "  no migrations found"
else
  applied_any=0
  for f in "${pg_files[@]}"; do
    name=$(basename "$f")
    # Hash with line endings normalised. Hashing raw bytes would make a
    # Windows checkout (CRLF) and Linux CI (LF) disagree about an identical
    # file, producing a spurious "migration edited" failure.
    sum=$(tr -d '\015' < "$f" | sha256sum | cut -d' ' -f1)
    prev=$(pg_sql "SELECT checksum FROM schema_migrations WHERE filename = '$name';" | tr -d '[:space:]')

    if [ -n "$prev" ]; then
      if [ "$prev" != "$sum" ]; then
        echo "  ERROR $name has been edited since it was applied." >&2
        echo "        applied: $prev" >&2
        echo "        on disk: $sum" >&2
        echo "        Migrations are immutable once applied. Add a new one, or" >&2
        echo "        reset the dev database:" >&2
        echo "          pnpm dev:stack:down && pnpm dev:stack && pnpm db:migrate" >&2
        exit 1
      fi
      echo "  skip    $name (already applied)"
      continue
    fi

    echo "  apply   $name"
    run_pg "$f"
    pg_sql "INSERT INTO schema_migrations (filename, checksum) VALUES ('$name', '$sum');" > /dev/null
    applied_any=1
  done
  [ "$applied_any" -eq 0 ] && echo "  database already up to date"
fi

echo "── ClickHouse ──"
ch_files=(db/clickhouse/*.sql)
if [ ${#ch_files[@]} -eq 0 ]; then
  echo "  no DDL found"
else
  for f in "${ch_files[@]}"; do
    echo "  applying $(basename "$f")"
    # ClickHouse's HTTP interface takes one statement per request, so split on
    # the semicolons that terminate a statement at end of line. Comments and
    # blank fragments are skipped.
    python - "$f" "$CLICKHOUSE_URL" <<'PY'
import re, sys, urllib.request

path, url = sys.argv[1], sys.argv[2]
sql = open(path, encoding='utf-8').read()
# Drop line comments so a trailing ";" inside one cannot split a statement.
sql = re.sub(r'^\s*--.*$', '', sql, flags=re.M)

for stmt in (s.strip() for s in sql.split(';')):
    if not stmt:
        continue
    req = urllib.request.Request(url, data=stmt.encode('utf-8'), method='POST')
    try:
        urllib.request.urlopen(req).read()
    except Exception as e:
        body = getattr(e, 'read', lambda: b'')().decode('utf-8', 'replace')
        head = ' '.join(stmt.split())[:110]
        print(f'    FAILED: {head}...\n    {body.strip()[:400]}', file=sys.stderr)
        sys.exit(1)
PY
  done
fi

echo "migrations ok"
