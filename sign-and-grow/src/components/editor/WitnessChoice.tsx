'use client';
import { useEffect } from 'react';
import { toast } from '../ui';
import { makeField, who, type Ed } from './shared';
import { WITNESSED_ROLES, WHO_MAY_WITNESS, WITNESS_RECORDS, WITNESS_BLOCK } from '@/lib/witness';

// A witness for one person who signs (src/lib/witness.ts). Under a witness's row in step 1: whose signature they
// witness, and whether that person names them on their signing page. What the product does and does not do is said
// next to the choice, before anyone relies on it. The rules for what cannot be sent are the server's own.

/** The people a witness can be there for: someone who signs on their own or in person, by name, not a group. */
const witnessable = (rcps: any[], r: any) => rcps.filter((x) => x.id !== r.id && WITNESSED_ROLES.includes(x.role) && !x.group_id);

/** A witness the signer names, who has no name yet: the sender types neither a name nor an address for them. */
export const signerNames = (r: any): boolean => r.role === 'witness' && !!r.named_by_signer && !String(r.email || '').trim();

export function WitnessChoice({ r, rcps, isTpl, onChange }: { r: any; rcps: any[]; isTpl: boolean; onChange: (p: any) => void }) {
  const people = r.role === 'witness' ? witnessable(rcps, r) : [];
  const target = rcps.find((x) => x.id === r.witness_for);
  // With one person who signs, that is whom the witness is for. With more, the sender chooses.
  const only = people.length === 1 && !target ? people[0].id : '';
  useEffect(() => {
    if (only) onChange({ witness_for: only });
  }, [only]); // eslint-disable-line react-hooks/exhaustive-deps
  if (r.role !== 'witness') return null;
  const id = `ed-wit-${r.id}`;
  return (
    <div className="ed-witness">
      <label className="f" htmlFor={`${id}-for`} style={{ margin: 0 }}>
        <span>Witnesses the signature of</span>
        <select id={`${id}-for`} value={target ? r.witness_for : ''} onChange={(e) => onChange({ witness_for: e.target.value || null })}>
          <option value="">Choose a person who signs</option>
          {people.map((x) => <option key={x.id} value={x.id}>{who(x)}</option>)}
        </select>
      </label>
      {!people.length && <p className="notice warn small">Add the person who signs first. A witness watches one named person sign.</p>}
      <label className="check">
        {/* Ticking takes the name and address away: the signer gives them. Unticking gives back what was typed. */}
        <input type="checkbox" checked={!!r.named_by_signer} aria-describedby={`${id}-how`}
          onChange={(e) => onChange(e.target.checked ? { named_by_signer: true, name: '', email: '', witness_before_tick: { name: r.name, email: r.email } } : { named_by_signer: false, name: r.witness_before_tick?.name || '', email: r.witness_before_tick?.email || '' })} />
        <span>{target ? `${who(target)} names the witness` : 'The person who signs names the witness'}<span className="muted"> on {isTpl ? 'their' : 'the'} signing page, before Finish</span></span>
      </label>
      <div id={`${id}-how`} className="muted small ed-witness-how">
        <p>We email the witness straight after {target ? who(target) : 'that person'} has signed, whatever the signing order says, and nobody else waits for them. A witness uses none of your signatures. On their first screen they confirm, in their own words, that they were physically present and saw the signature, or say that they were not there. Place their block in step 2, near the signature they witness.</p>
        <p>{WHO_MAY_WITNESS}</p>
        <p>{WITNESS_RECORDS}</p>
      </div>
    </div>
  );
}

/**
 * In step 2, while a witness is picked: their whole block at once (signature, name, address, occupation, date),
 * under the signature they witness, or above it when there is no room below. Undo takes the whole block away again.
 */
export function WitnessBlockButton({ ed, witness, onPlaced }: { ed: Ed; witness: any; onPlaced: (fieldId: string) => void }) {
  if (!witness) return null;
  const target = ed.rcps.find((x) => x.id === witness.witness_for);
  const has = ed.fields.value.some((f) => f.recipient_id === witness.id && f.type === 'signature');
  const place = () => {
    if (!ed.docs.length) return toast('Add a document in step 1 first.', true);
    const sig = ed.fields.current().find((f) => f.recipient_id === target?.id && f.type === 'signature');
    const doc = sig ? ed.docs.find((d) => d.id === sig.document_id) || ed.docs[0] : ed.docs[ed.docs.length - 1];
    const page = sig ? sig.page : Math.max(0, (doc.pages || 1) - 1);
    const tall = WITNESS_BLOCK.reduce((n, b) => n + b.h + 0.008, 0);
    const x = Math.min(sig ? sig.x : 0.1, 1 - Math.max(...WITNESS_BLOCK.map((b) => b.w)));
    let y = sig ? sig.y + sig.h + 0.015 : 0.6;
    if (y + tall > 0.99) y = sig ? Math.max(0.01, sig.y - tall - 0.015) : Math.max(0.01, 0.99 - tall);
    const made = WITNESS_BLOCK.map((b) => {
      const f = makeField(b.type, doc.id, page, witness.id, { x, y, w: b.w, h: b.h }, { label: b.label, required: b.required });
      y += b.h + 0.008;
      return f;
    });
    ed.setFields((l) => [...l, ...made]);
    onPlaced(made[0].id);
    toast(`Witness block placed${sig ? ` near the signature of ${who(target)}` : ''}. Check that it sits on blank space. Undo takes it away again.`);
  };
  return (
    <div className="ed-witness-block">
      <button type="button" className="btn sm" disabled={!!ed.wording} onClick={place} aria-describedby={`ed-wb-${witness.id}`}>Place the witness block</button>
      <p id={`ed-wb-${witness.id}`} className="muted small">{has ? `${who(witness)} has a signature field already. Another block adds five more fields.` : `Signature, name, address, occupation and date for ${who(witness)}${target ? `, next to the signature of ${who(target)}` : ''}.`}</p>
    </div>
  );
}
