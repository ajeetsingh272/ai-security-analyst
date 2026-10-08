/** Mirrors GET /cases/:id's response shape (apps/api/src/routes/
 * case-detail.ts) — this app's own wire-contract mirror, same reasoning
 * as lib/session.ts and lib/cases.ts. */
import type { Severity } from './cases.js';

export interface CaseSignal {
  signalId: string;
  ruleId: string;
  entityType: string;
  entityId: string;
  severity: string;
  detectedAt: string;
  mitreIds: string[];
}

export interface CaseTransition {
  fromState: string | null;
  toState: string;
  actorType: string;
  actorId: string;
  reason: string | null;
  occurredAt: string;
}

export interface Claim {
  text: string;
  evidenceRef: string[];
}

export type Urgency = 'now' | 'today' | 'later';

export interface RecommendedAction {
  playbook: string;
  urgency: Urgency;
  blastRadius: string;
}

export interface Verdict {
  severity: string;
  title: string;
  claims: Claim[];
  attackChain: string[];
  recommendedActions: RecommendedAction[];
}

export interface ActionRow {
  id: string;
  caseId: string;
  playbook: string;
  target: unknown;
  blastRadius: string;
  status: string;
  error: string | null;
  createdAt: string;
  executedAt: string | null;
}

export interface MitreEntry {
  id: string;
  name: string;
  description: string;
  ruleTitles: string[];
}

export interface CaseDetailResponse {
  case: {
    id: string;
    severity: Severity | null;
    title: string | null;
    signalCount: number;
    createdAt: string;
    windowStart: string;
    windowEnd: string | null;
  };
  signals: CaseSignal[];
  transitions: CaseTransition[];
  verdict: Verdict | null;
  actions: ActionRow[];
  mitre: MitreEntry[];
}

export type EvidenceResult =
  | { id: string; status: 'found'; event: EventSummary }
  | { id: string; status: 'pending' }
  | { id: string; status: 'not_found' };

export interface EventSummary {
  event_id: string;
  time: string;
  class_uid: number;
  category_uid: number;
  activity_id: number;
  severity_id: number;
  actor_user_uid: string | null;
  target_uid: string | null;
  src_ip: string | null;
  message: string | null;
}

export interface EvidenceResponse {
  results: EvidenceResult[];
}
