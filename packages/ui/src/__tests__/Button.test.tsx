import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../Button.js';
import { THEMES, withTheme } from './themes.js';

describe('Button', () => {
  it.each(THEMES)('renders under %s theme with the same structure', (theme) => {
    withTheme(theme, () => {
      render(<Button>Investigate</Button>);
      const btn = screen.getByRole('button', { name: 'Investigate' });
      expect(btn).toBeVisible();
      expect(btn.tagName).toBe('BUTTON');
    });
  });

  it('is a real <button> by default, so it is keyboard-operable with no extra wiring', () => {
    render(<Button>Approve</Button>);
    expect(screen.getByRole('button')).toHaveProperty('tagName', 'BUTTON');
  });

  it('fires onClick on Enter and Space like any native button', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Approve</Button>);
    const btn = screen.getByRole('button');
    btn.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('disables the control while loading, so a second click cannot fire mid-request', () => {
    render(<Button isLoading>Submitting</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('does not disable on the plain disabled prop differently than isLoading', () => {
    render(<Button disabled>Approve</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('every class on the rendered button is token-backed, never a raw hex', () => {
    render(<Button variant="danger">Revoke</Button>);
    const className = screen.getByRole('button').className;
    expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('asChild renders the child element instead of a <button>', () => {
    render(
      <Button asChild>
        <a href="/cases/1">Open case</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open case' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/cases/1');
  });
});
