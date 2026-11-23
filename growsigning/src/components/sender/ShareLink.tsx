'use client';
// The sender's side of a share link (growsigning.com/<name>, src/server/sharelinks.ts): one line on the card a sender
// lands on after sending, and one dialog, also in the document's More and in a form's More, that shows the link with
// Copy and its QR code and lets the sender rename it or switch it off. The rules and the words of a refusal are the
// server's.
import { useEffect, useMemo, useState } from 'react';
import { api, toast } from '../ui';
import { Dialog } from './Dialog';
import { QrCode } from '../QrCode';
import { qrForLink } from '@/lib/qrlink';
import { shareLinkShown } from '@/lib/sharename';
import { useST } from '../senderLang';

type Link = { name: string; url: string; active: boolean };
type Kind = 'envelope' | 'form';
const pathOf = (kind: Kind, id: string) => `/${kind === 'form' ? 'powerforms' : 'envelopes'}/${id}/share-link`;

// "Copy link": the button itself says "Copied" for two seconds, so nothing lies across the dialog. Only a copy
// that did not work is a toast, because then the person has to do something else.
function CopyButton({ url, className, autofocus }: { url: string; className: string; autofocus?: boolean }) {
  const T = useST();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [done]);
  const press = () => navigator.clipboard.writeText(url).then(() => setDone(true)).catch(() => toast(T('sharelink.copy_failed'), true));
  return (
    <button type="button" className={className} style={{ minHeight: 44 }} {...(autofocus ? { 'data-autofocus': '' } : {})} onClick={press}>
      <span aria-live="polite">{T(done ? 'sharelink.copied' : 'sharelink.copy_button')}</span>
    </button>
  );
}

/**
 * On the "Sent." card, once the document has a share link: the link, Copy link and its QR code on one line. A
 * document gets its link from "Share link" in More (one press), or by itself with SHARE_LINKS_AUTO=1. Until then the
 * card stays as short as it was (tests/ux/ceilings.json).
 */
export function ShareLinkLine({ envelope, onOpen }: { envelope: any; onOpen: () => void }) {
  const T = useST();
  const link: Link | null = envelope.share_link || null;
  if (envelope.status !== 'sent' || !link?.active) return null;
  return (
    <p className="sn-share">
      <span>{T('sharelink.after_has')} <span className="sn-share-url">{shareLinkShown(link.url)}</span></span>
      <CopyButton url={link.url} className="btn sm" />
      {/* The code is drawn in the dialog, which also renames the link and switches it off. */}
      <button type="button" className="btn sm qr-tap" style={{ minHeight: 44 }} aria-haspopup="dialog" onClick={onOpen}>{T('sharelink.qr_button')}</button>
    </p>
  );
}

/**
 * The dialog. Opening it for a document or form that has no link yet makes the link, with the name that comes out
 * of the document's name: the sender asked for a share link and gets one to copy, with nothing to fill in first.
 * Renaming and switching off are in the fold below.
 */
export function ShareLinkDialog({ kind, id, onClose, onChanged }: { kind: Kind; id: string; onClose: () => void; onChanged?: (link: Link | null) => void }) {
  const T = useST();
  const [data, setData] = useState<{ share_link: Link | null; suggestion: string | null; can_share: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; suggestion?: string } | null>(null);
  const take = (d: any) => (setData(d), setName(d.share_link?.name || d.suggestion || ''), d);
  useEffect(() => {
    let gone = false;
    api(pathOf(kind, id))
      .then((d) => (d.share_link || !d.can_share ? d : api(pathOf(kind, id), { method: 'PUT', body: {} }).then((made) => (onChanged?.(made.share_link || null), made))))
      .then((d) => !gone && take(d))
      .catch(() => !gone && setFailed(true));
    return () => void (gone = true);
  }, [kind, id]);
  const link = data?.share_link || null;
  const qr = useMemo(() => (link?.active ? qrForLink(link.url) : null), [link?.url, link?.active]);
  // "growsigning.com/" in front of the box: the name is the rest of the address, and that says how to write it.
  const front = link ? shareLinkShown(link.url).slice(0, -link.name.length) : '';

  const save = (body: { name?: string; active?: boolean }, said: string) => {
    setBusy(true);
    setError(null);
    api(pathOf(kind, id), { method: 'PUT', body })
      .then((d) => (take(d), toast(said), onChanged?.(d.share_link || null)))
      .catch((e: any) => setError({ text: e?.status ? e.message : T('sharelink.load_failed'), suggestion: e?.data?.suggestion || undefined }))
      .finally(() => setBusy(false));
  };
  const offer = error?.suggestion && error.suggestion !== name && error.suggestion !== link?.name ? error.suggestion : '';

  return (
    <Dialog title={T('sharelink.title')} onClose={onClose}>
      {failed ? <div className="notice err" role="alert">{T('sharelink.load_failed')}</div>
        : !data ? <p className="muted">{T('sharelink.loading')}</p>
        : !link ? <p>{T('sharelink.not_yet')}</p>
        : (
          <>
            {!data.can_share && <div className="notice warn">{T('sharelink.closed')}</div>}
            {link.active ? (
              <>
                <div className="shl-link">
                  <b>{shareLinkShown(link.url)}</b>
                  <CopyButton url={link.url} className="btn primary" autofocus />
                </div>
                {qr?.ok && <div className="shl-qr"><QrCode svg={qr.svg} label={T('sharelink.qr_alt', { link: shareLinkShown(link.url) })} /></div>}
                {qr?.ok && qr.note ? <div className="notice warn">{qr.note}</div> : null}
                {data.can_share && <p className="muted small">{T(kind === 'form' ? 'sharelink.what_form' : 'sharelink.what_doc')}</p>}
              </>
            ) : <div className="notice warn">{T('sharelink.is_off')}</div>}
            {data.can_share ? (
              <details className="shl-fold" data-fold="">
                <summary>{T('sharelink.rename_fold')}</summary>
                <form className="shl-name" onSubmit={(ev) => (ev.preventDefault(), save({ name }, T('sharelink.renamed')))}>
                  <label className="f"><span>{T('sharelink.name_label')}</span>
                    <span className="shl-box"><span className="muted" aria-hidden="true">{front}</span>
                      <input value={name} onChange={(e) => (setName(e.target.value), setError(null))} maxLength={80} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={!!error} aria-describedby="shl-says" /></span></label>
                  <button className="btn" disabled={busy || !name.trim() || name === link.name}>{T('sharelink.save_button')}</button>
                </form>
                {/* A refusal sits right under the box it is about, with the way forward as one press. */}
                <div id="shl-says">
                  {error && <div className="notice err" role="alert" style={{ marginTop: 10 }}>{error.text}{offer ? <> <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => (setName(offer), setError(null))}>{T('sharelink.use_suggestion', { name: offer })}</button></> : null}</div>}
                </div>
                <p className="muted small" style={{ marginTop: 6 }}>{T('sharelink.rename_warn')}</p>
                <button type="button" className="btn shl-off" disabled={busy} onClick={() => save({ active: !link.active }, T(link.active ? 'sharelink.now_off' : 'sharelink.now_on'))}>{T(link.active ? 'sharelink.off_button' : 'sharelink.on_button')}</button>
              </details>
            ) : link.active ? (
              <button type="button" className="btn shl-off" disabled={busy} onClick={() => save({ active: false }, T('sharelink.now_off'))}>{T('sharelink.off_button')}</button>
            ) : null}
          </>
        )}
    </Dialog>
  );
}
