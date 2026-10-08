# Data model

<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->
<!-- Regenerate with: pnpm db:docs    Verify with: pnpm db:docs:check -->

This document is produced by introspecting the control-plane database, so it
describes what the schema *is* rather than what a migration intended. The source
of truth is the SQL under `db/postgres/migrations`; this file is a reading of the
result. If the two disagree, the database is right and CI will say so.

Only the control plane lives here. Per-event data is in ClickHouse and is
documented separately — the boundary in ADR-0005 is hard: nothing transactional in
ClickHouse, nothing per-event in Postgres.

## Isolation posture

Tenant isolation is enforced below the application (ADR-0008). Three things have
to hold for every tenant-scoped table, and all three are listed here so that
none of them has to be taken on trust:

1. a non-null `tenant_id`;
2. row-level security both **enabled** and **forced**, because without FORCE
   the table owner silently bypasses every policy;
3. a policy whose expression ties rows to `app.tenant_id`.

| Table | `tenant_id` | RLS | FORCED | Policy |
|---|---|---|---|---|
| `actions` | NOT NULL | yes | yes | `tenant_isolation` |
| `analyst_degraded_queue` | NOT NULL | yes | yes | `tenant_isolation` |
| `approval_nonces` | NOT NULL | yes | yes | `tenant_isolation` |
| `audit_log` | NOT NULL | yes | yes | `tenant_isolation` |
| `baseline_cursors` | NOT NULL | yes | yes | `tenant_isolation` |
| `case_signals` | NOT NULL | yes | yes | `tenant_isolation` |
| `case_transitions` | NOT NULL | yes | yes | `tenant_isolation` |
| `cases` | NOT NULL | yes | yes | `tenant_isolation` |
| `connector_cursors` | NOT NULL | yes | yes | `tenant_isolation` |
| `connectors` | NOT NULL | yes | yes | `tenant_isolation` |
| `entities` | NOT NULL | yes | yes | `tenant_isolation` |
| `entity_aliases` | NOT NULL | yes | yes | `tenant_isolation` |
| `entity_criticality` | NOT NULL | yes | yes | `tenant_isolation` |
| `entity_merges` | NOT NULL | yes | yes | `tenant_isolation` |
| `investigation_transcripts` | NOT NULL | yes | yes | `tenant_isolation` |
| `llm_usage` | NOT NULL | yes | yes | `tenant_isolation` |
| `memberships` | NOT NULL | yes | yes | `tenant_isolation` |
| `notification_deliveries` | NOT NULL | yes | yes | `tenant_isolation` |
| `notification_recipient_optouts` | NOT NULL | yes | yes | `tenant_isolation` |
| `suppressions` | NOT NULL | yes | yes | `tenant_isolation` |
| `tenant_deks` | NOT NULL | yes | yes | `tenant_isolation` |
| `tenant_notification_preferences` | NOT NULL | yes | yes | `tenant_isolation` |
| `tenant_pre_approvals` | NOT NULL | yes | yes | `tenant_isolation` |

### Tables that are not tenant-scoped

Every table above carries a tenant. These do not, and each needs a reason — a
table without a tenant and without a reason is an isolation gap.

| Table | Why it has no `tenant_id` |
|---|---|
| `hotfix_rules` | P2-12/ADR-0004's emergency hotfix rule path: the cap AC1 requires ("maximum 10 active hotfix rules") is a single global count across every tenant combined, not a per-tenant limit, so this table is deliberately not tenant-scoped — the same reasoning tenants/users themselves already use above. |
| `msp_links` | Relates two tenants, so it holds msp_tenant_id and client_tenant_id instead of one tenant_id — this check only looks for the latter. RLS is still enforced (0003_msp_links_rls.sql): a row is visible to either the MSP tenant or the client tenant named in it, never to anyone else. |
| `schema_migrations` | The migration runner ledger. Infrastructure, not application data, and deliberately untyped in @sentinel/db. |
| `tenants` | The tenant registry itself. A tenant_id column would be its primary key twice. |
| `users` | An identity can belong to more than one tenant, so it cannot carry a single tenant_id. Tenant association lives in memberships. |

## Roles

A role that can bypass row-level security defeats it entirely, so this table is
part of the control and not merely a description of it.

| Role | BYPASSRLS | Superuser |
|---|---|---|
| `sentinel` | **yes** | **yes** |
| `sentinel_app` | no | no |
| `sentinel_jobs` | **yes** | no |

