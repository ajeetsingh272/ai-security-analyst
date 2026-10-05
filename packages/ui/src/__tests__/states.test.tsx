/**
 * The loading/empty/error triad (P0-08 AC5): Skeleton, EmptyState, ErrorState.
 * Grouped in one file because the thing worth asserting is the same shape
 * across all three — a data-bearing component swaps between them, and each
 * must announce itself correctly to assistive tech regardless of which theme
 * or which one is showing.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Skeleton } from '../Skeleton.js';
import { EmptyState } from '../EmptyState.js';
import { ErrorState } from '../ErrorState.js';
import { THEMES, withTheme } from './themes.js';

describe('Skeleton (loading state)', () => {
  it.each(THEMES)('announces loading under %s theme', (theme) => {
    withTheme(theme, () => {
      render(<Skeleton />);
      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    });
  });

  it('renders N stacked placeholders for a list skeleton', () => {
    const { container } = render(<Skeleton lines={3} />);
    // The outer status role plus 3 inner ones: a table/list skeleton must
    // read as 3 pending rows, not 1, to anyone using a screen reader.
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(4);
  });
});

describe('EmptyState', () => {
  it.each(THEMES)('renders its title under %s theme', (theme) => {
    withTheme(theme, () => {
      render(<EmptyState title="No open cases" description="You're all caught up." />);
      expect(screen.getByText('No open cases')).toBeVisible();
      expect(screen.getByText("You're all caught up.")).toBeVisible();
    });
  });

  it('is calm, not alarmed — carries no role="alert"', () => {
    const { container } = render(<EmptyState title="No connectors yet" />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('ErrorState', () => {
  it.each(THEMES)('announces failure as an alert under %s theme', (theme) => {
    withTheme(theme, () => {
      render(<ErrorState title="Could not load cases" />);
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load cases');
    });
  });

  it('offers a retry action when onRetry is provided, and it is keyboard-operable', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState title="Could not load cases" onRetry={onRetry} />);
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no retry action when onRetry is omitted', () => {
    render(<ErrorState title="Could not load cases" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
