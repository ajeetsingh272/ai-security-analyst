-- ─────────────────────────────────────────────────────────────────────────────
-- ClickHouse event store. Implements ADR-0005.
--
-- Sizing target: 500M events/day, 90 days hot (~4.5 TB compressed), 12 months
-- cold in object storage. A 30-day single-identity lookup must return in under
-- one second at a billion rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS sentinel;

-- ── Normalised events (OCSF) ────────────────────────────────────────────────
--
-- ReplacingMergeTree keyed on (tenant_id, event_id) collapses the duplicates
-- that at-least-once ingest necessarily produces. Exactly-once across a vendor
-- API boundary is not achievable, so duplicates are made harmless instead.
--
-- ORDER BY puts tenant_id first because EVERY query is tenant-scoped — the
-- primary index is useless if the tenant is not the leading column.

CREATE TABLE IF NOT EXISTS sentinel.events
(
    tenant_id       UUID,
    event_id        String,
    time            DateTime64(3, 'UTC'),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),

    -- OCSF classification
    class_uid       UInt32,
    category_uid    UInt16,
    activity_id     UInt16,
    type_uid        UInt32,
    severity_id     UInt8,

    -- Actor / identity
    actor_user_uid  String,
    actor_user_name String,
    actor_user_email String,

    -- Source
    src_ip          IPv6,
    src_country     LowCardinality(String),
    src_city        String,
    src_asn         UInt32,
    src_is_anon     UInt8 DEFAULT 0,

    -- Device / session
    device_uid      String,
    device_name     String,
    user_agent      String,
    session_uid     String,

    -- Target
    target_type     LowCardinality(String),
    target_uid      String,
    target_name     String,

    -- Provenance
    product         LowCardinality(String),
    vendor          LowCardinality(String),
    schema_version  LowCardinality(String),

    status_id       UInt8,
    message         String,

    -- Vendor fields with no OCSF home. Preserved rather than discarded, so a
    -- future rule can use them without a re-ingest.
    unmapped        Map(String, String),

    raw_ref         String,
    trace_id        String,

    INDEX idx_actor actor_user_uid TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_srcip src_ip TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_target target_uid TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_event_id event_id TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(time)
ORDER BY (tenant_id, time, event_id)
TTL toDateTime(time) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(time) + INTERVAL 365 DAY DELETE
SETTINGS
    storage_policy = 'hot_cold',
    index_granularity = 8192,
    -- Batched inserts only; async mode protects against merge pressure when a
    -- consumer misbehaves and sends small batches.
    async_insert = 1,
    wait_for_async_insert = 1;

-- idx_event_id exists specifically for the grounding validator (ADR-0006),
-- which resolves claims by event_id. That lookup is on the critical path of
-- every AI report, so it gets its own low-false-positive bloom filter.

-- ── Signals ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sentinel.signals
(
    tenant_id       UUID,
    signal_id       String,
    time            DateTime64(3, 'UTC'),
    rule_id         LowCardinality(String),
    rule_version    LowCardinality(String),
    severity        LowCardinality(String),
    mitre_technique LowCardinality(String),
    entity_type     LowCardinality(String),
    entity_id       String,
    -- Every signal references the event(s) that produced it. This is what makes
    -- a case's evidence chain resolvable all the way back to a raw record.
    event_ids       Array(String),
    case_id         String,
    dismissed       UInt8 DEFAULT 0,
    dismiss_reason  String,
    suppressed_by   String,

    INDEX idx_entity entity_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_case case_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (tenant_id, time, signal_id)
TTL toDateTime(time) + INTERVAL 180 DAY DELETE;

-- ── Entity baselines ────────────────────────────────────────────────────────
--
-- AggregatingMergeTree so baselines update incrementally rather than by a full
-- rescan. `observations` exists so a brand-new employee is reported as
-- insufficient-data rather than being flagged anomalous purely for being new.

CREATE TABLE IF NOT EXISTS sentinel.entity_baselines
(
    tenant_id       UUID,
    entity_id       String,
    metric          LowCardinality(String),
    bucket          Date,
    observations    AggregateFunction(count, UInt64),
    distinct_values AggregateFunction(uniq, String),
    value_counts    AggregateFunction(topK(10), String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, entity_id, metric, bucket)
TTL bucket + INTERVAL 90 DAY DELETE;

-- ── Daily reduction-ratio SLO ───────────────────────────────────────────────
--
-- The 10:1 signal-to-case reduction is a business-critical SLO, not an
-- aspiration: if it degrades, the unit economics break before the architecture
-- does. Materialising it makes it alertable.

CREATE TABLE IF NOT EXISTS sentinel.daily_reduction
(
    tenant_id       UUID,
    day             Date,
    signals         UInt64,
    cases_escalated UInt64,
    ratio           Float32
)
ENGINE = SummingMergeTree
ORDER BY (tenant_id, day);

-- ── Tenant isolation at the storage layer ───────────────────────────────────
-- Defence in depth alongside application-level scoping (ADR-0008). Applied by
-- the provisioner per query user; shown here as the required shape.
--
--   CREATE ROW POLICY tenant_isolation ON sentinel.events
--     FOR SELECT USING tenant_id = toUUID(getSetting('SQL_app_tenant_id'))
--     TO sentinel_query;
