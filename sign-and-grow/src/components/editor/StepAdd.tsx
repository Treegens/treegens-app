'use client';
import { useState } from 'react';
import { ROLE_LABEL, Status, fmtDate } from '../ui';
import { useMe } from '../AppShell';
import { Lock } from './parts';
import { PAPER_HINT, fmtSize } from './upload';
import { acceptList, uploadLimitsShort, checkingLabel } from '@/lib/convert';
import { NUDGE, personInSentence } from '@/lib/editorux';
import { MAX_DOCS, MAX_RECIPIENTS, SIGNS, who, type Ed } from './shared';
import { LockedLine, WhoCanUse } from '../templates/WhoCanUse';
import { GroupRow, AddGroup, useGroups, isGroupRow } from './GroupRecipient';
import { WitnessChoice, signerNames } from './WitnessChoice';
// A file's row and a person's More: everything that is not a name or an address (FileRow.tsx, PersonMore.tsx).
import { FileRow } from './FileRow';
import { PersonMore, PersonSummary, morePanelId } from './PersonMore';
import { RemovedLine } from './RemovedLine';
// Writing a document here instead of uploading one (WriteDoc.tsx): one quiet link under the drop zone.
import { WriteDoc, useWriting } from './WriteDoc';
import { WRITE_LINK, WRITE_NEXT_NUDGE } from '@/lib/writedoc';

const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Has a copy', witness: 'Witnessed' };

