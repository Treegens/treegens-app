'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { Dialog } from '@/components/sender/Dialog';
import { fail } from '@/components/sender/feedback';
import { cap, exportUrl, howLong, joinNames, neverOpened, waitingOn } from '@/components/sender/lib';

const BOXES: [string, string][] = [['all', 'All'], ['drafts', 'Drafts'], ['waiting', 'Waiting for others'], ['completed', 'Completed'], ['closed', 'Declined, voided, expired']];
const STORE = 'sg.envelopes.view';
const PAGE = 200;

// Why a closed envelope is closed, from what the list already knows.
function closedWhy(e: any): string {
  const acting = e.recipients.filter((r: any) => r.role !== 'cc');
  if (e.status === 'declined') return `${joinNames(acting.filter((r: any) => r.status === 'declined').map((r: any) => r.name)) || 'Someone'} declined`;
  if (e.status === 'expired') return `Closed before ${joinNames(acting.filter((r: any) => r.status !== 'completed').map((r: any) => r.name)) || 'everyone'} finished`;
  return 'Nobody. It was voided';
}

type View = { box: string; q: string; folder: string; sender: string };
const START: View = { box: 'all', q: '', folder: '', sender: '' };

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
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const v = restore();
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
    () => (view ? api(`/envelopes?box=${view.box}&q=${encodeURIComponent(view.q)}&folder=${encodeURIComponent(view.folder)}&sender=${encodeURIComponent(view.sender)}&limit=${PAGE}`) : Promise.resolve(null)),
    [view?.box, view?.q, view?.folder, view?.sender],
  );

  // A remembered folder or sender that no longer exists would hide everything with no way to see why.
  useEffect(() => {
    if (!data || !view) return;
    if (view.folder && !data.folders.includes(view.folder)) change({ folder: '' });
    else if (view.sender && !data.senders.some((s: any) => s.id === view.sender)) change({ sender: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows: any[] = data?.envelopes || [];
  const pickable = useMemo(() => rows.filter((e) => e.status !== 'draft').map((e) => e.id as string), [rows]);
  const chosen = pickable.filter((id) => picked.has(id));
  const allPicked = pickable.length > 0 && chosen.length === pickable.length;
  const filtered = !!view && (view.q !== '' || view.folder !== '' || view.sender !== '' || view.box !== 'all');
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  async function remind(e: any) {
    setBusy(e.id);
    try {
      const { reminded } = await api(`/envelopes/${e.id}/remind`, { method: 'POST' });
      if (reminded) toast(`Reminder emailed to ${reminded} ${reminded === 1 ? 'person' : 'people'}.`);
      else toast('No reminder went out. They turned reminders off. Open the envelope to share the link another way.', true);
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

  return (
    <div className="sn">
      <div className="pagehead">
        <div>
          <h1 className="serif">Envelopes</h1>
          <div className="muted small" id="sn-export-note">Export everything is free on every plan and keeps working after you cancel.</div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={exportAll} disabled={busy === 'export'} aria-describedby="sn-export-note">{busy === 'export' ? 'Preparing…' : 'Export everything (ZIP)'}</button>
          <Link href="/app/envelopes/new" className="btn primary">New envelope</Link>
        </div>
      </div>

      <div className="tabs" role="group" aria-label="Show">
        {BOXES.map(([k, l]) => <button key={k} className={view?.box === k ? 'on' : ''} aria-pressed={view?.box === k} onClick={() => change({ box: k })}>{l}</button>)}
      </div>

      <div className="sn-filters">
        <div className="sn-search">
          <input type="search" placeholder="Search subject, people, document text or ID" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search envelopes" />
          {typed && <button className="btn sm ghost" onClick={() => (setTyped(''), change({ q: '' }))}>Clear</button>}
        </div>
        {data && data.folders.length > 0 && (
          <select value={view?.folder || ''} onChange={(e) => change({ folder: e.target.value })} aria-label="Folder">
            <option value="">All folders</option>{data.folders.map((f: string) => <option key={f}>{f}</option>)}
          </select>
        )}
        {data && data.senders.length > 1 && (
          <select value={view?.sender || ''} onChange={(e) => change({ sender: e.target.value })} aria-label="Sent by">
            <option value="">Sent by anyone</option>{data.senders.map((s: any) => <option key={s.id} value={s.id}>{s.id === me.user.id ? 'Sent by me' : `Sent by ${s.name}`}</option>)}
          </select>
        )}
      </div>

      <div className="sn-selbar" aria-live="polite">
        {chosen.length > 0 ? (
          <>
            <b>{chosen.length} selected</b>
            <a className="btn sm primary" href={exportUrl(chosen)}>Download selected (ZIP)</a>
            <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
          </>
        ) : (
          <span className="muted small">
            {!data ? '' : rows.length === 0 ? '' : `${rows.length}${rows.length === PAGE ? ' most recently updated' : ''} envelope${rows.length === 1 ? '' : 's'}${rows.length === PAGE ? '. Search to find older ones' : ''}. Tick the boxes to download several as one ZIP.`}
          </span>
        )}
      </div>

      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>We could not load your envelopes</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h3>{filtered ? 'Nothing matches' : 'No envelopes yet'}</h3>
            {filtered ? 'No envelope fits this tab and search.' : 'Upload a PDF, add who needs to sign and place the fields. It takes about a minute.'}
            <div style={{ marginTop: 14 }}>
              {filtered ? <button className="btn" onClick={() => (setTyped(''), change({ ...START }))}>Show all envelopes</button> : <Link href="/app/envelopes/new" className="btn primary">Send your first envelope</Link>}
            </div>
          </div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead>
              <tr>
                <th className="sn-tick">
                  {pickable.length > 0 && (
                    <label className="sn-check"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(pickable))} aria-label={allPicked ? 'Clear selection' : `Select all ${pickable.length} sent envelopes in this list`} /></label>
                  )}
                </th>
                <th>Subject</th><th className="hide-sm">Status</th><th className="hide-sm">Waiting on</th><th className="hide-sm">Folder</th><th className="hide-sm">Updated</th><th className="hide-sm"><span className="sn-vh">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const w = e.status === 'sent' ? waitingOn(e.recipients, me.user.email) : null;
                const cold = e.status === 'sent' && e.recipients.some((r: any) => neverOpened(r));
                const title = e.subject || 'Untitled draft';
                const waitingText = w ? <><b>{cap(w.label)}</b>{w.since ? <span className="muted"> for {howLong(w.since)}</span> : null}{cold ? <span className="sn-cold"> · not opened</span> : null}</>
                  : e.status === 'draft' ? <span className="muted">Not sent yet</span>
                  : e.status === 'completed' ? <span className="muted">Everyone finished</span>
                  : <span className="muted">{closedWhy(e)}</span>;
                return (
                  <tr key={e.id} className="click" onClick={() => router.push(open(e))}>
                    <td className="sn-tick" onClick={(ev) => ev.stopPropagation()}>
                      {e.status !== 'draft' && <label className="sn-check"><input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${title}`} /></label>}
                    </td>
                    <td className="sn-main">
                      <Link href={open(e)} className="sn-subject" onClick={(ev) => ev.stopPropagation()}>{title}</Link>
                      <div className="muted small sn-to">To {e.recipients.map((r: any) => r.name).filter(Boolean).join(', ') || 'nobody yet'}</div>
                      <div className="sn-only-sm sn-rowmeta">
                        <Status s={e.status} />
                        {e.status === 'sent' && <span className="small">Waiting on {waitingText}</span>}
                        <span className="muted small">{fmtDate(e.updated_at)}</span>
                      </div>
                      {e.bulk_id && <Link href={`/app/bulk?batch=${e.bulk_id}`} className="small sn-batchlink" onClick={(ev) => ev.stopPropagation()}>Part of a bulk send</Link>}
                      <div className="sn-only-sm sn-inlineactions" onClick={(ev) => ev.stopPropagation()}>
                        {e.status === 'sent' && <button className="btn sm" disabled={busy === e.id} onClick={() => remind(e)} aria-label={`Send a reminder for ${title}`}>{busy === e.id ? 'Sending…' : 'Remind'}</button>}
                        {e.status === 'completed' && <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={`Download signed PDF of ${title}`}>Download</a>}
                        <button className="btn sm ghost" onClick={() => setMoving(e)} aria-label={`Move ${title} to a folder`}>Move</button>
                      </div>
                    </td>
                    <td className="hide-sm"><Status s={e.status} /></td>
                    <td className="hide-sm small sn-waiting">{waitingText}</td>
                    <td className="hide-sm muted small">{e.folder || ''}</td>
                    <td className="hide-sm muted small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.updated_at)}</td>
                    <td className="hide-sm sn-rowactions" onClick={(ev) => ev.stopPropagation()}>
                      {e.status === 'sent' && <button className="btn sm" disabled={busy === e.id} onClick={() => remind(e)} aria-label={`Send a reminder for ${title}`}>{busy === e.id ? 'Sending…' : 'Remind'}</button>}
                      {e.status === 'completed' && <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={`Download signed PDF of ${title}`}>Download</a>}
                      <button className="btn sm ghost" onClick={() => setMoving(e)} aria-label={`Move ${title} to a folder`}>Move</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

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
