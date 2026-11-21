'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, oops, toast, Modal, Leaf } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { AdoptSignature } from '@/components/SignaturePad';
import { PRICING, mangrovesFor } from '@/lib/impact';
// Plain constants only: the rest of policy.ts reads the environment and is for the server.
import { CLOSE_GRACE_DAYS, CLOSING_REMINDER_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION } from '@/lib/policy';
import { DEFAULT_REMINDER_DAYS, reminderText } from '@/lib/policy';
// When a signature expires, written the same way as in the emails: "3 December 2026 at 14:00 UTC".
import { expiryMoment, expiredWords, TOPUP_EXPIRY_MONTHS } from '@/lib/policy';
// The same holds for signin.ts: the names and the words only.
import { PROVIDER_NAMES, isProviderId, signInErrorText } from '@/lib/signin';
import { SignedIn } from './SignedIn';
import { TwoStepCard, TeamTwoStep } from './TwoStep';
import { EmailAddressCard } from '@/components/EmailProblem';
// The team's company stamps (src/components/stamps/StampSettings.tsx).
import { StampSettings } from '@/components/stamps/StampSettings';
import { RetentionSettings } from '@/components/settings/RetentionSettings';
import { ArchiveSettings } from '@/components/settings/ArchiveSettings';
import { SealStatus } from '@/components/settings/SealStatus';
import { ChannelsStatus } from '@/components/settings/ChannelsStatus';
import { ArchiveFormat } from '@/components/settings/ArchiveFormat';
import { TenantSwitches } from '@/components/settings/TenantSwitches';
// The language new recipients start in (src/components/settings/LanguageSettings.tsx).
import { LanguageSettings } from '@/components/settings/LanguageSettings';
// The account's own custom fields, such as a case number (src/components/settings/CustomFieldSettings.tsx).
import { CustomFieldSettings } from '@/components/settings/CustomFieldSettings';
import { SecurityLog } from '@/components/settings/SecurityLog';
import { securityOnlyHook } from '@/lib/seclog';
import { SecurityPolicy } from '@/components/settings/SecurityPolicy';
import { Organisation } from '@/components/settings/Organisation';
// Sections, cards, "Saved" next to what saved, and the one More options of a section (research/ux-charter.md, 2.2).
import { sectionsFor, landingFor, closingCount, nextTab, KEYS_AND_TWO_STEP, MEMBER_READS } from '@/lib/settingsnav';
import { Card, MoreOptions, useSaved } from '@/components/settings/Frame';
import { SendingDefaults } from '@/components/settings/SendingDefaults';
// "Your consent text", the account's own words on the consent screen, behind Sending's More options (admins).
import { Disclosure } from '@/components/settings/Disclosure';
import { MonthlyReport } from '@/components/reports/MonthlyReport';
import { ListDaysSetting } from '@/components/reports/SavedLists';
import { screenLocale } from '@/lib/dates';

const fileToDataUrl = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = rej;
  r.readAsDataURL(file);
});
const longDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '');
// A charge happens at a moment, not on a day: "cancel any time before" needs the time as well.
// Free signatures arrive at the start of the month in UTC, so that date is written in UTC and says so.
const utcDate = (s?: string | null) => (s ? `${new Date(s).toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}, UTC` : '');
const longMoment = (s?: string | null) => (s ? `${longDate(s)} at ${new Date(s).toLocaleTimeString(screenLocale(), { hour: 'numeric', minute: '2-digit' })}` : '');

