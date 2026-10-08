'use client';

import { useEffect } from 'react';
import { surface, text } from '@sentinel/design-tokens';

// Next's special boundary for an error thrown by the root layout itself —
// it replaces <html>/<body> entirely rather than rendering inside them, so
// unlike every other error.tsx in this app, it has to provide both. Kept
// free of the normal globals.css pipeline on purpose: if the root layout
// (which is what reads the theme cookie and imports that CSS) is what
// failed, this boundary can't assume the CSS build still works either —
// but it still reads its two colours from @sentinel/design-tokens' own
// tokens.ts (plain TS values, no CSS/build dependency) rather than
// hardcoding them, so there is still exactly one place those hex values
// are allowed to be defined.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ background: surface.void, color: text.primary, fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <p>Something went wrong loading Sentinel.</p>
            <button type="button" onClick={reset}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
