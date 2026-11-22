'use client';
// The total-cost calculator: every number is the visitor's own, and the arithmetic is tco() in src/lib/govpricing.ts.
import { useState } from 'react';
import { EMPTY_TCO, TCO_SIZES, tco, amountWords, perSignatureWords, MEASURED_SIGNATURES_PER_SERVER_YEAR, bandFor, bandWords, GOV_PRICING, type TcoInput } from '@/lib/govpricing';

type Key = keyof TcoInput;
const BOXES: { key: Key; label: string; hint: string }[] = [
  { key: 'serverMonth', label: 'Cost of one server for one month', hint: 'What a server costs you, in your own currency.' },
  { key: 'servers', label: 'Servers needed', hint: MEASURED_SIGNATURES_PER_SERVER_YEAR ? 'Leave empty to use the measured figure.' : 'Not yet measured. Enter your own number.' },
  { key: 'staffHoursMonth', label: 'Staff hours a month to run it', hint: 'Updates, backups, watching it.' },
  { key: 'staffHourCost', label: 'Cost of one staff hour', hint: '' },
  { key: 'supportYear', label: 'Support and updates from us, a year', hint: 'The quote for your band. Leave empty if you support it yourself.' },
  { key: 'smsPerSignature', label: 'Text messages for each signature', hint: 'Only if you send codes by text message. Often 0.' },
  { key: 'smsCost', label: 'Cost of one text message', hint: 'From your own provider.' },
  { key: 'emailsPerSignature', label: 'Emails for each signature', hint: 'The invitation, reminders and the copy.' },
  { key: 'emailCost', label: 'Cost of one email', hint: 'From your own mail service.' },
];
const COMPARE: { key: Key; label: string; hint: string }[] = [
  { key: 'perEnvelope', label: 'A price per document you were quoted', hint: 'For comparison only. Leave empty to skip.' },
  { key: 'signaturesPerEnvelope', label: 'Signatures on one document, on average', hint: 'Empty counts as 1.' },
];

const toNum = (s: string): number | null => {
  const t = s.replace(/[\s,]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function Calculator() {
  const [text, setText] = useState<Record<Key, string>>(() => Object.fromEntries(Object.keys(EMPTY_TCO).map((k) => [k, ''])) as Record<Key, string>);
  const input = Object.fromEntries(Object.entries(text).map(([k, v]) => [k, toNum(v)])) as TcoInput;
  const r = tco(input);
  const set = (k: Key) => (e: React.ChangeEvent<HTMLInputElement>) => setText({ ...text, [k]: e.target.value });
  const bad = (k: Key) => !!text[k].trim() && toNum(text[k]) === null;
  const box = ({ key, label, hint }: { key: Key; label: string; hint: string }) => (
    <label key={key} className="stack tco-box" style={{ gap: 4 }}>
      <span><b>{label}</b></span>
      <input inputMode="decimal" value={text[key]} onChange={set(key)} aria-invalid={bad(key) || undefined} aria-describedby={`${key}-hint`} />
      <span id={`${key}-hint`} className={bad(key) ? 'small err' : 'muted small'}>{bad(key) ? BAD_NUMBER : hint}</span>
    </label>
  );
  const sigs = input.signatures || 0;
  const missing = r.lines.flatMap((l) => l.missing);
  // The list of empty boxes helps only once somebody has started filling them in.
  const started = BOXES.some((b) => text[b.key].trim());
  const BAD_NUMBER = 'Write a number of 0 or more, without a currency sign. It is counted as 0 until then.';
  return (
    <div className="stack">
      <div className="card stack">
        <label className="stack" style={{ gap: 4 }}>
          <span><b>Signatures a year</b></span>
          <input inputMode="numeric" value={text.signatures} onChange={set('signatures')} aria-invalid={bad('signatures') || undefined} aria-describedby="signatures-hint" />
          <span id="signatures-hint" className={bad('signatures') ? 'small err' : 'muted small'}>{bad('signatures') ? 'Write a number of 0 or more, such as 1000000, without spaces or words.' : sigs ? `${bandWords(bandFor(sigs), GOV_PRICING)}.` : 'Type any number, or pick one below.'}</span>
        </label>
        <div className="row wrap tco-sizes" role="group" aria-label="Common sizes">
          {TCO_SIZES.map((n) => <button key={n} type="button" className="btn" aria-pressed={sigs === n} onClick={() => setText({ ...text, signatures: String(n) })}>{n.toLocaleString('en')}</button>)}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Your costs</h2>
        <p className="muted small" style={{ margin: 0 }}>All amounts in your own currency. None of these numbers is ours: a box you leave empty counts as 0, and the result says so.</p>
        <div className="tco-grid">{BOXES.map(box)}</div>
      </div>

      <section className="card stack" aria-labelledby="tco-out" aria-live="polite">
        <h2 id="tco-out" style={{ margin: 0 }}>A year</h2>
        {!sigs ? <p style={{ margin: 0 }}>Enter the signatures a year, or pick a size above, to see the total.</p> : <>
        <table className="t">
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.key}><th scope="row">{l.label}<div className="muted small" style={{ fontWeight: 400, whiteSpace: 'normal' }}>{l.working}</div></th><td style={{ textAlign: 'right' }}>{amountWords(l.amount)}</td></tr>
            ))}
            <tr><th scope="row">Licence</th><td style={{ textAlign: 'right' }}>0</td></tr>
            <tr><th scope="row"><b>Total</b></th><td style={{ textAlign: 'right' }}><b>{amountWords(r.total)}</b></td></tr>
          </tbody>
        </table>
        <p style={{ margin: 0 }}><b>Cost per signature: {perSignatureWords(r.perSignature)}</b></p>
        <p style={{ margin: 0 }}>Licence cost per signature: 0</p>
        {r.servers.from === 'none' && <p className="muted small" style={{ margin: 0 }}>Servers needed: not yet measured. Enter your own number above.</p>}
        {r.servers.from === 'measured' && <p className="muted small" style={{ margin: 0 }}>Servers needed: {r.servers.n}, from our measurement of {MEASURED_SIGNATURES_PER_SERVER_YEAR?.toLocaleString('en')} signatures a year on one server.</p>}
        {started && missing.length > 0 && <p className="muted small" style={{ margin: 0 }}>Counted as 0 because the box is empty or not a number: {missing.join(', ')}.</p>}
        </>}
      </section>

      <details className="card">
        <summary>Compare with a price per document you were quoted</summary>
        <div className="tco-grid" style={{ marginTop: 12 }}>{COMPARE.map(box)}</div>
        {r.compare && <p style={{ marginBottom: 0 }}>At the price per document you entered: {amountWords(r.compare.amount)} a year, for {r.compare.envelopes.toLocaleString('en')} documents.</p>}
      </details>

      <div className="no-print"><button type="button" className="btn" onClick={() => window.print()}>Print or save as PDF</button></div>
    </div>
  );
}
