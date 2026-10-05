/**
 * P0-08 T2: tab order and focus visibility for every interactive component,
 * tested together rather than one at a time — the thing that actually breaks
 * in practice is the ORDER across a row of mixed controls, not any single
 * control in isolation.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../Button.js';
import { Card } from '../Card.js';
import { ErrorState } from '../ErrorState.js';

describe('keyboard navigation across a mixed row of components', () => {
  it('Tab visits every interactive element in document order and skips every static one', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Card data-testid="static-card">Static summary</Card>
        <Button>First</Button>
        <Card onClick={() => {}}>Interactive card</Card>
        <ErrorState title="Failed" onRetry={() => {}} />
        <Button>Last</Button>
      </div>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Interactive card' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();

    // Nothing after the last control, and the static card was never visited.
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it('every focusable element in the row carries the visible focus-ring class', () => {
    render(
      <div>
        <Button>A</Button>
        <Card onClick={() => {}}>B</Card>
        <ErrorState title="Failed" onRetry={() => {}} />
      </div>,
    );
    for (const el of screen.getAllByRole('button')) {
      // focus-visible:outline-* is the project-wide rule (theme.css removes
      // focus for no element, including on mouse interaction) — asserted here
      // per-component rather than trusted from the CSS file alone.
      expect(el.className).toMatch(/focus-visible:outline/);
    }
  });

  it('a disabled button is removed from the tab sequence entirely', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Button>Before</Button>
        <Button disabled>Disabled</Button>
        <Button>After</Button>
      </div>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });
});
