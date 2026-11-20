'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '@/components/ui';
import { Dialog } from './Dialog';
import { Icon } from './parts';
import { fieldName, isMulti, problemWith, type Item } from './fields';

// Runs one request and keeps its error next to the form, where the person is looking.
function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(fn: () => Promise<any>, whatNext = '') {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e: any) {
      setError(`${e?.message || 'Something went wrong on our side.'}${whatNext ? ` ${whatNext}` : ''}`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, send };
}

const Problem = ({ children }: { children: ReactNode }) => (children ? <div className="notice err sg-problem" role="alert">{children}</div> : null);

// Shown in place of a form once it has been sent. Takes focus so the confirmation is the next thing read out.
function Confirmed({ children, onClose, label = 'Close' }: { children: ReactNode; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <div ref={ref} tabIndex={-1} className="notice sg-confirmed" role="status">{children}</div>
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>{label}</button></div>
    </>
  );
}

// ---- Other actions ---------------------------------------------------------------------------

export type MenuItem = { key: string; label: string; hint?: string; icon?: string; href?: string; download?: boolean; danger?: boolean; onClick?: () => void };

export function MenuDialog({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <Dialog title="Other actions" onClose={onClose}>
      <ul className="sg-menu">
        {items.map((it) => {
          const inner = (
            <>
              {it.icon && <Icon name={it.icon} size={20} />}
              <span><span className="sg-menu-label">{it.label}</span>{it.hint && <span className="sg-menu-hint">{it.hint}</span>}</span>
            </>
          );
          return (
            <li key={it.key}>
              {it.href
                ? <a className={`sg-menu-item${it.danger ? ' danger' : ''}`} href={it.href} {...(it.download ? {} : { target: '_blank', rel: 'noreferrer' })}>{inner}</a>
                : <button type="button" className={`sg-menu-item${it.danger ? ' danger' : ''}`} onClick={it.onClick}>{inner}</button>}
            </li>
          );
        })}
      </ul>
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Back to the document</button></div>
    </Dialog>
  );
}

// ---- Ask the sender --------------------------------------------------------------------------

export function AskDialog({ base, sender, replyTo, onClose }: { base: string; sender: any; replyTo: string; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, setError, send } = useSend();
  const title = `Ask ${sender.name} a question`;
  if (sent)
    return (
      <Dialog title={title} onClose={onClose}>
        <Confirmed onClose={onClose} label="Back to the document">
          <b>Your question is on its way.</b> {sender.name} will reply to {replyTo}. You can carry on, or come back later with the same link.
        </Confirmed>
      </Dialog>
    );
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (message.trim().length < 3) return setError('Type your question first, then send it.');
        if (await send(() => api(`${base}/ask`, { body: { message } }), `You can also email ${sender.email} directly.`)) setSent(true);
      }}>
        <p className="muted">Nothing is signed by asking. {sender.name} gets your question by email and replies to {replyTo}.</p>
        <label className="f"><span>Your question</span><textarea data-autofocus rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        <Problem>{error}</Problem>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Sending' : 'Send question'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- Report ----------------------------------------------------------------------------------

const REASONS: [string, string, string][] = [
  ['phishing', 'It looks like a scam', 'For example, it asks for money or passwords, or pretends to be someone else.'],
  ['spam', 'It is spam', 'I did not ask for this and do not know the sender.'],
  ['not-for-me', 'It is not meant for me', 'It looks genuine, but it was sent to the wrong person.'],
  ['other', 'Something else', ''],
];

