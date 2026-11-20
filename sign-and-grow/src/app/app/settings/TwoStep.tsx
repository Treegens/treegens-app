'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate, toast, Modal } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SetUpTwoStep, RecoveryCodes, CodeField, LostPhoneRules } from '@/components/TwoStep';
import { TWO_STEP_API_KEYS, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_REMEMBER_DAYS } from '@/lib/policy';

// Settings, Profile: two-step login of this login. Settings, Team: the team rule and resets by an admin. The rules
// are in src/server/twostep.ts and the routes in src/server/routes-twostep.ts.

const longMoment = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
type Doing = '' | 'setup' | 'move' | 'codes' | 'off';

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
      <CodeField id={`ts-${label.replace(/\W+/g, '-').toLowerCase()}`} value={code} onChange={setCode} label="Code from your authenticator app, or a recovery code" autoFocus />
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
  const done = (text = '') => {
    setDoing('');
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
      {d.paused_until && <div className="notice warn" role="status" style={{ margin: '10px 0' }}>Wrong codes were typed for your login, so its second step is paused until {longMoment(d.paused_until)}. No code works before then.</div>}
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
          <p style={{ margin: '10px 0' }}>Off. Your password alone signs in.</p>
          <button className="btn primary" onClick={() => (setSaid(''), setDoing('setup'))}>Set up two-step login</button>
        </>)}
      {!codes && d.on && (
        <>
          <p style={{ margin: '10px 0' }}><b>On</b> since {longMoment(d.since)}. {d.recovery_left === 0 ? 'You have no recovery codes left: make new ones now.' : `${d.recovery_left} recovery ${d.recovery_left === 1 ? 'code is' : 'codes are'} left.`}</p>
          {required.length > 0 && <p className="muted small">{required.join(', ')} {required.length === 1 ? 'asks' : 'ask'} everyone on the team for it, so it cannot be switched off while you are on {required.length === 1 ? 'that team' : 'those teams'}.</p>}
          {doing === 'move' ? <SetUpTwoStep hasPassword={d.has_password} moving onDone={() => done('Two-step login moved to the new app. The app you used before no longer works for Sign&Grow. Your recovery codes stay as they were.')} onCancel={() => setDoing('')} />
            : doing === 'codes' ? <WithCode label="Make new recovery codes" onCancel={() => setDoing('')} onSubmit={async (code) => { const r = await api('/me/two-step/recovery-codes', { body: { code } }); setDoing(''); setCodes(r.codes); }} />
            : doing === 'off' ? <>
              <p className="notice warn" style={{ marginTop: 12 }}>Switching it off removes your recovery codes and the devices that skip the second step. From then on your password alone signs in.</p>
              <WithCode label="Switch off two-step login" danger onCancel={() => setDoing('')} onSubmit={async (code) => { await api('/me/two-step/off', { body: { code } }); done('Two-step login is off. We emailed you about it.'); }} />
            </>
            : (
              <div className="ts-actions">
                <button className="btn" onClick={() => (setSaid(''), setDoing('codes'))}>Make new recovery codes</button>
                <button className="btn" onClick={() => (setSaid(''), setDoing('move'))}>Move to another app</button>
                {required.length === 0 && <button className="btn danger" onClick={() => (setSaid(''), setDoing('off'))}>Switch off</button>}
                <button className="btn ghost" onClick={() => window.confirm(d.owner ? `We email you a link to start a reset by email. It switches your second step off ${TWO_STEP_EMAIL_RESET_DAYS} days after you open it, and we email you every day until then. Send it?` : 'We email you who can reset your second step: an owner or admin of your team. Send it?') && api('/me/two-step/lost', { method: 'POST' }).then((r) => setSaid(`We sent an email to ${r.sent_to}. ${r.owner ? 'Open the link in it to start the reset.' : 'It names the people who can reset it for you.'}`)).catch((e) => setSaid(e.message))}>I lost my phone and my recovery codes</button>
              </div>
            )}
          <h3 style={{ margin: '18px 0 4px', fontSize: 16 }}>Devices that skip the second step</h3>
          <p className="muted small">A browser where you ticked &quot;Remember this device&quot; asks only for your password, for {TWO_STEP_REMEMBER_DAYS} days from that day. Withdraw one you no longer use, or that was not yours.</p>
          {d.devices.length === 0 ? <p className="muted small">None.</p> : (
            <>
              <ul className="ts-list">
                {d.devices.map((x: any) => (
                  <li key={x.id}>
                    <div><b>{x.device}</b>, {x.browser}<div className="muted small">Remembered {fmtDate(x.since)}, last used {fmtDate(x.last_used_at)}, until {fmtDate(x.until)}</div></div>
                    <button className="btn" aria-label={`Stop skipping on ${x.device}, ${x.browser}`} onClick={() => api(`/me/two-step/devices/${x.id}`, { method: 'DELETE' }).then(() => (toast('That device asks for the code again'), reload())).catch((e) => setSaid(e.message))}>Withdraw</button>
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
              {m.last_reset && <div className="muted small">Reset by {m.last_reset.by} on {fmtDate(m.last_reset.at)}</div>}</div>
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
            <CodeField id="ts-team" value={code} onChange={setCode} label="Your code from your authenticator app, or a recovery code" autoFocus />
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
            {d.you_on && <CodeField id="ts-reset" value={code} onChange={setCode} label="Your code from your authenticator app, or a recovery code" autoFocus />}
            {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="actions"><button type="button" className="btn" onClick={() => setReset(null)}>Cancel</button><button className="btn danger" disabled={busy || (d.you_on && !code.trim())}>Reset it</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}