// Step 1, "Files and people": the files and who gets them. The subject, the message, reminders and the deadline
// are on step 3, where the Send button is (research/ux-charter.md, 2.3).
export function StepAdd({ ed }: { ed: Ed }) {
  const me = useMe();
  const { env, base, isTpl, correcting, anyLocked, lockedIds, lockedNames, docs, rcps, contacts, uploads } = ed;
  // The wording of a template that is locked for this person: the documents, the roles and the message stay (tplroles.ts).
  const wording = ed.wording;
  const [over, setOver] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  // The step's one More options: signing order and groups. Closed every time the step opens.
  const [options, setOptions] = useState(false);
  const uploading = uploads.some((u) => u.state !== 'error');
  const was = (id: string) => (correcting ? base.recipients.find((r: any) => r.id === id) : null);
  // The account's signing groups: a recipient can be one of them instead of a person (editor/GroupRecipient.tsx).
  const groups = useGroups();
  const [writing, setWriting] = useWriting();

  return (
    <div className="main stack ed-narrow">
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Files</h2>
        {anyLocked && <div className="notice warn ed-lockline" style={{ marginBottom: 10 }}><Lock size={16} /><span>{lockedNames} already finished. If you add, replace, remove or reorder a file, they have to sign again. You are asked before anything is saved. Renaming a file is always fine.</span></div>}
        {wording && <LockedLine>The files come from the template{wording.template ? ` "${wording.template}"` : ''} and stay as they are. To change them, ask {wording.ask}.</LockedLine>}
        {!wording && writing && <WriteDoc ed={ed} writing={writing} onClose={() => setWriting(null)} />}
        {!wording && (
          <label className={`drop ed-drop${over ? ' over' : ''}${writing ? ' wd-hidden' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
            onDrop={(e) => (e.preventDefault(), setOver(false), ed.addFiles(e.dataTransfer.files))}>
            <input type="file" className="ed-sr" multiple accept={acceptList(!!me.converts)} onChange={(e) => (ed.addFiles(e.target.files), (e.target.value = ''))} />
            {/* A phone can neither drop nor click, so a touch screen is told what it can do: tap, and the phone offers
                its files, its photos and its camera. Only one of the two lines is shown (editor.css). */}
            <b>{uploading ? 'Uploading. You can add more.' : <><span className="ed-fine">Choose a file or drop it here</span><span className="ed-touch">Tap to choose files or take a photo</span></>}</b>
            {/* How long a large file takes on a phone is said on the row of a file that is large (FileRow.tsx). */}
            <div className="muted small" data-feature={me.converts ? 'ds-convert' : undefined}>{uploadLimitsShort(!!me.converts)}</div>
          </label>
        )}
        {!wording && !writing && !docs.length && !uploading && <p className="small" style={{ margin: '8px 0 0' }} data-feature="ds-write-doc"><button type="button" className="btn ghost sm" style={{ minHeight: 44 }} onClick={() => setWriting({})}>{WRITE_LINK}</button></p>}
        {/* Next was pressed with no file: said here, where the file goes, and gone once one is added (Editor.tsx go). */}
        {ed.nudge === 'file' && !docs.length && !uploading && <p className="notice warn small" role="alert" style={{ margin: '10px 0 0' }}>{writing ? WRITE_NEXT_NUDGE : NUDGE.file}</p>}
        <p className="muted small ed-touch" style={{ margin: '8px 0 0' }}>{PAPER_HINT}</p>

        {uploads.length > 0 && (
          <ul className="ed-uploads" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.key} className={u.state === 'error' ? 'err' : ''}>
                <div className="ed-upload-head">
                  <span className="truncate"><b>{u.name}</b> <span className="muted small">{fmtSize(u.size)}</span></span>
                  {u.state === 'error'
                    ? <button type="button" className="btn sm ghost" onClick={() => ed.dismissUpload(u.key)} aria-label={`Dismiss the message about ${u.name}`}>Dismiss</button>
                    : <span className="muted small num" aria-hidden="true">{u.state === 'waiting' ? 'Waiting' : u.state === 'preparing' ? 'Making it smaller' : u.state === 'checking' ? checkingLabel(u.name) : `${Math.round(u.progress * 100)}%`}</span>}
                </div>
                {u.state === 'error'
                  ? <div className="small" role="alert">{u.error}</div>
                  : <div className="ed-progress" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}
                      aria-valuetext={u.state === 'waiting' ? 'Waiting' : u.state === 'preparing' ? 'Making the picture smaller before it is uploaded.' : u.state === 'checking' ? `Uploaded. ${checkingLabel(u.name)}.` : `${Math.round(u.progress * 100)} percent`}>
                      <i className={u.state === 'checking' ? 'busy' : ''} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>}
              </li>
            ))}
          </ul>
        )}

        {docs.map((d, i) => <FileRow key={d.id} ed={ed} d={d} i={i} />)}
        {docs.length >= MAX_DOCS && <p className="muted small" style={{ margin: '10px 0 0' }}>One document can hold up to {MAX_DOCS} files. Remove one to add another.</p>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 12 }}>{isTpl ? 'Roles' : 'People'}</h2>
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
              <div key={r.id} className="rcpt" data-item="person" style={{ ['--fc' as any]: ed.color(r.id) }}>
                <div className="row wrap ed-person">
                  {!!env.ordered && <input type="number" min={1} max={99} value={r.routing_order} aria-label="Signing order" style={{ width: 64 }} disabled={!!wording} onChange={(e) => ed.patchRcp(r.id, { routing_order: Number(e.target.value) || 1 })} />}
                  {isTpl && <input placeholder="Role, e.g. Client" value={r.role_name || ''} aria-label="Role name" style={{ flex: '1 1 130px' }} onChange={(e) => ed.patchRcp(r.id, { role_name: e.target.value })} />}
                  {/* No name or address of the sender's for a witness the signer names (WitnessChoice.tsx, below). */}
                  {!signerNames(r) && <>
                  <input placeholder="Full name" value={r.name} aria-label="Name" data-ed-name autoComplete="off" style={{ flex: '1 1 150px' }} onChange={(e) => ed.patchRcp(r.id, { name: e.target.value })} />
                  {/* No address for someone whose link the sender sends themselves (SendMyself.tsx, in More). The box
                      is wide enough to show a whole address. */}
                  {!(r.link_by_sender && !isTpl) && <input placeholder="Email" type="email" list="contact-emails" value={r.email} aria-label="Email" autoComplete="off" className="ed-email" style={{ flex: '2 1 260px' }}
                    onChange={(e) => {
                      const c = contacts.find((x) => x.email.toLowerCase() === e.target.value.toLowerCase());
                      ed.patchRcp(r.id, { email: e.target.value, ...(c && !r.name ? { name: c.name } : {}) });
                    }} />}
                  </>}
                  {/* What this person does, how they get it, the check and their note: one More, closed until asked for. */}
                  <button type="button" className="btn sm ghost" data-more="item" onClick={() => setMore(more === r.id ? null : r.id)} aria-expanded={more === r.id} aria-controls={morePanelId(r.id)} aria-label={`More options for ${personInSentence(r)}`}>More</button>
                  {!wording && <button type="button" className="btn sm ghost danger" onClick={() => ed.removeRcp(r.id)} aria-label={`Remove ${personInSentence(r)}`}>✕</button>}
                </div>
                {more !== r.id && <PersonSummary r={r} />}
                {more === r.id && <PersonMore ed={ed} r={r} />}
                <WitnessChoice r={r} rcps={rcps} isTpl={isTpl} onChange={(p) => ed.patchRcp(r.id, p)} />
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
        <RemovedLine ed={ed} />
        {/* Next was pressed with nobody typed in: said here, and gone once somebody is (Editor.tsx go). */}
        {ed.nudge === 'person' && !isTpl && rcps.every((r) => ed.isIdle(r)) && <p className="notice warn small" role="alert" style={{ margin: '10px 0 0' }}>{NUDGE.person}</p>}
        {!wording && <div className="row wrap" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={rcps.length >= MAX_RECIPIENTS} onClick={() => ed.addRcp()}>Add another {isTpl ? 'role' : 'person'}</button>
          {!isTpl && rcps.length < MAX_RECIPIENTS && !rcps.some((r) => r.email.toLowerCase() === me.user.email.toLowerCase()) && <button type="button" className="btn ghost" onClick={() => ed.addMe()}>Add me</button>}
          {rcps.length >= MAX_RECIPIENTS && <span className="muted small">One document can go to up to {MAX_RECIPIENTS} people.</span>}
          <span className="grow" />
          {/* The step's one More options: what few documents need (research/ux-charter.md, P4). */}
          <button type="button" className="btn ghost" data-more="screen" aria-expanded={options} aria-controls="ed-step1-more" onClick={() => setOptions(!options)}>More options</button>
        </div>}
        {options && !wording && (
          <div id="ed-step1-more" className="ed-more" role="group" aria-label="More options for this step">
            <label className="check ed-tap"><input type="checkbox" checked={!!env.ordered} onChange={(e) => ed.patchEnv({ ordered: e.target.checked ? 1 : 0 })} /> <span>Set signing order<span className="muted">: number who goes first. Without it everyone gets the document at the same time.</span></span></label>
            <AddGroup ed={ed} groups={groups} />
          </div>
        )}
        {!isTpl && rcps.length > 0 && !rcps.some(SIGNS) && <p className="muted small" style={{ margin: '10px 0 0' }}>Nobody signs yet. Fields can only be placed for people who sign.</p>}
      </div>

      {/* Who can use and change this template, and its lock: said in a sentence, changed by its owner and admins. */}
      {isTpl && <WhoCanUse templateId={env.id} name={env.subject || 'Untitled template'} access={env.access} />}
    </div>
  );
}
