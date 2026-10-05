#!/usr/bin/env bash
# Proves the local stack is not merely running, but enforcing what the product
# guarantees claim. Each check corresponds to a documented guarantee in
# SECURITY.md, so a passing run is evidence rather than an assertion.
#
#   bash scripts/verify-setup.sh
set -uo pipefail
cd "$(dirname "$0")/.."

: "${CLICKHOUSE_URL:=http://localhost:8123}"
: "${COMPOSE_FILE:=infra/docker/docker-compose.dev.yml}"

PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$1"; }

pg() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U sentinel -d sentinel -q -t -A -c "$1" 2>&1
}
ch() { curl -sS "$CLICKHOUSE_URL" --data-binary "$1" 2>&1; }

echo "══ Services ═════════════════════════════════════════════════════════════"
for svc in postgres clickhouse redpanda redis s3 jaeger; do
  status=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep "^$svc " || true)
  if [ -n "$status" ]; then ok "$status"; else bad "$svc is not running"; fi
done

echo
echo "══ TG5 · Tenant isolation (ADR-0008) ════════════════════════════════════"

# Every tenant-scoped table must have RLS both ENABLED and FORCED. Without
# FORCE, the table owner silently bypasses every policy.
missing=$(pg "
  SELECT string_agg(c.relname, ', ')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);")
if [ -z "$(echo "$missing" | tr -d '[:space:]')" ]; then
  ok "every tenant_id table has RLS enabled AND forced"
else
  bad "tables missing forced RLS: $missing"
fi

# The application role must not be able to bypass RLS.
bypass=$(pg "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'sentinel_app';" | tr -d '[:space:]')
if [ "$bypass" = "f" ]; then ok "sentinel_app cannot bypass RLS"; else bad "sentinel_app has BYPASSRLS (=$bypass)"; fi

# The real test: two tenants, read as one, see only your own.
#
# Clean up by id as well as by name. These two ids belong to this script, and
# anything else already holding one of them — a seed row, a leftover fixture —
# would make the INSERT below fail on the primary key. The isolation query would
# then find nothing and report a leak, which is a confusing way to be told that
# the setup did not happen.
pg "DELETE FROM cases WHERE title LIKE 'verify-%';
    DELETE FROM tenants
     WHERE name LIKE 'verify-%'
        OR id IN ('11111111-1111-1111-1111-111111111111',
                  '22222222-2222-2222-2222-222222222222');" > /dev/null
