/**
 * get_case_history (P4-02 AC1) — wraps CasesRepository.history
 * (packages/db), the same repository P4-01's own worker.ts already uses
 * for case lookup. `withTenantContext` is how this repository class gets
 * its tenant — the constructor reads it at construction time and throws
 * if absent (packages/db's own tenant-context.ts) — so there is no
 * `tenantId` parameter the model could ever override; it is established
 * here, from the worker's own trusted CaseContext, before the model's
 * tool-call arguments are even looked at (AC2).
 */
import type { Pool } from 'pg';
import { CasesRepository, withTenantContext, type CaseHistory } from '@sentinel/db';
import { truncate, ToolInvalidArgumentError, runTool, type ToolOutcome, type Logger } from './types.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface GetCaseHistoryArgs {
  caseId: string;
  limit?: number;
}

export interface CaseHistoryResult {
  case: CaseHistory['case'];
  signals: CaseHistory['signals'];
  transitions: CaseHistory['transitions'];
  signalsTruncated: boolean;
  transitionsTruncated: boolean;
}

function validate(args: GetCaseHistoryArgs): void {
  if (!args.caseId || typeof args.caseId !== 'string') {
    throw new ToolInvalidArgumentError('get_case_history: caseId is required');
  }
}

export async function getCaseHistory(
  pool: Pool,
  tenantId: string,
  args: GetCaseHistoryArgs,
  logger: Logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutcome<CaseHistoryResult>> {
  return runTool({
    name: 'get_case_history',
    tenantId,
    args,
    timeoutMs,
    logger,
    fn: async () => {
      validate(args);
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const history = await withTenantContext(tenantId, () => new CasesRepository(pool).history(args.caseId, limit));
      const signals = truncate(history.signals, limit);
      const transitions = truncate(history.transitions, limit);
      return {
        case: history.case,
        signals: signals.items,
        transitions: transitions.items,
        signalsTruncated: signals.truncated,
        transitionsTruncated: transitions.truncated,
      };
    },
  });
}
