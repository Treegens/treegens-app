'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QrCode } from '@/components/QrCode';
import { Dialog } from './Dialog';
import { qrForLink, personScanLine, personCodeWarning, hiddenLine, afterScanLine, SCAN_TROUBLE, QR_SHOW_SECONDS } from '@/lib/qrlink';

// One recipient's signing link as a QR code, for someone who is standing next to the sender: they scan it and
// carry on with their own phone. The code is drawn here in the browser from the link. The code is the link, so the
// dialog says who may see it, and takes it off the screen by itself after QR_SHOW_SECONDS.
export function QrDialog({ recipient: r, link, opener, onClose }: { recipient: { name: string; role: string; status?: string; access_code?: string | null; verify?: string | null }; link: string; opener?: { current: HTMLElement | null }; onClose: () => void }) {
  const made = useMemo(() => qrForLink(link), [link]);
  // The button that opened the dialog is switched off while the link is fetched, so the browser had already moved
  // focus away from it. Once the dialog has gone, focus goes back to that button, so a keyboard user carries on
  // from where they were and not from the top of the page.
  const done = () => {
    const back = opener?.current;
    onClose();
    setTimeout(() => back?.isConnected && back.focus(), 0);
  };
  const [hidden, setHidden] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (hidden) return;
    const t = setTimeout(() => setHidden(true), QR_SHOW_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [hidden]);
  // The button that brings the code back goes away when it is used. Focus moves to Close, so it stays in the dialog.
  const showAgain = () => (setHidden(false), close.current?.focus());
  const name = r.name || 'this person';
  // Someone who has signed can be handed their link again, for their copy. The words then say what is left to do.
  const finished = r.status === 'completed';

  return (
    <Dialog title={`QR code for ${name}`} onClose={done}>
      <div className="qr-dialog">
        {!made.ok ? <div className="notice err" role="alert">{made.why}</div> : (
          <>
            <p>{personScanLine(r.name, r.role, finished)}</p>
            {hidden ? (
              <div className="qr-gone" role="status">
                <p>{hiddenLine(r.name)}</p>
                <button type="button" className="btn qr-tap" onClick={showAgain}>Show the code again</button>
              </div>
            ) : <QrCode svg={made.svg} label={`QR code that holds the personal link for ${name}`} />}
            <div className="notice warn">{personCodeWarning(r.name, r.role, finished)}</div>
            {afterScanLine(r) ? <p>{afterScanLine(r)}</p> : null}
            {made.note ? <div className="notice warn">{made.note}</div> : null}
            <p className="muted small">{SCAN_TROUBLE}</p>
          </>
        )}
        <div className="actions">
          <button type="button" ref={close} className="btn primary qr-tap" onClick={done} data-autofocus="">Close</button>
        </div>
      </div>
    </Dialog>
  );
}
