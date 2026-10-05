#!/usr/bin/env node
/**
 * Enforces the compatibility policy in src/index.ts's own doc comment
 * (P0-11 AC4, T3): a MAJOR-shaped change to the schema without a MAJOR
 * version bump fails CI.
 *
 *   node scripts/check-compatibility.mjs            update the baseline (dev-run; commit the result)
 *   node scripts/check-compatibility.mjs --check     never writes; what CI runs
 *
 * Compares the CURRENT parse of src/index.ts against schema.snapshot.json
 * — the committed shape — and classifies the diff:
 *
 *   none     — identical shape.
 *   additive — only new optional fields, new interfaces, or new union
 *              values. Safe for a MINOR or PATCH bump.
 *   breaking — a field removed/renamed, a type changed, a union value
 *              removed, or a field that was optional became required.
 *              Requires a MAJOR bump.
 *
 * `--check` never writes the snapshot, on purpose — mirrors
 * packages/db/scripts/data-model-doc.mjs's own --check. A CI step that
 * silently rewrote the baseline on every green run would make the
 * COMMITTED file stop being the thing actually enforced: the next PR's CI
 * would start from whatever an earlier CI run happened to write, not from
 * what a human reviewed and committed. So `--check` fails on ANY drift —
 * even a purely additive one — with the fix being "run this without
 * --check and commit schema.snapshot.json", the same two-step shape as
 * `db:docs`/`db:docs:check`.
 *
 * On first run with no snapshot committed at all, writing one (in non-check
 * mode) is not a failure — there is nothing to compare against yet.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchema } from './parse-schema.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(PKG_ROOT, 'src', 'index.ts');
const SNAPSHOT_PATH = join(PKG_ROOT, 'schema.snapshot.json');
const CHECK = process.argv.includes('--check');

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`check-compatibility: "${v}" is not a semver MAJOR.MINOR.PATCH string.`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Every breaking difference between two schema shapes, as human-readable
 * strings. Empty means the diff is additive-or-identical — safe. */
function findBreakingChanges(before, after) {
  const breaks = [];

  for (const [name, values] of Object.entries(before.unions)) {
    const nowValues = after.unions[name];
    if (!nowValues) {
      breaks.push(`union "${name}" was removed`);
      continue;
    }
    for (const v of values) {
      if (!nowValues.includes(v)) breaks.push(`union "${name}" lost the value "${v}"`);
    }
  }

  for (const [name, iface] of Object.entries(before.interfaces)) {
    const nowIface = after.interfaces[name];
    if (!nowIface) {
      breaks.push(`interface "${name}" was removed`);
      continue;
    }
    const nowFields = new Map(nowIface.fields.map((f) => [f.name, f]));
    for (const field of iface.fields) {
      const nowField = nowFields.get(field.name);
      if (!nowField) {
        breaks.push(`"${name}.${field.name}" was removed`);
        continue;
      }
      if (JSON.stringify(nowField.type) !== JSON.stringify(field.type)) {
        breaks.push(
          `"${name}.${field.name}" changed type (${JSON.stringify(field.type)} -> ${JSON.stringify(nowField.type)})`,
        );
      }
      // A required field becoming optional is additive (existing callers
      // that always set it still work); only the reverse is breaking.
      if (field.optional && !nowField.optional) {
        breaks.push(`"${name}.${field.name}" changed from optional to required`);
      }
    }
  }

  return breaks;
}

const current = parseSchema(SOURCE);

if (!existsSync(SNAPSHOT_PATH)) {
  if (CHECK) {
    console.error(`check-compatibility --check: no baseline at ${SNAPSHOT_PATH}. Run without --check first.`);
    process.exit(1);
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`check-compatibility: no baseline existed; wrote ${SNAPSHOT_PATH} at version ${current.version}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
const breaking = findBreakingChanges(baseline, current);
const before = parseVersion(baseline.version);
const after = parseVersion(current.version);
const majorBumped = after.major > before.major;

// This is T3, and it applies identically in both modes: a breaking change
// without a major bump is wrong regardless of who runs the check.
if (breaking.length > 0 && !majorBumped) {
  console.error(
    `check-compatibility: ${breaking.length} breaking change(s) without a MAJOR version bump ` +
      `(${baseline.version} -> ${current.version}):\n`,
  );
  for (const b of breaking) console.error(`  - ${b}`);
  console.error(
    "\n  Either revert the breaking change, or bump SCHEMA_VERSION's MAJOR " +
      'component in packages/schema/src/index.ts.',
  );
  process.exit(1);
}

const upToDate = JSON.stringify(current) === JSON.stringify(baseline);

if (CHECK) {
  if (!upToDate) {
    console.error(
      'check-compatibility --check: schema.snapshot.json is stale.\n' +
        '  src/index.ts changed without updating the baseline. Run: ' +
        'node scripts/check-compatibility.mjs   then commit schema.snapshot.json.',
    );
    process.exit(1);
  }
  console.log('check-compatibility --check: up to date, no unresolved breaking changes.');
  process.exit(0);
}

if (upToDate) {
  console.log('check-compatibility: no shape change. ok');
  process.exit(0);
}

writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
console.log(
  breaking.length > 0
    ? `check-compatibility: ${breaking.length} breaking change(s), correctly accompanied by a MAJOR bump ` +
        `(${baseline.version} -> ${current.version}). Baseline updated — commit schema.snapshot.json.`
    : `check-compatibility: additive or non-breaking change (${baseline.version} -> ${current.version}). ` +
        'Baseline updated — commit schema.snapshot.json.',
);
