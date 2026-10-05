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

const failures = [];
const scoped = [];
const globals = [];

for (const table of tables) {
  const col = tenantCols.get(table);
  const allowed = Object.hasOwn(GLOBAL_TABLES, table);

  if (!col) {
    if (allowed) {
      globals.push(table);
    } else {
      failures.push(
        `${table}: no tenant_id column, and it is not in the allowlist.\n` +
          '    Either add a non-null tenant_id, or add it to GLOBAL_TABLES in\n' +
          '    packages/db/scripts/tenancy.mjs with the reason it has no tenant.',
      );
    }
    continue;
  }

  // A table carrying tenant_id while claiming to be global is contradictory, and
  // the contradiction will be resolved by whoever reads it next — possibly wrongly.
  if (allowed) {
    failures.push(
      `${table}: has a tenant_id column but is listed in GLOBAL_TABLES.\n` +
        '    Remove it from the allowlist, or drop the column.',
    );
    continue;
  }

  if (col.is_nullable !== 'NO') {
    failures.push(
      `${table}: tenant_id is nullable.\n` +
        "    A NULL tenant_id matches no policy, so the row is invisible to every\n" +
        '    tenant including its owner — data that exists and cannot be read.',
    );
    continue;
  }

  if (col.udt_name !== 'uuid') {
    failures.push(
      `${table}: tenant_id is ${col.udt_name}, expected uuid.\n` +
        "    The policies cast app.tenant_id to uuid; a different type either fails\n" +
        '    the comparison or silently coerces.',
    );
    continue;
  }

  scoped.push(table);
}

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
