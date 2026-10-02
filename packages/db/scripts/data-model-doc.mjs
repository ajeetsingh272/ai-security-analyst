#!/usr/bin/env node
/**
 * Generates docs/architecture/data-model.md by introspecting the live database.
 *
 * The schema documentation is generated rather than written because a
 * hand-maintained copy drifts, and a drifted isolation document is worse than
 * none at all: it tells a reviewer that a policy exists when it may not. What
 * this file prints is what the database actually reports about itself.
 *
 * It leans on the isolation posture deliberately. For every table it states
 * whether row-level security is enabled, whether it is FORCED, the policy
 * expression, and which grants each role holds. Those four facts together are
 * trust guarantees TG5 and TG6, and they are the first thing a reviewer should
 * be able to check without opening psql.
 *
 *   POSTGRES_URL=... node scripts/data-model-doc.mjs [--check]
 *
 * --check regenerates into memory and exits non-zero if the committed file
 * differs, which is how CI catches a migration that landed without the doc
 * being refreshed.
 *
 * Output is deterministic: every query is explicitly ordered, so an unchanged
 * database produces a byte-identical file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GLOBAL_TABLES } from './tenancy.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const OUT_PATH = join(REPO_ROOT, 'docs', 'architecture', 'data-model.md');

const CHECK_ONLY = process.argv.includes('--check');

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel';


const SQL = {
  tables: `
    SELECT c.relname                AS name,
           c.relrowsecurity         AS rls_enabled,
           c.relforcerowsecurity    AS rls_forced,
           obj_description(c.oid)   AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`,

  columns: `
    SELECT table_name, column_name, data_type, udt_name,
           is_nullable, column_default, ordinal_position
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,

  constraints: `
    SELECT c.relname AS table_name,
           con.conname AS name,
           con.contype AS kind,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY c.relname, con.contype, con.conname`,

  indexes: `
    SELECT tablename AS table_name, indexname AS name, indexdef AS definition
      FROM pg_indexes
     WHERE schemaname = 'public'
     ORDER BY tablename, indexname`,

  policies: `
    SELECT tablename AS table_name, policyname AS name, permissive, roles,
           cmd, qual AS using_expr, with_check AS check_expr
      FROM pg_policies
     WHERE schemaname = 'public'
     ORDER BY tablename, policyname`,

  grants: `
    SELECT table_name, grantee, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND grantee IN ('sentinel_app', 'sentinel_jobs')
     ORDER BY table_name, grantee, privilege_type`,

  roles: `
    SELECT rolname AS name, rolbypassrls AS bypass_rls, rolsuper AS superuser
      FROM pg_roles
     WHERE rolname LIKE 'sentinel%'
     ORDER BY rolname`,

  triggers: `
    SELECT c.relname AS table_name, t.tgname AS name,
           pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`,
};

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
}

/** Column type as a reader of the migration would recognise it. */
function typeOf(col) {
  if (col.data_type === 'ARRAY') return `${col.udt_name.replace(/^_/, '')}[]`;
  if (col.data_type === 'USER-DEFINED') return col.udt_name;
  if (col.data_type === 'timestamp with time zone') return 'timestamptz';
  if (col.data_type === 'character varying') return 'varchar';
  return col.data_type;
}

/**
 * pg_policies.roles is a `name[]`, which node-postgres hands back as the raw
 * Postgres literal `{public}` rather than an array. Normalising here keeps the
 * renderer from caring which it got.
 */
function rolesOf(policy) {
  const r = policy.roles;
  if (Array.isArray(r)) return r;
  if (typeof r === 'string') {
    return r.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  }
  return [];
}

function esc(value) {
  // Pipes would break the markdown table; nothing else in a schema needs it.
  return String(value).replaceAll('|', '\\|');
}

async function collect(client) {
  const data = {};
  for (const [key, sql] of Object.entries(SQL)) {
    data[key] = (await client.query(sql)).rows;
  }
  return data;
}

