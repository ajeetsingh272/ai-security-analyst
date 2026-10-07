-- ─────────────────────────────────────────────────────────────────────────────
-- P2-05: sentinel.events has no column for ocsf.Event.Metadata at all — only
-- the typed actor_user_*/status_id/message fields plus the generic `unmapped`
-- map. go/sentinelconnector/publisher.go's wireEvent already puts Metadata on
-- the Kafka wire (P2-04's fix, so the in-stream worker can read
-- metadata.product/metadata.operation as the event flows through), but
-- nothing persists it — so a windowed rule querying HISTORY in ClickHouse
-- (impossible travel, mass download) has no column to query those same
-- fields against. This is the storage-side half of the exact gap P2-04 closed
-- on the wire side.
--
-- `ADD COLUMN IF NOT EXISTS` because db/clickhouse/*.sql files are replayed
-- on every `pnpm db:migrate` (ClickHouse DDL has no schema_migrations ledger
-- the way Postgres migrations do, per scripts/migrate.sh) — this must be a
-- no-op the second time.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sentinel.events
    ADD COLUMN IF NOT EXISTS metadata Map(String, String) AFTER status_id;
