'use client';
import { useState } from 'react';
import { ROLE_LABEL, Status, fmtDate } from '../ui';
import { useMe } from '../AppShell';
import { DATE_FORMATS, DATE_FORMAT_CHOICES, formatDate, deviceZone, momentText } from '@/lib/dates';
import { scanWarning } from '@/lib/scans';
import { phoneWeight } from '@/lib/phone';
import { Lock } from './parts';
import { CheckFields } from '../sender/CheckFields';
import { SendMyself } from './SendMyself';
import { LIMITS, PAPER_HINT, fmtSize } from './upload';
import { MAX_DOCS, MAX_RECIPIENTS, SIGNS, who, plural, type Ed } from './shared';
import { LockedLine, WhoCanUse } from '../templates/WhoCanUse';
import { GroupRow, AddGroup, useGroups, isGroupRow } from './GroupRecipient';

const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Has a copy' };

// Step 1: the documents, who gets them, and the message that goes with them.
export function StepAdd({ ed }: { ed: Ed }) {
  const me = useMe();
  const { env, base, isTpl, correcting, anyLocked, lockedIds, lockedNames, docs, rcps, contacts, uploads } = ed;
  // The wording of a template that is locked for this person: the documents, the roles and the message stay (tplroles.ts).
  const wording = ed.wording;
  const [over, setOver] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const uploading = uploads.some((u) => u.state !== 'error');
  const format = env.date_format || DATE_FORMATS[0];
  const today = new Date();
  // The example shows today's date where the sender is, which is how a signer's own day is found as well.
  const zone = deviceZone();
  const was = (id: string) => (correcting ? base.recipients.find((r: any) => r.id === id) : null);
  // The account's signing groups: a recipient can be one of them instead of a person (editor/GroupRecipient.tsx).
  const groups = useGroups();

  return (
    <div className="main stack ed-narrow">
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Documents</h2>
        {anyLocked && <div className="notice warn ed-lockline" style={{ marginBottom: 10 }}><Lock size={16} /><span>{lockedNames} already finished. If you add, replace, remove or reorder a document, they have to sign again. You are asked before anything is saved. Renaming a document is always fine.</span></div>}
        {wording && <LockedLine>The documents come from the template{wording.template ? ` "${wording.template}"` : ''} and stay as they are. To change them, ask {wording.ask}.</LockedLine>}
        {!wording && (
          <label className={`drop ed-drop${over ? ' over' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
            onDrop={(e) => (e.preventDefault(), setOver(false), ed.addFiles(e.dataTransfer.files))}>
            <input type="file" className="ed-sr" multiple accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" onChange={(e) => (ed.addFiles(e.target.files), (e.target.value = ''))} />
            {/* A phone can neither drop nor click, so a touch screen is told what it can do: tap, and the phone offers
                its files, its photos and its camera. Only one of the two lines is shown (editor.css). */}
            <b>{uploading ? 'Uploading. You can add more.' : <><span className="ed-fine">Drop files here or click to choose them</span><span className="ed-touch">Tap to choose files or take a photo</span></>}</b>
            <div className="muted small">{LIMITS}</div>
          </label>
        )}
        <p className="muted small ed-touch" style={{ margin: '8px 0 0' }}>{PAPER_HINT}</p>

        {uploads.length > 0 && (
          <ul className="ed-uploads" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.key} className={u.state === 'error' ? 'err' : ''}>
                <div className="ed-upload-head">
                  <span className="truncate"><b>{u.name}</b> <span className="muted small">{fmtSize(u.size)}</span></span>
                  {u.state === 'error'
                    ? <button type="button" className="btn sm ghost" onClick={() => ed.dismissUpload(u.key)} aria-label={`Dismiss the message about ${u.name}`}>Dismiss</button>
                    : <span className="muted small num" aria-hidden="true">{u.state === 'waiting' ? 'Waiting' : u.state === 'preparing' ? 'Making it smaller' : u.state === 'checking' ? 'Checking the pages' : `${Math.round(u.progress * 100)}%`}</span>}
                </div>
                {u.state === 'error'
                  ? <div className="small" role="alert">{u.error}</div>
                  : <div className="ed-progress" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}
                      aria-valuetext={u.state === 'waiting' ? 'Waiting' : u.state === 'preparing' ? 'Making the picture smaller before it is uploaded.' : u.state === 'checking' ? 'Uploaded. Checking the pages.' : `${Math.round(u.progress * 100)} percent`}>
                      <i className={u.state === 'checking' ? 'busy' : ''} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>}
              </li>
            ))}
          </ul>
        )}

        {docs.map((d, i) => (
          <div key={d.id}>
          <div className="row ed-doc">
            <input value={d.name} aria-label="Document name" maxLength={200} readOnly={!!wording} onChange={(e) => ed.renameDoc(d.id, e.target.value)} />
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{plural(d.pages, 'page')}</span>
            {!wording && (
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
          {phoneWeight(d) && <p className="notice warn small" style={{ margin: '6px 0 0' }}>{phoneWeight(d)}</p>}
          </div>
        ))}
        {docs.length >= MAX_DOCS && <p className="muted small" style={{ margin: '10px 0 0' }}>An envelope can hold up to {MAX_DOCS} documents. Remove one to add another.</p>}
      </div>

      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <h2>{isTpl ? 'Roles' : 'Recipients'}</h2>
          <label className="check ed-tap"><input type="checkbox" checked={!!env.ordered} disabled={!!wording} onChange={(e) => ed.patchEnv({ ordered: e.target.checked ? 1 : 0 })} /> Set signing order</label>
        </div>
        {isTpl && <p className="muted small">Leave name and email empty for roles you fill in each time you use the template.</p>}
        {wording && <LockedLine>Fill in each person&rsquo;s name and email address. Who signs, what each person does and the order come from the template and stay as they are.</LockedLine>}
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
                  <div className="muted small ed-break" style={{ marginTop: 4 }}>{r.email || (r.link_by_sender ? 'You send their link yourself' : '')} · {ROLE_LABEL[r.role]}</div>
                  <div className="muted small ed-lockline" style={{ marginTop: 6 }}><Lock /><span>Finished{old?.completed_at ? ` on ${fmtDate(old.completed_at)}` : ''}. Their details and their own fields stay as they are.</span></div>
                </div>
              );
            if (isGroupRow(r)) return <GroupRow key={r.id} ed={ed} r={r} groups={groups} old={old} />;
            return (
              <div key={r.id} className="rcpt" style={{ ['--fc' as any]: ed.color(r.id) }}>
                <div className="row wrap">
                  {!!env.ordered && <input type="number" min={1} max={99} value={r.routing_order} aria-label="Signing order" style={{ width: 64 }} disabled={!!wording} onChange={(e) => ed.patchRcp(r.id, { routing_order: Number(e.target.value) || 1 })} />}
                  {isTpl && <input placeholder="Role, e.g. Client" value={r.role_name || ''} aria-label="Role name" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { role_name: e.target.value })} />}
                  <input placeholder="Full name" value={r.name} aria-label="Recipient name" autoComplete="off" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { name: e.target.value })} />
                  {/* No address for someone whose link the sender sends themselves (SendMyself.tsx, below). */}
                  {!(r.link_by_sender && !isTpl) && <input placeholder="Email" type="email" list="contact-emails" value={r.email} aria-label="Recipient email" autoComplete="off" style={{ flex: '1 1 170px' }}
                    onChange={(e) => {
                      const c = contacts.find((x) => x.email.toLowerCase() === e.target.value.toLowerCase());
                      ed.patchRcp(r.id, { email: e.target.value, ...(c && !r.name ? { name: c.name } : {}) });
                    }} />}
                  <select value={r.role} aria-label="Role" style={{ flex: '0 1 170px' }} disabled={!!wording} onChange={(e) => ed.patchRcp(r.id, { role: e.target.value })}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button type="button" className="btn sm ghost" onClick={() => setMore(more === r.id ? null : r.id)} aria-expanded={more === r.id} aria-label={`More options for ${who(r)}`}>More</button>
                  {!wording && <button type="button" className="btn sm ghost danger" onClick={() => ed.removeRcp(r.id)} aria-label={`Remove ${who(r)}`}>✕</button>}
                </div>
                <SendMyself r={r} isTpl={isTpl} onChange={(p) => ed.patchRcp(r.id, p)} />
                {more === r.id && (
                  <div className="grid g2" style={{ marginTop: 10 }}>
                    <label className="f" style={{ margin: 0 }}><span>Access code <span className="hint">(at least 4 characters, share it with them yourself)</span></span><input value={r.access_code || ''} maxLength={50} onChange={(e) => ed.patchRcp(r.id, { access_code: e.target.value })} /></label>
                    <label className="f" style={{ margin: 0 }}><span>Private note <span className="hint">(only they see it)</span></span><input value={r.note || ''} maxLength={1000} onChange={(e) => ed.patchRcp(r.id, { note: e.target.value })} /></label>
                  </div>
                )}
                {/* A one-time code before the document opens, and the signing link by text message: only what this
                    server can do is offered (me.text_messages says whether its operator switched texts on). */}
                {more === r.id && <CheckFields value={r} role={r.role} textsOn={!!me.text_messages} open={isTpl && !r.email} onChange={(p) => ed.patchRcp(r.id, p)} />}
                {r.role === 'inperson' && <div className="muted small" style={{ marginTop: 6 }}>You host the signing on your own device. The link is emailed to you. While they hold the device your account is locked in that browser, and you type your password to come back.</div>}
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
        {!wording && <div className="row wrap" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={rcps.length >= MAX_RECIPIENTS} onClick={() => ed.addRcp()}>Add {isTpl ? 'role' : 'recipient'}</button>
          {!isTpl && rcps.length < MAX_RECIPIENTS && !rcps.some((r) => r.email.toLowerCase() === me.user.email.toLowerCase()) && <button type="button" className="btn ghost" onClick={() => ed.addRcp({ name: me.user.name, email: me.user.email })}>Add myself</button>}
          <AddGroup ed={ed} groups={groups} />
          {rcps.length >= MAX_RECIPIENTS && <span className="muted small">An envelope can have up to {MAX_RECIPIENTS} recipients.</span>}
        </div>}
        {!isTpl && rcps.length > 0 && !rcps.some(SIGNS) && <p className="muted small" style={{ margin: '10px 0 0' }}>Nobody signs yet. Fields can only be placed for people who sign.</p>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>{isTpl ? 'Template details' : 'Message'}</h2>
        <label className="f"><span>{isTpl ? 'Template name and email subject' : 'Email subject'}</span><input value={env.subject} maxLength={200} onChange={(e) => ed.patchEnv({ subject: e.target.value })} /></label>
        <label className="f"><span>Message <span className="hint">{wording ? '(from the template, locked)' : '(optional)'}</span></span><textarea value={env.message} maxLength={5000} readOnly={!!wording} onChange={(e) => ed.patchEnv({ message: e.target.value })} /></label>
        <div className="grid g2">
          <label className="f"><span>Remind every <span className="hint">(days, 0 for never)</span></span><input type="number" inputMode="numeric" min={0} max={60} value={env.reminder_days} onChange={(e) => ed.patchEnv({ reminder_days: Number(e.target.value) })} /></label>
          {correcting
            ? <div className="f ed-static"><span>Deadline</span><div className="muted">{env.expires_at ? `Closes on ${momentText(env.expires_at, zone)}. ` : ''}To give people more time, use the envelope page after you save.</div></div>
            : <label className="f"><span>Expires after <span className="hint">(days)</span></span><input type="number" inputMode="numeric" min={1} max={365} value={env.expire_days} onChange={(e) => ed.patchEnv({ expire_days: Number(e.target.value) })} /></label>}
          <div>
            <label className="f" style={{ marginBottom: 6 }}><span>Date format <span className="hint">(for dates stamped on the document)</span></span>
              <select value={format} disabled={anyLocked} aria-describedby="ed-date-example" onChange={(e) => ed.patchEnv({ date_format: e.target.value })}>
                {DATE_FORMAT_CHOICES.map((f) => <option key={f} value={f}>{formatDate(today, f, zone)} ({f})</option>)}
              </select>
            </label>
            <div id="ed-date-example" className="muted small" aria-live="polite">
              {anyLocked ? `Dates are written like ${formatDate(today, format, zone)}. That is fixed, because ${lockedNames} already finished.`
                : <>Every date on the document is written like <b style={{ color: 'var(--ink)' }}>{formatDate(today, format, zone)}</b>: the date each person signs on, and any date they pick in a date field. The date of signing is the calendar day where that person is, by the time zone of their device. The certificate gives the exact time in UTC as well. The format is never changed to another one.</>}
            </div>
          </div>
        </div>
      </div>
      {/* Who can use and change this template, and its lock: said in a sentence, changed by its owner and admins. */}
      {isTpl && <WhoCanUse templateId={env.id} name={env.subject || 'Untitled template'} access={env.access} />}
    </div>
  );
}
