'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '@/components/ui';
import { Dialog } from './Dialog';
import { Icon } from './parts';
import { fieldName, isMulti, problemWith, type Item } from './fields';
import { CANNOT_PRINT_HEAD, CANNOT_PRINT_THEN, shownChars } from '@/lib/scripts';
import { formatDateValue } from '@/lib/dates';
import { NUMBER_HINT } from '@/lib/numbers';
import { DISPUTE_DOES, disputeSenderSees } from '@/lib/evidence';

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

// The list has no descriptions and a fixed order (src/components/sign/actions.ts). `when` is the deadline in the
// person's own time, `doc` the way the document is shown (on the document only), `onHelp` the dialog's own Help.
export function MenuDialog({ items, onClose, when, doc, onHelp, back = 'Back to the document' }: { items: MenuItem[]; onClose: () => void; when?: string; doc?: ReactNode; onHelp?: () => void; back?: string }) {
  return (
    <Dialog title="Other actions" onClose={onClose}>
      {when && <p className="sg-menu-when">{when}</p>}
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
      {doc}
      <div className="actions sg-menu-foot">
        {onHelp && <button type="button" className="btn" aria-haspopup="dialog" onClick={onHelp}>Help</button>}
        <button type="button" className="btn" onClick={onClose}>{back}</button>
      </div>
    </Dialog>
  );
}

// Asking the sender a question is "Questions and comments" now (Comments.tsx): one way to ask.

// ---- Report ----------------------------------------------------------------------------------

const REASONS: [string, string, string][] = [
  ['phishing', 'It looks like a scam', 'For example, it asks for money or passwords, or pretends to be someone else.'],
  ['spam', 'It is spam', 'I did not ask for this and do not know the sender.'],
  ['not-for-me', 'It is not meant for me', 'It looks genuine, but it was sent to the wrong person.'],
  // A dispute, not a report: it marks the envelope, tells the sender and goes to POST /sign/:token/dispute.
  ['not-me', 'I did not sign this, or this was not me', 'Something was signed, approved or declined in my name that I did not do.'],
  ['other', 'Something else', ''],
];

export function ReportDialog({ base, sender, onClose }: { base: string; sender: any; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  // A member of a signing group who reports it is emailed nothing more about it (mail_stopped in the answer).
  const [stopped, setStopped] = useState(false);
  const { busy, error, setError, send } = useSend();
  const name = useId();
  if (sent && reason === 'not-me')
    return (
      <Dialog title="Report this request" onClose={onClose}>
        <Confirmed onClose={onClose}>
          <b>Your dispute is on record.</b> The document is now marked as disputed, on {sender?.name || 'the sender'}&apos;s page and for anyone who checks it on our Verify page. {sender?.name || 'The sender'} has been told, with what you wrote, and so have the people who run GrowSigning. Nothing was deleted, and you can still download your copy. We do not decide who is right. To hear from a person, write to us on the help page with the topic &ldquo;I am named on a document I did not sign&rdquo;.
        </Confirmed>
      </Dialog>
    );
  if (sent)
    return (
      <Dialog title="Report this request" onClose={onClose}>
        <Confirmed onClose={onClose}>
          <b>Thank you. A person will look at this.</b> You do not need to do anything else. If it looks like a scam, do not sign it and do not reply to it.{stopped && ' We will not email you about this document again. If you change your mind, this page has a button that starts our emails again.'}
        </Confirmed>
      </Dialog>
    );
  return (
    <Dialog title="Report this request" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!reason) return setError('Choose what is wrong, then send your report.');
        if (await send(() => (reason === 'not-me' ? api(`${base}/dispute`, { body: { detail } }) : api(`${base}/report`, { body: { reason, detail } }).then((x: any) => setStopped(!!x?.mail_stopped))), reason === 'not-me' ? '' : 'Your report was not sent. Try again in a minute.')) setSent(true);
      }}>
        {/* A dispute is not a report: it goes to the sender too, and the screen says exactly what they get before it is sent. */}
        <p className="muted">{reason === 'not-me' ? 'A dispute goes to the sender and to the GrowSigning team. Read below what each of them gets.' : `This goes to the GrowSigning team, not to ${sender?.name || 'the sender'}. A person reads every report.`}</p>
        <fieldset className="sg-choices">
          <legend>What is wrong?</legend>
          {REASONS.map(([value, label, hint], i) => (
            <label key={value} className="sg-choice">
              <input type="radio" name={name} value={value} checked={reason === value} onChange={() => (setReason(value), setError(''))} {...(i === 0 ? { 'data-autofocus': true } : {})} />
              <span><span className="sg-choice-label">{label}</span>{hint && <span className="sg-choice-hint">{hint}</span>}</span>
            </label>
          ))}
        </fieldset>
        {reason === 'not-me' && <div className="notice" id="sg-dispute-sees"><p style={{ margin: '0 0 6px' }}>{DISPUTE_DOES}</p><p style={{ margin: 0 }}>{disputeSenderSees(sender?.name || 'The sender')}</p></div>}
        <label className="f"><span>{reason === 'not-me' ? <>What happened, in your words <span className="hint">(optional; {sender?.name || 'the sender'} will read it)</span></> : <>Anything else we should know <span className="hint">(optional)</span></>}</span><textarea dir="auto" rows={3} maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} {...(reason === 'not-me' ? { 'aria-describedby': 'sg-dispute-sees' } : {})} /></label>
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

