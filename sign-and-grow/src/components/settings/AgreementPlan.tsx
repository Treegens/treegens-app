'use client';
// Settings, Plan on a server in BILLING_MODE=deployment (src/lib/billingmode.ts): one line about the agreement in place
// of the plan. Anywhere else it draws the plan as always (`plan`), at once, so nothing changes with zero setup. The
// line comes with /me (`agreement`), so there is no second request and no wait before the plan.
import type { ReactNode } from 'react';
import { useMe } from '@/components/AppShell';

export function AgreementPlan({ plan }: { plan: ReactNode }) {
  const me = useMe();
  if (!me?.agreement) return <>{plan}</>;
  // Headed like the tab it sits under, so the place has one name.
  return (
    <div className="card" id="agreement">
      <h2>Plan</h2>
      <p style={{ margin: 0 }}>{me.agreement}</p>
    </div>
  );
}
