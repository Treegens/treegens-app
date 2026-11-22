'use client';
import { documentsIntro, countLine } from '@/lib/simplicity';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { BroughtInLink } from '@/components/settings/BroughtInLink';
import { Dialog } from '@/components/sender/Dialog';
// Working for a colleague: a shared row offers only what its share allows; several chosen can move to a colleague.
import { MoveDialog as MoveToColleague } from '@/components/sender/Colleagues';
import { levelCovers, sharedRowLabel, MOVE_LABEL } from '@/lib/shares';
import { fail } from '@/components/sender/feedback';
import { cap, exportUrl, howLong, joinNames, neverOpened, waitingOn } from '@/components/sender/lib';
import { remindedText } from '@/components/sender/MailNews';
import { listName } from '@/lib/docname';
import { mayDo } from '@/lib/perm';
// Send later, a pause and a wait before a person, said in the row (sender/Timing.tsx).
import { timingRow } from '@/components/sender/Timing';
// A custom field to filter by and to show as a column (sender/CustomFieldFilter.tsx).
import { CustomFieldFilter, customValue } from '@/components/sender/CustomFieldFilter';

const BOXES: [string, string][] = [['all', 'All'], ['drafts', 'Drafts'], ['waiting', 'Waiting'], ['completed', 'Completed'], ['closed', 'Stopped']];
// For admins only: what a sender deleted from their own lists after somebody had signed. It is in no other tab, and
// it is not remembered as the last tab, so nobody lands in it by accident.
const REMOVED = 'removed';
const STORE = 'sg.envelopes.view';
const PAGE = 200;

// Why a closed envelope is closed, from what the list already knows.
function closedWhy(e: any): string {
  const acting = e.recipients.filter((r: any) => r.role !== 'cc');
  if (e.status === 'declined') return `${joinNames(acting.filter((r: any) => r.status === 'declined').map((r: any) => r.name)) || 'Someone'} declined`;
  if (e.status === 'expired') return `Closed before ${joinNames(acting.filter((r: any) => r.status !== 'completed').map((r: any) => r.name)) || 'everyone'} finished`;
  if (e.status === 'voided') return 'Nobody. It was cancelled';
  return 'Nobody right now';
}

type View = { box: string; q: string; folder: string; sender: string; field: string; value: string; col: string };
const START: View = { box: 'all', q: '', folder: '', sender: '', field: '', value: '', col: '' };

// The last tab and search are remembered, so opening an envelope and coming back does not lose your place.
function restore(): View {
  let saved: Partial<View> = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
  } catch {
    /* storage can be unavailable */
  }
  const v: View = { ...START, ...Object.fromEntries(Object.entries(saved).filter(([k, x]) => k in START && typeof x === 'string')) };
  // A link such as /app/envelopes?box=waiting wins over what was remembered.
  const url = new URLSearchParams(window.location.search);
  const box = url.get('box');
  if (box && BOXES.some(([k]) => k === box)) Object.assign(v, { box, q: url.get('q') || '', folder: '', sender: '' });
  else if (url.get('q')) v.q = url.get('q') || '';
  // From Settings, Away and sharing: the documents one colleague shares (src/components/settings/Shares.tsx).
  if (url.get('sender')) Object.assign(v, { box: 'all', sender: url.get('sender') || '', folder: '' });
  if (!BOXES.some(([k]) => k === v.box)) v.box = 'all';
  return v;
}

