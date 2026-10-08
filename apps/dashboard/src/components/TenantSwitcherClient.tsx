'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TenantSwitcher, type TenantOption } from '@sentinel/ui';

export interface TenantSwitcherClientProps {
  current: TenantOption;
  /** Just the current tenant plus, if acting on a linked client, the home
   * tenant to switch back to. The full ranked, searchable list of every
   * linked client belongs to the MSP console (P6-06) — this is only ever
   * the small header-level affordance, not that view (see
   * TenantSwitcher.tsx's own doc comment). */
  options: TenantOption[];
}

export function TenantSwitcherClient({ current, options }: TenantSwitcherClientProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSwitch(targetTenantId: string) {
    if (targetTenantId === current.id || pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetTenantId }),
      });
      if (res.ok) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return <TenantSwitcher current={current} options={options} onSwitch={handleSwitch} />;
}
