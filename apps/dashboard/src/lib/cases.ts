/** Mirrors the GET /cases / GET /cases/filter-options response shape
 * (apps/api/src/routes/cases.ts) — the wire contract between this app
 * and the real API, same reasoning as lib/session.ts's own Role type. */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STATES = ['open', 'triaging', 'investigating', 'awaiting_approval', 'actioned', 'closed', 'dismissed'] as const;
export type CaseState = (typeof STATES)[number];

export interface CaseListItem {
  id: string;
  tenantId: string;
  severity: Severity | null;
  title: string | null;
  score: number | null;
  state: CaseState | null;
  entityIds: string[];
  signalCount: number;
  createdAt: string;
  windowStart: string;
  windowEnd: string | null;
}

export interface CaseListResponse {
  items: CaseListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface CaseFilterOptions {
  entities: FilterOption[];
  rules: FilterOption[];
}

export interface CaseFilters {
  severity?: string;
  state?: string;
  entityId?: string;
  ruleId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export function buildCasesQuery(filters: CaseFilters, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.state) params.set('state', filters.state);
  if (filters.entityId) params.set('entityId', filters.entityId);
  if (filters.ruleId) params.set('ruleId', filters.ruleId);
  if (filters.createdAfter) params.set('createdAfter', filters.createdAfter);
  if (filters.createdBefore) params.set('createdBefore', filters.createdBefore);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return `/api/cases?${params.toString()}`;
}
