'use client';
// /impact: the tree commitments of signed government contracts and their yearly planting statements
// (src/server/commitments.ts). Absent until there is a signed one: nothing stands in its place.
import { api, useLoad } from '@/components/ui';
import { TREE_RULES, bandWords, GOV_PRICING } from '@/lib/govpricing';
import { dayWords } from '@/lib/billingmode';

const n = (x: number) => x.toLocaleString('en');

export function Commitments() {
  const [d] = useLoad(() => api('/public/tree-commitments'));
  const list: any[] | undefined = d?.commitments;
  if (!list?.length) return null;
  return (
    <section className="card stack" id="contracts" aria-labelledby="contracts-h">
      <h2 id="contracts-h" className="serif" style={{ fontSize: 22 }}>Trees in government contracts</h2>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{TREE_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
      {list.map((c) => {
        const band = GOV_PRICING.bands.find((b) => b.key === c.band);
        return (
          <article key={c.agreement_ref + c.holder} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <h3 style={{ margin: 0 }}>{c.holder}, contract {c.agreement_ref}</h3>
            <p style={{ margin: 0 }}>{c.share_pct}% of the contract fee funds mangrove planting with Treegens: {n(c.trees_per_year)} trees a year{band ? ` (${bandWords(band).toLowerCase()})` : ''}. Signed on {dayWords(c.signed_on)}, running from {dayWords(c.starts_on)}{c.ends_on ? ` to ${dayWords(c.ends_on)}` : ''}.</p>
            {c.statements.length === 0
              ? <p className="muted small" style={{ margin: 0 }}>No planting statement yet. The first one is published after the first year of planting.</p>
              : c.statements.map((s: any) => (
                <details key={s.year} data-fold>
                  <summary>Planting statement {s.year}: {n(s.trees)} trees</summary>
                  <dl className="small" style={{ margin: '8px 0 0' }}>
                    <dt><b>Sites</b></dt><dd>{s.sites}</dd>
                    <dt><b>Dates</b></dt><dd>{dayWords(s.planted_from)} to {dayWords(s.planted_to)}</dd>
                    <dt><b>Species</b></dt><dd>{s.species}</dd>
                    <dt><b>Trees planted</b></dt><dd>{n(s.trees)}</dd>
                    <dt><b>Evidence from Treegens</b></dt>
                    <dd><ul style={{ margin: 0, paddingLeft: 18 }}>{s.evidence.map((u: string) => <li key={u}><a href={u} rel="noreferrer noopener" target="_blank">{u}</a></li>)}</ul></dd>
                  </dl>
                </details>
              ))}
          </article>
        );
      })}
    </section>
  );
}
