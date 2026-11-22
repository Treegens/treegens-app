'use client';
// "Anyone on the document" in a field's "Assigned to" (src/lib/collab.ts): the choice at the end of the list, and,
// once chosen, the two things a sender may want with it. Nothing new appears for a field kind that cannot be shared
// or while fewer than two people sign.
import { useEffect } from 'react';
import { isShareable, canShare, ANYONE, ANYONE_VALUE, ANYONE_NOTE, INITIALS_LABEL, AFTER_LABEL, AFTER_HINT, NOT_REQUIRED, ORDERED_NOTE, groupOf } from '@/lib/collab';
import { isHidden } from '@/lib/fieldrules';

/** The people a shared field could start with: those who sign, in the order the editor lists them. */
const sharers = (people: any[]) => people.filter((r) => canShare(r.role));

/** A setting of the field that a field for anyone cannot have (the server refuses the pair, collab.ts saveShared). */
const conflicts = (f: any): boolean => !!(f?.readonly || f?.show_when || f?.formula != null && f?.formula !== '' || f?.link || f?.date_from || isHidden({ type: f?.type, validation: f?.validation }));

/** Whether "Anyone on the document" is offered for this field. Not for a field that is read only, shown only
 *  sometimes, shares an answer or hides it: those settings are not offered for it either, once it is for anyone. */
export const offersAnyone = (field: any, people: any[]): boolean => isShareable(field?.type) && sharers(people).length >= 2 && (!!field?.shared || !conflicts(field));

/** The fields a choice in "Assigned to" changes: a choice of a group goes with all of its group (one answer). */
export const assignIds = groupOf;

/** On the page in the editor: a field for anyone is named so and drawn in grey, not in the first person's colour. */
export const canvasWho = (f: any, people: any[], owner: string): string => (f?.shared && offersAnyone(f, people) ? ` for ${ANYONE.toLowerCase()}` : owner);
export const SHARED_COLOR = '#6b7570';

/** With fewer than two people who sign, a field for anyone goes back to being its person's field, said by nothing
 *  hidden: "Assigned to" then shows that person and "Required" comes back. */
export function useDropShared(list: any[], people: any[], drop: (ids: string[]) => void) {
  const ids = people.length && sharers(people).length < 2 ? list.filter((f) => f.shared && isShareable(f.type)).map((f) => f.id).join() : '';
  useEffect(() => {
    if (ids) drop(ids.split(','));
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The value "Assigned to" shows. */
export const assignedValue = (field: any, people: any[]): string => (field?.shared && offersAnyone(field, people) ? ANYONE_VALUE : field?.recipient_id || '');

/** The patch for a new choice in "Assigned to": a person, or anyone (the field then starts with someone who signs). */
export function assignPatch(value: string, field: any, people: any[]): any {
  if (value !== ANYONE_VALUE) return { recipient_id: value, shared: 0 };
  const now = sharers(people).find((r) => r.id === field.recipient_id) || sharers(people)[0];
  return { shared: 1, recipient_id: now?.id || field.recipient_id, required: false };
}

/** The extra option at the end of "Assigned to". */
export function AnyoneOption({ field, people }: { field: any; people: any[] }) {
  if (!offersAnyone(field, people)) return null;
  return <option value={ANYONE_VALUE} data-feature="ds-collab-fields">{ANYONE}</option>;
}

/** Under "Assigned to" once "Anyone on the document" is chosen. */
export function SharedChoice({ field, people, patch, ordered }: { field: any; people: any[]; patch: (p: any) => void; ordered?: boolean }) {
  if (!field?.shared || !offersAnyone(field, people)) return null;
  // Signing in order: the first person finishes before the next one sees it (collab.ts locks it then).
  const inOrder = !!ordered && new Set(sharers(people).map((r) => Number(r.routing_order))).size > 1;
  return (
    <div data-feature="ds-collab-fields" style={{ marginBottom: 12 }}>
      <p className="muted small" style={{ marginTop: -4 }}>{ANYONE_NOTE} {NOT_REQUIRED}</p>
      <label className="check ed-tap"><input type="checkbox" checked={!!field.shared_initials} onChange={(e) => patch({ shared_initials: e.target.checked ? 1 : 0 })} /> {INITIALS_LABEL}</label>
      <label className="check ed-tap"><input type="checkbox" checked={!!field.shared_after} aria-describedby={`ed-after-${field.id}`} onChange={(e) => patch({ shared_after: e.target.checked ? 1 : 0 })} /> {AFTER_LABEL}</label>
      <p className="muted small" id={`ed-after-${field.id}`} style={{ marginTop: 0 }}>{AFTER_HINT}</p>
      {inOrder && !field.shared_after && <p className="small" role="note" style={{ marginTop: 0 }}>{ORDERED_NOTE}</p>}
    </div>
  );
}
