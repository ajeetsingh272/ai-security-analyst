/**
 * P0-05 T4: adding a new tenant-scoped table without a policy fails the CI
 * schema check.
 *
 * During P0-04 this was verified by hand — creating a real `lint_probe`
 * table in the dev database, running the script, reading the failure, then
 * dropping the table. That proved the check worked once, for one person, on
 * one machine. This is the same assertion as a fast, no-database unit test
 * against the pure classification logic (packages/db/scripts/classify-tables.mjs),
 * so it runs on every CI invocation rather than whenever someone remembers to
 * repeat a manual step.
 */
import { describe, expect, it } from 'vitest';
import { classifyTables } from '../../scripts/classify-tables.mjs';

const GLOBAL = { tenants: 'the registry itself', users: 'spans tenants via memberships' };

function col(overrides: Partial<{ is_nullable: string; udt_name: string }> = {}) {
  return { is_nullable: 'NO', udt_name: 'uuid', ...overrides };
}

describe('classifyTables', () => {
  it('a correctly tenant-scoped table passes', () => {
    const { failures, scoped } = classifyTables(
      ['cases'],
      new Map([['cases', col()]]),
      GLOBAL,
    );
    expect(failures).toEqual([]);
    expect(scoped).toEqual(['cases']);
  });

  it('a correctly allowlisted global table passes', () => {
    const { failures, globals } = classifyTables(['tenants'], new Map(), GLOBAL);
    expect(failures).toEqual([]);
    expect(globals).toEqual(['tenants']);
  });

  it('T4: a new table with no tenant_id and no allowlist entry fails, by name', () => {
    const { failures, scoped, globals } = classifyTables(
      ['connectors', 'webhooks_untenanted'],
      new Map([['connectors', col()]]),
      GLOBAL,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('webhooks_untenanted');
    expect(failures[0]).toContain('not in the allowlist');
    expect(scoped).toEqual(['connectors']);
    expect(globals).toEqual([]);
  });

  it('a table with both tenant_id AND an allowlist entry fails as contradictory', () => {
    const { failures } = classifyTables(
      ['tenants'],
      new Map([['tenants', col()]]),
      GLOBAL,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('has a tenant_id column but is listed in GLOBAL_TABLES');
  });

  it('a nullable tenant_id fails, even though the column exists', () => {
    const { failures } = classifyTables(
      ['leaky'],
      new Map([['leaky', col({ is_nullable: 'YES' })]]),
      GLOBAL,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('nullable');
  });

  it('a non-uuid tenant_id fails, even though it is non-null', () => {
    const { failures } = classifyTables(
      ['legacy'],
      new Map([['legacy', col({ udt_name: 'text' })]]),
      GLOBAL,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('expected uuid');
  });

  it('reports every failure in a mixed set, not just the first', () => {
    const { failures } = classifyTables(
      ['ok', 'bad_untenanted', 'bad_nullable'],
      new Map([
        ['ok', col()],
        ['bad_nullable', col({ is_nullable: 'YES' })],
      ]),
      GLOBAL,
    );
    expect(failures).toHaveLength(2);
  });
});
