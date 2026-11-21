'use client';
// The totals and the working behind them, for /impact and the app's Trees planted page. Every figure about paper,
// water and CO2e is an estimate and is called one, with where it comes from. A total is shown only once it is large
// enough to mean something (TOTALS_FROM in src/lib/impact.ts): until then its place is simply absent, never a tiny
// number. Nothing here claims an offset, a removal of CO2 or that signing undoes any harm.
import { IMPACT, PRICING, TOTALS_FROM, fmtNum, totalWorthShowing } from '@/lib/impact';
import { TREEGENS_URL } from '@/lib/impactwords';

/** Is there any total worth showing for these numbers? */
export const anyTotal = (i: any): boolean => !!i && (totalWorthShowing(i.sheets) || Number(i.treesFunded) >= TOTALS_FROM.treesPlanted);

export function ImpactStats({ i, dark }: { i: any; dark?: boolean }) {
  const paper = totalWorthShowing(i.sheets);
  const planted = Number(i.treesFunded) >= TOTALS_FROM.treesPlanted;
  if (!paper && !planted) return null;
  return (
    <div className="grid g4 keep2">
      {planted && <div className={`stat${dark ? '' : ' green'}`}><div className="k">Mangroves funded</div><div className="v num">{fmtNum(i.treesFunded)}</div><div className="s">{PRICING.treesPerUsd} for every dollar paid, less refunds</div></div>}
      {paper && <div className="stat"><div className="k">Sheets of paper not used, estimated</div><div className="v num">{fmtNum(i.sheets)}</div><div className="s">across {fmtNum(i.envelopes)} completed envelope{i.envelopes === 1 ? '' : 's'}</div></div>}
      {paper && <div className="stat"><div className="k">Water not used, estimated</div><div className="v num">{fmtNum(i.litresWater)} L</div><div className="s">{IMPACT.litresWaterPerSheet} litres per sheet</div></div>}
      {paper && <div className="stat"><div className="k">CO2e not emitted, estimated</div><div className="v num">{fmtNum(i.kgCo2, 1)} kg</div><div className="s">{IMPACT.gramsCo2PerSheet} g per sheet</div></div>}
    </div>
  );
}

const out = { target: '_blank', rel: 'noreferrer' } as const;

export function Methodology() {
  return (
    <div className="card">
      <h2 style={{ marginBottom: 10 }}>How we count</h2>
      <p>Two different things are counted here, and they are kept apart.</p>
      <h3 style={{ margin: '14px 0 6px' }}>1. Mangroves: what the money does</h3>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7, margin: 0 }}>
        <li>Everything customers pay GrowSigning, the monthly plan and top-ups alike, goes to Treegens to plant mangroves. Every dollar funds {PRICING.treesPerUsd} mangroves, and a signature costs one dollar, so a signature that was paid for funds {PRICING.treesPerUsd}.</li>
        <li>A free signature funds none: the {PRICING.welcomeSignatures} signatures a new account starts with, a free code, or signing your own document. Nobody is told that a free signature planted anything.</li>
        <li>The total of mangroves is what was paid, less anything refunded, times {PRICING.treesPerUsd}. It counts the trees funded from that money, not signatures used: a signature that expires unused was paid for, and its trees are planted all the same. It is shown from {TOTALS_FROM.treesPlanted} trees up.</li>
        <li>The planting itself is done by Treegens planters. Treegens records plantings on video in its own app, where they are checked before they count. That is Treegens&apos; work, not ours, and <a href={TREEGENS_URL} {...out}>treegens.app</a> is where to look at it.</li>
      </ul>
      <h3 style={{ margin: '14px 0 6px' }}>2. Paper: an estimate of what was not printed</h3>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7, margin: 0 }}>
        <li><b>Sheets</b> = pages in the document × the people on it. On paper, each of them would get a printed copy. The sender&apos;s own copy, reprints and drafts are not counted, and only completed documents count. A total is shown from {fmtNum(TOTALS_FROM.sheets)} sheets up.</li>
        <li><b>Water</b>: about {IMPACT.litresWaterPerSheet} litres to make one A4 sheet. Published figures run from 2 to 13 litres a sheet (Van Oel and Hoekstra, &ldquo;The green and blue water footprint of paper products&rdquo;, UNESCO-IHE Value of Water Research Report 46, 2010).</li>
        <li><b>CO2e</b>: about {IMPACT.gramsCo2PerSheet} g for a sheet over its life, which is 0.9 kg of CO2e for a kilogram of office paper at 5 g a sheet. The Environmental Paper Network&apos;s <a href="https://c.environmentalpaper.org/" {...out}>Paper Calculator</a> lets you work out a figure for a paper of your own. Printers and couriers would add more, so they are left out.</li>
        <li>How many sheets a tree makes (about {fmtNum(IMPACT.sheetsPerTree)}, from <a href="https://conservatree.org/learn/EnviroIssues/TreeStats.shtml" {...out}>Conservatree</a>) is used nowhere as a claim: a share of a tree is not shown.</li>
      </ul>
      <h3 style={{ margin: '14px 0 6px' }}>What we do not claim</h3>
      <p style={{ margin: 0 }}>We do not say that signing here takes CO2 out of the air, offsets anything, or makes a document or a company carbon neutral, and no figure for carbon is given for the mangroves. A signature does not undo any harm. Running servers has a footprint too: far smaller than paper, but not zero.</p>
    </div>
  );
}