## Tables

### `actions`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `playbook` | `text` | no | — |
| `target` | `jsonb` | no | — |
| `blast_radius` | `text` | no | — |
| `status` | `text` | no | `'proposed'::text` |
| `error` | `text` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |
| `executed_at` | `timestamptz` | yes | — |

**Primary key**

- `actions_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `actions_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `actions_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `actions_status_check` — `CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text, 'succeeded'::text, 'failed'::text, 'reversed'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `analyst_degraded_queue`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `reason` | `text` | no | — |
| `queued_at` | `timestamptz` | no | `now()` |
| `processed_at` | `timestamptz` | yes | — |

**Primary key**

- `analyst_degraded_queue_pkey` — `PRIMARY KEY (id)`

**Unique**

- `analyst_degraded_queue_tenant_id_case_id_key` — `UNIQUE (tenant_id, case_id)`

**Foreign keys**

- `analyst_degraded_queue_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `analyst_degraded_queue_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Indexes**

- `idx_analyst_degraded_queue_pending` — `CREATE INDEX idx_analyst_degraded_queue_pending ON public.analyst_degraded_queue USING btree (tenant_id, queued_at) WHERE (processed_at IS NULL)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `approval_nonces`

| Column | Type | Null | Default |
|---|---|---|---|
| `nonce` | `text` | no | — |
| `tenant_id` | `uuid` | no | — |
| `action_id` | `uuid` | no | — |
| `used_at` | `timestamptz` | no | `now()` |

**Primary key**

- `approval_nonces_pkey` — `PRIMARY KEY (nonce)`

**Foreign keys**

- `approval_nonces_action_id_fkey` — `FOREIGN KEY (action_id) REFERENCES actions(id) ON DELETE CASCADE`
- `approval_nonces_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `audit_log`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `bigint` | no | `nextval('audit_log_id_seq'::regclass)` |
| `tenant_id` | `uuid` | no | — |
| `occurred_at` | `timestamptz` | no | `now()` |
| `actor_type` | `text` | no | — |
| `actor_id` | `text` | no | — |
| `action` | `text` | no | — |
| `subject_type` | `text` | no | — |
| `subject_id` | `text` | no | — |
| `payload` | `jsonb` | no | `'{}'::jsonb` |
| `prev_hash` | `bytea` | no | — |
| `entry_hash` | `bytea` | no | — |

**Primary key**

- `audit_log_pkey` — `PRIMARY KEY (id)`

**Checks**

- `audit_log_actor_type_check` — `CHECK ((actor_type = ANY (ARRAY['human'::text, 'ai'::text, 'system'::text, 'connector'::text])))`

**Indexes**

- `audit_tenant_time_idx` — `CREATE INDEX audit_tenant_time_idx ON public.audit_log USING btree (tenant_id, occurred_at DESC)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Triggers**

- `audit_log_no_delete` — `CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`
- `audit_log_no_update` — `CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`

**Grants**

- `sentinel_app`: INSERT, SELECT
- `sentinel_jobs`: SELECT

### `baseline_cursors`

| Column | Type | Null | Default |
|---|---|---|---|
| `tenant_id` | `uuid` | no | — |
| `last_processed_at` | `timestamptz` | no | — |
| `updated_at` | `timestamptz` | no | `now()` |

**Primary key**

- `baseline_cursors_pkey` — `PRIMARY KEY (tenant_id)`

**Foreign keys**

- `baseline_cursors_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `case_signals`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `dedupe_key` | `text` | no | — |
| `signal_id` | `text` | no | — |
| `rule_id` | `text` | no | — |
| `entity_type` | `text` | no | — |
| `entity_id` | `text` | no | — |
| `severity` | `text` | no | — |
| `event_ids` | `text[]` | no | `'{}'::text[]` |
| `detected_at` | `timestamptz` | no | — |
| `created_at` | `timestamptz` | no | `now()` |
| `mitre_ids` | `text[]` | no | `'{}'::text[]` |

**Primary key**

- `case_signals_pkey` — `PRIMARY KEY (id)`

**Unique**

- `case_signals_tenant_id_dedupe_key_key` — `UNIQUE (tenant_id, dedupe_key)`

**Foreign keys**

- `case_signals_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `case_signals_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Indexes**

