'use client';
import { IMPACT, PRICING, fmtNum, fmtTrees } from '@/lib/impact';

export function ImpactStats({ i, dark }: { i: any; dark?: boolean }) {
  return (
    <div className="grid g4 keep2">
      <div className={`stat${dark ? '' : ' green'}`}><div className="k">Sheets of paper saved</div><div className="v num">{fmtNum(i.sheets)}</div><div className="s">across {fmtNum(i.envelopes)} completed envelope{i.envelopes === 1 ? '' : 's'}</div></div>
      <div className="stat"><div className="k">Trees left standing</div><div className="v num">{fmtTrees(i.trees)}</div><div className="s">at {fmtNum(IMPACT.sheetsPerTree)} sheets per tree</div></div>
      <div className="stat"><div className="k">Water not used</div><div className="v num">{fmtNum(i.litresWater)} L</div><div className="s">{IMPACT.litresWaterPerSheet} litres per sheet</div></div>
      <div className="stat"><div className="k">CO2e avoided</div><div className="v num">{fmtNum(i.kgCo2, 1)} kg</div><div className="s">{IMPACT.gramsCo2PerSheet} g per sheet</div></div>
    </div>
  );
}

export function Methodology() {
  return (
    <div className="card">
      <h2 style={{ marginBottom: 10 }}>How we count</h2>
      <p>We would rather under-promise. These are estimates, and this is exactly how they are worked out:</p>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7, margin: 0 }}>
        <li><b>Sheets saved</b> = pages in the envelope × number of recipients. On paper, every party gets a printed copy. We do not count the sender&apos;s own copy, reprints, drafts or envelopes.</li>
        <li>Only <b>completed</b> envelopes count. Drafts and voided envelopes save nothing.</li>
        <li><b>Trees</b>: one average pulpwood tree makes about {fmtNum(IMPACT.sheetsPerTree)} sheets of office paper (Conservatree&apos;s estimate).</li>
        <li><b>Water</b>: about {IMPACT.litresWaterPerSheet} litres to make one A4 sheet.</li>
        <li><b>Carbon</b>: about {IMPACT.gramsCo2PerSheet} g CO2e per sheet over its life cycle. Couriers and printers would add more, so we leave them out.</li>
        <li><b>Mangroves</b>: everything paid to GrowSigning, the monthly plan and top-ups alike, goes to Treegens tree planting, and every dollar plants {PRICING.treesPerUsd} mangrove trees. The total shown is what was paid, less anything refunded. It counts the trees funded from that money, not signatures used: a signature that expires unused was paid for, and its trees are planted all the same.</li>
      </ul>
      <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>Running servers has a footprint too. It is far smaller than paper, but it is not zero, and we will not pretend it is.</p>
    </div>
  );
}
