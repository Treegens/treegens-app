'use client';
import { YOUR_TEXT_NAME, OLD_NOTE_WORD, LET_THEM_TYPE, SIGNER_ROLES_TYPING, isEmptyNote, isLeftoverNote, unwrittenNotes, asFillIn } from '@/lib/fieldkinds';
import { plural, type Ed } from './shared';

// The last look before sending: "Your text" boxes that hold no words, or still hold only the word an older draft
// started them with. An empty box is never shown to anyone who signs and never printed, so this is one short line
// that warns and does not block. Each box has three buttons: write its words (step 2 opens with the cursor in them),
// let the person who signs type there instead (the same box, in the same place, becomes a "Fill in" field), or remove it.
const SHOWN = 12;

export function NoteCheck({ ed }: { ed: Ed }) {
  // Where the wording is locked (a template's), the sender cannot write or remove a box. An empty one shows nowhere, so
  // only a box that would print the leftover word is brought up, with who to ask.
  const list = unwrittenNotes(ed.fields.value).filter((f) => (ed.wording ? isLeftoverNote(f) : !ed.isLockedField(f)));
  if (!list.length) return null;
  const empty = list.filter(isEmptyNote).length, left = list.length - empty;
  // Who types when a box is turned into a blank: the first person who signs and has not finished. Step 2 opens on the
  // field right away, where "Assigned to" changes it.
  const typer = ed.rcps.find((r) => SIGNER_ROLES_TYPING.includes(r.role) && !ed.isIdle(r) && r.status !== 'completed');
  const where = (f: any) => {
    const d = ed.docs.find((x) => x.id === f.document_id);
    return `Page ${f.page + 1}${ed.docs.length > 1 && d ? ` of ${d.name || 'a document'}` : ''}`;
  };
  const letThemType = (f: any) => {
    ed.setFields((l) => l.map((x) => (x.id === f.id ? asFillIn(x, typer.id) : x)));
    ed.showField(f.id);
  };
  return (
    <section className="notice warn ed-notecheck" aria-labelledby="ed-noteempty-h" data-check="your-text">
      <b id="ed-noteempty-h">
        {empty > 0 && `${plural(empty, `empty “${YOUR_TEXT_NAME}” box`, `empty “${YOUR_TEXT_NAME}” boxes`)} will be left off the document.`}
        {empty > 0 && left > 0 && ' '}
        {left > 0 && `${plural(left, `“${YOUR_TEXT_NAME}” box says`, `“${YOUR_TEXT_NAME}” boxes say`)} only “${OLD_NOTE_WORD}” and will be printed like that.`}
      </b>
      {ed.wording && <> The wording is locked, so to change it ask {ed.wording.ask}.</>}
      <ul className="ed-nolabel">
        {list.slice(0, SHOWN).map((f) => (
          <li key={f.id}>
            <span>{where(f)}{isEmptyNote(f) ? '' : `: says only “${OLD_NOTE_WORD}”`}</span>
            {!ed.wording && <button type="button" className="btn sm" onClick={() => ed.showField(f.id)} aria-label={`Write your text on ${where(f).toLowerCase()}`}>Write it</button>}
            {!ed.wording && typer && <button type="button" className="btn sm" data-act="let-them-type" onClick={() => letThemType(f)} aria-label={`${LET_THEM_TYPE}, on ${where(f).toLowerCase()}`}>{LET_THEM_TYPE}</button>}
            {!ed.wording && <button type="button" className="btn sm" onClick={() => ed.setFields((l) => l.filter((x) => x.id !== f.id))} aria-label={`Remove the box on ${where(f).toLowerCase()}`}>Remove</button>}
          </li>
        ))}
      </ul>
      {list.length > SHOWN && <p className="small" style={{ margin: '6px 0 0' }}>And {plural(list.length - SHOWN, 'more box', 'more boxes')}. They are listed here as you work through these.</p>}
    </section>
  );
}
