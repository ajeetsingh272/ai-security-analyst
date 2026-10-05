#!/usr/bin/env bash
# Proves the local development stack meets P0-03, rather than looking like it does.
#
#   bash scripts/check-stack.sh           non-destructive checks + restart persistence
#   bash scripts/check-stack.sh --cold    also measures a from-nothing cold start
#
# `docker compose up` can return exit 0 while an image pull failed, so "the command
# succeeded" is not evidence the stack is usable. Every check here asks the running
# system a question and compares the answer.
#
# --cold is destructive: it removes the named volumes to measure a genuine first-run
# startup (P0-03 AC1). The non-destructive default is what CI runs, because CI starts
# from nothing anyway and the timing there measures image pulls more than startup.
set -uo pipefail
cd "$(dirname "$0")/.."

: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"
: "${HEALTH_BUDGET_SECONDS:=90}"
COLD=0
[ "${1:-}" = "--cold" ] && COLD=1

PASS=0
FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '        %s\n' "$1"; }

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# The resolved config, from compose itself rather than our own YAML parsing, so
# what is asserted is what compose actually runs.
CONFIG=$(dc config --format json 2>/dev/null)
if [ -z "$CONFIG" ]; then
  echo "error: could not read compose config from $COMPOSE_FILE" >&2
  exit 1
fi

jq_node() { printf '%s' "$CONFIG" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s);
  $1
});"; }

SERVICES=$(jq_node "console.log(Object.keys(c.services).join('\n'))")
HEALTH_SERVICES=$(jq_node "console.log(Object.entries(c.services).filter(([,v])=>v.healthcheck).map(([n])=>n).join('\n'))")

echo "compose file: $COMPOSE_FILE"
echo

# ─────────────────────────────────────────────────────────────────────────────
echo "══ T1 · Every service with a healthcheck is healthy ═════════════════════"

for svc in $HEALTH_SERVICES; do
  cid=$(dc ps -q "$svc" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$cid" ]; then
    bad "$svc is not running"
    continue
  fi
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)
  if [ "$status" = healthy ]; then
    ok "$svc is healthy"
  else
    bad "$svc health is '$status', expected 'healthy'"
    note "$(docker inspect --format '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' "$cid" 2>/dev/null | tail -2 | tr '\n' ' ')"
  fi
done

# s3-init is a one-shot bucket creator, so it has no healthcheck by design — and
# that is exactly the gap: `up --wait` only waits for services THAT HAVE a
# healthcheck to go healthy, not for a one-shot container to finish. s3-init
# starts the moment `s3` is healthy and can still be mid-run (pulling the aws-cli
# image, creating buckets) when `--wait` returns successfully. A single
# point-in-time check here races that window and fails spuriously on a slower
# runner — caught on GitHub Actions, not reproducible on the faster local
# machine. So this polls for a terminal state instead of reading it once.
init_cid=$(dc ps -aq s3-init 2>/dev/null | tr -d '[:space:]')
if [ -z "$init_cid" ]; then
  bad "s3-init container not found"
else
  init_state=running
  for _ in $(seq 1 30); do
    init_state=$(docker inspect --format '{{.State.Status}}' "$init_cid" 2>/dev/null)
    [ "$init_state" = exited ] && break
    sleep 1
  done
  init_exit=$(docker inspect --format '{{.State.ExitCode}}' "$init_cid" 2>/dev/null)
  if [ "$init_state" = exited ] && [ "$init_exit" = 0 ]; then
    ok "s3-init completed (exit 0) — buckets provisioned"
  else
    bad "s3-init state=$init_state exit=$init_exit after 30s"
    note "$(docker logs "$init_cid" 2>&1 | tail -5 | tr '\n' ' ')"
  fi
fi

echo
# ─────────────────────────────────────────────────────────────────────────────
echo "══ AC2 · Health checks gate dependent services ══════════════════════════"

