'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { ImpactStats, Methodology } from '@/components/ImpactView';
import { fmtNum, PRICING } from '@/lib/impact';

export default function Impact() {
  const me = useMe();
  const [d] = useLoad(() => api('/impact'));
  if (!d) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Our impact</h1><div className="muted">What {me.account.name} has kept out of the printer.</div></div></div>
      <ImpactStats i={d.account} />
      <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
        <div style={{ maxWidth: 620 }}>
          <h2 className="serif" style={{ fontSize: 22 }}>Every dollar plants {PRICING.treesPerUsd} mangrove trees</h2>
          <p style={{ margin: '6px 0 0', color: '#cfe2d3' }}>
            {d.account.donatedUsd > 0 ? <>{me.account.name} has paid <b style={{ color: '#fff' }}>${fmtNum(d.account.donatedUsd, 2)}</b>, all of it sent to Treegens tree planting. That is <b style={{ color: '#fff' }}>{fmtNum(d.account.treesFunded)} mangroves</b>. Thank you.</>
              : 'Saving paper is good. Planting trees is better. Everything paid to Sign&Grow, the monthly plan and top-ups alike, goes to Treegens tree planting.'}
          </p>
        </div>
        <Link href="/app/settings?tab=billing" className="btn" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>See the plan</Link>
      </div>
      <div>
        <h2 style={{ marginBottom: 10 }}>Everyone on Sign&Grow, together</h2>
        <ImpactStats i={d.everyone} dark />
      </div>
      <Methodology />
    </div>
  );
}