export function ReportDialog({ base, sender, onClose }: { base: string; sender: any; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, setError, send } = useSend();
  const name = useId();
  if (sent)
    return (
      <Dialog title="Report this request" onClose={onClose}>
        <Confirmed onClose={onClose}>
          <b>Thank you. A person will look at this.</b> You do not need to do anything else. If it looks like a scam, do not sign it and do not reply to it.
        </Confirmed>
      </Dialog>
    );
  return (
    <Dialog title="Report this request" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!reason) return setError('Choose what is wrong, then send your report.');
        if (await send(() => api(`${base}/report`, { body: { reason, detail } }), 'Your report was not sent. Try again in a minute.')) setSent(true);
      }}>
        <p className="muted">This goes to the Sign&Grow team, not to {sender?.name || 'the sender'}. A person reads every report.</p>
        <fieldset className="sg-choices">
          <legend>What is wrong?</legend>
          {REASONS.map(([value, label, hint], i) => (
            <label key={value} className="sg-choice">
              <input type="radio" name={name} value={value} checked={reason === value} onChange={() => (setReason(value), setError(''))} {...(i === 0 ? { 'data-autofocus': true } : {})} />
              <span><span className="sg-choice-label">{label}</span>{hint && <span className="sg-choice-hint">{hint}</span>}</span>
            </label>
          ))}
        </fieldset>
        <label className="f"><span>Anything else we should know <span className="hint">(optional)</span></span><textarea rows={3} maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        <Problem>{error}</Problem>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Sending' : 'Send report'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- Decline and pass on ---------------------------------------------------------------------

export function DeclineDialog({ base, sender, onClose, onDone }: { base: string; sender: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, setError, send } = useSend();
  return (
    <Dialog title="Decline to sign" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!reason.trim()) return setError(`Add a short reason so ${sender.name} knows what to change, then choose Decline.`);
        if (await send(() => api(`${base}/decline`, { body: { reason } }), 'Nothing was declined. Try again, or close this and carry on.')) onDone();
      }}>
        <p className="muted">Declining closes the document for everyone. {sender.name} is told why. If you only have a question, ask it instead and nothing is closed.</p>
        <label className="f"><span>Your reason</span><textarea data-autofocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <Problem>{error}</Problem>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Go back</button>
          <button className="btn sg-danger" disabled={busy}>{busy ? 'Declining' : 'Decline'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReassignDialog({ base, sender, onClose, onDone }: { base: string; sender: any; onClose: () => void; onDone: (name: string) => void }) {
  const [form, setForm] = useState({ name: '', email: '', reason: '' });
  const { busy, error, setError, send } = useSend();
  return (
    <Dialog title="Assign to someone else" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!form.name.trim() || !form.email.trim()) return setError('Enter the name and email of the person who should sign instead.');
        if (await send(() => api(`${base}/reassign`, { body: form }), 'Check the details and try again.')) onDone(form.name.trim());
      }}>
        <p className="muted">Not the right person to sign? Pass it on. They get their own link by email, yours stops working, and {sender.name} is told.</p>
        <label className="f"><span>Their name</span><input data-autofocus autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="f"><span>Their email</span><input type="email" autoComplete="off" autoCapitalize="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="f"><span>Reason <span className="hint">(optional)</span></span><input value={form.reason} maxLength={300} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <Problem>{error}</Problem>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Go back</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Assigning' : 'Assign'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- A signature that is already on the page -------------------------------------------------

export function SignedFieldDialog({ kind, image, onChange, onClear, onClose }: { kind: 'signature' | 'initials'; image: string; onChange: () => void; onClear: () => void; onClose: () => void }) {
  const word = kind === 'signature' ? 'signature' : 'initials';
  return (
    <Dialog title={`Your ${word}`} onClose={onClose}>
      <div className="sg-sigpreview"><img src={image} alt={`Your ${word} as ${kind === 'signature' ? 'it' : 'they'} will appear on the document`} /></div>
      <p className="muted small">Change replaces your {word} everywhere on this document. Clear only empties this one field.</p>
      <div className="actions sg-three">
        <button type="button" className="btn" onClick={onClear}>Clear</button>
        <button type="button" className="btn" onClick={onChange}>Change</button>
        <button type="button" className="btn primary" data-autofocus onClick={onClose}>Keep it</button>
      </div>
    </Dialog>
  );
}

// ---- Review before finishing -----------------------------------------------------------------