function Profile() {
  const me = useMe();
  const [f, setF] = useState({ name: me.user.name, title: me.user.title || '', company: me.user.company || '' });
  const [adopt, setAdopt] = useState<'' | 'signature' | 'initials'>('');
  const [said, saved] = useSaved();
  const save = (body: any, msg = 'Saved') => api('/me', { method: 'PATCH', body }).then(() => (msg === 'Saved' ? saved() : toast(msg), me.reload())).catch(oops);
  const member = me.role === 'member';
  return (
    <div className="stack">
      <Card><div className="card">
        <h2 style={{ marginBottom: 12 }}>Profile</h2>
        <div className="grid g3">
          <label className="f"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="f"><span>Job title</span><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="f"><span>Company</span><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label>
        </div>
        <div className="row between wrap"><span className="muted small">{me.user.email} · {me.user.email_verified ? 'confirmed' : 'not confirmed yet'}</span><span className="row">{said}<button className="btn" onClick={() => save(f)}>Save profile</button></span></div>
      </div></Card>
      <Card><EmailAddressCard me={me} /></Card>
      <Card><div className="card">
        <h2 style={{ marginBottom: 4 }}>Your signature</h2>
        <p className="muted small">Saved here, it is offered when a document is sent to {me.user.email}. You can always change it while signing.</p>
        <div className="grid g2">
          {(['signature', 'initials'] as const).map((k) => {
            const img = k === 'signature' ? me.user.signature_png : me.user.initials_png;
            return (
              <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
                <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{img ? <img src={img} alt={`Your ${k}`} style={{ maxHeight: 76, maxWidth: '100%' }} /> : <span className="muted small">No {k} saved</span>}</div>
                <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                  <button className="btn sm" onClick={() => setAdopt(k)}>{img ? 'Change' : 'Create'} {k}</button>
                  {img && <button className="btn sm ghost danger" onClick={() => save({ [`${k}_png`]: '' }, 'Removed')}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div></Card>
      <Card><Notifications /></Card>
      <p className="muted small" style={{ margin: '12px 0 0' }}>Your password, two-step login and the places you are signed in are under Security, the next section.</p>
      {/* A member has no Records and data section: what was theirs to do there is here, behind the one More options. */}
      {member && <MoreOptions>
        <div className="card" data-item="card">
          <h2 style={{ marginBottom: 4 }}>What the admins set</h2>
          <p className="muted small">The plan and the stamps of {me.account.name} are set by its owner and admins. You can read them here.</p>
          <div className="row wrap">{MEMBER_READS.map(([k, l]) => <Link key={k} className="btn sm" style={{ minHeight: 44 }} href={`/app/settings?tab=${k}`} onClick={(e) => { e.preventDefault(); window.location.assign(`/app/settings?tab=${k}`); }}>{l}</Link>)}</div>
        </div>
        <YourData />
      </MoreOptions>}
      {adopt &&<AdoptSignature kind={adopt} name={me.user.name} doneLabel="Save" onClose={() => setAdopt('')} onDone={(png) => (save({ [`${adopt}_png`]: png }), setAdopt(''))} />}
    </div>
  );
}

// Settings, Security. The first card, "Your sign-in", is for everyone: the password and the other ways to sign in,
// two-step login, and where this login is signed in. The security record of the account follows, for its admins.
function Security() {
  const me = useMe();
  return (
    <div className="stack">
      <Card>
        <section className="stack" aria-labelledby="your-signin-h">
          <h2 id="your-signin-h" className="set-group">Your sign-in</h2>
          <SignInWays />
          <TwoStepCard />
          <SignedIn />
        </section>
      </Card>
      {/* Sign-in rules for the team: shortest password, sign out after no use, one session at a time (SecurityPolicy.tsx). */}
      {me.role !== 'member' && <Card><SecurityPolicy /></Card>}
      {me.role !== 'member' && <Card><SecurityLog /></Card>}
    </div>
  );
}

// Ways to sign in: the password, and Google and Microsoft when the operator of this server has switched them on, or
// while one is still connected from a time it was. With neither, this is the password form there has always been.
function SignInWays() {
  const me = useMe();
  const [d, reload, failed] = useLoad(() => api('/me/signin'));
  const [pw, setPw] = useState({ current: '', password: '', code: '' });
  // What the last thing done here led to. It stays on screen: some of it is a few sentences and tells what to do next.
  const [said, setSaid] = useState<{ text: string; err?: boolean; confirm?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Back from Google or Microsoft after "Connect": what happened, in words, and the address tidied up.
    const q = new URLSearchParams(window.location.search);
    const p = q.get('provider');
    if (q.get('signin_error')) setSaid({ text: signInErrorText(q.get('signin_error'), p), err: true });
    else if (q.get('signin') === 'connected') setSaid({ text: `${isProviderId(p) ? PROVIDER_NAMES[p] : 'It'} is connected. From now on you can sign in with it.` });
    if (q.get('signin_error') || q.get('signin')) window.history.replaceState(null, '', '/app/settings?tab=security');
  }, []);
  const providers: any[] = d?.providers || [];
  const hasPw: boolean = d ? d.password : me.user.has_password !== false;
  const act = (what: () => Promise<any>) => {
    setBusy(true);
    setSaid(null);
    what().catch((e: any) => setSaid({ text: e?.message || 'Something went wrong.', err: true, confirm: e?.code === 'confirm_first' })).finally(() => setBusy(false));
  };
  const changePassword = (e: React.FormEvent) => {
    e.preventDefault();
    api('/me/password', { body: pw }).then(() => (toast('Password changed'), setPw({ current: '', password: '', code: '' }))).catch(oops);
  };
  const fields = (
    <div className="grid g2">
      <label className="f"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
      <label className="f"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></label>
      {/* With two-step login on, a password is changed only with a current code too (src/server/twostep.ts). */}
      {me.user.two_step && <label className="f"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" required value={pw.code} onChange={(e) => setPw({ ...pw, code: e.target.value })} /></label>}
    </div>
  );
  // Nothing is drawn until we know which of the two this is, so the card does not change shape under the reader.
  if (!d && !failed) return null;
  if (!providers.length && hasPw) return (
    <form className="card" onSubmit={changePassword}>
      <h2 style={{ marginBottom: 12 }}>Password</h2>
      {fields}
      <button className="btn">Change password</button>
    </form>
  );
  const sendLink = () => act(() => api('/me/signin/password-link', { method: 'POST' }).then((r) => setSaid({ text: `We sent a link to ${r.sent_to}. Open it and choose your password. It works for one hour, and until you use it nothing changes.` })));
  const connectTo = (p: any) => act(() => api(`/me/signin/${p.id}/connect`, { method: 'POST' }).then((r) => window.location.assign(r.url)));
  const disconnect = (p: any, c: any) => window.confirm(`Disconnect ${p.name}${c.email ? ` (${c.email})` : ''}? Signing in with it will no longer open this login. You can connect it again at any time.`)
    && act(() => api(`/me/signin/${c.id}`, { method: 'DELETE' }).then(() => (setSaid({ text: `${p.name} is disconnected. It no longer opens this login.` }), reload())));
  return (
    <section className="card" aria-labelledby="ways-h">
      <h2 id="ways-h" style={{ marginBottom: 4 }}>Ways to sign in</h2>
      <p className="muted small">Each of these opens your login, {me.user.email}. There is always at least one: the last one cannot be removed.</p>
      {said && (
        <div className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'} style={{ margin: '10px 0' }}>
          {said.text}
          {said.confirm && <div style={{ marginTop: 8 }}><button className="btn sm" style={{ minHeight: 44 }} onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => setSaid({ text: `We sent the confirmation link to ${me.user.email} again. Open it in this browser while you are signed in, then come back here.` })).catch(oops)}>Send the confirmation email again</button></div>}
        </div>
      )}
      <ul className="ways">
        <li>
          <div className="what"><b>Password</b><div className="muted small">{hasPw ? 'Set. You sign in with your email address and this password.' : 'Not set yet. This login was made without one.'}</div></div>
          {hasPw
            ? <form onSubmit={changePassword}>{fields}<button className="btn">Change password</button></form>
            : <button className="btn" disabled={busy} onClick={sendLink}>Email me a link to set a password</button>}
        </li>
        {providers.map((p) => (
          <li key={p.id}>
            <div className="what">
              <b>{p.name}</b>
              {p.connected.length === 0 && <div className="muted small">Not connected.</div>}
              {p.connected.map((c: any) => <div key={c.id} className="muted small">Connected as {c.email || 'an account that gave no email address'} since {longDate(c.since)}.</div>)}
              {!p.on && <div className="muted small">Signing in with {p.name} is switched off on this server at the moment, so this does not open your login right now.</div>}
            </div>
            {p.connected.map((c: any) => <button key={c.id} className="btn danger" disabled={busy} aria-label={`Disconnect ${p.name}${c.email ? ` (${c.email})` : ''}`} onClick={() => disconnect(p, c)}>Disconnect</button>)}
            {p.on && p.connected.length === 0 && <button className="btn" disabled={busy} onClick={() => connectTo(p)}>Connect {p.name}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const NOTIFY: [string, string, string][] = [
  ['completed', 'When everyone has finished', 'One email with the signed document. Most people only need this one.'],
  ['problems', 'When something needs you', 'Someone declined, an email to a signer could not be delivered, a request sits unopened, a link could not be opened, or the deadline is close or has passed. A few things reach you whatever you choose here, because only you can act on them: a signer passed the document on, changed how their name is written, or asked for more time or for an access code.'],
  ['signed', 'Each time someone signs', 'One email per person as they finish. Off by default to keep your inbox quiet.'],
  ['viewed', 'Each time someone opens it', 'Useful when you want to know it arrived. Off by default.'],
];

function Notifications() {
  const me = useMe();
  const [n, setN] = useState<Record<string, boolean>>(me.user.notify || {});
  const [said, saved] = useSaved();
  // "Saved" stands next to the switch that was changed last.
  const [last, setLast] = useState('');
  const flip = (k: string) => {
    const next = { ...n, [k]: !n[k] };
    setN(next);
    setLast(k);
    api('/me', { method: 'PATCH', body: { notify: { [k]: next[k] } } }).then(() => (saved(), me.reload())).catch(oops);
  };
  return (
    <div className="card" id="notifications">
      <h2 style={{ marginBottom: 4 }}>Emails about your documents</h2>
      <p className="muted small">You choose how much we email you. Everything is always visible in the app either way.</p>
      {NOTIFY.map(([k, title, hint]) => (
        <label key={k} className="setting-row">
          <input type="checkbox" checked={!!n[k]} onChange={() => flip(k)} />
          <span><b>{title}</b> {last === k && said}<span className="muted small" style={{ display: 'block' }}>{hint}</span></span>
        </label>
      ))}
      {/* Owners and admins of a team that has sent something: last month's report by email (reports/MonthlyReport.tsx). */}
      <MonthlyReport />
      <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>People you send to get one request, the reminders you set on the document, and one copy when it is complete. They can turn reminders off for themselves.</p>
    </div>
  );
}

function Account() {
  const me = useMe();
  const a = me.account;
  const admin = me.role !== 'member';
  const [f, setF] = useState({ name: a.name, brand_color: a.brand_color || '#1f6f43', brand_logo: a.brand_logo || '' });
  const [said, saved] = useSaved();
  if (!admin) return <div className="notice">Only account admins can change these settings.</div>;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 12 }}>Account and branding</h2>
      <label className="f"><span>Account name <span className="hint">(shown to recipients)</span></span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="grid g2">
        <label className="f"><span>Brand colour <span className="hint">(emails and the signing screen)</span></span><input type="color" value={f.brand_color} onChange={(e) => setF({ ...f, brand_color: e.target.value })} /></label>
        <div className="f"><span style={{ display: 'block', marginBottom: 5, fontSize: 13, fontWeight: 600 }}>Logo <span className="hint">(PNG or JPEG, under 200 KB)</span></span>
          <div className="row">
            {f.brand_logo && <img src={f.brand_logo} alt="Logo" style={{ maxHeight: 38, maxWidth: 140 }} />}
            <label className="btn sm">Upload<input type="file" hidden accept="image/png,image/jpeg" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 200_000) return toast('That logo is over 200 KB. Try a smaller PNG or JPEG.', true); setF({ ...f, brand_logo: await fileToDataUrl(file) }); }} /></label>
            {f.brand_logo && <button className="btn sm ghost" onClick={() => setF({ ...f, brand_logo: '' })}>Remove</button>}
          </div>
        </div>
      </div>
      <p className="muted small">Emails to your recipients come from "{me.user.name} via GrowSigning" and replies go straight to you.</p>
      <div className="row"><button className="btn" onClick={() => api('/account', { method: 'PATCH', body: f }).then(() => (saved(), me.reload())).catch(oops)}>Save</button>{said}</div>
      {/* Switches that save by themselves, set apart from the Save button above: 'Trees on screens and emails', 'Trees on
          the signing record' under it, and, where a model answers the help chat, 'AI answers in the help chat'. */}
      <TenantSwitches />
    </div>
  );
}

function Team() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [d, reload] = useLoad(() => api('/account/members'));
  const [inv, setInv] = useState({ email: '', role: 'member' });
  // An invitation is an email, so the server refuses it while sending is paused or the address is not confirmed. The
  // button says so before it is pressed.
  const inviteHeld = me.account?.paused ? 'Invitations wait while sending is paused on this account. The red banner at the top says why.' : !me.user?.email_verified ? 'Confirm your email address first: type the 6-digit code from our email in the box at the top.' : '';
  const [remove, setRemove] = useState<any>(null);
  const [to, setTo] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Admins see every API key in the account, so the Remove dialog can say which ones stop with the person. Everyone
  // sees their own, so the Leave dialog can say the same about theirs.
  const [keys, reloadKeys] = useLoad(() => api('/api-keys'));
  const myKeys: any[] = (keys?.keys || []).filter((k: any) => k.mine && !k.stopped_at);
  const theirKeys: any[] = remove ? (keys?.keys || []).filter((k: any) => k.user_id === remove.id && !k.stopped_at) : [];
  const members: any[] = d?.members || [];
  const adminCount = members.filter((m) => m.role !== 'member').length;
  return (
    <div className="stack">
      {admin && members.length > 0 && adminCount < 2 && (
        <div className="notice warn">
          <b>This account depends on one person.</b> If you lose access to {me.user.email}, nobody else can manage it. Invite a second admin below: an admin can manage the team, the plan and every document. Only the owner can hand the whole account to someone else (Make owner, below), so do that before you move on.
        </div>
      )}
      {admin && (
        <form className="card row wrap set-invite" data-item="card" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); api('/account/invites', { body: inv }).then(() => (toast('Invitation sent'), setInv({ email: '', role: 'member' }), reload())).catch(oops); }}>
          <label className="f grow" style={{ margin: 0 }}><span>Invite by email</span><input type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} style={{ minHeight: 44 }} /></label>
          <label className="f" style={{ margin: 0 }}><span>Role</span><select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} style={{ minHeight: 44 }}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <button className="btn primary" disabled={!!inviteHeld} aria-describedby={inviteHeld ? 'invite-held' : undefined} style={{ minHeight: 44 }}>Send invite</button>
          {inviteHeld && <p id="invite-held" className="muted small" style={{ flexBasis: '100%', margin: 0 }}>{inviteHeld}</p>}
        </form>
      )}
      <div className="card pad0" data-item="card">
        <div className="tablewrap"><table className="t">
          <thead><tr><th>Member</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.id === me.user.id ? ' (you)' : ''}<div className="muted small">{m.email}</div></td>
                <td>{admin && m.role !== 'owner' && m.id !== me.user.id ? (
                  <select value={m.role} style={{ width: 120 }} aria-label={`Role for ${m.name}`} onChange={(e) => api(`/account/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }).then(reload).catch(oops)}><option value="member">Member</option><option value="admin">Admin</option></select>
                ) : <span style={{ textTransform: 'capitalize' }}>{m.role}</span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {me.role === 'owner' && m.id !== me.user.id && <button className="btn sm ghost" onClick={() => window.confirm(`Make ${m.name} the owner of this account? You stay on as an admin.`) && api('/account/transfer-owner', { body: { user_id: m.id } }).then(() => (toast(`${m.name} is now the owner`), me.reload(), reload())).catch(oops)}>Make owner</button>}
                  {admin && m.role !== 'owner' && m.id !== me.user.id && <button className="btn sm ghost danger" onClick={() => (reloadKeys(), setRemove(m), setTo(me.user.id))}>Remove</button>}
                </td>
              </tr>
            ))}
            {(d?.invites || []).map((i: any) => (
              <tr key={i.id}><td><b>{i.email}</b><div className="muted small">Invited {fmtDate(i.created_at)}</div></td><td style={{ textTransform: 'capitalize' }}>{i.role} · pending</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm ghost danger" onClick={() => api(`/account/invites/${i.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Cancel</button></td></tr>
            ))}
          </tbody>
        </table></div>
      </div>
      {admin && <Card><TeamTwoStep /></Card>}
      <p className="muted small">Documents belong to the account, not to one login. Members see what they sent, admins see everything. Templates are shared: everyone can use them, and only the person a template belongs to or an admin can change or delete it. Everyone on the team is covered by the one plan: there is no charge per person.</p>
      {me.role !== 'owner' && members.length > 1 && (
        <div className="card row wrap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          {/* The text may shrink to a readable column and no further; below that the button wraps onto its own line. */}
          <div className="grow" style={{ flex: '1 1 220px' }}><b>Leave this team</b><div className="muted small">You do not need anyone&apos;s permission. What you sent stays with the team, and you keep your own login.</div></div>
          <button className="btn danger" style={{ minHeight: 44 }} onClick={() => (reloadKeys(), setTo(members.find((m) => m.role === 'owner')?.id || ''), setLeaving(true))}>Leave this team</button>
        </div>
      )}
      {me.role === 'owner' && members.length > 1 && <p className="muted small">You own this account, so you cannot leave it as it is. To leave, make someone else the owner first (Make owner, above). You can then leave like any other member.</p>}

      {leaving && (
        <Modal title={`Leave ${me.account.name}`} onClose={() => setLeaving(false)}>
          <p>You lose access to this team straight away. Nothing you sent is lost: your envelopes, drafts, templates and bulk sends pass to the person you choose, and anything still out for signature carries on. Each envelope&apos;s audit trail says who handed it to whom.</p>
          {/* Where they land is said by name: the oldest of their other workspaces, as the server picks it (me.accounts is oldest first). */}
          <p className="muted small">You keep your login and stay signed in, {(me.accounts || []).find((a: any) => a.id !== me.account.id) ? `in ${(me.accounts || []).find((a: any) => a.id !== me.account.id).name}, the workspace you joined first among your others` : 'in a new workspace of your own'}. The team&apos;s owner and admins are told by email that you left. They can invite you back at any time.</p>
          {myKeys.length > 0 && (
            <div className="notice warn" style={{ marginBottom: 12 }}>
              <b>{myKeys.length === 1 ? 'This API key of yours stops' : `These ${myKeys.length} API keys of yours stop`} working the moment you leave:</b>
              <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
                {myKeys.map((k) => <li key={k.id}><b>{k.name}</b> <span className="mono">{k.prefix}…</span>, {k.last_used_at ? `last used ${fmtDate(k.last_used_at)}` : 'never used'}</li>)}
              </ul>
              Anything that uses one of them gets an error from then on. The admins are told which keys these were.
            </div>
          )}
          <label className="f"><span>Who takes over what you sent</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {members.filter((m) => m.id !== me.user.id).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
            </select>
          </label>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={() => setLeaving(false)}>Stay</button>
            <button className="btn danger" disabled={busy || !to} onClick={() => { setBusy(true); api('/account/leave', { body: { to } }).then((r) => { toast(`You left ${r.left}. You are now in ${r.now_in?.name || 'your own workspace'}.`); window.location.href = '/app'; }).catch((e) => (setBusy(false), oops(e))); }}>Leave this team</button>
          </div>
        </Modal>
      )}

      {remove && (
        <Modal title={`Remove ${remove.name}`} onClose={() => setRemove(null)}>
          <p>They lose access to this account straight away. Nothing they sent is lost: their envelopes, drafts, templates and bulk sends pass to the person you choose, and anything still out for signature carries on. Each envelope&apos;s audit trail says who handed it to whom.</p>
          <p className="muted small">{remove.name} keeps their own login and is told by email. The next time they sign in they are in another team they belong to, or in a workspace of their own if there is none, and you can invite them back at any time.</p>
          {theirKeys.length > 0 && (
            <div className="notice warn" style={{ marginBottom: 12 }}>
              <b>{theirKeys.length === 1 ? 'This API key stops' : `These ${theirKeys.length} API keys stop`} working the moment you remove {remove.name}:</b>
              <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
                {theirKeys.map((k) => <li key={k.id}><b>{k.name}</b> <span className="mono">{k.prefix}…</span>, {k.last_used_at ? `last used ${fmtDate(k.last_used_at)}` : 'never used'}</li>)}
              </ul>
              Anything that uses one of them starts failing. If an integration depends on it, create a replacement key on the API and webhooks tab first. All admins and {remove.name} get an email that names these keys.
            </div>
          )}
          <label className="f"><span>Hand their documents to</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {members.filter((m) => m.id !== remove.id).map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === me.user.id ? ' (you)' : ''}</option>)}
            </select>
          </label>
          <div className="actions">
            <button className="btn" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn primary" onClick={() => api(`/account/members/${remove.id}?to=${encodeURIComponent(to)}`, { method: 'DELETE' }).then((r) => (toast(`${remove.name} was removed. Their documents were handed over.${r.keys_stopped?.length ? ` Stopped API key${r.keys_stopped.length === 1 ? '' : 's'}: ${r.keys_stopped.map((k: any) => k.name).join(', ')}.` : ''}`), setRemove(null), reload())).catch(oops)}>Remove and hand over</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Developers() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [keys, reloadKeys] = useLoad(() => api('/api-keys'));
  // The delivery log: one webhook or all of them, the newest page first, older pages added underneath on request.
  const [only, setOnly] = useState('');
  const [hooks, reloadHooks] = useLoad(() => (admin ? api(`/webhooks${only ? `?webhook=${encodeURIComponent(only)}` : ''}`) : Promise.resolve(null)), [only]);
  // Older pages belong to the first page they were loaded under. After a refresh or another filter they are dropped.
  const [olderPages, setOlder] = useState<{ under: any; rows: any[]; next: number | null } | null>(null);
  const older = olderPages && olderPages.under === hooks ? olderPages : null;
  const deliveries: any[] = [...(hooks?.deliveries || []), ...(older?.rows || [])];
  const nextBefore: number | null = older ? older.next : hooks?.next_before ?? null;
  const showOlder = () => api(`/webhooks?before=${nextBefore}${only ? `&webhook=${encodeURIComponent(only)}` : ''}`).then((r) => setOlder({ under: hooks, rows: [...(older?.rows || []), ...r.deliveries], next: r.next_before })).catch(oops);
  const [fresh, setFresh] = useState('');
  const [url, setUrl] = useState('');
  const [making, setMaking] = useState<null | { name: string; scope: 'send' | 'admin' }>(null);
  const revoke = (k: any) => {
    if (!k.mine && !k.stopped_at && !window.confirm(`Revoke "${k.name}", made by ${k.owner_name || 'someone else'}? Whatever uses it stops working at once.`)) return;
    api(`/api-keys/${k.id}`, { method: 'DELETE' }).then(reloadKeys).catch(oops);
  };
  return (
    <div className="stack">
      <div className="card" data-item="card">
        <div className="row between wrap"><h2>API keys</h2><a href="/developers" target="_blank">API reference ↗</a></div>
        <p className="muted small">Included on every plan, with the same limits as the app. A key works straight away: there is no review step and no separate test environment.{admin ? ' As an admin you see every key in this account and who made it. The key itself is shown once, to the person who creates it, and never again.' : ''}</p>
        <p className="muted small">{KEYS_AND_TWO_STEP}</p>
        {fresh && <div className="notice" style={{ marginBottom: 12 }}>Copy your key now. It is not shown again:<div className="mono" style={{ marginTop: 4 }}>{fresh}</div></div>}
        {(keys?.keys || []).map((k: any) => (
          <div key={k.id} className="row between wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span>
              <b>{k.name}</b> <span className="mono muted">{k.prefix}…</span> <span className={`badge${k.scope === 'admin' ? ' expired' : ''}`}>{k.scope === 'admin' ? 'Admin: account settings too' : 'Send: everyday work'}</span>
              {!k.mine && <span className="muted small"> made by {k.owner_name || 'someone who has left'}</span>}
              {k.stopped_at && <span className="small" style={{ display: 'block', color: 'var(--red)' }}>Stopped working on {fmtDate(k.stopped_at)}, when {k.owner_name || 'the person who made it'} left the team. Whatever used it needs a new key.</span>}
              {k.closing && <span className="small" style={{ display: 'block', color: 'var(--red)' }}>Switched off: {k.owner_name || 'the person who made it'} is closing their login. It works again if they sign in before {fmtDate(k.closing)}. If they do not, it stops for good on that day. Whatever uses it needs a new key to carry on now.</span>}
            </span>
            <span className="row"><span className="muted small">{k.last_used_at ? `last used ${fmtDate(k.last_used_at)}` : 'never used'}</span><button className="btn sm ghost danger" onClick={() => revoke(k)}>{k.stopped_at ? 'Clear from list' : 'Revoke'}</button></span>
          </div>
        ))}
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setMaking({ name: '', scope: 'send' })}>Create API key</button>
      </div>
      {making && (
        <Modal title="Create an API key" onClose={() => setMaking(null)}>
          <label className="f"><span>Name <span className="hint">(what will use it, for example "Website integration")</span></span><input value={making.name} autoFocus maxLength={80} onChange={(e) => setMaking({ ...making, name: e.target.value })} /></label>
          <div role="radiogroup" aria-label="What the key may do">
            <label className="setting-row">
              <input type="radio" name="key-scope" checked={making.scope === 'send'} onChange={() => setMaking({ ...making, scope: 'send' })} />
              <span><b>Send</b><span className="muted small" style={{ display: 'block' }}>Envelopes, templates, files, contacts, bulk sends, export and reports. It cannot change account settings, the team or webhooks. Right for almost every integration.</span></span>
            </label>
            {admin && (
              <label className="setting-row">
                <input type="radio" name="key-scope" checked={making.scope === 'admin'} onChange={() => setMaking({ ...making, scope: 'admin' })} />
                <span><b>Admin</b><span className="muted small" style={{ display: 'block' }}>Everything a send key can do, and also account settings, invitations, member roles and webhooks.</span></span>
              </label>
            )}
          </div>
          {making.scope === 'admin' && <div className="notice warn" role="alert"><b>Choose this only if the integration manages the account itself.</b> Whoever gets hold of an admin key can rename the account, invite people as admins and point your webhooks somewhere else. If the key only sends documents, pick Send.</div>}
          <p className="muted small" style={{ marginBottom: 0 }}>No key of either kind can create or revoke keys, remove a team member, hand over or close the account, or touch the plan and payments. Those always need a person who is signed in.</p>
          <div className="actions">
            <button className="btn" onClick={() => setMaking(null)}>Cancel</button>
            <button className="btn primary" onClick={() => api('/api-keys', { body: making }).then((r) => (setFresh(r.key), setMaking(null), reloadKeys())).catch(oops)}>Create {making.scope === 'admin' ? 'admin' : 'send'} key</button>
          </div>
        </Modal>
      )}
      {admin && (
        <div className="card" data-item="card">
          <h2>Webhooks</h2>
          <p className="muted small">We POST JSON to your URL when an envelope is sent, opened, signed, corrected, completed, declined, voided or expires. Check the <span className="mono">X-GrowSigning-Signature</span> header with the signing secret. Each payload also carries a one-line <span className="mono">text</span> summary for tools that just want a message to show.</p>
          {(hooks?.webhooks || []).map((h: any) => (
            <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row between"><b className="truncate">{h.url}</b><button className="btn sm ghost danger" onClick={() => api(`/webhooks/${h.id}`, { method: 'DELETE' }).then(() => (only === h.id ? setOnly('') : reloadHooks())).catch(oops)}>Delete</button></div>
              {securityOnlyHook(h.events) && <div className="muted small">Sends the security record only, nothing about documents. It is also listed under <Link href="/app/settings?tab=security">Security</Link>.</div>}
              <div className="mono muted">Secret: {h.secret}</div>
            </div>
          ))}
          {/* The operator may allow only some hosts, or none (OUTSIDE_CALLS, src/lib/outside.ts): then no form. */}
          {Array.isArray(hooks?.allowed_hosts) && hooks.allowed_hosts.length === 0
            ? <p className="muted small" style={{ marginTop: 12 }}>Webhooks are switched off on this server: it sends nothing to other systems. That is a rule of the people who run it.</p>
            : <>
              {Array.isArray(hooks?.allowed_hosts) && <p className="muted small" style={{ marginTop: 12 }}>On this server a webhook can only go to {hooks.allowed_hosts.join(', ')}.</p>}
              <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); api('/webhooks', { body: { url } }).then(() => (setUrl(''), reloadHooks())).catch(oops); }}>
                <input placeholder="https://example.com/hooks/growsigning" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Webhook URL" />
                <button className="btn">Add webhook</button>
              </form>
            </>}
          {(deliveries.length > 0 || !!only) && (
            <div style={{ marginTop: 16 }}>
              <div className="row between wrap"><h3>Deliveries</h3>
                <span className="row">
                  {(hooks?.webhooks || []).length > 1 && (
                    <select value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Show deliveries for" style={{ maxWidth: 260 }}>
                      <option value="">All webhooks</option>
                      {hooks.webhooks.map((h: any) => <option key={h.id} value={h.id}>{h.url}</option>)}
                    </select>
                  )}
                  <button className="btn sm ghost" onClick={reloadHooks}>Refresh</button>
                </span>
              </div>
              <p className="muted small">A delivery is listed from the moment it starts, and is tried three times. If your side was down, fix it and send the same event again. The latest 200 events of each webhook can be sent again. Older ones stay listed.</p>
              {deliveries.length === 0 && <p className="muted small">Nothing has been sent to this webhook yet.</p>}
              {deliveries.map((d: any) => {
                const ok = d.state === 'delivered';
                const trying = d.state === 'pending';
                return (
                  <div key={d.id} className="row between wrap small" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                    <span><span className={`badge ${ok ? 'completed' : trying ? 'sent' : 'declined'}`}>{ok ? `Delivered (${d.status})` : trying ? 'Trying now' : d.status ? `Failed (${d.status})` : 'Failed'}</span> <span className="mono">{d.event}</span>{!only && (hooks?.webhooks || []).length > 1 && <span className="muted"> to {d.url}</span>}</span>
                    <span className="row">
                      <span className="muted">{!ok && !trying && d.error ? `${d.error} · ` : ''}{fmtDate(d.at, true)}</span>
                      {!!d.can_redeliver && <button className="btn sm" onClick={() => api(`/webhooks/deliveries/${d.id}/redeliver`, { method: 'POST' }).then(() => (toast('Sent again. Refresh in a moment to see the result.'), setTimeout(reloadHooks, 2500))).catch(oops)}>Send again</button>}
                    </span>
                  </div>
                );
              })}
              {nextBefore && <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={showOlder}>Show older deliveries</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TOP_UP_PICKS = [5, 10, 25, 50];

function Billing() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [b, reload] = useLoad(() => api('/billing'));
  useEffect(() => {
    const again = () => (reload(), me.reload());
    window.addEventListener('sg-billing-changed', again);
    return () => window.removeEventListener('sg-billing-changed', again);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [modal, setModal] = useState<'' | 'cancel' | 'refund' | 'card'>('');
  const [offer, setOffer] = useState<any>(null); // the payment the refund dialog is about
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [qty, setQty] = useState(10);
  const [code, setCode] = useState('');
  if (!b) return <div className="muted">Loading…</div>;
  const grove = b.plan === 'grove';
  const free = !!b.free_with;
  const P = PRICING;
  // The price for someone starting today. An account that is on the plan sees the price it is on, which can be an
  // earlier one: nobody's price goes up without notice.
  const price = `$${P.monthlyUsd}`;
  const myPrice = grove && !b.free_with && b.plan_price ? b.plan_price.replace(/\.00$/, '') : price;
  const s = b.signatures;
  const n = (x: number) => `${x} signature${x === 1 ? '' : 's'}`;
  // The day of a moment, in UTC like every time on this tab (expiryMoment), so a top-up and its payment show one day.
  const utcDay = (iso?: string | null) => expiryMoment(iso).replace(/ at .*$/, '');
  // Running out because some expired is said with the number, where the person first sees it.
  const gone = s && s.available <= 0 && !b.renewal_pending ? expiredWords(b.last_expiry) : '';
  const q = Math.min(P.topUpMax, Math.max(1, Math.round(qty) || 1));
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
      reload();
      me.reload();
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  };
  const go = (path: string, body?: any) => act(async () => {
    const r = await api(path, { method: 'POST', body });
    window.location.href = r.url;
  });

  return (
    <div className="stack plan-tab">
      <div className="card plan-hero">
        <Leaf size={28} color="#9ed88f" />
        <div>
          <h2 className="serif" style={{ fontSize: 22 }}>Every dollar plants {P.treesPerUsd} mangrove trees</h2>
          <p style={{ margin: '4px 0 0' }}>
            Everything you pay GrowSigning goes to Treegens tree planting, whether its signatures are used or not. {b.mangroves > 0 ? <>So far {me.account.name} has planted <b style={{ color: '#fff' }}>{b.mangroves.toLocaleString()} mangroves</b>. Thank you.</> : 'People who sign your documents never pay anything.'}
          </p>
        </div>
      </div>

      {done && (
        <div className="notice" role="status">
          {done.kind === 'cancel' && !done.ended_now && <><b>Cancelled. You will not be charged again.</b> The plan runs until {utcDay(done.ends_at)} because that month is already paid for. Your signatures can be used until their own dates: this month&apos;s until the plan ends, top-ups for {TOPUP_EXPIRY_MONTHS} months after each payment. Reference {done.reference}. We emailed you this too.</>}
          {done.kind === 'cancel' && done.ended_now && <><b>Cancelled. You will not be charged again.</b> {done.why === 'not_taken' ? 'The payment for the new month had not been taken yet, so the plan ended today and that payment is withdrawn.' : done.why === 'already_ended' ? 'The plan had already ended with the payment provider, so there was nothing more to stop.' : 'The last payment had not gone through, so the plan ended today and that payment will not be tried again.'} The signatures you have left can be used until their own dates, shown below. Reference {done.reference}. We emailed you this too.</>}
          {done.kind === 'refund' && !done.pending && <><b>Refund sent: {done.refunded}</b> for {n(done.signatures)} you had not used. It goes back to the card you paid with. Reference {done.reference}. Banks usually show it within 5 to 10 working days.{done.plan_ended ? ' The monthly plan has ended and will not be charged again.' : ''}</>}
          {done.kind === 'refund' && done.pending && <><b>Refund of {done.refunded} requested.</b> The payment provider has not confirmed it yet. We keep checking and email you as soon as it is through; you do not need to do anything, and it cannot be paid twice. The {n(done.signatures)} have left your balance.{done.plan_ended ? ' The monthly plan has ended and will not be charged again.' : ''}</>}
          {done.kind === 'card' && (done.removed > 0 ? <><b>Card removed.</b> Nothing can be charged to it.{done.cancelled ? ' Your plan was cancelled at the same time, so it does not renew.' : ''}</> : <><b>There was no saved card or payment method to remove.</b>{done.cancelled ? ' Your plan was cancelled, so it does not renew.' : ''}</>)}
        </div>
      )}

      {b.price_change && (
        <div className="notice warn" role="status"><b>The price of your plan changes on {b.price_change.from_day || utcDay(b.price_change.from)}.</b> It stays {b.price_change.now} a month until then. The first renewal on or after that day is {b.price_change.next}. Every owner and admin the account had then was told by email on {utcDay(b.price_change.told_at)}. Nothing else changes, and you can cancel at any time before then and use the signatures you have until their own dates.</div>
      )}
      {b.refunds_pending?.map((r: any) => (
        <div className="notice" role="status" key={r.payment_id + r.since}>
          {/* `back`: part of it that a person already sent back by hand; only `left` is still to come. */}
          {r.by_hand ? <><b>We owe you a refund of {r.amount}{r.why ? `: ${r.why}` : ''}.</b> {r.back ? <>{r.back} of it has gone back to your card already. </> : ''}The payment provider would not send {r.back ? `the other ${r.left}` : 'it'} automatically, so a person here will send it to your card by hand, and we email you once it has all gone back. You do not need to do anything.</>
            : r.auto ? <><b>We owe you a refund of {r.amount}{r.why ? `: ${r.why}` : ''}.</b> {r.back ? <>{r.back} of it has gone back to your card already, and the other {r.left} is on its way. </> : 'It is on its way back to the card it was paid with, and the payment provider has not confirmed it yet. '}We keep checking and email you as soon as it is through. You do not need to do anything.</>
            : <><b>A refund of {r.amount} is on its way.</b> You asked for it on {expiryMoment(r.since)}{r.back ? <>, and {r.back} of it has gone back to your card already. The payment provider has not confirmed the other {r.left} yet.</> : ' and the payment provider has not confirmed it yet.'} We keep checking and email you as soon as it is through. You do not need to do anything.</>}
        </div>
      ))}

      {s && (
        <div className="card">
          <h2>Signatures</h2>
          <div className="balance"><b className="num">{Math.max(0, s.available)}</b> left to send with</div>
          {gone && <p className="plan-line lot-line" role="status"><b>{gone}</b> {grove ? 'Top up below to send again.' : 'Start the monthly plan below to send again.'}</p>}
          {b.renewal_pending && <p className="plan-line lot-line" role="status"><b>Your new month&apos;s {P.monthlySignatures} signatures arrive when the renewal payment goes through.</b> That is usually within the hour, and there is nothing for you to do.</p>}
          {/* Like a usage limit that resets: this month's signatures and when they reset, then every other lot with its own date. */}
          {b.period && (
            <p className="plan-line lot-line" style={{ marginTop: 6 }}><b>This month: {b.period.left} of {b.period.of} left.</b> {b.period.fresh === 'none'
              ? <>They expire on {expiryMoment(b.period.resets_at)}, and no new month follows.</>
              : <>They reset on {expiryMoment(b.period.resets_at)}.</>}{b.period.held > 0 ? <> {b.period.held} more {b.period.held === 1 ? 'is' : 'are'} held for envelopes that are out.</> : ''}</p>
          )}
          {b.lots?.filter((l: any) => !(b.period && (l.source === 'plan' || l.source === 'code') && l.expires_at === b.period.resets_at)).length > 0 && (
            <ul className="lot-list">{b.lots.filter((l: any) => !(b.period && (l.source === 'plan' || l.source === 'code') && l.expires_at === b.period.resets_at)).map((l: any, i: number) => (
              <li key={i}>
                <b>{l.source === 'topup' ? `Top-up of ${utcDay(l.at)}` : l.label}: {l.left} of {l.of} left</b>
                {l.expires_at ? (l.live ? <> until {expiryMoment(l.expires_at)}.</> : <>, past {l.held === 1 ? 'its' : 'their'} date ({expiryMoment(l.expires_at)}): only the held ones are left, and they do not expire while held.</>) : <>, with no expiry date.</>}
                {l.held > 0 && l.live ? <> {l.held} more {l.held === 1 ? 'is' : 'are'} held for envelopes that are out.</> : ''}
              </li>
            ))}</ul>
          )}
          <p className="muted small" style={{ margin: '10px 0 0' }}>Dates and times on this page are in UTC.</p>
          {s.available < 0 && <div className="notice warn">You are {n(b.short)} short. {s.held > 0 ? 'More envelopes are out than you have signatures for, and people can still sign them. ' : ''}Whatever you add next covers those {b.short} first, so add more than that before sending to someone new. Signing your own documents stays free.</div>}
        </div>
      )}

      <div className="card">
        <div className="row between wrap">
          <div>
            <div className="muted small" style={{ fontWeight: 600 }}>Monthly plan</div>
            <h2 style={{ fontSize: 24 }}>{free ? <>Free <s className="muted" style={{ fontSize: 16, fontWeight: 400 }}>{price} a month</s></> : <>{myPrice} a month</>} <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>adds {n(P.monthlySignatures)} every month</span></h2>
          </div>
          {free && <span className="badge completed">Free with {b.free_with}</span>}
          {grove && !free && !b.ends_at && !b.problem && <span className="badge completed">Active</span>}
          {grove && !free && b.ends_at && !b.problem && <span className="badge expired">Ends {utcDay(b.ends_at)}</span>}
          {!free && b.problem && <span className="badge expired">{b.problem === 'paused' ? 'Paused' : b.problem === 'unpaid' ? 'On hold' : 'Payment failed'}</span>}
          {!grove && !b.problem && <span className="badge">{b.ended ? 'Ended' : 'Not started'}</span>}
        </div>

        {free && (
          <p className="plan-line" style={{ marginBottom: 0 }}>
            <b>Your plan is free with the code {b.free_with}.</b> {n(P.monthlySignatures)} come with every calendar month at no charge{b.free_next_at ? <> (the next on {utcDay(b.free_next_at)})</> : ''}. They belong to that month: what you do not use by its end expires, and the next month brings a fresh {P.monthlySignatures}. Nothing is charged for the plan, so there is nothing to cancel. Need more in a busy month? Top up below.
          </p>
        )}
        {!free && b.problem && (
          <>
            {b.problem === 'unpaid' ? (
              <div className="notice warn" style={{ marginBottom: 12 }}><b>Your plan is on hold: a payment did not go through, and the card is no longer being tried.</b> Nothing is locked and nothing is deleted, and the signatures you have still work. To bring the plan back, pay the open payment (you can use another card there). A new card on file is not enough by itself. To stop the plan instead, cancel: the open payment is then withdrawn and never tried again.</div>
            ) : b.problem === 'paused' ? (
              <div className="notice warn" style={{ marginBottom: 12 }}><b>Your plan is paused with the payment provider.</b> Nothing is charged while it is paused, nothing is locked, and the signatures you have still work. To end it for good, cancel.</div>
            ) : (
              <div className="notice warn" style={{ marginBottom: 12 }}><b>The last payment did not go through.</b> Nothing is locked and nothing is deleted, and the signatures you have still work. The card will be tried again over the next days. To keep the plan, pay now or update the card. To stop it, cancel: the failed payment is then not tried again.{b.ends_at ? <> It is already set to end on {expiryMoment(b.ends_at)}; pressing Cancel plan ends it today instead.</> : ''}</div>
            )}
            {admin && (
              <div className="row wrap">
                {/* "Paid in the meantime" is good news, not an error: it is said plainly and the page is read again. */}
                {b.can_pay_open && <button className="btn primary" disabled={busy} onClick={() => act(async () => {
                  try {
                    const r = await api('/billing/pay-open', { method: 'POST' });
                    window.location.href = r.url;
                  } catch (e: any) {
                    if (e?.status !== 409) throw e;
                    // Cancel was pressed and never confirmed: paying keeps the plan only if the person says so.
                    if (e.code === 'cancel_pressed') {
                      if (!window.confirm(`${e.message}\n\nKeep the plan and pay it now?`)) return;
                      const r = await api('/billing/pay-open', { method: 'POST', body: { keep: true } });
                      window.location.href = r.url;
                      return;
                    }
                    toast(e.message);
                  }
                })}>Pay the open payment</button>}
                {b.problem !== 'paused' && <button className={b.can_pay_open ? 'btn' : 'btn primary'} disabled={busy} onClick={() => go('/billing/portal')}>Update the card</button>}
                <button className="btn" onClick={() => setModal('cancel')}>Cancel plan</button>
              </div>
            )}
          </>
        )}
        {grove && !free && !b.ends_at && !b.problem && (
          <>
            <p className="plan-line">{b.renews_at && Date.parse(b.renews_at) <= Date.now() ? <>The payment for the new month is being taken now: <b>{b.next_amount || price}</b> (your bank may show it up to an hour later), which adds {n(P.monthlySignatures)} and plants {mangrovesFor(P.monthlyUsd)} mangroves. You can still cancel: a month that has not been paid for yet is then withdrawn.</> : b.renews_at ? <>Next charge: <b>{b.next_amount || price} on {expiryMoment(b.renews_at)}</b> (your bank may show it up to an hour later), which adds {n(P.monthlySignatures)} and plants {mangrovesFor(P.monthlyUsd)} mangroves. That is the whole amount. We remind you by email a week before and again about a day before, and you can cancel right up to the charge.</> : <>Billed {price} each month. We remind you by email a week before and again about a day before every charge.</>}</p>
            {admin && <div className="row wrap"><button className="btn" onClick={() => setModal('cancel')}>Cancel plan</button></div>}
          </>
        )}
        {grove && !free && b.ends_at && !b.problem && (
          <>
            <p className="plan-line"><b>Cancelled.</b> You will not be charged again. The plan runs until {expiryMoment(b.ends_at)}. What is left of this month&apos;s signatures expires then, like every month&apos;s, and no new month follows; top-ups keep their own dates. Nothing is deleted.{b.cancel_ref ? <> Cancellation reference <b>{b.cancel_ref}</b>.</> : ''}</p>
            {admin && <button className="btn primary" disabled={busy} onClick={() => act(() => api('/billing/resume', { method: 'POST' }).then(() => (setDone(null), toast('Welcome back. Your plan continues.'))))}>Keep the plan after all</button>}
          </>
        )}
        {b.disputed && <div className="notice warn" style={{ marginBottom: 12 }}><b>A payment on this account was disputed with the bank.</b> New payments are switched off until a person has looked. If that was a mistake, <Link href="/help?topic=billing#contact">write to us</Link> and we switch them back on.</div>}
        {!grove && !b.problem && !b.disputed && (
          <>
            <p className="plan-line">{n(P.monthlySignatures)} added to your balance with every payment, {mangrovesFor(P.monthlyUsd)} mangroves planted each month. They belong to that month: what you do not use by the renewal expires, and the renewal brings a fresh {P.monthlySignatures}. Need more in a busy month? Top up at ${P.topUpUsd} a signature.</p>
            {admin && b.enabled && b.other_paid?.length > 0 && (
              <div className="notice warn" style={{ marginBottom: 12 }}>You already pay for a plan on {b.other_paid.map((x: string) => `"${x}"`).join(' and ')}. Starting one here is a second, separate subscription. Each team needs only one.</div>
            )}
            {admin && b.enabled && (
              <div className="row wrap">
                <button className="btn primary" disabled={busy} onClick={() => go('/billing/checkout')}>Start the monthly plan for {price}</button>
                <span className="muted small">Month to month. Cancel in one click. Unused signatures refunded within {b.refund_days} days.</span>
              </div>
            )}
          </>
        )}
        {!admin && <p className="muted small" style={{ marginBottom: 0 }}>Only account admins can change the plan.</p>}
        {admin && b.enabled && b.has_customer && (
          <div className="row wrap" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line, #e4dfd3)' }}>
            <span className="muted small">Your card and invoices are always here, also after you cancel.</span>
            <button className="btn ghost sm" disabled={busy} onClick={() => go('/billing/portal')}>Invoices and card</button>
            <button className="btn ghost sm" onClick={() => setModal('card')}>Remove card</button>
          </div>
        )}
      </div>

      {admin && !free && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); act(async () => { const r = await api('/billing/redeem', { body: { code } }); setCode(''); toast(`Code ${r.free_with} accepted. Your monthly plan is free.`); }); }}>
          <h3>Have a code?</h3>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>Some communities get the monthly plan free. Enter the code you were given.</p>
          <div className="row wrap">
            <input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" placeholder="Your code" autoComplete="off" style={{ maxWidth: 240 }} />
            <button className="btn" disabled={busy || !code.trim()}>Apply code</button>
          </div>
        </form>
      )}

      {admin && b.enabled && !b.disputed && (
        <div className="card">
          <h2>Top up</h2>
          <p className="muted" style={{ margin: '4px 0 12px' }}>${P.topUpUsd} a signature. Each one plants {P.treesPerUsd} mangrove trees. A top-up is a single payment you choose: it never changes your plan or its price.</p>
          {grove ? (
            <>
              <div className="row wrap" role="group" aria-label="How many signatures">
                {TOP_UP_PICKS.map((x) => <button key={x} className={`btn sm${q === x ? ' primary' : ''}`} aria-pressed={q === x} onClick={() => setQty(x)}>{x}</button>)}
                <label className="row small" style={{ gap: 6 }}>or <input type="number" min={1} max={P.topUpMax} value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ width: 90 }} aria-label="Number of signatures" /></label>
              </div>
              <div className="row between wrap" style={{ marginTop: 14 }}>
                <div className="topup-sum"><b>{n(q)}</b> for <b>${q * P.topUpUsd}</b> plants <b>{mangrovesFor(q * P.topUpUsd).toLocaleString()} mangroves</b></div>
                <button className="btn primary" disabled={busy} onClick={() => go('/billing/topup', { quantity: q })}>Pay ${q * P.topUpUsd} and add {n(q)}</button>
              </div>
            </>
          ) : <div className="notice">{b.problem === 'paused' ? 'Top-ups come with the monthly plan, and yours is paused with the payment provider. Once it runs again you can top up.' : b.problem ? 'Top-ups come with the monthly plan, and yours is on hold because a payment did not go through. Pay the open payment above (you can use another card there) and you can top up again. A new card on file is not enough by itself.' : 'Top-ups come with the monthly plan. Start the plan above and you can add signatures whenever you need them.'}</div>}
        </div>
      )}

      {admin && b.refund && (
        <div className="card row between wrap">
          <div style={{ maxWidth: 560 }}>
            <h3>Want your money back?</h3>
            <p className="muted" style={{ margin: '4px 0 0' }}>Your latest payment can be refunded: {b.refund.reason}, so {b.refund.amount} goes back to your card. No form, no waiting for approval.{b.refund.kind === 'plan' && !free ? ' Refunding a monthly payment also ends the plan.' : ''} Earlier payments from the last {b.refund_days} days can be refunded from the list below.</p>
          </div>
          <button className="btn" onClick={() => { setOffer(b.refund); setModal('refund'); }}>Refund {b.refund.amount}</button>
        </div>
      )}

      {/* Every rule, closed until someone wants it (research/ux-charter.md, Plan): the dates above are what people need daily. */}
      <details className="card" data-fold="">
        <summary style={{ padding: '11px 0', cursor: 'pointer', fontWeight: 600, fontSize: 18 }}>How signatures work</summary>
        <ul className="rules" style={{ marginTop: 10 }}>
          <li><b>{price} a month adds {n(P.monthlySignatures)}.</b> Extra signatures are ${P.topUpUsd} each. Every dollar plants {P.treesPerUsd} mangrove trees.</li>
          <li><b>When signatures expire.</b> {b.expiry_rule}</li>
          <li><b>You only use one when somebody signs.</b> When an envelope is voided, declined or expires, the signatures held for people who had not signed yet come back. {b.held_rule} One that was already used stays used. Correcting a sent envelope and sending reminders are free.</li>
          <li><b>Some things are always free.</b> Signing your own documents, under your own name and address. People who approve, view or get a copy. Everyone who signs something you send. Your first {n(P.welcomeSignatures)}. Being asked to sign again after a change.</li>
          <li><b>Some things always use one.</b> Someone signing in person on your device, whatever address you typed for them. Each visitor who signs a public form of yours: a form holds nothing while people fill it in and takes one signature when a visitor finishes. It never takes one that is held for an envelope you have out, and never takes you below zero. <Link href="/help#signatures">More about forms and signatures</Link>.</li>
          <li><b>Nothing is charged unless you choose it.</b> When you run out, sending pauses and tells you. There are no automatic extra charges and no per-person fees.</li>
          <li><b>Month to month.</b> No yearly contract and no notice period. Cancel any time up to the minute before a charge. We remind you a week before and again about a day before, with the exact amount.</li>
          <li><b>Refunds are automatic.</b> {b.refund_rule}</li>
          <li><b>No surprise price rises.</b> {b.price_rule}</li>
          {b.dormant_stop_days > 0 && <li><b>We do not charge for a plan nobody uses.</b> If nothing has been sent for {b.dormant_stop_days} days when a renewal comes up, we stop the renewal and tell you, with one click to keep it.</li>}
          <li><b>Charged after cancelling?</b> That should never happen. If it does, the software refunds it by itself and tells you. While the payment provider cannot be reached it keeps trying; if the provider refuses the refund three times, a person here sends it by hand and we tell you so. The same goes for being charged twice for the plan, or more than we told you.</li>
          <li><b>A card dispute stops everything.</b> If a payment is disputed with the bank, billing stops at once and new payments stay off until a person has looked. The unused signatures that payment bought are set aside: they leave with the money if it goes back to the card, and come back if the bank decides the payment stands (unless their own date passed in the meantime: then they expire). Ones of that payment that already expired are not taken from anything else.</li>
          <li><b>Payments are in US dollars.</b> Anything paid in another currency is sent straight back.</li>
          <li><b>The limits, as numbers.</b> A top-up is at most {b.limits.top_up_max} signatures, a bulk send at most {b.limits.bulk_rows} rows, and top-ups need the monthly plan. To keep scammers out, an account without a payment that has stood for {b.limits.paid_trust_days} days can send to {b.limits.new_account_daily} people a day in its first week{b.limits.first_week_daily ? ' (that is you, for now)' : ''} and to {b.limits.unpaid_daily} a day after that{b.limits.unpaid_daily_now ? ' (that is you, for now)' : ''}. Paying does not lift them at once: they stop, together with the check for fake payment notices, once a payment is at least {b.limits.paid_trust_days} days old and was not refunded or disputed{b.limits.lifts_on ? <> (for you, on {utcDay(b.limits.lifts_on)}, if that payment stands)</> : ''}. A small amount we send back by ourselves because more was charged than we said does not count as a refund here. A person on our team can lift them sooner: use the contact form on the help page.</li>
          <li><b>Stopping never costs you your documents.</b> Cancelling or a failed payment deletes nothing and locks nothing. Export is always free.</li>
          <li><b>Locked out?</b> While a plan is renewing, every email about a payment has a link that stops it without logging in. <Link href="/help">The help page</Link> can also stop it with the card alone: the last four digits plus the date and amount of a charge.</li>
        </ul>
      </details>

      <div className="grid g2">
        <div className="card pad0">
          <div style={{ padding: '14px 16px' }}><h2>Payments</h2><div className="muted small">Kept for as long as the account exists.</div></div>
          {b.payments.length === 0 ? <div className="empty" style={{ padding: 24 }}>No payments yet.</div> : (
            <div className="tablewrap"><table className="t">
              <thead><tr><th>Date</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>{b.payments.map((p: any) => (
                <tr key={p.id}><td>{utcDay(p.at)}</td><td>{p.label || (p.kind === 'topup' ? 'Top-up' : 'Monthly plan')}<div className="muted small">{n(p.credits)}</div>{p.expires_at && p.credits > 0 && <div className="muted small">{Date.parse(p.expires_at) > Date.now() ? 'Expire' : 'Expired'} {expiryMoment(p.expires_at)}</div>}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{p.amount}{p.refunded && <div className="muted small">{p.refunded} refunded</div>}
                    {p.disputed === 'open' && <div className="muted small">Disputed with the bank, not decided yet</div>}
                    {p.refund_pending && <div className="muted small">Refund on its way</div>}
                    {p.receipt_url && <div className="small"><a href={p.receipt_url} target="_blank" rel="noreferrer">Invoice ↗</a></div>}
                    {admin && p.refundable && <div><button className="linklike small" onClick={() => { setOffer(p.refundable); setModal('refund'); }}>Refund {p.refundable.amount}</button></div>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="card pad0">
          <div style={{ padding: '14px 16px' }}><h2>Signature activity</h2><div className="muted small">Every change to your balance, newest first.</div></div>
          {b.ledger.length === 0 ? <div className="empty" style={{ padding: 24 }}>Nothing yet.</div> : (
            <div className="tablewrap" style={{ maxHeight: 320, overflowY: 'auto' }}><table className="t">
              <tbody>{b.ledger.map((l: any, i: number) => (
                <tr key={i}><td>{l.label}<div className="muted small">{expiryMoment(l.at)}</div></td><td className="num" style={{ textAlign: 'right', fontWeight: 600, color: l.delta > 0 ? 'var(--green)' : undefined }}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      {b.history?.length > 0 && (
        <div className="card pad0">
          <div style={{ padding: '14px 16px' }}><h2>Plan history</h2><div className="muted small">Every start, reminder, cancellation and refund, with its reference. Kept for as long as the account exists.</div></div>
          <ul className="plan-history">{b.history.map((h: any, i: number) => (
            <li key={i}>
              <div className="row between wrap" style={{ gap: 8 }}><b>{h.label}</b><span className="muted small">{expiryMoment(h.at)}</span></div>
              {h.detail && <div className="muted small">{h.detail}</div>}
              {h.ref && <div className="muted small ref">Reference {h.ref}</div>}
            </li>
          ))}</ul>
        </div>
      )}

      {!b.enabled && <div className="notice warn">Payments are not connected on this server, so signatures are not counted and there is nothing to pay.</div>}

      {modal === 'cancel' && (
        <Modal title="Cancel the monthly plan" onClose={() => setModal('')}>
          <ul className="rules">
            <li>You will not be charged again.</li>
            {b.problem ? <li>The last payment did not go through, so the plan ends today and that payment is not tried again.</li>
              : <li>The plan runs until {b.renews_at ? expiryMoment(b.renews_at) : 'the end of the month you paid for'}, because that month is already paid for. (If a new month has only just started and its payment has not been taken yet, the plan ends today instead and that payment is withdrawn.)</li>}
            <li>{b.period ? `This month's signatures (${b.period.left} of ${b.period.of} left) can be used until ${expiryMoment(b.period.resets_at)} and expire then, like every month's; no new month follows.` : 'No new signatures arrive after the plan ends.'} {b.topups?.length ? `Your top-up signatures keep their own dates (${TOPUP_EXPIRY_MONTHS} months after each payment).` : ''}</li>
            <li>Nothing is deleted. Every document, audit trail and invoice stays in your account.</li>
          </ul>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Keep the plan</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/cancel', { method: 'POST' }); setDone({ kind: 'cancel', ...r }); setModal(''); window.scrollTo({ top: 0 }); })}>Cancel plan</button>
          </div>
        </Modal>
      )}
      {modal === 'refund' && offer && (
        <Modal title={`Refund ${offer.amount}`} onClose={() => setModal('')}>
          <p>We will send {offer.amount} back to the card you paid with, for the {n(offer.signatures)} you have not used from your payment of {utcDay(offer.paid_at)}. Those signatures leave your balance.{offer.kind === 'plan' ? (free ? ' Your free plan is not affected.' : (grove || b.problem) ? ' Because this was a monthly payment, the monthly plan ends first, today. Nothing is deleted.' : ' Your monthly plan has already ended, so nothing else changes.') : ' Your plan is not affected.'}</p>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Not now</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/refund', { body: { payment_id: offer.payment_id } }); setDone({ kind: 'refund', ...r }); setModal(''); window.scrollTo({ top: 0 }); })}>Send my refund</button>
          </div>
        </Modal>
      )}
      {modal === 'card' && (
        <Modal title="Remove your card" onClose={() => setModal('')}>
          <p>We take the card off file so nothing can be charged to it. {b.can_cancel ? 'Your plan is cancelled at the same time, so it does not renew.' : ''} Your signatures can still be used until their own dates, and nothing is deleted.</p>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Keep the card</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/remove-card', { method: 'POST' }); setDone({ kind: 'card', ...r }); setModal(''); window.scrollTo({ top: 0 }); })}>Remove card</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// The two lists of what closing an account deletes and keeps, closed until someone wants them.
function WhatIsKept() {
  return (
    <details data-fold="" className="set-kept">
      <summary className="set-fold">What is kept</summary>
      <div className="grid g2" style={{ margin: '10px 0 0' }}>
        <div><b>Deleted for good</b><ul className="rules small" style={{ marginTop: 6 }}>{DELETED_WITH_ACCOUNT.map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><b>Kept</b><ul className="rules small" style={{ marginTop: 6 }}>{KEPT_AFTER_DELETION.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
    </details>
  );
}

// `only` draws one of its two cards: an admin has Export open and Close your account behind More options.
function YourData({ only }: { only?: 'export' | 'close' } = {}) {
  const me = useMe();
  const [info] = useLoad(() => api('/me/delete'));
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [now, setNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked: string[] = info?.blocked || [];
  const owned: any[] = info?.owned || [];
  const inFlight = owned.reduce((n, a) => n + a.in_flight, 0);
  // The API keys this person made, in their own account and in teams. They go off with the login.
  const keys: any[] = info?.keys || [];

  async function close() {
    setBusy(true);
    try {
      const r = await api('/me/delete', { body: { password: pw, now } });
      window.location.assign(r.closed === 'now' ? '/?closed=now' : '/login?closing=1');
    } catch (e) {
      oops(e);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {only !== 'close' && <div className="card row between wrap" data-item="card">
        <div style={{ maxWidth: 600 }}>
          <h2>Take everything with you</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>One ZIP file with every signed PDF with its signing record, the full history of every document, and a spreadsheet listing them all. Free on every plan, as often as you like, and it keeps working if you cancel.</p>
        </div>
        <a className="btn" href="/api/export">Export everything</a>
      </div>}

      {only !== 'export' && <div className="card" data-item="card">
        <h2>Close your account</h2>
        <p className="muted" style={{ margin: '6px 0 12px' }}>Closing is separate from cancelling a plan. If you only want to stop paying, <button className="linklike" onClick={() => window.location.assign('/app/settings?tab=billing')}>cancel the plan</button> instead and keep all your documents.</p>
        {blocked.length > 0 ? (
          <>
            <div className="notice warn">You own {blocked.map((n) => `"${n}"`).join(' and ')} and other people still use it. Make one of them the owner on the Team tab first, then you can close your own account.</div>
            {/* What closing would remove and keep is said here too, so nobody has to hand an account over to find out. */}
            <p className="muted small" style={{ margin: '14px 0 0' }}>Once you can close it, this is what goes and what stays. An account you have handed to someone else is theirs then and is not deleted.</p>
            <WhatIsKept />
          </>
        ) : (
          <>
            <ul className="rules">
              {/* Said before the payment provider has answered, so it promises only what the software does either way. */}
              <li>Any subscription is cancelled at once. If the payment provider still takes a payment before it has confirmed that, the software refunds it by itself.</li>
              <li><b>Nothing is deleted for {CLOSE_GRACE_DAYS} days.</b> If you change your mind, or closed it by mistake, sign in again and the account comes straight back. We email you {CLOSING_REMINDER_DAYS} days before the end with the date and how to keep it.</li>
              <li>While it is closing, nothing new starts in it: nothing can be sent, nobody can be invited or join, and public forms take no new signatures.</li>
              <li>After {CLOSE_GRACE_DAYS} days {owned.length ? `the account and ${closingCount(owned.reduce((n, a) => n + a.envelopes, 0))} are` : 'your login is'} removed for good. Export first if you want copies. &quot;What is kept&quot; below says exactly what goes and what stays.</li>
              {inFlight > 0 && <li>{inFlight === 1 ? '1 document is' : `${inFlight} documents are`} still out for signature. People can keep signing during the {CLOSE_GRACE_DAYS} days.</li>}
              {keys.length > 0 && <li><b>{keys.length === 1 ? 'Your API key stops' : `Your ${keys.length} API keys stop`} working at once:</b> {keys.map((k) => `"${k.name}" in ${k.account}`).join(', ')}. Whatever uses {keys.length === 1 ? 'it' : 'them'} starts failing straight away, and {keys.length === 1 ? 'it works' : 'they work'} again only if you sign in within the 30 days.{keys.some((k) => k.team) ? ' The admins of a team a key belongs to are told by email.' : ''}</li>}
            </ul>
            <WhatIsKept />
            <button className="btn danger" onClick={() => setOpen(true)}>Close my account</button>
          </>
        )}
      </div>}

      {open && (
        <Modal title="Close your account" onClose={() => setOpen(false)}>
          {me.user.has_password === false ? (
            // Someone who signs in with Google or Microsoft has no password to type here. They are told how to get
            // one, and the button below stays off until they have it.
            <div className="notice warn" style={{ marginBottom: 12 }}>Closing an account is confirmed with your password, and this login has none yet because you sign in another way. Set one first: open <button className="linklike" onClick={() => window.location.assign('/app/settings?tab=security')}>Settings, Security</button> and choose &quot;Email me a link to set a password&quot;. Then come back here. Nothing has been changed.</div>
          ) : (
            <>
              <p>Enter your password to confirm it is you, <bdi>{me.user.name}</bdi>.</p>
              <label className="f"><span>Password</span><input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
            </>
          )}
          <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> Delete everything right now instead of keeping it for {CLOSE_GRACE_DAYS} days. This cannot be undone, and nobody can bring it back, us included.</label>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(false)}>Keep my account</button>
            <button className="btn primary" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy || !pw} onClick={close}>{now ? 'Delete now' : 'Close account'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Checkout sessions this page has already confirmed, so coming back is handled once.
const returned = new Set<string>();


export default function Settings() {
  const me = useMe();
  const [tab, setTab] = useState('profile');
  // Said once when a link asked for a section this person does not have (src/lib/settingsnav.ts).
  const [note, setNote] = useState('');
  // The sections this person has: an owner or admin at most 10, a member at most 4.
  const TABS = sectionsFor(me.role, !!me.org_admin);
  // A member reading the plan or the stamps is in a section that has no tab of its own.
  const listed = TABS.some(([k]) => k === tab);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const to = landingFor(me.role, q.get('tab'), window.location.hash, !!(q.get('signin') || q.get('signin_error')), !!me.org_admin);
    setTab(to.tab);
    setNote(to.note || '');
    // An old link to something that moved: bring it into view once its section is drawn.
    if (to.focus) setTimeout(() => document.getElementById(to.focus!)?.scrollIntoView({ block: 'start' }), 400);
    if ((q.get('upgraded') || q.get('topped')) && !returned.has(q.get('session_id') || '')) {
      returned.add(q.get('session_id') || '');
      // Back from checkout: apply the plan or the top-up right away rather than waiting for the payment provider to tell us.
      const topped = !!q.get('topped');
      const unsure = 'We could not confirm that payment yet. If you paid, it shows here within a minute and nothing is charged twice. If it does not, contact us.';
      api('/billing/sync', { body: { session_id: q.get('session_id') || '' } }).then((r) => {
        // Only thank people for a payment that really arrived.
        if (r.applied === 'topup' && topped) toast('Signatures added. Thank you for planting mangroves.');
        else if (r.applied === 'plan' && !topped) toast('Welcome to the monthly plan. Thank you for planting mangroves.');
        else if (r.applied === 'plan-pending' && !topped) toast('Welcome to the monthly plan. Your signatures are being added and will show here within a minute.');
        else toast(unsure, true);
      }).catch(() => toast(unsure, true)).finally(() => {
        window.history.replaceState(null, '', '/app/settings?tab=billing');
        window.dispatchEvent(new Event('sg-billing-changed'));
      });
    }
  }, []);
  useEffect(() => {
    document.querySelector('.tabs .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [tab]);
  const pick = (k: string) => {
    setTab(k as typeof tab);
    setNote('');
    window.history.replaceState(null, '', `/app/settings?tab=${k}`);
  };
  return (
    <div>
      <div className="pagehead"><h1 className="serif">Settings</h1></div>
      {/* Real tabs: Left, Right, Home and End move between them, Tab goes on into the section that is open. */}
      <div className="tabs" role="tablist" aria-label="Settings sections" onKeyDown={(e) => {
        const to = nextTab(TABS.map(([k]) => k), listed ? tab : TABS[0][0], e.key);
        if (!to) return;
        e.preventDefault();
        pick(to);
        setTimeout(() => document.getElementById(`set-tab-${to}`)?.focus(), 0);
      }}>{TABS.map(([k, l]) => <button key={k} id={`set-tab-${k}`} role="tab" aria-selected={tab === k} aria-controls="set-panel" tabIndex={tab === k || (!listed && k === TABS[0][0]) ? 0 : -1} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
      {note && <div className="notice" role="status" style={{ marginBottom: 16 }}>{note}</div>}
      <div id="set-panel" role="tabpanel" aria-labelledby={listed ? `set-tab-${tab}` : undefined} aria-label={listed ? undefined : 'What the admins set'}>
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'account' && <Card><Account /></Card>}
      {tab === 'account' && <LanguageSettings />}
      {tab === 'sending' && <div className="stack"><Card><SendingDefaults /></Card><CustomFieldSettings /><MoreOptions><Disclosure /></MoreOptions></div>}
      {/* Admins, where the operator set up WhatsApp or calls with a code: one read-only Connections card. */}
      {tab === 'sending' && <ChannelsStatus />}
      {tab === 'team' && <Team />}
      {tab === 'billing' && <Billing />}
      {tab === 'data' && <Card><RetentionSettings /></Card>}
      {/* Admins, once a list for Send to many is saved: after how many days an unused one is deleted (reports/SavedLists.tsx). */}
      {tab === 'data' && <ListDaysSetting />}
      {tab === 'data' && <ArchiveSettings />}
      {tab === 'data' && <SealStatus />}
      {tab === 'data' && <YourData only="export" />}
      {tab === 'data' && <MoreOptions><ArchiveFormat /><YourData only="close" /></MoreOptions>}
      {tab === 'developers' && <Developers />}
      {tab === 'stamps' && <Card><StampSettings /></Card>}
      {tab === 'organisation' && me.org_admin && <Organisation />}
      </div>
    </div>
  );
}
