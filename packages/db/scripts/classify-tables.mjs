/**
 * The pure classification logic behind validate-schema.mjs, extracted so it
 * can be unit-tested (P0-05 T4) without a database connection — the script
 * itself still needs one to discover what tables and columns actually exist,
 * but the DECISION ("is this table correctly scoped, correctly global, or
 * wrong") is ordinary data-in data-out logic with nothing Postgres-specific
 * left in it.
 *
 * @param {string[]} tables - every table name in schema "public"
 * @param {Map<string, {is_nullable: string, udt_name: string}>} tenantCols -
 *   table name -> its tenant_id column's metadata, for tables that have one
 * @param {Record<string, string>} globalTables - the GLOBAL_TABLES allowlist
 * @returns {{ failures: string[], scoped: string[], globals: string[] }}
 */
export function classifyTables(tables, tenantCols, globalTables) {
  const failures = [];
  const scoped = [];
  const globals = [];

  for (const table of tables) {
    const col = tenantCols.get(table);
    const allowed = Object.hasOwn(globalTables, table);

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
          '    A NULL tenant_id matches no policy, so the row is invisible to every\n' +
          '    tenant including its owner — data that exists and cannot be read.',
      );
      continue;
    }

    if (col.udt_name !== 'uuid') {
      failures.push(
        `${table}: tenant_id is ${col.udt_name}, expected uuid.\n` +
          '    The policies cast app.tenant_id to uuid; a different type either fails\n' +
          '    the comparison or silently coerces.',
      );
      continue;
    }

    scoped.push(table);
  }

  return { failures, scoped, globals };
}