# A depends_on without a condition waits only for the container to start, which is
# the difference between deterministic startup and a race that usually wins.
#
# Exception: a dependency target with NO healthcheck at all (otel-collector —
# its image is fully distroless, no shell/wget/curl to run a CMD healthcheck
# against, see docker-compose.dev.yml's own comment on that service) has no
# service_healthy state to gate on in the first place, so service_started is
# the only condition that could ever be correct there — requiring
# service_healthy would demand something the service structurally cannot
# provide, not catch a real startup-ordering bug.
dep_report=$(jq_node "
  const bad=[]; let total=0;
  for(const [name,svc] of Object.entries(c.services)){
    for(const [dep,spec] of Object.entries(svc.depends_on||{})){
      total++;
      const depHasHealthcheck = !!(c.services[dep]||{}).healthcheck;
      const condition = spec.condition||'';
      const okCondition = depHasHealthcheck ? condition==='service_healthy' : condition==='service_started';
      if(!okCondition) bad.push(name+' -> '+dep+' ('+(condition||'none')+')');
    }
  }
  console.log(JSON.stringify({total, bad}));
")
dep_total=$(printf '%s' "$dep_report" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).total))")
dep_bad=$(printf '%s' "$dep_report" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).bad.join('; ')))")

if [ "$dep_total" = "0" ]; then
  bad "no depends_on relationships found — startup order is not gated at all"
elif [ -z "$dep_bad" ]; then
  ok "all $dep_total dependencies are correctly gated (service_healthy, or service_started where the target has no healthcheck to gate on)"
else
  bad "dependencies not gated on health: $dep_bad"
fi

echo
# ─────────────────────────────────────────────────────────────────────────────
echo "══ AC5 · Debugging UIs are reachable ════════════════════════════════════"

probe() {
  local name=$1 url=$2
  # --max-time so a hung service fails the check instead of the script.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)
  if [ "$code" = 200 ]; then
    ok "$name reachable ($url)"
  else
    bad "$name returned HTTP ${code:-no response} ($url)"
  fi
}

probe "Redpanda console" "http://localhost:8080/admin/health"
probe "ClickHouse play UI" "http://localhost:8123/play"
probe "Jaeger UI" "http://localhost:16686/"

# The play UI being served is not the same as the database answering queries.
ch=$(curl -s --max-time 10 "http://localhost:8123/" --data-binary 'SELECT 1' 2>/dev/null | tr -d '[:space:]')
if [ "$ch" = "1" ]; then
  ok "ClickHouse answers queries over HTTP"
else
  bad "ClickHouse query returned '$ch', expected '1'"
fi

echo
# ─────────────────────────────────────────────────────────────────────────────
echo "══ AC4 · Ports are documented and do not collide ════════════════════════"

