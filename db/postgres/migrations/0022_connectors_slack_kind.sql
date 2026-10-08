-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 · connectors_kind allows 'slack'
--
-- P5-07: `connectors`' own kind CHECK (0001_foundation.sql) only ever
-- listed data-INGESTION sources (m365, google_workspace, aws, azure,
-- syslog) — no notification/alerting channel integration existed when
-- that list was written. Reusing `connectors` + TenantCredentialVault
-- for Slack's own OAuth-installed bot token is otherwise exactly the
-- right fit (per-tenant, encrypted, revocable credentials is the same
-- shape either way) — the only thing actually wrong was this
-- constraint never having anticipated a non-ingestion connector kind,
-- not a reason to build a second, parallel encrypted-credentials
-- table for the same purpose.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE connectors DROP CONSTRAINT connectors_kind_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check
  CHECK (kind IN ('m365', 'google_workspace', 'aws', 'azure', 'syslog', 'slack'));

COMMIT;
