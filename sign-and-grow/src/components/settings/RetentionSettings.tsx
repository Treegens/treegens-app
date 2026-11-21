'use client';
// Settings, the card "Keep and delete" (src/server/records.ts). Two lines: delete completed documents after so many
// days, and delete cancelled, declined and expired ones after so many days. Both empty means off: nothing is deleted
// automatically. Then what happens at the end, Holds, and the Deletion record. The long rules sit behind "How this
// works"; the schedule's name and code, templates with a period of their own, and deleting one document's files are
// behind the card's More options. Every sentence about what goes and what stays comes from src/lib/retention.ts.
import { useState, type ReactNode, type FormEvent } from 'react';
import Link from 'next/link';
import { api, useLoad, toast } from '@/components/ui';
import { useSaved } from './Frame';
import { HoldDialog, ReasonDialog, HoldRules } from '@/components/sender/Retention';
import { LEVEL_NAME, LEVEL_DOES, KEPT_AT, removesAt, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS, RETENTION_NOTICE_DAYS, RETENTION_CLOSED, SCREEN_LEVELS, daysText, daysProblem, type PurgeLevel } from '@/lib/retention';
import { screenLocale } from '@/lib/dates';

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const FEATURE = { 'data-feature': 'ds-retention' };

/** Find one document by its name: type, then pick. `children` draws what can be done with each one found. */
function DocFinder({ label, closedOnly, children }: { label: string; closedOnly?: boolean; children: (e: any) => ReactNode }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function find(ev: FormEvent) {
    ev.preventDefault();
    if (q.trim().length < 2) return setError('Type at least two letters of its name, then press Find.');
    setBusy(true);
    setError('');
    try {
      const r = await api(`/envelopes?q=${encodeURIComponent(q.trim())}&limit=8`);
      setFound((r.envelopes || []).filter((e: any) => (closedOnly ? RETENTION_CLOSED.includes(e.status) : e.status !== 'draft')));
    } catch (e: any) {
      setError(e?.message || 'We could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ret-find">
      <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={find}>
        <label className="f grow" style={{ margin: 0, minWidth: 180 }}><span>{label}</span><input value={q} maxLength={120} onChange={(e) => (setQ(e.target.value), setError(''))} /></label>
        <button className="btn" disabled={busy}>{busy ? 'Looking…' : 'Find'}</button>
      </form>
      {error && <p className="notice err" role="alert">{error}</p>}
      {found && found.length === 0 && <p className="muted small" role="status">Nothing found with that name{closedOnly ? ' among your finished documents' : ''}. Try another word from its title, or a person on it.</p>}
      {found && found.length > 0 && <ul className="ret-list">{found.map((e) => <li key={e.id}><div>{e.subject || 'Untitled'}<div className="muted small">{e.sender ? `${e.sender}, ` : ''}{day(e.completed_at || e.sent_at || e.created_at)}</div></div>{children(e)}</li>)}</ul>}
    </div>
  );
}

export function RetentionSettings() {
  const [data, reload, failed] = useLoad<any>(() => api('/account/retention'), []);
  const [form, setForm] = useState<any>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [adding, setAdding] = useState<'' | 'doc' | 'folder' | 'purge'>('');
  const [dialog, setDialog] = useState<null | { lift: string } | { folder: string } | { doc: any }>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, saved] = useSaved();
  if (failed) return <section className="card"><h2>Keep and delete</h2><p className="notice err" role="alert">{failed.message || 'We could not load this. Reload the page to try again.'}</p></section>;
  if (!data) return null;
  const p = data.policy;
  const f = form || { days: p.days ? String(p.days) : '', stopped: p.stopped_days ? String(p.stopped_days) : '', level: p.level, name: p.name || '', code: p.code || '', templates: Object.fromEntries(data.templates.map((t: any) => [t.id, t.days ? String(t.days) : ''])) };
  const set = (k: string, v: any) => (setForm({ ...f, [k]: v }), setError(''), setConfirm(null));
  const admin = data.may_change;
  const on = !!(f.days.trim() || f.stopped.trim());
  const bad = { days: daysProblem(f.days), stopped: daysProblem(f.stopped) };
  const level = f.level as PurgeLevel;
  const levels = SCREEN_LEVELS.includes(level) ? SCREEN_LEVELS : [...SCREEN_LEVELS.slice(0, 1), level, ...SCREEN_LEVELS.slice(1)];

  async function save(really = false) {
    if (bad.days || bad.stopped) return;
    const templates: Record<string, number | null> = {};
    for (const [id, v] of Object.entries(f.templates as Record<string, string>)) {
      if (daysProblem(v)) return setError(`A template's own period: ${daysProblem(v)}`);
      templates[id] = v.trim() ? Number(v) : null;
    }
    const body = { days: f.days.trim() ? Number(f.days) : null, stopped_days: f.stopped.trim() ? Number(f.stopped) : null, level: f.level, name: f.name, code: f.code, templates };
    setBusy(true);
    setError('');
    try {
      // First a dry run: how many finished documents would be in the next email at once. Saving that needs a second press.
      if (on && !really) {
        const dry = await api('/account/retention', { method: 'PUT', body: { ...body, dry_run: true } });
        if (dry.would_notice_now > 0) return setConfirm(dry.would_notice_now);
      }
      await api('/account/retention', { method: 'PUT', body });
      saved();
      setForm(null);
      setConfirm(null);
      reload();
    } catch (e: any) {
      setError(e?.message || 'We could not reach the server. Nothing was saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!admin) {
    return (
      <section className="card ret-settings" aria-labelledby="ret-set-h" {...FEATURE}>
        <h2 id="ret-set-h">Keep and delete</h2>
        <p className="muted">{p.on
          ? `${[p.days ? `Completed documents are deleted after ${daysText(p.days)}` : '', p.stopped_days ? `${p.days ? 'c' : 'C'}ancelled, declined and expired ones after ${daysText(p.stopped_days)}` : ''].filter(Boolean).join(', ')}. You get an email at least ${RETENTION_NOTICE_DAYS} days before, and can keep any of yours.`
          : 'Nothing is deleted automatically. Only the owner and admins can change that.'}</p>
      </section>
    );
  }

  return (
    <section className="card ret-settings" aria-labelledby="ret-set-h" {...FEATURE}>
      <h2 id="ret-set-h">Keep and delete</h2>
      {!on && <p className="muted" style={{ marginTop: 0 }}>Off: nothing is deleted automatically.</p>}
      <div className="ret-lines">
        <label className="ret-line" htmlFor="ret-days"><span>Delete completed documents after</span><span className="ret-num"><input id="ret-days" type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} value={f.days} aria-invalid={!!bad.days} aria-describedby={bad.days ? 'ret-days-bad' : undefined} onChange={(e) => set('days', e.target.value)} /> days</span></label>
        {bad.days && <p className="notice err" role="alert" id="ret-days-bad">{bad.days}</p>}
        <label className="ret-line" htmlFor="ret-stopped"><span>Delete cancelled, declined and expired ones after</span><span className="ret-num"><input id="ret-stopped" type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} value={f.stopped} aria-invalid={!!bad.stopped} aria-describedby={bad.stopped ? 'ret-stopped-bad' : undefined} onChange={(e) => set('stopped', e.target.value)} /> days</span></label>
        {bad.stopped && <p className="notice err" role="alert" id="ret-stopped-bad">{bad.stopped}</p>}
      </div>
      {on && (
        <fieldset className="ret-levels">
          <legend>At the end</legend>
          {levels.map((l) => (
            <label key={l} className="check ret-level"><input type="radio" name="ret-set-level" checked={level === l} onChange={() => set('level', l)} /><span>{LEVEL_NAME[l]}</span></label>
          ))}
        </fieldset>
      )}
      <p className="muted small">You and the sender get one email at least {RETENTION_NOTICE_DAYS} days before, and can keep any of them.</p>
      <details data-fold="">
        <summary className="set-fold">How this works</summary>
        <p className="muted small">The days count from the day each document was completed, cancelled, declined or expired. One that is still out is never deleted. The email goes to an account at most once a week and lists what is next. The people on the documents are not told, and their links stop working on the day.</p>
        <p className="small"><b>{LEVEL_NAME[level]}</b> means: {LEVEL_DOES[level]}. In full, this goes for good:</p>
        <ul className="rules small">{removesAt(level).map((s: string) => <li key={s}>{s}</li>)}</ul>
        <p className="small">{KEPT_AT[level]}</p>
        <p className="small"><b>What stays:</b></p>
        <ul className="rules small">{data.stays.map((s: string) => <li key={s}>{s}</li>)}</ul>
      </details>
      {confirm !== null && (
        <div className="notice warn" role="alert">
          {confirm === 1 ? 'One finished document is' : `${confirm} finished documents are`} already older than this. {confirm === 1 ? 'It is' : 'They are'} in the next email, and {confirm === 1 ? 'is' : 'are'} deleted {RETENTION_NOTICE_DAYS} days after it unless someone keeps {confirm === 1 ? 'it' : 'them'}.
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => setConfirm(null)}>Not yet</button>
            <button className="btn" disabled={busy} onClick={() => save(true)}>Save it anyway</button>
          </div>
        </div>
      )}
      {error && <div className="notice err" role="alert">{error}</div>}
      {confirm === null && <div className="row wrap" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}><button className="btn" disabled={busy || !form || !!bad.days || !!bad.stopped} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>{said}</div>}

      {data.queue.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Next to be deleted</h3>
          <ul className="ret-list">
            {data.queue.map((q: any) => (
              <li key={q.id}>
                <div><Link className="ret-link" href={`/app/envelopes/${q.id}`}>{q.subject || 'Untitled'}</Link><div className="muted small">On {day(q.goes_at)}, {LEVEL_DOES[q.level as PurgeLevel]}{q.asked_by ? `. ${q.asked_by} asked for it` : ''}.</div></div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 style={{ marginTop: 22 }}>Holds</h3>
      {data.holds.length === 0 ? <p className="muted small">Nothing is on hold. A hold keeps a document or a folder from being deleted until an admin ends it.</p> : (
        <ul className="ret-list">
          {data.holds.map((h: any) => (
            <li key={h.id}>
              <div>
                {h.folder ? <b>Folder &ldquo;{h.folder}&rdquo;</b> : <Link className="ret-link" href={`/app/envelopes/${h.envelope_id}`}>{h.subject || 'Untitled'}</Link>}
                <div className="muted small">On hold since {day(h.set_at)} ({h.set_by}). Reason: {h.reason}{h.matter ? `. Case: ${h.matter}` : ''}</div>
              </div>
              <button className="btn" aria-label={`Lift the hold on ${h.folder ? `folder ${h.folder}` : h.subject || 'the document'}`} onClick={() => setDialog({ lift: h.id })}>Lift the hold</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn" data-fold="" aria-expanded={adding === 'doc'} onClick={() => setAdding(adding === 'doc' ? '' : 'doc')}>Hold a document</button>
        {data.folders.length > 0 && <button className="btn" data-fold="" aria-expanded={adding === 'folder'} onClick={() => setAdding(adding === 'folder' ? '' : 'folder')}>Hold a folder</button>}
      </div>
      {adding === 'doc' && <DocFinder label="Name of the document to hold">{(e) => <button className="btn" aria-label={`Hold ${e.subject || 'Untitled'}`} onClick={() => setDialog({ doc: e })}>Hold</button>}</DocFinder>}
      {adding === 'folder' && (
        <div className="row wrap" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
          <label className="f" style={{ margin: 0, minWidth: 200 }}><span>Folder to hold</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">Choose a folder</option>
              {data.folders.map((x: string) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <button className="btn" disabled={!folder} onClick={() => setDialog({ folder })}>Hold this folder</button>
        </div>
      )}
      <HoldRules />

      {data.has_record && (
        <>
          <h3 style={{ marginTop: 22 }}>Deletion record</h3>
          <p className="muted small">Every change to the schedule, every keep, hold and deletion, and every attempt the software refused, with the fingerprint of each signed PDF that was deleted. Lines are never changed.</p>
          {/* Two downloads of the same kind, each saying its format (the simplicity reviewer: one button and one link
              left the person guessing what the button gives). */}
          <p className="row wrap" style={{ alignItems: 'center', gap: 12 }}>
            <span>Download the deletion record:</span>
            <a className="btn" href="/api/account/retention/log?format=csv">As a spreadsheet</a>
            <a className="btn" href="/api/account/retention/log?format=pdf">As a PDF to print</a>
          </p>
        </>
      )}

      <details className="set-more" data-more="item" style={{ marginTop: 16 }}>
        <summary>More about keeping and deleting</summary>
        <div className="set-more-body">
          <div className="ret-grid">
            <label className="f"><span>Name of the schedule <span className="hint">(optional)</span></span><input value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} /></label>
            <label className="f"><span>Its code <span className="hint">(optional, as your records schedule writes it)</span></span><input value={f.code} maxLength={80} onChange={(e) => set('code', e.target.value)} /></label>
          </div>
          {data.templates.length > 0 && (
            <>
              <h4>Templates with a period of their own</h4>
              <p className="muted small">Used instead of the account&apos;s days for every document started from that template, while the line for the way it ended is on. Leave it empty for the account&apos;s.</p>
              <ul className="ret-list">
                {data.templates.map((t: any) => (
                  <li key={t.id}>
                    <div>{t.subject || 'Untitled template'}</div>
                    <label className="f" style={{ margin: 0, width: 160 }}><span className="sg-vh">Days for {t.subject || 'Untitled template'}</span><input type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} placeholder="Account's" value={f.templates[t.id] ?? ''} onChange={(e) => set('templates', { ...f.templates, [t.id]: e.target.value })} /></label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">Name, code and template periods are saved with Save above.</p>
          <h4>Delete one document&apos;s files for good</h4>
          <p className="muted small">For a finished document that has to go before its time, or with no schedule at all. It waits {RETENTION_NOTICE_DAYS} days and can be called off until then.</p>
          <button className="btn" data-fold="" aria-expanded={adding === 'purge'} onClick={() => setAdding(adding === 'purge' ? '' : 'purge')}>Find the document</button>
          {adding === 'purge' && <DocFinder label="Name of the finished document" closedOnly>{(e) => <Link className="btn" href={`/app/envelopes/${e.id}?ask=purge`} aria-label={`Delete the files of ${e.subject || 'Untitled'}`}>Delete its files</Link>}</DocFinder>}
        </div>
      </details>

      {dialog && 'doc' in dialog && <HoldDialog url="/account/retention/holds" envelopeId={dialog.doc.id} title={`Hold "${dialog.doc.subject || 'Untitled'}"`} onClose={() => setDialog(null)} onDone={() => (setDialog(null), setAdding(''), toast('On hold. The software refuses to delete it until an admin lifts the hold.'), reload())} />}
      {dialog && 'folder' in dialog && <HoldDialog url="/account/retention/holds" folder={dialog.folder} title={`Hold the folder "${dialog.folder}"`} onClose={() => setDialog(null)} onDone={() => (setDialog(null), setAdding(''), toast('On hold. The software refuses to delete it until an admin lifts the hold.'), reload())} />}
      {dialog && 'lift' in dialog && <ReasonDialog title="Lift the hold" label="Why it may be lifted" note="Once the hold is lifted, what it covered can be deleted again by the usual rules. If the deletion schedule had reached any of it, the sender and the admins are emailed again at least 14 days before anything is deleted." confirm="Lift the hold" method="DELETE" url={`/account/retention/holds/${dialog.lift}`} onClose={() => setDialog(null)} onDone={() => (setDialog(null), toast('The hold is lifted.'), reload())} />}
    </section>
  );
}
