'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, oops } from '@/components/ui';
import { RECEIPT_SIZES } from '@/lib/counter';

// The receipt after Finish (GET /counter/visits/:id/receipt): what the person takes home. Printed at the width of a
// receipt printer (80 mm) or on an A4 sheet; only the receipt is on paper (counter.css, body.ct-printing).
export function Receipt({ visitId }: { visitId: string }) {
  const [r, setR] = useState<any>(null);
  const [size, setSize] = useState<'80mm' | 'a4'>('80mm');
  useEffect(() => {
    api(`/counter/visits/${visitId}/receipt`).then(setR).catch(oops);
  }, [visitId]);
  function print() {
    const page = document.createElement('style');
    // "80mm auto" is not valid CSS and is dropped by the browser: a roll is given a fixed length, long enough for
    // the receipt, and a receipt printer cuts after the last line.
    page.textContent = `@page { size: ${size === 'a4' ? 'A4' : '80mm 200mm'}; margin: ${size === 'a4' ? '15mm' : '4mm'}; }`;
    document.head.appendChild(page);
    document.body.classList.add('ct-printing');
    const done = () => {
      document.body.classList.remove('ct-printing');
      page.remove();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }
  if (!r) return null;
  return (
    <div className="card stack" data-feature="gov-G18">
      <h2>Receipt</h2>
      <fieldset className="ct-radio">
        <legend>Paper</legend>
        {RECEIPT_SIZES.map((s) => (
          <label key={s.key}><input type="radio" name="ct-size" checked={size === s.key} onChange={() => setSize(s.key)} /> {s.label}</label>
        ))}
      </fieldset>
      <div><button type="button" className="btn primary" onClick={print}>Print the receipt</button></div>
      <div className={`ct-receipt ${size === 'a4' ? 'ra4' : 'r80'}`} aria-label="Receipt">
        <h2>{r.agency || 'Receipt'}</h2>
        <div>{r.subject}</div>
        <dl>
          <dt>Signed by</dt><dd>{r.name}, {fmtDate(r.signed_at, true)}</dd>
          <dt>Envelope ID</dt><dd className="mono">{r.envelope_id}</dd>
          <dt>Fingerprint (SHA-256)</dt><dd className="mono">{r.fingerprint || 'Made once everyone on the document has signed.'}</dd>
          <dt>Your copy</dt><dd>{r.copy ? `${r.copy} ` : ''}{r.check}</dd>
          {r.contact && <><dt>Questions</dt><dd>{r.contact}</dd></>}
        </dl>
        <div>{r.note}</div>
      </div>
    </div>
  );
}
