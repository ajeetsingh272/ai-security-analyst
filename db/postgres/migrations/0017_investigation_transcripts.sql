-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 · investigation_transcripts
--
-- P4-11: "re-run a past investigation with full prompt, tool-call and
-- response capture, so 'why did it say that' is answerable months
-- later." `messages` alone already carries the full tool-call history —
-- Anthropic's own conversational format interleaves `tool_use` and
-- `tool_result` blocks directly into the message sequence in the order
-- they happened, so a separate tool-call log would just be a second,
-- redundant copy of data `messages` already holds in its natural order.
--
-- `system`/`messages`/`final_response`/`verdict` are stored already
-- redacted (apps/analyst's own TranscriptRecorder runs
-- @sentinel/observability's `redact` before this table is ever
-- touched) — this table is NOT itself a second place secrets could
-- leak from, by construction, not by a column-level policy.
--
-- No separate retention-policy column: AC3's "subject to retention
-- policy" is enforced by `purgeExpiredTranscripts` (packages/db),
-- called on a fixed schedule from apps/analyst's own main.ts, against
-- `recorded_at` directly.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE investigation_transcripts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  system         JSONB NOT NULL,
  messages       JSONB NOT NULL,
  final_response JSONB NOT NULL,
  verdict        JSONB,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_investigation_transcripts_case ON investigation_transcripts (tenant_id, case_id, recorded_at DESC);
-- The retention sweep's own hot-path query.
CREATE INDEX idx_investigation_transcripts_recorded ON investigation_transcripts (recorded_at);

ALTER TABLE investigation_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON investigation_transcripts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON investigation_transcripts TO sentinel_app;
GRANT SELECT ON investigation_transcripts TO sentinel_jobs;

COMMIT;
