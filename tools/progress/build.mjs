#!/usr/bin/env node
/**
 * Builds the project progress dashboard into site/.
 *
 * Merges two sources:
 *   planning/        the plan — phases, tickets, test cases, dependencies
 *   GitHub issues    reality — what is actually open, closed, in progress
 *
 * If the GitHub API is unavailable the page still builds from planning/ alone
 * and says so, rather than failing the deploy and leaving a stale page with no
 * explanation.
 *
 *   node tools/progress/build.mjs
 *
 * GITHUB_TOKEN is optional locally; the workflow provides it.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'site');

const meta = JSON.parse(readFileSync(join(ROOT, 'planning', 'meta.json'), 'utf8'));
const REPO = meta.repo;

const tickets = [];
for (const file of readdirSync(join(ROOT, 'planning', 'tickets')).sort()) {
  if (!file.endsWith('.json')) continue;
  const phase = file.replace('.json', '').toUpperCase();
  for (const t of JSON.parse(readFileSync(join(ROOT, 'planning', 'tickets', file), 'utf8'))) {
    tickets.push({ ...t, phase });
  }
}

// ── Reality: fetch issues ───────────────────────────────────────────────────

let issues = [];
let live = false;
let fetchNote = '';

try {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'sentinel-progress',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/issues?state=all&per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const batch = await res.json();
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  live = true;
} catch (err) {
  fetchNote = `Live issue data unavailable (${err.message}). Showing the plan only.`;
  console.warn(fetchNote);
}

// ── Join plan to reality ────────────────────────────────────────────────────

const byTicketId = new Map();
for (const i of issues) {
  const m = /^\[([A-Z]\d-\d+)\]/.exec(i.title);
  if (m) byTicketId.set(m[1], i);
}

/** Status is derived from labels first, then issue state. */
function statusOf(issue) {
  if (!issue) return 'Backlog';
  if (issue.state === 'closed') return 'Done';
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());
  if (labels.some((l) => l.includes('blocked'))) return 'Blocked';
  if (labels.some((l) => l.includes('in review'))) return 'In Review';
  if (labels.some((l) => l.includes('in progress'))) return 'In Progress';
  if (issue.assignee) return 'In Progress';
  return 'Ready';
}

const enriched = tickets.map((t) => {
  const issue = byTicketId.get(t.id);
  return {
    ...t,
    issue: issue ? { number: issue.number, url: issue.html_url, updated: issue.updated_at } : null,
    status: statusOf(issue),
  };
});

const STATUSES = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Blocked', 'Done'];

const phases = meta.phases.map((p) => {
  const ts = enriched.filter((t) => t.phase === p.key);
  const done = ts.filter((t) => t.status === 'Done');
  return {
    ...p,
    tickets: ts,
    total: ts.length,
    done: done.length,
    points: ts.reduce((a, t) => a + t.points, 0),
    donePoints: done.reduce((a, t) => a + t.points, 0),
    tests: ts.reduce((a, t) => a + t.tests.length, 0),
    doneTests: done.reduce((a, t) => a + t.tests.length, 0),
    pct: ts.length ? Math.round((done.length / ts.length) * 100) : 0,
  };
});

const totals = {
  tickets: enriched.length,
  done: enriched.filter((t) => t.status === 'Done').length,
  points: enriched.reduce((a, t) => a + t.points, 0),
  donePoints: enriched.filter((t) => t.status === 'Done').reduce((a, t) => a + t.points, 0),
  tests: enriched.reduce((a, t) => a + t.tests.length, 0),
  doneTests: enriched.filter((t) => t.status === 'Done').reduce((a, t) => a + t.tests.length, 0),
  weeks: meta.phases.reduce((a, p) => a + p.weeks, 0),
};
totals.pct = Math.round((totals.done / totals.tickets) * 100);

const statusCounts = Object.fromEntries(
  STATUSES.map((s) => [s, enriched.filter((t) => t.status === s).length]),
);

const testTypeCounts = {};
for (const t of enriched) {
  for (const tc of t.tests) testTypeCounts[tc.type] = (testTypeCounts[tc.type] ?? 0) + 1;
}

const guaranteeRows = Object.entries(meta.trustGuarantees).map(([key, text]) => {
  const ts = enriched.filter((t) => t.guarantee === key);
  return {
    key,
    text,
    total: ts.length,
    done: ts.filter((t) => t.status === 'Done').length,
    tickets: ts,
  };
});

const activeTickets = enriched
  .filter((t) => t.status === 'In Progress' || t.status === 'In Review' || t.status === 'Blocked')
  .sort((a, b) => a.id.localeCompare(b.id));

