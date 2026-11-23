'use client';
// Settings, Sending, More options: "Your consent text" (research/ux-notes.json, ds-consent-own). For admins. The
// account's own words for the screen where a person agrees to sign on screen, shown there under our own sentence,
// which always stays. Off until a text is saved: a new account sees one card here and nothing anywhere else.
//
// One card of text boxes with one Save (not the page's main button: research/ux-charter.md P5). Every save that
// changes a word makes a new version, and the versions are listed under "Earlier versions". "Ask people to agree"
// (once for each document, or every time the link is opened) saves as soon as it changes, and is there only while a
// text is shown and the form is closed. The language list is there only with two languages.
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { languageOf } from '@/lib/i18n';
import { OWN_TEXT_MAX, DEFAULT_NEEDS, HOW_OFTEN, ownTextProblem, type OwnTextFields } from '@/lib/disclosure';
import { useST, senderRich } from '@/components/senderLang';
// The same markup as on the signing page, so "See what signers read" is what they read.
import { OwnTextWords, readTermsLabel } from '@/components/sign/OwnTerms';
import { useSaved } from './Frame';

const EMPTY: OwnTextFields = { org: '', email: '', phone: '', address: '', paper: '', paper_cost: '', withdraw: '', needs: '', other: '' };
const TALL = { minHeight: 44 };
// Day, month, year ("21 Nov 2026"), the way every date in the app reads.
const day = (at: string) => fmtDate(at);
const langName = (tag: string) => languageOf(tag)?.own || tag;
const pick = (v: any): OwnTextFields => Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(v?.[k] ?? '')])) as OwnTextFields;

