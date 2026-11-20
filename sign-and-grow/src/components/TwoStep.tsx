'use client';
import { useState } from 'react';
import { api } from './ui';
import { QrCode } from './QrCode';
import { qrSvg } from '@/lib/qr';
import { TWO_STEP_API_KEYS, TWO_STEP_LOST, TWO_STEP_RECOVERY_CODES, TWO_STEP_TRIES, TWO_STEP_PAUSE_MINUTES } from '@/lib/policy';

// Setting up two-step login, and the recovery codes shown once. Used under Settings, Profile, and by the screen a
// team that asks for it shows to someone without it (TwoStepRequired). The rules are in src/server/twostep.ts.

const group = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

// The box a code is typed into. Six digits from the app, or a recovery code: the server tells them apart.
// `either`: the box also takes a recovery code, so a phone shows its full keyboard.
export function CodeField({ value, onChange, label = 'Code from your authenticator app', recovery = false, either = false, autoFocus = false, id }: { value: string; onChange: (v: string) => void; label?: string; recovery?: boolean; either?: boolean; autoFocus?: boolean; id?: string }) {
  const letters = recovery || either;
  return (
    <label className="f" htmlFor={id}>
      <span>{label}</span>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} required autoFocus={autoFocus} className="ts-code"
        inputMode={letters ? 'text' : 'numeric'} autoComplete="one-time-code" autoCapitalize="off" spellCheck={false}
        maxLength={letters ? 14 : 8} pattern={letters ? undefined : '[0-9 ]*'} aria-describedby={id ? `${id}-hint` : undefined} />
      {id && <span id={`${id}-hint`} className="hint">{recovery ? 'Ten letters and digits, as printed. Capitals, spaces and the dash do not matter.' : either ? 'The 6 digits your app shows for GrowSigning now, or one of your recovery codes as printed.' : 'The 6 digits your app shows for GrowSigning. A new one comes every 30 seconds: type the newest.'}</span>}
    </label>
  );
}

