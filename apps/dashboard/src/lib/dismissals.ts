/** Mirrors GET /dismissals/digest and POST /cases/:id/challenge's
 * response shapes (apps/api/src/routes/dismissals.ts). */

export interface DismissalDigestRow {
  /** 'system' = a rule dismissed it; 'ai' = Sentinel's own triage
   * dismissed it — the two are never conflated in the UI (AC2). */
  actorType: string;
  reason: string;
  caseCount: number;
  signalCount: number;
}

export interface DismissalDigestResponse {
  day: string;
  digest: DismissalDigestRow[];
}

export interface ChallengeDismissalResponse {
  case: { id: string; state: string | null };
}
