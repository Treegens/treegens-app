'use client';
import { YOUR_TEXT_NAME, FILL_IN_NAME, OLD_NOTE_WORD, isEmptyNote, isLeftoverNote, unwrittenNotes } from '@/lib/fieldkinds';
import { plural, type Ed } from './shared';

// The last look before sending: boxes of the sender's own text ("Your text") that hold no words, or still hold only
// the word an older draft started them with. An empty box is never shown to anyone who signs and never printed, so
// this warns and does not block. Each one is listed with a button that opens it in step 2 with the cursor in its
// words, and one that takes it off.
const SHOWN = 12;

export function NoteCheck({ ed }: { ed: Ed }) {
  // Where the wording is locked (a template's), the sender cannot write or remove a box. An empty one shows nowhere, so
  // only a box that would print the leftover word is brought up, with who to ask.
  const list = unwrittenNotes(ed.fields.value).filter((f) => (ed.wording ? isLeftoverNote(f) : !ed.isLockedField(f)));
  if (!list.length) return null;
  const empty = list.filter(isEmptyNote).length, left = list.length - empty;
  const where = (f: any) => {
    const d = ed.docs.find((x) => x.id === f.document_id);
    return `Page ${f.page + 1}${ed.docs.length > 1 && d ? ` of ${d.name || 'a document'}` : ''}`;
  };
  return (
    <section className="notice warn" aria-labelledby="ed-noteempty-h" data-check="your-text">
      <b id="ed-noteempty-h">{empty ? `${plural(empty, 'box', 'boxes')} of your own text ${empty === 1 ? 'is' : 'are'} empty.` : `${plural(left, 'box', 'boxes')} of your own text ${left === 1 ? 'says' : 'say'} only \u201c${OLD_NOTE_WORD}\u201d.`}</b>{' '}
      {empty > 0 && <>An empty box is left off the document: nobody who signs sees it, and it is not printed. </>}
      {left > 0 && <>A box that says only &ldquo;{OLD_NOTE_WORD}&rdquo; is printed with that word. </>}
      {ed.wording ? <>The wording is locked, so to change it ask {ed.wording.ask}.</> : <>&ldquo;{YOUR_TEXT_NAME}&rdquo; is for words you type yourself. If the person who signs should type here, remove it and add a &ldquo;{FILL_IN_NAME}&rdquo; field in step 2.</>}
      <ul className="ed-nolabel">
        {list.slice(0, SHOWN).map((f) => (
          <li key={f.id}>
            <span>{where(f)}: {isEmptyNote(f) ? 'empty' : `says only “${OLD_NOTE_WORD}”`}</span>
            {!ed.wording && <button type="button" className="btn sm" onClick={() => ed.showField(f.id)} aria-label={`Write your text on ${where(f).toLowerCase()}`}>Write it</button>}
            {!ed.wording && <button type="button" className="btn sm" onClick={() => ed.setFields((l) => l.filter((x) => x.id !== f.id))} aria-label={`Remove the box on ${where(f).toLowerCase()}`}>Remove</button>}
          </li>
        ))}
      </ul>
      {list.length > SHOWN && <p className="small" style={{ margin: '6px 0 0' }}>And {plural(list.length - SHOWN, 'more box', 'more boxes')}. They are listed here as you work through these.</p>}
    </section>
  );
}
