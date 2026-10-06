#!/usr/bin/env node
/**
 * Schema lint: no tenant-scoped table is missing tenant_id. P0-04 test T3.
 *
 * The bug this defends against is not malice. It is a developer adding a table
 * in a hurry, scoping it with a WHERE clause in the repository instead of a
 * column, and being right about every query they wrote. The isolation then holds
 * only for as long as everyone keeps remembering, which is not a guarantee —
 * it is a habit, and habits do not survive an on-call change at 3am.
 *
 * So the rule is inverted: a table is assumed tenant-scoped unless it appears
 * in the allowlist in scripts/tenancy.mjs with a written reason. Adding a table
 * is then a decision someone has to make explicitly, in a diff a reviewer sees.
 *
 *   POSTGRES_URL=... node scripts/validate-schema.mjs
 *
 * Scope note: this checks the tenant_id *column* — presence, type and
 * nullability. Whether each table also has a working RLS policy, and whether
 * the application role can bypass it, is P0-05's check. Keeping them separate
 * keeps each failure message about one thing.
 */
import pg from 'pg';
import { GLOBAL_TABLES } from './tenancy.mjs';
import { classifyTables } from './classify-tables.mjs';

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel';

const TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY c.relname`;

const TENANT_COLS_SQL = `
  SELECT table_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'tenant_id'
   ORDER BY table_name`;

const client = new pg.Client({ connectionString: POSTGRES_URL });
try {
  await client.connect();
} catch (err) {
  console.error(
    `validate-schema: cannot reach Postgres at ${POSTGRES_URL.replace(/:[^:@]*@/, ':***@')}\n` +
      `                 ${err.message}\n` +
      '                 start the stack first:  pnpm dev:stack && pnpm db:migrate',
  );
  process.exit(1);
}

let tables;
let tenantCols;
try {
  tables = (await client.query(TABLES_SQL)).rows.map((r) => r.name);
  tenantCols = new Map(
    (await client.query(TENANT_COLS_SQL)).rows.map((r) => [r.table_name, r]),
  );
} finally {
  await client.end();
}

if (tables.length === 0) {
  console.error(
    'validate-schema: no tables in schema "public". Run migrations first: pnpm db:migrate',
  );
  process.exit(1);
}

const { failures, scoped, globals } = classifyTables(tables, tenantCols, GLOBAL_TABLES);

if (failures.length > 0) {
  console.error(`validate-schema: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(
  `validate-schema: ok — ${scoped.length} tenant-scoped, ${globals.length} global`,
);
for (const t of scoped) console.log(`  tenant-scoped  ${t}`);
for (const t of globals) console.log(`  global         ${t}`);