- `idx_case_signals_case` — `CREATE INDEX idx_case_signals_case ON public.case_signals USING btree (case_id)`
- `idx_case_signals_tenant_entity_detected` — `CREATE INDEX idx_case_signals_tenant_entity_detected ON public.case_signals USING btree (tenant_id, entity_type, entity_id, detected_at DESC)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `case_transitions`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `bigint` | no | `nextval('case_transitions_id_seq'::regclass)` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `from_state` | `text` | yes | — |
| `to_state` | `text` | no | — |
| `actor_type` | `text` | no | — |
| `actor_id` | `text` | no | — |
| `reason` | `text` | no | — |
| `occurred_at` | `timestamptz` | no | `now()` |

**Primary key**

- `case_transitions_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `case_transitions_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `case_transitions_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `case_transitions_actor_type_check` — `CHECK ((actor_type = ANY (ARRAY['human'::text, 'ai'::text, 'system'::text])))`
- `case_transitions_to_state_check` — `CHECK ((to_state = ANY (ARRAY['open'::text, 'triaging'::text, 'investigating'::text, 'awaiting_approval'::text, 'actioned'::text, 'closed'::text, 'dismissed'::text])))`

**Indexes**

- `case_transitions_case_idx` — `CREATE INDEX case_transitions_case_idx ON public.case_transitions USING btree (case_id, id)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `cases`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `severity` | `text` | yes | — |
| `score` | `numeric` | yes | — |
| `score_components` | `jsonb` | yes | — |
| `title` | `text` | yes | — |
| `window_start` | `timestamptz` | no | — |
| `window_end` | `timestamptz` | yes | — |
| `entity_ids` | `text[]` | no | `'{}'::text[]` |
| `signal_count` | `integer` | no | `0` |
| `created_at` | `timestamptz` | no | `now()` |
| `escalated_at` | `timestamptz` | yes | — |
| `escalated_published_at` | `timestamptz` | yes | — |

**Primary key**

- `cases_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `cases_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `cases_severity_check` — `CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text, 'info'::text])))`

**Indexes**

- `cases_entities_idx` — `CREATE INDEX cases_entities_idx ON public.cases USING gin (entity_ids)`
- `cases_tenant_created_idx` — `CREATE INDEX cases_tenant_created_idx ON public.cases USING btree (tenant_id, created_at DESC)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `connector_cursors`

| Column | Type | Null | Default |
|---|---|---|---|
| `connector_id` | `uuid` | no | — |
| `stream` | `text` | no | — |
| `cursor` | `jsonb` | no | — |
| `updated_at` | `timestamptz` | no | `now()` |
| `tenant_id` | `uuid` | no | — |

**Primary key**

- `connector_cursors_pkey` — `PRIMARY KEY (connector_id, stream)`

**Foreign keys**

- `connector_cursors_connector_tenant_fkey` — `FOREIGN KEY (connector_id, tenant_id) REFERENCES connectors(id, tenant_id) ON DELETE CASCADE`

**Indexes**

- `connector_cursors_tenant_idx` — `CREATE INDEX connector_cursors_tenant_idx ON public.connector_cursors USING btree (tenant_id)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `connectors`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `kind` | `text` | no | — |
| `status` | `text` | no | `'pending'::text` |
| `credentials` | `bytea` | yes | — |
| `dek_id` | `text` | yes | — |
| `last_error` | `text` | yes | — |
| `last_sync_at` | `timestamptz` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `connectors_pkey` — `PRIMARY KEY (id)`

**Unique**

- `connectors_id_tenant_key` — `UNIQUE (id, tenant_id)`
- `connectors_tenant_id_kind_key` — `UNIQUE (tenant_id, kind)`

**Foreign keys**

- `connectors_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `connectors_kind_check` — `CHECK ((kind = ANY (ARRAY['m365'::text, 'google_workspace'::text, 'aws'::text, 'azure'::text, 'syslog'::text, 'slack'::text])))`
- `connectors_status_check` — `CHECK ((status = ANY (ARRAY['pending'::text, 'healthy'::text, 'degraded'::text, 'revoked'::text, 'error'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `entities`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `entity_type` | `text` | no | — |
| `status` | `text` | no | `'provisional'::text` |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `entities_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `entities_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `entities_status_check` — `CHECK ((status = ANY (ARRAY['provisional'::text, 'resolved'::text])))`

**Indexes**

- `idx_entities_tenant_type` — `CREATE INDEX idx_entities_tenant_type ON public.entities USING btree (tenant_id, entity_type)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `entity_aliases`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `entity_id` | `uuid` | no | — |
| `alias_type` | `text` | no | — |
| `alias_value` | `text` | no | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `entity_aliases_pkey` — `PRIMARY KEY (id)`

