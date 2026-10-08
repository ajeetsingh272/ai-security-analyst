/**
 * P6-12: in-product feedback attached to a case or a weekly report
 * (0028_onboarding_feedback.sql). A false-positive report on a CASE
 * automatically feeds the tuning backlog — a human-reviewed queue,
 * never a live write to `suppressions`/`hotfix_rules` unreviewed; see
 * TuningBacklogRepository's own doc comment.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export type FeedbackSubjectType = 'case' | 'weekly_report';

export interface FeedbackRow {
  id: string;
  tenantId: string;
  subjectType: FeedbackSubjectType;
  subjectId: string;
  userId: string;
  isFalsePositive: boolean;
  comment: string | null;
  createdAt: string;
}

function mapFeedbackRow(row: Record<string, unknown>): FeedbackRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    subjectType: row['subject_type'] as FeedbackSubjectType,
    subjectId: String(row['subject_id']),
    userId: String(row['user_id']),
    isFalsePositive: Boolean(row['is_false_positive']),
    comment: (row['comment'] as string | null) ?? null,
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

export interface CreateFeedbackInput {
  subjectType: FeedbackSubjectType;
  subjectId: string;
  userId: string;
  isFalsePositive: boolean;
  comment: string | null;
}

export interface TuningBacklogItemRow {
  id: string;
  tenantId: string;
  caseId: string | null;
  ruleId: string | null;
  source: string;
  reason: string | null;
  status: 'open' | 'reviewed' | 'applied' | 'dismissed';
  createdAt: string;
}

function mapTuningBacklogRow(row: Record<string, unknown>): TuningBacklogItemRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    caseId: (row['case_id'] as string | null) ?? null,
    ruleId: (row['rule_id'] as string | null) ?? null,
    source: String(row['source']),
    reason: (row['reason'] as string | null) ?? null,
    status: row['status'] as TuningBacklogItemRow['status'],
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

export class FeedbackRepository extends TenantScopedRepository {
  /**
   * AC "false-positive reports ... feed the tuning backlog
   * automatically": a false-positive report on a `case` creates one
   * tuning_backlog_items row in the SAME transaction as the feedback
   * itself — never a separate, skippable step. The candidate rule is
   * whichever rule_id this case's own FIRST signal carries (a case
   * can have signals from more than one rule; the first is a simple,
   * disclosed heuristic, not a claim that it is always the single
   * responsible rule — a human reviews every backlog item before
   * anything is actually tuned).
   */
  async create(input: CreateFeedbackInput): Promise<{ feedback: FeedbackRow; tuningBacklogItem: TuningBacklogItemRow | null }> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO feedback (tenant_id, subject_type, subject_id, user_id, is_false_positive, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, subject_type, subject_id, user_id, is_false_positive, comment, created_at`,
        [this.tenantId, input.subjectType, input.subjectId, input.userId, input.isFalsePositive, input.comment],
      );
      const feedback = mapFeedbackRow(rows[0]);

      if (!input.isFalsePositive || input.subjectType !== 'case') {
        return { feedback, tuningBacklogItem: null };
      }

      const { rows: signalRows } = await client.query<{ rule_id: string }>(
        `SELECT rule_id FROM case_signals WHERE case_id = $1 ORDER BY detected_at ASC LIMIT 1`,
        [input.subjectId],
      );
      const ruleId = signalRows[0]?.rule_id ?? null;

      const { rows: backlogRows } = await client.query(
        `INSERT INTO tuning_backlog_items (tenant_id, case_id, rule_id, source, reason)
         VALUES ($1, $2, $3, 'customer_feedback', $4)
         RETURNING id, tenant_id, case_id, rule_id, source, reason, status, created_at`,
        [this.tenantId, input.subjectId, ruleId, input.comment],
      );

      return { feedback, tuningBacklogItem: mapTuningBacklogRow(backlogRows[0]) };
    });
  }
}

export class TuningBacklogRepository extends TenantScopedRepository {
  async listOpen(): Promise<TuningBacklogItemRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, case_id, rule_id, source, reason, status, created_at
           FROM tuning_backlog_items WHERE status = 'open' ORDER BY created_at DESC`,
      );
      return rows.map(mapTuningBacklogRow);
    });
  }
}
