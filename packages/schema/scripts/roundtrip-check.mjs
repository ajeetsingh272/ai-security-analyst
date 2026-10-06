#!/usr/bin/env node
/**
 * P0-11 T2: round-trip serialisation TypeScript -> Go -> TypeScript
 * preserves every field.
 *
 * Constructs a `Verdict` object exercising every field this schema defines
 * (including its nested Claim and RecommendedAction arrays), serialises it
 * the same way any real TypeScript caller would (plain JSON.stringify),
 * pipes that through the generated Go struct via a throwaway Go program
 * (go/sentinelschema/cmd/roundtrip), and deep-compares what comes back
 * against the original. This is the only genuinely cross-language proof in
 * this ticket — every other check here is about the GENERATED CODE looking
 * right; this is about the two sides actually agreeing on the wire format.
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

/** Every field of Verdict, Claim, and RecommendedAction populated with a
 * distinguishable, non-default value — a bug that only manifests on a zero
 * value (an empty string standing in for a missing field, say) would not
 * show up if any field were left at its default. */
const original = {
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
};

const inputJson = JSON.stringify(original);

const result = spawnSync('go', ['run', './cmd/roundtrip'], {
  cwd: ROUNDTRIP_DIR,
  input: inputJson,
  encoding: 'utf8',
});

if (result.error) {
  console.error(`roundtrip-check: could not run the Go roundtrip program: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`roundtrip-check: Go program exited ${result.status}\n${result.stderr}`);
  process.exit(1);
}

let roundTripped;
try {
  roundTripped = JSON.parse(result.stdout);
} catch (err) {
  console.error(`roundtrip-check: Go program's stdout was not valid JSON: ${err.message}\nstdout: ${result.stdout}`);
  process.exit(1);
}

/** Structural equality, not string equality — Go's json.Marshal orders
 * struct fields by their declaration order, which happens to match this
 * file's object literal today, but relying on that coincidence would make
 * this test fragile to a field reorder that changes nothing semantically. */
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

if (!deepEqual(original, roundTripped)) {
  console.error('roundtrip-check: FAILED — the object changed shape after passing through Go.\n');
  console.error('  original:      ' + JSON.stringify(original));
  console.error('  round-tripped: ' + JSON.stringify(roundTripped));
  process.exit(1);
}

console.log('roundtrip-check: ok — every field of Verdict, Claim and RecommendedAction survived TS -> Go -> TS.');
