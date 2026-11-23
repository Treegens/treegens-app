'use client';
// "One more thing": the screen that asks a login for its phone number (src/server/signuprules.ts).
//   - A login made with Google or Microsoft gives it here once, before the app opens.
//   - A login from before the rule is asked once at its next visit and may say "Not now". It is asked again when it
//     sends its next new document: the server refuses that send with the code "phone_needed", and the app shows this
//     screen over the page, with a way back. Nothing that is already out is touched.
// One box, one button: it is meant to take ten seconds.
import { useState } from 'react';
import { api, toast } from './ui';
import { PhoneField, usePhone, phoneBody, phoneProblem } from './PhoneField';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const say = (key: string, vars: Record<string, string | number> = {}) => t(SOURCE_LOCALE, key, vars);

/** The form alone: the number, the button, and after it the optional check by code where the server can text. */
export function PhoneForm({ me, button, onSaved, autoFocus = false, why = true }: { me: any; button: string; onSaved: (r: any) => void; autoFocus?: boolean; why?: boolean }) {
  const [phone, setPhone] = usePhone();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const wrong = phoneProblem(phone);
    if (wrong) return setError(wrong);
    setBusy(true);
    setError('');
    try {
      onSaved(await api('/me/phone', { body: phoneBody(phone) }));
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate data-user={me?.user?.id || ''}>
      <PhoneField T={say} value={phone} onChange={setPhone} autoFocus={autoFocus} why={why} />
      {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <button className="btn primary" disabled={busy} style={{ minHeight: 44 }}>{button}</button>
    </form>
  );
}

/** Checking a saved number by a code sent as a text message. Shown only where the server sends texts; never required. */
export function PhoneVerify({ onDone }: { onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const act = (p: Promise<any>, then: (r: any) => void) => p.then(then).catch((e: any) => setError(e?.message || 'Something went wrong.'));
  return (
    <div className="phone-verify" style={{ marginTop: 12 }}>
      <p className="small muted" style={{ margin: '0 0 8px' }}>{say('phone.verify.offer')}</p>
      {!sent ? <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => (setError(''), act(api('/me/phone/code', { method: 'POST' }), () => setSent(true)))}>{say('phone.verify.send')}</button> : (
        <form onSubmit={(e) => (e.preventDefault(), setError(''), act(api('/me/phone/verify', { body: { code } }), () => (toast(say('phone.verify.done')), onDone())))} className="row wrap">
          <label className="f" style={{ margin: 0 }}><span>{say('phone.verify.code')}</span><input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} required autoFocus /></label>
          <button className="btn sm" style={{ minHeight: 44, alignSelf: 'flex-end' }}>{say('phone.verify.button')}</button>
        </form>
      )}
      {error && <div className="notice err" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/**
 * The whole screen. `onClose`: set when the screen came up over a page because a send was refused; it then offers
 * the way back in place of "Not now".
 */
export function PhoneRequired({ me, onDone, onClose }: { me: any; onDone: () => void; onClose?: () => void }) {
  const ask: string = me.phone?.ask || 'now';
  const [busy, setBusy] = useState(false);
  const later = () => {
    setBusy(true);
    api('/me/phone/later', { method: 'POST' }).then(onDone).catch((e: any) => (toast(e?.message || 'Something went wrong.', true), setBusy(false)));
  };
  return (
    <main className="authbox phone-need" style={{ maxWidth: 480 }}>
      <div className="card">
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>{say('phone.title')}</h1>
        <p style={{ marginBottom: 14 }}>{say(onClose ? 'phone.body_send' : ask === 'now' ? 'phone.body_new' : 'phone.body_old')}</p>
        <PhoneForm me={me} button={say('phone.button.save')} autoFocus onSaved={() => (toast(say(onClose ? 'phone.saved_send' : 'phone.saved')), onDone())} />
        <div className="actions" style={{ marginTop: 14 }}>
          {onClose ? <button type="button" className="btn" style={{ minHeight: 44 }} onClick={onClose}>{say('phone.back')}</button>
            : ask === 'may_wait' ? <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={later}>{say('phone.later')}</button>
            : <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/login'))}>{say('phone.sign_out')}</button>}
        </div>
        {!onClose && ask === 'may_wait' && <p className="small muted" style={{ margin: '10px 0 0' }}>{say('phone.later_note')}</p>}
      </div>
    </main>
  );
}
