'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SECURITY_GROUPS, SECURITY_KINDS } from '@/lib/seclog';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

// Settings, Security: the account's security record (src/server/seclog.ts), for its admins. Newest first, filtered by
// kind, person and days, downloadable as CSV; the alerts, each with its own switch; and how a security system gets
// the record: the call to pull it with an admin key, a webhook for "security.event", and whether names and email
// addresses go along. Nothing here watches anything: the page says so, in the words of the server.

const ui = SOURCE_LOCALE;
type Line = { seq: number; at: string; kind: string; what: string; outcome: string; actor: { type: string; id: string | null }; actor_name: string; about: { type: string; id: string } | null; about_name: string | null; ip: string | null; user_agent: string | null; details: Record<string, any> };
type Settings = { days: number; note: string; alerts: { id: string; label: string; on: boolean }[]; emails: boolean; chain: { whole: boolean; lines: number; broken_at: number | null }; webhooks: { id: string; host: string; created_at: string }[]; people: { id: string; name: string }[]; pull_url: string };

// A day typed on the screen is a day where the person is: from its first moment to the first moment of the next.
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : '');
const dayAfter = (d: string) => {
  if (!d) return '';
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + 1);
  return x.toISOString();
};

// The details of a line in words a person can read: values as they are, a setting by its name with what it was and is.
const words = (k: string) => k.replace(/_/g, ' ');
const show = (v: any): string => (v === null || v === undefined || v === '' ? 'nothing' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'object' ? JSON.stringify(v) : String(v));
function detailText(d: Record<string, any>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d || {})) {
    if (k === 'settings' && v && typeof v === 'object') {
      for (const [s, c] of Object.entries(v as Record<string, any>)) parts.push(c?.changed ? `${words(s)} changed` : `${words(s)}: ${show(c?.from)} to ${show(c?.to)}`);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) parts.push(`${words(k)}: ${Object.entries(v).map(([a, b]) => `${words(a)} ${show(b)}`).join(', ')}`);
    else parts.push(`${words(k)}: ${show(v)}`);
  }
  return parts.join('. ');
}