**Unique**

- `entity_aliases_tenant_id_alias_type_alias_value_key` — `UNIQUE (tenant_id, alias_type, alias_value)`

**Foreign keys**

- `entity_aliases_entity_id_fkey` — `FOREIGN KEY (entity_id) REFERENCES entities(id)`
- `entity_aliases_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Indexes**

- `idx_entity_aliases_entity` — `CREATE INDEX idx_entity_aliases_entity ON public.entity_aliases USING btree (entity_id)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `entity_criticality`

| Column | Type | Null | Default |
|---|---|---|---|
| `tenant_id` | `uuid` | no | — |
| `entity_type` | `text` | no | — |
| `entity_id` | `text` | no | — |
| `criticality` | `text` | no | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `entity_criticality_pkey` — `PRIMARY KEY (tenant_id, entity_type, entity_id)`

**Foreign keys**

- `entity_criticality_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `entity_criticality_criticality_check` — `CHECK ((criticality = ANY (ARRAY['normal'::text, 'high'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `entity_merges`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `from_entity_id` | `uuid` | no | — |
| `into_entity_id` | `uuid` | no | — |
| `moved_alias_ids` | `uuid[]` | no | — |
| `reason` | `text` | no | — |
| `actor_type` | `text` | no | — |
| `actor_id` | `text` | no | — |
| `merged_at` | `timestamptz` | no | `now()` |
| `reversed_at` | `timestamptz` | yes | — |
| `reversed_by` | `text` | yes | — |

**Primary key**

- `entity_merges_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `entity_merges_from_entity_id_fkey` — `FOREIGN KEY (from_entity_id) REFERENCES entities(id)`
- `entity_merges_into_entity_id_fkey` — `FOREIGN KEY (into_entity_id) REFERENCES entities(id)`
- `entity_merges_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `entity_merges_actor_type_check` — `CHECK ((actor_type = ANY (ARRAY['human'::text, 'system'::text])))`
- `entity_merges_reason_check` — `CHECK ((length(TRIM(BOTH FROM reason)) > 0))`

**Indexes**

- `idx_entity_merges_tenant` — `CREATE INDEX idx_entity_merges_tenant ON public.entity_merges USING btree (tenant_id)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `hotfix_rules`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `rule_id` | `text` | no | — |
| `rule_title` | `text` | no | — |
| `rule_yaml` | `text` | no | — |
| `reason` | `text` | no | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | `now()` |
| `expires_at` | `timestamptz` | no | `now()` |
| `revoked_at` | `timestamptz` | yes | — |
| `revoked_by` | `uuid` | yes | — |

**Primary key**

- `hotfix_rules_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `hotfix_rules_created_by_fkey` — `FOREIGN KEY (created_by) REFERENCES users(id)`
- `hotfix_rules_revoked_by_fkey` — `FOREIGN KEY (revoked_by) REFERENCES users(id)`

**Checks**

- `hotfix_rules_reason_check` — `CHECK ((length(TRIM(BOTH FROM reason)) > 0))`

**Indexes**

- `idx_hotfix_rules_active` — `CREATE INDEX idx_hotfix_rules_active ON public.hotfix_rules USING btree (expires_at) WHERE (revoked_at IS NULL)`

**Triggers**

- `hotfix_rules_force_expiry_trigger` — `CREATE TRIGGER hotfix_rules_force_expiry_trigger BEFORE INSERT OR UPDATE ON public.hotfix_rules FOR EACH ROW EXECUTE FUNCTION hotfix_rules_force_expiry()`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `investigation_transcripts`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `model` | `text` | no | — |
| `system` | `jsonb` | no | — |
| `messages` | `jsonb` | no | — |
| `final_response` | `jsonb` | no | — |
| `verdict` | `jsonb` | yes | — |
| `recorded_at` | `timestamptz` | no | `now()` |

**Primary key**

- `investigation_transcripts_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `investigation_transcripts_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `investigation_transcripts_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Indexes**

- `idx_investigation_transcripts_case` — `CREATE INDEX idx_investigation_transcripts_case ON public.investigation_transcripts USING btree (tenant_id, case_id, recorded_at DESC)`
- `idx_investigation_transcripts_recorded` — `CREATE INDEX idx_investigation_transcripts_recorded ON public.investigation_transcripts USING btree (recorded_at)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT
- `sentinel_jobs`: SELECT

### `llm_usage`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `case_id` | `uuid` | no | — |
| `model` | `text` | no | — |
| `stage` | `text` | no | — |
| `input_tokens` | `integer` | no | — |
| `output_tokens` | `integer` | no | — |
| `cache_read_tokens` | `integer` | no | `0` |
| `cache_creation_tokens` | `integer` | no | `0` |
| `cost_usd` | `numeric` | no | — |
| `recorded_at` | `timestamptz` | no | `now()` |

**Primary key**

- `llm_usage_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `llm_usage_case_id_fkey` — `FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE`
- `llm_usage_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `llm_usage_stage_check` — `CHECK ((stage = ANY (ARRAY['triage'::text, 'investigation'::text])))`

**Indexes**

- `idx_llm_usage_tenant_recorded` — `CREATE INDEX idx_llm_usage_tenant_recorded ON public.llm_usage USING btree (tenant_id, recorded_at)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT
- `sentinel_jobs`: SELECT

### `memberships`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `user_id` | `uuid` | no | — |
| `role` | `text` | no | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `memberships_pkey` — `PRIMARY KEY (id)`

**Unique**

- `memberships_tenant_id_user_id_key` — `UNIQUE (tenant_id, user_id)`

**Foreign keys**

- `memberships_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`
- `memberships_user_id_fkey` — `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`

**Checks**

- `memberships_role_check` — `CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'analyst'::text, 'read_only'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `msp_links`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `msp_tenant_id` | `uuid` | no | — |
| `client_tenant_id` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | `now()` |
| `revoked_at` | `timestamptz` | yes | — |

**Primary key**

- `msp_links_pkey` — `PRIMARY KEY (id)`

**Unique**

- `msp_links_msp_tenant_id_client_tenant_id_key` — `UNIQUE (msp_tenant_id, client_tenant_id)`

**Foreign keys**

- `msp_links_client_tenant_id_fkey` — `FOREIGN KEY (client_tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`
- `msp_links_msp_tenant_id_fkey` — `FOREIGN KEY (msp_tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `msp_links_check` — `CHECK ((msp_tenant_id <> client_tenant_id))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING ((msp_tenant_id = (current_setting('app.tenant_id'::text, true))::uuid) OR (client_tenant_id = (current_setting('app.tenant_id'::text, true))::uuid))`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `notification_deliveries`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `dedupe_key` | `text` | no | — |
| `channel` | `text` | no | — |
| `attempt` | `integer` | no | `1` |
| `status` | `text` | no | — |
| `content` | `jsonb` | yes | — |
| `error` | `text` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `notification_deliveries_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `notification_deliveries_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `notification_deliveries_channel_check` — `CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'slack'::text, 'email'::text, 'dashboard_banner'::text])))`
- `notification_deliveries_status_check` — `CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])))`

**Indexes**

- `idx_notification_deliveries_dedupe` — `CREATE INDEX idx_notification_deliveries_dedupe ON public.notification_deliveries USING btree (tenant_id, dedupe_key)`
- `idx_notification_deliveries_sent_once` — `CREATE UNIQUE INDEX idx_notification_deliveries_sent_once ON public.notification_deliveries USING btree (tenant_id, dedupe_key, channel) WHERE (status = 'sent'::text)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT

