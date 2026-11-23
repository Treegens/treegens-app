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

async function copy(text: string, ok: string, failed: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    toast(failed, true);
  }
}

/** On the "Sent." card: the link with Copy when there is one, else the one button that makes it. */
export function ShareLinkLine({ envelope, onOpen }: { envelope: any; onOpen: () => void }) {
  const T = useST();
  const link: Link | null = envelope.share_link || null;
  if (envelope.status !== 'sent') return null;
  return link?.active ? (
    <p className="sn-share">
      <span>{T('sharelink.after_has')} <span className="sn-share-url">{shareLinkShown(link.url)}</span></span>
      <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => copy(link.url, T('sharelink.copied'), T('sharelink.copy_failed'))}>{T('sharelink.copy_button')}</button>
      {/* The code is drawn in the dialog, which also renames the link and switches it off. */}
      <button type="button" className="btn sm qr-tap" style={{ minHeight: 44 }} aria-haspopup="dialog" onClick={onOpen}>{T('sharelink.qr_button')}</button>
    </p>
  ) : (
    <p className="sn-share">
      <span>{T('sharelink.after_line')}</span>
      <button type="button" className="btn sm" style={{ minHeight: 44 }} aria-haspopup="dialog" onClick={onOpen}>{T('sharelink.get_button')}</button>
    </p>
  );
}

/** The dialog: make the link, copy it, show its QR code, rename it, switch it off or on. */
export function ShareLinkDialog({ kind, id, onClose, onChanged }: { kind: Kind; id: string; onClose: () => void; onChanged?: (link: Link | null) => void }) {
  const T = useST();
  const [data, setData] = useState<{ share_link: Link | null; suggestion: string | null; can_share: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; suggestion?: string } | null>(null);
  useEffect(() => {
    api(pathOf(kind, id)).then((d) => (setData(d), setName(d.share_link?.name || d.suggestion || ''))).catch(() => setFailed(true));
  }, [kind, id]);
  const link = data?.share_link || null;
  const qr = useMemo(() => (link?.active ? qrForLink(link.url) : null), [link?.url, link?.active]);

  const save = (body: { name?: string; active?: boolean }, said: string) => {
    setBusy(true);
    setError(null);
    api(pathOf(kind, id), { method: 'PUT', body })
      .then((d) => (setData(d), setName(d.share_link?.name || ''), toast(said), onChanged?.(d.share_link || null)))
      .catch((e: any) => setError({ text: e?.status ? e.message : T('sharelink.load_failed'), suggestion: e?.data?.suggestion || undefined }))
      .finally(() => setBusy(false));
  };
  const nameBox = (label: string, said: string) => (
    <form className="shl-name" onSubmit={(ev) => (ev.preventDefault(), save({ name }, said))}>
      <label className="f"><span>{T('sharelink.name_label')} <span className="hint">({T('sharelink.name_hint')})</span></span>
        <input value={name} onChange={(e) => (setName(e.target.value), setError(null))} maxLength={80} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={!!error} aria-describedby="shl-says" /></label>
      <button className={`btn${link ? '' : ' primary'}`} disabled={busy || !name.trim() || name === link?.name}>{label}</button>
    </form>
  );
  const says = (
    <div id="shl-says">
      {error && <div className="notice err" role="alert" style={{ marginTop: 10 }}>{error.text}{error.suggestion && error.suggestion !== name ? <> <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => (setName(error.suggestion!), setError(null))}>{T('sharelink.use_suggestion', { name: error.suggestion })}</button></> : null}</div>}
    </div>
  );

  return (
    <Dialog title={T('sharelink.title')} onClose={onClose}>
      {failed ? <div className="notice err" role="alert">{T('sharelink.load_failed')}</div>
        : !data ? <p className="muted">{T('sharelink.loading')}</p>
        : !data.can_share && !link ? <p>{T('sharelink.not_yet')}</p>
        : !link ? (
          <>
            <p>{T(kind === 'form' ? 'sharelink.what_form' : 'sharelink.what_doc')}</p>
            {nameBox(T('sharelink.make_button'), T('sharelink.made'))}
            {says}
          </>
        ) : (
          <>
            {!data.can_share && <div className="notice warn">{T('sharelink.closed')}</div>}
            {link.active ? (
              <>
                <div className="shl-link">
                  <b>{shareLinkShown(link.url)}</b>
                  <button type="button" className="btn primary" data-autofocus="" onClick={() => copy(link.url, T('sharelink.copied'), T('sharelink.copy_failed'))}>{T('sharelink.copy_button')}</button>
                </div>
                {qr?.ok && <div className="shl-qr"><QrCode svg={qr.svg} label={T('sharelink.qr_alt', { link: shareLinkShown(link.url) })} /><span className="muted small">{T('sharelink.qr_hint')}</span></div>}
                {qr?.ok && qr.note ? <div className="notice warn">{qr.note}</div> : null}
              </>
            ) : <div className="notice warn">{T('sharelink.is_off')}</div>}
            <p className="muted small">{T(kind === 'form' ? 'sharelink.what_form' : 'sharelink.what_doc')}</p>
            {data.can_share && (
              <details className="shl-fold" data-fold="">
                <summary>{T('sharelink.rename_fold')}</summary>
                {nameBox(T('sharelink.save_button'), T('sharelink.renamed'))}
                <p className="muted small" style={{ marginTop: 6 }}>{T('sharelink.rename_warn')}</p>
                {says}
                <button type="button" className="btn shl-off" disabled={busy} onClick={() => save({ active: !link.active }, T(link.active ? 'sharelink.now_off' : 'sharelink.now_on'))}>{T(link.active ? 'sharelink.off_button' : 'sharelink.on_button')}</button>
              </details>
            )}
          </>
        )}
    </Dialog>
  );
}
