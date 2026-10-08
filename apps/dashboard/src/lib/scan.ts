/** Mirrors POST /scan / GET /scan/:id's response shape
 * (apps/api/src/routes/scan.ts) — this app's own wire-contract mirror. */
import type { CaseListItem } from './cases.js';

export interface ScanSummary {
  scanId: string;
  windowStart: string;
  windowEnd: string;
  totalFindings: number;
  entitiesAffected: number;
  isClean: boolean;
  headline: string;
  topFinding: { title: string | null; severity: string | null } | null;
  findings: CaseListItem[];
}
