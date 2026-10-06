import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Card } from '../Card.js';
import { THEMES, withTheme } from './themes.js';

describe('Card', () => {
  it.each(THEMES)('renders non-interactive under %s theme with no button semantics', (theme) => {
    withTheme(theme, () => {
      render(<Card data-testid="card">Case summary</Card>);
      const card = screen.getByTestId('card');
      expect(card).toBeVisible();
      expect(card).not.toHaveAttribute('role');
      expect(card).not.toHaveAttribute('tabindex');
    });
  });

  it('a non-interactive card is not reachable by Tab', async () => {
    render(<Card data-testid="card">Static</Card>);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByTestId('card')).not.toHaveFocus();
  });

  it('an interactive card (onClick set) gets button role, tabIndex and keyboard activation', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Card onClick={onClick}>Open case</Card>);
    const card = screen.getByRole('button', { name: 'Open case' });
    expect(card).toHaveAttribute('tabindex', '0');

    await user.tab();
    expect(card).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('clicking an interactive card with a mouse still fires onClick', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Card onClick={onClick}>Open case</Card>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