function render(data) {
  const L = [];
  const columns = groupBy(data.columns, 'table_name');
  const constraints = groupBy(data.constraints, 'table_name');
  const indexes = groupBy(data.indexes, 'table_name');
  const policies = groupBy(data.policies, 'table_name');
  const grants = groupBy(data.grants, 'table_name');
  const triggers = groupBy(data.triggers, 'table_name');

  const tenantScoped = [];
  const global = [];
  for (const t of data.tables) {
    const cols = columns.get(t.name) ?? [];
    const tenantCol = cols.find((c) => c.column_name === 'tenant_id');
    if (tenantCol) tenantScoped.push({ ...t, tenantCol });
    else global.push(t);
  }

  L.push('# Data model');
  L.push('');
  L.push('<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->');
  L.push('<!-- Regenerate with: pnpm db:docs    Verify with: pnpm db:docs:check -->');
  L.push('');
  L.push(
    'This document is produced by introspecting the control-plane database, so it',
  );
  L.push(
    'describes what the schema *is* rather than what a migration intended. The source',
  );
  L.push(
    'of truth is the SQL under `db/postgres/migrations`; this file is a reading of the',
  );
  L.push('result. If the two disagree, the database is right and CI will say so.');
  L.push('');
  L.push('Only the control plane lives here. Per-event data is in ClickHouse and is');
  L.push(
    'documented separately — the boundary in ADR-0005 is hard: nothing transactional in',
  );
  L.push('ClickHouse, nothing per-event in Postgres.');
  L.push('');

  // ── Isolation summary ─────────────────────────────────────────────────────
  L.push('## Isolation posture');
  L.push('');
  L.push(
    'Tenant isolation is enforced below the application (ADR-0008). Three things have',
  );
  L.push('to hold for every tenant-scoped table, and all three are listed here so that');
  L.push('none of them has to be taken on trust:');
  L.push('');
  L.push('1. a non-null `tenant_id`;');
  L.push('2. row-level security both **enabled** and **forced**, because without FORCE');
  L.push('   the table owner silently bypasses every policy;');
  L.push('3. a policy whose expression ties rows to `app.tenant_id`.');
  L.push('');
  L.push('| Table | `tenant_id` | RLS | FORCED | Policy |');
  L.push('|---|---|---|---|---|');
  for (const t of tenantScoped) {
    const pols = policies.get(t.name) ?? [];
    const notNull = t.tenantCol.is_nullable === 'NO';
    L.push(
      `| \`${t.name}\` | ${notNull ? 'NOT NULL' : '**nullable**'} | ${
        t.rls_enabled ? 'yes' : '**no**'
      } | ${t.rls_forced ? 'yes' : '**no**'} | ${
        pols.length > 0 ? pols.map((p) => `\`${p.name}\``).join(', ') : '**none**'
      } |`,
    );
  }
  L.push('');
  L.push('### Tables that are not tenant-scoped');
  L.push('');
  L.push(
    'Every table above carries a tenant. These do not, and each needs a reason — a',
  );
  L.push('table without a tenant and without a reason is an isolation gap.');
  L.push('');
  L.push('| Table | Why it has no `tenant_id` |');
  L.push('|---|---|');
  for (const t of global) {
    const reason = GLOBAL_TABLES[t.name] ?? '**UNREVIEWED — no reason recorded.**';
    L.push(`| \`${t.name}\` | ${esc(reason)} |`);
  }
  L.push('');

  // ── Roles ─────────────────────────────────────────────────────────────────
  L.push('## Roles');
  L.push('');
  L.push(
    'A role that can bypass row-level security defeats it entirely, so this table is',
  );
  L.push('part of the control and not merely a description of it.');
  L.push('');
  L.push('| Role | BYPASSRLS | Superuser |');
  L.push('|---|---|---|');
  for (const r of data.roles) {
    L.push(
      `| \`${r.name}\` | ${r.bypass_rls ? '**yes**' : 'no'} | ${
        r.superuser ? '**yes**' : 'no'
      } |`,
    );
  }
  L.push('');

  // ── Tables ────────────────────────────────────────────────────────────────
  L.push('## Tables');
  for (const t of data.tables) {
    L.push('');
    L.push(`### \`${t.name}\``);
    L.push('');
    if (t.comment) {
      L.push(esc(t.comment));
      L.push('');
    }

    L.push('| Column | Type | Null | Default |');
    L.push('|---|---|---|---|');
    for (const c of columns.get(t.name) ?? []) {
      L.push(
        `| \`${c.column_name}\` | \`${typeOf(c)}\` | ${
          c.is_nullable === 'YES' ? 'yes' : 'no'
        } | ${c.column_default ? `\`${esc(c.column_default)}\`` : '—'} |`,
      );
    }

    const cons = constraints.get(t.name) ?? [];
    const byKind = (k) => cons.filter((c) => c.kind === k);
    const sections = [
      ['Primary key', byKind('p')],
      ['Unique', byKind('u')],
      ['Foreign keys', byKind('f')],
      ['Checks', byKind('c')],
    ];
    for (const [label, rows] of sections) {
      if (rows.length === 0) continue;
      L.push('');
      L.push(`**${label}**`);
      L.push('');
      for (const r of rows) L.push(`- \`${r.name}\` — \`${esc(r.definition)}\``);
    }

    const idx = (indexes.get(t.name) ?? []).filter(
      (i) => !cons.some((c) => c.name === i.name),
    );
    if (idx.length > 0) {
      L.push('');
      L.push('**Indexes**');
      L.push('');
      for (const i of idx) L.push(`- \`${i.name}\` — \`${esc(i.definition)}\``);
    }

    const pols = policies.get(t.name) ?? [];
    if (pols.length > 0) {
      L.push('');
      L.push('**Row-level security**');
      L.push('');
      L.push(
        `- enabled: ${t.rls_enabled ? 'yes' : 'no'} · forced: ${
          t.rls_forced ? 'yes' : 'no'
        }`,
      );
      for (const p of pols) {
        L.push(
          `- policy \`${p.name}\` (${p.permissive.toLowerCase()}, ${p.cmd}, to ${rolesOf(
            p,
          ).join(', ')})`,
        );
        if (p.using_expr) L.push(`  - \`USING ${esc(p.using_expr)}\``);
        if (p.check_expr) L.push(`  - \`WITH CHECK ${esc(p.check_expr)}\``);
      }
    }

    const trg = triggers.get(t.name) ?? [];
    if (trg.length > 0) {
      L.push('');
      L.push('**Triggers**');
      L.push('');
      for (const g of trg) L.push(`- \`${g.name}\` — \`${esc(g.definition)}\``);
    }

    const gr = grants.get(t.name) ?? [];
    if (gr.length > 0) {
      L.push('');
      L.push('**Grants**');
      L.push('');
      for (const [grantee, rows] of groupBy(gr, 'grantee')) {
        const privs = rows.map((r) => r.privilege_type).sort().join(', ');
        L.push(`- \`${grantee}\`: ${privs}`);
      }
    }
  }

  L.push('');
  return L.join('\n');
}

const client = new pg.Client({ connectionString: POSTGRES_URL });
try {
  await client.connect();
} catch (err) {
  console.error(
    `data-model-doc: cannot reach Postgres at ${POSTGRES_URL.replace(/:[^:@]*@/, ':***@')}\n` +
      `                ${err.message}\n` +
      '                start the stack first:  pnpm dev:stack && pnpm db:migrate',
  );
  process.exit(1);
}

let generated;
try {
  generated = render(await collect(client));
} finally {
  await client.end();
}

if (CHECK_ONLY) {
  if (!existsSync(OUT_PATH)) {
    console.error(
      'data-model-doc: docs/architecture/data-model.md does not exist. Run: pnpm db:docs',
    );
    process.exit(1);
  }
  const committed = readFileSync(OUT_PATH, 'utf8');
  if (committed !== generated) {
    console.error(
      'data-model-doc: docs/architecture/data-model.md is out of date.\n' +
        '                The schema changed without the documentation being regenerated.\n' +
        '                Run: pnpm db:docs    then commit the result.',
    );
    process.exit(1);
  }
  console.log('data-model-doc: up to date');
  process.exit(0);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, generated, 'utf8');
console.log(`data-model-doc: wrote ${OUT_PATH}`);
