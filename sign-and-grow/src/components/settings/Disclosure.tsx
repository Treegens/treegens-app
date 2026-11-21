'use client';
// Settings, Sending, More options: "Your consent text" (research/ux-notes.json, ds-consent-own). For admins. The
// account's own words for the screen where a person agrees to sign on screen, shown there under our own sentence,
// which always stays. Off until a text is saved: a new account sees one card here and nothing anywhere else.
//
// One card of text boxes with one Save (not the page's main button: research/ux-charter.md P5). Every save that
// changes a word makes a new version, and the versions are listed under "Earlier versions". "How often" saves as
// soon as it changes, and is there only while a text is shown. The language list is there only with two languages.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { languageOf } from '@/lib/i18n';
import { OWN_TEXT_MAX, OWN_TEXT_LABEL, OWN_TEXT_IS, ESIGN_NOTE, DEFAULT_NEEDS, HOW_OFTEN, ownTextProblem, type OwnTextFields, type OwnSection } from '@/lib/disclosure';
import { useSaved } from './Frame';

const EMPTY: OwnTextFields = { org: '', email: '', phone: '', address: '', paper: '', paper_cost: '', withdraw: '', needs: '', other: '' };
const TALL = { minHeight: 44 };
const day = (at: string) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const langName = (tag: string) => languageOf(tag)?.own || tag;
const pick = (v: any): OwnTextFields => Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(v?.[k] ?? '')])) as OwnTextFields;

/** The text as a signer reads it. The same markup as on the signing page (sign/OwnTerms.tsx). */
export function OwnTextWords({ sections }: { sections: OwnSection[] }) {
  return (
    <div className="own-words">
      {sections.map((s) => (
        <div key={s.h} className="own-part">
          <b>{s.h}</b>
          {s.lines.map((l, i) => <p key={i} dir="auto">{l}</p>)}
        </div>
      ))}
    </div>
  );
}

