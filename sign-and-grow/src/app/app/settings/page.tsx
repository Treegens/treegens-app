'use client';
import { useEffect, useState } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { AdoptSignature } from '@/components/SignaturePad';
import { PLANS } from '@/lib/impact';

const fileToDataUrl = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = rej;
  r.readAsDataURL(file);
});

function Profile() {
  const me = useMe();
  const [f, setF] = useState({ name: me.user.name, title: me.user.title || '', company: me.user.company || '' });
  const [pw, setPw] = useState({ current: '', password: '' });
  const [adopt, setAdopt] = useState<'' | 'signature' | 'initials'>('');
  const save = (body: any, msg = 'Saved') => api('/me', { method: 'PATCH', body }).then(() => (toast(msg), me.reload())).catch(oops);
  return (
    <div className="stack">
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Profile</h2>
        <div className="grid g3">
          <label className="f"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="f"><span>Job title</span><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="f"><span>Company</span><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label>
        </div>
        <div className="row between wrap"><span className="muted small">{me.user.email} · {me.user.email_verified ? 'confirmed' : 'not confirmed yet'}</span><button className="btn primary" onClick={() => save(f)}>Save profile</button></div>
      </div>
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Your signature</h2>
        <p className="muted small">Saved here, it is offered automatically whenever a document is sent to {me.user.email}.</p>
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
      </div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); api('/me/password', { body: pw }).then(() => (toast('Password changed'), setPw({ current: '', password: '' }))).catch(oops); }}>
        <h2 style={{ marginBottom: 12 }}>Password</h2>
        <div className="grid g2">
          <label className="f"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
          <label className="f"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></label>
        </div>
        <button className="btn">Change password</button>
      </form>
      {adopt && <AdoptSignature kind={adopt} name={me.user.name} onClose={() => setAdopt('')} onDone={(png) => (save({ [`${adopt}_png`]: png }), setAdopt(''))} />}
    </div>
  );
}

function Account() {
  const me = useMe();
  const a = me.account;
  const admin = me.role !== 'member';
  const [f, setF] = useState({ name: a.name, brand_color: a.brand_color || '#1f6f43', brand_logo: a.brand_logo || '', default_reminder_days: a.default_reminder_days, default_expire_days: a.default_expire_days });
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
            <label className="btn sm">Upload<input type="file" hidden accept="image/png,image/jpeg" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 200_000) return toast('Logo must be under 200 KB.', true); setF({ ...f, brand_logo: await fileToDataUrl(file) }); }} /></label>
            {f.brand_logo && <button className="btn sm ghost" onClick={() => setF({ ...f, brand_logo: '' })}>Remove</button>}
          </div>
        </div>
        <label className="f"><span>Default reminder <span className="hint">(days, 0 for never)</span></span><input type="number" min={0} max={60} value={f.default_reminder_days} onChange={(e) => setF({ ...f, default_reminder_days: Number(e.target.value) })} /></label>
        <label className="f"><span>Default expiry <span className="hint">(days)</span></span><input type="number" min={1} max={365} value={f.default_expire_days} onChange={(e) => setF({ ...f, default_expire_days: Number(e.target.value) })} /></label>
      </div>
      <button className="btn primary" onClick={() => api('/account', { method: 'PATCH', body: f }).then(() => (toast('Saved'), me.reload())).catch(oops)}>Save</button>
    </div>
  );
}

