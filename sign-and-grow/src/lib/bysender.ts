// A recipient the sender reaches themselves: "I will send the link myself". Many people live in WhatsApp or text
// messages and have no email address they read, so the sender may give a person a name and no address. We send that
// person nothing, ever: no invitation, no reminder, no copy. The sender copies their link from the envelope page and
// passes it on, and the same link opens the completed document later. The record says "Link shared by the sender",
// because that is all we know: not how it was shared, and not that it arrived.
// The words both the pages and the server quote live here. Plain values and functions, so a page may import them.

/** What the certificate and the audit trail say in place of an email address. */
export const BY_SENDER_LINE = 'Link shared by the sender';

/** The tick in the editor. */
export const BY_SENDER_TICK = 'I will send the link myself';

/** Under the tick: what it does, what it costs and what it takes away, before anyone relies on it. */
export const BY_SENDER_HOW =
  'We send this person no email at all: no invitation, no reminders, no copy at the end. After sending, copy their link from the envelope page and send it by WhatsApp, text message or any chat, or show it as a QR code. Their link also opens the completed document, and it is the only way they get their copy: without an address, "Find my documents" on our help page cannot find it. If they sign, it uses one of your signatures, also when the person is you.';

/**
 * A person as the record names them: name and address, or name and how their link reached them. An address that is
 * missing for another reason (a group nobody has taken on) is printed as it always was.
 */
export const labelOf = (r: { name?: any; email?: any; link_by_sender?: any }): string =>
  !r?.email && r?.link_by_sender ? `${r?.name ?? ''} (link shared by the sender)` : `${r?.name ?? ''} <${r?.email ?? ''}>`;

/**
 * Why a person whose link the sender passes on cannot go out like this, or null. The editor shows it before Send,
 * and the server refuses with it when an envelope is sent or changed. `e` needs only its fields.
 */
export function bySenderProblem(r: any, e: { fields?: any[] } | null | undefined): string | null {
  if (!r?.link_by_sender) return null;
  const name = r.name || r.role_name || 'One of the recipients';
  const tick = `"${BY_SENDER_TICK}"`;
  if (r.group_id || r.group_name) return `${name} is a group, and every member of a group gets an email of their own. ${tick} is for one person. Untick it, or put that person on the envelope by name.`;
  if (r.role === 'inperson') return `${name} signs in person on your device, so there is no link to send them. Untick ${tick} for them.`;
  if (r.role === 'cc') return `${name} only gets a copy, and a copy goes out by email once everyone has finished. To give them the finished document yourself, download it from the envelope page then. Untick ${tick} for them, or let them view it instead.`;
  if (String(r.email || '').trim()) return `${name} has an email address and ${tick} ticked. Choose one: leave the address empty and send the link yourself, or untick it and we email them.`;
  if (r.verify === 'email_code') return `${name} has no email address here, so a one-time code by email could never reach them. Choose a one-time code by text message, an access code or no extra check for them.`;
  if (r.text_link) return `For ${name} both ${tick} and "also text the signing link" are on. Choose one of the two.`;
  // An Email field prints the person's address on the page, and there is none to print.
  if ((e?.fields || []).some((f: any) => f.recipient_id === r.id && f.type === 'email')) return `${name} has an Email field, which prints their email address on the document, and they have none here. Remove that field, or give them an address.`;
  return null;
}

/**
 * What saving a correction does to such a person, in place of the sentences that promise them an email (outcomes in
 * src/components/editor/changes.ts). Null where the usual sentence is already true for them.
 */
export function ownOutcome(kind: string, now: boolean, role: string): string | null {
  const did = role === 'approver' ? 'approved' : role === 'viewer' ? 'viewed' : 'signed';
  const redo = role === 'approver' ? 'approve' : role === 'viewer' ? 'confirm' : 'sign';
  const none = 'We send them no email';
  if (kind === 'sign_again') return `Already ${did}. This change touches what they ${did}, so they are asked to ${redo} again ${now ? 'now' : 'when it is their turn'}, on the same link. ${none}: tell them yourself. What they ${did} the first time stays on record.`;
  if (kind === 'held') return `Someone before them in the signing order has not finished, so their turn is taken back. ${none}: tell them yourself if they ask. What they filled in is kept.`;
  if (kind === 'updated') return `Keeps the same link. ${none}: tell them yourself that the document changed.`;
  if (kind === 'new_link') return now ? `Gets a new link, and the old one stops working. ${none}: send them the new link yourself from the envelope page.` : 'The old link stops working. When it is their turn we tell you, and you send them the new one.';
  if (kind === 'invited') return now ? `Is added. ${none}: send them their link from the envelope page once you have saved.` : 'Is added. When it is their turn we tell you, and you send them their link.';
  if (kind === 'waiting' && now) return `It is now their turn. ${none}: send them their link from the envelope page.`;
  return null;
}

/** How the record and the sender's emails start a sentence about something this signer asked for. */
export const signerAt = (r: { name?: any; email?: any }): string => (r?.email ? `The signer at ${r.email}` : `${r?.name ?? 'The signer'}, whose link the sender shares,`);

/** On the signing page, after finishing: what comes by email, which is nothing, and what to keep instead. */
export const noEmailCopyText = (sender: string, allDone: boolean): string =>
  allDone
    ? `We have no email address for you, so no copy comes by email, and "Find my documents" on our help page cannot find this one. Download your copy now. This same link keeps opening the completed document for as long as ${sender} keeps their account, so keep it, or ask ${sender} for it again.`
    : `We have no email address for you, so we cannot tell you when the others have finished. ${sender} can. This same link opens the completed document once everyone has signed, so keep it, and download your copy then. "Find my documents" on our help page cannot find this one.`;

/** On the signing page, when it is not yet their turn. */
export const noEmailWaitText = (sender: string): string =>
  `Others need to finish first. We have no email address for you, so ${sender} will tell you when it is your turn. This same link opens the document then. There is nothing to do until then.`;

/**
 * On the signing page, once someone asked for more time: how an answer reaches them. Someone with no address here
 * is never told "by email" (the sender has no address of theirs either, and is told so: answerLine in
 * src/server/bysender.ts). `say` is the toast, `hint` the line under the menu item, `open` the expired screen.
 */
export const moreTimeWords = (sender: string, bySender: boolean): { say: string; hint: string; open: string } =>
  bySender
    ? { say: `We asked ${sender} for more time. They have no email address for you here, so they will reach you the way they sent you this link.`, hint: 'Asked. They will reach you the way they sent you this link.', open: `We cannot email you, so ${sender} will let you know when it is open again. This same link opens it then.` }
    : { say: `We asked ${sender} for more time. They will be in touch by email.`, hint: 'Asked. They will be in touch by email.', open: 'You will get an email as soon as the document is open again.' };

/** The toast after "Finish later": where the way back is. */
export const laterWords = (bySender: boolean): string => (bySender ? 'Saved. Come back with this same link to finish.' : 'Saved. Use the link in your email to come back and finish.');
