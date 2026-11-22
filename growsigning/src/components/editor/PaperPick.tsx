'use client';
// "How they sign" in a person's More (research/ux-notes.json, ds-paper), only once an admin switched on "People may
// sign on paper" (Settings, Sending). The same one list as before, with the paper choices in it: on screen (and on
// paper if they prefer, the default), on screen only, on paper only, or in person with me. Without the switch this is
// never drawn and the list is as it always was (PersonMore.tsx).
import { PAPER_WORDS, PICK_WORDS, PICK_SHORT, paperPick, type PaperPick as Pick } from '@/lib/paper';

/** The value of the line "How they sign" in a person's More. */
export const paperLine = (r: any): string => PICK_SHORT[paperPick(r)];

export function PaperPick({ r, name, disabled, onChange }: { r: any; name: string; disabled?: boolean; onChange: (p: any) => void }) {
  const value: Pick | 'inperson' = r.role === 'inperson' ? 'inperson' : paperPick(r);
  const pick = (v: string) => {
    if (v === 'inperson') return onChange({ role: 'inperson', allow_paper: null, require_paper: false });
    const role = r.role === 'inperson' ? 'signer' : r.role;
    onChange({ role, allow_paper: v === 'screen' ? false : null, require_paper: v === 'paper' });
  };
  return (
    <div data-feature="ds-paper">
      <label className="f" style={{ margin: 0 }}><span>How {name} signs</span>
        <select value={value} aria-label="How they sign" disabled={disabled} onChange={(e) => pick(e.target.value)}>
          <option value="link">{PICK_WORDS.link}</option>
          <option value="screen">{PICK_WORDS.screen}</option>
          <option value="paper">{PICK_WORDS.paper}</option>
          <option value="inperson">In person, with me</option>
        </select>
      </label>
      <p className="muted small" style={{ margin: '6px 0 0' }}>{value === 'paper' ? PAPER_WORDS.onlyNote : value === 'inperson' ? 'They sign on your device while you are with them.' : 'In person means they sign on your device while you are with them.'}</p>
    </div>
  );
}
