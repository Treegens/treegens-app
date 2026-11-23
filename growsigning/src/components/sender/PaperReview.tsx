'use client';
// The envelope page when someone sent back a scan signed on paper (research/ux-notes.json, ds-paper): the page's one
// main button is "Look at the scan", and it opens the scan with "Accept as signed by <name>" and "Ask again". Only
// while a scan waits; with nothing set up or nothing waiting this draws nothing. The rules are in src/server/paper.ts.
import { useEffect, useState } from 'react';
import { api, toast, fmtDate } from '@/components/ui';
import { Dialog } from './Dialog';
import { explain } from './lib';
import { PAPER_WORDS, PAPER_REASON_MAX } from '@/lib/paper';

/** The person whose scan waits for the sender, if anyone's does. */
export const scanWaiting = (e: any): any => (e?.status === 'sent' ? (e.recipients || []).find((r: any) => r.paper_state === 'waiting' && (r.status === 'sent' || r.status === 'viewed')) || null : null);

/** For a list row (Home, Documents) whose scan waits: it waits for the sender, so the words say so and there is no Remind. */
export const scanRowText = (r: any): string => `Waiting for you: look at the scan ${r.name || 'they'} signed on paper`;

/** The headline of "Where this stands" while a scan waits. */
export const scanHeadline = (r: any): string => `${r.name || 'Someone'} signed on paper. Look at the scan to accept it or ask again.`;

/** The line under "Where this stands" while a scan waits. */
export function PaperWaitingLine({ r, after }: { r: any; after: boolean }) {
  if (!after) return null;
  return <p className="sn-now-sub warn" data-feature="ds-paper">Until then nobody after {r.name} is asked.</p>;
}

/** The main button and its dialog. */
export function PaperReview({ e, r, onDone }: { e: any; r: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn primary" data-feature="ds-paper" onClick={() => setOpen(true)}>{PAPER_WORDS.look}</button>
      {open && <ScanDialog e={e} r={r} onClose={() => setOpen(false)} onDone={() => (setOpen(false), onDone())} />}
    </>
  );
}

function ScanDialog({ e, r, onClose, onDone }: { e: any; r: any; onClose: () => void; onDone: () => void }) {
  const [scan, setScan] = useState<any>(null);
  const [again, setAgain] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wide, setWide] = useState(false);
  useEffect(() => setWide(window.innerWidth >= 700), []);
  useEffect(() => {
    api(`/envelopes/${e.id}/paper`).then((d) => setScan((d.scans || []).find((s: any) => s.recipient_id === r.id && s.state === 'waiting') || null)).catch(() => setScan(null));
  }, [e.id, r.id]);
  const url = `/api/envelopes/${e.id}/recipients/${r.id}/paper/scan`;
  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/envelopes/${e.id}/recipients/${r.id}/paper/accept`, { body: {} });
      toast(`Done. ${r.name} is marked as having signed on paper.`);
      onDone();
    } catch (x: any) {
      setError(explain(x, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    if (!reason.trim()) return setError('Say why you ask again, so they know what to do differently.');
    setBusy(true);
    setError('');
    try {
      const d = await api(`/envelopes/${e.id}/recipients/${r.id}/paper/reject`, { body: { reason: reason.trim() } });
      toast(d.emailed ? `Done. We emailed ${r.name} your reason.` : `Done. ${r.name} sees your reason when they open their link.`);
      onDone();
    } catch (x: any) {
      setError(explain(x, 'Nothing was sent.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Scan from ${r.name}`} onClose={onClose} wide>
      <p>{r.name} uploaded {scan ? `${scan.pages} page${scan.pages === 1 ? '' : 's'} on ${fmtDate(scan.at, true)}` : 'a scan'} through their own link. Look at every page.</p>
      {/* On a wide screen the scan is shown here; a phone opens it in its own viewer, which pages through a PDF better. */}
      {wide && (
        <div className="sn-scan" style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, overflow: 'hidden', background: '#f6f6f4' }}>
          <iframe src={`${url}#view=FitH`} title={`Scan from ${r.name}`} style={{ width: '100%', height: 'min(60vh, 520px)', border: 0, display: 'block' }} />
        </div>
      )}
      <p style={{ margin: '6px 0 0' }}><a className={wide ? 'small' : 'btn'} style={wide ? undefined : { minHeight: 44 }} href={url} target="_blank" rel="noreferrer">Open the scan{wide ? ' in a new tab' : ''}<span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}> (opens in a new tab)</span></a></p>
      {scan && <p className="small" style={{ margin: '8px 0 0' }}>The code at the top of each page should read <b>{scan.code}</b>.</p>}
      {scan && !scan.current && <div className="notice warn" role="note">You changed the document after {r.name} printed it, so this scan is of an older version. Ask again, so they print the new one.</div>}
      <p className="muted small">{PAPER_WORDS.notChecked}</p>
      {again && (
        <label className="f">
          <span>Why do you ask again? <span className="hint">({r.name} sees this)</span></span>
          <textarea value={reason} maxLength={PAPER_REASON_MAX} autoFocus onChange={(x) => (setReason(x.target.value), setError(''))} placeholder="For example: page 2 is cut off at the bottom" />
        </label>
      )}
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        {again ? (
          <>
            <button type="button" className="btn" onClick={() => (setAgain(false), setError(''))}>Back</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void ask()}>{busy ? 'Sending' : `Send to ${r.name}`}</button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setAgain(true)}>{PAPER_WORDS.again}</button>
            <button type="button" className="btn primary" disabled={busy || (scan && !scan.current)} onClick={() => void accept()}>{busy ? 'Accepting' : PAPER_WORDS.accept(r.name)}</button>
          </>
        )}
      </div>
    </Dialog>
  );
}
