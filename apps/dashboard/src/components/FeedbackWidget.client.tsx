'use client';

import { useState } from 'react';
import { Card, Button } from '@sentinel/ui';
import type { FeedbackSubjectType } from '../lib/feedback.js';

export interface FeedbackWidgetProps {
  subjectType: FeedbackSubjectType;
  subjectId: string;
}

/**
 * P6-12: in-product feedback attached to a case or a weekly report.
 * Reporting a false positive here is what automatically feeds the
 * tuning backlog (apps/api/src/routes/feedback.ts) — nothing further
 * the person submitting this needs to do for that to happen.
 */
export function FeedbackWidget({ subjectType, subjectId }: FeedbackWidgetProps) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(isFalsePositive: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectType, subjectId, isFalsePositive, comment: comment.trim() || undefined }),
      });
      if (!res.ok) {
        setError('Could not submit feedback.');
        return;
      }
      setSubmitted(true);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return <p className="font-ui text-body-s text-text-tertiary">Thanks for the feedback.</p>;
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void submit(false)} isLoading={submitting}>
          This was helpful
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Report false positive
        </Button>
        {error && (
          <span role="alert" className="text-body-s text-severity-critical">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <Card className="border-severity-high/30">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-ui text-body-s font-medium text-text-secondary">What made this look like a false positive? (optional)</span>
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-body-s text-text-primary"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" isLoading={submitting} onClick={() => void submit(true)}>
            Submit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && (
          <span role="alert" className="text-body-s text-severity-critical">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}