export function Disclosure() {
  const me = useMe();
  const [state, setState] = useState<any>(null);
  const [failed, setFailed] = useState('');
  const [lang, setLang] = useState('en');
  const [f, setF] = useState<OwnTextFields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [oftenSaid, oftenSaved] = useSaved();
  const [versions, setVersions] = useState<any[] | null>(null);
  const admin = me.role === 'owner' || me.role === 'admin';

  const take = useCallback((s: any, tag: string) => {
    setState(s);
    setF(pick(s.texts?.[tag]));
  }, []);
  useEffect(() => {
    if (!admin) return;
    api('/account/disclosure').then((s) => take(s, 'en')).catch((e: any) => setFailed(e?.message || 'This could not be loaded. Check your connection and open Settings again.'));
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
    } catch (e: any) {
      setError(e?.status ? e.message : 'Not saved: this device seems to be offline. Check the connection and save again.');
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const wrong = ownTextProblem(f);
    if (wrong) return setError(wrong);
    void send({ text: f }, (r) => (r.unchanged ? 'Nothing changed, so no new version was made.' : `Saved as version ${r.saved?.version}. People who open a document from now on see it.`));
  };
  const stop = () => void send({ text: null }, () => 'Stopped. Signers now see only our own words. Your versions are kept.');
  const often = (v: string) => api('/account/disclosure', { method: 'PUT', body: { each_visit: v === 'each' } }).then((r) => (setState(r), oftenSaved())).catch((e: any) => setError(e?.message || 'Not saved. Try again.'));
  const openVersions = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!(e.target as HTMLDetailsElement).open || versions) return;
    api('/account/disclosure/versions').then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  };
  const box = (k: keyof OwnTextFields, rows: number, hint?: string, placeholder?: string) => (
    <label className="f"><span>{OWN_TEXT_LABEL[k]}{hint ? <> <span className="hint">({hint})</span></> : null}</span>
      {rows > 1
        ? <textarea dir="auto" rows={rows} maxLength={OWN_TEXT_MAX[k]} value={f[k]} placeholder={placeholder} onChange={set(k)} />
        : <input dir="auto" style={TALL} maxLength={OWN_TEXT_MAX[k]} value={f[k]} placeholder={placeholder} autoComplete="off" onChange={set(k)} />}
    </label>
  );

  return (
    <section className="card own-text" aria-labelledby="set-own-h" data-item="card" data-feature="ds-consent-own">
      <h2 id="set-own-h" style={{ marginBottom: 6 }}>Your consent text</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{OWN_TEXT_IS}</p>
      {failed && <div className="notice err" role="alert">{failed}</div>}
      {state && (
        <form noValidate onSubmit={(e) => (e.preventDefault(), save())}>
          <p className="own-state" role="status">
            {shown ? <><b>Shown to signers now:</b> version {shown.version}, saved {day(shown.saved_at)}{shown.saved_by ? ` by ${shown.saved_by}` : ''}.</> : <><b>Not shown.</b> Signers see only our own words. Fill this in and save to add yours.</>}
          </p>
          {many && (
            <label className="f"><span>Language of this text</span>
              <select style={TALL} value={lang} onChange={(e) => (setLang(e.target.value), setF(pick(state.texts?.[e.target.value])), setError(''), setSaid(''))}>
                {state.languages.map((tag: string) => <option key={tag} value={tag} lang={tag}>{langName(tag)}{state.texts?.[tag] ? '' : ' (no text yet)'}</option>)}
              </select>
              <span className="hint">Someone whose language has no text reads your English one. With no English one they see only our words.</span>
            </label>
          )}
          {box('org', 1)}
          <fieldset className="own-reach">
            <legend>How to reach you <span className="hint">(at least one)</span></legend>
            <div className="grid g3">{box('email', 1)}{box('phone', 1)}{box('address', 1)}</div>
          </fieldset>
          {box('paper', 3)}
          {box('paper_cost', 1, 'write Free if it costs nothing')}
          {box('withdraw', 3)}
          {box('needs', 2, 'left empty, signers read our sentence', DEFAULT_NEEDS)}
          {box('other', 4, 'optional')}
          {error && <div className="notice err" role="alert">{error}</div>}
          <div className="row wrap own-actions">
            <button className="btn" style={TALL} disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
            {shown && <button type="button" className="btn ghost" style={TALL} disabled={busy} onClick={stop}>Stop showing it</button>}
            <span role="status" className="set-saved">{said}</span>
          </div>
          {shown && (
            <label className="f own-often"><span>Ask people to agree {oftenSaid}</span>
              <select style={TALL} value={state.each_visit ? 'each' : 'once'} onChange={(e) => void often(e.target.value)}>
                {HOW_OFTEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          )}
          <p className="muted small">{ESIGN_NOTE}</p>
          {shown && (
            <details data-fold="">
              <summary className="set-fold">See what signers read</summary>
              <p className="muted small">On the signing page this opens under "Read {shown.org}'s terms", above the box they tick.</p>
              <OwnTextWords sections={shown.sections} />
            </details>
          )}
          {state.has_versions && (
            <details data-fold="" onToggle={openVersions}>
              <summary className="set-fold">Earlier versions</summary>
              <p className="muted small">Every save is kept as it was, so a signing record can always be read back. A version cannot be changed or deleted here.</p>
              {!versions ? <p className="muted small">Loading</p> : (
                <ul className="own-versions">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <details data-fold="">
                        <summary className="set-fold own-version">Version {v.version}{many ? `, ${langName(v.language)}` : ''}, saved {day(v.saved_at)}{v.saved_by ? ` by ${v.saved_by}` : ''}{v.shown_now ? ' (shown now)' : ''}</summary>
                        <p className="muted small">{v.documents === 0 ? 'Nobody has agreed next to this version yet.' : `People agreed next to this version on ${v.documents} ${v.documents === 1 ? 'document' : 'documents'}.`}</p>
                        <OwnTextWords sections={v.sections} />
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </form>
      )}
    </section>
  );
}
