-- ─────────────────────────────────────────────────────────────────────────────
-- P1-06: closes two gaps 0001_events.sql left as documented intent rather than
-- applied behaviour —
--
--   1. "90-day hot TTL and an S3 cold tier" (AC3) — 0001 shipped a flat
--      365-day DELETE and an explicit comment that hot/cold tiering was
--      deferred to Terraform in P7-05. That deferral turned out to be
--      unnecessary: the dev stack already runs an S3-compatible store
--      (SeaweedFS, P0-03) with a `sentinel-cold` bucket provisioned by
--      s3-init specifically for this. infra/docker/clickhouse-storage.xml
--      points ClickHouse's own storage_configuration at it, so this ALTER
--      is real tiering a developer can observe locally, not a stub.
--
--   2. "Row policies enforce tenant isolation at the storage layer" (AC4) —
--      0001 showed the CREATE ROW POLICY statement as a comment, "shown
--      here as the required shape", never executed. This applies it for
--      real, and extends it to every tenant-scoped table that exists today
--      (signals, entity_baselines, daily_reduction), not only events —
--      the AC says "the storage layer", not "the events table", and
--      leaving the other three unprotected while claiming the guarantee
--      holds would be exactly the kind of half-applied isolation ADR-0008
--      argues against.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Hot/cold tiering ────────────────────────────────────────────────────────
--
-- storage_policy must be set before the TTL clause references VOLUME 'cold'
-- — a TTL naming a volume that isn't part of the table's current policy is
-- rejected at ALTER time, not silently ignored.

ALTER TABLE sentinel.events MODIFY SETTING storage_policy = 'hot_cold';

ALTER TABLE sentinel.events MODIFY TTL
  toDateTime(time) + INTERVAL 90 DAY TO VOLUME 'cold',
  toDateTime(time) + INTERVAL 365 DAY DELETE;

-- ── Row-level tenant isolation ──────────────────────────────────────────────
--
-- SQL_-prefixed custom settings are the one mechanism ClickHouse 24.8
-- accepts for an application-supplied value a row policy can reference
-- (confirmed against the live server — an unprefixed custom setting is
-- rejected outright: "neither a builtin setting nor started with the
-- prefix 'SQL_'"). The query layer sets this per query/connection, the same
-- role Postgres's `SET LOCAL app.tenant_id` plays for RLS (ADR-0008) — two
-- different mechanisms, deliberately, because ClickHouse has no equivalent
-- of SET LOCAL's transaction-scoped revert; each query sets its own value.

CREATE ROLE IF NOT EXISTS sentinel_query;

GRANT SELECT ON sentinel.events TO sentinel_query;
GRANT SELECT ON sentinel.signals TO sentinel_query;
GRANT SELECT ON sentinel.entity_baselines TO sentinel_query;
GRANT SELECT ON sentinel.daily_reduction TO sentinel_query;

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON sentinel.events
  FOR SELECT USING tenant_id = toUUID(getSetting('SQL_app_tenant_id'))
  TO sentinel_query;

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON sentinel.signals
  FOR SELECT USING tenant_id = toUUID(getSetting('SQL_app_tenant_id'))
  TO sentinel_query;

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON sentinel.entity_baselines
  FOR SELECT USING tenant_id = toUUID(getSetting('SQL_app_tenant_id'))
  TO sentinel_query;

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON sentinel.daily_reduction
  FOR SELECT USING tenant_id = toUUID(getSetting('SQL_app_tenant_id'))
  TO sentinel_query;

-- No default password, no network restriction here beyond what the dev
-- stack's own network boundary already provides — matching how sentinel_app
-- (Postgres) has no separate secret either; both are reached only from
-- inside the application network, never exposed to the host beyond the
-- stack's own debug ports.
CREATE USER IF NOT EXISTS sentinel_query_user IDENTIFIED WITH no_password;
GRANT sentinel_query TO sentinel_query_user;
SET DEFAULT ROLE sentinel_query TO sentinel_query_user;
