'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { ImpactStats, Methodology } from '@/components/ImpactView';
import { PRICING } from '@/lib/impact';

export default function PublicImpact() {
  const [d] = useLoad(() => api('/public/impact'));
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap stack" style={{ paddingTop: 20 }}>
        <div>
          <h1 className="pub-h1">Fewer printers. More trees.</h1>
          <p className="pub-lead">A document signed on screen is not printed. And everything customers pay GrowSigning goes to Treegens to plant mangroves: {PRICING.treesPerUsd} for every dollar. This page says exactly what is counted, and how.</p>
        </div>
        {/* Totals appear once they are large enough to mean something. Until then nothing stands in their place. */}
        {d && <ImpactStats i={d} />}
        <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
          <div style={{ maxWidth: 620 }}>
            <h2 className="serif" style={{ fontSize: 22 }}>A paid signature funds {PRICING.treesPerUsd} mangroves</h2>
            <p style={{ margin: '6px 0 0', color: '#cfe2d3' }}>The person who sends a document pays, never the person who signs. Free signatures fund none, and we say so.</p>
          </div>
          <Link href="/signup" className="btn lg" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>Start signing</Link>
        </div>
        <Methodology />
      </main>
      <PublicFooter />
    </div>
  );
}
