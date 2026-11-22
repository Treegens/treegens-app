'use client';
// "Get ready to sign without signal", from the More of someone who signs in person on the envelope page. The host
// chooses a PIN; the document and this person's part are fetched once and kept on this device, encrypted with it
// (src/components/sign/offlineInPerson.ts). Then the device opens /in-person, the page that also opens with no signal.
import { useEffect, useState } from 'react';
import { Modal, api, fmtDate } from '@/components/ui';
import { OFFLINE_WORDS, PIN_MIN } from '@/lib/offlinesign';
import { keep, idbBox, pinProblem, peek, canKeep } from '@/components/sign/offlineInPerson';
import '@/app/styles/inperson.css';

export function OfflineReady({ envelopeId, r, onClose }: { envelopeId: string; r: any; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<any[]>([]);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    api(`/envelopes/${envelopeId}/offline`).then((d) => setWaiting((d.waiting || []).filter((w: any) => w.recipient_id === r.id))).catch(() => {});
    peek(idbBox()).then((p) => setHeld(p.state !== 'none')).catch(() => {});
  }, [envelopeId, r.id]);

  async function go(ev: React.FormEvent) {
    ev.preventDefault();
    const problem = pinProblem(pin, again);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const pack = await api(`/envelopes/${envelopeId}/offline`, { body: { recipient_id: r.id } });
      await keep(idbBox(), pin, pack);
      // The page and the files it needs are fetched now, while there is signal, so the device has them later.
      await Promise.all(['/pdfjs/pdf.min.mjs', '/pdfjs/pdf.worker.min.mjs'].map((u) => fetch(u).catch(() => null)));
      window.location.assign('/in-person');
    } catch (e: any) {
      setError(e?.message || 'This could not be got ready. Check the connection, then try again.');
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    try {
      await api(`/envelopes/${envelopeId}/offline/${id}`, { method: 'DELETE' });
      setWaiting((w) => w.filter((x) => x.id !== id));
    } catch (e: any) {
      setError(e?.message || 'That did not work. Try again.');
    }
    setBusy(false);
  }

  return (
    <Modal title={OFFLINE_WORDS.action} onClose={onClose}>
      <form onSubmit={go} className="ofr" data-feature="ds-offline-inperson">
        <p>For when there is no signal where you meet {r.name}. Do this now, while you have signal, on the device they will sign on.</p>
        <p className="muted small">{OFFLINE_WORDS.kept(r.name)} Nothing is signed until the device has signal again and GrowSigning has it.</p>
        <p className="muted small">If you hand the device over with no signal, your account locks the first time GrowSigning opens on it with signal. Until then, only the page for signing is open on it.</p>
        {held && <p className="notice warn small">This device already holds a document got ready like this. Getting this one ready replaces it.</p>}
        {waiting.map((w) => (
          <p key={w.id} className="notice small">Already got ready on a device by {w.host || 'someone'} on {fmtDate(w.created_at, true)}. Doing it again here ends that copy.{' '}
            <button type="button" className="btn sm" disabled={busy} onClick={() => cancel(w.id)}>End that copy</button></p>
        ))}
        <label className="f"><span>Choose a PIN</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" minLength={PIN_MIN} value={pin} onChange={(e) => (setPin(e.target.value), setError(''))} aria-describedby="ofr-pin-hint" />
        </label>
        <p id="ofr-pin-hint" className="muted small">At least {PIN_MIN} numbers or letters. Do not tell {r.name}. If you forget it, get it ready again.</p>
        <label className="f"><span>Type the PIN again</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => (setAgain(e.target.value), setError(''))} />
        </label>
        {error && <p className="notice err" role="alert">{error}</p>}
        <div className="row ofr-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Getting it ready…' : 'Get it ready'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** The line in the More of someone who signs in person. Absent where this browser cannot keep a copy. */
export function OfflineReadyButton({ envelopeId, r }: { envelopeId: string; r: any }) {
  const [ok, setOk] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setOk(canKeep()), []);
  if (!ok) return null;
  return (
    <div className="sn-person-actions" data-feature="ds-offline-inperson">
      <button type="button" className="btn sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>{OFFLINE_WORDS.action}</button>
      {open && <OfflineReady envelopeId={envelopeId} r={r} onClose={() => setOpen(false)} />}
    </div>
  );
}