const nextUp = enriched
  .filter((t) => t.status === 'Backlog' || t.status === 'Ready')
  .filter((t) => (t.dependsOn ?? []).every((d) => enriched.find((x) => x.id === d)?.status === 'Done'))
  .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))
  .slice(0, 8);

// ── Render ──────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SEV = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };

function bar(pct, color) {
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

const built = new Date().toISOString();

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel · Delivery</title>
<meta name="description" content="Live build progress for Sentinel, the AI Security Analyst.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --void:#070A11; --base:#0C111C; --raised:#131A28; --sunken:#04060B;
  --hair:rgba(255,255,255,.08); --strong:rgba(255,255,255,.16);
  --t1:#E8ECF4; --t2:#9BA6BA; --t3:#7A849A;
  --critical:#FF3D6E; --high:#FF8A3D; --medium:#F5C544; --low:#3DBFF2; --info:#777F8F;
  --signal:#34D1F0; --verified:#4ADE9B;
  --f-display:'Bricolage Grotesque','Archivo',system-ui,sans-serif;
  --f-ui:'Archivo',system-ui,sans-serif;
  --f-mono:'IBM Plex Mono',ui-monospace,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--void);color:var(--t1);
  font-family:var(--f-ui);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(ellipse 80% 50% at 50% -10%, rgba(52,209,240,.07), transparent 70%);
  background-repeat:no-repeat;
}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px 96px}
a{color:inherit}
code,.mono{font-family:var(--f-mono);font-variant-ligatures:none}

/* ── Header ─────────────────────────────────────────────────────────────── */
header{padding:64px 0 40px;border-bottom:1px solid var(--hair);margin-bottom:40px}
.eyebrow{
  display:inline-flex;align-items:center;gap:8px;
  font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
  color:var(--signal);border:1px solid var(--strong);border-radius:999px;
  padding:5px 12px;margin-bottom:24px;
}
.live{width:7px;height:7px;border-radius:999px;background:var(--signal);animation:pulse 3s cubic-bezier(.4,0,.6,1) infinite}
.live[data-state="stale"]{background:var(--medium);animation:none}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(52,209,240,.4)}50%{opacity:.5;box-shadow:0 0 0 6px rgba(52,209,240,0)}}
h1{
  font-family:var(--f-display);font-size:clamp(2.25rem,6vw,3.5rem);
  line-height:1.02;letter-spacing:-.03em;font-weight:700;margin:0 0 12px;
}
.sub{color:var(--t2);font-size:1.0625rem;max-width:62ch;margin:0}

/* ── Stat row ───────────────────────────────────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--hair);border:1px solid var(--hair);border-radius:12px;overflow:hidden;margin:40px 0}
.stat{background:var(--base);padding:20px}
.stat-k{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--t3);margin-bottom:10px}
.stat-v{font-family:var(--f-display);font-size:2rem;line-height:1;letter-spacing:-.02em;font-weight:700}
.stat-v small{font-family:var(--f-ui);font-size:.8125rem;font-weight:400;color:var(--t3);letter-spacing:0}

h2{font-family:var(--f-display);font-size:1.6875rem;letter-spacing:-.01em;margin:56px 0 6px;font-weight:600}
.lede{color:var(--t2);margin:0 0 24px;max-width:68ch}

/* ── Bars ───────────────────────────────────────────────────────────────── */
.bar{height:5px;background:var(--sunken);border-radius:999px;overflow:hidden}
.bar-fill{height:100%;border-radius:999px;transition:width .28s cubic-bezier(.16,1,.3,1)}

/* ── Phases ─────────────────────────────────────────────────────────────── */
.phase{
  background:var(--base);border:1px solid var(--hair);border-radius:12px;
  padding:20px;margin-bottom:12px;
  animation:rise .4s cubic-bezier(.16,1,.3,1) backwards;
}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.phase-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.phase-key{font-family:var(--f-mono);font-size:.8125rem;font-weight:500;padding:2px 7px;border-radius:5px;background:var(--raised)}
.phase-name{font-weight:600;font-size:1rem}
.phase-meta{margin-left:auto;font-family:var(--f-mono);font-size:.71875rem;color:var(--t3);white-space:nowrap}
.phase-goal{color:var(--t2);font-size:.8125rem;margin:0 0 14px;max-width:72ch}
.phase-nums{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:.71875rem;color:var(--t3);font-family:var(--f-mono)}
.phase-nums b{color:var(--t2);font-weight:500}

/* ── Tables ─────────────────────────────────────────────────────────────── */
.panel{background:var(--base);border:1px solid var(--hair);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:.8125rem}
th{
  text-align:left;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
  color:var(--t3);padding:12px 16px;border-bottom:1px solid var(--hair);white-space:nowrap;
}
td{padding:11px 16px;border-bottom:1px solid var(--hair);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--raised)}
.tid{font-family:var(--f-mono);font-size:.71875rem;color:var(--t2);white-space:nowrap}

