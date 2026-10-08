#!/usr/bin/env node
/**
 * P6-03: "the MITRE technique for each signal is shown with a plain-
 * English explanation." Generates src/mitre-glossary.generated.json —
 * DO NOT EDIT BY HAND, rerun this script after a rule change instead.
 *
 * Combines two already-real, already-reviewed sources rather than one
 * more hand-maintained encyclopedia that could drift from either:
 *   - go/sentinelattck/techniques.json — the pinned, official MITRE
 *     ATT&CK catalogue (P2-07) — for the technique's correct NAME. A
 *     security product asserting the wrong name for a technique ID is
 *     actively misleading, so this is read from the same pinned data
 *     services/detect's own coverage report uses, never guessed.
 *   - detections/rules/*.yml's own `owner_description` field — already
 *     human-written, reviewed, plain-English prose explaining exactly
 *     what that RULE means for a non-technical owner (the product's own
 *     established voice, docs/design/ui-ux-spec.md §9) — reused here
 *     rather than writing a second, separate "MITRE 101" gloss that
 *     would say something more generic and less useful.
 *
 * Deliberately scoped to only the technique ids this product's OWN
 * detection content can actually produce (extracted from the rules
 * themselves) — not the full ~800-technique ATT&CK matrix, most of
 * which this product has no rule for and no business describing.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RULES_DIR = path.join(REPO_ROOT, 'detections', 'rules');
const TECHNIQUES_JSON = path.join(REPO_ROOT, 'go', 'sentinelattck', 'techniques.json');
const OUT_FILE = path.join(__dirname, '..', 'src', 'mitre-glossary.generated.json');

function normalizeId(tag) {
  const id = tag.toLowerCase().replace(/^attack\./, '');
  return `T${id.replace(/^t/, '')}`.toUpperCase().replace(/^T(\d+)/, (_, n) => `T${n}`);
}

const techniques = JSON.parse(readFileSync(TECHNIQUES_JSON, 'utf8'));
const byId = new Map(techniques.map((t) => [t.id, t]));

function displayName(id) {
  const t = byId.get(id);
  if (!t) return null;
  const parentId = id.includes('.') ? id.split('.')[0] : null;
  const parent = parentId ? byId.get(parentId) : null;
  return parent ? `${parent.name}: ${t.name}` : t.name;
}

const glossary = new Map(); // id -> { id, name, description, ruleTitles }

for (const file of readdirSync(RULES_DIR)) {
  if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
  const doc = parseYaml(readFileSync(path.join(RULES_DIR, file), 'utf8'));
  const tags = (doc.tags ?? []).filter((t) => /^attack\./i.test(t));
  const ownerDescription = (doc.owner_description ?? '').trim();
  for (const tag of tags) {
    const id = normalizeId(tag);
    const name = displayName(id);
    if (!name) {
      // Fails loudly rather than silently shipping a technique id with
      // no known name — a rule referencing an id outside the pinned
      // catalogue is a rule bug (typo, or the catalogue needs
      // regenerating against a newer ATT&CK release), not something
      // this script should paper over.
      throw new Error(`build-mitre-glossary: ${file} tags unknown technique "${tag}" (normalized "${id}")`);
    }
    const existing = glossary.get(id);
    if (existing) {
      existing.ruleTitles.push(doc.title);
    } else {
      glossary.set(id, { id, name, description: ownerDescription, ruleTitles: [doc.title] });
    }
  }
}

const sorted = [...glossary.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`build-mitre-glossary: wrote ${sorted.length} technique(s) -> ${path.relative(REPO_ROOT, OUT_FILE)}`);
