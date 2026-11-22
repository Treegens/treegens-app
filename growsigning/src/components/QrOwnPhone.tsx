'use client';
import { useEffect, useId, useState } from 'react';
import { QrCode } from './QrCode';
import { qrForLink, OWN_PHONE_LINE, type QrLink } from '@/lib/qrlink';

// On a public form that is open on a big screen (a tablet at a front desk, a shared computer): the visitor can scan
// a code and fill the same form in on their own phone. The code is drawn here in the browser and holds the public
// link of the form, which is no secret. On a phone-sized screen the button is hidden (src/app/styles/qr.css).
export function QrOwnPhone({ slug, name }: { slug: string; name: string }) {
  const [made, setMade] = useState<QrLink | null>(null);
  const [open, setOpen] = useState(false);
  const box = useId();
  useEffect(() => setMade(qrForLink(`${window.location.origin}/f/${slug}`)), [slug]);
  // No button when no code can be made, or when the address only exists on this computer: a visitor could do
  // nothing about either.
  if (!made || !made.ok || made.reach === 'computer') return null;
  return (
    <div className="qr-own">
      <button type="button" className="btn qr-tap" aria-expanded={open} aria-controls={box} onClick={() => setOpen(!open)}>{open ? 'Hide the QR code' : 'Fill it in on your own phone instead'}</button>
      <div id={box} className="qr-own-box" hidden={!open}>
        {open && (
          <>
            <QrCode svg={made.svg} label={`QR code that holds the link to the form ${name}`} />
            <p>{OWN_PHONE_LINE}</p>
            {made.note ? <p>{made.note}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