/* ── Severity pills: hue + shape + label, never hue alone ───────────────── */
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;white-space:nowrap}
.glyph{width:9px;height:9px;flex:none}
.g-critical{background:var(--critical);clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%)}
.g-high{background:var(--high);clip-path:polygon(50% 0,100% 100%,0 100%)}
.g-medium{background:var(--medium);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.g-low{background:var(--low);border-radius:999px}
.p-critical{color:var(--critical)} .p-high{color:var(--high)}
.p-medium{color:var(--medium)} .p-low{color:var(--low)}

.chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--hair);color:var(--t2);white-space:nowrap}
.chip-done{color:var(--verified);border-color:rgba(74,222,155,.3)}
.chip-prog{color:var(--signal);border-color:rgba(52,209,240,.3)}
.chip-block{color:var(--critical);border-color:rgba(255,61,110,.3)}

/* ── Guarantees ─────────────────────────────────────────────────────────── */
.guarantee{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid var(--hair);align-items:flex-start}
.guarantee:last-child{border-bottom:0}
.g-key{font-family:var(--f-mono);font-size:.71875rem;color:var(--verified);padding-top:2px;flex:none;width:34px}
.g-body{flex:1;min-width:0}
.g-text{font-size:.8125rem}
.g-count{font-family:var(--f-mono);font-size:.71875rem;color:var(--t3);white-space:nowrap}

.note{background:var(--raised);border:1px solid var(--hair);border-left:2px solid var(--medium);border-radius:8px;padding:14px 16px;font-size:.8125rem;color:var(--t2);margin:24px 0}
footer{margin-top:72px;padding-top:24px;border-top:1px solid var(--hair);color:var(--t3);font-size:.71875rem;display:flex;gap:16px;flex-wrap:wrap;justify-content:space-between}
.scroll{overflow-x:auto}

