'use client';
// "Anyone on the document" in a field's "Assigned to" (src/lib/collab.ts): the choice at the end of the list, and,
// once chosen, the two things a sender may want with it. Nothing new appears for a field kind that cannot be shared
// or while fewer than two people sign.
import { isShareable, canShare, ANYONE, ANYONE_VALUE, ANYONE_NOTE, INITIALS_LABEL, AFTER_LABEL, AFTER_HINT, NOT_REQUIRED } from '@/lib/collab';

/** The people a shared field could start with: those who sign, in the order the editor lists them. */
const sharers = (people: any[]) => people.filter((r) => canShare(r.role));

/** Whether "Anyone on the document" is offered for this field. */
export const offersAnyone = (field: any, people: any[]): boolean => isShareable(field?.type) && sharers(people).length >= 2;

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
export function SharedChoice({ field, people, patch }: { field: any; people: any[]; patch: (p: any) => void }) {
  if (!field?.shared || !offersAnyone(field, people)) return null;
  return (
    <div data-feature="ds-collab-fields" style={{ marginBottom: 12 }}>
      <p className="muted small" style={{ marginTop: -4 }}>{ANYONE_NOTE} {NOT_REQUIRED}</p>
      <label className="check ed-tap"><input type="checkbox" checked={!!field.shared_initials} onChange={(e) => patch({ shared_initials: e.target.checked ? 1 : 0 })} /> {INITIALS_LABEL}</label>
      <label className="check ed-tap"><input type="checkbox" checked={!!field.shared_after} aria-describedby={`ed-after-${field.id}`} onChange={(e) => patch({ shared_after: e.target.checked ? 1 : 0 })} /> {AFTER_LABEL}</label>
      <p className="muted small" id={`ed-after-${field.id}`} style={{ marginTop: 0 }}>{AFTER_HINT}</p>
    </div>
  );
}
