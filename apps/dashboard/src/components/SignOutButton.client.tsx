'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@sentinel/ui';

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleSignOut}>
      Sign out
    </Button>
  );
}
