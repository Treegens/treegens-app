'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { ImpactStats, Methodology, anyTotal } from '@/components/ImpactView';
import { fmtNum, PRICING } from '@/lib/impact';

export default function Impact() {
  const me = useMe();
  const [d] = useLoad(() => api('/impact'));
  if (!d) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Trees planted</h1><div className="muted">What the signatures of {me.account.name} have planted and kept out of the printer.</div></div></div>
      <ImpactStats i={d.account} />
      <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
        <div style={{ maxWidth: 620 }}>
          <h2 className="serif" style={{ fontSize: 22 }}>Every signature plants {PRICING.treesPerSignature} trees</h2>
          <p style={{ margin: '6px 0 0', color: '#cfe2d3' }}>
            {d.account.treesFunded > 0 ? <>The signatures on the documents of {me.account.name} plant <b style={{ color: '#fff' }}>{fmtNum(d.account.treesFunded)} trees</b> so far: mangroves, planted by Treegens. Free signatures count too. Thank you.</>
              : <>Each time someone you asked finishes signing, Treegens plants {PRICING.treesPerSignature} mangroves. Free signatures count too.</>}
          </p>
        </div>
        <Link href="/app/settings?tab=billing" className="btn" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>See the plan</Link>
      </div>
      {/* Everyone's totals, once they are large enough to mean something. */}
      {anyTotal(d.everyone) && (
        <div>
          <h2 style={{ marginBottom: 10 }}>Everyone on GrowSigning, together</h2>
          <ImpactStats i={d.everyone} dark />
        </div>
      )}
      <Methodology />
    </div>
  );
}
