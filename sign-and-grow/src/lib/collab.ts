// Fields anyone on the document can fill in, instead of one person. Plain rules and words shared by the editor, the
// signing page and the server (src/server/collab.ts), so all three say the same thing.
//
// 1. A text, choice, dropdown or tick-box field can be "Anyone on the document": every signer can fill it in or change
//    it while they sign. The sender may also ask for initials whenever it changes.
// 2. Each change is on the audit trail with who made it and what the field said before. The signing page shows who
//    changed it last.
// 3. Once anyone has finished, a change is refused, unless the sender allowed it. Then everyone who had finished is
//    asked to sign again, so a later change never quietly alters what someone already agreed to.
// 4. The signed PDF prints the final answer; the certificate lists every change.
// Signatures and initials are never shared: each one belongs to the person who makes it.

/** The kinds of field that can be filled in by anyone on the document. */
export const SHAREABLE = ['text', 'radio', 'dropdown', 'checkbox'] as const;
export const isShareable = (type: any): boolean => (SHAREABLE as readonly string[]).includes(type);
/** A field anyone on the document can fill in. */
export const isShared = (f: any): boolean => !!f?.shared && isShareable(f?.type);
/** Who can fill in such a field: the people who sign, on their own device or in person. */
export const canShare = (role: any): boolean => role === 'signer' || role === 'inperson';

/** The choice at the end of "Assigned to" in the editor. */
export const ANYONE = 'Anyone on the document';
export const ANYONE_VALUE = '__anyone';
/** Said in the editor and on the signing page. */
export const ANYONE_NOTE = 'Anyone on the document can fill it in.';
export const INITIALS_LABEL = 'Ask for initials when someone changes it';
export const AFTER_LABEL = 'Allow changes after someone has finished';
export const AFTER_HINT = 'Whoever already finished is then asked to sign again.';
export const NOT_REQUIRED = 'Nobody has to fill it in.';
/** The most changes one person may make to these fields on one document: enough for any real use, few enough that the
 *  audit trail stays readable (src/server/collab.ts). */
export const SHARED_MAX = 200;
/** With people signing in order, the first person finishes before the next one gets the document, so the field is
 *  theirs alone unless the sender allows changes after someone has finished. Said in the editor. */
export const ORDERED_NOTE = 'People sign in order, so once the first person has finished, nobody else can change it unless you allow changes after someone has finished.';
/** A change that asks someone to sign again is kept on this screen and sent with Finish, never by the autosave. */
export const holdsChange = (f: any): boolean => !!f?.shared && !!f?.sign_again?.length;
/** The answers the signing page's autosave sends: all but those held for Finish (holdsChange). */
export function withoutHeld(fields: any[] | undefined, values: Record<string, string>): Record<string, string> {
  const held = new Set((fields || []).filter(holdsChange).map((f) => f.id));
  return held.size ? Object.fromEntries(Object.entries(values).filter(([id]) => !held.has(id))) : values;
}
/** Initials are asked for before changing an answer that is there, never for the first answer in an empty field. */
export const initialsFirst = (f: any, ini: string | null | undefined): boolean => !!f?.shared && !!f.initials_on_change && !!f.value && !ini;
/** The choices of a group of radio buttons that go together with `field` (one answer: all for anyone or none). */
export function groupOf(field: any, list: any[]): string[] {
  if (field?.type !== 'radio') return [field?.id];
  const key = field.group_name || field.id;
  return list.filter((g) => g.type === 'radio' && g.recipient_id === field.recipient_id && (g.group_name || g.id) === key).map((g) => g.id);
}

/** The words under the field on the signing page. */
export function sharedNote(f: { last_by?: string | null; locked_by?: string[] | null; sign_again?: string[] | null; initials_on_change?: boolean }): string {
  if (f.locked_by?.length) return `${listNames(f.locked_by)} already finished, so this can no longer be changed.`;
  const last = f.last_by ? ` Last changed by ${f.last_by}.` : '';
  const again = f.sign_again?.length ? ` If you change it, ${listNames(f.sign_again)} ${f.sign_again.length === 1 ? 'is' : 'are'} asked to sign again when you finish.` : '';
  const ini = f.initials_on_change ? ' Changing an answer needs your initials.' : '';
  return `${ANYONE_NOTE}${last}${again}${ini}`;
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function listNames(names: string[]): string {
  const n = names.filter(Boolean);
  return n.length <= 1 ? n[0] || '' : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** A value as said on the record: a tick box and a choice by what they mean, words in quotes, nothing as "empty". */
export function saidValue(type: string, v: any): string {
  const s = String(v ?? '');
  if (type === 'checkbox') return s === '1' ? 'ticked' : 'not ticked';
  if (type === 'radio') return s === '1' ? 'chosen' : 'not chosen';
  return s ? `"${s.length > 300 ? `${s.slice(0, 300)}...` : s}"` : 'empty';
}
