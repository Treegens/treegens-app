'use client';
import { useEffect, useState } from 'react';
import { api, useLoad, fmtDate, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SECURITY_GROUPS, SECURITY_SEARCH_MAX, securityKindWords, securityGroupWords, securityAlertWords, securityLogWords, securityDetail, securityDevice } from '@/lib/seclog';
import { senderT as t } from '@/lib/senderlang';
import { useSenderLangHere } from '@/components/senderLang';

// Settings, Security: the account's security record (src/server/seclog.ts), for its admins. One card: who signed in
// and what changed, newest first, with one search box, a folded Filter and Download. What is set up once sits behind
// the card's More options: the alerts, and how a security system gets the record. Each answer ("Saved", a refusal)
// stands next to the control that was used. Nothing here watches anything: the first line says so.

type Line = { seq: number; at: string; kind: string; outcome: string; actor_name: string; about_name: string | null; ip: string | null; user_agent: string | null; details: Record<string, any> };
type Settings = { days: number; alerts: { id: string; on: boolean }[]; emails: boolean; chain: { whole: boolean; broken_at: number | null; why: 'line' | 'missing' | null }; webhooks: { id: string; host: string; created_at: string }[]; webhook_hosts: string[] | null; people: { id: string; name: string }[]; pull_url: string };
type Said = { at: string; text: string; err?: boolean } | null;

// A day typed on the screen is a day where the person is: from its first moment to the first moment of the next.
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : '');
const dayAfter = (d: string) => {
  if (!d) return '';
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + 1);
  return x.toISOString();
};
// The server names some actors in lower case ("someone who is no longer on the team"), to read inside a sentence too.
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const NONE = { kind: '', person: '', from: '', to: '' };

