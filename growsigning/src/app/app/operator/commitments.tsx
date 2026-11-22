'use client';
// The operator's table of tree commitments in government contracts (src/server/commitments.ts). A commitment is shown
// on /impact only once it is marked as a signed contract; each year gets one planting statement with its evidence.
import { useState, type FormEvent } from 'react';
import { api, useLoad, oops, toast } from '@/components/ui';
import { GOV_PRICING, bandWords } from '@/lib/govpricing';

const EMPTY = { holder: '', agreement_ref: '', band: GOV_PRICING.bands[0].key, share_pct: '', trees_per_year: '', starts_on: '', ends_on: '' };
const EMPTY_S = { year: '', sites: '', planted_from: '', planted_to: '', species: '', trees: '', evidence: '' };

function Field({ label, value, set, type = 'text', area = false }: { label: string; value: string; set: (v: string) => void; type?: string; area?: boolean }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="small">{label}</span>
      {area ? <textarea value={value} onChange={(e) => set(e.target.value)} rows={3} /> : <input type={type} value={value} onChange={(e) => set(e.target.value)} />}
    </label>
  );
}

function Statement({ id, done }: { id: string; done: () => void }) {
  const [s, setS] = useState(EMPTY_S);
  const f = (k: keyof typeof EMPTY_S) => (v: string) => setS({ ...s, [k]: v });
  const save = (e: FormEvent) => {
    e.preventDefault();
    api(`/operator/tree-commitments/${id}/statements`, { body: s }).then(() => (toast('Planting statement added.'), setS(EMPTY_S), done())).catch(oops);
  };
  return (
    <details>
      <summary>Add the planting statement of a year</summary>
      <form className="stack" onSubmit={save} style={{ marginTop: 8 }}>
        <Field label="Year" value={s.year} set={f('year')} type="number" />
        <Field label="Sites" value={s.sites} set={f('sites')} />
        <Field label="First planting day" value={s.planted_from} set={f('planted_from')} type="date" />
        <Field label="Last planting day" value={s.planted_to} set={f('planted_to')} type="date" />
        <Field label="Species" value={s.species} set={f('species')} />
        <Field label="Trees planted" value={s.trees} set={f('trees')} type="number" />
        <Field label="Evidence from Treegens: links to geotagged photos and partner reports, one per line" value={s.evidence} set={f('evidence')} area />
        <div><button className="btn primary">Add the statement</button></div>
      </form>
    </details>
  );
}

// The day the contract was signed, typed next to the button that publishes it: no pop-up, and the date picker of the
// browser. The server checks the day again (a real day that has come).
function SignedOn({ onSign }: { onSign: (day: string) => void }) {
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  return (
    <form className="row wrap" style={{ alignItems: 'flex-end' }} onSubmit={(e) => (e.preventDefault(), onSign(day))}>
      <label className="stack" style={{ gap: 4 }}>
        <span className="small">Day the contract was signed</span>
        <input type="date" value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} required />
      </label>
      <button className="btn">Mark as signed</button>
    </form>
  );
}

export function TreeCommitments() {
  const [d, reload] = useLoad(() => api('/operator/tree-commitments'));
  const [c, setC] = useState(EMPTY);
  if (!d) return null;
  const f = (k: keyof typeof EMPTY) => (v: string) => setC({ ...c, [k]: v });
  const add = (e: FormEvent) => {
    e.preventDefault();
    api('/operator/tree-commitments', { body: c }).then(() => (toast('Saved as a draft. It is shown on the impact page once you mark the contract as signed.'), setC(EMPTY), reload())).catch(oops);
  };
  const sign = (id: string, on: boolean, day = '') =>
    api(`/operator/tree-commitments/${id}/signed`, { body: { signed: on, signed_on: day } }).then(() => (toast(on ? 'Marked as signed. It is on the impact page now.' : 'Back to a draft. It is no longer on the impact page.'), reload())).catch(oops);
  return (
    <details className="card gov-commit">
      <summary><b>Tree commitments in government contracts</b> <span className="muted">({d.commitments.length})</span></summary>
      <p className="muted small">One line per contract, as the contract says it: the share of the fee that funds planting and the trees a year. The impact page lists only contracts marked as signed, with one planting statement a year.</p>
      {d.commitments.map((x: any) => (
        <div key={x.id} className="stack" style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
          <div><b>{x.holder}</b>, contract {x.agreement_ref} · {x.share_pct}% · {x.trees_per_year.toLocaleString('en')} trees a year · {x.status === 'signed' ? `signed on ${x.signed_on}` : 'draft, not shown'}</div>
          {x.statements.map((s: any) => (
            <div key={s.id} className="row wrap small">
              <span>{s.year}: {s.trees.toLocaleString('en')} trees, {s.planted_from} to {s.planted_to}</span>
              <button className="btn" onClick={() => window.confirm(`Remove the statement for ${s.year}?`) && api(`/operator/tree-commitments/${x.id}/statements/${s.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Remove</button>
            </div>
          ))}
          {x.status === 'signed'
            ? <div className="row wrap"><button className="btn" onClick={() => sign(x.id, false)}>Back to a draft</button></div>
            : <SignedOn onSign={(day) => sign(x.id, true, day)} />}
          <Statement id={x.id} done={reload} />
        </div>
      ))}
      <form className="stack" onSubmit={add} style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <h3 style={{ margin: 0 }}>Add a contract</h3>
        <Field label="Who holds the contract" value={c.holder} set={f('holder')} />
        <Field label="Contract reference" value={c.agreement_ref} set={f('agreement_ref')} />
        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Price band</span>
          <select value={c.band} onChange={(e) => f('band')(e.target.value)}>{GOV_PRICING.bands.map((b) => <option key={b.key} value={b.key}>{bandWords(b)}</option>)}</select>
        </label>
        <Field label="Share of the fee that funds planting, in percent" value={c.share_pct} set={f('share_pct')} type="number" />
        <Field label="Trees a year" value={c.trees_per_year} set={f('trees_per_year')} type="number" />
        <Field label="First day of the contract" value={c.starts_on} set={f('starts_on')} type="date" />
        <Field label="Last day of the contract (leave empty if open)" value={c.ends_on} set={f('ends_on')} type="date" />
        <div><button className="btn primary">Save as a draft</button></div>
      </form>
    </details>
  );
}
