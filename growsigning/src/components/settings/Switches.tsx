'use client';
// Settings, Sending: the rest of the card "When people sign" (owners and admins; drawn inside OwnDocsDefault.tsx), and under Stamps and seals the switch "Members
// may place stamps". GET and PUT /api/account/switches (src/server/routes-switches.ts). Each saves the moment it
// changes, with "Saved" next to it, and never changes a document that is already out. Every switch starts the way the
// product always worked (src/lib/switches.ts).
import { useState } from 'react';
import { api, useLoad, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { useSaved } from './Frame';
import { useST } from '@/components/senderLang';
import { SIGN_WAYS, WAY_LABELS, WAYS_NOTE, MARK_WORDS_DEFAULT, MARK_WORDS_MAX, markWordsProblem, type SignWay } from '@/lib/switches';

function useSwitches() {
  const me = useMe();
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const [d, reload] = useLoad<any>(() => (admin ? api('/account/switches').catch(() => null) : Promise.resolve(null)), [admin]);
  const put = (body: Record<string, unknown>, saved: () => void, undo?: () => void) =>
    api('/account/switches', { method: 'PUT', body }).then(() => (saved(), reload())).catch((e) => (undo?.(), oops(e), reload()));
  return { admin, d, put };
}

function Row({ id, title, hint, on, onChange, said }: { id: string; title: string; hint: string; on: boolean; onChange: (v: boolean) => void; said: React.ReactNode }) {
  return (
    <label className="setting-row" style={{ margin: '12px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={on} aria-labelledby={`${id}-t`} aria-describedby={`${id}-h`} onChange={(e) => onChange(e.target.checked)} style={{ width: 22, height: 22 }} />
      <span>
        <b id={`${id}-t`}>{title}</b> {said}
        <span className="muted small" id={`${id}-h`} style={{ display: 'block' }}>{hint}</span>
      </span>
    </label>
  );
}

export function WhenPeopleSign() {
  const T = useST();
  const { admin, d, put } = useSwitches();
  const [passSaid, passSaved] = useSaved();
  const [copySaid, copySaved] = useSaved();
  const [askSaid, askSaved] = useSaved();
  const [waysSaid, waysSaved] = useSaved();
  const [markSaid, markSaved] = useSaved();
  const [words, setWords] = useState<string | null>(null);
  const [wordsBad, setWordsBad] = useState('');
  if (!admin || !d) return null;
  const ways: SignWay[] = d.sign_ways;
  const flipWay = (w: SignWay, v: boolean) => {
    const next = SIGN_WAYS.filter((x) => (x === w ? v : ways.includes(x)));
    if (!next.length) return;
    put({ sign_ways: next }, waysSaved);
  };
  const shown = words ?? d.mark_words;
  const saveWords = () => {
    if (words === null) return;
    const w = words.replace(/\s+/g, ' ').trim();
    const no = markWordsProblem(w);
    if (no) return setWordsBad(no);
    setWordsBad('');
    if (w.toUpperCase() !== d.mark_words) put({ mark_words: w }, markSaved);
    setWords(null);
  };
  return (
    // Inside the card "When people sign" (OwnDocsDefault.tsx), under its first switch: no card or heading of its own.
    <div data-feature="ds-switches" style={{ borderTop: '1px solid var(--line, #e5e5e5)', marginTop: 16, paddingTop: 4 }}>
      <p className="muted small" style={{ margin: '12px 0 0' }}>{T('settings.switches.from_now')}</p>
      <Row id="sw-pass" title={T('settings.switches.pass')} on={d.pass_on} said={passSaid} onChange={(v) => put({ pass_on: v }, passSaved)}
        hint={T('settings.switches.pass_hint')} />
      {d.pass_on && (
        <div style={{ marginLeft: 32 }}>
          <Row id="sw-copy" title={T('settings.switches.copy')} on={d.pass_on_copy} said={copySaid} onChange={(v) => put({ pass_on_copy: v }, copySaved)}
            hint={T('settings.switches.copy_hint')} />
        </div>
      )}
      <Row id="sw-ask" title={T('settings.switches.ask')} on={d.comments} said={askSaid} onChange={(v) => put({ comments: v }, askSaved)}
        hint={T('settings.switches.ask_hint')} />
      <fieldset style={{ border: 0, padding: 0, margin: '16px 0 0' }} aria-describedby="sw-ways-h">
        <legend><b>{T('settings.switches.ways')}</b> {waysSaid}</legend>
        <div className="row wrap" style={{ gap: 16 }}>
          {SIGN_WAYS.map((w) => (
            <label key={w} className="check" style={{ minHeight: 44 }}>
              <input type="checkbox" checked={ways.includes(w)} disabled={ways.length === 1 && ways.includes(w)} onChange={(e) => flipWay(w, e.target.checked)} style={{ width: 20, height: 20 }} /> <span>{WAY_LABELS[w]}</span>
            </label>
          ))}
        </div>
        <span className="muted small" id="sw-ways-h" style={{ display: 'block' }}>{WAYS_NOTE} {T('settings.switches.ways_rest')}</span>
      </fieldset>
      <label className="f" style={{ marginTop: 16 }}><span><b>{T('settings.switches.mark')}</b> {markSaid}</span>
        <input value={shown} maxLength={MARK_WORDS_MAX} aria-invalid={!!wordsBad} aria-describedby={wordsBad ? 'sw-mark-bad sw-mark-h' : 'sw-mark-h'} placeholder={MARK_WORDS_DEFAULT}
          onChange={(e) => (setWords(e.target.value), setWordsBad(''))} onBlur={saveWords} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        {wordsBad && <span id="sw-mark-bad" className="set-bad" role="alert">{wordsBad}</span>}
        <span className="muted small" id="sw-mark-h">{T('settings.switches.mark_hint', { words: MARK_WORDS_DEFAULT })}</span>
      </label>
    </div>
  );
}

export function MembersStamps() {
  const T = useST();
  const { admin, d, put } = useSwitches();
  const [said, saved] = useSaved();
  if (!admin || !d) return null;
  return (
    // Inside the Stamps and seals card, under the stamps themselves.
    <div data-feature="ds-switches" style={{ borderTop: '1px solid var(--line, #e5e5e5)', marginTop: 16, paddingTop: 4 }}>
      <Row id="sw-stamps" title={T('settings.switches.stamps')} on={d.members_stamps} said={said} onChange={(v) => put({ members_stamps: v }, saved)}
        hint={T('settings.switches.stamps_hint')} />
    </div>
  );
}
