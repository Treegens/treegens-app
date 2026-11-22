'use client';
// The newer kinds of field on the signing page (src/lib/fieldkinds.ts): a drawing, the Approve and Decline buttons
// placed on a page, a first or last name taken from the person's name, and a date worked out from another date.
// Every other kind is drawn by the page itself. Returns null for a field this does not draw.
import { useState, type ReactNode } from 'react';
import { AdoptSignature } from '../SignaturePad';
import { Icon } from './parts';
import { formatDateValue } from '@/lib/dates';
import { buttonWords, dateFromOf, dateFromValue, isNamePart, DATE_FROM_WAITS, DRAWING_IS } from '@/lib/fieldkinds';

type Ctx = {
  common: { id: string; className: string; style: any };
  name: string;
  need: string;
  value: string;
  values: Record<string, string>;
  fields: any[];
  role: string;
  dateFormat?: string | null;
  /** A typed field opens a sheet on a phone: then a first or last name opens it too (FieldSheet in dialogs.tsx). */
  sheet: boolean;
  openSheet?: (f: any) => void;
  set: (id: string, v: string) => void;
  onDraw: (f: any) => void;
  onApprove: () => void;
  onDecline: () => void;
};

export function kindField(f: any, k: Ctx): ReactNode | null {
  const { common, name, need, value } = k;
  if (f.type === 'approve' || f.type === 'decline') {
    const words = buttonWords(f.type, k.role);
    return (
      <button key={f.id} type="button" {...common} className={`${common.className} sg-kbtn${f.type === 'decline' ? ' sg-kbtn-no' : ''}`} onClick={f.type === 'approve' ? k.onApprove : k.onDecline}
        aria-haspopup={f.type === 'decline' ? 'dialog' : undefined}>
        <span className="cta"><Icon name={f.type === 'approve' ? 'check' : 'stop'} size={14} /> {words}</span>
      </button>
    );
  }
  if (f.type === 'drawing')
    return (
      <button key={f.id} type="button" {...common} className={`${common.className} sg-draw`} onClick={() => k.onDraw(f)} aria-label={value ? `${name}: your drawing. Draw it again` : `${name}${need}. Opens a box to draw in. ${DRAWING_IS}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {value ? <img src={value} alt="" /> : <span className="cta"><Icon name="pen" size={14} /> Draw</span>}
      </button>
    );
  const rule = dateFromOf(f);
  if (rule) {
    const src = k.fields.find((g) => g.id === rule.from);
    const v = src?.type === 'date_signed' ? '' : dateFromValue(rule, src, k.values);
    const shown = v ? formatDateValue(v, k.dateFormat) : src?.type === 'date_signed' ? `${DATE_FROM_WAITS} when you finish` : DATE_FROM_WAITS;
    // Nothing to do here for the signer, so it is drawn like a field already filled, with its rule in words under it.
    return (
      <div key={f.id} {...common} className={`${common.className} sg-auto done sg-dfrom sg-knoted`} title={f.date_note} role="note" aria-label={`${name}: ${shown}. ${f.date_note || ''}`}>
        <span className={`sg-val${v ? '' : ' ph'}`}>{shown}</span>
        {/* The rule in words under it; the whole note, with what GrowSigning does not do, is in its label and Easy reading. */}
        {f.date_rule && <span className="sg-knote" aria-hidden="true">{f.date_rule}</span>}
      </div>
    );
  }
  if (isNamePart(f.type)) {
    // Said in words under the field while it still holds what was taken from their name, on every screen.
    const check = f.from_name && value === f.from_name ? f.name_check : '';
    const note = check && <span className="sg-knote" aria-hidden="true">{check}</span>;
    if (k.sheet && k.openSheet)
      return (
        <button key={f.id} type="button" {...common} className={`${common.className}${check ? ' sg-knoted' : ''}`} onClick={() => k.openSheet!(f)} aria-label={`${name}${need}. ${value ? `Your answer: ${value}` : 'Empty'}.${check ? ` ${check}.` : ''} Opens a box to type in`}>
          <span className={`sg-val${value ? '' : ' ph'}`} dir="auto">{value || name + (f.required ? ' *' : '')}</span>
          {note}
        </button>
      );
    if (k.sheet) return null;
    return (
      <div key={f.id} {...common} className={`${common.className}${check ? ' sg-knoted' : ''}`}>
        <input dir="auto" aria-label={`${name}${need}.${check ? ` ${check}` : ''}`} aria-required={!!f.required} value={value} maxLength={120} placeholder={name} onChange={(e) => k.set(f.id, e.target.value)} />
        {note}
      </div>
    );
  }
  return null;
}

/** The box to draw in for a Drawing field: the same pad as a signature, with none of the words about signing. */
export function useDrawing(set: (id: string, v: string) => void): { open: (f: any) => void; dialog: ReactNode } {
  const [forId, setFor] = useState<string | null>(null);
  return {
    open: (f) => setFor(f.id),
    dialog: forId ? <AdoptSignature kind="drawing" name="" doneLabel="Put it on the page" onDone={(png) => (set(forId, png), setFor(null))} onClose={() => setFor(null)} /> : null,
  };
}