// `note`: said before anything else, such as that one member of a signing group declines for the whole group.
export function DeclineDialog({ base, sender, title = 'Decline to sign', note, onClose, onDone }: { base: string; sender: any; title?: string; note?: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, setError, send } = useSend();
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!reason.trim()) return setError(`Add a short reason so ${sender.name} knows what to change, then choose Decline.`);
        if (await send(() => api(`${base}/decline`, { body: { reason } }), 'Nothing was declined. Try again, or close this and carry on.')) onDone();
      }}>
        {note && <div className="notice warn" role="note">{note}</div>}
        <p className="muted">Declining closes the document for everyone. {sender.name} is told why. If you only have a question, ask it instead and nothing is closed.</p>
        <label className="f"><span>Your reason</span><textarea dir="auto" data-autofocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
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
    <Dialog title="Pass to someone else" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!form.name.trim() || !form.email.trim()) return setError('Enter the name and email of the person who should sign instead.');
        if (await send(() => api(`${base}/reassign`, { body: form }), 'Check the details and try again.')) onDone(form.name.trim());
      }}>
        <p className="muted">Not the right person to sign? Pass it on. They get their own link by email, yours stops working, and {sender.name} is told.</p>
        {/* A hand-over passes on nothing, also to someone at the same address (reassignRecipient), so that is said
            before it happens, with the way to keep everything for someone who only wants their name spelled right. */}
        <p className="muted">Nothing you filled in or signed goes with it: they start with an empty document. If this is you and only your name is spelled wrong, go back instead. You can fix your name when you make your signature.</p>
        <label className="f"><span>Their name</span><input dir="auto" data-autofocus autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="f"><span>Their email</span><input type="email" autoComplete="off" autoCapitalize="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="f"><span>Reason <span className="hint">(optional)</span></span><input dir="auto" value={form.reason} maxLength={300} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <Problem>{error}</Problem>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Go back</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Passing it on' : 'Pass it on'}</button>
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

