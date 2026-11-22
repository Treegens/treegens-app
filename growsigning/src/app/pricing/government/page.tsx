// The public price list for governments, built only from src/lib/govpricing.ts (research/government.json, G14).
// A number the owner has not decided yet is said as "not published yet", never made up.
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { GOV_PRICING, OPEN_LICENCE, ALWAYS_INCLUDED, contractRules, bandWords, feeWords, treeLine, TREE_RULES } from '@/lib/govpricing';

export const metadata = { title: 'Government prices', description: 'What a public body pays for GrowSigning: one fixed fee a year per deployment, no limit on senders or signatures, nothing charged to citizens, and free self-hosting under the open licence.' };

export default function GovernmentPricing() {
  const P = GOV_PRICING;
  const currencies = P.currencies.length ? P.currencies : [null];
  const published = P.currencies.length > 0 || P.bands.some((b) => b.supportHours != null || !!b.response || b.treesPerYear != null || b.hosted !== null);
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap section stack">
        <div>
          <h1 className="pub-h1">Government prices</h1>
          <p className="pub-sub" style={{ marginBottom: 0 }}>One fixed fee a year for each deployment. No limit on senders, documents or signatures, no overage charges, and nothing charged to the people who sign.</p>
        </div>

        <div className="card" id="free">
          <h2>Self-hosting is free</h2>
          <p style={{ margin: 0 }}>The software is open source under the {OPEN_LICENCE} licence. Any public body may run it on its own servers without paying anything and without a contract. The fee below is for support and updates from us, if you want them.</p>
        </div>

        <section className="stack" aria-labelledby="bands-h">
          <h2 id="bands-h">The fee for each size of service</h2>
          {!P.currencies.length && <p className="notice" role="status" style={{ margin: 0 }}>The fees are not published yet. Until they are, write to us through <Link href="/help#contact">the help page</Link> for a quote, and say how many signatures a year you expect.</p>}
          {/* Nothing decided yet: the bands in one list, not four cards that each say "not published yet". */}
          {!published && (
            <div className="card">
              <ul style={{ margin: 0 }}>{P.bands.map((b) => <li key={b.key}>{bandWords(b, P)}</li>)}</ul>
              <p className="muted small" style={{ marginBottom: 0 }}>For each size: the fee when you host it, the support hours and how fast a serious fault is answered are not published yet. Hosting by us or a partner is not offered yet.</p>
            </div>
          )}
          {published && P.bands.map((b) => {
            const trees = treeLine(b, P);
            return (
              <div className="card" key={b.key}>
                <h3 style={{ marginTop: 0 }}>{bandWords(b, P)}</h3>
                <dl style={{ margin: 0 }}>
                  {currencies.map((cur) => (
                    <div key={cur || 'none'}>
                      <dt><b>Support and updates, you host it{cur ? ` (${cur})` : ''}</b></dt><dd>{feeWords(b.selfHosted, cur)}</dd>
                      <dt><b>Hosted by us or a partner{cur ? ` (${cur})` : ''}</b></dt><dd>{feeWords(b.hosted, cur)}</dd>
                    </div>
                  ))}
                  <dt><b>Support hours a year</b></dt><dd>{b.supportHours != null ? b.supportHours.toLocaleString('en') : 'Not published yet'}</dd>
                  <dt><b>Answer to a serious fault</b></dt><dd>{b.response || 'Not published yet'}</dd>
                  {trees && <><dt><b>Trees</b></dt><dd>{trees}</dd></>}
                </dl>
              </div>
            );
          })}
        </section>

        <div className="card">
          <h2>In every fee</h2>
          <ul style={{ margin: 0 }}>{ALWAYS_INCLUDED.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>

        <div className="card" id="rules">
          <h2>The contract rules</h2>
          <ul style={{ margin: 0 }}>{contractRules(P).map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="muted small" style={{ marginBottom: 0 }}>These are the terms we offer. The contract itself is written with your lawyers, and it is the contract that binds both sides.</p>
        </div>

        <div className="card" id="trees">
          <h2>Trees</h2>
          <ul style={{ margin: 0 }}>{TREE_RULES.map((x) => <li key={x}>{x}</li>)}</ul>
          <p style={{ marginBottom: 0 }}>Once a contract is signed, its commitment and each year&apos;s statement are on <Link href="/impact">the impact page</Link>.</p>
        </div>

        <div className="card">
          <h2>What running it costs you</h2>
          <p style={{ margin: 0 }}>Servers, staff time, text messages and email are yours to pay, at your own prices. <Link href="/tco">The cost calculator</Link> adds them up for your number of signatures, with every assumption shown.</p>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
