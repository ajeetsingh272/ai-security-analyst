'use client';

import { useEffect } from 'react';
import { ErrorState } from '@sentinel/ui';

export default function AuthenticatedError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="Something went wrong loading this page"
      description="This has been logged. You can try again, or use the navigation to go elsewhere."
      onRetry={reset}
    />
  );
}
