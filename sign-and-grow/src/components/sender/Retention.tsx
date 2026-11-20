'use client';
// How long this envelope is kept, and what may happen to it (src/server/records.ts): the account's rule or its
// template's period, the purge the timer announced or someone asked for, "Keep it", "Purge now", legal holds, and,
// once a purge ran, what it removed and what stays. The words are in src/lib/retention.ts, which the server and the
// emails use too.
import { useState } from 'react';
import { api, toast } from '@/components/ui';
import { Dialog } from './Dialog';
import { explain, longDate } from './lib';
import { LEVEL_NAME, removesAt, KEPT_AT, HOLD_TRUTH, HOLD_BACKUPS, PURGE_LEVELS, RETENTION_NOTICE_DAYS, daysText, type PurgeLevel } from '@/lib/retention';

type R = {
  closed_at: string | null; period: { days: number; from: 'account' | 'template'; template?: string } | null; due_at: string | null; rule_level: PurgeLevel | null;
  noticed_at: string | null; goes_at: string | null; level: PurgeLevel | null; kept_until: string | null; kept_reason: string | null; kept_by: string | null;
  asked: { at: string; by: string; level: PurgeLevel } | null; holds: any[]; held: boolean; disputed: boolean;
  purged_at: string | null; purged_level: PurgeLevel | null; purged_sha256: string | null; may_purge: boolean; may_hold: boolean; stays: string[];
};

const Stays = ({ r, open }: { r: R; open?: boolean }) => (
  <details className="ret-stays" open={open}>
    <summary>What stays after a purge</summary>
    <ul className="rules small">{r.stays.map((s) => <li key={s}>{s}</li>)}</ul>
  </details>
);

