'use client';
import { checksSendProblem } from '@/lib/fieldrules';
import { TLABEL, who, type Ed } from './shared';

// The last look before sending: fields whose Format and limits are not finished (a pattern with no message, a pattern
// that could take minutes to check, a tick-box rule nobody could meet). The server refuses to send these
// (src/server/fieldchecks.ts sendProblem, the same reasons from src/lib/fieldrules.ts), so each is listed here first
// with a button that opens the field in step 2. Nothing shows for a document that uses no format or limit.
export function ChecksCheck({ ed }: { ed: Ed }) {
  const all = ed.fields.value;
  const list = all.map((f: any) => ({ f, why: checksSendProblem(f, all) })).filter((x: any) => x.why && !ed.isLockedField(x.f));
  if (!list.length) return null;
  const where = (f: any) => {
    const d = ed.docs.find((x) => x.id === f.document_id);
    const r = ed.rcps.find((x) => x.id === f.recipient_id);
    return `${f.label ? `"${f.label}"` : TLABEL[f.type] || 'Field'}${r ? ` for ${who(r)}` : ''}, page ${f.page + 1}${ed.docs.length > 1 && d ? ` of ${d.name || 'a document'}` : ''}`;
  };
  return (
    <section className="notice warn" aria-labelledby="ed-checks-h">
      <b id="ed-checks-h">{list.length === 1 ? 'One field needs its format finished' : `${list.length} fields need their format finished`} before you can send.</b>
      <ul className="ed-nolabel">
        {list.map(({ f, why }: any) => (
          <li key={f.id}>
            <span>{where(f)}: {why}</span>
            <button type="button" className="btn sm" onClick={() => ed.showField(f.id)} aria-label={`Finish the format of the ${where(f)}`}>Finish its format</button>
          </li>
        ))}
      </ul>
      <p className="small" style={{ margin: '6px 0 0' }}>You find it under Format and limits in the field&rsquo;s More options.</p>
    </section>
  );
}
