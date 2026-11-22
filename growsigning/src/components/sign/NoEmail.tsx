'use client';
import { noEmailCopyText, noEmailWaitText } from '@/lib/bysender';

// The signing page for someone with no email address here, whose link the sender passed on themselves (see
// src/lib/bysender.ts). Every promise of an email is replaced by what is true: nothing comes by email, "Find my
// documents" cannot find this document, and this same link is the way back to it.

/** After finishing: in place of "a copy has been emailed to you". */
export const NoEmailDone = ({ sender, allDone }: { sender: string; allDone: boolean }) => <p>{noEmailCopyText(sender, allDone)}</p>;

/** Before their turn: in place of "we will email you". */
export const NoEmailWait = ({ sender }: { sender: string }) => <p>{noEmailWaitText(sender)}</p>;

/** Where the question dialog says how the answer comes back. */
export const answerComesTo = (me: { email?: string; link_by_sender?: boolean }) => (me.email ? me.email : 'you the way they sent you this link');
