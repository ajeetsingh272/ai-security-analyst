/** Mirrors GET/POST /suppressions's response shape
 * (apps/api/src/routes/suppressions.ts, @sentinel/db's SuppressionRow). */

export interface SuppressionRow {
  id: string;
  tenantId: string;
  ruleId: string;
  entityId: string | null;
  reason: string;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedByEmail: string | null;
  suppressedCount: number;
}

export interface SuppressionListResponse {
  suppressions: SuppressionRow[];
}
