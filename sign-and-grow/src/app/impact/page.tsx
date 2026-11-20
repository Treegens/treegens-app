'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { ImpactStats, Methodology } from '@/components/ImpactView';
import { fmtNum } from '@/lib/impact';

export default function PublicImpact() {
  const [d] = useLoad(() => api('/public/impact'));
  return (
    <div>
      <PublicNav />
      <main className="wrap stack" style={{ paddingTop: 24 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 40 }}>Fewer printers. More trees.</h1>
          <p className="muted" style={{ fontSize: 17, maxWidth: 680, marginTop: 10 }}>Signing digitally keeps paper out of the world. Then we go one step further: 100% of Sign&Grow subscription revenue goes to Treegens tree planting. These are the live totals.</p>
        </div>
        {d ? <ImpactStats i={d} /> : <div className="muted">Loading…</div>}
        <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
          <div>
            <div className="small" style={{ color: '#b5cfbc', fontWeight: 600 }}>Subscription revenue sent to tree planting</div>
            <div className="serif num" style={{ fontSize: 40, fontWeight: 700 }}>${d ? fmtNum(d.donatedUsd, 2) : '…'}</div>
            {d?.treesFunded != null && <div style={{ color: '#cfe2d3' }}>About {fmtNum(d.treesFunded)} trees funded</div>}
          </div>
          <Link href="/signup" className="btn lg" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>Start signing</Link>
        </div>
        <Methodology />
      </main>
      <PublicFooter />
    </div>
  );
}
