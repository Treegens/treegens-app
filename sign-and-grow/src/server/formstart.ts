// A public form's visitor whose start was closed before they finished: left alone for too long (an hour on a shared
// device, a day otherwise), or past a deadline its template set. Nobody but that visitor knows of the start, so the
// form's owner is not emailed that "the deadline passed" and is not asked to give more time: the visitor is offered
// a fresh form instead. Not for a visitor who pressed Finish while no signature was free (form_waits_at): they were
// told that what they filled in is kept, so that start stays the owner's to reopen.
import { get } from './db.ts';
import { baseUrl } from './util.ts';

export const closedFormStart = (e: any, r: any): boolean =>
  !!e?.powerform_id && !!e.form_recipient_id && e.form_recipient_id === r?.id && e.status === 'expired' && !r.form_waits_at && r.status !== 'completed' && r.status !== 'declined';

// Where the visitor starts again: the form's page, while it still takes people.
export const startAgainSlug = (e: any): string | null => (e?.powerform_id && get('SELECT slug FROM powerforms WHERE id=? AND active=1', e.powerform_id)?.slug) || null;

// What the visitor is told when they press Finish, save or ask for more time on such a start.
export function closedStartText(e: any): string {
  const slug = startAgainSlug(e);
  return `This form was closed before it was finished, because forms that are left unfinished are cleared to make room for others. ${slug
    ? `To sign, start again at ${baseUrl()}/f/${slug}. The new form starts empty: what you typed here is not carried over.`
    : 'The form is not taking new people right now. Please contact whoever gave you the link.'}`;
}
