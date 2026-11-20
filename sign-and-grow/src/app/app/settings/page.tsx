'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, oops, toast, Modal, Leaf } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { AdoptSignature } from '@/components/SignaturePad';
import { PRICING, mangrovesFor } from '@/lib/impact';

const fileToDataUrl = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = rej;
  r.readAsDataURL(file);
});
const longDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
// A charge happens at a moment, not on a day: "cancel any time before" needs the time as well.
// Free signatures arrive at the start of the month in UTC, so that date is written in UTC and says so.
const utcDate = (s?: string | null) => (s ? `${new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}, UTC` : '');
const longMoment = (s?: string | null) => (s ? `${longDate(s)} at ${new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '');

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

const NOTIFY: [string, string, string][] = [
  ['completed', 'When everyone has finished', 'One email with the signed document. Most people only need this one.'],
  ['problems', 'When something needs you', 'Someone declined, passed it on, or the deadline is close or has passed.'],
  ['signed', 'Each time someone signs', 'One email per person as they finish. Off by default to keep your inbox quiet.'],
  ['viewed', 'Each time someone opens it', 'Useful when you want to know it arrived. Off by default.'],
];

function Notifications() {
  const me = useMe();
  const [n, setN] = useState<Record<string, boolean>>(me.user.notify || {});
  const flip = (k: string) => {
    const next = { ...n, [k]: !n[k] };
    setN(next);
    api('/me', { method: 'PATCH', body: { notify: { [k]: next[k] } } }).then(() => (toast('Saved'), me.reload())).catch(oops);
  };
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}>Emails about your envelopes</h2>
      <p className="muted small">You choose how much we email you. Everything is always visible in the app either way.</p>
      {NOTIFY.map(([k, title, hint]) => (
        <label key={k} className="setting-row">
          <input type="checkbox" checked={!!n[k]} onChange={() => flip(k)} />
          <span><b>{title}</b><span className="muted small" style={{ display: 'block' }}>{hint}</span></span>
        </label>
      ))}
      <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>People you send to get one request, the reminders you set on the envelope, and one copy when it is complete. They can turn reminders off for themselves.</p>
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
            <label className="btn sm">Upload<input type="file" hidden accept="image/png,image/jpeg" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 200_000) return toast('That logo is over 200 KB. Try a smaller PNG or JPEG.', true); setF({ ...f, brand_logo: await fileToDataUrl(file) }); }} /></label>
            {f.brand_logo && <button className="btn sm ghost" onClick={() => setF({ ...f, brand_logo: '' })}>Remove</button>}
          </div>
        </div>
        <label className="f"><span>Default reminder <span className="hint">(days, 0 for never)</span></span><input type="number" min={0} max={60} value={f.default_reminder_days} onChange={(e) => setF({ ...f, default_reminder_days: Number(e.target.value) })} /></label>
        <label className="f"><span>Default deadline <span className="hint">(days)</span></span><input type="number" min={1} max={365} value={f.default_expire_days} onChange={(e) => setF({ ...f, default_expire_days: Number(e.target.value) })} /></label>
      </div>
      <p className="muted small">Emails to your recipients come from "{me.user.name} via Sign&Grow" and replies go straight to you.</p>
      <button className="btn primary" onClick={() => api('/account', { method: 'PATCH', body: f }).then(() => (toast('Saved'), me.reload())).catch(oops)}>Save</button>
    </div>
  );
}

function Team() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [d, reload] = useLoad(() => api('/account/members'));
  const [inv, setInv] = useState({ email: '', role: 'member' });
  const [remove, setRemove] = useState<any>(null);
  const [to, setTo] = useState('');
  // Admins see every API key in the account, so the Remove dialog can say which ones stop with the person.
  const [keys, reloadKeys] = useLoad(() => (admin ? api('/api-keys') : Promise.resolve(null)));
  const theirKeys: any[] = remove ? (keys?.keys || []).filter((k: any) => k.user_id === remove.id && !k.stopped_at) : [];
  const members: any[] = d?.members || [];
  const adminCount = members.filter((m) => m.role !== 'member').length;
  return (
    <div className="stack">
      {admin && members.length > 0 && adminCount < 2 && (
        <div className="notice warn">
          <b>This account depends on one person.</b> If you lose access to {me.user.email}, nobody else can manage it. Invite a second admin below so the account is never stuck behind one mailbox.
        </div>
      )}
      {admin && (
        <form className="card row wrap" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); api('/account/invites', { body: inv }).then(() => (toast('Invitation sent'), setInv({ email: '', role: 'member' }), reload())).catch(oops); }}>
          <label className="f grow" style={{ margin: 0 }}><span>Invite by email</span><input type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></label>
          <label className="f" style={{ margin: 0 }}><span>Role</span><select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <button className="btn primary">Send invite</button>
        </form>
      )}
      <div className="card pad0">
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
      <p className="muted small">Documents belong to the account, not to one login. Members see what they sent, admins see everything, and templates are shared. Everyone on the team is covered by the one plan: there is no charge per person.</p>

      {remove && (
        <Modal title={`Remove ${remove.name}`} onClose={() => setRemove(null)}>
          <p>They lose access to this account straight away. Nothing they sent is lost: their envelopes, drafts and templates pass to the person you choose, and anything still out for signature carries on.</p>
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
      <div className="card">
        <div className="row between wrap"><h2>API keys</h2><a href="/developers" target="_blank">API reference ↗</a></div>
        <p className="muted small">Included on every plan, with the same limits as the app. A key works straight away: there is no review step and no separate test environment.{admin ? ' As an admin you see every key in this account and who made it. The key itself is shown once, to the person who creates it, and never again.' : ''}</p>
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
        <div className="card">
          <h2>Webhooks</h2>
          <p className="muted small">We POST JSON to your URL when an envelope is sent, opened, signed, corrected, completed, declined, voided or expires. Check the <span className="mono">X-SignAndGrow-Signature</span> header with the signing secret. Each payload also carries a one-line <span className="mono">text</span> summary for tools that just want a message to show.</p>
          {(hooks?.webhooks || []).map((h: any) => (
            <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row between"><b className="truncate">{h.url}</b><button className="btn sm ghost danger" onClick={() => api(`/webhooks/${h.id}`, { method: 'DELETE' }).then(() => (only === h.id ? setOnly('') : reloadHooks())).catch(oops)}>Delete</button></div>
              <div className="mono muted">Secret: {h.secret}</div>
            </div>
          ))}
          <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); api('/webhooks', { body: { url } }).then(() => (setUrl(''), reloadHooks())).catch(oops); }}>
            <input placeholder="https://example.com/hooks/sign-and-grow" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Webhook URL" />
            <button className="btn">Add webhook</button>
          </form>
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
  const price = `$${P.monthlyUsd}`;
  const s = b.signatures;
  const n = (x: number) => `${x} signature${x === 1 ? '' : 's'}`;
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
    <div className="stack">
      <div className="card plan-hero">
        <Leaf size={28} color="#9ed88f" />
        <div>
          <h2 className="serif" style={{ fontSize: 22 }}>Every dollar plants {P.treesPerUsd} mangrove trees</h2>
          <p style={{ margin: '4px 0 0' }}>
            Everything you pay Sign&Grow goes to Treegens tree planting. {b.mangroves > 0 ? <>So far {me.account.name} has planted <b style={{ color: '#fff' }}>{b.mangroves.toLocaleString()} mangroves</b>. Thank you.</> : 'People who sign your documents never pay anything.'}
          </p>
        </div>
      </div>

      {done && (
        <div className="notice" role="status">
          {done.kind === 'cancel' && !done.ended_now && <><b>Cancelled. You will not be charged again.</b> The plan runs until {longDate(done.ends_at)} because that month is already paid for, and your signatures stay yours. Reference {done.reference}. We emailed you this too.</>}
          {done.kind === 'cancel' && done.ended_now && <><b>Cancelled. You will not be charged again.</b> The last payment had not gone through, so the plan ended today and that payment will not be tried again. Your signatures stay yours. Reference {done.reference}. We emailed you this too.</>}
          {done.kind === 'refund' && !done.pending && <><b>Refund sent: {done.refunded}</b> for {n(done.signatures)} you had not used. It goes back to the card you paid with. Reference {done.reference}. Banks usually show it within 5 to 10 working days.{done.plan_ended ? ' The monthly plan has ended and will not be charged again.' : ''}</>}
          {done.kind === 'refund' && done.pending && <><b>Refund of {done.refunded} requested.</b> The payment provider has not confirmed it yet. We keep checking and email you as soon as it is through; you do not need to do anything, and it cannot be paid twice. The {n(done.signatures)} have left your balance.{done.plan_ended ? ' The monthly plan has ended and will not be charged again.' : ''}</>}
          {done.kind === 'card' && (done.removed > 0 ? <><b>Card removed.</b> Nothing can be charged to it.{done.cancelled ? ' Your plan was cancelled at the same time, so it does not renew.' : ''}</> : <><b>There was no saved card or payment method to remove.</b>{done.cancelled ? ' Your plan was cancelled, so it does not renew.' : ''}</>)}
        </div>
      )}

      {s && (
        <div className="card">
          <div className="muted small" style={{ fontWeight: 600 }}>Ready to send</div>
          <div className="balance"><b className="num">{Math.max(0, s.available)}</b> signature{s.available === 1 ? '' : 's'}</div>
          <p className="plan-line" style={{ marginTop: 6 }}>
            One signature is one person signing one envelope. {s.held > 0 ? <>{s.held} more {s.held === 1 ? 'is' : 'are'} held for people who have been asked and have not signed yet. </> : ''}
            A signature is only used when somebody actually signs. If you void an envelope, or someone declines or runs out of time, the ones held for people who had not signed yet come straight back. One that was already used stays used. Signatures never expire.
          </p>
          {s.available < 0 && <div className="notice warn">You are {n(b.short)} short. {s.held > 0 ? 'More envelopes are out than you have signatures for, and people can still sign them. ' : ''}Add at least {b.short} before sending to someone new. Signing your own documents stays free.</div>}
        </div>
      )}

      <div className="card">
        <div className="row between wrap">
          <div>
            <div className="muted small" style={{ fontWeight: 600 }}>Monthly plan</div>
            <h2 style={{ fontSize: 24 }}>{free ? <>Free <s className="muted" style={{ fontSize: 16, fontWeight: 400 }}>{price} a month</s></> : <>{price} a month</>} <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>adds {n(P.monthlySignatures)} every month</span></h2>
          </div>
          {free && <span className="badge completed">Free with {b.free_with}</span>}
          {grove && !free && !b.ends_at && !b.problem && <span className="badge completed">Active</span>}
          {grove && !free && b.ends_at && !b.problem && <span className="badge expired">Ends {fmtDate(b.ends_at)}</span>}
          {!free && b.problem && <span className="badge expired">Payment failed</span>}
          {!grove && !b.problem && <span className="badge">{b.ended ? 'Ended' : 'Not started'}</span>}
        </div>

        {free && (
          <p className="plan-line" style={{ marginBottom: 0 }}>
            <b>Your plan is free with the code {b.free_with}.</b> {n(P.monthlySignatures)} are added to your balance at the start of every month at no charge{b.free_next_at ? <> (the next on {utcDate(b.free_next_at)})</> : ''}, and what you do not use rolls over. Nothing is charged for the plan, so there is nothing to cancel. Need more in a busy month? Top up below.
          </p>
        )}
        {!free && b.problem && (
          <>
            <div className="notice warn" style={{ marginBottom: 12 }}><b>The last payment did not go through.</b> Nothing is locked and nothing is deleted, and the signatures you have still work. To keep the plan, update the card. To stop it, cancel: the failed payment is then not tried again.</div>
            {admin && (
              <div className="row wrap">
                <button className="btn primary" disabled={busy} onClick={() => go('/billing/portal')}>Update the card</button>
                <button className="btn" onClick={() => setModal('cancel')}>Cancel plan</button>
              </div>
            )}
          </>
        )}
        {grove && !free && !b.ends_at && !b.problem && (
          <>
            <p className="plan-line">{b.renews_at ? <>Next charge: <b>{b.next_amount || price} on {longMoment(b.renews_at)}</b> (your bank may show it up to an hour later), which adds {n(P.monthlySignatures)} and plants {mangrovesFor(P.monthlyUsd)} mangroves. That is the whole amount. We remind you by email a week before and again about a day before, and you can cancel right up to the charge.</> : <>Billed {price} each month. We remind you by email a week before and again about a day before every charge.</>}</p>
            {admin && <div className="row wrap"><button className="btn" onClick={() => setModal('cancel')}>Cancel plan</button></div>}
          </>
        )}
        {grove && !free && b.ends_at && !b.problem && (
          <>
            <p className="plan-line"><b>Cancelled.</b> You will not be charged again. The plan runs until {longMoment(b.ends_at)}. Your signatures stay yours after that, and nothing is deleted.{b.cancel_ref ? <> Cancellation reference <b>{b.cancel_ref}</b>.</> : ''}</p>
            {admin && <button className="btn primary" disabled={busy} onClick={() => act(() => api('/billing/resume', { method: 'POST' }).then(() => toast('Welcome back. Your plan continues.')))}>Keep the plan after all</button>}
          </>
        )}
        {b.disputed && <div className="notice warn" style={{ marginBottom: 12 }}><b>A payment on this account was disputed with the bank.</b> New payments are switched off until a person has looked. If that was a mistake, <Link href="/help?topic=billing#contact">write to us</Link> and we switch them back on.</div>}
        {!grove && !b.problem && !b.disputed && (
          <>
            <p className="plan-line">{n(P.monthlySignatures)} added to your balance with every payment, {mangrovesFor(P.monthlyUsd)} mangroves planted each month. What you do not use rolls over. Need more in a busy month? Top up at ${P.topUpUsd} a signature.</p>
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
          ) : <div className="notice">{b.problem ? 'Top-ups come with the monthly plan, and the last payment for yours did not go through. Update the card above and you can top up again.' : 'Top-ups come with the monthly plan. Start the plan above and you can add signatures whenever you need them.'}</div>}
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

      <div className="card">
        <h2 style={{ marginBottom: 10 }}>The rules, all of them</h2>
        <ul className="rules">
          <li><b>{price} a month adds {n(P.monthlySignatures)}.</b> Extra signatures are ${P.topUpUsd} each. Every dollar plants {P.treesPerUsd} mangrove trees.</li>
          <li><b>Signatures never expire.</b> What you do not use this month is still there next month, and after you cancel.</li>
          <li><b>You only use one when somebody signs.</b> When an envelope is voided, declined or expires, the signatures held for people who had not signed yet come back. One that was already used stays used. Correcting a sent envelope and sending reminders are free.</li>
          <li><b>Some things are always free.</b> Signing your own documents. People who approve, view or get a copy. Everyone who signs something you send. Your first {n(P.welcomeSignatures)}.</li>
          <li><b>Nothing is charged unless you choose it.</b> When you run out, sending pauses and tells you. There are no automatic extra charges and no per-person fees.</li>
          <li><b>Month to month.</b> No yearly contract and no notice period. Cancel any time up to the minute before a charge. We remind you a week before and again about a day before, with the exact amount.</li>
          <li><b>Refunds are automatic.</b> {b.refund_rule}</li>
          {b.dormant_stop_days > 0 && <li><b>We do not charge for a plan nobody uses.</b> If nothing has been sent for {b.dormant_stop_days} days when a renewal comes up, we stop the renewal and tell you, with one click to keep it.</li>}
          <li><b>Charged after cancelling?</b> That should never happen. If it does, the software refunds it by itself, and keeps trying until the refund has gone through. The same goes for being charged twice for the plan, or more than we told you.</li>
          <li><b>A card dispute stops everything.</b> If a payment is disputed with the bank, billing stops at once, the unused signatures that payment bought go back with the money, and new payments stay off until a person has looked.</li>
          <li><b>The limits, as numbers.</b> A top-up is at most {b.limits.top_up_max} signatures, a bulk send at most {b.limits.bulk_rows} rows, and top-ups need the monthly plan. To keep scammers out, an account that has not paid anything can send to {b.limits.new_account_daily} people a day in its first week{b.limits.first_week_daily ? ' (that is you, for now)' : ''} and to {b.limits.unpaid_daily} a day after that{b.limits.unpaid_daily_now ? ' (that is you, for now)' : ''}. A payment, or a word with support, lifts both.</li>
          <li><b>Stopping never costs you your documents.</b> Cancelling or a failed payment deletes nothing and locks nothing. Export is always free.</li>
          <li><b>Locked out?</b> While a plan is renewing, every email about a payment has a link that stops it without logging in. <Link href="/help">The help page</Link> can also stop it with the card alone: the last four digits plus the date and amount of a charge.</li>
        </ul>
      </div>

      <div className="grid g2">
        <div className="card pad0">
          <div style={{ padding: '14px 16px' }}><h2>Payments</h2><div className="muted small">Kept for as long as the account exists.</div></div>
          {b.payments.length === 0 ? <div className="empty" style={{ padding: 24 }}>No payments yet.</div> : (
            <div className="tablewrap"><table className="t">
              <thead><tr><th>Date</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>{b.payments.map((p: any) => (
                <tr key={p.id}><td>{fmtDate(p.at)}</td><td>{p.label || (p.kind === 'topup' ? 'Top-up' : 'Monthly plan')}<div className="muted small">{n(p.credits)}</div></td>
                  <td className="num" style={{ textAlign: 'right' }}>{p.amount}{p.refunded && <div className="muted small">{p.refunded} refunded</div>}
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
                <tr key={i}><td>{l.label}<div className="muted small">{fmtDate(l.at, true)}</div></td><td className="num" style={{ textAlign: 'right', fontWeight: 600, color: l.delta > 0 ? 'var(--green)' : undefined }}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td></tr>
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
              <div className="row between wrap" style={{ gap: 8 }}><b>{h.label}</b><span className="muted small">{fmtDate(h.at, true)}</span></div>
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
              : <li>The plan runs until {b.renews_at ? longMoment(b.renews_at) : 'the end of the month you paid for'}, because that month is already paid for.</li>}
            <li>Your signatures stay yours. {s && s.available > 0 ? `The ${n(s.available)} you have never expire.` : 'They never expire.'}</li>
            <li>Nothing is deleted. Every document, audit trail and invoice stays in your account.</li>
          </ul>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Keep the plan</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/cancel', { method: 'POST' }); setDone({ kind: 'cancel', ...r }); setModal(''); })}>Cancel plan</button>
          </div>
        </Modal>
      )}
      {modal === 'refund' && offer && (
        <Modal title={`Refund ${offer.amount}`} onClose={() => setModal('')}>
          <p>We will send {offer.amount} back to the card you paid with, for the {n(offer.signatures)} you have not used from your payment of {longDate(offer.paid_at)}. Those signatures leave your balance.{offer.kind === 'plan' ? (free ? ' Your free plan is not affected.' : ' Because this was a monthly payment, the monthly plan ends first, today. Nothing is deleted.') : ' Your plan is not affected.'}</p>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Not now</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/refund', { body: { payment_id: offer.payment_id } }); setDone({ kind: 'refund', ...r }); setModal(''); })}>Send my refund</button>
          </div>
        </Modal>
      )}
      {modal === 'card' && (
        <Modal title="Remove your card" onClose={() => setModal('')}>
          <p>We take the card off file so nothing can be charged to it. {b.can_cancel ? 'Your plan is cancelled at the same time, so it does not renew.' : ''} Your signatures stay, and nothing is deleted.</p>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Keep the card</button>
            <button className="btn primary" disabled={busy} onClick={() => act(async () => { const r = await api('/billing/remove-card', { method: 'POST' }); setDone({ kind: 'card', ...r }); setModal(''); })}>Remove card</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function YourData() {
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
      <div className="card row between wrap">
        <div style={{ maxWidth: 600 }}>
          <h2>Take everything with you</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>One ZIP file with every signed PDF and its certificate, the full audit trail of every envelope, and a spreadsheet listing them all. Free on every plan, as often as you like, and it keeps working if you cancel.</p>
        </div>
        <a className="btn primary" href="/api/export">Export everything</a>
      </div>

      <div className="card">
        <h2>Close your account</h2>
        <p className="muted" style={{ margin: '6px 0 12px' }}>Closing is separate from cancelling a plan. If you only want to stop paying, <button className="linklike" onClick={() => window.location.assign('/app/settings?tab=billing')}>cancel the plan</button> instead and keep all your documents.</p>
        {blocked.length > 0 ? (
          <div className="notice warn">You own {blocked.map((n) => `"${n}"`).join(' and ')} and other people still use it. Make one of them the owner on the Team tab first, then you can close your own account.</div>
        ) : (
          <>
            <ul className="rules">
              <li>Any subscription stops at once. You will not be charged again.</li>
              <li><b>Nothing is deleted for 30 days.</b> If you change your mind, or closed it by mistake, sign in again and the account comes straight back.</li>
              <li>After 30 days the account{owned.length ? `, its ${owned.reduce((n, a) => n + a.envelopes, 0)} envelope(s)` : ''} and its audit trails are removed for good. Export first if you want copies.</li>
              {inFlight > 0 && <li>{inFlight} envelope(s) are still out for signature. People can keep signing during the 30 days.</li>}
              {keys.length > 0 && <li><b>{keys.length === 1 ? 'Your API key stops' : `Your ${keys.length} API keys stop`} working at once:</b> {keys.map((k) => `"${k.name}" in ${k.account}`).join(', ')}. Whatever uses {keys.length === 1 ? 'it' : 'them'} starts failing straight away, and {keys.length === 1 ? 'it works' : 'they work'} again only if you sign in within the 30 days.{keys.some((k) => k.team) ? ' The admins of a team a key belongs to are told by email.' : ''}</li>}
              <li>Documents other people sent you belong to them and are not affected.</li>
            </ul>
            <button className="btn danger" onClick={() => setOpen(true)}>Close my account</button>
          </>
        )}
      </div>

      {open && (
        <Modal title="Close your account" onClose={() => setOpen(false)}>
          <p>Enter your password to confirm it is you, {me.user.name.split(' ')[0]}.</p>
          <label className="f"><span>Password</span><input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
          <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> Delete everything right now instead of keeping it for 30 days. This cannot be undone.</label>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(false)}>Keep my account</button>
            <button className="btn primary" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy || !pw} onClick={close}>{now ? 'Delete now' : 'Close account'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const TABS: [string, string][] = [['profile', 'Profile'], ['notifications', 'Notifications'], ['account', 'Account'], ['team', 'Team'], ['billing', 'Plan'], ['data', 'Your data'], ['developers', 'API and webhooks']];

export default function Settings() {
  const [tab, setTab] = useState('profile');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('tab')) setTab(q.get('tab')!);
    if (q.get('upgraded') || q.get('topped')) {
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
    setTab(k);
    window.history.replaceState(null, '', `/app/settings?tab=${k}`);
  };
  return (
    <div>
      <div className="pagehead"><h1 className="serif">Settings</h1></div>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
      {tab === 'profile' && <Profile />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'account' && <Account />}
      {tab === 'team' && <Team />}
      {tab === 'billing' && <Billing />}
      {tab === 'data' && <YourData />}
      {tab === 'developers' && <Developers />}
    </div>
  );
}