### `notification_recipient_optouts`

| Column | Type | Null | Default |
|---|---|---|---|
| `tenant_id` | `uuid` | no | — |
| `channel` | `text` | no | — |
| `recipient` | `text` | no | — |
| `opted_out_at` | `timestamptz` | no | `now()` |

**Primary key**

- `notification_recipient_optouts_pkey` — `PRIMARY KEY (tenant_id, channel, recipient)`

**Foreign keys**

- `notification_recipient_optouts_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `notification_recipient_optouts_channel_check` — `CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'slack'::text, 'email'::text, 'dashboard_banner'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT

### `schema_migrations`

| Column | Type | Null | Default |
|---|---|---|---|
| `filename` | `text` | no | — |
| `checksum` | `text` | no | — |
| `applied_at` | `timestamptz` | no | `now()` |

**Primary key**

- `schema_migrations_pkey` — `PRIMARY KEY (filename)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `suppressions`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `rule_id` | `text` | no | — |
| `entity_id` | `text` | yes | — |
| `reason` | `text` | no | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | `now()` |
| `expires_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | yes | — |
| `revoked_by` | `uuid` | yes | — |
| `suppressed_count` | `integer` | no | `0` |

**Primary key**

- `suppressions_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `suppressions_created_by_fkey` — `FOREIGN KEY (created_by) REFERENCES users(id)`
- `suppressions_revoked_by_fkey` — `FOREIGN KEY (revoked_by) REFERENCES users(id)`
- `suppressions_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `suppressions_check` — `CHECK ((expires_at > created_at))`
- `suppressions_reason_check` — `CHECK ((length(TRIM(BOTH FROM reason)) > 0))`

