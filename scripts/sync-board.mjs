#!/usr/bin/env node
/**
 * Generates the GitHub board from planning/.
 *
 * planning/ is the source of truth. This script is idempotent and resumable:
 * it skips labels, milestones and issues that already exist, so a partial run
 * (rate limit, network drop) is safe to repeat.
 *
 *   node scripts/sync-board.mjs --dry-run      preview without writing
 *   node scripts/sync-board.mjs                create/update everything
 *   node scripts/sync-board.mjs --phase P0     restrict to one phase
 *
 * Requires `gh` authenticated with the `repo` and `project` scopes.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'planning');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyPhase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : null;

const meta = JSON.parse(readFileSync(join(PLANNING, 'meta.json'), 'utf8'));
const REPO = meta.repo;
const [OWNER] = REPO.split('/');

function gh(ghArgs, { allowFail = false } = {}) {
  if (DRY) {
    console.log(`  [dry-run] gh ${ghArgs.join(' ')}`);
    return '';
  }
  try {
    return execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = err.stderr?.toString() ?? err.message;
    throw new Error(`gh ${ghArgs.join(' ')}\n${detail}`);
  }
}

// ── Load tickets ────────────────────────────────────────────────────────────

const tickets = [];
for (const file of readdirSync(join(PLANNING, 'tickets')).sort()) {
  if (!file.endsWith('.json')) continue;
  const phase = file.replace('.json', '').toUpperCase();
  if (onlyPhase && phase !== onlyPhase.toUpperCase()) continue;
  for (const t of JSON.parse(readFileSync(join(PLANNING, 'tickets', file), 'utf8'))) {
    tickets.push({ ...t, phase });
  }
}

const phaseByKey = Object.fromEntries(meta.phases.map((p) => [p.key, p]));

// ── Issue body ──────────────────────────────────────────────────────────────

function renderBody(t) {
  const phase = phaseByKey[t.phase];
  const lines = [];

  lines.push(`> **${t.phase} · ${phase.name}** — ${t.epic}`);
  lines.push('');
  lines.push(t.description);
  lines.push('');

  if (t.guarantee) {
    lines.push(
      `### ⚠ Trust guarantee: ${t.guarantee}`,
      '',
      `This ticket implements the product guarantee **"${meta.trustGuarantees[t.guarantee]}"**.`,
      'Weakening it requires an ADR and two reviewers. See [`SECURITY.md`](../blob/main/SECURITY.md).',
      '',
    );
  }

  lines.push('### Acceptance criteria', '');
  for (const a of t.acceptance) lines.push(`- [ ] ${a}`);
  lines.push('');

  lines.push('### Test cases', '');
  lines.push('| ID | Type | Must verify | Passing |');
  lines.push('|---|---|---|---|');
  for (const tc of t.tests) {
    lines.push(`| \`${tc.id}\` | ${tc.type} | ${tc.desc} | <ul><li>[ ]</li></ul> |`);
  }
  lines.push('');

  if (t.dependsOn?.length) {
    lines.push('### Depends on', '');
    for (const d of t.dependsOn) lines.push(`- \`${d}\``);
    lines.push('');
  }

  lines.push('### Definition of Done', '');
  lines.push(
    '- [ ] Every acceptance criterion above is met',
    '- [ ] Every test case above exists and passes',
    '- [ ] `pnpm lint && pnpm typecheck && pnpm test` green (paste output in the PR)',
    '- [ ] `go vet ./... && go test -race ./...` green, if Go was touched',
    '- [ ] No secret, customer identifier or live log sample committed',
    '- [ ] Docs or ADRs updated if behaviour or an interface changed',
    '- [ ] Reviewed and approved' + (t.guarantee ? ' **by two reviewers**' : ''),
    '',
    '---',
    `<sub>Generated from \`planning/tickets/${t.phase.toLowerCase()}.json\` by \`scripts/sync-board.mjs\`. ` +
      `Edit the backlog, not this issue body — a re-run overwrites it.</sub>`,
  );

  return lines.join('\n');
}

function labelsFor(t) {
  const l = [`phase:${t.phase}`, `type:${t.type}`, `priority:${t.priority}`, `area:${t.area}`];
  if (t.guarantee) l.push('trust-guarantee');
  if (t.cuttable) l.push('cuttable');
  return l;
}

// ── 1. Labels ───────────────────────────────────────────────────────────────

console.log(`\n── Labels (${meta.labels.length}) ───────────────────────────────`);
for (const l of meta.labels) {
  const res = gh(
    ['label', 'create', l.name, '--repo', REPO, '--color', l.color, '--description', l.description, '--force'],
    { allowFail: true },
  );
  console.log(`  ${res === null ? 'skip' : 'ok  '} ${l.name}`);
}

// ── 2. Milestones (one per phase) ───────────────────────────────────────────

console.log(`\n── Milestones ──────────────────────────────────────────────`);
const existingMilestones = DRY
  ? []
  : JSON.parse(gh(['api', `repos/${REPO}/milestones?state=all&per_page=100`]) || '[]');
const milestoneNumber = {};

for (const p of meta.phases) {
  if (onlyPhase && p.key !== onlyPhase.toUpperCase()) continue;
  const title = `${p.key} · ${p.name}`;
  const found = existingMilestones.find((m) => m.title === title);
  if (found) {
    milestoneNumber[p.key] = found.number;
    console.log(`  skip ${title}`);
    continue;
  }
  const out = gh([
    'api', `repos/${REPO}/milestones`, '-X', 'POST',
    '-f', `title=${title}`,
    '-f', `description=${p.goal}\n\nExit criterion: ${p.exit}\n\nEstimated: ${p.weeks} weeks.`,
  ]);
  if (!DRY) milestoneNumber[p.key] = JSON.parse(out).number;
  console.log(`  ok   ${title}`);
}

// ── 3. Issues ───────────────────────────────────────────────────────────────

console.log(`\n── Issues (${tickets.length}) ──────────────────────────────────`);
const existingIssues = DRY
  ? []
  : JSON.parse(
      gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title']) || '[]',
    );

const issueUrlById = {};
const tmp = mkdtempSync(join(tmpdir(), 'sentinel-board-'));

for (const t of tickets) {
  const title = `[${t.id}] ${t.title}`;
  const existing = existingIssues.find((i) => i.title === title);
  const bodyFile = join(tmp, `${t.id}.md`);
  writeFileSync(bodyFile, renderBody(t), 'utf8');

  if (existing) {
    gh([
      'issue', 'edit', String(existing.number), '--repo', REPO,
      '--body-file', bodyFile,
      ...labelsFor(t).flatMap((l) => ['--add-label', l]),
      ...(milestoneNumber[t.phase] ? ['--milestone', `${t.phase} · ${phaseByKey[t.phase].name}`] : []),
    ]);
    issueUrlById[t.id] = `https://github.com/${REPO}/issues/${existing.number}`;
    console.log(`  upd  #${existing.number} ${title}`);
  } else {
    const url = gh([
      'issue', 'create', '--repo', REPO,
      '--title', title,
      '--body-file', bodyFile,
      ...labelsFor(t).flatMap((l) => ['--label', l]),
      ...(milestoneNumber[t.phase] ? ['--milestone', `${t.phase} · ${phaseByKey[t.phase].name}`] : []),
    ]);
    issueUrlById[t.id] = url;
    console.log(`  new  ${url.split('/').pop().padStart(3)} ${title}`);
  }
}

// ── 4. Project board ────────────────────────────────────────────────────────

console.log(`\n── Project board ───────────────────────────────────────────`);
let projectNumber = null;
if (!DRY) {
  const projects = JSON.parse(
    gh(['project', 'list', '--owner', OWNER, '--format', 'json', '--limit', '100']) || '{"projects":[]}',
  );
  const found = projects.projects?.find((p) => p.title === meta.board);
  if (found) {
    projectNumber = found.number;
    console.log(`  skip "${meta.board}" (#${projectNumber})`);
  } else {
    const created = JSON.parse(
      gh(['project', 'create', '--owner', OWNER, '--title', meta.board, '--format', 'json']),
    );
    projectNumber = created.number;
    console.log(`  new  "${meta.board}" (#${projectNumber}) ${created.url}`);
  }

  console.log(`\n── Adding ${Object.keys(issueUrlById).length} items to board ──────────────`);
  let added = 0;
  for (const [id, url] of Object.entries(issueUrlById)) {
    const res = gh(['project', 'item-add', String(projectNumber), '--owner', OWNER, '--url', url], {
      allowFail: true,
    });
    if (res !== null) added++;
    process.stdout.write(`\r  ${added}/${Object.keys(issueUrlById).length}  ${id}        `);
  }
  console.log('');
}

// ── Summary ─────────────────────────────────────────────────────────────────

const totalTests = tickets.reduce((a, t) => a + t.tests.length, 0);
console.log(`
────────────────────────────────────────────────────────────
  ${tickets.length} tickets · ${totalTests} test cases · ${meta.phases.length} milestones
  Issues: https://github.com/${REPO}/issues
  ${projectNumber ? `Board:  https://github.com/users/${OWNER}/projects/${projectNumber}` : ''}
────────────────────────────────────────────────────────────`);
