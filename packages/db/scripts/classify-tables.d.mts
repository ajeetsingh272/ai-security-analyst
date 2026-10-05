/**
 * Type declaration for classify-tables.mjs. Named .d.mts, not .d.ts — that
 * exact extension match is what TypeScript's module resolution requires to
 * associate a declaration file with a .mjs specifier; .d.ts alone silently
 * does not resolve and tsc reports "implicitly has an 'any' type" instead.
 *
 * The implementation stays plain JS on purpose: validate-schema.mjs runs via
 * bare `node`, with no build step, so it can execute in CI before anything
 * else has been compiled. This file exists only so the unit test — which
 * does go through tsc — gets real type checking on the one module boundary
 * that crosses from src/ (the TypeScript project) out to scripts/ (outside
 * `rootDir`, deliberately not part of it).
 */

export interface TenantColumn {
  is_nullable: string;
  udt_name: string;
}

export interface ClassifyResult {
  failures: string[];
  scoped: string[];
  globals: string[];
}

export function classifyTables(
  tables: string[],
  tenantCols: Map<string, TenantColumn>,
  globalTables: Record<string, string>,
): ClassifyResult;
