'use client';
// Under a field anyone on the document can fill in, while the person is in it: who changed it last, and what a change
// does now (src/lib/collab.ts). Never drawn while they are elsewhere, so it never covers the words of the document or
// another field. The same words are part of the field's own name for a screen reader (sharedSaid) and are in the
// phone's typing box (dialogs.tsx FieldSheet), so this line is only for the eyes. Fields of one person get nothing.
import { useEffect, useState } from 'react';
import { sharedNote, saidValue, withoutHeld, initialsFirst } from '@/lib/collab';

/** The words added to a shared field's name for a screen reader, or ''. */
export const sharedSaid = (f: any): string => (f?.shared ? `. ${sharedNote(f).replace(/\.$/, '')}` : '');

/** The id of the shared field the keyboard or a tap is in now (its element is #f-<id>), or ''. */
function useFocusedField(ids: string[]): string {
  const [at, setAt] = useState('');
  const key = ids.join();
  useEffect(() => {
    if (!key) return;
    const of = (t: EventTarget | null) => {
      const el = t instanceof Element ? t.closest('[id^="f-"]') : null;
      const id = el ? el.id.slice(2) : '';
      return key.split(',').includes(id) ? id : '';
    };
    // Only for focus a person can see moving (the keyboard, or typing in the box): a tap on a phone opens the typing
    // box, which says the same words, and the line is not left over the page when that box closes.
    const seen = (t: EventTarget | null) => t instanceof Element && (t.matches('input, textarea, select, .sg-locked') || t.matches(':focus-visible'));
    const on = (e: FocusEvent) => setAt(seen(e.target) ? of(e.target) : '');
    const off = (e: FocusEvent) => setAt(of(e.relatedTarget));
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => {
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', off);
    };
  }, [key]);
  return at;
}

export function SharedNotes({ fields }: { fields: any[] }) {
  const shared = fields.filter((f) => f.shared);
  const at = useFocusedField(shared.map((f) => f.id));
  if (!shared.length || !at) return null;
  return (
    <>
      {shared.filter((f) => f.id === at).map((f) => {
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

/** A change to this field needs initials first, and this person has none on the page yet. Only for an answer that
 *  is there already: the first answer in an empty field needs none (src/server/collab.ts). */
export const needsInitials = (fields: any[], id: string, ini: string | null): boolean => initialsFirst(fields.find((x) => x.id === id), ini);
export const INITIALS_FIRST = 'Add your initials to change this answer. Then type your change.';

/** What the autosave sends: a change that asks someone else to sign again stays on this screen and goes with Finish,
 *  so a pause while typing never asks anyone to sign again. */
export const autosaved = withoutHeld;

/** A field that can no longer be changed: what it says, and why, for the eyes and for a screen reader. */
export function LockedShared({ f, common, shown, box }: { f: any; common: any; shown: string; box: boolean }) {
  const empty = !shown;
  const said = `${f.label || 'Field'}${box ? `, ${saidValue(f.type, shown ? '1' : '')}` : empty ? ', left empty' : `: ${shown}`}. ${sharedNote(f)}`;
  return (
    // Focusable, so a tap or Tab shows the line that says why (SharedNotes) and a screen reader says all of it.
    <div {...common} className={`${String(common.className || '').replace(/ done\b/, '')} sg-locked`} title={sharedNote(f)} role="note" tabIndex={0} aria-label={said} data-feature="ds-collab-fields">
      <span className={`sg-val${empty && !box ? ' ph' : ''}`} dir="auto" aria-hidden="true">{box ? (shown ? '\u2713' : '') : empty ? 'Left empty' : shown}</span>
    </div>
  );
}