export function Disclosure() {
  const me = useMe();
  const T = useST();
  const label = (k: keyof OwnTextFields) => T(`disclosure.label.${k}`);
  const [state, setState] = useState<any>(null);
  const [failed, setFailed] = useState('');
  const [lang, setLang] = useState('en');
  const [f, setF] = useState<OwnTextFields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [oftenSaid, oftenSaved] = useSaved();
  const [versions, setVersions] = useState<any[] | null>(null);
  // The form opens from one button, so Sending's More options holds one line for this until someone writes a text.
  const [editing, setEditing] = useState(false);
  const admin = me.role === 'owner' || me.role === 'admin';

  const take = useCallback((s: any, tag: string) => {
    setState(s);
    setF(pick(s.texts?.[tag]));
  }, []);
  useEffect(() => {
    if (!admin) return;
    api('/account/disclosure').then((s) => take(s, 'en')).catch((e: any) => setFailed(e?.code || e?.message ? T.error(e) : T('settings.own.load_failed')));
  }, [admin, take]);
  if (!admin) return null;

  const shown = state?.texts?.[lang] || null;
  const many = (state?.languages?.length || 0) > 1;
  const set = (k: keyof OwnTextFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => (setF({ ...f, [k]: e.target.value }), setError(''), setSaid(''));
  const send = async (body: any, done: (r: any) => string) => {
    setBusy(true);
    setError('');
    setSaid('');
    try {
      const r = await api('/account/disclosure', { method: 'PUT', body: { language: lang, ...body } });
      take(r, lang);
      setVersions(null);
      setSaid(done(r));
      setEditing(false);
    } catch (e: any) {
      setError(e?.status ? T.error(e) : T('settings.own.offline'));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const wrong = ownTextProblem(f);
    if (wrong) return setError(wrong);
    void send({ text: f }, (r) => (r.unchanged ? T('settings.own.unchanged') : T('settings.own.saved', { version: String(r.saved?.version) })));
  };
  const stop = () => void send({ text: null }, () => T('settings.own.stopped'));
  const often = (v: string) => api('/account/disclosure', { method: 'PUT', body: { each_visit: v === 'each' } }).then((r) => (setState(r), oftenSaved())).catch((e: any) => setError(e?.code || e?.message ? T.error(e) : T('settings.own.not_saved')));
  const openVersions = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!(e.target as HTMLDetailsElement).open || versions) return;
    api('/account/disclosure/versions').then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  };
  const box = (k: keyof OwnTextFields, rows: number, hint?: string, placeholder?: string) => (
    <label className="f"><span>{label(k)}{hint ? <> <span className="hint">({hint})</span></> : null}</span>
      {rows > 1
        ? <textarea dir="auto" rows={rows} maxLength={OWN_TEXT_MAX[k]} value={f[k]} placeholder={placeholder} onChange={set(k)} />
        : <input dir="auto" style={TALL} maxLength={OWN_TEXT_MAX[k]} value={f[k]} placeholder={placeholder} autoComplete="off" onChange={set(k)} />}
    </label>
  );

  return (
    <section className="card own-text" aria-labelledby="set-own-h" data-item="card" data-feature="ds-consent-own">
      <h2 id="set-own-h" style={{ marginBottom: 6 }}>{T('settings.own.title')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{T('disclosure.is')}</p>
      {failed && <div className="notice err" role="alert">{failed}</div>}
      {state && (
        <div>
          <p className="own-state" role="status">
            {shown ? senderRich(T.lang, shown.saved_by ? 'settings.own.shown_by' : 'settings.own.shown', { label: <b>{T('settings.own.shown_label')}</b> }, { version: String(shown.version), day: day(shown.saved_at), who: shown.saved_by || '' }) : senderRich(T.lang, 'settings.own.not_shown', { label: <b>{T('settings.own.not_shown_label')}</b> })}
          </p>
          {many && (
            <label className="f"><span>{T('settings.own.language')}</span>
              <select style={TALL} value={lang} onChange={(e) => (setLang(e.target.value), setF(pick(state.texts?.[e.target.value])), setError(''), setSaid(''))}>
                {state.languages.map((tag: string) => <option key={tag} value={tag} lang={tag}>{state.texts?.[tag] ? langName(tag) : T('settings.own.no_text_yet', { language: langName(tag) })}</option>)}
              </select>
              <span className="hint">{T('settings.own.language_hint')}</span>
            </label>
          )}
          {!editing && error && <div className="notice err" role="alert">{error}</div>}
          {!editing ? (
            <div className="row wrap own-actions">
              <button type="button" className="btn" style={TALL} onClick={() => (setEditing(true), setSaid(''), setError(''))}>{T(shown ? 'settings.own.change' : 'settings.own.write')}</button>
              <span role="status" className="set-saved">{said}</span>
            </div>
          ) : (
            <form noValidate onSubmit={(e) => (e.preventDefault(), save())}>
              <label className="f"><span>{label('org')}</span>
                {/* The form was opened on purpose, so the first box takes the focus. */}
                <input dir="auto" style={TALL} autoFocus maxLength={OWN_TEXT_MAX.org} value={f.org} autoComplete="off" onChange={set('org')} />
              </label>
              <fieldset className="own-reach">
                <legend>{T('settings.own.reach')} <span className="hint">{T('settings.own.at_least_one')}</span></legend>
                <div className="grid g3">{box('email', 1)}{box('phone', 1)}{box('address', 1)}</div>
              </fieldset>
              {box('paper', 3)}
              {box('paper_cost', 1, T('settings.own.hint_free'))}
              {box('withdraw', 3)}
              {box('needs', 2, T('settings.own.hint_needs'), DEFAULT_NEEDS)}
              {box('other', 4, T('settings.own.hint_optional'))}
              {error && <div className="notice err" role="alert">{error}</div>}
              <div className="row wrap own-actions">
                <button className="btn" style={TALL} disabled={busy}>{T(busy ? 'settings.saving' : 'settings.save')}</button>
                <button type="button" className="btn ghost" style={TALL} disabled={busy} onClick={() => (setEditing(false), setF(pick(shown)), setError(''))}>{T('settings.cancel')}</button>
                {shown && <button type="button" className="btn ghost" style={TALL} disabled={busy} onClick={stop}>{T('settings.own.stop')}</button>}
              </div>
            </form>
          )}
          {/* How often: only while a text is shown, since with none our screen is asked once for each document. */}
          {shown && !editing && (
            <label className="f own-often"><span>{T('settings.own.how_often')} {oftenSaid}</span>
              <select style={TALL} value={state.each_visit ? 'each' : 'once'} onChange={(e) => often(e.target.value)}>
                {HOW_OFTEN.map(([v]) => <option key={v} value={v}>{T(`disclosure.often.${v}`)}</option>)}
              </select>
            </label>
          )}
          <p className="muted small">{T('disclosure.esign_note')}</p>
          {shown && (
            <details data-fold="">
              <summary className="set-fold">{T('settings.own.see')}</summary>
              <p className="muted small">{T('settings.own.where', { link: readTermsLabel(shown.language || 'en', shown.org) })}</p>
              <OwnTextWords sections={shown.sections} lang={shown.language} />
            </details>
          )}
          {state.has_versions && (
            <details data-fold="" onToggle={openVersions}>
              <summary className="set-fold">{T('settings.own.versions')}</summary>
              <p className="muted small">{T('settings.own.versions_note')}</p>
              {!versions ? <p className="muted small">{T('settings.loading')}</p> : (
                <ul className="own-versions">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <details data-fold="">
                        <summary className="set-fold own-version">{T(v.saved_by ? 'settings.own.version_by' : 'settings.own.version', { version: String(v.version), language: many ? `, ${langName(v.language)}` : '', day: day(v.saved_at), who: v.saved_by || '' })}{v.shown_now ? ` ${T('settings.own.shown_now')}` : ''}</summary>
                        <p className="muted small">{v.documents === 0 ? T('settings.own.nobody_agreed') : T('settings.own.agreed', { count: v.documents })}</p>
                        <OwnTextWords sections={v.sections} lang={v.language} />
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