// Shown once. Kept as text, a file or on paper, never here.
export function RecoveryCodes({ codes, onKept }: { codes: string[]; onKept: () => void }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `GrowSigning recovery codes\nEach one signs you in once, in place of the code from your app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'growsigning-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="twostep">
      <div className="notice warn" role="alert">
        <b>Keep these {codes.length} recovery codes now. You will not see them again.</b> Each one signs you in once if you lose your phone. Print them, or save them where you keep passwords, somewhere that is not this phone. Without them and without your phone, getting back in takes an admin of your team, or a reset by email that takes days.
      </div>
      <ol className="ts-codes mono" aria-label="Your recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'Copied' : 'Copy them'}</button>
        <button type="button" className="btn" onClick={download}>Save as a text file</button>
        <button type="button" className="btn" onClick={() => window.print()}>Print</button>
      </div>
      <label className="setting-row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
        <span>I have kept these codes somewhere safe.</span>
      </label>
      <button type="button" className="btn primary" disabled={!kept} onClick={onKept}>Done</button>
    </div>
  );
}

// What happens if the phone is lost, said where two-step login is switched on.
export function LostPhoneRules() {
  return (
    <div className="ts-rules">
      <b>If you lose your phone</b>
      <ul className="rules">
        <li>Use one of your {TWO_STEP_RECOVERY_CODES} recovery codes in place of the code. Each works once, and the sign-in says how many are left. You can make new ones under Settings.</li>
        {TWO_STEP_LOST.map((l) => <li key={l}>{l}</li>)}
      </ul>
      <p className="muted small">{TWO_STEP_TRIES} wrong codes in a row after your password pause the second step of your login for {TWO_STEP_PAUSE_MINUTES} minutes, and we email you. Wrong codes after a wrong password pause only the internet address they came from, so someone who does not know your password cannot keep you out. Changing your password, your email address or two-step login itself asks for a code. {TWO_STEP_API_KEYS}</p>
    </div>
  );
}

type Step = { kind: 'start' } | { kind: 'scan'; secret: string; uri: string; account: string } | { kind: 'codes'; codes: string[] };

// Switching it on, or moving it to another app (`moving`): the password (or, when moving, the current code), then
// the secret as a picture, as text and as a link, then a code from the app, then the recovery codes.
export function SetUpTwoStep({ hasPassword, moving = false, onDone, onCancel }: { hasPassword: boolean; moving?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    fn().catch((e: any) => setError(e?.message || 'Something went wrong. Nothing was changed.')).finally(() => setBusy(false));
  };
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/me/two-step/setup', { body: moving ? { code } : hasPassword ? { password: pw } : {} });
      setCode('');
      setStep({ kind: 'scan', secret: r.secret, uri: r.uri, account: r.account });
    });
  };
  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/me/two-step/confirm', { body: { code } });
      if (r.codes?.length) setStep({ kind: 'codes', codes: r.codes });
      else onDone();
    });
  };
  if (step.kind === 'codes') return <RecoveryCodes codes={step.codes} onKept={onDone} />;
  if (step.kind === 'scan') {
    let svg = '';
    try {
      svg = qrSvg(step.uri);
    } catch {
      /* the text and the link below still work */
    }
    return (
      <form className="twostep" onSubmit={confirm}>
        <p><b>1. Add GrowSigning to your authenticator app.</b> Open the app on your phone, choose to add an account, and scan this picture. Any app that shows 6-digit sign-in codes works.</p>
        {svg && <QrCode svg={svg} label="A QR code that adds your GrowSigning login to an authenticator app" />}
        <p style={{ marginTop: 12 }}>Cannot scan it? Choose to type a key in the app, and type this one (spaces do not matter). The type is &quot;time-based&quot;.</p>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <code className="ts-secret" aria-label={`Key: ${step.secret.split('').join(' ')}`}>{group(step.secret)}</code>
          <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(step.secret).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy the key'}</button>
        </div>
        <p className="small muted">The app on this device? <a href={step.uri}>Open it in an authenticator app here</a>. Account name in the app: {step.account}. Keep this key to yourself: whoever has it can make your codes.</p>
        <p style={{ marginTop: 14 }}><b>2. Type the code the app shows now.</b> {moving ? 'The app you used before stops working for GrowSigning once this one is confirmed.' : 'Two-step login switches on only when this code is right.'}</p>
        <CodeField id="ts-confirm" value={code} onChange={setCode} autoFocus />
        {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy || !code.trim()}>{busy ? 'Checking…' : moving ? 'Move to this app' : 'Switch on two-step login'}</button>
          {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    );
  }
  return (
    <form className="twostep" onSubmit={start}>
      {!moving && <LostPhoneRules />}
      {moving
        ? <CodeField id="ts-move" value={code} onChange={setCode} label="Code from the app you use now, or a recovery code" either autoFocus />
        : hasPassword
          ? <label className="f"><span>Your password</span><input type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /><span className="hint">So that nobody who finds this browser signed in can put their own phone in front of your login.</span></label>
          : <p className="small muted">Your login has no password, so this works within 15 minutes of signing in. If you are told to sign in again, sign out and back in with Google or Microsoft, and come straight back.</p>}
      {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || (moving ? !code.trim() : hasPassword && !pw)}>{busy ? 'One moment…' : moving ? 'Continue' : 'Set up two-step login'}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// On every page of the app, in every browser signed in to the login, while a reset by email is under way (the
// owner's decision): someone who did not ask for it must not miss it. Stopping it needs no code: it only keeps the
// second step as it is.
export function TwoStepResetBanner({ me }: { me: any }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const at = me?.two_step?.reset_at;
  if (said) return <div className="notice row between wrap" role="status" style={{ marginBottom: 16 }}><span>{said}</span><button className="btn" style={{ minHeight: 44 }} onClick={() => setSaid('')}>OK</button></div>;
  if (!at) return null;
  const when = new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const stop = () => {
    setBusy(true);
    api('/me/two-step/reset/stop', { method: 'POST' })
      .then(() => (setSaid('The reset was stopped, and two-step login stays on. We emailed you that it stopped. If you did not ask for it, change your password now under Settings, Profile, and the password of your mailbox.'), me.reload?.()))
      .catch((e: any) => setSaid(e?.message || 'We could not reach GrowSigning, so nothing was stopped. Check your connection and press the button again.'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="banner ts-reset" role="alert">
      <span><b>Two-step login of your login will be switched off on {when}.</b> Someone who typed your password asked for a reset by email, saying the phone and the recovery codes are lost. If that was you, there is nothing to do. If not, stop it now, then change your password and the password of your mailbox.</span>
      <button className="btn" disabled={busy} onClick={stop}>{busy ? 'Stopping…' : 'Stop the reset'}</button>
    </div>
  );
}

// What a team that asks everyone for two-step login shows, in place of the app, to someone signed in without it.
export function TwoStepRequired({ me }: { me: any }) {
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState('');
  const others = (me.accounts || []).filter((a: any) => a.id !== me.account.id);
  // Two-step login needs a confirmed address (src/server/routes-twostep.ts), and this screen hides the rest of the
  // app, with its banner that sends the confirmation again. So it is offered here.
  if (!me.user.email_verified && !done) return (
    <main className="authbox" style={{ maxWidth: 560 }}>
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>Confirm your email address first</h1>
        <p>{me.account.name} asks everyone on the team to sign in with two-step login, and it can only be switched on for a confirmed address. Open the link we sent to {me.user.email}, in this browser, then come back here to set it up.</p>
        {resent && <p className="notice" role="status">{resent}</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary" onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => setResent(`We sent the link again to ${me.user.email}. It can take a few minutes, and may land among spam.`)).catch((e: any) => setResent(e?.message || 'We could not send it. Try again in a minute.'))}>Send the link again</button>
          <button className="btn" onClick={() => window.location.reload()}>I have confirmed it</button>
          <button className="btn" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/'))}>Sign out</button>
        </div>
      </div>
    </main>
  );
  return (
    <main className="authbox" style={{ maxWidth: 560 }}>
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>Set up two-step login to open {me.account.name}</h1>
        <p>{me.account.name} asks everyone on the team to sign in with two-step login: after the password, a 6-digit code from an authenticator app on your phone. Until yours is set up, nothing else in {me.account.name} opens. It takes a minute.</p>
        {done
          ? <button className="btn primary" onClick={() => window.location.assign('/app')}>Open {me.account.name}</button>
          : <SetUpTwoStep hasPassword={me.user.has_password !== false} onDone={() => setDone(true)} />}
        <hr style={{ margin: '18px 0', border: 0, borderTop: '1px solid var(--line)' }} />
        <p className="small muted">Cannot set it up now? {others.length ? 'Your other workspaces are not affected:' : 'Ask an owner or admin of the team, or sign out.'}</p>
        <div className="row wrap" style={{ gap: 8 }}>
          {others.map((a: any) => <button key={a.id} className="btn" onClick={() => api('/auth/switch', { body: { account_id: a.id } }).then(() => window.location.assign('/app')).catch(() => {})}>Open {a.name}</button>)}
          <button className="btn" onClick={() => api('/auth/logout', { method: 'POST' }).then(() => window.location.assign('/'))}>Sign out</button>
        </div>
      </div>
    </main>
  );
}
