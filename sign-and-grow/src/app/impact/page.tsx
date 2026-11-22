'use client';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { ImpactStats, Methodology } from '@/components/ImpactView';
import { PRICING } from '@/lib/impact';
import { Commitments } from '@/components/Commitments';
import { useDeploymentBilling } from '@/components/BillingModePublic';

export default function PublicImpact() {
  const [d] = useLoad(() => api('/public/impact'));
  // Under a government agreement nothing is paid per signature, so no signature funds trees: trees are per contract.
  const gov = useDeploymentBilling();
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap stack" style={{ paddingTop: 20 }}>
        <div>
          <h1 className="pub-h1">Fewer printers. More trees.</h1>
          <p className="pub-lead">A document signed on screen is not printed.{gov ? '' : <> And what customers pay GrowSigning, less card fees, goes to Treegens to plant mangroves: {PRICING.treesPerUsd} for every dollar.</>} This page says exactly what is counted, and how.</p>
        </div>
        {/* Totals appear once they are large enough to mean something. Until then nothing stands in their place. */}
        {d && <ImpactStats i={d} />}
        {gov ? (
          <div className="card">
            <h2 className="serif" style={{ fontSize: 22 }}>Trees here are set per contract</h2>
            <p style={{ margin: '6px 0 0' }}>This service runs under a contract with a public body. Nothing is paid per signature, so no signature funds trees. What a contract funds is set in the contract, whether or not the service is used.</p>
          </div>
        ) : (
          <div className="card row between wrap" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
            <div style={{ maxWidth: 620 }}>
              <h2 className="serif" style={{ fontSize: 22 }}>A paid signature funds {PRICING.treesPerUsd} mangroves</h2>
              <p style={{ margin: '6px 0 0', color: '#cfe2d3' }}>The person who sends a document pays, never the person who signs. Free signatures fund none, and we say so.</p>
            </div>
            <Link href="/signup" className="btn lg" style={{ background: '#ffd24a', borderColor: '#ffd24a', color: '#2b2100' }}>Start signing</Link>
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
