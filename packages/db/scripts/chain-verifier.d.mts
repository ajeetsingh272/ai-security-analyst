export const GENESIS_HASH: Buffer;

export interface AuditEntryContentInput {
  tenantId: string;
  occurredAt: string;
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
}

export interface AuditEntryContent {
  tenantId: string;
  occurredAt: string;
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
}

export function auditEntryContent(entry: AuditEntryContentInput): AuditEntryContent;

export function computeEntryHash(prevHash: Buffer, content: AuditEntryContent): Buffer;

export interface AuditEntryRow extends AuditEntryContentInput {
  id: string | number;
  prevHash: Buffer;
  entryHash: Buffer;
}

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAtId: string | number; reason: string };

export function verifyChain(entries: AuditEntryRow[]): VerifyChainResult;
