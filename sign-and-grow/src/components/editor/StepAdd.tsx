'use client';
import { useState } from 'react';
import { ROLE_LABEL, Status, fmtDate } from '../ui';
import { useMe } from '../AppShell';
import { DATE_FORMATS, formatDate } from '@/lib/dates';
import { scanWarning } from '@/lib/scans';
import { Lock } from './parts';
import { LIMITS, fmtSize } from './upload';
import { MAX_DOCS, MAX_RECIPIENTS, SIGNS, who, plural, type Ed } from './shared';

const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Has a copy' };

// Step 1: the documents, who gets them, and the message that goes with them.
export function StepAdd({ ed }: { ed: Ed }) {
  const me = useMe();
  const { env, base, isTpl, correcting, anyLocked, lockedIds, lockedNames, docs, rcps, contacts, uploads } = ed;
  const [over, setOver] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const uploading = uploads.some((u) => u.state !== 'error');
  const format = env.date_format || DATE_FORMATS[0];
  const today = new Date();
  const was = (id: string) => (correcting ? base.recipients.find((r: any) => r.id === id) : null);

  return (
    <div className="main stack ed-narrow">
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Documents</h2>
        {anyLocked && <div className="notice warn ed-lockline" style={{ marginBottom: 10 }}><Lock size={16} /><span>{lockedNames} already finished. If you add, replace, remove or reorder a document, they have to sign again. You are asked before anything is saved. Renaming a document is always fine.</span></div>}
        {(
          <label className={`drop ed-drop${over ? ' over' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
            onDrop={(e) => (e.preventDefault(), setOver(false), ed.addFiles(e.dataTransfer.files))}>
            <input type="file" className="ed-sr" multiple accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" onChange={(e) => (ed.addFiles(e.target.files), (e.target.value = ''))} />
            <b>{uploading ? 'Uploading. You can add more.' : 'Drop files here or click to upload'}</b>
            <div className="muted small">{LIMITS}</div>
          </label>
        )}

        {uploads.length > 0 && (
          <ul className="ed-uploads" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.key} className={u.state === 'error' ? 'err' : ''}>
                <div className="ed-upload-head">
                  <span className="truncate"><b>{u.name}</b> <span className="muted small">{fmtSize(u.size)}</span></span>
                  {u.state === 'error'
                    ? <button type="button" className="btn sm ghost" onClick={() => ed.dismissUpload(u.key)} aria-label={`Dismiss the message about ${u.name}`}>Dismiss</button>
                    : <span className="muted small num" aria-hidden="true">{u.state === 'waiting' ? 'Waiting' : u.state === 'checking' ? 'Checking the pages' : `${Math.round(u.progress * 100)}%`}</span>}
                </div>
                {u.state === 'error'
                  ? <div className="small" role="alert">{u.error}</div>
                  : <div className="ed-progress" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}
                      aria-valuetext={u.state === 'waiting' ? 'Waiting' : u.state === 'checking' ? 'Uploaded. Checking the pages.' : `${Math.round(u.progress * 100)} percent`}>
                      <i className={u.state === 'checking' ? 'busy' : ''} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>}
              </li>
            ))}
          </ul>
        )}

        {docs.map((d, i) => (
          <div key={d.id}>
          <div className="row ed-doc">
            <input value={d.name} aria-label="Document name" maxLength={200} onChange={(e) => ed.renameDoc(d.id, e.target.value)} />
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{plural(d.pages, 'page')}</span>
            {(
              <>
                <label className="btn sm ghost" title="Swap in a corrected version. Your fields stay where they are.">
                  Replace file
                  <input type="file" className="ed-sr" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" aria-label={`Replace the file for ${d.name || 'this document'}`} onChange={(e) => (ed.replaceDoc(d.id, e.target.files?.[0]), (e.target.value = ''))} />
                </label>
                <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => ed.moveDoc(i, -1)} aria-label={`Move ${d.name || 'document'} up`}>↑</button>
                <button type="button" className="btn sm ghost" disabled={i === docs.length - 1} onClick={() => ed.moveDoc(i, 1)} aria-label={`Move ${d.name || 'document'} down`}>↓</button>
                <button type="button" className="btn sm ghost danger" onClick={() => ed.removeDoc(d.id)} aria-label={`Remove ${d.name || 'document'}`}>Remove</button>
              </>
            )}
          </div>
          {/* The server keeps which pages are pictures with the file, so this is also said when a draft is opened again. */}
          {scanWarning(d) && <p className="notice warn small" style={{ margin: '6px 0 0' }}>{scanWarning(d)}</p>}
          </div>
        ))}
        {docs.length >= MAX_DOCS && <p className="muted small" style={{ margin: '10px 0 0' }}>An envelope can hold up to {MAX_DOCS} documents. Remove one to add another.</p>}
      </div>

      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <h2>{isTpl ? 'Roles' : 'Recipients'}</h2>
          <label className="check ed-tap"><input type="checkbox" checked={!!env.ordered} onChange={(e) => ed.patchEnv({ ordered: e.target.checked ? 1 : 0 })} /> Set signing order</label>
        </div>
        {isTpl && <p className="muted small">Leave name and email empty for roles you fill in each time you use the template.</p>}
        <datalist id="contact-emails">{contacts.map((c) => <option key={c.id} value={c.email}>{c.name}</option>)}</datalist>
        <div style={{ display: 'grid', gap: 10 }}>
          {rcps.map((r) => {
            const old = was(r.id);
            if (lockedIds.has(r.id))
              return (
                <div key={r.id} className="rcpt ed-locked" style={{ ['--fc' as any]: ed.color(r.id) }}>
                  <div className="row wrap" style={{ gap: 8, rowGap: 4 }}>
                    {!!env.ordered && <span className="badge num" aria-label={`Signing order ${r.routing_order}`}>{r.routing_order}</span>}
                    <b className="ed-break">{who(r)}</b>
                    <Status s="completed" label={DONE[r.role] || 'Finished'} />
                  </div>
                  <div className="muted small ed-break" style={{ marginTop: 4 }}>{r.email} · {ROLE_LABEL[r.role]}</div>
                  <div className="muted small ed-lockline" style={{ marginTop: 6 }}><Lock /><span>Finished{old?.completed_at ? ` on ${fmtDate(old.completed_at)}` : ''}. Their details and their own fields stay as they are.</span></div>
                </div>
              );
            return (
              <div key={r.id} className="rcpt" style={{ ['--fc' as any]: ed.color(r.id) }}>
                <div className="row wrap">
                  {!!env.ordered && <input type="number" min={1} max={99} value={r.routing_order} aria-label="Signing order" style={{ width: 64 }} onChange={(e) => ed.patchRcp(r.id, { routing_order: Number(e.target.value) || 1 })} />}
                  {isTpl && <input placeholder="Role, e.g. Client" value={r.role_name || ''} aria-label="Role name" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { role_name: e.target.value })} />}
                  <input placeholder="Full name" value={r.name} aria-label="Recipient name" autoComplete="off" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { name: e.target.value })} />
                  <input placeholder="Email" type="email" list="contact-emails" value={r.email} aria-label="Recipient email" autoComplete="off" style={{ flex: '1 1 170px' }}
                    onChange={(e) => {
                      const c = contacts.find((x) => x.email.toLowerCase() === e.target.value.toLowerCase());
                      ed.patchRcp(r.id, { email: e.target.value, ...(c && !r.name ? { name: c.name } : {}) });
                    }} />
                  <select value={r.role} aria-label="Role" style={{ flex: '0 1 170px' }} onChange={(e) => ed.patchRcp(r.id, { role: e.target.value })}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button type="button" className="btn sm ghost" onClick={() => setMore(more === r.id ? null : r.id)} aria-expanded={more === r.id} aria-label={`More options for ${who(r)}`}>More</button>
                  <button type="button" className="btn sm ghost danger" onClick={() => ed.removeRcp(r.id)} aria-label={`Remove ${who(r)}`}>✕</button>
                </div>
                {more === r.id && (
                  <div className="grid g2" style={{ marginTop: 10 }}>
                    <label className="f" style={{ margin: 0 }}><span>Access code <span className="hint">(at least 4 characters, share it with them yourself)</span></span><input value={r.access_code || ''} maxLength={50} onChange={(e) => ed.patchRcp(r.id, { access_code: e.target.value })} /></label>
                    <label className="f" style={{ margin: 0 }}><span>Private note <span className="hint">(only they see it)</span></span><input value={r.note || ''} maxLength={1000} onChange={(e) => ed.patchRcp(r.id, { note: e.target.value })} /></label>
                  </div>
                )}
                {r.role === 'inperson' && <div className="muted small" style={{ marginTop: 6 }}>You host the signing on your own device. The link is emailed to you.</div>}
                {correcting && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {!old ? 'New. They are invited when you save, or when it is their turn.'
                      : old.status === 'pending' ? 'Has not been asked yet.'
                      : old.status === 'completed' ? 'Already has their copy.'
                      : `Has the document now${old.status === 'viewed' ? ' and has opened it' : ''}. If you change their email or role they get a new link.`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={rcps.length >= MAX_RECIPIENTS} onClick={() => ed.addRcp()}>Add {isTpl ? 'role' : 'recipient'}</button>
          {!isTpl && rcps.length < MAX_RECIPIENTS && !rcps.some((r) => r.email.toLowerCase() === me.user.email.toLowerCase()) && <button type="button" className="btn ghost" onClick={() => ed.addRcp({ name: me.user.name, email: me.user.email })}>Add myself</button>}
          {rcps.length >= MAX_RECIPIENTS && <span className="muted small">An envelope can have up to {MAX_RECIPIENTS} recipients.</span>}
        </div>
        {!isTpl && rcps.length > 0 && !rcps.some(SIGNS) && <p className="muted small" style={{ margin: '10px 0 0' }}>Nobody signs yet. Fields can only be placed for people who sign.</p>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>{isTpl ? 'Template details' : 'Message'}</h2>
        <label className="f"><span>{isTpl ? 'Template name and email subject' : 'Email subject'}</span><input value={env.subject} maxLength={200} onChange={(e) => ed.patchEnv({ subject: e.target.value })} /></label>
        <label className="f"><span>Message <span className="hint">(optional)</span></span><textarea value={env.message} maxLength={5000} onChange={(e) => ed.patchEnv({ message: e.target.value })} /></label>
        <div className="grid g2">
          <label className="f"><span>Remind every <span className="hint">(days, 0 for never)</span></span><input type="number" inputMode="numeric" min={0} max={60} value={env.reminder_days} onChange={(e) => ed.patchEnv({ reminder_days: Number(e.target.value) })} /></label>
          {correcting
            ? <div className="f ed-static"><span>Deadline</span><div className="muted">{env.expires_at ? `Closes on ${fmtDate(env.expires_at)}. ` : ''}To give people more time, use the envelope page after you save.</div></div>
            : <label className="f"><span>Expires after <span className="hint">(days)</span></span><input type="number" inputMode="numeric" min={1} max={365} value={env.expire_days} onChange={(e) => ed.patchEnv({ expire_days: Number(e.target.value) })} /></label>}
          <div>
            <label className="f" style={{ marginBottom: 6 }}><span>Date format <span className="hint">(for dates stamped on the document)</span></span>
              <select value={format} disabled={anyLocked} aria-describedby="ed-date-example" onChange={(e) => ed.patchEnv({ date_format: e.target.value })}>
                {DATE_FORMATS.map((f) => <option key={f} value={f}>{formatDate(today, f)} ({f})</option>)}
              </select>
            </label>
            <div id="ed-date-example" className="muted small" aria-live="polite">
              {anyLocked ? `Dates are written like ${formatDate(today, format)}. That is fixed, because ${lockedNames} already finished.` : <>A date signed today is written as <b style={{ color: 'var(--ink)' }}>{formatDate(today, format)}</b>. It is never changed to another format.</>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
