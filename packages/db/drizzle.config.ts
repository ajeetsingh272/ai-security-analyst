/**
 * drizzle-kit configuration — for `pull` only.
 *
 * This repository does NOT use drizzle-kit to generate migrations. The SQL
 * under db/postgres/migrations is the source of truth, applied by
 * scripts/migrate.sh with a checksum ledger. That choice is deliberate: the
 * schema's security properties — FORCE ROW LEVEL SECURITY, the per-table
 * isolation policies, the audit-log immutability triggers, the REVOKE that
 * denies UPDATE and DELETE on audit_log — are the controls behind trust
 * guarantees TG5 and TG6. They have to be reviewable as written SQL in a diff,
 * not inferred from a generator's output.
 *
 * So the flow is one-directional: migration SQL -> live database -> `pull` ->
 * src/schema.ts. The generated file gives the TypeScript product plane types
 * that cannot disagree with the database, because they were read out of it.
 *
 * Do not run `drizzle-kit generate` or `drizzle-kit push` against this schema.
 * Both would treat schema.ts as authoritative and silently drop every policy,
 * trigger and grant they do not know how to express.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './src',
  dbCredentials: {
    url:
      process.env.POSTGRES_URL ??
      'postgres://sentinel:sentinel@localhost:5434/sentinel',
  },
  // Introspect the control plane only. schema_migrations is the migration
  // runner's own ledger, not application data, and typing it would invite
  // application code to write to it.
  schemaFilter: ['public'],
  tablesFilter: ['!schema_migrations'],
  verbose: true,
  strict: true,
});
