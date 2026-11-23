'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { ImpactStats, Methodology } from '@/components/ImpactView';
import { PRICING } from '@/lib/impact';
import { Commitments } from '@/components/Commitments';
import { useDeploymentBilling } from '@/components/BillingModePublic';
import { usePublicT } from '@/components/publicLang';

export default function PublicImpact() {
  const T = usePublicT();
  const [d] = useLoad(() => api('/public/impact'));
  // Under a government agreement nothing is paid per signature, so no signature funds trees: trees are per contract.
  const gov = useDeploymentBilling();
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap stack" style={{ paddingTop: 20 }}>
        <div>
          <h1 className="pub-h1">{T('public.impact.h1')}</h1>
          <p className="pub-lead">{T('public.impact.lead_start')}{gov ? '' : <> {T('public.impact.lead_money', { trees: String(PRICING.treesPerSignature) })}</>} {T('public.impact.lead_end')}</p>
        </div>
        {/* Totals appear once they are large enough to mean something. Until then nothing stands in their place. */}
        {d && <ImpactStats i={d} />}
        {gov ? (
          <div className="card">
            <h2 className="serif" style={{ fontSize: 22 }}>{T('public.impact.contract_h')}</h2>
            <p style={{ margin: '6px 0 0' }}>{T('public.impact.contract_body')}</p>
          </div>
        ) : (
          <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
            <div style={{ maxWidth: 620 }}>
              <h2 className="serif" style={{ fontSize: 22 }}>{T('public.impact.paid_h', { trees: String(PRICING.treesPerSignature) })}</h2>
              <p style={{ margin: '6px 0 0', color: '#cfe2d3' }}>{T('public.impact.paid_body')}</p>
            </div>
            <Link href="/signup" className="btn lg" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>{T('public.impact.start')}</Link>
          </div>
        )}
        {/* Signed government contracts and their planting statements; absent until there is one. */}
        <Commitments />
        <Methodology perContract={gov} />
      </main>
      <PublicFooter />
    </div>
  );
}
