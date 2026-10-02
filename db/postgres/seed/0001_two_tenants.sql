-- ─────────────────────────────────────────────────────────────────────────────
-- Seed · two tenants with deliberately distinct data
--
-- This exists to make isolation testable. A single-tenant database cannot show
-- that isolation works — every query returns the right answer by accident. Two
-- tenants whose rows are individually identifiable are what turn "the policy is
-- enabled" into "the policy returns tenant A's rows and not tenant B's".
--
-- Northwind Trading is a direct small-business customer. Vanta Managed Security
-- is an MSP that also manages Northwind, so the MSP access path has a subject
-- too. The two differ in plan, connector mix, case severity and case count, so
-- a leak between them is visible rather than plausible.
--
-- Tenant ids start with 5eed ("seed") and deliberately avoid the all-ones and
-- all-twos UUIDs: scripts/verify-setup.sh inserts those as its own throwaway
-- isolation fixtures, and a seeded row holding one of them makes that script's
-- INSERT collide, so the isolation assertion silently has nothing to read.
--
-- Idempotent in the strict sense: fixed UUIDs and ON CONFLICT throughout, and
-- no ON CONFLICT clause touches a timestamp. Timestamps are seeded relative to
-- now() on first insert, which keeps the fixtures looking recent, but re-applying
-- them on conflict would move every row on every run — so a second run leaves the
-- rows byte-identical, which is what scripts/check-migrations.sh asserts.
-- Safe to run before or after a migration.
--
-- Deliberately absent: audit_log rows. Every entry's hash must chain from the
-- one before it (ADR-0007), and the canonical JSON encoding that defines that
-- hash is implemented in P0-06. Writing rows here with hand-made hashes would
-- seed a chain the verifier is supposed to reject. The seed stays silent until
-- there is one writer that computes the hash correctly.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Tenants ─────────────────────────────────────────────────────────────────

INSERT INTO tenants (id, name, plan, shard_count, eps_quota, status) VALUES
  ('5eed0000-0000-4000-8000-00000000000a', 'Northwind Trading',      'small_business', 1, 500,  'active'),
  ('5eed0000-0000-4000-8000-00000000000b', 'Vanta Managed Security', 'msp',            4, 5000, 'active')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, plan = EXCLUDED.plan,
      shard_count = EXCLUDED.shard_count, eps_quota = EXCLUDED.eps_quota,
      status = EXCLUDED.status;

-- ── Users and membership ────────────────────────────────────────────────────
-- Mixed case on purpose: the citext column in 0001 means "Priya@..." and
-- "priya@..." are one identity. Seeding mixed case keeps that honest.

INSERT INTO users (id, email, display_name) VALUES
  ('a1111111-0000-4000-8000-000000000001', 'Priya@northwind.example', 'Priya Raman'),
  ('a1111111-0000-4000-8000-000000000002', 'tom@northwind.example',   'Tom Alvarez'),
  ('a2222222-0000-4000-8000-000000000001', 'lead@vanta.example',      'Sam Okonkwo'),
  ('a2222222-0000-4000-8000-000000000002', 'analyst@vanta.example',   'Jo Whitfield')
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email, display_name = EXCLUDED.display_name;

INSERT INTO memberships (id, tenant_id, user_id, role) VALUES
  ('b1111111-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000a', 'a1111111-0000-4000-8000-000000000001', 'owner'),
  ('b1111111-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-00000000000a', 'a1111111-0000-4000-8000-000000000002', 'read_only'),
  ('b2222222-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000b', 'a2222222-0000-4000-8000-000000000001', 'owner'),
  ('b2222222-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-00000000000b', 'a2222222-0000-4000-8000-000000000002', 'analyst')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- Vanta manages Northwind. Scoped and revocable: the link is the grant, and
-- membership in Vanta alone conveys nothing about Northwind.
INSERT INTO msp_links (id, msp_tenant_id, client_tenant_id) VALUES
  ('c0000000-0000-4000-8000-000000000001',
   '5eed0000-0000-4000-8000-00000000000b',
   '5eed0000-0000-4000-8000-00000000000a')
ON CONFLICT (msp_tenant_id, client_tenant_id) DO NOTHING;

-- ── Connectors and cursors ──────────────────────────────────────────────────
-- Different mixes per tenant, so a connector appearing under the wrong tenant
-- is obvious rather than ambiguous. Credentials stay NULL: envelope encryption
-- needs a KMS-wrapped DEK, and a fake ciphertext teaches the wrong lesson.

INSERT INTO connectors (id, tenant_id, kind, status, last_sync_at) VALUES
  ('d1111111-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000a', 'm365',             'healthy',  now() - interval '4 minutes'),
  ('d2222222-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000b', 'google_workspace', 'healthy',  now() - interval '2 minutes'),
  ('d2222222-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-00000000000b', 'aws',              'degraded', now() - interval '41 minutes')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status;

-- tenant_id here is denormalised but not duplicated truth: the composite FK
-- added in 0002 makes a cursor that disagrees with its connector impossible.
INSERT INTO connector_cursors (connector_id, tenant_id, stream, cursor) VALUES
  ('d1111111-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000a', 'unified_audit', '{"nextPage": "nw-7714"}'),
  ('d2222222-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000b', 'login_audit',   '{"pageToken": "vt-2219"}'),
  ('d2222222-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-00000000000b', 'cloudtrail',    '{"shardIterator": "vt-aws-88"}')
ON CONFLICT (connector_id, stream) DO UPDATE
  SET cursor = EXCLUDED.cursor;

-- ── Cases ───────────────────────────────────────────────────────────────────
-- Northwind gets two, Vanta one. Counts differ so a cross-tenant leak shows up
-- as a wrong row count, not just wrong contents.

