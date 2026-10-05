/**
 * The pure counting logic behind the progress dashboard (P0-12 T2),
 * extracted from build.mjs so it is callable with a fixture issue set
 * without needing a live GitHub API call or planning/ on disk. build.mjs
 * imports this rather than inlining it; the behaviour is unchanged, only
 * where it lives.
 */

/** Status is derived from labels first, then issue state. */
export function statusOf(issue) {
  if (!issue) return 'Backlog';
  if (issue.state === 'closed') return 'Done';
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());
  if (labels.some((l) => l.includes('blocked'))) return 'Blocked';
  if (labels.some((l) => l.includes('in review'))) return 'In Review';
  if (labels.some((l) => l.includes('in progress'))) return 'In Progress';
  if (issue.assignee) return 'In Progress';
  return 'Ready';
}

export const STATUSES = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Blocked', 'Done'];

/**
 * Joins the plan (tickets, from planning/) to reality (issues, from the
 * GitHub API) and computes every count the page renders.
 *
 * @param {Array} tickets - planning/tickets/*.json entries, each with a
 *   `phase` key already attached (build.mjs derives this from the filename).
 * @param {Array} issues - raw GitHub issue objects (state, labels, assignee,
 *   title, number, html_url, updated_at).
 * @param {object} meta - planning/meta.json (phases, trustGuarantees).
 */
export function computeCounts(tickets, issues, meta) {
  const byTicketId = new Map();
  for (const i of issues) {
    const m = /^\[([A-Z]\d-\d+)\]/.exec(i.title);
    if (m) byTicketId.set(m[1], i);
  }

  const enriched = tickets.map((t) => {
    const issue = byTicketId.get(t.id);
    return {
      ...t,
      issue: issue ? { number: issue.number, url: issue.html_url, updated: issue.updated_at } : null,
      status: statusOf(issue),
    };
  });

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
  totals.pct = totals.tickets ? Math.round((totals.done / totals.tickets) * 100) : 0;

  const statusCounts = Object.fromEntries(
    STATUSES.map((s) => [s, enriched.filter((t) => t.status === s).length]),
  );

  const testTypeCounts = {};
  for (const t of enriched) {
    for (const tc of t.tests) testTypeCounts[tc.type] = (testTypeCounts[tc.type] ?? 0) + 1;
  }

  const guaranteeRows = Object.entries(meta.trustGuarantees ?? {}).map(([key, text]) => {
    const ts = enriched.filter((t) => t.guarantee === key);
    return {
      key,
      text,
      total: ts.length,
      done: ts.filter((t) => t.status === 'Done').length,
      tickets: ts,
    };
  });

  return { enriched, phases, totals, statusCounts, testTypeCounts, guaranteeRows };
}
