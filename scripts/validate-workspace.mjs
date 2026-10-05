#!/usr/bin/env node
/**
 * Lints every workspace manifest. P0-01 test T2.
 *
 * A monorepo degrades one manifest at a time. A package without a `typecheck`
 * script is not type-checked by `turbo run typecheck`, and nothing fails —
 * `turbo` simply has nothing to run, reports success, and the gap is invisible
 * until something breaks in a package nobody was checking. The same is true of
 * `test`. Silence from a task runner is not the same as a pass.
 *
 * So this asserts the shape every package must have for the root commands to
 * mean what they claim. It also checks that each package extends the shared
 * tsconfig rather than duplicating compiler options, which is P0-01 acceptance
 * criterion 4 and the usual way strictness quietly gets relaxed in one corner.
 *
 *   node scripts/validate-workspace.mjs
 *
 * No network, no database, no build. Safe to run first in CI.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scripts that must exist for the root task to cover this package.
 * `build` is deliberately absent: a package that emits nothing has nothing to
 * build, and requiring an empty script would be ceremony rather than a check.
 */
const REQUIRED_SCRIPTS = ['typecheck', 'test', 'test:unit'];

const NAME_PREFIX = '@sentinel/';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Reads the `packages:` globs out of pnpm-workspace.yaml. */
function workspaceGlobs() {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line);
      if (m) {
        globs.push(m[1]);
        continue;
      }
      if (line.trim() !== '') break;
    }
  }
  return globs;
}

/** Expands the single-level `dir/*` form, which is all this repo uses. */
function expand(glob) {
  if (!glob.endsWith('/*')) return existsSync(join(ROOT, glob)) ? [glob] : [];
  const base = glob.slice(0, -2);
  const baseAbs = join(ROOT, base);
  if (!existsSync(baseAbs)) return [];
  return readdirSync(baseAbs)
    .filter((e) => statSync(join(baseAbs, e)).isDirectory())
    .map((e) => `${base}/${e}`)
    .sort();
}

const failures = [];
const checked = [];

for (const glob of workspaceGlobs()) {
  for (const dir of expand(glob)) {
    const manifestPath = join(ROOT, dir, 'package.json');

    // A directory under a workspace glob with no manifest is not a package.
    // tools/progress is exactly this: a script run directly from the root.
    if (!existsSync(manifestPath)) continue;

    const fail = (msg) => failures.push(`${dir}: ${msg}`);
    checked.push(dir);

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      fail(`package.json is not valid JSON — ${err.message}`);
      continue;
    }

    if (typeof pkg.name !== 'string' || pkg.name === '') {
      fail('no "name"');
    } else if (!pkg.name.startsWith(NAME_PREFIX)) {
      fail(`name "${pkg.name}" is not scoped under ${NAME_PREFIX}`);
    }

    if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
      fail(`version ${JSON.stringify(pkg.version)} is not a semver string`);
    }

    // Everything here is internal. A missing `private` is one `pnpm publish`
    // away from putting the control plane's schema on the public registry.
    if (pkg.private !== true) fail('"private": true is missing');

    const scripts = pkg.scripts ?? {};
    for (const name of REQUIRED_SCRIPTS) {
      if (typeof scripts[name] !== 'string' || scripts[name].trim() === '') {
        fail(`no "${name}" script — root \`turbo run ${name}\` silently skips this package`);
      }
    }

    // The shared-tsconfig requirement (P0-01 AC4) only means something for a
    // package that actually compiles TypeScript. A plain-JS package (its
    // own "typecheck" script never invokes tsc — tools/progress is the one
    // example today, checked with `node --check` instead, since there is no
    // TypeScript here to typecheck) has nothing to extend the base config
    // INTO, and requiring a tsconfig.json for it would be a file with
    // nothing real for it to configure.
    const usesTsc = /\btsc\b/.test(scripts.typecheck ?? '');
    if (usesTsc) {
      const tsconfigPath = join(ROOT, dir, 'tsconfig.json');
      if (!existsSync(tsconfigPath)) {
        fail('no tsconfig.json');
      } else {
        const text = readFileSync(tsconfigPath, 'utf8');
        const expected = `${relative(join(ROOT, dir), join(ROOT, 'tsconfig.base.json')).replaceAll('\\', '/')}`;
        if (!text.includes('"extends"')) {
          fail('tsconfig.json does not extend the shared base config');
        } else if (!text.includes(expected)) {
          fail(`tsconfig.json extends something other than ${expected}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`workspace: ${failures.length} problem(s) across ${checked.length} package(s)\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`workspace: ${checked.length} packages ok`);
for (const dir of checked) console.log(`  ${dir}`);
