import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../Badge.js';
import { THEMES, withTheme } from './themes.js';

describe('Badge', () => {
  it.each(THEMES)('renders under %s theme', (theme) => {
    withTheme(theme, () => {
      render(<Badge>trial</Badge>);
      expect(screen.getByText('trial')).toBeVisible();
    });
  });

  it('every class is token-backed, never a raw hex', () => {
    render(<Badge variant="verified">grounded</Badge>);
    expect(screen.getByText('grounded').className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
