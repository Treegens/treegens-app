'use client';
// Keep and delete, on the page of one document (src/server/records.ts): one sentence under its status that carries
// the delete or hold date, the notes inside the page's one Delete dialog, and the dialogs that the page's More opens
// (Keep it, Hold, Lift the hold, Delete its files for good). With no deletion schedule, no hold and nothing asked
// for, none of this draws anything. The words are in src/lib/retention.ts, which the server and the emails use too.
import { useState } from 'react';
import { api, toast } from '@/components/ui';
import { Dialog } from './Dialog';
import { explain, longDate } from './lib';
import { LEVEL_NAME, LEVEL_DOES, removesAt, KEPT_AT, HOLD_SHORT, HOLD_TRUTH, HOLD_BACKUPS, HOLD_OVERRIDE, SCREEN_LEVELS, RETENTION_NOTICE_DAYS, daysText, copiesKept, type PurgeLevel } from '@/lib/retention';

type R = {
  closed_at: string | null; period: { days: number; from: 'account' | 'template'; template?: string } | null; due_at: string | null; rule_level: PurgeLevel | null;
  noticed_at: string | null; goes_at: string | null; level: PurgeLevel | null; kept_until: string | null; kept_reason: string | null; kept_by: string | null;
  asked: { at: string; by: string; level: PurgeLevel } | null; holds: any[]; held: boolean; disputed: boolean; schedule_on?: boolean;
  purged_at: string | null; purged_level: PurgeLevel | null; purged_sha256: string | null; may_purge: boolean; may_hold: boolean; stays: string[];
};

/** Which of the dialogs is open. The document page's More, its Delete dialog and a link with ?ask= open them. */
export type RetentionAsk = '' | 'keep' | 'purge' | 'hold' | 'lift';

/** Whether a deletion schedule or a request reaches this document: only then are Keep it and Hold listed anywhere. */
export const scheduleOn = (r: R | null | undefined): boolean => !!r && !!(r.schedule_on || r.period || r.noticed_at || r.asked);

/** What the page may offer: keeping it past the schedule, and deleting its files for good. */
export function deleteOffers(r: R | null | undefined): { keep: boolean; purge: boolean } {
  if (!r || r.purged_at) return { keep: false, purge: false };
  return { keep: !!r.closed_at && !r.held && !!(r.noticed_at || r.due_at || r.asked), purge: !!r.may_purge && !r.asked && !r.disputed };
}

/** What a link with ?ask= may open on this document for this person, or '' when it does not apply (then nothing opens). */
export function askAllowed(ask: string | null, r: R | null | undefined, envelopeId: string): RetentionAsk {
  if (!r || r.purged_at) return '';
  const o = deleteOffers(r);
  if (ask === 'keep') return o.keep ? 'keep' : '';
  if (ask === 'purge') return o.purge ? 'purge' : '';
  if (ask === 'hold') return r.may_hold && !r.holds.some((h) => h.envelope_id === envelopeId) ? 'hold' : '';
  return '';
}

/** The day the links of the people on it stop, when one is set: what the Delete dialog says they keep until. */
export const linkEnds = (r: R | null | undefined): string | null => (!r || r.purged_at || r.held ? null : r.goes_at || r.due_at || null);

/** What the page tells its sender after deleting it from their account. */
export const deletedToast = (r: R | null | undefined) => (linkEnds(r) ? `Deleted from your account. Everyone who was on it keeps their link until ${longDate(linkEnds(r))}.` : 'Deleted from your account. Everyone who was on it keeps their copy.');
/** The sentence of the Delete dialog about the copies of the people on it, with the day in the reader's own format. */
export const copiesLine = (r: R | null | undefined) => copiesKept(linkEnds(r) ? longDate(linkEnds(r)) : null);

// When a dialog that the page's More opened closes, the line that opened it is gone: focus goes to More itself.
const backToMore = () => requestAnimationFrame(() => {
  if (document.activeElement && document.activeElement !== document.body) return;
  document.querySelector<HTMLElement>('.sn-headactions [data-more="screen"]')?.focus();
});

/**
 * One sentence under the status of the document: the day its files are deleted, that it is on hold, or that they
 * were deleted. Nothing with no schedule, no hold and nothing asked for.
 */
