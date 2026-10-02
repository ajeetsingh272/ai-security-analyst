/**
 * Makes `drizzle-kit pull` output usable, mechanically.
 *
 * Three things have to happen after every pull, and all three have to happen
 * the same way every time or the "schema is generated, not hand-maintained"
 * property is a fiction:
 *
 *   1. Replace the `unknown("col")` placeholders drizzle-kit emits for database
 *      types it cannot parse with the real types from src/types.ts.
 *   2. Delete the migration snapshot pull leaves behind. db/postgres/migrations
 *      is the only migration source in this repository; a second one sitting in
 *      a package is an invitation to apply it.
 *   3. Fail loudly if anything is still unresolved, because `drizzle-kit pull`
 *      exits 0 even when it has errored, so its exit code cannot be trusted as
 *      a gate.
 *
 * Run via `pnpm --filter @sentinel/db pull`, never on its own.
 */
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(pkgRoot, 'src');
const schemaPath = join(srcDir, 'schema.ts');

/** Database type -> the helper exported from src/types.ts that represents it. */
const CUSTOM_TYPES = {
  bytea: 'bytea',
  citext: 'citext',
};

const BANNER = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by \`pnpm --filter @sentinel/db pull\`, which introspects the live
// database and then runs scripts/postprocess.mjs over the result.
//
// The source of truth for this schema is the SQL under db/postgres/migrations.
// To change the schema, write a migration, apply it, and re-run the pull. Edits
// made here are silently discarded on the next pull, and they cannot change the
// database — which means an edit here that looks correct is strictly worse than
// no edit at all.
`;

if (!existsSync(schemaPath)) {
  console.error(
    'postprocess: src/schema.ts does not exist.\n' +
      '             drizzle-kit pull did not produce a schema — it exits 0 even\n' +
      '             when it fails, so check its output above for the real error.',
  );
  process.exit(1);
}

let schema = readFileSync(schemaPath, 'utf8');

// ── 1. Resolve the placeholders ─────────────────────────────────────────────
// drizzle-kit emits, on two lines:
//     // TODO: failed to parse database type 'bytea'
//     prevHash: unknown("prev_hash").notNull(),
const placeholder =
  /^([ \t]*)\/\/ TODO: failed to parse database type '([^']+)'\n[ \t]*([A-Za-z0-9_]+): unknown\(/gm;

const used = new Set();
const unmapped = new Set();

schema = schema.replace(placeholder, (match, indent, dbType, prop) => {
  const helper = CUSTOM_TYPES[dbType];
  if (!helper) {
    unmapped.add(dbType);
    return match;
  }
  used.add(helper);
  return `${indent}${prop}: ${helper}(`;
});

if (unmapped.size > 0) {
  console.error(
    `postprocess: no mapping for database type(s): ${[...unmapped].join(', ')}\n` +
      '             Add a customType for each in src/types.ts and register it in\n' +
      '             CUSTOM_TYPES in this script. Guessing a close-enough type is\n' +
      '             how a column silently changes meaning.',
  );
  process.exit(1);
}

// ── 2. Import what we used, and stamp the banner ────────────────────────────
if (used.size > 0) {
  const names = [...used].sort().join(', ');
  const importLine = `import { ${names} } from "./types";`;
  if (!schema.includes(importLine)) {
    // Place it after the last existing import so the file still reads top-down.
    const imports = [...schema.matchAll(/^import .*$/gm)];
    const last = imports.at(-1);
    if (!last) {
      console.error('postprocess: generated schema has no import statements.');
      process.exit(1);
    }
    const at = last.index + last[0].length;
    schema = `${schema.slice(0, at)}\n${importLine}${schema.slice(at)}`;
  }
}

if (!schema.startsWith('//')) schema = `${BANNER}\n${schema}`;

writeFileSync(schemaPath, schema, 'utf8');

// ── 3. Remove the competing migration snapshot ──────────────────────────────
const removed = [];
for (const entry of readdirSync(srcDir)) {
  if (entry.endsWith('.sql') || entry === 'meta') {
    rmSync(join(srcDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
}

// ── 4. Gate ─────────────────────────────────────────────────────────────────
const leftover = [];
if (/\bunknown\(/.test(schema)) leftover.push('an unresolved unknown() column');
if (/TODO: failed to parse/.test(schema)) leftover.push('a failed-to-parse TODO');
if (leftover.length > 0) {
  console.error(`postprocess: schema.ts still contains ${leftover.join(' and ')}.`);
  process.exit(1);
}

const mapped = used.size > 0 ? [...used].sort().join(', ') : 'none needed';
console.log(`postprocess: custom types applied -> ${mapped}`);
console.log(
  `postprocess: snapshot removed -> ${removed.length > 0 ? removed.join(', ') : 'nothing to remove'}`,
);
console.log('postprocess: ok');
