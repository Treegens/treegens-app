'use client';
import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { QrCode } from '@/components/QrCode';
import { QR_QUIET, type Qr } from '@/lib/qr';
import { qrForLink, qrFileName, formCodeWarning, FORM_SCAN_LINE, FORM_LINK_LINE, FORM_PAUSED_LINE } from '@/lib/qrlink';

// The code as a PNG picture, for a poster of the owner's own. Drawn on a canvas here in the browser, 16 pixels to a
// module with the light margin a reader needs. It holds the code only: no name and no link in words.
function savePicture(qr: Qr, name: string) {
  const unit = 16;
  const side = (qr.size + 2 * QR_QUIET) * unit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  const g = canvas.getContext('2d');
  const sorry = () => toast('Your browser did not let us save the picture. Print the sheet instead, or take a screenshot of the code.', true);
  if (!g) return sorry();
  g.fillStyle = '#fff';
  g.fillRect(0, 0, side, side);
  g.fillStyle = '#000';
  qr.modules.forEach((row, y) => row.forEach((on, x) => on && g.fillRect((x + QR_QUIET) * unit, (y + QR_QUIET) * unit, unit, unit)));
  canvas.toBlob((blob) => {
    if (!blob) return sorry();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = qrFileName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast('Picture saved. It holds the code only, so write the name of the form and the link next to it yourself.');
  }, 'image/png');
}

// A sheet to print and put up: the name of the form, its QR code, one line on what scanning does, and the link
// written out. What is on the sheet is for the people who scan it. What is around it on the screen is for the
// owner and is never printed (src/app/styles/qr.css, "@media print").
export default function PowerFormQr() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const [data, , error] = useLoad(() => api('/powerforms'));
  const p = data?.powerforms.find((x: any) => x.id === id);
  // The address the server gives is the public one (APP_URL), the same one its emails use.
  const made = useMemo(() => (p ? qrForLink(p.url || `${window.location.origin}/f/${p.slug}`) : null), [p]);
  useEffect(() => {
    document.body.classList.add('qr-printing');
    return () => document.body.classList.remove('qr-printing');
  }, []);

  const back = <Link href="/app/powerforms" className="qr-back qr-noprint">Back to PowerForms</Link>;
  if (error) return <div className="qr-page">{back}<div className="card" role="alert"><h1 className="serif" style={{ fontSize: 22 }}>We could not load your forms</h1><p className="muted" style={{ margin: '8px 0 0' }}>{error.message || 'Something went wrong.'} Check your connection and open this page again.</p></div></div>;
  if (!data) return <div className="qr-page muted" role="status">Loading…</div>;
  if (!p || !made) return <div className="qr-page">{back}<div className="card"><h1 className="serif" style={{ fontSize: 22 }}>This form is not here any more</h1><p className="muted" style={{ margin: '8px 0 0' }}>It may have been deleted. A code that was printed for it opens a page that says the form is not available.</p></div></div>;

  return (
    <div className="qr-page">
      {back}
      <h1 className="serif qr-noprint">QR code for &ldquo;{p.name}&rdquo;</h1>
      {!made.ok ? <div className="notice err" role="alert" style={{ marginTop: 14 }}>{made.why}</div> : (
        <>
          <div className="qr-tools qr-noprint">
            <button type="button" className="btn primary qr-tap" onClick={() => window.print()}>Print this sheet</button>
            <button type="button" className="btn qr-tap" onClick={() => savePicture(made.qr, p.name)}>Save the code as a picture</button>
            <button type="button" className="btn qr-tap" onClick={() => navigator.clipboard.writeText(made.link).then(() => toast('Link copied'), () => toast('Your browser did not let us copy. The link is written out on the sheet, so you can select it there.', true))}>Copy link</button>
          </div>
          {!p.active && <div className="notice warn qr-noprint" role="status">{FORM_PAUSED_LINE}</div>}
          {made.note && <div className="notice warn qr-noprint" role="status">{made.note}</div>}
          <div className="notice qr-noprint">{formCodeWarning(!!me.billing?.enabled)} The sheet below is what gets printed: this note and the buttons stay off the paper.</div>
          <section className="qr-sheet" aria-label="The sheet as it is printed">
            <p className="qr-sheet-from">{me.account.name}</p>
            <h2 className="serif qr-sheet-name">{p.name}</h2>
            <QrCode svg={made.svg} label={`QR code that holds the link to the form ${p.name}`} />
            <p className="qr-sheet-scan">{FORM_SCAN_LINE}</p>
            <p className="qr-sheet-small">{FORM_LINK_LINE}</p>
            <p className="qr-sheet-link">{made.link}</p>
          </section>
        </>
      )}
    </div>
  );
}
