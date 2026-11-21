'use client';
// Settings, Account: archive addresses (src/server/routes-archive.ts). An admin names up to five addresses, a records
// office or a freedom-of-information team, that get a copy of every email the account sends about its documents.
// Each is asked by email first and gets nothing until someone with that inbox confirms it. Admins see how each one
// stands, send its link again, or remove it; a member reads only that copies go somewhere. The rules and the long
// sentences are in src/lib/archivemail.ts, which the server and the emails use too.
import { useState } from 'react';
import { api, useLoad, toast, oops, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { ARCHIVE_WHAT, ARCHIVE_LIMITS, ARCHIVE_MAX_ADDRESSES } from '@/lib/archivemail';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

// The sender's own screens are in English until they are translated, as in LanguageSettings.
const ui = SOURCE_LOCALE;
const TAP = { minHeight: 44 };

function stateLine(a: any): string {
  if (a.state === 'waiting') return t(ui, 'settings.archive.waiting', { sent: fmtDate(a.link_sent_at, true), until: fmtDate(a.link_works_until, true) });
  if (a.state === 'expired') return t(ui, 'settings.archive.expired');
  if (a.state === 'paused') return t(ui, a.paused_why === 'spam' ? 'settings.archive.paused_spam' : 'settings.archive.paused_bounced', { day: fmtDate(a.paused_at) });
  return t(ui, 'settings.archive.confirmed', { day: fmtDate(a.confirmed_at) });
}

export function ArchiveSettings() {
  const me = useMe();
  const [data, reload, failed] = useLoad<any>(() => api('/account/archive-addresses'), []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  if (failed) return <section className="card" style={{ marginTop: 16 }}><h2>{t(ui, 'settings.archive.title')}</h2><p className="notice err" role="alert">{failed.message || t(ui, 'settings.archive.load_failed')}</p></section>;
  if (!data) return null;
  // A member: one line when copies go somewhere, nothing otherwise. Account() above says who changes settings.
  if (me.role === 'member' || !data.addresses) return data.taking ? <section className="card" style={{ marginTop: 16 }} aria-labelledby="archive-h"><h2 id="archive-h">{t(ui, 'settings.archive.title')}</h2><p className="muted" style={{ margin: 0 }}>{t(ui, 'settings.archive.member', { count: data.taking })}</p></section> : null;

  const add = async (address: string, again = false) => {
    setBusy(again ? address : 'add');
    setSaid(null);
    try {
      const r = await api('/account/archive-addresses', { body: { email: address } });
      setSaid({ text: r.message });
      if (!again) setEmail('');
      reload();
    } catch (e: any) {
      setSaid({ text: e?.status ? e.message : t(ui, 'settings.archive.offline'), err: true });
    } finally {
      setBusy('');
    }
  };
  const remove = (a: any) => {
    if (!window.confirm(t(ui, 'settings.archive.remove_confirm', { email: a.email }))) return;
    setBusy(a.id);
    api(`/account/archive-addresses/${a.id}`, { method: 'DELETE' }).then((r) => (toast(r.message), reload())).catch(oops).finally(() => setBusy(''));
  };
  const full = data.addresses.length >= data.max;

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="archive-h">
      <h2 id="archive-h" style={{ marginBottom: 8 }}>{t(ui, 'settings.archive.title')}</h2>
      <p className="muted small">{t(ui, 'settings.archive.lead', { max: ARCHIVE_MAX_ADDRESSES })}</p>
      <details style={{ margin: '0 0 12px' }}>
        <summary style={{ ...TAP, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>{t(ui, 'settings.archive.what_title')}</summary>
        <p className="small">{ARCHIVE_WHAT}</p>
        <p className="small">{ARCHIVE_LIMITS}</p>
      </details>
      {!data.bounce_news && <p className="muted small">{t(ui, 'settings.archive.no_news')}</p>}

      {data.addresses.length ? (
        <ul aria-label={t(ui, 'settings.archive.list_label')} style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {data.addresses.map((a: any) => (
            <li key={a.id} style={{ borderTop: '1px solid var(--line, #e4dfd3)', padding: '10px 0' }}>
              <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{a.email}</div>
              <div className={`small${a.state === 'paused' ? '' : ' muted'}`} role={a.state === 'paused' ? 'status' : undefined}>{stateLine(a)}</div>
              {a.state === 'confirmed' && <div className="small muted">{t(ui, 'settings.archive.copies', { count: a.copies })}{a.last_copy_at ? ` ${t(ui, 'settings.archive.last', { day: fmtDate(a.last_copy_at, true) })}` : ''}</div>}
              {a.missed > 0 && <div className="small">{t(ui, 'settings.archive.missed', { count: a.missed })}</div>}
              {a.problem && <div className="small">{t(ui, 'settings.archive.problem', { problem: a.problem, day: fmtDate(a.problem_at, true) })}</div>}
              <div className="small muted">{t(ui, a.added_by ? 'settings.archive.added_by' : 'settings.archive.added', { name: a.added_by || '', day: fmtDate(a.added_at) })}</div>
              {data.may_change && (
                <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                  {a.state !== 'confirmed' && <button type="button" className="btn sm" style={TAP} disabled={!!busy} onClick={() => add(a.email, true)} aria-label={t(ui, 'settings.archive.resend_for', { email: a.email })}>{t(ui, 'settings.archive.resend')}</button>}
                  <button type="button" className="btn sm ghost" style={TAP} disabled={!!busy} onClick={() => remove(a)} aria-label={t(ui, 'settings.archive.remove_for', { email: a.email })}>{t(ui, 'settings.archive.remove')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t(ui, 'settings.archive.none')}</p>}
      {(data.refused || []).map((r: any) => <p key={r.email} className="small muted" style={{ overflowWrap: 'anywhere' }}>{t(ui, 'settings.archive.refused', { email: r.email, day: fmtDate(r.at), until: fmtDate(r.can_ask_again_at) })}</p>)}

      {data.may_change && (full ? <p className="small">{t(ui, 'settings.archive.full', { max: data.max })}</p> : (
        <form onSubmit={(e) => (e.preventDefault(), email.trim() && add(email.trim()))}>
          <label className="f"><span>{t(ui, 'settings.archive.add_label')}</span>
            <input type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="records@example.org" aria-describedby="archive-add-hint" style={TAP} />
          </label>
          <p id="archive-add-hint" className="muted small">{t(ui, 'settings.archive.add_hint')}</p>
          <button type="submit" className="btn primary" style={TAP} disabled={!!busy || !email.trim()}>{busy === 'add' ? t(ui, 'settings.archive.sending') : t(ui, 'settings.archive.add_button')}</button>
        </form>
      ))}
      {said && <p className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'} style={{ marginTop: 12, marginBottom: 0 }}>{said.text}</p>}
    </section>
  );
}