export function SecurityLog() {
  const ui = useSenderLangHere();
  const me = useMe();
  const admin = me.role !== 'member';
  const [s, reload, failed] = useLoad<Settings | null>(() => (admin ? api('/account/security') : Promise.resolve(null)), [admin]);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [f, setF] = useState(NONE);
  // The search filters as you type: the list follows a moment after the last key.
  useEffect(() => {
    const id = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(id);
  }, [typed]);
  const qs = () => new URLSearchParams(Object.entries({ q, kind: f.kind, person: f.person, from: dayStart(f.from), to: dayAfter(f.to) }).filter(([, v]) => v)).toString();
  const [page, , pageFailed] = useLoad<{ events: Line[]; next_before: number | null } | null>(() => (admin ? api(`/account/security-events/view?${qs()}`) : Promise.resolve(null)), [admin, q, f]);
  const [older, setOlder] = useState<{ under: any; rows: Line[]; next: number | null } | null>(null);
  const more = older && older.under === page ? older : null;
  const rows = [...(page?.events || []), ...(more?.rows || [])];
  const next = more ? more.next : page?.next_before ?? null;
  // What was just answered, and next to which control it is shown.
  const [said, setSaid] = useState<Said>(null);
  const [hook, setHook] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  // What is inside "Send to your security system" is drawn only while it is open.
  const [siem, setSiem] = useState(false);

  // A member never gets this card (Settings does not draw it for them).
  if (!admin) return null;
  if (failed || pageFailed) return <section className="card" data-feature="ds-sec-log"><h2>{t(ui, 'settings.security.title')}</h2><p className="notice err" role="alert">{(failed || pageFailed)?.message || t(ui, 'settings.security.load_failed')}</p></section>;
  if (!s) return null;

  const act = (at: string, what: () => Promise<any>, ok: string) => {
    setBusy(true);
    setSaid(null);
    return what().then(() => (setSaid({ at, text: ok }), reload())).catch((e) => setSaid({ at, text: e?.message || t(ui, 'settings.security.nothing_changed'), err: true })).finally(() => setBusy(false));
  };
  // The answer, in the place it belongs to: a live region that is always there, so a screen reader hears it arrive.
  const answer = (at: string, block = false) => {
    const mine = said?.at === at ? said : null;
    // A refusal is brought into view: it may have landed just under the edge of the screen.
    if (mine?.err || block) return <div ref={(el) => { if (el && mine?.err) el.scrollIntoView({ block: 'nearest' }); }} role={mine?.err ? 'alert' : 'status'} className={mine ? `notice${mine.err ? ' err' : ''}` : undefined} style={mine ? { margin: '8px 0' } : undefined}>{mine?.text || ''}</div>;
    return <span role="status" className="set-saved">{mine?.text || ''}</span>;
  };
  const download = async () => {
    setSaid(null);
    const r = await fetch(`/api/account/security-events/csv?${qs()}`, { credentials: 'same-origin' });
    if (!r.ok) return setSaid({ at: 'download', text: (await r.json().catch(() => ({})))?.error || t(ui, 'settings.security.download_failed'), err: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob());
    a.download = `security-record-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const copy = (at: string, text: string) => navigator.clipboard.writeText(text).then(() => setSaid({ at, text: t(ui, 'settings.security.copied') })).catch(oops);
  const addHook = () => act('hook', async () => {
    setSecret('');
    const made = await api('/webhooks', { body: { url: hook, events: ['security.event'] } });
    // The signing secret of the address just added, to show it here, where it was added.
    const list = await api('/webhooks').catch(() => null);
    setSecret(list?.webhooks?.find((h: any) => h.id === made?.id)?.secret || '');
    setHook('');
  }, t(ui, 'settings.security.saved'));
  const showOlder = () => api(`/account/security-events/view?${qs()}&before=${next}`).then((r) => setOlder({ under: page, rows: [...(more?.rows || []), ...r.events], next: r.next_before })).catch(oops);
  const filters = [f.kind, f.person, f.from, f.to].filter(Boolean).length;
  const filtered = !!(q || filters);
  const clear = () => (setTyped(''), setQ(''), setF(NONE));
  const who = (r: Line) => [cap(r.actor_name), r.about_name && r.about_name !== r.actor_name ? t(ui, 'settings.security.about', { name: r.about_name }) : '', r.ip ? t(ui, 'settings.security.from', { ip: r.ip }) : '', securityDevice(r.user_agent, ui)].filter(Boolean).join(', ');

  return (
    <section className="card seclog" aria-labelledby="seclog-h" data-feature="ds-sec-log">
      <h2 id="seclog-h" style={{ marginBottom: 4 }}>{t(ui, 'settings.security.title')}</h2>
      <p className="muted small">{securityLogWords(s.days, ui)}</p>
      {!s.chain.whole && <p className="notice err" role="alert">{s.chain.why === 'missing' || s.chain.broken_at == null ? t(ui, 'settings.security.chain_missing') : t(ui, 'settings.security.chain_broken', { seq: s.chain.broken_at })}</p>}

      <label className="f seclog-search"><span>{t(ui, 'settings.security.search_label')}</span>
        <input type="search" value={typed} maxLength={SECURITY_SEARCH_MAX} placeholder={t(ui, 'settings.security.search_placeholder')} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <details className="seclog-fold" data-fold="">
        <summary className="set-fold">{t(ui, 'settings.security.filter')}{filters ? ` (${filters})` : ''}</summary>
        <div className="seclog-filters">
          <label className="f"><span>{t(ui, 'settings.security.filter_kind')}</span>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="">{t(ui, 'settings.security.every_kind')}</option>
              {SECURITY_GROUPS.map(([g, kinds]) => <optgroup key={g} label={securityGroupWords(g, ui)}>{kinds.map((k) => <option key={k} value={k}>{securityKindWords(k, ui)}</option>)}</optgroup>)}
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
        </div>
      </details>
      <div className="row wrap seclog-actions">
        {filtered && <button type="button" className="btn" onClick={clear}>{t(ui, 'settings.security.clear')}</button>}
        <button type="button" className="btn" aria-label={t(ui, 'settings.security.download_label')} onClick={() => void download().catch(oops)}>{t(ui, 'settings.security.download')}</button>
      </div>
      {answer('download', true)}

      {page && rows.length === 0 && <p className="muted" role="status">{filtered ? t(ui, 'settings.security.none_filtered') : t(ui, 'settings.security.none')}</p>}
      <ul className="ways seclog-list" aria-label={t(ui, 'settings.security.list_label')}>
        {rows.map((r) => {
          const detail = securityDetail(r.kind, r.details, ui).join(' ');
          return (
            <li key={r.seq}>
              <div className="what">
                <b>{securityKindWords(r.kind, ui)}</b>{r.outcome === 'failure' && <> <span className="badge declined">{t(ui, 'settings.security.failed')}</span></>}
                <div className="muted small seclog-detail">{fmtDate(r.at, true)}. {who(r)}.</div>
                {detail && <div className="muted small seclog-detail">{detail}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {next && <button className="btn" style={{ marginTop: 10 }} onClick={showOlder}>{t(ui, 'settings.security.older')}</button>}

      <details className="set-more seclog-more" data-more="item">
        <summary>{t(ui, 'settings.security.more')}</summary>
        <div className="set-more-body">
          <h3 id="seclog-alerts-h" className="seclog-h3">{t(ui, 'settings.security.alerts_title')}</h3>
          <p className="muted small">{t(ui, 'settings.security.alerts_what')}</p>
          <div role="group" aria-labelledby="seclog-alerts-h">
            {s.alerts.map((a) => (
              <label key={a.id} className="setting-row">
                <input type="checkbox" checked={a.on} disabled={busy} onChange={(e) => void act(`alert:${a.id}`, () => api('/account/security', { method: 'PATCH', body: { alerts: { [a.id]: e.target.checked } } }), t(ui, 'settings.security.saved'))} />
                <span>{securityAlertWords(a.id, ui)} {answer(`alert:${a.id}`)}</span>
              </label>
            ))}
          </div>

          <details className="seclog-fold" data-fold="" onToggle={(e) => setSiem(e.currentTarget.open)}>
            <summary className="set-fold">{t(ui, 'settings.security.siem_title')}</summary>
            {siem && <>
            <p className="muted small">{t(ui, 'settings.security.pull')}</p>
            <p className="mono small seclog-detail">{s.pull_url}</p>
            <div className="row wrap seclog-actions">
              <button type="button" className="btn" onClick={() => void copy('pull', s.pull_url)}>{t(ui, 'settings.security.copy')}</button>
              <a className="seclog-link" href="/developers#security-record">{t(ui, 'settings.security.pull_how')}</a>
              {answer('pull')}
            </div>
            {/* The people who run this server may let it send to some hosts only, or to none: then there is no form. */}
            {!(Array.isArray(s.webhook_hosts) && s.webhook_hosts.length === 0) && (
              <>
                <p className="muted small" style={{ marginTop: 14 }}>{t(ui, 'settings.security.webhook_what')}{Array.isArray(s.webhook_hosts) ? ` ${t(ui, 'settings.security.webhook_only', { hosts: s.webhook_hosts.join(', ') })}` : ''}</p>
                {s.webhooks.length > 0 && (
                  <ul className="ways">
                    {s.webhooks.map((h) => (
                      <li key={h.id}>
                        <div className="what"><b>{h.host}</b><div className="muted small">{t(ui, 'settings.security.webhook_since', { day: fmtDate(h.created_at) })}</div></div>
                        <button className="btn" disabled={busy} aria-label={t(ui, 'settings.security.webhook_remove_label', { host: h.host })} onClick={() => void act('hook', () => (setSecret(''), api(`/webhooks/${h.id}`, { method: 'DELETE' })), t(ui, 'settings.security.webhook_removed', { host: h.host }))}>{t(ui, 'settings.security.webhook_remove')}</button>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="row wrap" style={{ marginTop: 8 }} onSubmit={(e) => (e.preventDefault(), void addHook())}>
                  <input type="url" required placeholder="https://siem.example.com/hooks/growsigning" value={hook} onChange={(e) => setHook(e.target.value)} aria-label={t(ui, 'settings.security.webhook_label')} style={{ flex: '1 1 240px', minHeight: 44 }} />
                  <button className="btn" style={{ minHeight: 44 }} disabled={busy}>{t(ui, 'settings.security.webhook_add')}</button>
                </form>
                {answer('hook', true)}
                {secret && (
                  <div className="row wrap seclog-actions">
                    <span className="small">{t(ui, 'settings.security.webhook_added')}</span>
                    <span className="mono small seclog-detail">{secret}</span>
                    <button type="button" className="btn" onClick={() => void copy('secret', secret)}>{t(ui, 'settings.security.copy_secret')}</button>
                  </div>
                )}
                {answer('secret')}
              </>
            )}
            <label className="setting-row" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={s.emails} disabled={busy} onChange={(e) => void act('emails', () => api('/account/security', { method: 'PATCH', body: { emails: e.target.checked } }), t(ui, 'settings.security.saved'))} />
              <span>{t(ui, 'settings.security.emails')} {answer('emails')}<span className="muted small" style={{ display: 'block' }}>{t(ui, 'settings.security.emails_hint')}</span></span>
            </label>
            </>}
          </details>
        </div>
      </details>
    </section>
  );
}
