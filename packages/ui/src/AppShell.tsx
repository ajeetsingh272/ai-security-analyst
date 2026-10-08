/**
 * The dashboard's authenticated layout (P6-01): a header bar, a primary
 * navigation region, and the page content every route renders into.
 * Structural only — no state, no "use client" needed here. Below the
 * `md` breakpoint the nav becomes a wrapping horizontal bar instead of a
 * sidebar, which keeps the whole shell scroll-free down to 375px without
 * needing a client-side drawer toggle; a dedicated mobile nav pattern can
 * replace this later without changing this component's contract (it only
 * ever renders whatever `nav` is handed to it).
 */
import type { ReactNode } from 'react';
import { cn } from './lib/cn.js';

export interface AppShellProps {
  header: ReactNode;
  nav: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AppShell({ header, nav, children, className }: AppShellProps) {
  return (
    <div className={cn('flex min-h-screen flex-col bg-surface-base text-text-primary', className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-signal focus:px-4 focus:py-2 focus:text-surface-void"
      >
        Skip to content
      </a>

      <header className="flex items-center justify-between gap-4 border-b border-border-hairline bg-surface-raised px-4 py-3 md:px-6">
        {header}
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Primary"
          className="flex flex-row flex-wrap gap-1 border-b border-border-hairline bg-surface-sunken p-2 md:w-56 md:flex-col md:border-b-0 md:border-r md:p-4"
        >
          {nav}
        </nav>

        <main id="main-content" className="flex-1 overflow-x-hidden p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