INSERT INTO cases (id, tenant_id, severity, score, score_components, title,
                   window_start, window_end, entity_ids, signal_count) VALUES
  ('e1111111-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000a',
   'critical', 91.50,
   '{"impossible_travel": 40, "mfa_fatigue": 31.5, "new_inbox_rule": 20}',
   'Impossible travel then inbox rule created for priya@northwind.example',
   now() - interval '3 hours', now() - interval '2 hours',
   ARRAY['user:priya@northwind.example', 'ip:203.0.113.44'], 7),
  ('e1111111-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-00000000000a',
   'medium', 44.00,
   '{"unusual_download_volume": 44}',
   'Unusual SharePoint download volume for tom@northwind.example',
   now() - interval '9 hours', now() - interval '8 hours',
   ARRAY['user:tom@northwind.example'], 3),
  ('e2222222-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000b',
   'high', 72.25,
   '{"root_api_key_used": 50, "new_region_activity": 22.25}',
   'Root access key used from an unseen region',
   now() - interval '70 minutes', NULL,
   ARRAY['aws:root', 'region:ap-south-1'], 5)
ON CONFLICT (id) DO UPDATE
  SET severity = EXCLUDED.severity, score = EXCLUDED.score,
      score_components = EXCLUDED.score_components, title = EXCLUDED.title,
      signal_count = EXCLUDED.signal_count, entity_ids = EXCLUDED.entity_ids;

-- State is derived from this log, never stored destructively. Each case gets a
-- plausible history, including an AI actor, so the actor_type distinction is
-- exercised by the seed rather than only by tests.
INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
SELECT v.tenant_id, v.case_id, v.from_state, v.to_state, v.actor_type, v.actor_id, v.reason, v.occurred_at
FROM (VALUES
  ('5eed0000-0000-4000-8000-00000000000a'::uuid, 'e1111111-0000-4000-8000-000000000001'::uuid, NULL,            'open',              'system', 'correlator',       'Seven signals collapsed into one case',         now() - interval '2 hours'),
  ('5eed0000-0000-4000-8000-00000000000a'::uuid, 'e1111111-0000-4000-8000-000000000001'::uuid, 'open',          'investigating',     'ai',     'triage-haiku',     'Critical severity: escalated without sampling', now() - interval '119 minutes'),
  ('5eed0000-0000-4000-8000-00000000000a'::uuid, 'e1111111-0000-4000-8000-000000000001'::uuid, 'investigating', 'awaiting_approval', 'ai',     'investigate-opus', 'Containment proposed; every claim grounded',    now() - interval '112 minutes'),
  ('5eed0000-0000-4000-8000-00000000000a'::uuid, 'e1111111-0000-4000-8000-000000000002'::uuid, NULL,            'open',              'system', 'correlator',       'Three signals collapsed into one case',         now() - interval '8 hours'),
  ('5eed0000-0000-4000-8000-00000000000a'::uuid, 'e1111111-0000-4000-8000-000000000002'::uuid, 'open',          'dismissed',         'human',  'a1111111-0000-4000-8000-000000000001', 'Quarter-end export, confirmed with Tom', now() - interval '7 hours'),
  ('5eed0000-0000-4000-8000-00000000000b'::uuid, 'e2222222-0000-4000-8000-000000000001'::uuid, NULL,            'open',              'system', 'correlator',       'Five signals collapsed into one case',          now() - interval '68 minutes'),
  ('5eed0000-0000-4000-8000-00000000000b'::uuid, 'e2222222-0000-4000-8000-000000000001'::uuid, 'open',          'triaging',          'ai',     'triage-haiku',     'Root credential use always escalates',          now() - interval '66 minutes')
) AS v(tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
WHERE NOT EXISTS (
  SELECT 1 FROM case_transitions ct
   WHERE ct.case_id = v.case_id AND ct.to_state = v.to_state
);

-- ── Actions ─────────────────────────────────────────────────────────────────
-- Proposed, not executed. TG2 says the AI never acts without approval, so a
-- seeded 'succeeded' action would contradict the guarantee it is meant to show.

INSERT INTO actions (id, tenant_id, case_id, playbook, target, blast_radius, status) VALUES
  ('f1111111-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000a',
   'e1111111-0000-4000-8000-000000000001', 'revoke_sessions_and_reset',
   '{"user": "priya@northwind.example"}',
   'One identity: all active sessions dropped, password reset required at next sign-in.',
   'proposed'),
  ('f2222222-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-00000000000b',
   'e2222222-0000-4000-8000-000000000001', 'disable_access_key',
   '{"account": "219900110022", "key_id": "AKIAEXAMPLEEXAMPLE"}',
   'One access key: automation using this key fails until a replacement is issued.',
   'proposed')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status, blast_radius = EXCLUDED.blast_radius;

COMMIT;

-- A seed that reports nothing is a seed nobody trusts.
SELECT t.name,
       (SELECT count(*) FROM connectors        c WHERE c.tenant_id = t.id) AS connectors,
       (SELECT count(*) FROM connector_cursors k WHERE k.tenant_id = t.id) AS cursors,
       (SELECT count(*) FROM cases             s WHERE s.tenant_id = t.id) AS cases,
       (SELECT count(*) FROM case_transitions  x WHERE x.tenant_id = t.id) AS transitions,
       (SELECT count(*) FROM actions           a WHERE a.tenant_id = t.id) AS actions
  FROM tenants t
 WHERE t.id IN ('5eed0000-0000-4000-8000-00000000000a',
                '5eed0000-0000-4000-8000-00000000000b')
 ORDER BY t.name;