PORTS=$(jq_node "
  const seen=new Map(), dupes=[];
  for(const [name,svc] of Object.entries(c.services))
    for(const p of svc.ports||[]){
      const h=String(p.published);
      if(seen.has(h)) dupes.push(h+' ('+seen.get(h)+' and '+name+')'); else seen.set(h,name);
    }
  console.log(JSON.stringify({ports:[...seen.keys()], dupes}));
")
port_list=$(printf '%s' "$PORTS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ports.join(' ')))")
port_dupes=$(printf '%s' "$PORTS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).dupes.join('; ')))")

if [ -z "$port_dupes" ]; then
  ok "no host port is published twice"
else
  bad "host port collision inside the stack: $port_dupes"
fi

DOCS="docs/getting-started.md"
undocumented=""
for p in $port_list; do
  grep -q "$p" "$DOCS" || undocumented="$undocumented $p"
done
if [ -z "$undocumented" ]; then
  ok "all published ports documented in $DOCS ($(echo "$port_list" | wc -w) ports)"
else
  bad "ports missing from $DOCS:$undocumented"
fi

echo
# ─────────────────────────────────────────────────────────────────────────────
echo "══ T2 · Named volumes survive a restart ═════════════════════════════════"

MARK="stack-check-$(date +%s)"

pg() { dc exec -T postgres psql -U sentinel -d sentinel -q -t -A -c "$1" 2>&1; }

pg "CREATE TABLE IF NOT EXISTS stack_check_marker (id SERIAL PRIMARY KEY, token TEXT NOT NULL);" > /dev/null
pg "INSERT INTO stack_check_marker (token) VALUES ('$MARK');" > /dev/null
wrote_pg=$(pg "SELECT token FROM stack_check_marker WHERE token = '$MARK';" | tr -d '[:space:]')

dc exec -T redis valkey-cli SET "stack:check" "$MARK" > /dev/null 2>&1
wrote_redis=$(dc exec -T redis valkey-cli GET "stack:check" 2>/dev/null | tr -d '[:space:]')

if [ "$wrote_pg" = "$MARK" ] && [ "$wrote_redis" = "$MARK" ]; then
  ok "marker written to Postgres and Redis"
else
  bad "could not write marker (postgres='$wrote_pg' redis='$wrote_redis')"
fi

# `down` without -v removes the containers but keeps the named volumes. That is the
# distinction being tested: data must live in the volume, not in a container's
# writable layer. A `restart` would not catch that mistake.
echo "        recreating the stack (down, then up --wait) ..."
dc down > /dev/null 2>&1
if dc up -d --wait > /dev/null 2>&1; then
  ok "stack came back up after a full down/up cycle"
else
  bad "stack did not return to healthy after down/up"
  dc logs --tail=40 2>&1 | sed 's/^/        /'
fi

read_pg=$(pg "SELECT token FROM stack_check_marker WHERE token = '$MARK';" | tr -d '[:space:]')
read_redis=$(dc exec -T redis valkey-cli GET "stack:check" 2>/dev/null | tr -d '[:space:]')

if [ "$read_pg" = "$MARK" ]; then
  ok "Postgres data survived the restart"
else
  bad "Postgres marker lost: got '$read_pg', expected '$MARK'"
fi
if [ "$read_redis" = "$MARK" ]; then
  ok "Redis data survived the restart (appendonly)"
else
  bad "Redis marker lost: got '$read_redis', expected '$MARK'"
fi

# Leave no trace: the marker table is ours, and a stray table would trip the
# schema tenancy lint, which requires a tenant_id on anything not allowlisted.
pg "DROP TABLE IF EXISTS stack_check_marker;" > /dev/null
dc exec -T redis valkey-cli DEL "stack:check" > /dev/null 2>&1
leftover=$(pg "SELECT count(*) FROM information_schema.tables WHERE table_name = 'stack_check_marker';" | tr -d '[:space:]')
if [ "$leftover" = "0" ]; then
  ok "marker cleaned up"
else
  bad "marker table still present after cleanup"
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$COLD" = 1 ]; then
  echo
  echo "══ AC1/AC3 · Cold start to healthy within ${HEALTH_BUDGET_SECONDS}s ═════════════════"

  declared=$(jq_node "console.log(Object.keys(c.volumes||{}).join(' '))")
  echo "        removing volumes: $declared"
  dc down -v > /dev/null 2>&1

  still=""
  for v in $declared; do
    docker volume inspect "sentinel-dev_$v" > /dev/null 2>&1 && still="$still sentinel-dev_$v"
  done
  if [ -z "$still" ]; then
    ok "dev:stack:down -v removed every named volume"
  else
    bad "volumes survived down -v:$still"
  fi

  start=$(date +%s)
  if dc up -d --wait > /dev/null 2>&1; then
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -le "$HEALTH_BUDGET_SECONDS" ]; then
      ok "cold start reached healthy in ${elapsed}s (budget ${HEALTH_BUDGET_SECONDS}s)"
    else
      bad "cold start took ${elapsed}s, over the ${HEALTH_BUDGET_SECONDS}s budget"
    fi
  else
    elapsed=$(( $(date +%s) - start ))
    bad "cold start failed after ${elapsed}s"
    dc logs --tail=40 2>&1 | sed 's/^/        /'
  fi

  for v in $declared; do
    if docker volume inspect "sentinel-dev_$v" > /dev/null 2>&1; then
      ok "volume sentinel-dev_$v recreated"
    else
      bad "volume sentinel-dev_$v missing after up"
    fi
  done

  note "the database is now empty — run: pnpm db:migrate && pnpm db:seed"
fi

echo
echo "═════════════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m%d passed, 0 failed\033[0m\n' "$PASS"
  echo "  Development stack verified."
  exit 0
fi
printf '  \033[31m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
exit 1
