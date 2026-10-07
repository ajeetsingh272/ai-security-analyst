/**
 * The one list of tables that are legitimately not tenant-scoped.
 *
 * Shared by the schema lint (scripts/validate-schema.mjs) and the generated
 * data-model document (scripts/data-model-doc.mjs) on purpose. Two copies of
 * this list is how a check ends up weaker than the document that claims it
 * passed: someone adds a table to the doc's allowlist to make the output read
 * nicely, the lint never learns about it, and the next reader trusts a table
 * that nothing is actually enforcing.
 *
 * Membership here is a decision a human makes once, with the reason written
 * down. Anything absent is required to carry a non-null `tenant_id`, so a new
 * table is treated as tenant-scoped until someone argues otherwise. That is the
 * safe default: a global table wrongly flagged costs one line here, while a
 * tenant table wrongly assumed global is a cross-tenant leak.
 */
export const GLOBAL_TABLES = {
  tenants: 'The tenant registry itself. A tenant_id column would be its primary key twice.',
  users:
    'An identity can belong to more than one tenant, so it cannot carry a single tenant_id. Tenant association lives in memberships.',
  msp_links:
    'Relates two tenants, so it holds msp_tenant_id and client_tenant_id instead of one tenant_id — this check only looks for the latter. RLS is still enforced (0003_msp_links_rls.sql): a row is visible to either the MSP tenant or the client tenant named in it, never to anyone else.',
  schema_migrations:
    'The migration runner ledger. Infrastructure, not application data, and deliberately untyped in @sentinel/db.',
  hotfix_rules:
    'P2-12/ADR-0004\'s emergency hotfix rule path: the cap AC1 requires ("maximum 10 active hotfix rules") is a single global count across every tenant combined, not a per-tenant limit, so this table is deliberately not tenant-scoped — the same reasoning tenants/users themselves already use above.',
};
