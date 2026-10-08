/**
 * P6-07: the weekly owner report's own generation logic — one page,
 * one named improvement (never a list), honest when the week was
 * quiet, readability-gated against the same threshold case reports
 * use (@sentinel/readability, promoted out of apps/analyst for
 * exactly this reuse).
 */
import { CasesRepository, ActionsRepository, ConnectorsRepository, WeeklyReportRepository, withTenantContext, type CaseListItem, type WeeklyReportRow } from '@sentinel/db';
import { isReadable } from '@sentinel/readability';
import type { Pool } from 'pg';

const SERIOUS_SEVERITIES = new Set(['critical', 'high', 'medium']);
const MAX_CASES = 10_000; // P6-02's own proven scale

export interface WeeklyReportData {
  totalCases: number;
  bySeverity: Record<string, number>;
  actionsByStatus: Record<string, number>;
  entitiesAffected: number;
  topCase: { title: string | null; severity: string | null } | null;
}

export function pickOneImprovement(actionsByStatus: Record<string, number>, degradedConnectors: string[]): string | null {
  // Priority order: a systemic problem (something Sentinel itself
  // needs help with) outranks "review your cases," since case review
  // is already the dashboard's own ordinary job — the ONE improvement
  // this report names is deliberately about what's broken, not a
  // restatement of what the Cases screen already shows.
  const failed = actionsByStatus['failed'] ?? 0;
  if (failed > 0) {
    return failed === 1
      ? "Review the 1 action that didn't finish on its own this week. It may need a manual follow-up."
      : `Review the ${failed} actions that didn't finish on their own this week. They may need manual follow-up.`;
  }
  if (degradedConnectors.length > 0) {
    return `Reconnect ${degradedConnectors[0]} — it stopped collecting activity at some point this week.`;
  }
  return null; // genuinely nothing systemic to flag — see AC5's own "says so plainly"
}

export function buildHeadline(serious: CaseListItem[], totalCases: number): string {
  if (serious.length === 0 && totalCases === 0) return 'Nothing happened this week — Sentinel saw no activity worth a case at all.';
  if (serious.length === 0) return `Nothing serious happened this week. Sentinel noted ${totalCases} small item${totalCases === 1 ? '' : 's'}. None needed action.`;
  return `Sentinel caught ${serious.length} thing${serious.length === 1 ? '' : 's'} this week that needed attention, and acted on what it could.`;
}

/** Every sentence this report ships gates against the same Flesch-
 * Kincaid threshold case reports use (AC4) — a fallback keeps the
 * report honest (never silently blank) if a future change to the
 * templates above ever regresses past the threshold. */
function gatedOrFallback(text: string, fallback: string): string {
  return isReadable(text) ? text : fallback;
}

export async function generateWeeklyReport(pool: Pool, tenantId: string, windowEnd: Date): Promise<WeeklyReportRow> {
  const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  return withTenantContext(tenantId, async () => {
    const casePage = await new CasesRepository(pool).list(
      { createdAfter: windowStart.toISOString(), createdBefore: windowEnd.toISOString() },
      1,
      MAX_CASES,
    );
    const actionsByStatus = await new ActionsRepository(pool).countByStatusInRange(windowStart, windowEnd);
    const connectors = await new ConnectorsRepository(pool).findHealth();
    const degradedConnectors = connectors.filter((c) => c.status === 'degraded').map((c) => c.kind);

    const serious = casePage.items.filter((c) => c.severity && SERIOUS_SEVERITIES.has(c.severity));
    const bySeverity: Record<string, number> = {};
    for (const item of casePage.items) {
      if (!item.severity) continue;
      bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;
    }
    const entitiesAffected = new Set(casePage.items.flatMap((c) => c.entityIds)).size;

    const headline = gatedOrFallback(buildHeadline(serious, casePage.items.length), 'Here is your weekly summary.');
    const rawImprovement = pickOneImprovement(actionsByStatus, degradedConnectors);
    const oneImprovement = rawImprovement ? gatedOrFallback(rawImprovement, 'Review this week\'s cases when you have a moment.') : null;

    const data: WeeklyReportData = {
      totalCases: casePage.items.length,
      bySeverity,
      actionsByStatus,
      entitiesAffected,
      topCase: casePage.items[0] ? { title: casePage.items[0].title, severity: casePage.items[0].severity } : null,
    };

    return new WeeklyReportRepository(pool).create({
      windowStart,
      windowEnd,
      headline,
      oneImprovement,
      isQuiet: serious.length === 0,
      data,
    });
  });
}
