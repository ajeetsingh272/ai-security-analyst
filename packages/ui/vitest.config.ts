/**
 * React components need a DOM to render into and a cleanup hook between tests,
 * neither of which vitest's default `node` environment provides. Every other
 * TS package in this repo tests pure functions and is fine without this file;
 * this is the one that renders markup.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: false,
  },
});
