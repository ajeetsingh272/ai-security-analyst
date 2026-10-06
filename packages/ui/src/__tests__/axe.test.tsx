/**
 * P0-08 T3: axe accessibility assertions pass with no violations.
 *
 * Runs every component together in one tree rather than in isolation, since
 * axe also catches relational problems (duplicate ids, a landmark structure
 * that only breaks once two components share a page) that per-component runs
 * would miss individually.
 *
 * jsdom has no real layout engine, so colour-contrast and a few other rules
 * that need actual painted pixels come back "incomplete" rather than pass or
 * fail here — that is a property of the test environment, not evidence of
 * anything. Contrast itself is already proven analytically against every
 * defined pair in @sentinel/design-tokens' own 73-test suite; this test
 * additionally asserts incomplete results are limited to the small set axe
 * documents as DOM/layout-dependent, so a *new* incomplete rule firing for an
 * unrelated reason does not slip past unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { Button } from '../Button.js';
import { Badge } from '../Badge.js';
import { SeverityPill } from '../SeverityPill.js';
import { Card } from '../Card.js';
import { Skeleton } from '../Skeleton.js';
import { EmptyState } from '../EmptyState.js';
import { ErrorState } from '../ErrorState.js';

// Rules axe itself documents as requiring real layout/paint, which jsdom does
// not provide. Anything NOT in this list that comes back incomplete is a real
// finding and fails the test below.
const LAYOUT_DEPENDENT_RULES = new Set(['color-contrast', 'color-contrast-enhanced']);

function Gallery() {
  return (
    <main>
      <h1>Component gallery</h1>
      <Button>Investigate</Button>
      <Button variant="danger">Revoke</Button>
      <Badge variant="verified">grounded</Badge>
      <SeverityPill severity="critical" />
      <SeverityPill severity="low" compact />
      <Card onClick={() => {}}>Interactive case summary</Card>
      <Card>Static case summary</Card>
      <Skeleton lines={2} />
      <EmptyState title="No open cases" description="All clear." />
      <ErrorState title="Could not load cases" onRetry={() => {}} />
    </main>
  );
}

describe('accessibility (axe-core)', () => {
  it('reports zero violations across the full component set', async () => {
    const { container } = render(<Gallery />);
    const results = await axe.run(container);

    if (results.violations.length > 0) {
      const detail = results.violations
        .map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`)
        .join('\n');
      throw new Error(`axe found ${results.violations.length} violation(s):\n${detail}`);
    }
    expect(results.violations).toHaveLength(0);

    const unexpectedIncomplete = results.incomplete.filter(
      (r) => !LAYOUT_DEPENDENT_RULES.has(r.id),
    );
    if (unexpectedIncomplete.length > 0) {
      const detail = unexpectedIncomplete.map((r) => `${r.id}: ${r.help}`).join('\n');
      throw new Error(`axe found unexplained incomplete result(s):\n${detail}`);
    }
  });
});
