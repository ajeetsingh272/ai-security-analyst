/**
 * Unit tests for the schema parser — pure, no Go toolchain needed. The
 * Go-dependent checks (generate-go --check, check-compatibility --check,
 * roundtrip-check) are exercised directly as shell commands in CI
 * (ci-go.yml), not duplicated here as vitest assertions, since they are
 * fundamentally "does this external process exit 0" checks rather than
 * something meaningful to assert on in-process.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSchema } from '../../scripts/parse-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function withTempSchema(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'schema-parse-test-'));
  const file = join(dir, 'index.ts');
  writeFileSync(file, source, 'utf8');
  return file;
}

describe('parseSchema', () => {
  it('parses the real src/index.ts into the expected shape', () => {
    const shape = parseSchema(join(__dirname, '..', 'index.ts'));
    expect(shape.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(shape.unions.Severity).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(shape.interfaces.Claim!.fields).toEqual([
      { name: 'text', optional: false, type: { kind: 'string' } },
      { name: 'evidenceRef', optional: false, type: { kind: 'array', of: { kind: 'string' } } },
    ]);
  });

  it('extracts a string-literal union', () => {
    const file = withTempSchema(`
      export const SCHEMA_VERSION = '1.0.0';
      export type Color = 'red' | 'green' | 'blue';
    `);
    const shape = parseSchema(file);
    expect(shape.unions.Color).toEqual(['red', 'green', 'blue']);
    rmSync(file, { force: true });
  });

  it('marks a field optional when it has a question token', () => {
    const file = withTempSchema(`
      export const SCHEMA_VERSION = '1.0.0';
      export interface Thing {
        required: string;
        optional?: string;
      }
    `);
    const shape = parseSchema(file);
    expect(shape.interfaces.Thing!.fields).toEqual([
      { name: 'required', optional: false, type: { kind: 'string' } },
      { name: 'optional', optional: true, type: { kind: 'string' } },
    ]);
    rmSync(file, { force: true });
  });

  it('resolves a reference to another type declared in the same file', () => {
    const file = withTempSchema(`
      export const SCHEMA_VERSION = '1.0.0';
      export interface Inner { value: number; }
      export interface Outer { inner: Inner; items: Inner[]; }
    `);
    const shape = parseSchema(file);
    expect(shape.interfaces.Outer!.fields).toEqual([
      { name: 'inner', optional: false, type: { kind: 'ref', name: 'Inner' } },
      { name: 'items', optional: false, type: { kind: 'array', of: { kind: 'ref', name: 'Inner' } } },
    ]);
    rmSync(file, { force: true });
  });

  it('throws on a type it does not understand, rather than guessing', () => {
    const file = withTempSchema(`
      export const SCHEMA_VERSION = '1.0.0';
      export interface Thing { value: string | number; }
    `);
    // A non-string-literal union field type is exactly the kind of thing
    // this parser refuses rather than silently mishandling — see the
    // module's own doc comment on why the scope stays this narrow.
    expect(() => parseSchema(file)).toThrow(/unsupported type node/);
    rmSync(file, { force: true });
  });

  it('throws if SCHEMA_VERSION is missing', () => {
    const file = withTempSchema(`export interface Thing { value: string; }`);
    expect(() => parseSchema(file)).toThrow(/SCHEMA_VERSION/);
    rmSync(file, { force: true });
  });
});
