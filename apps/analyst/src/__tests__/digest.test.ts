import { describe, expect, it } from 'vitest';
import type { DismissalDigestRow } from '@sentinel/db';
import { renderDigestSummary } from '../digest.js';

describe('renderDigestSummary', () => {
  it('reports no dismissals plainly', () => {
    expect(renderDigestSummary([])).toBe('No dismissals today.');
  });

  it('AC3: distinguishes an AI dismissal from a rule-based one in the rendered text', () => {
    const rows: DismissalDigestRow[] = [
      { actorType: 'ai', reason: 'Routine travel, not malicious', caseCount: 2, signalCount: 6 },
      { actorType: 'system', reason: 'below_escalation_threshold', caseCount: 5, signalCount: 20 },
    ];
    const summary = renderDigestSummary(rows);
    expect(summary).toContain('AI-dismissed 2 case(s)');
    expect(summary).toContain('rule-dismissed 5 case(s)');
    expect(summary).toContain('Routine travel, not malicious');
    expect(summary).toContain('below_escalation_threshold');
  });
});