@media (max-width:640px){
  header{padding:40px 0 28px}
  .stat-v{font-size:1.5rem}
  th,td{padding:9px 12px}
  .phase-meta{margin-left:0;width:100%}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="eyebrow"><span class="live" ${live ? '' : 'data-state="stale"'}></span>${live ? 'Live from GitHub' : 'Plan only'}</div>
  <h1>Sentinel · Delivery</h1>
  <p class="sub">Build progress for the AI Security Analyst — an autonomous security operations centre for companies that could never afford one. Every ticket carries acceptance criteria and test cases; this page is generated from the same backlog that generates the board.</p>
</header>

${fetchNote ? `<div class="note">${esc(fetchNote)}</div>` : ''}

<div class="stats">
  <div class="stat"><div class="stat-k">Overall</div><div class="stat-v">${totals.pct}<small>%</small></div></div>
  <div class="stat"><div class="stat-k">Tickets</div><div class="stat-v">${totals.done}<small> / ${totals.tickets}</small></div></div>
  <div class="stat"><div class="stat-k">Story points</div><div class="stat-v">${totals.donePoints}<small> / ${totals.points}</small></div></div>
  <div class="stat"><div class="stat-k">Test cases</div><div class="stat-v">${totals.doneTests}<small> / ${totals.tests}</small></div></div>
  <div class="stat"><div class="stat-k">Phases</div><div class="stat-v">${phases.filter((p) => p.pct === 100).length}<small> / ${phases.length}</small></div></div>
  <div class="stat"><div class="stat-k">Planned</div><div class="stat-v">${totals.weeks}<small> weeks</small></div></div>
</div>

<h2>Phases</h2>
<p class="lede">Eight phases, sized honestly rather than optimistically. Each has an exit criterion that is an executable test, not a judgement call.</p>
${phases
  .map(
    (p, i) => `
<div class="phase" style="animation-delay:${i * 40}ms">
  <div class="phase-top">
    <span class="phase-key" style="color:#${p.color}">${p.key}</span>
    <span class="phase-name">${esc(p.name)}</span>
    <span class="phase-meta">${p.done}/${p.total} · ${p.pct}% · ~${p.weeks}w</span>
  </div>
  <p class="phase-goal">${esc(p.goal)}</p>
  ${bar(p.pct, `#${p.color}`)}
  <div class="phase-nums">
    <span><b>${p.donePoints}</b>/${p.points} pts</span>
    <span><b>${p.doneTests}</b>/${p.tests} tests</span>
    <span>exit: ${esc(p.exit.slice(0, 90))}${p.exit.length > 90 ? '…' : ''}</span>
  </div>
</div>`,
  )
  .join('')}

<h2>Status</h2>
<p class="lede">Derived from issue state and labels on the board.</p>
<div class="panel scroll">
<table>
<thead><tr><th>Status</th><th>Tickets</th><th style="width:50%">Share</th></tr></thead>
<tbody>
${STATUSES.map((s) => {
  const n = statusCounts[s];
  const pct = Math.round((n / totals.tickets) * 100);
  const col = s === 'Done' ? 'var(--verified)' : s === 'Blocked' ? 'var(--critical)' : s === 'In Progress' ? 'var(--signal)' : 'var(--info)';
  return `<tr><td>${s}</td><td class="tid">${n}</td><td>${bar(pct, col)}</td></tr>`;
}).join('')}
</tbody>
</table>
</div>

<h2>Trust guarantees</h2>
<p class="lede">Six product promises enforced by code and covered by tests rather than by policy. Weakening any of them requires an ADR. These tickets carry the <code>trust-guarantee</code> label and need two reviewers.</p>
<div class="panel">
${guaranteeRows
  .map(
    (g) => `<div class="guarantee">
  <div class="g-key">${g.key}</div>
  <div class="g-body"><div class="g-text">${esc(g.text)}</div></div>
  <div class="g-count">${g.done}/${g.total}</div>
</div>`,
  )
  .join('')}
</div>

${
  activeTickets.length
    ? `<h2>In flight</h2>
<div class="panel scroll">
<table>
<thead><tr><th>Ticket</th><th>Title</th><th>Phase</th><th>Status</th></tr></thead>
<tbody>
${activeTickets
  .map(
    (t) => `<tr>
  <td class="tid">${t.issue ? `<a href="${t.issue.url}">${esc(t.id)}</a>` : esc(t.id)}</td>
  <td>${esc(t.title)}</td>
  <td class="tid">${t.phase}</td>
  <td><span class="chip ${t.status === 'Blocked' ? 'chip-block' : 'chip-prog'}">${t.status}</span></td>
</tr>`,
  )
  .join('')}
</tbody>
</table>
</div>`
    : ''
}

<h2>Ready to start</h2>
<p class="lede">Unblocked tickets whose dependencies are all complete, highest priority first.</p>
<div class="panel scroll">
<table>
<thead><tr><th>Ticket</th><th>Title</th><th>Priority</th><th>Pts</th><th>Tests</th></tr></thead>
<tbody>
${
  nextUp.length
    ? nextUp
        .map(
          (t) => `<tr>
  <td class="tid">${t.issue ? `<a href="${t.issue.url}">${esc(t.id)}</a>` : esc(t.id)}</td>
  <td>${esc(t.title)}</td>
  <td><span class="pill p-${SEV[t.priority]}"><span class="glyph g-${SEV[t.priority]}"></span>${t.priority}</span></td>
  <td class="tid">${t.points}</td>
  <td class="tid">${t.tests.length}</td>
</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="color:var(--t3)">Nothing unblocked — every ready ticket is waiting on a dependency.</td></tr>'
}
</tbody>
</table>
</div>

<h2>Test coverage planned</h2>
<p class="lede">${totals.tests} test cases across ${totals.tickets} tickets. Every detection rule additionally ships a positive and a negative fixture, enforced by CI.</p>
<div class="panel scroll">
<table>
<thead><tr><th>Type</th><th>Cases</th><th style="width:50%">Share</th></tr></thead>
<tbody>
${Object.entries(testTypeCounts)
  .sort((a, b) => b[1] - a[1])
  .map(
    ([type, n]) =>
      `<tr><td>${type}</td><td class="tid">${n}</td><td>${bar(Math.round((n / totals.tests) * 100), 'var(--signal)')}</td></tr>`,
  )
  .join('')}
</tbody>
</table>
</div>

<footer>
  <span>Generated ${esc(built)} from <code>planning/</code>${live ? ' + live GitHub issues' : ''}</span>
  <span><a href="https://github.com/${REPO}">${REPO}</a> · <a href="https://github.com/${REPO}/issues">Issues</a> · <a href="https://github.com/${REPO}/blob/main/docs/roadmap.md">Roadmap</a></span>
</footer>

</div>
</body>
</html>`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), html, 'utf8');
writeFileSync(
  join(OUT, 'progress.json'),
  JSON.stringify({ built, live, totals, statusCounts, phases: phases.map(({ tickets: _, ...p }) => p) }, null, 2),
  'utf8',
);
// Jekyll would otherwise swallow files; Pages serves this directory raw.
writeFileSync(join(OUT, '.nojekyll'), '', 'utf8');

console.log(
  `Built site/index.html — ${totals.done}/${totals.tickets} tickets (${totals.pct}%), ` +
    `${totals.tests} test cases, live=${live}`,
);
