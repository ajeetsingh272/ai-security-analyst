'use client';

import { useEffect } from 'react';
import { ErrorState } from '@sentinel/ui';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-base p-6">
      <ErrorState title="Something went wrong" description="This has been logged. You can try again." onRetry={reset} />
    </main>
  );
}
