'use client';
// "To read, not sign", inside a file's More in step 1 (research/ux-notes.json, ds-supplements): a privacy notice or
// terms that go with the document. One switch; when it is on, one choice of what Finish waits for and one tick for
// the signed copy. The rules and the words are in src/lib/supplements.ts, the server's side in
// src/server/supplements.ts. Off by default: every file is to sign.
import { useId } from 'react';
import { RULE_LABEL, SUPPLEMENT_RULES, TO_READ, type SupplementRule } from '@/lib/supplements';
import type { Ed } from './shared';

export function ToRead({ ed, d }: { ed: Ed; d: any }) {
  const id = useId();
  const sup = d.supplemental as { rule: SupplementRule; in_copy: boolean } | null;
  // On a document that is out, an existing file cannot change between to sign and to read (the server refuses it):
  // a file to sign shows nothing here, and a file to read keeps its rule and copy choices without the switch.
  const sent = ed.correcting && ed.base?.documents?.some((x: any) => x.id === d.id);
  if (sent && !sup) return null;
  // With one file, marking it to read could only make a document with nothing to sign: offered from two files on,
  // and always to switch back a file that already is to read.
  if (!sup && ed.docs.length < 2) return null;
  const name = d.name || 'this file';
  return (
    <div style={{ flexBasis: '100%', display: 'grid', gap: 6 }} data-feature="ds-supplements">
      {!sent && (sup || ed.docs.length > 1) && (
        <label className="check ed-tap">
          <input type="checkbox" checked={!!sup} onChange={(e) => ed.markToRead(d.id, e.target.checked ? { rule: 'none', in_copy: true } : null)} aria-describedby={`${id}-hint`} />
          <span>{TO_READ}<span className="muted" id={`${id}-hint`}>: given with the document, such as a privacy notice. Nobody signs it and it has no fields.</span></span>
        </label>
      )}
      {sup && (
        <>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            <span>Before they finish</span>
            <select value={sup.rule} style={{ minHeight: 44 }} aria-label={`Before they finish, for ${name}`} onChange={(e) => ed.markToRead(d.id, { ...sup, rule: e.target.value as SupplementRule })}>
              {SUPPLEMENT_RULES.map((r) => <option key={r} value={r}>{RULE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="check ed-tap">
            <input type="checkbox" checked={sup.in_copy} onChange={(e) => ed.markToRead(d.id, { ...sup, in_copy: e.target.checked })} />
            <span>Put it in the signed copy<span className="muted">, after the signed pages</span></span>
          </label>
        </>
      )}
    </div>
  );
}
