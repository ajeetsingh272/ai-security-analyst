#!/usr/bin/env node
/**
 * P0-11 T2, P3-08 T3: round-trip serialisation TypeScript -> Go ->
 * TypeScript preserves every field, for every top-level contract this
 * package currently freezes (Verdict, Case).
 *
 * For each, constructs an object exercising every field (including, for
 * Verdict, its nested Claim and RecommendedAction arrays), serialises it
 * the same way any real TypeScript caller would (plain JSON.stringify),
 * pipes that through the matching generated Go struct via a throwaway Go
 * program (go/sentinelschema/cmd/roundtrip), and deep-compares what comes
 * back against the original. This is the only genuinely cross-language
 * proof in this package — every other check here is about the GENERATED
 * CODE looking right; this is about the two sides actually agreeing on
 * the wire format.
 *
 *   node scripts/roundtrip-check.mjs
 *
 * Requires Go on PATH.
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const ROUNDTRIP_DIR = join(REPO_ROOT, 'go', 'sentinelschema');

/** Structural equality, not string equality — Go's json.Marshal orders
 * struct fields by their declaration order, which happens to match this
 * file's object literals today, but relying on that coincidence would
 * make this check fragile to a field reorder that changes nothing
 * semantically. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function roundTripThroughGo(typeName, original) {
  const result = spawnSync('go', ['run', './cmd/roundtrip', `-type=${typeName}`], {
    cwd: ROUNDTRIP_DIR,
    input: JSON.stringify(original),
    encoding: 'utf8',
  });

  if (result.error) {
    console.error(`roundtrip-check (${typeName}): could not run the Go roundtrip program: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`roundtrip-check (${typeName}): Go program exited ${result.status}\n${result.stderr}`);
    process.exit(1);
  }

  let roundTripped;
  try {
    roundTripped = JSON.parse(result.stdout);
  } catch (err) {
    console.error(
      `roundtrip-check (${typeName}): Go program's stdout was not valid JSON: ${err.message}\nstdout: ${result.stdout}`,
    );
    process.exit(1);
  }

  if (!deepEqual(original, roundTripped)) {
    console.error(`roundtrip-check (${typeName}): FAILED — the object changed shape after passing through Go.\n`);
    console.error('  original:      ' + JSON.stringify(original));
    console.error('  round-tripped: ' + JSON.stringify(roundTripped));
    process.exit(1);
  }

  console.log(`roundtrip-check (${typeName}): ok — every field survived TS -> Go -> TS.`);
}

/** Every field of Verdict, Claim, and RecommendedAction populated with a
 * distinguishable, non-default value — a bug that only manifests on a zero
 * value (an empty string standing in for a missing field, say) would not
 * show up if any field were left at its default. */
roundTripThroughGo('verdict', {
  severity: 'critical',
  title: 'Impossible travel followed by a new inbox rule',
  claims: [
    { text: 'Sign-in from Lagos, NG at 03:14 UTC', evidenceRef: ['evt_001', 'evt_002'] },
    { text: 'Inbox rule created 90 seconds later', evidenceRef: ['evt_003'] },
  ],
  attackChain: ['initial_access', 'persistence', 'collection'],
  recommendedActions: [
    { playbook: 'revoke_sessions_and_reset', urgency: 'now', blastRadius: 'One identity.' },
    { playbook: 'notify_security_team', urgency: 'today', blastRadius: 'No customer impact.' },
  ],
});

/** P3-08 T3. Every optional field is POPULATED here, not omitted — the
 * zero-value hazard above applies the same way to Case's own optional
 * fields (a pointer in the generated Go struct), and omitting one would
 * leave its pointer-vs-value handling unexercised by this check. */
roundTripThroughGo('case', {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  severity: 'high',
  title: 'Impossible travel followed by a new inbox rule',
  score: 42.5,
  state: 'investigating',
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-01T01:00:00.000Z',
  entityIds: ['user:alice', 'device:laptop-1'],
  signalCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
});
