'use client';
import { useId, useState } from 'react';
import { api, toast } from './ui';
import { bounceDay } from '@/lib/mailnews';

// The address of a login: the notice on every page of the app while our emails to it come back (GET /me,
// email_problem), and the form that moves the login to another address (POST /me/email, src/server/routes-bounces.ts).
// Both take `me` from their caller, so this file needs nothing from AppShell.

const TAP = { minHeight: 44 };
const friendly = (e: any) => (e?.status ? e.message : 'We could not reach GrowSigning, so nothing was changed. Check your connection and try again.');

/** Asks for the new address (and the password, when the login has one) and emails a link there. Nothing changes before that link is opened. */
export function EmailChangeForm({ me, onCancel }: { me: any; onCancel?: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // With two-step login on, the address is moved only with a current code too (src/server/twostep.ts).
  const [code, setCode] = useState('');
  const twoStep = !!me.user.two_step;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const id = useId();
  const pw = me.user.has_password !== false;
  async function send(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/me/email', { body: { email: email.trim(), ...(pw ? { password } : {}), ...(twoStep ? { code } : {}) } });
      setSent(r.sent_to);
      setPassword('');
      setCode('');
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  if (sent) return (
    <p className="small" role="status" style={{ margin: '8px 0 0' }}>
      We emailed a link to <b>{sent}</b>. Open it in this browser within an hour to finish. Until then your login keeps {me.user.email}, and nothing else changes. No email there? Check the address and send it again.
    </p>
  );
  return (
    <form onSubmit={send} className="sn-email-form" aria-labelledby={`${id}-h`}>
      <p id={`${id}-h`} className="small" style={{ margin: '8px 0' }}>Type the address you want to use from now on. We email a link there, and the change is made once you open it in this browser. Your documents, team and plan stay as they are.</p>
      <label className="f"><span>New email address</span><input type="email" autoComplete="email" inputMode="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} style={TAP} /></label>
      {pw && <label className="f"><span>Your current password</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={TAP} /></label>}
      {twoStep && <label className="f"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} style={TAP} /></label>}
      {error && <p className="notice err" role="alert">{error}</p>}
      <div className="row wrap">
        <button className="btn primary" disabled={busy || !email.trim() || (pw && !password) || (twoStep && !code.trim())} style={TAP}>{busy ? 'Sending…' : 'Email me a link to confirm it'}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel} style={TAP}>Cancel</button>}
      </div>
    </form>
  );
}

/**
 * On every page of the app while our last email to this login came back for good. It says what happened and the two
 * ways on: move the login to an address that works, or say this one works again (which sends one email to try it).
 */
export function EmailProblemBanner({ me }: { me: any }) {
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = me.email_problem;
  if (!p) return null;
  async function works() {
    setBusy(true);
    try {
      const r = await api('/me/email-works', { method: 'POST' });
      toast(r.delivery === 'outbox' ? 'The notice is gone. This server has no mail server, so no email went out to try it.' : `The notice is gone, and we sent an email to ${p.address} to try it. If that one comes back too, the notice is back.`);
      me.reload();
    } catch (e) {
      toast(friendly(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notice warn sn-email-problem" role="alert" style={{ marginBottom: 16 }}>
      <p style={{ margin: 0 }}>
        <b>Our emails to {p.address} are not arriving.</b> On {bounceDay(p.since)} the mail server of that address answered: {p.reason}. So you may be missing receipts, renewal reminders and news about your documents. If the mailbox works again, tell us. If not, move your login to an address that works.
      </p>
      {moving ? <EmailChangeForm me={me} onCancel={() => setMoving(false)} /> : (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={busy} onClick={works} style={TAP}>{busy ? 'Sending…' : 'It works now, try again'}</button>
          <button className="btn sm" onClick={() => setMoving(true)} style={TAP} aria-expanded={false}>Use another address</button>
        </div>
      )}
    </div>
  );
}

/** Settings, Profile: the address of the login, and the way to move it. */
export function EmailAddressCard({ me }: { me: any }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // The button stays on the page while the form is open, and says so (aria-expanded): pressing it again closes the form.
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}>Email address</h2>
      <p className="muted small">You sign in with {me.user.email}, and our emails to you go there.{me.email_problem ? ' Our last email to it came back, see the notice at the top.' : ''}</p>
      <button type="button" className="btn sm" style={TAP} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${id}-change`} data-more="item">Change email address</button>
      <div id={`${id}-change`} hidden={!open}>{open && <EmailChangeForm me={me} onCancel={() => setOpen(false)} />}</div>
    </div>
  );
}
