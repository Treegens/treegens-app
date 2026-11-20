'use client';
import { useId, useState, type ReactNode } from 'react';
import { api, toast } from '@/components/ui';
import { Dialog } from './Dialog';
import { deadlineLine, explain, closingText, newDeadline, looksLikeEmail } from './lib';
import { useMe } from '@/components/AppShell';
import { CheckFields, checkTrouble, type CheckValue } from './CheckFields';

const CHOICES = [7, 14, 30];

// Push a deadline back, or reopen an envelope that already closed. Nobody has to sign again either way.
export function ExtendDialog({ envelope, onClose, onDone }: { envelope: { id: string; status: string; expires_at?: string | null }; onClose: () => void; onDone: (expiresAt: string) => void }) {
  const expired = envelope.status === 'expired';
  const [choice, setChoice] = useState<number | 'custom'>(14);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const customId = useId();
  const errorId = useId();

  const typed = Number(custom);
  const customOk = /^\d+$/.test(custom.trim()) && typed >= 1 && typed <= 365;
  const days = choice === 'custom' ? (customOk ? typed : 0) : choice;
  // The new deadline with its time and zone: a bare day can be another day for the people who sign.
  const until = days ? closingText(newDeadline(envelope.status, envelope.expires_at, days).toISOString()) : '';

  async function save() {
    if (!days) return setError('Type a number of days from 1 to 365.');
    setBusy(true);
    setError('');
    try {
      const { expires_at } = await api(`/envelopes/${envelope.id}/extend`, { body: { days } });
      toast(expired ? `Reopened. It now closes on ${closingText(expires_at)}.` : `Done. It now closes on ${closingText(expires_at)}.`);
      onDone(expires_at);
    } catch (e: any) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={expired ? 'Reopen this envelope' : 'Give more time'} onClose={onClose}>
      <p>
        {expired
          ? `${deadlineLine(envelope.expires_at) || 'This envelope closed'} before everyone had finished. Reopen it and everyone who still needs to act gets a fresh email.`
          : `${deadlineLine(envelope.expires_at) || 'This envelope has no closing date yet'}. The days you add are counted from that date.`}
        {' '}<b>Nobody who already signed has to sign again.</b>
      </p>
      <fieldset className="sn-choices">
        <legend>{expired ? 'Keep it open for' : 'How much more time?'}</legend>
        {CHOICES.map((d) => (
          <label key={d} className={`sn-choice${choice === d ? ' on' : ''}`}>
            <input type="radio" name="extend-days" checked={choice === d} onChange={() => (setChoice(d), setError(''))} data-autofocus={d === 14 ? '' : undefined} />
            <span>{d} days</span>
          </label>
        ))}
        <label className={`sn-choice${choice === 'custom' ? ' on' : ''}`}>
          <input type="radio" name="extend-days" checked={choice === 'custom'} onChange={() => setChoice('custom')} />
          <span>Another number</span>
        </label>
      </fieldset>
      {choice === 'custom' && (
        <label className="f" htmlFor={customId}>
          <span>Number of days <span className="hint">(1 to 365)</span></span>
          <input id={customId} inputMode="numeric" autoFocus value={custom} onChange={(e) => (setCustom(e.target.value), setError(''))} onKeyDown={(e) => e.key === 'Enter' && save()}
            aria-invalid={!!error} aria-describedby={error ? errorId : undefined} style={{ maxWidth: 140 }} />
        </label>
      )}
      <p className="sn-preview" aria-live="polite">{until ? <>New closing date: <b>{until}</b></> : 'Type a number of days to see the new closing date.'}</p>
      {error && <div className="notice err" role="alert" id={errorId}>{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : expired ? `Reopen${days ? ` for ${days} ${days === 1 ? 'day' : 'days'}` : ''}` : days ? `Give ${days} more ${days === 1 ? 'day' : 'days'}` : 'Give more time'}</button>
      </div>
    </Dialog>
  );
}

// Asks for a reason before voiding one envelope or a whole batch. The people who received it see the reason.
export function VoidDialog({ title, children, confirmLabel, onClose, onVoid }: { title: string; children: ReactNode; confirmLabel: string; onClose: () => void; onVoid: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (!reason.trim()) return setError('Add a short reason first. The people who received it will see it.');
    setBusy(true);
    setError('');
    try {
      await onVoid(reason.trim());
    } catch (e: any) {
      setError(explain(e, 'Nothing was voided.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      {children}
      <label className="f">
        <span>Reason <span className="hint">(recipients will see this)</span></span>
        <textarea value={reason} onChange={(e) => (setReason(e.target.value), setError(''))} maxLength={500} data-autofocus="" placeholder="For example: sent the wrong version" />
      </label>
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Keep it</button>
        <button className="btn primary sn-danger" disabled={busy} onClick={go}>{busy ? 'Voiding…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

// The quick fix for one person: a typo in the name, a different address, or an access code.
export function CorrectDialog({ envelopeId, recipient, onClose, onDone }: { envelopeId: string; recipient: { id: string; name: string; email: string; role?: string; status?: string; access_code?: string | null; code_frozen_at?: string | null; verify?: string | null; phone?: string | null; text_link?: boolean | null; check?: { stopped?: boolean } | null; code_only?: boolean }; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  // For someone who has finished, and once the envelope is finished or closed, the access code is the one thing that
  // can still change: it is not part of what was signed, and it stands between them and their copy.
  const codeOnly = !!recipient.code_only;
  const [f, setF] = useState({ name: recipient.name || '', email: recipient.email || '', access_code: recipient.access_code || '' });
  // The check before the document opens, and the signing link by text message. Changing either makes them type a new code.
  const was: CheckValue = { verify: recipient.verify || 'none', phone: recipient.phone || '', text_link: !!recipient.text_link };
  const [check, setCheck] = useState<CheckValue>(was);
  const checkChanged = check.verify !== was.verify || String(check.phone || '').trim() !== was.phone || !!check.text_link !== was.text_link;
  // Someone said the number is not theirs, and the sender has since checked with the person that it is.
  const [confirmed, setConfirmed] = useState(false);
  // After too many wrong tries a code opens nothing until a different one is set here.
  const frozen = !!recipient.access_code && !!recipient.code_frozen_at;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const newAddress = f.email.trim().toLowerCase() !== (recipient.email || '').toLowerCase();
  // Someone whose link the sender sends themselves has no address, and may keep none (src/lib/bysender.ts).
  const own = !!(recipient as any).link_by_sender && !recipient.email;
  // Someone whose turn has not come yet has no email and no link so far.
  const waiting = recipient.status === 'pending';

  async function saveCode() {
    setBusy(true);
    setError('');
    try {
      await api(`/envelopes/${envelopeId}/correct`, { body: { recipient_id: recipient.id, access_code: f.access_code } });
      toast(f.access_code.trim() ? 'Updated. Their link is the same. Give them the new code yourself.' : 'Updated. Their link now opens without a code.');
      onDone();
    } catch (e: any) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (codeOnly) return saveCode();
    if (!f.name.trim()) return setError('Add their name.');
    if (!(own && !f.email.trim()) && !looksLikeEmail(f.email.trim())) return setError('That email address is not complete. It should look like name@example.org.');
    const trouble = checkTrouble({ ...check, role: recipient.role }, !!me.text_messages, f.name.trim());
    if (trouble && (checkChanged || newAddress)) return setError(trouble);
    setBusy(true);
    setError('');
    try {
      // The check goes along when it was changed here, and when the address was: a number typed for one person is
      // never used for another without the sender saying so.
      const checks = checkChanged || newAddress ? { verify: check.verify, phone: String(check.phone || '').trim(), text_link: !!check.text_link } : {};
      const reopen = confirmed && !checkChanged && !newAddress ? { number_confirmed: true } : {};
      await api(`/envelopes/${envelopeId}/correct`, { body: { recipient_id: recipient.id, name: f.name.trim(), email: f.email.trim(), access_code: f.access_code, ...checks, ...reopen } });
      const again = checkChanged && check.verify !== 'none' ? ' They are asked for a new one-time code.' : 'number_confirmed' in reopen ? ' Codes go to their number again.' : '';
      toast(!newAddress ? `Updated. Their link still works.${again}` : waiting ? 'Updated. They get the email when it is their turn.' : `Updated. A new email is on its way to ${f.email.trim()}.`);
      onDone();
    } catch (e: any) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Correct ${recipient.name || 'this recipient'}`} onClose={onClose}>
      <p className="muted">{codeOnly ? `The name and the address of ${recipient.name} can no longer be changed here. Their access code still can: it is not part of what was signed, and their link needs it to open the document or their copy of it.`
        : 'Fix a typo, send it to a different address, or change how they are checked. Nothing is voided and nobody else is disturbed.'}</p>
      <form onSubmit={(e) => (e.preventDefault(), save())}>
        {!codeOnly && <label className="f"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" data-autofocus="" /></label>}
        {!codeOnly && <label className="f"><span>Email{own ? <span className="hint"> (none now: you send their link yourself. Add one only if we should email them from now on)</span> : null}</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" /></label>}
        <label className="f"><span>Access code <span className="hint">(optional, at least 4 characters, you give it to them yourself)</span></span><input value={f.access_code} onChange={(e) => setF({ ...f, access_code: e.target.value })} autoComplete="off" {...(codeOnly ? { 'data-autofocus': '' } : {})} /></label>
        {frozen && <div className="notice warn" style={{ marginBottom: 12 }}><b>This code is frozen.</b> It was entered wrongly too many times, so it opens nothing now. {f.access_code.trim() === recipient.access_code ? 'Type a different code here, save, and give the new one to them yourself.' : 'Saving the new code lets them in again. Give it to them yourself.'}</div>}
        {!codeOnly && <fieldset className="sn-check-fix">
          <legend>Checking who signs</legend>
          {/* Someone using the link said the number is not theirs. Codes go out again once the number or the check changes. */}
          {recipient.check?.stopped && !checkChanged && <p className="notice warn small" role="status" style={{ margin: 0 }}><b>They said this number is not theirs</b>, so we stopped sending codes to it. Put in the right number or choose another check, and save{was.verify === 'sms_code' && !newAddress ? ', or tick the box below if the number is right after all' : ''}. Make sure first that you are dealing with the right person.</p>}
          {recipient.check?.stopped && !checkChanged && !newAddress && was.verify === 'sms_code' && (
            <label className="check sn-check-confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I checked with {recipient.name} that this is their number. Send codes to it again.</label>
          )}
          <CheckFields value={check} role={recipient.role} textsOn={!!me.text_messages} onChange={(p) => setCheck({ ...check, ...p })} />
          {newAddress && !!was.phone && String(check.phone || '').trim() === was.phone && <p className="notice warn small" role="status" style={{ margin: 0 }}>This mobile number was typed for {recipient.name}. If the person at the new address has another number, change it here, or texts for them go to the wrong phone.</p>}
        </fieldset>}
        <p className="small muted" aria-live="polite">
          {codeOnly ? 'Their link stays the same and no email is sent. Give the new code to them yourself.'
            : own && !newAddress ? 'They have no email address here, so the link you sent them keeps working and nothing is emailed to them.'
            : own ? `With an address we email them from now on. The link you sent them stops working${waiting ? ', and they get our email when their turn comes' : ', and a new email goes out to this address'}.`
            : waiting ? 'It is not their turn yet, so no email has gone out. They get it at the corrected address when their turn comes.'
            : newAddress ? 'Because the address changed, the old link stops working and a new email goes out to the new address.'
            : f.name.trim() !== (recipient.name || '') ? 'The address is the same, so the link they already have keeps working. A spelling fix keeps what they filled in. If the new name is another person, whatever was filled in or signed under the old name is cleared, and they start with an empty document.'
            : 'The address is the same, so the link they already have keeps working and no new email is sent.'}
        </p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : newAddress && !waiting ? 'Save and send new email' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// A plain "are you sure" for things that cannot be undone. The safe choice gets the focus.
export function ConfirmDialog({ title, children, confirmLabel, keepLabel = 'Keep it', danger = true, unchanged = 'Nothing was changed.', onClose, onConfirm }: { title: string; children: ReactNode; confirmLabel: string; keepLabel?: string; danger?: boolean; unchanged?: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (e: any) {
      setError(explain(e, unchanged));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      {children}
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose} data-autofocus="">{keepLabel}</button>
        <button className={`btn primary${danger ? ' sn-danger' : ''}`} disabled={busy} onClick={go}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}