export function RetentionLine({ envelopeId, r, onChanged, onAsk }: { envelopeId: string; r: R | null | undefined; onChanged: () => void; onAsk: (a: RetentionAsk) => void }) {
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/envelopes/${envelopeId}/purge`, { method: 'DELETE' });
      toast('Called off. Nothing will be deleted.');
      onChanged();
    } catch (e) {
      toast(explain(e, 'Nothing was changed.'), true);
    } finally {
      setBusy(false);
    }
  };
  const level = (r.level || r.rule_level || 'documents') as PurgeLevel;
  const h = r.holds[0];
  const line = r.purged_at ? <>Its files were deleted on {longDate(r.purged_at)}. This cannot be undone.</>
    : r.held ? <>On hold since {longDate(h.set_at)} ({h.set_by}{h.folder ? <>, with its folder &ldquo;{h.folder}&rdquo;</> : null}). It cannot be deleted until the hold ends.</>
    : r.asked ? <>{r.asked.by} asked to delete its files. On {longDate(r.goes_at)}, {LEVEL_DOES[r.asked.level]}. <button type="button" className="sn-linkbtn" disabled={busy} onClick={cancel}>Call it off</button></>
    : r.disputed && r.period ? <>Not deleted while the dispute about it is open.</>
    : r.noticed_at && r.goes_at ? <>On {longDate(r.goes_at)}, {LEVEL_DOES[level]}. {deleteOffers(r).keep && <button type="button" className="sn-linkbtn" onClick={() => onAsk('keep')}>Keep it</button>}</>
    : r.due_at && r.period ? <>On {longDate(r.due_at)}, {LEVEL_DOES[level]}.{r.kept_until && r.kept_by ? ` Kept until then by ${r.kept_by}.` : ''}</>
    : null;
  return line ? <p className="sn-ret-line" data-feature="ds-retention">{line}</p> : null;
}

/**
 * Inside the page's one Delete dialog, only when a deletion schedule or a request reaches the document: the day
 * its files go anyway, with "Keep it instead", and the way to delete its files for good.
 */
export function DeleteNotes({ r, onKeep, onPurge }: { r: R | null | undefined; onKeep: () => void; onPurge: () => void }) {
  if (!r || r.purged_at || !scheduleOn(r)) return null;
  const day = r.goes_at || r.due_at;
  const { keep, purge } = deleteOffers(r);
  if (!(day && keep) && !purge) return null;
  return (
    <div className="ret-in-delete" data-feature="ds-retention">
      {day && keep && <p>Rather keep it past {longDate(day)}? <button type="button" className="btn sm" onClick={onKeep}>Keep it instead</button></p>}
      {purge && <p className="muted">Need the files gone for everyone? <button type="button" className="sn-linkbtn" onClick={onPurge}>Delete its files for good</button> ({RETENTION_NOTICE_DAYS}-day wait)</p>}
    </div>
  );
}

const Lists = ({ r, level }: { r: R; level: PurgeLevel }) => (
  <>
    <p className="small"><b>Deleted:</b></p>
    <ul className="rules small">{removesAt(level).map((s) => <li key={s}>{s}</li>)}</ul>
    <p className="small">{KEPT_AT[level]}</p>
    <p className="small"><b>What stays:</b></p>
    <ul className="rules small">{r.stays.map((s) => <li key={s}>{s}</li>)}</ul>
  </>
);

/** The dialogs, and for a document whose files were deleted one folded section that says what went and what stays. */
export function RetentionCard({ envelopeId, r, onChanged, ask, onAsk }: { envelopeId: string; r: R | null | undefined; onChanged: () => void; ask?: RetentionAsk; onAsk?: (a: RetentionAsk) => void }) {
  const [own_, setOwn_] = useState<RetentionAsk>('');
  // The page may hold which dialog is open (its More opens them); without that, this holds it itself.
  const open = onAsk ? ask || '' : own_;
  const setOpen = onAsk || setOwn_;
  if (!r) return null;
  const close = () => (setOpen(''), backToMore());

  if (r.purged_at) {
    const level = (r.purged_level || 'documents') as PurgeLevel;
    return (
      <details className="card sn-fold ret" data-fold="" data-feature="ds-retention">
        <summary><span>What was deleted and what stays</span></summary>
        <div className="sn-fold-in">
          <Lists r={r} level={level} />
          {r.purged_sha256 && <p className="small">The fingerprint (SHA-256) of the signed PDF that was deleted: <span className="mono ret-sha">{r.purged_sha256}</span>. Anyone who still has that file can check it at Verify a document.</p>}
        </div>
      </details>
    );
  }

  return (
    <>
      {open === 'keep' && <ReasonDialog title="Keep this document" label="Why it is kept" note={`It is kept for ${r.period ? daysText(r.period.days) : 'now'}${r.period ? ' from today' : ''}, and any deletion announced or asked for is called off. The reason goes into its history, which its sender and the admins can read.`} confirm="Keep it" url={`/envelopes/${envelopeId}/keep`} onClose={close} onDone={() => (close(), toast('Kept. Nothing will be deleted from it for now.'), onChanged())} />}
      {open === 'hold' && <HoldDialog url={`/envelopes/${envelopeId}/hold`} title="Hold this document" onClose={close} onDone={() => (close(), toast('On hold. The software refuses to delete it until an admin lifts the hold.'), onChanged())} />}
      {open === 'lift' && <ReasonDialog title="Lift the hold" label="Why it may be lifted" note="Once the hold is lifted, it can be deleted again by the usual rules. If the deletion schedule had reached it, the sender and the admins are emailed again at least 14 days before anything is deleted." confirm="Lift the hold" method="DELETE" url={`/envelopes/${envelopeId}/hold`} onClose={close} onDone={() => (close(), toast('The hold is lifted.'), onChanged())} />}
      {open === 'purge' && <PurgeDialog envelopeId={envelopeId} r={r} onClose={close} onDone={(at) => (close(), toast(`Its files will be deleted on ${longDate(at)}. You can call it off until then.`), onChanged())} />}
    </>
  );
}

export function ReasonDialog({ title, label, note, confirm, url, method = 'POST', onClose, onDone }: { title: string; label: string; note: string; confirm: string; url: string; method?: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (reason.trim().length < 3) return setError('The reason is missing. Write it in a few words, then try again.');
    setBusy(true);
    setError('');
    try {
      await api(url, { method, body: { reason: reason.trim() } });
      onDone();
    } catch (e) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{note}</p>
      <label className="f"><span>{label}</span><textarea value={reason} maxLength={500} data-autofocus="" onChange={(e) => (setReason(e.target.value), setError(''))} /></label>
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Working…' : confirm}</button>
      </div>
    </Dialog>
  );
}

/** The long truth about holds, folded: what the software refuses, what it cannot stop, backups, and who can end one. */
export const HoldRules = () => (
  <details className="ret-stays" data-fold="">
    <summary>How holds work</summary>
    <p className="small">{HOLD_TRUTH}</p>
    <p className="small">{HOLD_BACKUPS}</p>
    <p className="small">{HOLD_OVERRIDE}</p>
  </details>
);

export function HoldDialog({ url, title, folder, envelopeId, onClose, onDone }: { url: string; title: string; folder?: string; envelopeId?: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [matter, setMatter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (reason.trim().length < 3) return setError('The reason is missing. Write why it is held in a few words, then try again.');
    setBusy(true);
    setError('');
    try {
      await api(url, { body: { reason: reason.trim(), matter: matter.trim(), ...(folder ? { folder } : {}), ...(envelopeId ? { envelope_id: envelopeId } : {}) } });
      onDone();
    } catch (e) {
      setError(explain(e, 'Nothing was put on hold.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{HOLD_SHORT}</p>
      <label className="f"><span>Why it is held <span className="hint">(only admins see this)</span></span><textarea value={reason} maxLength={500} data-autofocus="" onChange={(e) => (setReason(e.target.value), setError(''))} /></label>
      <label className="f"><span>Case reference <span className="hint">(optional)</span></span><input value={matter} maxLength={120} onChange={(e) => setMatter(e.target.value)} /></label>
      <HoldRules />
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Working…' : 'Put on hold'}</button>
      </div>
    </Dialog>
  );
}

function PurgeDialog({ envelopeId, r, onClose, onDone }: { envelopeId: string; r: R; onClose: () => void; onDone: (at: string) => void }) {
  const [level, setLevel] = useState<PurgeLevel>('documents');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const day = new Date(Date.now() + RETENTION_NOTICE_DAYS * 864e5).toISOString();
  async function go() {
    setBusy(true);
    setError('');
    try {
      const a = await api(`/envelopes/${envelopeId}/purge`, { body: { level } });
      onDone(a.goes_at);
    } catch (e) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Delete its files for good" onClose={onClose}>
      <p>It waits {RETENTION_NOTICE_DAYS} days, until {longDate(day)}. You or an admin can call it off until then. After that it cannot be undone, and the links of the people on it stop working. They are not told.</p>
      <fieldset className="ret-levels">
        <legend className="sg-vh">What to delete</legend>
        {SCREEN_LEVELS.map((l) => (
          <label key={l} className="check ret-level">
            <input type="radio" name="ret-level" checked={level === l} onChange={() => setLevel(l)} />
            <span>{LEVEL_NAME[l]}</span>
          </label>
        ))}
      </fieldset>
      <details className="ret-stays" data-fold="">
        <summary>What exactly is deleted</summary>
        <Lists r={r} level={level} />
      </details>
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose} data-autofocus="">Cancel</button>
        <button className="btn primary sn-danger" disabled={busy} onClick={go}>{busy ? 'Working…' : `Delete on ${longDate(day)}`}</button>
      </div>
    </Dialog>
  );
}
