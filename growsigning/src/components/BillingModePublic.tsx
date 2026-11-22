'use client';
// Which billing mode this server is in, for public pages that run in the browser (the footer, /impact). One request
// per page view, shared by every part of the page that asks, and nothing at all is hidden until the answer says
// "deployment": with zero setup the consumer pages are exactly as before. Server pages ask isDeploymentBilling()
// (src/lib/billingmode.ts) directly.
import { useEffect, useState } from 'react';
import { api } from '@/components/ui';

let asked: Promise<boolean> | null = null;
const ask = () => (asked ??= api('/public/billing-mode').then((r: any) => r?.mode === 'deployment').catch(() => false));

/** True once the server says it runs under a government agreement (BILLING_MODE=deployment). */
export function useDeploymentBilling(): boolean {
  const [gov, setGov] = useState(false);
  useEffect(() => {
    let live = true;
    ask().then((v) => live && setGov(v));
    return () => {
      live = false;
    };
  }, []);
  return gov;
}