export function RetentionCard({ envelopeId, r, onChanged }: { envelopeId: string; r: R | null | undefined; onChanged: () => void }) {
  const [open, setOpen] = useState<'' | 'keep' | 'purge' | 'hold' | 'lift'>('');
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const closed = !!r.closed_at;
  // Nothing to say about an envelope that is still out and not held, apart from the button to hold it for an admin.
  if (!closed && !r.held && !r.may_hold) return null;
  const own = r.holds.find((h) => h.envelope_id === envelopeId);
  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/envelopes/${envelopeId}/purge`, { method: 'DELETE' });
      toast('Called off. Nothing will be purged.');
      onChanged();
    } catch (e) {
      toast(explain(e, 'Nothing was changed.'), true);
    } finally {
      setBusy(false);
    }
  };

  if (r.purged_at) {
    const level = (r.purged_level || 'documents') as PurgeLevel;
    return (
      <section className="card ret" aria-labelledby="ret-h">
        <h2 id="ret-h">Purged on {longDate(r.purged_at)}</h2>
        <p>{LEVEL_NAME[level]}: removed for good. This cannot be undone. {KEPT_AT[level]}</p>
        <ul className="rules small">{removesAt(level).map((s) => <li key={s}>{s}</li>)}</ul>
        {r.purged_sha256 && <p className="small">The fingerprint (SHA-256) of the signed PDF it removed: <span className="mono ret-sha">{r.purged_sha256}</span>. Anyone who still has that file can check it at Verify a document.</p>}
        <Stays r={r} open />
      </section>
    );
  }

  const goes = r.goes_at ? longDate(r.goes_at) : '';
  const level = (r.level || r.rule_level || 'documents') as PurgeLevel;
  return (
    <section className="card ret" aria-labelledby="ret-h">
      <h2 id="ret-h">How long it is kept</h2>
      {r.held ? (
        <div className="notice ret-held" role="note">
          <b>On legal hold</b> since {longDate(r.holds[0].set_at)}, set by {r.holds[0].set_by}{r.holds[0].folder ? <> on the folder &ldquo;{r.holds[0].folder}&rdquo;</> : null}. {HOLD_TRUTH} Only an admin of the account can lift a hold.
          {r.holds.map((h) => h.reason && <div key={h.id} className="small ret-reason">Reason: {h.reason}{h.matter ? `. Matter: ${h.matter}` : ''}</div>)}
        </div>
      ) : r.disputed ? (
        <p>A person named on it disputes it, so it is not purged while that dispute is open.</p>
      ) : r.asked ? (
        <p className="warn-text"><b>{r.asked.by} asked to purge it.</b> On {goes}, this will be removed: {LEVEL_NAME[r.asked.level].toLowerCase()}. Until then the sender or an admin can call it off. After that it cannot be undone.</p>
      ) : r.noticed_at && r.goes_at ? (
        <p className="warn-text"><b>The account&apos;s retention rule reaches it.</b> On {goes}, this will be removed: {LEVEL_NAME[level].toLowerCase()}. The sender and the admins were emailed on {longDate(r.noticed_at)}. To keep it, choose Keep it and give a reason.</p>
      ) : r.due_at && r.period ? (
        <p>Kept until {longDate(r.due_at)}: {r.period.from === 'template' ? <>the period of the template &ldquo;{r.period.template}&rdquo;, </> : 'the account\'s rule, '}{daysText(r.period.days)} after it closed{r.kept_until ? `, and kept on by ${r.kept_by} (${r.kept_reason})` : ''}. Then this is removed: {LEVEL_NAME[level].toLowerCase()}, after an email to the sender and the admins {RETENTION_NOTICE_DAYS} days before.</p>
      ) : closed ? (
        <p>The account keeps closed envelopes without an end date. Nothing is purged unless someone asks for it.</p>
      ) : (
        <p>It is still out. The retention rule only counts from the day an envelope closes.</p>
      )}
      <div className="row wrap ret-actions">
        {closed && !r.held && (r.noticed_at || r.due_at) && !r.asked && <button className="btn" disabled={busy} onClick={() => setOpen('keep')}>Keep it</button>}
        {r.asked && !r.held && <button className="btn" disabled={busy} onClick={cancel}>Call off the purge</button>}
        {r.may_purge && !r.asked && !r.disputed && <button className="btn ghost danger" disabled={busy} onClick={() => setOpen('purge')}>Purge now</button>}
        {r.may_hold && !own && <button className="btn" disabled={busy} onClick={() => setOpen('hold')}>Put on legal hold</button>}
        {r.may_hold && own && <button className="btn" disabled={busy} onClick={() => setOpen('lift')}>Lift the hold</button>}
      </div>
      {closed && <Stays r={r} />}
      {open === 'keep' && <ReasonDialog title="Keep this envelope" label="Why it is kept" note={`It is kept for ${r.period ? daysText(r.period.days) : 'another period'} from today, and any purge announced or asked for is called off. The reason goes into its audit trail, which its sender and the admins can read.`} confirm="Keep it" url={`/envelopes/${envelopeId}/keep`} onClose={() => setOpen('')} onDone={() => (setOpen(''), toast('Kept. The reason is in the audit trail.'), onChanged())} />}
      {open === 'hold' && <HoldDialog url={`/envelopes/${envelopeId}/hold`} what="this envelope" onClose={() => setOpen('')} onDone={() => (setOpen(''), toast('On legal hold. It cannot be deleted or purged until an admin lifts the hold.'), onChanged())} />}
      {open === 'lift' && <ReasonDialog title="Lift the legal hold" label="Why it may be lifted" note="Once the hold is lifted, it can be deleted and purged again by the usual rules. If the retention rule had reached it, the sender and the admins are emailed again 14 days before anything is purged." confirm="Lift the hold" method="DELETE" url={`/envelopes/${envelopeId}/hold`} onClose={() => setOpen('')} onDone={() => (setOpen(''), toast('The hold is lifted.'), onChanged())} />}
      {open === 'purge' && <PurgeDialog envelopeId={envelopeId} r={r} onClose={() => setOpen('')} onDone={(at) => (setOpen(''), toast(`It will be purged on ${longDate(at)}. You can call it off until then.`), onChanged())} />}
    </section>
  );
}

export function ReasonDialog({ title, label, note, confirm, url, method = 'POST', onClose, onDone }: { title: string; label: string; note: string; confirm: string; url: string; method?: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (reason.trim().length < 3) return setError('Write the reason in a few words first.');
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

export function HoldDialog({ url, what, folder, onClose, onDone }: { url: string; what: string; folder?: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [matter, setMatter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (reason.trim().length < 3) return setError('Write why it is held in a few words first.');
    setBusy(true);
    setError('');
    try {
      await api(url, { body: { reason: reason.trim(), matter: matter.trim(), ...(folder ? { folder } : {}) } });
      onDone();
    } catch (e) {
      setError(explain(e, 'Nothing was put on hold.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Put ${what} on legal hold`} onClose={onClose}>
      <p>{HOLD_TRUTH}</p>
      <p className="muted small">{HOLD_BACKUPS}</p>
      <label className="f"><span>Why it is held <span className="hint">(for the admins: the sender sees only that it is held)</span></span><textarea value={reason} maxLength={500} data-autofocus="" onChange={(e) => (setReason(e.target.value), setError(''))} /></label>
      <label className="f"><span>Matter or case reference <span className="hint">(optional)</span></span><input value={matter} maxLength={120} onChange={(e) => setMatter(e.target.value)} /></label>
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
    <Dialog title="Purge this envelope" onClose={onClose} wide>
      <p>It waits {RETENTION_NOTICE_DAYS} days, until {longDate(day)}. The sender and the admins are emailed now, and either can call it off until then. After that it cannot be undone.</p>
      <fieldset className="ret-levels">
        <legend>What to remove</legend>
        {PURGE_LEVELS.map((l) => (
          <label key={l} className="check ret-level">
            <input type="radio" name="ret-level" checked={level === l} onChange={() => setLevel(l)} />
            <span><b>{LEVEL_NAME[l]}</b><span className="muted small"> {KEPT_AT[l]}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="small"><b>Removed:</b></p>
      <ul className="rules small">{removesAt(level).map((s) => <li key={s}>{s}</li>)}</ul>
      <Stays r={r} />
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose} data-autofocus="">Keep it</button>
        <button className="btn primary sn-danger" disabled={busy} onClick={go}>{busy ? 'Working…' : `Purge on ${longDate(day)}`}</button>
      </div>
    </Dialog>
  );
}
