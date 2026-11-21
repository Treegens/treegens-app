'use client';
// Ready-made templates on the Templates page (src/lib/starters/, POST /api/starters/:id/use). A list inside the
// page, opened from "Start from a ready-made one" next to New template or in the empty list. Nothing is added to the
// account until someone picks one; picking asks for the words the document prints (their organisation's name, and
// for a few a partner or an event), makes a normal template and opens it in the editor.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, fmtDate, toast } from '../ui';
import { explain } from '../sender/lib';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;

type Ask = { key: string; label: string; max: number; example: string | null };
type Item = { id: string; title: string; purpose: string; place: string; reviewed_by: string | null; note: string; roles: string[]; asks: Ask[]; made: { id: string; subject: string; created_at: string }[] };

/** Under "Nothing matches" when a search finds no template of the account's own: the ready-made ones may have it. */
export function StartersLink({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="btn rmt-headlink" onClick={onOpen}>{t(ui, 'starters.open')}</button>;
}

// "Written for: Kenya." or, for one written for nowhere in particular, "Not written for any one country."
const placeLine = (place: string) => (/^no particular country$/i.test(place) ? t(ui, 'starters.place_none') : t(ui, 'starters.place', { place }));

/** The words for the empty list, with the names of the first few starters. */
export function StartersInvite({ onOpen }: { onOpen: () => void }) {
  return (
    <p className="rmt-invite">
      <button type="button" className="btn" onClick={onOpen}>{t(ui, 'starters.open')}</button>
      <span className="muted small">{t(ui, 'starters.examples')}</span>
    </p>
  );
}

export function Starters({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<{ organisation: string; starters: Item[] } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    api('/starters').then(setData).catch((e) => setError(explain(e)));
    head.current?.focus();
  }, []);
  const pick = (s: Item) => {
    setProblem('');
    if (open === s.id) return setOpen('');
    setOpen(s.id);
    // What was typed for one stays for the next: the organisation is the same in all of them.
    setValues((v) => ({ organisation: v.organisation ?? data?.organisation ?? '', ...v }));
    // Once the form is drawn: its first box gets the focus, and on a phone the whole form is brought into view.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById(`rmt-${s.id}-organisation`)?.focus({ preventScroll: true });
      document.getElementById(`rmt-form-${s.id}`)?.scrollIntoView({ block: 'nearest' });
    }));
  };
  async function make(s: Item) {
    const gap = s.asks.find((a) => !(values[a.key] || '').trim());
    if (gap) {
      setProblem(t(ui, 'starters.missing', { what: gap.label.charAt(0).toLowerCase() + gap.label.slice(1) }));
      return document.getElementById(`rmt-${s.id}-${gap.key}`)?.focus();
    }
    setBusy(true);
    setProblem('');
    try {
      const body = Object.fromEntries(s.asks.map((a) => [a.key, values[a.key] || '']));
      const r = await api(`/starters/${s.id}/use`, { body });
      toast(t(ui, 'starters.made'));
      router.push(r.edit_url);
    } catch (e) {
      setProblem(explain(e));
    } finally {
      setBusy(false);
    }
  }
  const preview = (s: Item) => `/api/starters/${s.id}/preview?${new URLSearchParams(Object.fromEntries(s.asks.map((a) => [a.key, values[a.key] || '']))).toString()}`;

  return (
    <section className="card rmt-list" aria-labelledby="rmt-head">
      <div className="rmt-top">
        <h2 id="rmt-head" ref={head} tabIndex={-1}>{t(ui, 'starters.title')}</h2>
        <button type="button" className="btn sm ghost" onClick={onClose}>{t(ui, 'starters.close')}</button>
      </div>
      {/* The note is said once here; a row repeats it only for a starter whose review or place is different. */}
      {data && data.starters[0] && <p className="small rmt-lead"><b>{data.starters[0].note} {placeLine(data.starters[0].place)}</b> {t(ui, 'starters.lead')}</p>}
      {error ? <div className="notice err" role="alert">{error}</div> : !data ? <p role="status" className="muted">{t(ui, 'starters.loading')}</p> : (
        <ul className="rmt-items">
          {data.starters.map((s) => (
            <li key={s.id} className={open === s.id ? 'on' : ''}>
              <div className="rmt-row">
                <div className="rmt-what">
                  <b>{s.title}</b>
                  <div className="small">{s.purpose}</div>
                  {(s.note !== data.starters[0].note || s.place !== data.starters[0].place) && <div className="muted small">{s.note} {placeLine(s.place)}</div>}
                  {s.made.length > 0 && (
                    <div className="small rmt-made">
                      {t(ui, 'starters.made_before', { date: fmtDate(s.made[0].created_at) })} <Link href={`/app/templates/${s.made[0].id}/edit`}>{t(ui, 'starters.open_made')}</Link>
                    </div>
                  )}
                </div>
                <button type="button" className="btn sm" aria-expanded={open === s.id} aria-controls={`rmt-form-${s.id}`} onClick={() => pick(s)} aria-label={open === s.id ? t(ui, 'starters.cancel_named', { title: s.title }) : t(ui, 'starters.use_named', { title: s.title })}>
                  {open === s.id ? t(ui, 'starters.cancel') : t(ui, 'starters.use')}
                </button>
              </div>
              {open === s.id && (
                <form id={`rmt-form-${s.id}`} className="rmt-form" onSubmit={(e) => (e.preventDefault(), make(s))}>
                  <p className="muted small">{t(ui, 'starters.form_lead')}</p>
                  {s.asks.map((a) => (
                    <label key={a.key} className="f">
                      <span>{a.label}</span>
                      <input id={`rmt-${s.id}-${a.key}`} value={values[a.key] || ''} maxLength={a.max} autoComplete={a.key === 'organisation' ? 'organization' : 'off'}
                        placeholder={a.example ? t(ui, 'starters.example', { example: a.example }) : undefined}
                        onChange={(e) => (setProblem(''), setValues({ ...values, [a.key]: e.target.value }))} />
                    </label>
                  ))}
                  <p className="muted small">{t(ui, 'starters.roles', { roles: s.roles.join(', ') })}</p>
                  {problem && <div className="notice err" role="alert">{problem}</div>}
                  <div className="actions">
                    <a className="btn" href={preview(s)} target="_blank" rel="noopener">{t(ui, 'starters.preview')}</a>
                    <button type="submit" className="btn primary" disabled={busy}>{busy ? t(ui, 'starters.making') : t(ui, 'starters.make')}</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The note in the editor of a template made from a ready-made one, as it was written the day it was made. */
export function StarterNote({ note }: { note?: string | null }) {
  if (!note) return null;
  return <div className="ed-banner rmt-note" role="note">{note} {t(ui, 'starters.editor_more')}</div>;
}
