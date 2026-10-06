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
| `approval_nonces` | NOT NULL | yes | yes | `tenant_isolation` |
| `audit_log` | NOT NULL | yes | yes | `tenant_isolation` |
| `case_transitions` | NOT NULL | yes | yes | `tenant_isolation` |
| `cases` | NOT NULL | yes | yes | `tenant_isolation` |
| `connector_cursors` | NOT NULL | yes | yes | `tenant_isolation` |
| `connectors` | NOT NULL | yes | yes | `tenant_isolation` |
| `memberships` | NOT NULL | yes | yes | `tenant_isolation` |
| `tenant_deks` | NOT NULL | yes | yes | `tenant_isolation` |

### Tables that are not tenant-scoped

Every table above carries a tenant. These do not, and each needs a reason — a
table without a tenant and without a reason is an isolation gap.

| Table | Why it has no `tenant_id` |
|---|---|
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

- `connectors_kind_check` — `CHECK ((kind = ANY (ARRAY['m365'::text, 'google_workspace'::text, 'aws'::text, 'azure'::text, 'syslog'::text])))`
- `connectors_status_check` — `CHECK ((status = ANY (ARRAY['pending'::text, 'healthy'::text, 'degraded'::text, 'revoked'::text, 'error'::text])))`

**Row-level security**

- enabled: yes · forced: yes
- policy `tenant_isolation` (permissive, ALL, to public)
  - `USING (tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)`

**Grants**

- `sentinel_app`: DELETE, INSERT, SELECT, UPDATE
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
