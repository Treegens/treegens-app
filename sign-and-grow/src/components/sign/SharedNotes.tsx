'use client';
// On the page, under each field anyone on the document can fill in: who changed it last, and what a change does now
// (src/lib/collab.ts). The same words are part of the field's own name for a screen reader (sharedSaid), so this line
// is only for the eyes. Fields of one person get nothing.
import { sharedNote } from '@/lib/collab';

/** The words added to a shared field's name for a screen reader, or ''. */
export const sharedSaid = (f: any): string => (f?.shared ? `. ${sharedNote(f).replace(/\.$/, '')}` : '');

export function SharedNotes({ fields }: { fields: any[] }) {
  const shared = fields.filter((f) => f.shared);
  if (!shared.length) return null;
  return (
    <>
      {shared.map((f) => {
        // At least about half the page wide, so the line is not a tall column on a phone, and never past its right edge.
        const w = Math.min(1, Math.max(f.w, 0.5));
        return (
          <span key={f.id} className="sg-shared-note" aria-hidden="true" data-feature="ds-collab-fields"
            style={{ left: `${Math.max(0, Math.min(f.x, 1 - w)) * 100}%`, top: `${(f.y + f.h) * 100}%`, maxWidth: `${w * 100}%` }}>
            {sharedNote(f)}
          </span>
        );
      })}
    </>
  );
}

/** Answers without the fields anyone can fill in: when the page loads again, those always show what is stored, so a
 *  value this tab had is never sent back over someone else's change. */
export function ownAnswers(fields: any[] | undefined, values: Record<string, string>): Record<string, string> {
  const shared = new Set((fields || []).filter((f) => f.shared).map((f) => f.id));
  return shared.size ? Object.fromEntries(Object.entries(values).filter(([id]) => !shared.has(id))) : values;
}

/** A change to this field needs initials first, and this person has none on the page yet. */
export const needsInitials = (fields: any[], id: string, ini: string | null): boolean => {
  const f = fields.find((x) => x.id === id);
  return !!f?.shared && !!f.initials_on_change && !ini;
};
export const INITIALS_FIRST = 'Add your initials first. The sender asks for them when this field changes. Then make your change.';
