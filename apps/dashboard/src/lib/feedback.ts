/** Mirrors POST /feedback's request/response shape
 * (apps/api/src/routes/feedback.ts). */

export type FeedbackSubjectType = 'case' | 'weekly_report';

export interface SubmitFeedbackRequest {
  subjectType: FeedbackSubjectType;
  subjectId: string;
  isFalsePositive: boolean;
  comment?: string;
}
