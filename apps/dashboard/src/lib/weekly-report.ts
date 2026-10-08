/** Mirrors apps/api/src/routes/weekly-report.ts's own response shapes. */

export interface WeeklyReportData {
  totalCases: number;
  bySeverity: Record<string, number>;
  actionsByStatus: Record<string, number>;
  entitiesAffected: number;
  topCase: { title: string | null; severity: string | null } | null;
}

export interface WeeklyReportRow {
  id: string;
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  headline: string;
  oneImprovement: string | null;
  isQuiet: boolean;
  data: WeeklyReportData;
  generatedAt: string;
  emailedAt: string | null;
}

export interface WeeklyReportListResponse {
  reports: WeeklyReportRow[];
}

export interface ReportSchedule {
  dayOfWeek: number;
  enabled: boolean;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
