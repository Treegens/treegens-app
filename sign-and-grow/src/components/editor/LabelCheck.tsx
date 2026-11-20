'use client';
import { HEARD_AS, unlabelled } from '@/lib/phone';
import { TLABEL, plural, who, type Ed } from './shared';

// The last look before sending: fields a signer has to fill in that have no label. Someone who signs with a screen
// reader hears a field's label, and without one only its type. Each field is listed with a button that opens it in
// step 2 with the cursor in the Label box. It warns and never blocks: plenty of documents print the words next to
// the field, and the sender is the one who knows.
const SHOWN = 12;

export function LabelCheck({ ed }: { ed: Ed }) {
  // A field that someone has already signed cannot be changed any more, so it is not brought up.
  const list = unlabelled(ed.fields.value).filter((f) => !ed.isLockedField(f));
  if (!list.length) return null;
  const n = list.length;
  const where = (f: any) => {
    const d = ed.docs.find((x) => x.id === f.document_id);
    const r = ed.rcps.find((x) => x.id === f.recipient_id);
    return `${TLABEL[f.type] || 'Field'}${r ? ` for ${who(r)}` : ''}, page ${f.page + 1}${ed.docs.length > 1 && d ? ` of ${d.name || 'a document'}` : ''}`;
  };
  return (
    <section className="notice warn" aria-labelledby="ed-nolabel-h">
      <b id="ed-nolabel-h">{plural(n, 'field')} {n === 1 ? 'has' : 'have'} no label.</b>{' '}
      Someone who signs with a screen reader cannot see where a field sits on the page. They hear its label. Without one they hear only what kind of field it is, such as &ldquo;{HEARD_AS[list[0].type]}, required&rdquo;, and cannot know what belongs in it. A label of a few words is enough, such as &ldquo;Seedlings pledged&rdquo;. You can send without, but then tell that signer yourself what each field is for.
      <ul className="ed-nolabel">
        {list.slice(0, SHOWN).map((f) => (
          <li key={f.id}>
            <span>{where(f)}</span>
            <button type="button" className="btn sm" onClick={() => ed.showField(f.id)} aria-label={`Add a label to the ${where(f)}`}>Add a label</button>
          </li>
        ))}
      </ul>
      {n > SHOWN && <p className="small" style={{ margin: '6px 0 0' }}>And {plural(n - SHOWN, 'more field')} without a label. They are listed here as you work through these.</p>}
    </section>
  );
}
