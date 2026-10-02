#!/usr/bin/env node
/**
 * Validates planning/ before it is allowed to generate issues or the progress
 * dashboard. The backlog is the source of truth for the board, the roadmap and
 * the progress page, so a malformed ticket silently becomes a malformed issue.
 *
 * Exits non-zero on any error. Warnings do not fail the build.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'planning');

const errors = [];
const warnings = [];

const meta = JSON.parse(readFileSync(join(PLANNING, 'meta.json'), 'utf8'));
const phaseKeys = new Set(meta.phases.map((p) => p.key));
const labelNames = new Set(meta.labels.map((l) => l.name));
const guaranteeKeys = new Set(Object.keys(meta.trustGuarantees));

const VALID_TYPES = new Set(['feat', 'infra', 'test', 'docs', 'security']);
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const VALID_TEST_TYPES = new Set([
  'unit',
  'integration',
  'e2e',
  'load',
  'manual',
  'security',
]);

/** @type {Map<string, any>} */
const tickets = new Map();

for (const file of readdirSync(join(PLANNING, 'tickets')).sort()) {
  if (!file.endsWith('.json')) continue;
  const phase = file.replace('.json', '').toUpperCase();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(PLANNING, 'tickets', file), 'utf8'));
  } catch (err) {
    errors.push(`${file}: invalid JSON — ${err.message}`);
    continue;
  }

  if (!Array.isArray(parsed)) {
    errors.push(`${file}: expected an array of tickets`);
    continue;
  }

  for (const t of parsed) {
    const where = `${file}:${t.id ?? '<missing id>'}`;

    if (!t.id) errors.push(`${where}: missing id`);
    else if (tickets.has(t.id)) errors.push(`${where}: duplicate id`);
    else tickets.set(t.id, { ...t, phase });

    if (t.id && !t.id.startsWith(phase + '-')) {
      errors.push(`${where}: id does not match its phase file (${phase})`);
    }
    if (!phaseKeys.has(phase)) errors.push(`${where}: unknown phase ${phase}`);

    for (const field of ['title', 'epic', 'description']) {
      if (!t[field] || typeof t[field] !== 'string' || !t[field].trim()) {
        errors.push(`${where}: missing or empty ${field}`);
      }
    }

    if (!VALID_TYPES.has(t.type)) errors.push(`${where}: invalid type "${t.type}"`);
    if (!VALID_PRIORITIES.has(t.priority)) {
      errors.push(`${where}: invalid priority "${t.priority}"`);
    }
    if (!labelNames.has(`area:${t.area}`)) errors.push(`${where}: unknown area "${t.area}"`);
    if (!Number.isInteger(t.points) || t.points < 1) {
      errors.push(`${where}: points must be a positive integer`);
    }
    if (t.guarantee && !guaranteeKeys.has(t.guarantee)) {
      errors.push(`${where}: unknown trust guarantee "${t.guarantee}"`);
    }

    // Acceptance criteria are what make a ticket closeable. A ticket without
    // them is a wish, and the Definition of Done cannot be evaluated.
    if (!Array.isArray(t.acceptance) || t.acceptance.length < 3) {
      errors.push(`${where}: needs at least 3 acceptance criteria`);
    }

    // Test cases are not optional. This is a security product; an untested
    // behaviour is an unverified claim.
    if (!Array.isArray(t.tests) || t.tests.length < 1) {
      errors.push(`${where}: needs at least one test case`);
    } else {
      const ids = new Set();
      for (const tc of t.tests) {
        if (!tc.id) errors.push(`${where}: a test case is missing its id`);
        else if (ids.has(tc.id)) errors.push(`${where}: duplicate test id ${tc.id}`);
        else ids.add(tc.id);

        if (!VALID_TEST_TYPES.has(tc.type)) {
          errors.push(`${where}/${tc.id}: invalid test type "${tc.type}"`);
        }
        if (!tc.desc || !tc.desc.trim()) {
          errors.push(`${where}/${tc.id}: missing description`);
        }
      }

      // A ticket whose only coverage is a manual test cannot gate a release.
      const allManual = t.tests.every((tc) => tc.type === 'manual');
      if (allManual && t.type !== 'docs') {
        warnings.push(`${where}: only manual tests — cannot gate CI`);
      }
    }

    // A ticket implementing a trust guarantee must prove it, not assert it.
    // The `trust-guarantee` label (applied from this field by sync-board) is
    // what routes it to two reviewers; this check makes sure the ticket also
    // carries coverage that can actually fail.
    if (t.guarantee && Array.isArray(t.tests)) {
      const hasEnforcingTest = t.tests.some(
        (tc) => tc.type === 'security' || tc.type === 'integration' || tc.type === 'e2e',
      );
      if (!hasEnforcingTest) {
        errors.push(
          `${where}: implements ${t.guarantee} but has no security, integration or e2e test — ` +
            `a guarantee covered only by unit tests is a guarantee about one function, not the system`,
        );
      }
    }
  }
}

// Dependencies must exist and must not point forward in time.
const phaseOrder = meta.phases.map((p) => p.key);
for (const [id, t] of tickets) {
  for (const dep of t.dependsOn ?? []) {
    if (!tickets.has(dep)) {
      errors.push(`${id}: depends on unknown ticket ${dep}`);
      continue;
    }
    const depPhase = tickets.get(dep).phase;
    if (phaseOrder.indexOf(depPhase) > phaseOrder.indexOf(t.phase)) {
      errors.push(`${id} (${t.phase}) depends on ${dep} in a later phase (${depPhase})`);
    }
  }
}

// Cycle detection — a dependency cycle deadlocks the board.
const state = new Map();
function visit(id, trail) {
  if (state.get(id) === 'done') return;
  if (state.get(id) === 'visiting') {
    errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
    return;
  }
  state.set(id, 'visiting');
  for (const dep of tickets.get(id)?.dependsOn ?? []) {
    if (tickets.has(dep)) visit(dep, [...trail, id]);
  }
  state.set(id, 'done');
}
for (const id of tickets.keys()) visit(id, []);

// ── Report ──────────────────────────────────────────────────────────────────

const totalTests = [...tickets.values()].reduce((a, t) => a + (t.tests?.length ?? 0), 0);
const totalPoints = [...tickets.values()].reduce((a, t) => a + (t.points ?? 0), 0);

console.log(
  `Backlog: ${tickets.size} tickets · ${totalTests} test cases · ${totalPoints} points · ${meta.phases.length} phases`,
);

for (const w of warnings) console.log(`  warn  ${w}`);

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  error ${e}`);
  process.exit(1);
}

console.log('Backlog valid.');
