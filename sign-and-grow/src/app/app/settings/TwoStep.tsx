'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate, toast, Modal } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SetUpTwoStep, RecoveryCodes, CodeField, LostPhoneRules } from '@/components/TwoStep';
import { TWO_STEP_API_KEYS, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_REMEMBER_DAYS, TWO_STEP_EMAIL_RESET_RISK, TWO_STEP_RESET_BLOCK_DAYS } from '@/lib/policy';

// Settings, Profile: two-step login of this login. Settings, Team: the team rule and resets by an admin. The rules
// are in src/server/twostep.ts and the routes in src/server/routes-twostep.ts.

const longMoment = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
type Doing = '' | 'setup' | 'move' | 'codes' | 'off' | 'lost' | 'email';
// What POST /me/two-step/lost emailed, in words for the screen.
const WAY_BACK: Record<string, string> = {
  link: 'Open the link in it to start the reset by email.',
  under_way: 'A reset by email is already under way, so nothing else was started.',
  blocked: `A reset by email was stopped recently, so a new one cannot start yet. The email says from when.`,
  admins: 'The reset by email is switched off for your login, so it names who on your team can reset your second step.',
  nobody: 'The reset by email is switched off for your login, and nobody else can reset it, so a recovery code or a remembered device is what is left.',
};