export function SecurityLog() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [s, reload, failed] = useLoad<Settings | null>(() => (admin ? api('/account/security') : Promise.resolve(null)), [admin]);
  const [f, setF] = useState({ kind: '', person: '', from: '', to: '' });
  const [shown, setShown] = useState(f);
  const qs = (x = shown) => new URLSearchParams(Object.entries({ kind: x.kind, person: x.person, from: dayStart(x.from), to: dayAfter(x.to) }).filter(([, v]) => v)).toString();
  const [page, , pageFailed] = useLoad<{ events: Line[]; next_before: number | null } | null>(() => (admin ? api(`/account/security-events/view?${qs()}`) : Promise.resolve(null)), [admin, shown]);
  const [older, setOlder] = useState<{ under: any; rows: Line[]; next: number | null } | null>(null);
  const more = older && older.under === page ? older : null;
  const rows = [...(page?.events || []), ...(more?.rows || [])];
  const next = more ? more.next : page?.next_before ?? null;
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);

  if (!admin) return <section className="card"><h2>{t(ui, 'settings.security.title')}</h2><p className="muted" style={{ margin: 0 }}>{t(ui, 'settings.security.admins_only')}</p></section>;
  if (failed || pageFailed) return <section className="card"><h2>{t(ui, 'settings.security.title')}</h2><p className="notice err" role="alert">{(failed || pageFailed)?.message || t(ui, 'settings.security.load_failed')}</p></section>;
  if (!s) return null;

  const act = (what: () => Promise<any>, ok: string) => {
    setBusy(true);
    setSaid(null);
    what().then(() => (setSaid({ text: ok }), reload())).catch((e) => setSaid({ text: e?.message || t(ui, 'settings.security.nothing_changed'), err: true })).finally(() => setBusy(false));
  };
  const download = async () => {
    setSaid(null);
    const r = await fetch(`/api/account/security-events/csv?${qs()}`, { credentials: 'same-origin' });
    if (!r.ok) return setSaid({ text: (await r.json().catch(() => ({})))?.error || t(ui, 'settings.security.download_failed'), err: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob());
    a.download = `security-record-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const showOlder = () => api(`/account/security-events/view?${qs()}&before=${next}`).then((r) => setOlder({ under: page, rows: [...(more?.rows || []), ...r.events], next: r.next_before })).catch(oops);
  const filtered = !!(shown.kind || shown.person || shown.from || shown.to);

  return (
    <div className="stack seclog">
      <section className="card" aria-labelledby="seclog-h">
        <h2 id="seclog-h" style={{ marginBottom: 4 }}>{t(ui, 'settings.security.title')}</h2>
        <p className="muted small">{s.note} {t(ui, 'settings.security.what')}</p>
        {!s.chain.whole && <p className="notice err" role="alert">{t(ui, 'settings.security.chain_broken', { seq: s.chain.broken_at ?? '' })}</p>}
        {said && <div className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'} style={{ margin: '10px 0' }}>{said.text}</div>}
        <form className="seclog-filters" onSubmit={(e) => (e.preventDefault(), setShown(f))}>
          <label className="f"><span>{t(ui, 'settings.security.filter_kind')}</span>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="">{t(ui, 'settings.security.every_kind')}</option>
              {SECURITY_GROUPS.map(([g, kinds]) => <optgroup key={g} label={g}>{kinds.map((k) => <option key={k} value={k}>{SECURITY_KINDS[k]}</option>)}</optgroup>)}
            </select>
          </label>
          <label className="f"><span>{t(ui, 'settings.security.filter_person')}</span>
            <select value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })}>
              <option value="">{t(ui, 'settings.security.everyone')}</option>
              {s.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="f"><span>{t(ui, 'settings.security.filter_from')}</span><input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="f"><span>{t(ui, 'settings.security.filter_to')}</span><input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <div className="row wrap seclog-actions">
            <button className="btn primary">{t(ui, 'settings.security.show')}</button>
            {filtered && <button type="button" className="btn" onClick={() => (setF({ kind: '', person: '', from: '', to: '' }), setShown({ kind: '', person: '', from: '', to: '' }))}>{t(ui, 'settings.security.clear')}</button>}
            <button type="button" className="btn" onClick={() => void download().catch(oops)}>{t(ui, 'settings.security.download')}</button>
          </div>
        </form>
        <p className="muted small" style={{ margin: '0 0 4px' }}>{t(ui, 'settings.security.download_hint')}</p>
        {page && rows.length === 0 && <p className="muted" role="status">{filtered ? t(ui, 'settings.security.none_filtered') : t(ui, 'settings.security.none')}</p>}
        <ul className="ways seclog-list" aria-label={t(ui, 'settings.security.list_label')}>
          {rows.map((r) => (
            <li key={r.seq}>
              <div className="what">
                <b>{r.what}</b>{r.outcome === 'failure' && <> <span className="badge declined">{t(ui, 'settings.security.failed')}</span></>}
                <div className="muted small">
                  {fmtDate(r.at, true)}. {r.actor_name}{r.about_name && r.about_name !== r.actor_name ? `, ${t(ui, 'settings.security.about', { name: r.about_name })}` : ''}{r.ip ? `, ${t(ui, 'settings.security.from', { ip: r.ip })}` : ''}.
                </div>
                {Object.keys(r.details || {}).length > 0 && <div className="muted small seclog-detail">{detailText(r.details)}</div>}
                {r.user_agent && <div className="muted small seclog-detail">{t(ui, 'settings.security.browser', { ua: r.user_agent })}</div>}
              </div>
            </li>
          ))}
        </ul>
        {next && <button className="btn" style={{ marginTop: 10 }} onClick={showOlder}>{t(ui, 'settings.security.older')}</button>}
      </section>

      <section className="card" aria-labelledby="seclog-alerts-h">
        <h2 id="seclog-alerts-h" style={{ marginBottom: 4 }}>{t(ui, 'settings.security.alerts_title')}</h2>
        <p className="muted small">{t(ui, 'settings.security.alerts_what')}</p>
        {s.alerts.map((a) => (
          <label key={a.id} className="setting-row">
            <input type="checkbox" checked={a.on} disabled={busy} onChange={(e) => act(() => api('/account/security', { method: 'PATCH', body: { alerts: { [a.id]: e.target.checked } } }), e.target.checked ? t(ui, 'settings.security.alert_on', { alert: a.label }) : t(ui, 'settings.security.alert_off', { alert: a.label }))} />
            <span>{a.label}</span>
          </label>
        ))}
      </section>

      <section className="card" aria-labelledby="seclog-siem-h">
        <h2 id="seclog-siem-h" style={{ marginBottom: 4 }}>{t(ui, 'settings.security.siem_title')}</h2>
        <p className="muted small">{t(ui, 'settings.security.pull')}</p>
        <p className="mono small seclog-detail">GET {s.pull_url}?after=0&amp;limit=1000</p>
        <p className="muted small">{t(ui, 'settings.security.webhook_what')}</p>
        {s.webhooks.length > 0 && (
          <ul className="ways">
            {s.webhooks.map((h) => (
              <li key={h.id}>
                <div className="what"><b>{h.host}</b><div className="muted small">{t(ui, 'settings.security.webhook_since', { day: fmtDate(h.created_at) })}</div></div>
                <button className="btn" disabled={busy} aria-label={t(ui, 'settings.security.webhook_remove_label', { host: h.host })} onClick={() => act(() => api(`/webhooks/${h.id}`, { method: 'DELETE' }), t(ui, 'settings.security.webhook_removed', { host: h.host }))}>{t(ui, 'settings.security.webhook_remove')}</button>
              </li>
            ))}
          </ul>
        )}
        <form className="row wrap" style={{ marginTop: 8 }} onSubmit={(e) => (e.preventDefault(), act(() => api('/webhooks', { body: { url: hook, events: ['security.event'] } }).then(() => setHook('')), t(ui, 'settings.security.webhook_added')))}>
          <input type="url" required placeholder="https://siem.example.com/hooks/growsigning" value={hook} onChange={(e) => setHook(e.target.value)} aria-label={t(ui, 'settings.security.webhook_label')} style={{ flex: '1 1 240px', minHeight: 44 }} />
          <button className="btn" disabled={busy}>{t(ui, 'settings.security.webhook_add')}</button>
        </form>
        <p className="muted small">{t(ui, 'settings.security.webhook_secret')}</p>
        <label className="setting-row">
          <input type="checkbox" checked={s.emails} disabled={busy} onChange={(e) => act(() => api('/account/security', { method: 'PATCH', body: { emails: e.target.checked } }), e.target.checked ? t(ui, 'settings.security.emails_on') : t(ui, 'settings.security.emails_off'))} />
          <span>{t(ui, 'settings.security.emails')}<span className="muted small" style={{ display: 'block' }}>{t(ui, 'settings.security.emails_hint')}</span></span>
        </label>
      </section>
    </div>
  );
}