export function ReviewDialog({ me, sender, items, sig, ini, usesSig, usesIni, approving, busy, error, onChangeSig, onBack, onFinish }: {
  me: any; sender: any; items: Item[]; sig: string | null; ini: string | null; usesSig: boolean; usesIni: boolean; approving?: boolean;
  busy: boolean; error: string; onChangeSig: (kind: 'signature' | 'initials') => void; onBack: () => void; onFinish: () => void;
}) {
  const filled = items.filter((i) => i.done).length;
  const optionalEmpty = items.filter((i) => !i.done && !i.required).length;
  return (
    <Dialog title={approving ? 'Approve this document' : 'Check before you finish'} onClose={onBack}>
      <dl className="sg-review">
        <div>
          <dt>{approving ? 'You are approving as' : 'You are signing as'}</dt>
          <dd><b>{me.name}</b><br /><span className="muted">{me.email}</span></dd>
        </div>
        {usesSig && sig && (
          <div>
            <dt>Your signature</dt>
            <dd className="sg-review-sig">
              <img src={sig} alt="Your signature" />
              <button type="button" className="btn sm" onClick={() => onChangeSig('signature')}>Change<span className="sg-vh"> signature</span></button>
            </dd>
          </div>
        )}
        {usesIni && ini && (
          <div>
            <dt>Your initials</dt>
            <dd className="sg-review-sig">
              <img src={ini} alt="Your initials" />
              <button type="button" className="btn sm" onClick={() => onChangeSig('initials')}>Change<span className="sg-vh"> initials</span></button>
            </dd>
          </div>
        )}
        {!approving && (
          <div>
            <dt>Fields</dt>
            <dd>
              {items.length === 0 ? 'Nothing to fill in. Your details are added for you.' : `${filled} of ${items.length} filled in.`}
              {optionalEmpty > 0 && <span className="muted"> {optionalEmpty === 1 ? '1 optional field is empty.' : `${optionalEmpty} optional fields are empty.`} That is fine.</span>}
            </dd>
          </div>
        )}
      </dl>
      <p className="muted small">
        {approving ? `Choosing Approve and send records your approval and tells ${sender.name}.` : `Choosing Finish and send signs the document and tells ${sender.name}.`} You can still go back and change anything first.
      </p>
      <Problem>{error}</Problem>
      <div className="actions">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>Go back</button>
        <button type="button" className="btn primary" data-autofocus onClick={onFinish} disabled={busy}>{busy ? 'Sending' : approving ? 'Approve and send' : 'Finish and send'}</button>
      </div>
    </Dialog>
  );
}

// ---- Typing on a phone -----------------------------------------------------------------------

// Instead of typing into a box a few millimetres tall, the field opens here with room to see what you type.
export function FieldSheet({ field, value, onChange, onDone, onNext }: { field: any; value: string; onChange: (v: string) => void; onDone: () => void; onNext?: () => void }) {
  const input = useRef<any>(null);
  const hint = useId();
  const name = fieldName(field);
  const problem = problemWith(field, value);
  // The sheet stays open while moving from one field to the next, so move focus by hand.
  useEffect(() => input.current?.focus({ preventScroll: true }), [field.id]);
  const shared = { ref: input, 'aria-label': name, 'aria-describedby': hint, 'aria-required': !!field.required, 'aria-invalid': !!problem, className: 'sg-big-input', value, 'data-autofocus': true } as const;
  return (
    <Dialog title={name} onClose={onDone} variant="field" light>
      <form onSubmit={(e) => {
        e.preventDefault();
        (onNext || onDone)();
      }}>
        {field.type === 'dropdown' ? (
          <select {...shared} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose one</option>
            {(field.options || []).map((o: string) => <option key={o}>{o}</option>)}
          </select>
        ) : isMulti(field) ? (
          <textarea {...shared} rows={3} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input {...shared} type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined} autoComplete={field.type === 'company' ? 'organization' : field.type === 'title' ? 'organization-title' : 'off'}
            enterKeyHint={onNext ? 'next' : 'done'} onChange={(e) => onChange(e.target.value)} />
        )}
        <p id={hint} className={`sg-sheet-hint${problem ? ' bad' : ''}`}>{problem || (field.required ? 'Required' : 'Optional. Leave it empty if it does not apply.')}</p>
        <div className="actions">
          <button type="button" className={`btn${onNext ? '' : ' primary'}`} onClick={onDone}>Done</button>
          {onNext && <button className="btn primary">Next</button>}
        </div>
      </form>
    </Dialog>
  );
}