function Team() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [d, reload] = useLoad(() => api('/account/members'));
  const [inv, setInv] = useState({ email: '', role: 'member' });
  return (
    <div className="stack">
      {admin && (
        <form className="card row wrap" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); api('/account/invites', { body: inv }).then(() => (toast('Invitation sent'), setInv({ email: '', role: 'member' }), reload())).catch(oops); }}>
          <label className="f grow" style={{ margin: 0 }}><span>Invite by email</span><input type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></label>
          <label className="f" style={{ margin: 0 }}><span>Role</span><select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <button className="btn primary">Send invite</button>
        </form>
      )}
      <div className="card pad0">
        <table className="t">
          <thead><tr><th>Member</th><th>Role</th><th /></tr></thead>
          <tbody>
            {(d?.members || []).map((m: any) => (
              <tr key={m.id}>
                <td><b>{m.name}</b><div className="muted small">{m.email}</div></td>
                <td>{admin && m.role !== 'owner' && m.id !== me.user.id ? (
                  <select value={m.role} style={{ width: 120 }} aria-label="Role" onChange={(e) => api(`/account/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }).then(reload).catch(oops)}><option value="member">Member</option><option value="admin">Admin</option></select>
                ) : <span style={{ textTransform: 'capitalize' }}>{m.role}</span>}</td>
                <td style={{ textAlign: 'right' }}>{admin && m.role !== 'owner' && m.id !== me.user.id && <button className="btn sm ghost danger" onClick={() => window.confirm(`Remove ${m.name} from the team?`) && api(`/account/members/${m.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Remove</button>}</td>
              </tr>
            ))}
            {(d?.invites || []).map((i: any) => (
              <tr key={i.id}><td><b>{i.email}</b><div className="muted small">Invited {fmtDate(i.created_at)}</div></td><td style={{ textTransform: 'capitalize' }}>{i.role} · pending</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm ghost danger" onClick={() => api(`/account/invites/${i.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Cancel</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Members see the envelopes they sent. Admins see everything in the account. Templates are shared with everyone.</p>
    </div>
  );
}

function Developers() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [keys, reloadKeys] = useLoad(() => api('/api-keys'));
  const [hooks, reloadHooks] = useLoad(() => (admin ? api('/webhooks') : Promise.resolve(null)));
  const [fresh, setFresh] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div className="stack">
      <div className="card">
        <div className="row between wrap"><h2>API keys</h2><a href="/developers" target="_blank">API reference ↗</a></div>
        <p className="muted small">Included on every plan. Use a key as a Bearer token.</p>
        {fresh && <div className="notice" style={{ marginBottom: 12 }}>Copy your key now. It will not be shown again:<div className="mono" style={{ marginTop: 4 }}>{fresh}</div></div>}
        {(keys?.keys || []).map((k: any) => (
          <div key={k.id} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span><b>{k.name}</b> <span className="mono muted">{k.prefix}…</span></span>
            <span className="row"><span className="muted small">{k.last_used_at ? `last used ${fmtDate(k.last_used_at)}` : 'never used'}</span><button className="btn sm ghost danger" onClick={() => api(`/api-keys/${k.id}`, { method: 'DELETE' }).then(reloadKeys).catch(oops)}>Revoke</button></span>
          </div>
        ))}
        <button className="btn" style={{ marginTop: 12 }} onClick={() => { const name = window.prompt('Name this key (for example "Website integration"):'); if (name !== null) api('/api-keys', { body: { name } }).then((r) => (setFresh(r.key), reloadKeys())).catch(oops); }}>Create API key</button>
      </div>
      {admin && (
        <div className="card">
          <h2>Webhooks</h2>
          <p className="muted small">We POST JSON to your URL when an envelope is sent, viewed, signed, completed, declined, voided or expires. Verify the <span className="mono">X-SignAndGrow-Signature</span> header with the signing secret.</p>
          {(hooks?.webhooks || []).map((h: any) => (
            <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row between"><b className="truncate">{h.url}</b><button className="btn sm ghost danger" onClick={() => api(`/webhooks/${h.id}`, { method: 'DELETE' }).then(reloadHooks).catch(oops)}>Delete</button></div>
              <div className="mono muted">Secret: {h.secret}</div>
            </div>
          ))}
          <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); api('/webhooks', { body: { url } }).then(() => (setUrl(''), reloadHooks())).catch(oops); }}>
            <input placeholder="https://example.com/hooks/sign-and-grow" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Webhook URL" />
            <button className="btn">Add webhook</button>
          </form>
          {hooks?.deliveries?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ marginBottom: 6 }}>Recent deliveries</h3>
              {hooks.deliveries.map((d: any) => <div key={d.id} className="row between small" style={{ padding: '3px 0' }}><span className="mono">{d.event}</span><span className={d.status && d.status < 300 ? '' : 'muted'}>{d.status || d.error} · {fmtDate(d.at, true)}</span></div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Billing() {
  const me = useMe();
  const admin = me.role !== 'member';
  const grove = me.account.plan === 'grove';
  const go = (path: string) => api(path, { method: 'POST' }).then((r) => (window.location.href = r.url)).catch(oops);
  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--green-deep)', color: '#fff', borderColor: 'var(--green-deep)' }}>
        <h2 className="serif" style={{ fontSize: 22 }}>100% of what you pay plants trees</h2>
        <p style={{ color: '#cfe2d3', margin: '6px 0 0', maxWidth: 640 }}>Not profit, not a percentage. All subscription revenue from Sign&Grow goes to Treegens tree planting. People who sign your documents never pay anything.</p>
      </div>
      <div className="grid g2">
        {(['seedling', 'grove'] as const).map((id) => {
          const p = PLANS[id];
          const current = me.account.plan === id;
          return (
            <div key={id} className="card" style={current ? { borderColor: 'var(--green)', boxShadow: '0 0 0 1px var(--green)' } : undefined}>
              <div className="row between"><h2>{p.name}</h2>{current && <span className="badge completed">Your plan</span>}</div>
              <div className="serif" style={{ fontSize: 34, fontWeight: 700, margin: '8px 0 2px' }}>${p.price}<span className="muted" style={{ fontSize: 15, fontWeight: 400 }}> / month</span></div>
              <div className="muted">{p.blurb}</div>
              <ul style={{ paddingLeft: 18, lineHeight: 1.8, margin: '12px 0' }}>
                <li>{Number.isFinite(p.envelopesPerMonth) ? `${p.envelopesPerMonth} envelopes a month` : 'Unlimited envelopes'}</li>
                <li>Unlimited signers, always free for them</li>
                <li>Templates, bulk send, PowerForms, API and webhooks</li>
                <li>Audit trail, certificates and public verification</li>
                {id === 'grove' && <li><b>Every cent goes to tree planting</b></li>}
              </ul>
              {id === 'grove' && !grove && admin && <button className="btn primary" disabled={!me.billing.enabled} onClick={() => go('/billing/checkout')}>Upgrade to Grove</button>}
              {id === 'grove' && grove && admin && <button className="btn" onClick={() => go('/billing/portal')}>Manage subscription</button>}
            </div>
          );
        })}
      </div>
      {!me.billing.enabled && <div className="notice warn">Payments are not connected on this server, so there are no sending limits and nothing to pay. Set the Stripe keys described in the README to turn billing on.</div>}
      {me.billing.limit != null && <div className="muted small">{me.billing.used} of {me.billing.limit} envelopes used this month.</div>}
    </div>
  );
}

const TABS: [string, string][] = [['profile', 'Profile'], ['account', 'Account'], ['team', 'Team'], ['developers', 'API and webhooks'], ['billing', 'Plan']];

export default function Settings() {
  const [tab, setTab] = useState('profile');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('tab')) setTab(q.get('tab')!);
    if (q.get('upgraded')) toast('Welcome to Grove. Thank you for planting trees.');
  }, []);
  return (
    <div>
      <div className="pagehead"><h1 className="serif">Settings</h1></div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'profile' && <Profile />}
      {tab === 'account' && <Account />}
      {tab === 'team' && <Team />}
      {tab === 'developers' && <Developers />}
      {tab === 'billing' && <Billing />}
    </div>
  );
}
