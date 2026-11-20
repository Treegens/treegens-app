'use client';
// Settings, Your data: how long closed envelopes are kept (src/server/records.ts). Admins set the period, what goes
// at the end of it, a schedule name and code, and templates with a period of their own; they see what is about to be
// purged, the legal holds, and the record of all of it as CSV. Members read the rule, because it keeps theirs too.
// Every sentence about what goes and what stays comes from src/lib/retention.ts, which the server and the emails use.
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, toast } from '@/components/ui';
import { HoldDialog, ReasonDialog } from '@/components/sender/Retention';
import { LEVEL_NAME, KEPT_AT, removesAt, HOLD_TRUTH, HOLD_BACKUPS, HOLD_OVERRIDE, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS, RETENTION_NOTICE_DAYS, PURGE_LEVELS, daysText, validDays, type PurgeLevel } from '@/lib/retention';

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function RetentionSettings() {
  const [data, reload, failed] = useLoad<any>(() => api('/account/retention'), []);
  const [form, setForm] = useState<any>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'' | 'hold' | { lift: string }>('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (failed) return <section className="card"><h2>How long closed envelopes are kept</h2><p className="notice err" role="alert">{failed.message || 'We could not load this. Reload the page to try again.'}</p></section>;
  if (!data) return null;
  const p = data.policy;
  const f = form || { on: p.on, days: String(p.days ?? 3650), level: p.level, name: p.name || '', code: p.code || '', templates: Object.fromEntries(data.templates.map((t: any) => [t.id, t.days ? String(t.days) : ''])) };
  const set = (k: string, v: any) => (setForm({ ...f, [k]: v }), setError(''), setConfirm(null));
  const admin = data.may_change;

  async function save(really = false) {
    const days = Number(f.days);
    if (f.on && !validDays(days)) return setError(`The period is a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}.`);
    const templates: Record<string, number | null> = {};
    for (const [id, v] of Object.entries(f.templates as Record<string, string>)) {
      if (v === '') templates[id] = null;
      else if (!validDays(Number(v))) return setError(`A template's own period is a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}, or empty for the account's.`);
      else templates[id] = Number(v);
    }
    const body = { days: f.on ? days : null, level: f.level, name: f.name, code: f.code, templates };
    setBusy(true);
    setError('');
    try {
      // First a dry run: how many closed envelopes would get the email at once. Saving that needs a second press.
      if (f.on && !really) {
        const dry = await api('/account/retention', { method: 'PUT', body: { ...body, dry_run: true } });
        if (dry.would_notice_now > 0) return setConfirm(dry.would_notice_now);
      }
      await api('/account/retention', { method: 'PUT', body });
      toast(f.on ? 'Saved. The rule applies from now on.' : 'Saved. The rule is off: nothing is purged by it.');
      setForm(null);
      setConfirm(null);
      reload();
    } catch (e: any) {
      setError(e?.message || 'We could not reach the server. Nothing was saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ret-settings" aria-labelledby="ret-set-h">
      <h2 id="ret-set-h">How long closed envelopes are kept</h2>
      {!admin && (
        <p className="muted">{p.on ? `This account keeps closed envelopes for ${daysText(p.days)} after they close. Then this is removed: ${LEVEL_NAME[p.level as PurgeLevel].toLowerCase()}, after an email ${RETENTION_NOTICE_DAYS} days before to the sender and the admins. You can keep one of yours on its page, with a reason.` : 'This account keeps closed envelopes without an end date. Only the owner and admins can change that.'}</p>
      )}
      {admin && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Off unless you switch it on. Counted from the day each envelope closed: completed, voided, declined or expired. One that is still out is never purged. Nobody on the envelopes is told: the sender and the admins get one email {RETENTION_NOTICE_DAYS} days before, and can keep any of them.</p>
          <label className="check" style={{ minHeight: 44 }}><input type="checkbox" checked={f.on} onChange={(e) => set('on', e.target.checked)} /> Purge closed envelopes at the end of a set period</label>
          {f.on && (
            <div className="ret-grid">
              <label className="f"><span>Keep them for, in days</span><input type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} value={f.days} onChange={(e) => set('days', e.target.value)} /></label>
              <label className="f"><span>Then remove</span>
                <select value={f.level} onChange={(e) => set('level', e.target.value)}>{PURGE_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_NAME[l]}</option>)}</select>
              </label>
              <label className="f"><span>Name of the schedule <span className="hint">(optional)</span></span><input value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} /></label>
              <label className="f"><span>Its code <span className="hint">(optional, as your records schedule writes it)</span></span><input value={f.code} maxLength={80} onChange={(e) => set('code', e.target.value)} /></label>
            </div>
          )}
          {f.on && (
            <>
              <p className="small"><b>{LEVEL_NAME[f.level as PurgeLevel]}</b> means this goes, for good:</p>
              <ul className="rules small">{removesAt(f.level).map((s: string) => <li key={s}>{s}</li>)}</ul>
              <p className="small">{KEPT_AT[f.level as PurgeLevel]}</p>
            </>
          )}
          <details className="ret-stays" open={f.on}>
            <summary>What stays after a purge</summary>
            <ul className="rules small">{data.stays.map((s: string) => <li key={s}>{s}</li>)}</ul>
          </details>
          {f.on && data.templates.length > 0 && (
            <details className="ret-stays">
              <summary>Templates with a period of their own</summary>
              <p className="muted small">Used instead of the account&apos;s period for every envelope started from that template, while the rule is on. Leave it empty for the account&apos;s.</p>
              <ul className="ret-list">
                {data.templates.map((t: any) => (
                  <li key={t.id}>
                    <div>{t.subject || 'Untitled template'}</div>
                    <label className="f" style={{ margin: 0, width: 160 }}><span className="sg-vh">Days for {t.subject || 'Untitled template'}</span><input type="number" inputMode="numeric" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} placeholder="Account's" value={f.templates[t.id] ?? ''} onChange={(e) => set('templates', { ...f.templates, [t.id]: e.target.value })} /></label>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {confirm !== null && (
            <div className="notice warn" role="alert">
              {confirm === 1 ? 'One closed envelope is' : `${confirm} closed envelopes are`} already older than this. {confirm === 1 ? 'It gets' : 'They get'} the email at the next run of the timer, and {confirm === 1 ? 'is' : 'are'} purged {RETENTION_NOTICE_DAYS} days after it unless someone keeps {confirm === 1 ? 'it' : 'them'} or an admin puts {confirm === 1 ? 'it' : 'them'} on hold.
              <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn" onClick={() => setConfirm(null)}>Not yet</button>
                <button className="btn primary" disabled={busy} onClick={() => save(true)}>Save it anyway</button>
              </div>
            </div>
          )}
          {error && <div className="notice err" role="alert">{error}</div>}
          {confirm === null && <div className="row wrap" style={{ gap: 8, marginTop: 10 }}><button className="btn primary" disabled={busy || !form} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button></div>}

          {data.queue.length > 0 && (
            <>
              <h3 style={{ marginTop: 22 }}>About to be purged</h3>
              <ul className="ret-list">
                {data.queue.map((q: any) => (
                  <li key={q.id}>
                    <div><Link href={`/app/envelopes/${q.id}`}>{q.subject || 'Untitled'}</Link><div className="muted small">On {day(q.goes_at)}: {LEVEL_NAME[q.level as PurgeLevel].toLowerCase()}{q.asked_by ? `, asked for by ${q.asked_by}` : ''}</div></div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 style={{ marginTop: 22 }}>Legal holds</h3>
          <p className="small">{HOLD_TRUTH}</p>
          <p className="muted small">{HOLD_BACKUPS} {HOLD_OVERRIDE}</p>
          {data.holds.length === 0 ? <p className="muted small">Nothing is on hold.</p> : (
            <ul className="ret-list">
              {data.holds.map((h: any) => (
                <li key={h.id}>
                  <div>
                    <b>{h.folder ? `Folder "${h.folder}"` : h.subject || 'An envelope'}</b>{h.envelope_id && <> (<Link href={`/app/envelopes/${h.envelope_id}`}>open</Link>)</>}
                    <div className="muted small">Since {day(h.set_at)}, set by {h.set_by}. Reason: {h.reason}{h.matter ? `. Matter: ${h.matter}` : ''}</div>
                  </div>
                  <button className="btn" onClick={() => setDialog({ lift: h.id })}>Lift</button>
                </li>
              ))}
            </ul>
          )}
          <div className="row wrap" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
            <label className="f" style={{ margin: 0, minWidth: 200 }}><span>Folder to hold</span>
              <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">Choose a folder</option>
                {data.folders.map((x: string) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
            <button className="btn" disabled={!folder} onClick={() => setDialog('hold')}>Put the folder on hold</button>
          </div>
          {data.folders.length === 0 && <p className="muted small">No envelope is in a folder yet. To hold one envelope, open it and choose Put on legal hold.</p>}
          <p className="small" style={{ marginTop: 16 }}><a href="/api/account/retention/log?format=csv">Download the retention record (CSV)</a>: every change to the rule, every keep, hold and purge, and every attempt the software refused, with the fingerprint of each signed PDF that was purged.</p>
        </>
      )}
      {dialog === 'hold' && <HoldDialog url="/account/retention/holds" folder={folder} what={`the folder "${folder}"`} onClose={() => setDialog('')} onDone={() => (setDialog(''), toast('On legal hold. Nothing in it can be deleted or purged until an admin lifts the hold.'), reload())} />}
      {dialog && typeof dialog === 'object' && <ReasonDialog title="Lift the legal hold" label="Why it may be lifted" note="Once the hold is lifted, what it covered can be deleted and purged again by the usual rules. If the retention rule had reached any of it, the sender and the admins are emailed again 14 days before anything is purged." confirm="Lift the hold" method="DELETE" url={`/account/retention/holds/${dialog.lift}`} onClose={() => setDialog('')} onDone={() => (setDialog(''), toast('The hold is lifted.'), reload())} />}
    </section>
  );
}