fixture=$(pg "INSERT INTO tenants (id, name, plan) VALUES
      ('11111111-1111-1111-1111-111111111111', 'verify-a', 'trial'),
      ('22222222-2222-2222-2222-222222222222', 'verify-b', 'trial');
    INSERT INTO cases (tenant_id, title, window_start) VALUES
      ('11111111-1111-1111-1111-111111111111', 'verify-case-a', now()),
      ('22222222-2222-2222-2222-222222222222', 'verify-case-b', now());")

# Assert the premise before testing the conclusion. An isolation test run against
# fixtures that were never created passes or fails for the wrong reason.
planted=$(pg "SELECT count(*) FROM cases WHERE title LIKE 'verify-case-%';" | tr -d '[:space:]')
if [ "$planted" = "2" ]; then
  ok "isolation fixtures planted for two tenants"
else
  bad "could not plant isolation fixtures (found $planted of 2 cases)"
  note "$(printf '%s' "$fixture" | tr '
' ' ')"
fi

# Deliberately omit a tenant_id filter — the classic developer mistake.
seen=$(pg "SET ROLE sentinel_app;
           SET app.tenant_id = '11111111-1111-1111-1111-111111111111';
           SELECT string_agg(title, ',') FROM cases WHERE title LIKE 'verify-%';" | tr -d '[:space:]')
if [ "$seen" = "verify-case-a" ]; then
  ok "unfiltered query as tenant A returned only tenant A's row"
else
  bad "cross-tenant leak or unexpected result: '$seen'"
fi

seen_b=$(pg "SET ROLE sentinel_app;
             SET app.tenant_id = '22222222-2222-2222-2222-222222222222';
             SELECT string_agg(title, ',') FROM cases WHERE title LIKE 'verify-%';" | tr -d '[:space:]')
if [ "$seen_b" = "verify-case-b" ]; then
  ok "same query as tenant B returned only tenant B's row"
else
  bad "cross-tenant leak or unexpected result: '$seen_b'"
fi

echo
echo "══ TG6 · Audit log is tamper-evident (ADR-0007) ═════════════════════════"

# This probe's row is permanent — audit_log forbids DELETE even for its own
# rows (that is the point), and every run of this script adds one more. The
# hash below has to be a REAL one, computed with the same algorithm P0-06's
# AuditLogWriter uses (packages/db/scripts/chain-verifier.mjs), chained off
# whatever this tenant's actual last hash currently is. An earlier version of
# this script inserted a single placeholder byte for each hash — harmless for
# testing UPDATE/DELETE rejection in isolation, but it permanently poisons
# that tenant's chain for scripts/verify-audit-chain.mjs, which has no way to
# know "that one is just a grants probe" from "that one is a real break."
prev_hex=$(pg "SELECT encode(entry_hash, 'hex') FROM audit_log
                WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
                ORDER BY id DESC LIMIT 1;" | tr -d '[:space:]')
[ -z "$prev_hex" ] && prev_hex=$(printf '0%.0s' $(seq 1 64))

hashes=$(cd "$(dirname "$0")/../packages/db/scripts" && node --input-type=module -e "
  import { auditEntryContent, computeEntryHash } from './chain-verifier.mjs';
  const prevHash = Buffer.from('$prev_hex', 'hex');
  const occurredAt = new Date().toISOString();
  const content = auditEntryContent({
    tenantId: '11111111-1111-1111-1111-111111111111',
    occurredAt, actorType: 'system', actorId: 'verify',
    action: 'verify.probe', subjectType: 'test', subjectId: '1', payload: {},
  });
  const entryHash = computeEntryHash(prevHash, content);
  console.log(occurredAt);
  console.log(prevHash.toString('hex'));
  console.log(entryHash.toString('hex'));
")
occurred_at=$(echo "$hashes" | sed -n '1p')
prev_hash_hex=$(echo "$hashes" | sed -n '2p')
entry_hash_hex=$(echo "$hashes" | sed -n '3p')

pg "INSERT INTO audit_log (tenant_id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, payload, prev_hash, entry_hash)
    VALUES ('11111111-1111-1111-1111-111111111111', '$occurred_at', 'system', 'verify', 'verify.probe', 'test', '1', '{}', '\\x$prev_hash_hex', '\\x$entry_hash_hex');" > /dev/null

upd=$(pg "UPDATE audit_log SET action = 'tampered' WHERE actor_id = 'verify';")
if echo "$upd" | grep -qi "append-only"; then
  ok "UPDATE on audit_log is rejected"
else
  bad "UPDATE was not rejected: $upd"
fi

del=$(pg "DELETE FROM audit_log WHERE actor_id = 'verify';")
if echo "$del" | grep -qi "append-only"; then
  ok "DELETE on audit_log is rejected"
else
  bad "DELETE was not rejected: $del"
fi

grants=$(pg "SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
             WHERE grantee = 'sentinel_app' AND table_name = 'audit_log';")
if echo "$grants" | grep -qiE "UPDATE|DELETE"; then
  bad "sentinel_app still holds UPDATE/DELETE on audit_log: $grants"
else
  ok "sentinel_app holds no UPDATE/DELETE grant on audit_log"
fi

echo
echo "══ Event store ══════════════════════════════════════════════════════════"
for t in events signals entity_baselines daily_reduction; do
  r=$(ch "EXISTS TABLE sentinel.$t" | tr -d '[:space:]')
  if [ "$r" = "1" ]; then ok "clickhouse sentinel.$t exists"; else bad "clickhouse sentinel.$t missing ($r)"; fi
done

# ReplacingMergeTree must collapse the duplicates at-least-once ingest produces.
ch "TRUNCATE TABLE IF EXISTS sentinel.events" > /dev/null
ch "INSERT INTO sentinel.events (tenant_id, event_id, time, class_uid)
    VALUES ('11111111-1111-1111-1111-111111111111','dup-1',now(),3002),
           ('11111111-1111-1111-1111-111111111111','dup-1',now(),3002)" > /dev/null
ch "OPTIMIZE TABLE sentinel.events FINAL" > /dev/null
n=$(ch "SELECT count() FROM sentinel.events WHERE event_id = 'dup-1'" | tr -d '[:space:]')
if [ "$n" = "1" ]; then ok "duplicate event_id collapsed by ReplacingMergeTree"; else bad "expected 1 row after merge, got $n"; fi
ch "TRUNCATE TABLE sentinel.events" > /dev/null

# P1-06 T2: the row policy (db/clickhouse/0002_hot_cold_tier_and_row_policy.sql)
# must actually block a cross-tenant read, not just exist. Queried as
# sentinel_query_user — the role the policy is scoped TO — never as the
# default/admin user the rest of this script uses, which would bypass it
# entirely and prove nothing.
ch_as() {
  curl -sS "$CLICKHOUSE_URL/?user=sentinel_query_user&SQL_app_tenant_id=$1" --data-binary "$2" 2>&1
}
ch "INSERT INTO sentinel.events (tenant_id, event_id, time, class_uid) VALUES
    ('11111111-1111-1111-1111-111111111111','rp-a',now(),3002),
    ('22222222-2222-2222-2222-222222222222','rp-b',now(),3002)" > /dev/null
asA=$(ch_as '11111111-1111-1111-1111-111111111111' \
  "SELECT count() FROM sentinel.events WHERE event_id IN ('rp-a','rp-b')" | tr -d '[:space:]')
asB=$(ch_as '22222222-2222-2222-2222-222222222222' \
  "SELECT count() FROM sentinel.events WHERE event_id IN ('rp-a','rp-b')" | tr -d '[:space:]')
if [ "$asA" = "1" ] && [ "$asB" = "1" ]; then
  ok "row policy: each tenant context sees only its own row (1 of 2 each), not the other's"
else
  bad "row policy leak: tenant A saw $asA rows, tenant B saw $asB rows (expected 1 each)"
fi
ch "TRUNCATE TABLE sentinel.events" > /dev/null

# P1-06 T4: TTL moves an aged partition to the cold (S3) tier, and the data
# is still queryable there — proven by actually moving a part and reading it
# back, not by inspecting the TTL clause's text.
oldDate=$(ch "SELECT toDate(now() - INTERVAL 100 DAY)" | tr -d '[:space:]')
partitionId=$(ch "SELECT toYYYYMMDD(toDate('$oldDate'))" | tr -d '[:space:]')
ch "INSERT INTO sentinel.events (tenant_id, event_id, time, class_uid) VALUES
    ('11111111-1111-1111-1111-111111111111','ttl-cold-1','$oldDate 00:00:00',3002)" > /dev/null
ch "ALTER TABLE sentinel.events MOVE PARTITION $partitionId TO VOLUME 'cold'" > /dev/null
diskName=$(ch "SELECT disk_name FROM system.parts
  WHERE table = 'events' AND database = 'sentinel' AND partition_id = '$partitionId' AND active" | tr -d '[:space:]')
stillReadable=$(ch "SELECT count() FROM sentinel.events WHERE event_id = 'ttl-cold-1'" | tr -d '[:space:]')
if [ "$diskName" = "cold" ] && [ "$stillReadable" = "1" ]; then
  ok "TTL cold tier: aged partition moved to the S3-backed 'cold' disk and remains queryable"
else
  bad "TTL cold tier: disk_name=$diskName (want cold), readable=$stillReadable (want 1)"
fi
ch "ALTER TABLE sentinel.events DELETE WHERE event_id = 'ttl-cold-1'" > /dev/null

echo
echo "══ Object storage ═══════════════════════════════════════════════════════"
buckets=$(docker compose -f "$COMPOSE_FILE" logs s3-init 2>/dev/null | grep -oE "sentinel-(archive|cold|reports)" | sort -u | tr '\n' ' ')
if echo "$buckets" | grep -q "sentinel-archive"; then
  ok "buckets created:$(echo " $buckets" | sed 's/ $//')"
else
  bad "expected buckets not found (s3-init logs showed: '$buckets')"
fi

# ── Cleanup ─────────────────────────────────────────────────────────────────
pg "DELETE FROM cases WHERE title LIKE 'verify-%';
    DELETE FROM tenants WHERE name LIKE 'verify-%';" > /dev/null

echo
echo "═════════════════════════════════════════════════════════════════════════"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "  Local environment verified."