export default function Envelopes() {
  const router = useRouter();
  const me = useMe();
  const [view, setView] = useState<View | null>(null);
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<any>(null);
  const [handing, setHanding] = useState(false);
  const [busy, setBusy] = useState('');

  // Read once: an effect that runs twice (development) must not lose a link's ?sender= or ?box= on its second run.
  const restored = useRef<View | null>(null);
  useEffect(() => {
    const v = (restored.current ??= restore());
    setView(v);
    setTyped(v.q);
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (!view) return;
    try {
      localStorage.setItem(STORE, JSON.stringify(view));
    } catch {
      /* storage can be unavailable */
    }
  }, [view]);
  useEffect(() => {
    const t = setTimeout(() => setView((v) => (v && v.q !== typed.trim() ? { ...v, q: typed.trim() } : v)), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const change = (patch: Partial<View>) => (setView((v) => ({ ...(v || START), ...patch })), setPicked(new Set()));
  const [data, reload, error] = useLoad<any>(
    () => (view ? api(`/envelopes?box=${view.box}&q=${encodeURIComponent(view.q)}&folder=${encodeURIComponent(view.folder)}&sender=${encodeURIComponent(view.sender)}&field=${encodeURIComponent(view.field)}&value=${encodeURIComponent(view.value)}&limit=${PAGE}`) : Promise.resolve(null)),
    [view?.box, view?.q, view?.folder, view?.sender, view?.field, view?.value],
  );

  // A remembered folder or sender that no longer exists would hide everything with no way to see why.
  useEffect(() => {
    if (!data || !view) return;
    if (view.folder && !data.folders.includes(view.folder)) change({ folder: '' });
    else if (view.sender && !data.senders.some((s: any) => s.id === view.sender)) change({ sender: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows: any[] = data?.envelopes || [];
  // What was removed by its sender is not in the export, so there is nothing to tick there.
  const pickable = useMemo(() => (view?.box === REMOVED ? [] : rows.filter((e) => e.status !== 'draft' && !e.shared_level).map((e) => e.id as string)), [rows, view?.box]);
  const chosen = pickable.filter((id) => picked.has(id));
  const allPicked = pickable.length > 0 && chosen.length === pickable.length;
  const filtered = !!view && (view.q !== '' || view.folder !== '' || view.sender !== '' || view.box !== 'all' || view.field !== '');
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  async function remind(e: any) {
    setBusy(e.id);
    try {
      const { reminded, not_reminded } = await api(`/envelopes/${e.id}/remind`, { method: 'POST' });
      if (reminded || not_reminded?.length) {
        const said = remindedText(reminded, not_reminded, 'Open the document to see what to do.');
        toast(said.text, said.bad);
      } else toast('No reminder went out. They turned reminders off. Open the document to share the link another way.', true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }

  async function exportAll() {
    setBusy('export');
    try {
      // Look before downloading, so an empty account gets a sentence instead of a broken file.
      const any = await api('/envelopes?box=sent&limit=1');
      if (!any.envelopes.length) return toast('There is nothing to export yet. Envelopes are included once they have been sent.');
      toast('Your export is being put together. The download starts in a moment.');
      window.location.href = exportUrl();
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }

  const open = (e: any) => (e.status === 'draft' ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`);
  const isAdmin = me.role !== 'member';
  // Documents brought in hold every document of the account: a made role without "See every document" has no link to them.
  const seesBroughtIn = isAdmin && mayDo(me, 'see_all');
  const inRemoved = view?.box === REMOVED;

  async function putBack(e: any) {
    setBusy(e.id);
    try {
      await api(`/envelopes/${e.id}/restore`, { method: 'POST' });
      toast(`Put back. "${e.subject || 'Untitled'}" is in the lists, the search, the export and the reports again.`);
      reload();
    } catch (err) {
      fail(err, 'Nothing was changed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="sn">
      <div className="pagehead">
        <div>
          <h1 className="serif">Documents</h1>
          <div className="muted small" id="sn-export-note">{documentsIntro(!!isAdmin)}</div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={exportAll} disabled={busy === 'export'} aria-describedby="sn-export-note">{busy === 'export' ? 'Preparing…' : 'Download signed PDFs (ZIP)'}</button>
        </div>
      </div>

      <div className="tabs" role="group" aria-label="Show">
        {BOXES.map(([k, l]) => <button key={k} className={view?.box === k ? 'on' : ''} aria-pressed={view?.box === k} onClick={() => change({ box: k })}>{l}</button>)}
        {isAdmin && (inRemoved || data?.removed > 0) && <button className={inRemoved ? 'on' : ''} aria-pressed={inRemoved} onClick={() => change({ box: REMOVED })}>Removed by its sender{data?.removed > 0 ? ` (${data.removed})` : ''}</button>}
      </div>
      {inRemoved && <p className="notice sn-inset" role="note">These documents were deleted by their sender after somebody had signed. They are in no other tab, search, export or report, and everyone who was on them still has their link and their copy. As an admin you can open each one and put it back.</p>}

      <div className="sn-filters">
        <div className="sn-search">
          <input type="search" placeholder="Search subject, people, document text or ID" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search documents" />
          {typed && <button className="btn sm ghost" onClick={() => (setTyped(''), change({ q: '' }))}>Clear</button>}
        </div>
        {data && data.folders.length > 0 && (
          <select value={view?.folder || ''} onChange={(e) => change({ folder: e.target.value })} aria-label="Folder">
            <option value="">All folders</option>{data.folders.map((f: string) => <option key={f}>{f}</option>)}
          </select>
        )}
        {data && data.senders.length > 1 && (
          <select value={view?.sender || ''} onChange={(e) => change({ sender: e.target.value })} aria-label="Sent by">
            <option value="">Sent by anyone</option>{data.senders.map((s: any) => <option key={s.id} value={s.id}>{s.id === me.user.id ? 'Sent by me' : s.shared ? `Shared with me by ${s.name}` : `Sent by ${s.name}`}</option>)}
          </select>
        )}
        {view && <CustomFieldFilter view={view} onChange={change} />}
      </div>

      <div className="sn-selbar" aria-live="polite">
        {chosen.length > 0 ? (
          <>
            <b>{chosen.length} selected</b>
            <a className="btn sm primary" href={exportUrl(chosen)}>Download selected (ZIP)</a>
            {Number(me.members) >= 2 && <button className="btn sm" onClick={() => setHanding(true)}>{MOVE_LABEL}</button>}
            <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
          </>
        ) : (
          <span className="muted small">
            {!data ? '' : countLine(rows.length, inRemoved ? 0 : pickable.length, PAGE)}
          </span>
        )}
      </div>

      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>We could not load your documents</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h3>{filtered ? 'Nothing matches' : 'No documents yet'}</h3>
            {filtered ? 'No document fits this tab and search.' : <>Press <b>Send a document</b><span className="sn-where-phone"> (Send, in the bar at the bottom)</span> to start. Upload a PDF, add who needs to sign and place the fields. It takes about a minute.</>}
            {filtered && <div style={{ marginTop: 14 }}><button className="btn" onClick={() => (setTyped(''), change({ ...START }))}>Show all documents</button></div>}
            {/* One link for admins (research/ux-notes.json, gov-G19): to bring documents in, or to those brought in. */}
            {!filtered && seesBroughtIn && <BroughtInLink empty />}
          </div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead>
              <tr>
                <th className="sn-tick">
                  {pickable.length > 0 && (
                    <label className="sn-check"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(pickable))} aria-label={allPicked ? 'Clear selection' : `Select all ${pickable.length} sent documents in this list`} /></label>
                  )}
                </th>
                <th>Subject</th><th className="hide-sm">Status</th><th className="hide-sm">Waiting on</th><th className="hide-sm">Folder</th>{view?.col && <th className="hide-sm">{view.col}</th>}<th className="hide-sm">Updated</th><th className="hide-sm"><span className="sn-vh">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const w = e.status === 'sent' ? waitingOn(e.recipients, me.user.email) : null;
                // Someone still to act whose last email came back, or who marked it as spam (MailNews.tsx). Said before "not opened".
                const dead = e.status === 'sent' ? e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && (r.bounced_at || r.complained_at)) : [];
                const cold = e.status === 'sent' && !dead.length && e.recipients.some((r: any) => neverOpened(r));
                const title = listName(e.subject) || 'Untitled draft';
                const timed = e.status === 'sent' ? timingRow(e) : '';
                const waitingText = timed ? <span className="muted">{timed}</span> : w ? <><b>{cap(w.label)}</b>{w.since ? <span className="muted"> for {howLong(w.since)}</span> : null}{dead.length ? <span className="sn-cold"> · {dead.some((r: any) => r.bounced_at && !r.complained_at) ? 'could not be delivered' : 'marked as spam'}</span> : cold ? <span className="sn-cold"> · not opened</span> : null}</>
                  : e.status === 'draft' ? <span className="muted">{timingRow(e) || 'Not sent yet'}</span>
                  : e.status === 'completed' ? <span className="muted">Everyone finished</span>
                  : <span className="muted">{closedWhy(e)}</span>;
                return (
                  <tr key={e.id} className="click" onClick={() => router.push(open(e))}>
                    <td className="sn-tick" onClick={(ev) => ev.stopPropagation()}>
                      {!inRemoved && e.status !== 'draft' && !e.shared_level && <label className="sn-check"><input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${title}`} /></label>}
                    </td>
                    <td className="sn-main">
                      <Link href={open(e)} className="sn-subject" onClick={(ev) => ev.stopPropagation()}>{title}</Link>
                      <div className="muted small sn-to">To {e.recipients.map((r: any) => r.name).filter(Boolean).join(', ') || 'nobody yet'}</div>
                      {inRemoved && <div className="muted small">Sent by {e.sender}. Removed from their lists on {fmtDate(e.removed_at)}.</div>}
                      {e.shared_level && <div className="muted small" data-feature="ds-colleagues">{sharedRowLabel(e.sender)}, shared with you</div>}
                      <div className="sn-only-sm sn-rowmeta">
                        <Status s={e.status} />
                        {e.status === 'sent' && <span className="small">{timed ? waitingText : <>Waiting on {waitingText}</>}</span>}
                        <span className="muted small">{fmtDate(e.updated_at)}</span>
                        {view?.col && customValue(e, view.col) && <span className="small cf-col">{view.col}: {customValue(e, view.col)}</span>}
                      </div>
                      {e.bulk_id && <Link href={`/app/bulk?batch=${e.bulk_id}`} className="small sn-batchlink" onClick={(ev) => ev.stopPropagation()}>Part of a bulk send</Link>}
                      <div className="sn-only-sm sn-inlineactions" onClick={(ev) => ev.stopPropagation()}>
                        {e.status === 'sent' && (!e.shared_level || levelCovers(e.shared_level, 'manage')) && <button className="btn sm" disabled={busy === e.id} onClick={() => remind(e)} aria-label={`Send a reminder for ${title}`}>{busy === e.id ? 'Sending…' : 'Remind'}</button>}
                        {e.status === 'completed' && (!e.shared_level || levelCovers(e.shared_level, 'manage')) && <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={`Download signed PDF of ${title}`}>Download</a>}
                        {inRemoved ? <button className="btn sm" disabled={busy === e.id} onClick={() => putBack(e)} aria-label={`Put ${title} back in the lists`}>{busy === e.id ? 'Putting back…' : 'Put back'}</button>
                          : !e.shared_level && <button className="btn sm ghost" onClick={() => setMoving(e)} aria-label={`Move ${title} to a folder`}>Move to folder</button>}
                      </div>
                    </td>
                    <td className="hide-sm"><Status s={e.status} /></td>
                    <td className="hide-sm small sn-waiting">{waitingText}</td>
                    <td className="hide-sm muted small">{e.folder || ''}</td>
                    {view?.col && <td className="hide-sm small cf-col">{customValue(e, view.col)}</td>}
                    <td className="hide-sm muted small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.updated_at)}</td>
                    <td className="hide-sm sn-rowactions" onClick={(ev) => ev.stopPropagation()}>
                      {e.status === 'sent' && (!e.shared_level || levelCovers(e.shared_level, 'manage')) && <button className="btn sm" disabled={busy === e.id} onClick={() => remind(e)} aria-label={`Send a reminder for ${title}`}>{busy === e.id ? 'Sending…' : 'Remind'}</button>}
                      {e.status === 'completed' && (!e.shared_level || levelCovers(e.shared_level, 'manage')) && <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={`Download signed PDF of ${title}`}>Download</a>}
                      {inRemoved ? <button className="btn sm" disabled={busy === e.id} onClick={() => putBack(e)} aria-label={`Put ${title} back in the lists`}>{busy === e.id ? 'Putting back…' : 'Put back'}</button>
                        : !e.shared_level && <button className="btn sm ghost" onClick={() => setMoving(e)} aria-label={`Move ${title} to a folder`}>Move to folder</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
      {seesBroughtIn && !filtered && rows.length > 0 && <BroughtInLink />}

      {handing && <MoveToColleague ids={chosen} onClose={() => setHanding(false)} onDone={() => (setHanding(false), setPicked(new Set()), toast('Moved. Each history says who moved it.'), reload())} />}
      {moving && <MoveDialog envelope={moving} folders={data?.folders || []} onClose={() => setMoving(null)} onDone={() => (setMoving(null), reload())} />}
    </div>
  );
}

function MoveDialog({ envelope, folders, onClose, onDone }: { envelope: any; folders: string[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(envelope.folder || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/envelopes/${envelope.id}`, { method: 'PATCH', body: { folder: name.trim() } });
      toast(name.trim() ? `Moved to ${name.trim()}.` : 'Taken out of its folder.');
      onDone();
    } catch (e) {
      fail(e, 'Nothing was moved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Move to a folder" onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), save())}>
        <label className="f">
          <span>Folder for &ldquo;{envelope.subject || 'Untitled draft'}&rdquo; <span className="hint">(leave empty for no folder)</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} list="sn-folders" maxLength={80} placeholder="For example: Clients 2026" data-autofocus="" autoComplete="off" />
          <datalist id="sn-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Moving…' : 'Move'}</button>
        </div>
      </form>
    </Dialog>
  );
}
