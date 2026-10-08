'use client';

import { useEffect } from 'react';
import { ErrorState } from '@sentinel/ui';

export default function CasesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ErrorState title="Could not load cases" onRetry={reset} />;
}
