'use client';
import { useState } from 'react';
import { useMe } from '../AppShell';
import { CheckFields } from '../sender/CheckFields';
import { LockedLine } from '../templates/WhoCanUse';
import { keptLine } from '@/lib/tplroles';
import { shippedLocales } from '@/lib/i18n';
import { ROLE_CHOICES, ROLE_WORDS, moreLines, personSummary, type MoreLine } from '@/lib/editorux';
import { SendMyself } from './SendMyself';
import { RecipientLanguage } from './RecipientLanguage';
import { who, type Ed } from './shared';

// One person's More in step 1 (research/ux-charter.md, 2.3). Everything about a person that is not their name and
// address lives here, one line for each choice with what it is set to now ("How they get it: Email"). A line opens
// its own small picker in place, one at a time. Which lines there are is decided in src/lib/editorux.ts: a choice
// with only one possible answer is not listed.

/** The id of a person's More panel, which the More button names in aria-controls. */
export const morePanelId = (rid: string) => `ed-more-${rid}`;

/** What is set for this person, said under their row while More is closed. Nothing for the plain case. */
export function PersonSummary({ r }: { r: any }) {
  const said = personSummary(r);
  return said ? <div className="muted small ed-person-says">{said}</div> : null;
}

export function PersonMore({ ed, r }: { ed: Ed; r: any }) {
  const me = useMe();
  const [pick, setPick] = useState<MoreLine['key'] | null>(null);
  const { isTpl, wording } = ed;
  const kept = wording?.people?.[r.id];
  const patch = (p: any) => ed.patchRcp(r.id, p);
  const lines = moreLines(r, { isTpl, languages: shippedLocales().length });
  const name = who(r);

  const picker = (key: MoreLine['key']) => {
    if (key === 'role')
      return (
        <label className="f" style={{ margin: 0 }}><span>What {name} does</span>
          <select value={r.role === 'inperson' ? 'signer' : r.role} aria-label="Role" disabled={!!wording} onChange={(e) => patch({ role: e.target.value })}>
            {ROLE_CHOICES.map((k) => <option key={k} value={k}>{ROLE_WORDS[k]}</option>)}
          </select>
        </label>
      );
    if (key === 'deliver') return <SendMyself r={r} isTpl={isTpl} onChange={patch} />;
    if (key === 'check')
      return (
        <>
          {/* What a locked template gave this person stays (wording.people, tplroles.ts): shown as such. */}
          <label className="f" style={{ margin: 0 }}><span>Access code <span className="hint">{kept?.code ? '(from the template: you can change it, not take it off)' : '(at least 4 characters, a code you tell them yourself)'}</span></span><input value={r.access_code || ''} maxLength={50} required={!!kept?.code} onChange={(e) => patch({ access_code: e.target.value })} /></label>
          {/* A one-time code before the document opens, and the signing link by text message: only what this
              server can do is offered (me.text_messages says whether its operator switched texts on). */}
          <CheckFields value={r} role={r.role} textsOn={!!me.text_messages} open={isTpl && !r.email} keepCode={!!kept?.verify} onChange={patch} />
        </>
      );
    if (key === 'sign')
      return (
        <>
          <label className="f" style={{ margin: 0 }}><span>How {name} signs</span>
            <select value={r.role === 'inperson' ? 'inperson' : 'screen'} aria-label="How they sign" disabled={!!wording} onChange={(e) => patch({ role: e.target.value === 'inperson' ? 'inperson' : 'signer' })}>
              <option value="screen">On screen, from their own link</option>
              <option value="inperson">In person, with me</option>
            </select>
          </label>
          {r.role !== 'inperson' && <p className="muted small" style={{ margin: '6px 0 0' }}>In person means they sign on your device while you are with them.</p>}
        </>
      );
    if (key === 'language') return <RecipientLanguage value={r.locale} who={name} onChange={patch} />;
    return <label className="f" style={{ margin: 0 }}><span>Private note <span className="hint">{kept?.note ? '(from the template, locked)' : '(only they see it)'}</span></span><input value={r.note || ''} maxLength={1000} readOnly={!!kept?.note} onChange={(e) => patch({ note: e.target.value })} /></label>;
  };

  return (
    <div id={morePanelId(r.id)} className="ed-more" role="group" aria-label={`More options for ${name}`}>
      {lines.map((l) => (
        <div key={l.key} className="ed-line">
          <button type="button" className="ed-line-btn" aria-expanded={pick === l.key} onClick={() => setPick(pick === l.key ? null : l.key)}>
            <span>{l.label}: <b>{l.value}</b></span><span aria-hidden="true" className="ed-line-go">{pick === l.key ? 'Close' : 'Change'}</span>
          </button>
          {pick === l.key && <div className="ed-pick">{picker(l.key)}</div>}
        </div>
      ))}
      {kept && <LockedLine>{keptLine(kept, wording!.ask)}</LockedLine>}
    </div>
  );
}