// "I lost my phone and my recovery codes", from a browser that is still signed in. The password is asked for, as on
// the sign-in screen: a browser left signed in is not enough to start a reset.
function LostForm({ onDone, onCancel }: { onDone: (said: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="twostep" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      setBusy(true);
      setError('');
      api('/me/two-step/lost', { body: { password: pw } }).then((r) => onDone(`We sent an email to ${r.sent_to}. ${WAY_BACK[r.what] || ''}`)).catch((x: any) => setError(x?.message || 'Something went wrong. Nothing was emailed.')).finally(() => setBusy(false));
    }}>
      <p>We email you what you can do. If the reset by email is allowed, the email has a link that starts it: your second step is then switched off {TWO_STEP_EMAIL_RESET_DAYS} days later, and every day until then we email you and every browser where you are signed in says so.</p>
      <label className="f" htmlFor="ts-lost-pw"><span>Your password</span><input id="ts-lost-pw" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /><span className="hint">A reset by email needs the password of your login.</span></label>
      {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="ts-actions"><button className="btn primary" disabled={busy || !pw}>{busy ? 'Sending…' : 'Email me what to do'}</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

// A change that needs the current code: one box and one button, and what the server said.
function WithCode({ label, danger, onSubmit, onCancel }: { label: string; danger?: boolean; onSubmit: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="twostep" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      setBusy(true);
      setError('');
      onSubmit(code).catch((x: any) => setError(x?.message || 'Something went wrong. Nothing was changed.')).finally(() => setBusy(false));
    }}>
      <CodeField id={`ts-${label.replace(/\W+/g, '-').toLowerCase()}`} value={code} onChange={setCode} label="Code from your authenticator app, or a recovery code" either autoFocus />
      {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="ts-actions"><button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || !code.trim()}>{label}</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export function TwoStepCard() {
  const me = useMe();
  const [d, reload, failed] = useLoad(() => api('/me/two-step'));
  const [doing, setDoing] = useState<Doing>('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [said, setSaid] = useState('');
  // The switch "Allow a reset by email" shows what the person chose while the code for it is asked.
  const [wish, setWish] = useState<boolean | null>(null);
  const done = (text = '') => {
    setDoing('');
    setWish(null);
    setSaid(text);
    reload();
    me.reload();
  };
  if (!d) return failed ? <section className="card"><h2>Two-step login</h2><p className="notice err">We could not load this part. Reload the page.</p></section> : null;
  const required: string[] = d.required_by || [];
  return (
    <section className="card twostep" id="two-step" aria-labelledby="two-step-h">
      <h2 id="two-step-h" style={{ marginBottom: 4 }}>Two-step login</h2>
      <p className="muted small">After your password (or after Google or Microsoft), a 6-digit code from an authenticator app on your phone. Someone who learns your password still cannot get in without your phone.</p>
      {said && <div className="notice" role="status" style={{ margin: '10px 0' }}>{said}</div>}
      {d.paused_until && <div className="notice warn" role="status" style={{ margin: '10px 0' }}>Wrong codes were typed after your password, so signing in to your login with a code is paused until {longMoment(d.paused_until)}. This browser stays signed in, and changes here are not affected. If it was not you, someone knows your password: change it now.</div>}
      {d.reset_at && (
        <div className="notice warn" role="alert" style={{ margin: '10px 0' }}>
          <b>A reset by email is under way.</b> Two-step login of your login will be switched off on {longMoment(d.reset_at)}. If you did not start it, someone knows your password and can read your mailbox: stop it, and change both.
          <div className="ts-actions"><button className="btn" onClick={() => api('/me/two-step/reset/stop', { method: 'POST' }).then(() => done('The reset was stopped. Two-step login stays on, and we emailed you that it stopped.')).catch((e) => setSaid(e.message))}>Stop the reset</button></div>
        </div>
      )}
      {codes && <RecoveryCodes codes={codes} onKept={() => (setCodes(null), done('Your new recovery codes are the only ones that work now.'))} />}
      {!codes && !d.on && (doing === 'setup'
        ? <SetUpTwoStep hasPassword={d.has_password} onDone={() => done('Two-step login is on. Every other browser that was signed in to your login was signed out.')} onCancel={() => setDoing('')} />
        : <>
          <p style={{ margin: '10px 0' }}>Off. Signing in asks for no code.</p>
          {d.email_verified
            ? <button className="btn primary" onClick={() => (setSaid(''), setDoing('setup'))}>Set up two-step login</button>
            : <p className="notice warn" role="status">Confirm your email address first: open the link we sent to {me.user.email}, or have it sent again at the top of this page. Two-step login can only be switched on for a confirmed address, so that nobody can put their phone in front of a login made in someone else&apos;s name.</p>}
        </>)}
      {!codes && d.on && (
        <>
          <p style={{ margin: '10px 0' }}><b>On</b> since {longMoment(d.since)}. {d.recovery_left === 0 ? 'You have no recovery codes left: make new ones now.' : `${d.recovery_left} recovery ${d.recovery_left === 1 ? 'code is' : 'codes are'} left.`}</p>
          {required.length > 0 && <p className="muted small">{required.join(', ')} {required.length === 1 ? 'asks' : 'ask'} everyone on the team for it, so it cannot be switched off while you are on {required.length === 1 ? 'that team' : 'those teams'}.</p>}
          {doing === 'move' ? <SetUpTwoStep hasPassword={d.has_password} moving onDone={() => done('Two-step login moved to the new app. The app you used before no longer works for GrowSigning. Your recovery codes stay as they were.')} onCancel={() => setDoing('')} />
            : doing === 'codes' ? <WithCode label="Make new recovery codes" onCancel={() => setDoing('')} onSubmit={async (code) => { const r = await api('/me/two-step/recovery-codes', { body: { code } }); setDoing(''); setCodes(r.codes); }} />
            : doing === 'off' ? <>
              <p className="notice warn" style={{ marginTop: 12 }}>Switching it off removes your recovery codes and the devices that skip the second step. From then on signing in asks for no code.</p>
              <WithCode label="Switch off two-step login" danger onCancel={() => setDoing('')} onSubmit={async (code) => { await api('/me/two-step/off', { body: { code } }); done('Two-step login is off. We emailed you about it.'); }} />
            </>
            : doing === 'lost' ? <LostForm onCancel={() => setDoing('')} onDone={(text) => done(text)} />
            : (
              <div className="ts-actions">
                <button className="btn" onClick={() => (setSaid(''), setDoing('codes'))}>Make new recovery codes</button>
                <button className="btn" onClick={() => (setSaid(''), setDoing('move'))}>Move to another app</button>
                {required.length === 0 && <button className="btn danger" onClick={() => (setSaid(''), setDoing('off'))}>Switch off</button>}
                <button className="btn ghost" onClick={() => (setSaid(''), setDoing('lost'))}>I lost my phone and my recovery codes</button>
              </div>
            )}
          <h3 style={{ margin: '18px 0 4px', fontSize: 16 }}>Reset by email</h3>
          <label className="setting-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={wish ?? d.email_reset.allowed} disabled={doing === 'email'} aria-describedby="ts-email-reset-hint"
              onChange={(e) => (setSaid(''), setWish(e.target.checked), setDoing('email'))} />
            <span>Allow a reset by email<span id="ts-email-reset-hint" className="muted small" style={{ display: 'block' }}>If you lose your phone and your recovery codes: after your password, a link by email switches your second step off {TWO_STEP_EMAIL_RESET_DAYS} days later, with an email every day until then and a notice on every page where you are signed in.</span></span>
          </label>
          {d.email_reset.blocked_until && d.email_reset.allowed && <p className="muted small">A reset by email was stopped recently, so a new one can be asked for from {longMoment(d.email_reset.blocked_until)}, or sooner after you sign in with your code.</p>}
          {doing === 'email' && wish !== null && (
            <>
              {wish
                ? <p className="notice" style={{ marginTop: 12 }}>With this on, someone who loses the phone and the recovery codes can get back in by email, after the right password and a wait of {TWO_STEP_EMAIL_RESET_DAYS} days. {TWO_STEP_EMAIL_RESET_RISK}</p>
                : <p className="notice warn" style={{ marginTop: 12 }}><b>Before you switch it off:</b> {d.email_reset.admins_can
                  ? 'if you lose your phone and your recovery codes, only an owner or admin of your team can switch your second step off.'
                  : 'if you lose your phone and your recovery codes, nobody can switch your second step off, because you own a workspace or are an admin of more than one. You would be locked out of your login for good.'} Keep your recovery codes somewhere safe. {TWO_STEP_EMAIL_RESET_RISK}</p>}
              <WithCode label={wish ? 'Allow a reset by email' : 'Switch the reset by email off'} danger={!wish} onCancel={() => (setWish(null), setDoing(''))}
                onSubmit={async (code) => { await api('/me/two-step/email-reset', { body: { allowed: wish, code } }); done(wish ? 'A reset by email is allowed again. We emailed you about it.' : 'The reset by email is off. We emailed you about it.'); }} />
            </>
          )}
          <h3 style={{ margin: '18px 0 4px', fontSize: 16 }}>Devices that skip the second step</h3>
          <p className="muted small">A browser where you ticked &quot;Remember this device&quot; asks only for your password, for {TWO_STEP_REMEMBER_DAYS} days from that day. Withdraw one you no longer use, or that was not yours. Withdrawing one also signs that browser out; this browser stays signed in.</p>
          {d.devices.length === 0 ? <p className="muted small">None.</p> : (
            <>
              <ul className="ts-list">
                {d.devices.map((x: any) => (
                  <li key={x.id}>
                    <div><b>{x.device}</b>, {x.browser}<div className="muted small">Remembered {fmtDate(x.since)}, last used {fmtDate(x.last_used_at)}, until {fmtDate(x.until)}</div></div>
                    <button className="btn" aria-label={`Stop skipping on ${x.device}, ${x.browser}`} onClick={() => api(`/me/two-step/devices/${x.id}`, { method: 'DELETE' }).then((r) => (toast(r.signed_out ? 'That device asks for the code again, and it was signed out' : 'That device asks for the code again'), reload())).catch((e) => setSaid(e.message))}>Withdraw</button>
                  </li>
                ))}
              </ul>
              {d.devices.length > 1 && <button className="btn" onClick={() => api('/me/two-step/devices', { method: 'DELETE' }).then(() => (toast('Every device asks for the code again'), reload())).catch((e) => setSaid(e.message))}>Withdraw all</button>}
            </>
          )}
          <details style={{ marginTop: 14 }}>
            <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>If you lose your phone, and what two-step login covers</summary>
            <LostPhoneRules />
          </details>
        </>
      )}
      {d.log?.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>What happened to your second step</summary>
          <ul className="ts-list">{d.log.map((l: any, i: number) => <li key={i}><span>{l.text}</span><span className="muted small">{longMoment(l.at)}</span></li>)}</ul>
        </details>
      )}
      {!d.on && <p className="muted small" style={{ marginTop: 12 }}>{TWO_STEP_API_KEYS}</p>}
    </section>
  );
}

// Settings, Team, for admins: who has it, the owner's rule for everyone, and resets for members who lost their phone.
export function TeamTwoStep() {
  const me = useMe();
  const [d, reload] = useLoad(() => api('/account/two-step'));
  const [asking, setAsking] = useState<boolean | null>(null);
  const [reset, setReset] = useState<any>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const without = d.members.filter((m: any) => !m.on);
  const act = (fn: () => Promise<any>) => {
    setBusy(true);
    setError('');
    fn().then(() => (setAsking(null), setReset(null), setCode(''), reload(), me.reload())).catch((e: any) => setError(e?.message || 'Something went wrong. Nothing was changed.')).finally(() => setBusy(false));
  };
  return (
    <section className="card twostep" aria-labelledby="team-two-step-h">
      <h2 id="team-two-step-h" style={{ marginBottom: 4 }}>Two-step login on this team</h2>
      <p className="muted small">{d.required ? `Everyone on ${me.account.name} has to use two-step login, since ${fmtDate(d.required_since)}. Someone without it is asked to set it up the next time they open ${me.account.name}, and nothing else in it opens for them until they have.` : `Members choose for themselves. ${d.members.length - without.length} of ${d.members.length} have it on.`} {TWO_STEP_API_KEYS}</p>
      <ul className="ts-list" style={{ marginTop: 8 }}>
        {d.members.map((m: any) => (
          <li key={m.id}>
            <div><b>{m.name}</b>{m.id === me.user.id ? ' (you)' : ''} <span className="muted small">{m.on ? 'On' : 'Not set up'}</span>
              {m.last_reset && <div className="muted small">Reset by {m.last_reset.by} on {fmtDate(m.last_reset.at)}</div>}
              {m.only_by_email && <div className="muted small">Only {m.name} can reset it, by email: {m.role === 'owner' ? 'they own this account' : 'they own a workspace or are an admin of another one'}.</div>}</div>
            {m.can_reset && <button className="btn" onClick={() => (setError(''), setCode(''), setReset(m))}>Reset their second step</button>}
          </li>
        ))}
      </ul>
      {d.can_require && (
        <div className="ts-actions">
          {d.required
            ? <button className="btn" onClick={() => (setError(''), setCode(''), setAsking(false))}>Stop asking everyone</button>
            : <button className="btn primary" disabled={!d.you_on} aria-describedby={!d.you_on ? 'ask-first' : undefined} onClick={() => (setError(''), setCode(''), setAsking(true))}>Ask everyone for two-step login</button>}
          {!d.required && !d.you_on && <p id="ask-first" className="muted small" style={{ flexBasis: '100%', margin: 0 }}>Switch it on for yourself first, under Settings, Profile.</p>}
        </div>
      )}
      {asking !== null && (
        <Modal title={asking ? 'Ask everyone for two-step login' : 'Stop asking everyone'} onClose={() => setAsking(null)}>
          <form className="twostep" onSubmit={(e) => { e.preventDefault(); act(() => api('/account/two-step', { body: { required: asking, code } })); }}>
            <p>{asking ? `${without.length ? `${without.length === 1 ? 'One person does' : `${without.length} people do`} not have it yet. We email them now. The next time they open ${me.account.name}, they are asked to set it up, and until then nothing else in it opens for them. Their other workspaces are not affected, and API keys keep working.` : 'Everyone has it already.'}` : `Members can then switch two-step login off for themselves.`}</p>
            <CodeField id="ts-team" value={code} onChange={setCode} label="Your code from your authenticator app, or a recovery code" either autoFocus />
            {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="actions"><button type="button" className="btn" onClick={() => setAsking(null)}>Cancel</button><button className="btn primary" disabled={busy || !code.trim()}>{asking ? 'Ask everyone' : 'Stop asking'}</button></div>
          </form>
        </Modal>
      )}
      {reset && (
        <Modal title={`Reset the second step of ${reset.name}`} onClose={() => setReset(null)}>
          <form className="twostep" onSubmit={(e) => { e.preventDefault(); act(() => api(`/account/members/${reset.id}/two-step/reset`, { body: { code } }).then(() => toast(`Two-step login of ${reset.name} is off. We emailed them.`))); }}>
            <p>For someone who lost their phone and their recovery codes. Their second step is switched off at once: whoever knows their password can then sign in with it alone, until they set it up again.</p>
            <p><b>Only do this when you know it is {reset.name} asking</b>, for example on a call or in person. A message from their email address is not enough, because someone who has got into their mailbox can write that too.</p>
            <p className="muted small">{reset.name} is emailed at once, and their record says that you did it.</p>
            {d.you_on && <CodeField id="ts-reset" value={code} onChange={setCode} label="Your code from your authenticator app, or a recovery code" either autoFocus />}
            {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="actions"><button type="button" className="btn" onClick={() => setReset(null)}>Cancel</button><button className="btn danger" disabled={busy || (d.you_on && !code.trim())}>Reset it</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}
