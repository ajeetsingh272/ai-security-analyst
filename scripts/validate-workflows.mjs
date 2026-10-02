#!/usr/bin/env node
/**
 * Tests the CI path filters. P0-02 AC3 and T3.
 *
 * The acceptance criterion is "a docs-only change does not run the Go test
 * matrix". Proving that with a real pull request costs a push, a CI round trip
 * and a human reading the result, and it only tests the one case somebody
 * remembered to try. The filters are data, so they can be tested as data.
 *
 * This parses every CI workflow, extracts the dorny/paths-filter globs, and
 * evaluates representative change sets against them. It asserts both directions,
 * which matters more than it sounds: a filter that matches nothing would pass a
 * "docs-only does not trigger Go" check while silently disabling CI entirely.
 * That is not hypothetical — before this existed, a change under db/ matched no
 * filter at all, so adding a migration ran no jobs.
 *
 * It also enforces the two structural rules that are easy to get wrong when
 * workflows are split across files:
 *   - every job has a timeout (P0-02 AC4), so a hang fails in minutes;
 *   - every workflow has its own concurrency group, because a shared group makes
 *     each push cancel its sibling workflows and look like a flaky pipeline.
 *
 *   node scripts/validate-workflows.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');

// js-yaml is present transitively; resolving it explicitly keeps this script free
// of a direct dependency for a check that must run before `pnpm install` matters.
const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  yaml = require(
    join(ROOT, 'node_modules/.pnpm/js-yaml@4.3.2/node_modules/js-yaml/index.js'),
  );
}

/** Minimal glob matcher for the subset dorny/paths-filter uses here. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `a/**` matches a/ and everything beneath it.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\/'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function loadWorkflows() {
  const out = [];
  for (const file of readdirSync(WORKFLOW_DIR).sort()) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    out.push({
      file,
      doc: yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf8')),
    });
  }
  return out;
}

/** Pulls `{ filterName: [globs] }` out of a workflow's paths-filter step. */
function filtersOf(doc) {
  const found = {};
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!String(step.uses ?? '').startsWith('dorny/paths-filter')) continue;
      const parsed = yaml.load(step.with.filters);
      for (const [name, globs] of Object.entries(parsed)) {
        found[name] = globs.filter((g) => typeof g === 'string');
      }
    }
  }
  return found;
}

function matches(globs, path) {
  return globs.some((g) => globToRegExp(g).test(path));
}

const workflows = loadWorkflows();
const ci = workflows.filter((w) => w.file.startsWith('ci-'));
const failures = [];
const checks = [];

function check(desc, condition) {
  checks.push({ desc, ok: Boolean(condition) });
  if (!condition) failures.push(desc);
}

// ── Structure ───────────────────────────────────────────────────────────────

check('at least one CI workflow exists', ci.length > 0);

const groups = new Map();
for (const { file, doc } of workflows) {
  const group = doc.concurrency?.group;
  check(`${file}: declares a concurrency group`, Boolean(group));
  if (group) {
    if (groups.has(group)) {
      check(
        `${file}: concurrency group is not shared with ${groups.get(group)}`,
        false,
      );
    }
    groups.set(group, file);
  }
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    check(`${file}:${name}: has timeout-minutes`, Boolean(job['timeout-minutes']));
  }
}

// Check-run names must be unique across workflows. Four jobs all called "changes"
// produce four indistinguishable checks, which cannot be selected individually as
// required status checks (AC5).
const displayNames = new Map();
for (const { file, doc } of ci) {
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    const display = job.name ?? id;
    const prev = displayNames.get(display);
    check(
      `check name "${display}" is unique (${file}${prev ? ` collides with ${prev}` : ''})`,
      !prev,
    );
    displayNames.set(display, file);
  }
}

// TypeScript and Go must be in different files so they gate independently (AC1).
check(
  'TypeScript and Go have separate workflow files',
  ci.some((w) => w.file.includes('typescript')) && ci.some((w) => w.file.includes('go')),
);

// A workflow filtered at the trigger never reports a check, which permanently
// blocks a pull request once that check is required (AC5).
for (const { file, doc } of ci) {
  const on = doc.on ?? doc.true; // YAML 1.1 parses bare `on:` as boolean true
  const pr = on?.pull_request;
  check(
    `${file}: pull_request trigger has no paths filter (would break required checks)`,
    !pr || (!pr.paths && !pr['paths-ignore']),
  );
}

// ── Routing ─────────────────────────────────────────────────────────────────

const allFilters = {};
for (const { file, doc } of ci) {
  for (const [name, globs] of Object.entries(filtersOf(doc))) {
    allFilters[`${file}:${name}`] = globs;
  }
}

const byName = (needle) =>
  Object.entries(allFilters).filter(([k]) => k.endsWith(`:${needle}`));

for (const name of ['ts', 'go', 'db', 'planning', 'detections']) {
  check(`a "${name}" filter is defined`, byName(name).length > 0);
}

/**
 * Each case lists paths and which filters must and must not match. Both halves
 * are required: "must not match" alone would be satisfied by a filter that
 * matches nothing at all.
 */
const CASES = [
  {
    name: 'docs-only change (P0-02 T3)',
    paths: ['docs/ci.md', 'docs/getting-started.md', 'README.md'],
    mustNot: ['ts', 'go', 'detections', 'db', 'planning'],
    must: [],
  },
  {
    name: 'Go service change',
    paths: ['services/ingest/cmd/ingest/main.go'],
    must: ['go'],
    mustNot: ['planning'],
  },
  {
    name: 'TypeScript package change',
    paths: ['packages/db/src/index.ts'],
    must: ['ts'],
    mustNot: ['go', 'planning'],
  },
  {
    name: 'migration change must reach the integration job',
    paths: ['db/postgres/migrations/0003_example.sql'],
    must: ['db'],
    mustNot: ['go', 'planning'],
  },
  {
    name: 'detection rule change without Go source',
    paths: ['detections/rules/t1110_password_spraying.yml'],
    must: ['detections'],
    mustNot: ['ts', 'planning'],
  },
  {
    name: 'backlog change',
    paths: ['planning/tickets/p0.json'],
    must: ['planning'],
    mustNot: ['ts', 'go', 'detections'],
  },
  {
    name: 'lockfile change rebuilds TypeScript',
    paths: ['pnpm-lock.yaml'],
    must: ['ts'],
    mustNot: ['planning'],
  },
];

for (const c of CASES) {
  for (const name of c.must) {
    const entries = byName(name);
    const hit = entries.some(([, globs]) => c.paths.some((p) => matches(globs, p)));
    check(`${c.name}: matches "${name}"`, hit);
  }
  for (const name of c.mustNot) {
    for (const [key, globs] of byName(name)) {
      const bad = c.paths.filter((p) => matches(globs, p));
      check(`${c.name}: does not match "${key}"${bad.length ? ` (hit ${bad.join(', ')})` : ''}`, bad.length === 0);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`workflows: ${failures.length} of ${checks.length} checks failed\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`workflows: ${checks.length} checks ok across ${ci.length} CI workflows`);
for (const { file, doc } of ci) {
  console.log(`  ${file} — jobs: ${Object.keys(doc.jobs ?? {}).join(', ')}`);
}