**Indexes**

- `idx_suppressions_lookup` — `CREATE INDEX idx_suppressions_lookup ON public.suppressions USING btree (tenant_id, rule_id, entity_id)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `tenant_deks`

| Column | Type | Null | Default |
|---|---|---|---|
| `tenant_id` | `uuid` | no | — |
| `wrapped_dek` | `bytea` | no | — |
| `kms_key_id` | `text` | no | — |
| `created_at` | `timestamptz` | no | `now()` |

**Primary key**

- `tenant_deks_pkey` — `PRIMARY KEY (tenant_id)`

**Foreign keys**

- `tenant_deks_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `tenant_notification_preferences`

| Column | Type | Null | Default |
|---|---|---|---|
| `tenant_id` | `uuid` | no | — |
| `channel_order` | `text[]` | no | `ARRAY['whatsapp'::text, 'slack'::text, 'email'::text, 'dashboard_banner'::text]` |
| `updated_at` | `timestamptz` | no | `now()` |

**Primary key**

- `tenant_notification_preferences_pkey` — `PRIMARY KEY (tenant_id)`

**Foreign keys**

- `tenant_notification_preferences_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT, UPDATE

### `tenant_pre_approvals`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `tenant_id` | `uuid` | no | — |
| `playbook` | `text` | no | — |
| `granted_by` | `uuid` | no | — |
| `granted_at` | `timestamptz` | no | `now()` |
| `revoked_at` | `timestamptz` | yes | — |
| `revoked_by` | `uuid` | yes | — |

**Primary key**

- `tenant_pre_approvals_pkey` — `PRIMARY KEY (id)`

**Foreign keys**

- `tenant_pre_approvals_granted_by_fkey` — `FOREIGN KEY (granted_by) REFERENCES users(id)`
- `tenant_pre_approvals_revoked_by_fkey` — `FOREIGN KEY (revoked_by) REFERENCES users(id)`
- `tenant_pre_approvals_tenant_id_fkey` — `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`

**Checks**

- `tenant_pre_approvals_no_destructive_playbooks` — `CHECK ((playbook <> ALL (ARRAY['disable_user'::text, 'isolate_device'::text, 'force_password_reset'::text])))`
- `tenant_pre_approvals_playbook_check` — `CHECK ((playbook = ANY (ARRAY['disable_user'::text, 'revoke_sessions'::text, 'delete_inbox_rule'::text, 'block_ip'::text, 'force_password_reset'::text, 'isolate_device'::text])))`

**Indexes**

- `idx_tenant_pre_approvals_one_active` — `CREATE UNIQUE INDEX idx_tenant_pre_approvals_one_active ON public.tenant_pre_approvals USING btree (tenant_id, playbook) WHERE (revoked_at IS NULL)`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: INSERT, SELECT, UPDATE

### `tenants`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `name` | `text` | no | — |
| `plan` | `text` | no | — |
| `shard_count` | `smallint` | no | `1` |
| `eps_quota` | `integer` | no | `500` |
| `status` | `text` | no | `'active'::text` |
| `created_at` | `timestamptz` | no | `now()` |
| `updated_at` | `timestamptz` | no | `now()` |

**Primary key**

- `tenants_pkey` — `PRIMARY KEY (id)`

**Checks**

- `tenants_plan_check` — `CHECK ((plan = ANY (ARRAY['msp'::text, 'startup'::text, 'small_business'::text, 'trial'::text])))`
- `tenants_shard_count_check` — `CHECK (((shard_count >= 1) AND (shard_count <= 64)))`
- `tenants_status_check` — `CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'degraded'::text, 'churned'::text])))`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT

### `users`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `email` | `citext` | yes | — |
| `display_name` | `text` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |
| `password_hash` | `text` | yes | — |

**Primary key**

- `users_pkey` — `PRIMARY KEY (id)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
- `sentinel_jobs`: SELECT
