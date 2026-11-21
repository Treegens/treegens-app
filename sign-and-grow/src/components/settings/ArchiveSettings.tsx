'use client';
// Settings, Records and data: "Copies of every email" (src/server/routes-archive.ts). An admin names up to five
// addresses, a records office or a freedom-of-information team, that get a copy of every email the account sends
// about its documents. Each is asked by email first and gets nothing until someone with that inbox confirms it.
// Admins see how each one stands, send its link again, or remove it; a member reads only that copies go somewhere.
// The rules are in src/lib/archivemail.ts, which the server and the emails use too. The card follows the designer's
// note (research/ux-notes.json, "ds-mail-records"): one line of explanation, no expander, no filled button.
import { useEffect, useRef, useState } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { ARCHIVE_MAX_ADDRESSES, ARCHIVE_BOUNCES_TO_PAUSE, ARCHIVE_ONE_LINE, archiveAddress } from '@/lib/archivemail';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

// The sender's own screens are in English until they are translated, as in LanguageSettings.
const ui = SOURCE_LOCALE;
const TAP = { minHeight: 44 };
const CARD = { 'data-item': 'card', 'data-feature': 'ds-mail-records' };

function stateLine(a: any): string {
  if (a.state === 'waiting') return t(ui, 'settings.archive.waiting', { until: fmtDate(a.link_works_until) });
  if (a.state === 'expired') return t(ui, 'settings.archive.expired');
  if (a.state === 'paused') return a.paused_why === 'spam' ? t(ui, 'settings.archive.paused_spam', { day: fmtDate(a.paused_at) }) : t(ui, 'settings.archive.paused_bounced', { day: fmtDate(a.paused_at), n: ARCHIVE_BOUNCES_TO_PAUSE });
  return t(ui, 'settings.archive.confirmed', { day: fmtDate(a.confirmed_at), count: a.copies });
}

export function ArchiveSettings() {
  const me = useMe();
  const [data, reload, failed] = useLoad<any>(() => api('/account/archive-addresses'), []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  // Keyboard and screen reader: a pressed button is never switched off under the finger (the focus would fall to the
  // top of the page), a second press while one is on its way is ignored, and after a change the focus goes to the
  // field for the next address, or to the line that says the list is full.
  const working = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const fullLine = useRef<HTMLParagraphElement>(null);
  const [refocus, setRefocus] = useState(0);
  const count = data?.addresses?.length ?? 0;
  useEffect(() => {
    if (refocus) (field.current || fullLine.current)?.focus();
  }, [refocus, count]);
  if (failed) return me.role === 'member' ? null : <section className="card" style={{ marginTop: 16 }} {...CARD}><h2>{t(ui, 'settings.archive.title')}</h2><p className="notice err" role="alert">{failed.message || t(ui, 'settings.archive.load_failed')}</p></section>;
  if (!data) return null;
  // A member: one line when copies go somewhere, because their emails are copied too. Nothing otherwise.
  if (me.role === 'member' || !data.addresses) return data.taking ? <section className="card" style={{ marginTop: 16 }} aria-labelledby="archive-h" {...CARD}><h2 id="archive-h">{t(ui, 'settings.archive.title')}</h2><p className="muted" style={{ margin: 0 }}>{t(ui, 'settings.archive.member', { count: data.taking })} {ARCHIVE_ONE_LINE}</p></section> : null;

  const act = async (key: string, call: () => Promise<any>, after?: () => void) => {
    if (working.current) return;
    working.current = true;
    setBusy(key);
    setSaid(null);
    try {
      const r = await call();
      setSaid({ text: r.message });
      after?.();
      reload();
    } catch (e: any) {
      setSaid({ text: e?.status ? e.message : t(ui, 'settings.archive.offline'), err: true });
    } finally {
      working.current = false;
      setBusy('');
    }
  };
  const again = (address: string) => act(address, () => api('/account/archive-addresses', { body: { email: address } }));
  const add = () => {
    if (!email.trim()) return field.current?.focus();
    // Said in the card, in our words, and not only in the browser's own bubble.
    if (!archiveAddress(email)) return (setSaid({ text: t(ui, 'settings.archive.bad_address'), err: true }), field.current?.focus());
    act('add', () => api('/account/archive-addresses', { body: { email: email.trim() } }), () => (setEmail(''), setRefocus((n) => n + 1))).then(() => field.current?.focus());
  };
  const remove = (a: any) => window.confirm(t(ui, 'settings.archive.remove_confirm', { email: a.email })) && act(a.id, () => api(`/account/archive-addresses/${a.id}`, { method: 'DELETE' }), () => setRefocus((n) => n + 1));
  const full = data.addresses.length >= data.max;

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="archive-h" {...CARD}>
      <h2 id="archive-h" style={{ marginBottom: 8 }}>{t(ui, 'settings.archive.title')}</h2>
      <p className="muted small">{t(ui, 'settings.archive.lead', { max: ARCHIVE_MAX_ADDRESSES })} {ARCHIVE_ONE_LINE}</p>

      {data.addresses.length > 0 && (
        <ul aria-label={t(ui, 'settings.archive.list_label')} style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {data.addresses.map((a: any) => (
            <li key={a.id} style={{ borderTop: '1px solid var(--line, #e4dfd3)', padding: '10px 0' }}>
              <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{a.email}</div>
              <div className={`small${a.state === 'paused' ? '' : ' muted'}`}>{stateLine(a)}</div>
              {a.missed > 0 && <div className="small">{t(ui, 'settings.archive.missed', { count: a.missed })}</div>}
              {a.problem && a.state !== 'paused' && <div className="small">{a.problem}</div>}
              {data.may_change && (
                <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                  {a.state !== 'confirmed' && <button type="button" className="btn sm" style={TAP} aria-busy={busy === a.email} onClick={() => again(a.email)} aria-label={t(ui, 'settings.archive.resend_for', { email: a.email })}>{t(ui, 'settings.archive.resend')}</button>}
                  <button type="button" className="btn sm ghost" style={TAP} aria-busy={busy === a.id} onClick={() => remove(a)} aria-label={t(ui, 'settings.archive.remove_for', { email: a.email })}>{t(ui, 'settings.archive.remove')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(data.refused || []).map((r: any) => <p key={r.email} className="small muted" style={{ overflowWrap: 'anywhere' }}>{t(ui, r.why === 'spam' ? 'settings.archive.refused_spam' : 'settings.archive.refused', { email: r.email, until: fmtDate(r.can_ask_again_at) })}</p>)}

      {data.may_change && (full ? <p ref={fullLine} tabIndex={-1} className="small muted">{t(ui, 'settings.archive.full', { max: data.max })}</p> : (
        <form noValidate onSubmit={(e) => (e.preventDefault(), add())} className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="f" style={{ flex: '1 1 220px', margin: 0, minWidth: 0 }}><span>{t(ui, 'settings.archive.add_label')}</span>
            <input ref={field} type="email" inputMode="email" autoComplete="off" value={email} aria-invalid={said?.err && !!email ? true : undefined} onChange={(e) => (setEmail(e.target.value), setSaid(null))} style={TAP} />
          </label>
          <button type="submit" className="btn" style={TAP} aria-busy={busy === 'add'}>{busy === 'add' ? t(ui, 'settings.archive.sending') : t(ui, 'settings.archive.add_button')}</button>
        </form>
      ))}
      {said && <p className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'} style={{ marginTop: 12, marginBottom: 0 }}>{said.text}</p>}
    </section>
  );
}