// A signer whose name was typed wrong by the sender can put it right themselves. It is logged and the sender is told.
// A name that reads like a different person's is not changed: the sender is asked instead, and onRename hands back
// the words that say so. They stay on screen in place of the form.
export function FixName({ name, onRename }: { name: string; onRename: (name: string) => Promise<string | void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [asked, setAsked] = useState('');
  const id = useId();
  if (asked) return <div className="notice warn sg-problem" role="status">{asked}</div>;
  if (!open) return <button type="button" className="sg-link" onClick={() => setOpen(true)}>Not spelled right? Fix my name</button>;
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const notChanged = await onRename(value.trim());
      if (notChanged) setAsked(notChanged);
      setOpen(false);
    } catch (e: any) {
      setProblem(e?.message || 'That did not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sg-fixname">
      <label htmlFor={id} className="small">Your name as it should appear</label>
      <div className="row wrap">
        <input id={id} dir="auto" value={value} maxLength={120} autoComplete="name" onChange={(e) => setValue(e.target.value)} />
        <button type="button" className="btn sm primary" disabled={busy || value.trim().length < 2} onClick={save}>Save name</button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {problem && <p className="sg-problem" role="alert">{problem}</p>}
      <p className="muted small" style={{ margin: '6px 0 0' }}>This is for fixing how your name is written: a letter, the spacing, a hyphen or a dot. The sender is told about the change and it is recorded in the audit trail. A name in another alphabet or script, or a different name, is not changed here: the sender is asked instead.</p>
    </div>
  );
}

export function ReviewDialog({ me, sender, items, sig, ini, usesSig, usesIni, approving, busy, error, onChangeSig, onBack, onFinish, onRename, printCheck, note }: {
  me: any; sender: any; items: Item[]; sig: string | null; ini: string | null; usesSig: boolean; usesIni: boolean; approving?: boolean;
  /** Said above the buttons and never in their way: a question of this person's that is not answered yet (Comments.tsx). */
  note?: ReactNode;
  busy: boolean; error: string; onChangeSig: (kind: 'signature' | 'initials') => void; onBack: () => void; onFinish: () => void;
  onRename?: (name: string) => Promise<string | void>;
  /** Asks the server whether this person's name or answers hold a character the signed PDF cannot print. */
  printCheck?: () => Promise<{ problems?: { field_id: string | null; label: string; chars: string }[] }>;
}) {
  // Said before the person finishes, never found out from the finished document. Asked again when the name changes.
  const [cannotPrint, setCannotPrint] = useState<{ field_id: string | null; label: string; chars: string }[]>([]);
  useEffect(() => {
    let on = true;
    printCheck?.().then((r) => on && setCannotPrint(r?.problems || [])).catch(() => {});
    return () => {
      on = false;
    };
  }, [me.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const filled = items.filter((i) => i.done).length;
  const optionalEmpty = items.filter((i) => !i.done && !i.required).length;
  return (
    <Dialog title={approving ? 'Approve this document' : 'Check before you finish'} onClose={onBack}>
      <dl className="sg-review">
        <div>
          <dt>{approving ? 'You are approving as' : 'You are signing as'}</dt>
          <dd><b><bdi>{me.name}</bdi></b><br /><span className="muted">{me.email}</span>{onRename && <div style={{ marginTop: 6 }}><FixName name={me.name} onRename={onRename} /></div>}</dd>
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
      {cannotPrint.length > 0 && (
        <div className="notice warn sg-problem sg-cannot-print" role="status">
          <b>{CANNOT_PRINT_HEAD}</b>
          <ul>{cannotPrint.map((p) => <li key={p.field_id || 'name'}>{p.label}: <bdi>{shownChars(p.chars)}</bdi></li>)}</ul>
          {CANNOT_PRINT_THEN}{' '}
          {cannotPrint.some((p) => p.field_id) && 'To have an answer readable on the PDF, go back and add the same in Latin letters as well, for example in brackets after it. '}
          {cannotPrint.some((p) => !p.field_id) && `For your name, ask ${sender.name} to add it in Latin letters as well. They can change it without sending the document again. `}
          You can also finish as it is.
        </div>
      )}
      {note}
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
export function FieldSheet({ field, value, dateFormat, onChange, onDone, onNext }: { field: any; value: string; dateFormat?: string | null; onChange: (v: string) => void; onDone: () => void; onNext?: () => void }) {
  const input = useRef<any>(null);
  const hint = useId();
  const name = fieldName(field);
  const problem = problemWith(field, value);
  // The sheet stays open while moving from one field to the next, so move focus by hand.
  useEffect(() => input.current?.focus({ preventScroll: true }), [field.id]);
  const shared = { dir: 'auto' as const, ref: input, 'aria-label': name, 'aria-describedby': hint, 'aria-required': !!field.required, 'aria-invalid': !!problem, className: 'sg-big-input', value, 'data-autofocus': true } as const;
  return (
    <Dialog title={name} onClose={onDone} variant="field" light>
      <form onSubmit={(e) => {
        e.preventDefault();
        // Stay on a field that still needs putting right. Done remains available to look at the document first.
        if (problem) return input.current?.focus();
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
        {problem
          ? <p id={hint} className="sg-sheet-hint bad" role="alert">{problem}</p>
          : <p id={hint} className="sg-sheet-hint">{field.type === 'date' && value ? `On the document this date is written as ${formatDateValue(value, dateFormat)}.` : field.type === 'number' ? `${NUMBER_HINT}${field.required ? '' : ' Optional.'}` : field.required ? 'Required' : 'Optional. Leave it empty if it does not apply.'}</p>}
        <div className="actions">
          <button type="button" className={`btn${onNext ? '' : ' primary'}`} onClick={onDone}>Done</button>
          {onNext && <button className="btn primary">Next</button>}
        </div>
      </form>
    </Dialog>
  );
}
