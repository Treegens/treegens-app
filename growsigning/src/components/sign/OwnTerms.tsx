'use client';
// The account's own consent text on the consent screen, above the box. Our own link "How electronic signing works"
// (ConsentDetails.tsx) stands under Continue and always stays (src/lib/policy.ts). The words are the version the server says is in use for this person's
// language (ownTermsFor in src/server/disclosure.ts). The screen sends its id back with the agreement, so the record
// names exactly the words that were on the screen.
//
// In full while the whole screen stays at 120 words before the tick (research/ux-charter.md P7 and its correction in
// research/ux.json "ux:check"), otherwise behind one line, "Read <Org>'s terms" (research/ux-notes.json,
// ds-consent-own). It starts as that one line and is measured once, before the screen is painted: the words above the
// tick less the line, plus the words of the text. The sender's own message (SenderWords.tsx) measures the same
// screen at the same moment, with this text still folded, so their message is shown in full whenever it fits.
import { useLayoutEffect, useRef, useState } from 'react';
import { CONSENT_WORDS, wordsIn } from '@/components/sign/actions';
import { possessive, ownTextPlain, type OwnSection } from '@/lib/disclosure';
import { t } from '@/lib/i18n';

/** What GET /sign/:token gives as "own_terms". */
export type OwnTerms = { id: string; version: number; language: string; org: string; sections: OwnSection[]; note: string; each_visit: boolean };

/** The text as a signer reads it: a short heading of ours and the account's words under it. Settings shows the same. */
export function OwnTextWords({ sections, lang }: { sections: OwnSection[]; lang?: string }) {
  return (
    <div className="own-words" lang={lang}>
      {sections.map((s) => (
        <div key={s.h} className="own-part">
          <b>{s.h}</b>
          {s.lines.map((l, i) => <p key={i} dir="auto">{l}</p>)}
        </div>
      ))}
    </div>
  );
}

/** "Read Acme's terms": the one line a signer sees when the text does not fit on the screen with the rest. */
export const readTermsLabel = (lang: string, org: string): string => t(lang, 'ownterms.read', { whose: possessive(org), org });

/**
 * The words of the text as the screen shows them, for the count: the note, the text and, for someone whose Other
 * actions has "Sign on paper instead" (`paper`), the line that points to it.
 */
export const ownTermsWords = (lang: string, own: Pick<OwnTerms, 'note' | 'sections'>, paper = true): number =>
  wordsIn(own.note || '') + wordsIn(ownTextPlain(own.sections || [])) + (paper ? wordsIn(t(lang, 'ownterms.way_out')) : 0);

/**
 * `lang`: the language of this person's screens. Give it key={own.id}: a new version is measured afresh. `paper`:
 * whether this person's Other actions has "Sign on paper instead" (a viewer, a copy and a witness have none), so the
 * line that points to it is there only for someone who can follow it.
 */
export function OwnTermsBlock({ own, lang, paper = true }: { own: OwnTerms; lang: string; paper?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'measure' | 'inline' | 'fold'>('measure');
  const [open, setOpen] = useState(false);
  const label = readTermsLabel(lang, own.org);
  useLayoutEffect(() => {
    const tick = box.current?.closest('.sg-shell')?.querySelector('input[type=checkbox]');
    if (!tick) return setMode('fold');
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(tick.closest('label') || tick);
    setMode(wordsIn(range.toString()) - wordsIn(label) + ownTermsWords(lang, own, paper) <= CONSENT_WORDS ? 'inline' : 'fold');
    // Measured once for this version: opening and closing the fold never moves anything else on the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const words = (
    <div className="sg-own-body">
      {/* In English when the account has no text in this person's language: one sentence in their language says why. */}
      {own.note && <p className="muted small sg-own-note">{own.note}</p>}
      <OwnTextWords sections={own.sections} lang={own.language} />
      {paper && <p className="muted small sg-own-out">{t(lang, 'ownterms.way_out')}</p>}
    </div>
  );
  return (
    <div ref={box} className="sg-own" data-feature="ds-consent-own">
      {mode === 'inline' ? words : (
        <details className="sg-fold" data-fold open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary>{label}</summary>
          {/* Closed, the words are not on the screen at all, so a screen reader does not read them before the tick. */}
          {open && words}
        </details>
      )}
    </div>
  );
}
