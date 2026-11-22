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
import { useST, senderRich } from '@/components/senderLang';

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const FEATURE = { 'data-feature': 'ds-retention' };

/** Find one document by its name: type, then pick. `children` draws what can be done with each one found. */
function DocFinder({ label, closedOnly, children }: { label: string; closedOnly?: boolean; children: (e: any) => ReactNode }) {
  const T = useST();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function find(ev: FormEvent) {
    ev.preventDefault();
    if (q.trim().length < 2) return setError(T('settings.ret.two_letters'));
    setBusy(true);
    setError('');
    try {
      const r = await api(`/envelopes?q=${encodeURIComponent(q.trim())}&limit=8`);
      setFound((r.envelopes || []).filter((e: any) => (closedOnly ? RETENTION_CLOSED.includes(e.status) : e.status !== 'draft')));
    } catch (e: any) {
      setError(e?.message || T('settings.offline'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ret-find">
      <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={find}>
        <label className="f grow" style={{ margin: 0, minWidth: 180 }}><span>{label}</span><input value={q} maxLength={120} onChange={(e) => (setQ(e.target.value), setError(''))} /></label>
        <button className="btn" disabled={busy}>{busy ? T('settings.looking') : T('settings.find')}</button>
      </form>
      {error && <p className="notice err" role="alert">{error}</p>}
      {found && found.length === 0 && <p className="muted small" role="status">{closedOnly ? T('settings.ret.nothing_found_closed') : T('settings.ret.nothing_found')}</p>}
      {found && found.length > 0 && <ul className="ret-list">{found.map((e) => <li key={e.id}><div>{e.subject || T('settings.untitled')}<div className="muted small">{e.sender ? T('settings.ret.sender_day', { sender: e.sender, day: day(e.completed_at || e.sent_at || e.created_at) }) : day(e.completed_at || e.sent_at || e.created_at)}</div></div>{children(e)}</li>)}</ul>}
    </div>
  );
}

export function RetentionSettings() {
  const T = useST();
  const [data, reload, failed] = useLoad<any>(() => api('/account/retention'), []);
  const [form, setForm] = useState<any>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [adding, setAdding] = useState<'' | 'doc' | 'folder' | 'purge'>('');
  const [dialog, setDialog] = useState<null | { lift: string } | { folder: string } | { doc: any }>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, saved] = useSaved();
  if (failed) return <section className="card"><h2>{T('settings.ret.title')}</h2><p className="notice err" role="alert">{failed.message || T('settings.load_failed')}</p></section>;
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
      if (daysProblem(v)) return setError(T('settings.ret.template_period', { problem: daysProblem(v) }));
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
      setError(e?.message || T('settings.offline_not_saved'));
    } finally {
      setBusy(false);
    }
  }

  if (!admin) {
    return (
      <section className="card ret-settings" aria-labelledby="ret-set-h" {...FEATURE}>
        <h2 id="ret-set-h">{T('settings.ret.title')}</h2>
        <p className="muted">{p.on
          ? T(p.days && p.stopped_days ? 'settings.ret.member_both' : p.days ? 'settings.ret.member_done' : 'settings.ret.member_stopped', { days: p.days ? daysText(p.days) : '', stopped: p.stopped_days ? daysText(p.stopped_days) : '', notice: RETENTION_NOTICE_DAYS })
          : T('settings.ret.member_off')}</p>
      </section>
    );
  }

  return (
    <section className="card ret-settings" aria-labelledby="ret-set-h" {...FEATURE}>
      <h2 id="ret-set-h">{T('settings.ret.title')}</h2>
      {!on && <p className="muted" style={{ marginTop: 0 }}>{T('settings.ret.off')}</p>}
      <div className="ret-lines">
        <label className="ret-line" htmlFor="ret-days"><span>{T('settings.ret.completed_after')}</span><span className="ret-num"><input id="ret-days" type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} value={f.days} aria-invalid={!!bad.days} aria-describedby={bad.days ? 'ret-days-bad' : undefined} onChange={(e) => set('days', e.target.value)} /> {T('settings.ret.days')}</span></label>
        {bad.days && <p className="notice err" role="alert" id="ret-days-bad">{bad.days}</p>}
        <label className="ret-line" htmlFor="ret-stopped"><span>{T('settings.ret.stopped_after')}</span><span className="ret-num"><input id="ret-stopped" type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} value={f.stopped} aria-invalid={!!bad.stopped} aria-describedby={bad.stopped ? 'ret-stopped-bad' : undefined} onChange={(e) => set('stopped', e.target.value)} /> {T('settings.ret.days')}</span></label>
        {bad.stopped && <p className="notice err" role="alert" id="ret-stopped-bad">{bad.stopped}</p>}
      </div>
      {on && (
        <fieldset className="ret-levels">
          <legend>{T('settings.ret.at_end')}</legend>
          {levels.map((l) => (
            <label key={l} className="check ret-level"><input type="radio" name="ret-set-level" checked={level === l} onChange={() => set('level', l)} /><span>{LEVEL_NAME[l]}</span></label>
          ))}
        </fieldset>
      )}
      <p className="muted small">{T('settings.ret.email_before', { notice: RETENTION_NOTICE_DAYS })}</p>
      <details data-fold="">
        <summary className="set-fold">{T('settings.how')}</summary>
        <p className="muted small">{T('settings.ret.how')}</p>
        <p className="small">{senderRich(T.lang, 'settings.ret.means', { level: <b>{LEVEL_NAME[level]}</b> }, { does: LEVEL_DOES[level] })}</p>
        <ul className="rules small">{removesAt(level).map((s: string) => <li key={s}>{s}</li>)}</ul>
        <p className="small">{KEPT_AT[level]}</p>
        <p className="small"><b>{T('settings.ret.what_stays')}</b></p>
        <ul className="rules small">{data.stays.map((s: string) => <li key={s}>{s}</li>)}</ul>
      </details>
      {confirm !== null && (
        <div className="notice warn" role="alert">
          {T('settings.ret.older', { count: confirm, notice: RETENTION_NOTICE_DAYS })}
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => setConfirm(null)}>{T('settings.ret.not_yet')}</button>
            <button className="btn" disabled={busy} onClick={() => save(true)}>{T('settings.ret.anyway')}</button>
          </div>
        </div>
      )}
      {error && <div className="notice err" role="alert">{error}</div>}
      {confirm === null && <div className="row wrap" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}><button className="btn" disabled={busy || !form || !!bad.days || !!bad.stopped} onClick={() => save()}>{busy ? T('settings.saving_dots') : T('settings.save')}</button>{said}</div>}

      {data.queue.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>{T('settings.ret.next')}</h3>
          <ul className="ret-list">
            {data.queue.map((q: any) => (
              <li key={q.id}>
                <div><Link className="ret-link" href={`/app/envelopes/${q.id}`}>{q.subject || T('settings.untitled')}</Link><div className="muted small">{T(q.asked_by ? 'settings.ret.queue_line_asked' : 'settings.ret.queue_line', { day: day(q.goes_at), does: LEVEL_DOES[q.level as PurgeLevel], who: q.asked_by || '' })}</div></div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 style={{ marginTop: 22 }}>{T('settings.ret.holds')}</h3>
      {data.holds.length === 0 ? <p className="muted small">{T('settings.ret.no_holds')}</p> : (
        <ul className="ret-list">
          {data.holds.map((h: any) => (
            <li key={h.id}>
              <div>
                {h.folder ? <b>{T('settings.ret.folder', { name: h.folder })}</b> : <Link className="ret-link" href={`/app/envelopes/${h.envelope_id}`}>{h.subject || T('settings.untitled')}</Link>}
                <div className="muted small">{T(h.matter ? 'settings.ret.hold_line_case' : 'settings.ret.hold_line', { day: day(h.set_at), who: h.set_by, reason: h.reason, matter: h.matter || '' })}</div>
              </div>
              <button className="btn" aria-label={h.folder ? T('settings.ret.lift_label_folder', { name: h.folder }) : T('settings.ret.lift_label', { name: h.subject || T('settings.ret.the_document') })} onClick={() => setDialog({ lift: h.id })}>{T('settings.ret.lift')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn" data-fold="" aria-expanded={adding === 'doc'} onClick={() => setAdding(adding === 'doc' ? '' : 'doc')}>{T('settings.ret.hold_doc')}</button>
        {data.folders.length > 0 && <button className="btn" data-fold="" aria-expanded={adding === 'folder'} onClick={() => setAdding(adding === 'folder' ? '' : 'folder')}>{T('settings.ret.hold_folder')}</button>}
      </div>
      {adding === 'doc' && <DocFinder label={T('settings.ret.doc_to_hold')}>{(e) => <button className="btn" aria-label={T('settings.ret.hold_label', { name: e.subject || T('settings.untitled') })} onClick={() => setDialog({ doc: e })}>{T('settings.ret.hold')}</button>}</DocFinder>}
      {adding === 'folder' && (
        <div className="row wrap" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
          <label className="f" style={{ margin: 0, minWidth: 200 }}><span>{T('settings.ret.folder_to_hold')}</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">{T('settings.ret.choose_folder')}</option>
              {data.folders.map((x: string) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <button className="btn" disabled={!folder} onClick={() => setDialog({ folder })}>{T('settings.ret.hold_this_folder')}</button>
        </div>
      )}
      <HoldRules />

      {data.has_record && (
        <>
          <h3 style={{ marginTop: 22 }}>{T('settings.ret.record')}</h3>
          <p className="muted small">{T('settings.ret.record_note')}</p>
          {/* Two downloads of the same kind, each saying its format (the simplicity reviewer: one button and one link
              left the person guessing what the button gives). */}
          <p className="row wrap" style={{ alignItems: 'center', gap: 12 }}>
            <span>{T('settings.ret.download')}</span>
            <a className="btn" href="/api/account/retention/log?format=csv">{T('settings.ret.as_csv')}</a>
            <a className="btn" href="/api/account/retention/log?format=pdf">{T('settings.ret.as_pdf')}</a>
          </p>
        </>
      )}

      <details className="set-more" data-more="item" style={{ marginTop: 16 }}>
        <summary>{T('settings.ret.more')}</summary>
        <div className="set-more-body">
          <div className="ret-grid">
            <label className="f"><span>{T('settings.ret.schedule_name')} <span className="hint">{T('settings.optional')}</span></span><input value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} /></label>
            <label className="f"><span>{T('settings.ret.code')} <span className="hint">{T('settings.ret.code_hint')}</span></span><input value={f.code} maxLength={80} onChange={(e) => set('code', e.target.value)} /></label>
          </div>
          {data.templates.length > 0 && (
            <>
              <h4>{T('settings.ret.templates')}</h4>
              <p className="muted small">{T('settings.ret.templates_note')}</p>
              <ul className="ret-list">
                {data.templates.map((t: any) => (
                  <li key={t.id}>
                    <div>{t.subject || T('settings.untitled_template')}</div>
                    <label className="f" style={{ margin: 0, width: 160 }}><span className="sg-vh">{T('settings.ret.days_for', { name: t.subject || T('settings.untitled_template') })}</span><input type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} placeholder={T('settings.ret.accounts')} value={f.templates[t.id] ?? ''} onChange={(e) => set('templates', { ...f.templates, [t.id]: e.target.value })} /></label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">{T('settings.ret.saved_above')}</p>
          <h4>{T('settings.ret.purge_title')}</h4>
          <p className="muted small">{T('settings.ret.purge_note', { notice: RETENTION_NOTICE_DAYS })}</p>
          <button className="btn" data-fold="" aria-expanded={adding === 'purge'} onClick={() => setAdding(adding === 'purge' ? '' : 'purge')}>{T('settings.ret.find_doc')}</button>
          {adding === 'purge' && <DocFinder label={T('settings.ret.finished_name')} closedOnly>{(e) => <Link className="btn" href={`/app/envelopes/${e.id}?ask=purge`} aria-label={T('settings.ret.purge_label', { name: e.subject || T('settings.untitled') })}>{T('settings.ret.purge_button')}</Link>}</DocFinder>}
        </div>
      </details>

      {dialog && 'doc' in dialog && <HoldDialog url="/account/retention/holds" envelopeId={dialog.doc.id} title={T('settings.ret.hold_title', { name: dialog.doc.subject || T('settings.untitled') })} onClose={() => setDialog(null)} onDone={() => (setDialog(null), setAdding(''), toast(T('settings.ret.on_hold')), reload())} />}
      {dialog && 'folder' in dialog && <HoldDialog url="/account/retention/holds" folder={dialog.folder} title={T('settings.ret.hold_folder_title', { name: dialog.folder })} onClose={() => setDialog(null)} onDone={() => (setDialog(null), setAdding(''), toast(T('settings.ret.on_hold')), reload())} />}
      {dialog && 'lift' in dialog && <ReasonDialog title={T('settings.ret.lift')} label={T('settings.ret.why_lift')} note={T('settings.ret.lift_note')} confirm={T('settings.ret.lift')} method="DELETE" url={`/account/retention/holds/${dialog.lift}`} onClose={() => setDialog(null)} onDone={() => (setDialog(null), toast(T('settings.ret.lifted')), reload())} />}
    </section>
  );
}
