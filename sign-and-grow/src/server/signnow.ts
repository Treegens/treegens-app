// "Sign now" (research/ux-charter.md, 2.3): when the only person on a document is its sender, signing on screen at
// their own sign-in address, step 3's main button sends it and opens the signing page in the same tab. No invitation
// email is written for that one request, because the person it would go to is already looking at the document. The
// rule for when this applies is src/lib/editorux.ts onlyMe, the same one the editor uses for the button's words.
//
// What it never does: skip an email to anybody else, skip a check the sender put on themselves (an access code or a
// one-time code is still asked for on the signing page), or change what the record says. The record gets one line
// that says no invitation was emailed and why. Reminders and every later email go out as for any other document.

import { onlyMe } from '../lib/editorux.ts';

// Recipient ids whose invitation is not written during the send that is running right now. In memory, for the few
// milliseconds between "sent" and the first email: an entry is taken out as soon as it is read.
const quiet = new Set<string>();

/**
 * The one recipient a "sign_now" send is for, or null when it is an ordinary send. `callerEmail` is the address of
 * the signed-in person who pressed the button: an API key, or a colleague sending someone else's draft, gets null.
 */
export function signNowFor(e: any, sender: { email?: string } | null | undefined, callerEmail: string | null | undefined, asked: unknown): any | null {
  if (asked !== true || !sender?.email || !callerEmail) return null;
  if (String(callerEmail).trim().toLowerCase() !== String(sender.email).trim().toLowerCase()) return null;
  return onlyMe(e?.recipients || [], sender.email);
}

export const holdInvite = (recipientId: string) => void quiet.add(recipientId);
/** True once for a recipient whose invitation was held back: the caller then writes no email for them. */
export const inviteHeld = (recipientId: string): boolean => quiet.delete(recipientId);
/** Called when the send is over, whatever happened, so nothing stays behind after a send that failed. */
export const dropHold = (recipientId: string) => void quiet.delete(recipientId);

export const SIGN_NOW_AUDIT = 'Not emailed';
export const signNowNote = (who: string) => `${who}. The sender chose Sign now and went straight to the signing page, so no invitation email went out.`;
