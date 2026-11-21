import { run } from './db.ts';
import { bad, str } from './util.ts';
import { audit, notifySender, type Actor } from './envelopes.ts';
import { labelOf, bySenderProblem } from '../lib/bysender.ts';

// "I will send the link myself" (recipients.link_by_sender): a person with a name and no email address, whom the
// sender reaches themselves, often on WhatsApp or by text message. The words are in src/lib/bysender.ts.
//
// What it means everywhere: nothing is ever emailed to that person (notifyRecipient asks bySenderNotice instead), the
// sender is told whatever the person would have been told and only the sender can pass on (their turn came, a
// reminder from the timer, the document is complete), and the record says "link shared by the sender" in place of an
// address, because we do not know how the link travelled or whether it arrived. The person still counts wherever
// people are counted: a signature is held and used for them like for anyone who is not the sender, they count
// towards the daily limit on new people (reachKey), and a report from them counts towards the automatic pause as a
// person of their own (reporterKey). envelopes.ts and a few routes call in here at the places where that differs.
// Nothing in here calls into envelopes.ts while this module is being loaded, which is what lets the two files use
// each other.

const SYSTEM: Actor = { name: 'System' };
const yes = (v: any) => v === true || v === 1 || v === '1' || v === 'true';
const names = (l: any[]) => (l.length < 3 ? l.map((r) => r.name).join(' and ') : `${l.slice(0, -1).map((r) => r.name).join(', ')} and ${l[l.length - 1].name}`);
const verbOf = (r: any) => (r.role === 'approver' ? 'approve' : r.role === 'viewer' ? 'read and confirm' : 'sign');

/**
 * Called by writeContent() in envelopes.ts once the recipients of a save are written, inside its transaction. Reads
 * "link_by_sender" of every recipient in the request. Left out, it stays as it was, except that a request which now
 * gives the person an email address means we email them, so the tick goes. What cannot work with it is said when
 * the envelope is sent or corrected (bySenderProblem), so a draft can hold a half-finished choice like a half-typed
 * address. A template is refused at once: an envelope made from it would otherwise lose the tick without a word.
 */
export function saveBySender(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>) {
  for (const { rid, r, i } of asked) {
    const old = before.get(rid);
    const typed = str(r?.email, 254).trim();
    const tick = r?.link_by_sender === undefined ? (old?.link_by_sender && !typed ? 1 : 0) : yes(r.link_by_sender) ? 1 : 0;
    if (tick && e.kind === 'template')
      throw bad(`Recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''} has "link_by_sender" set, and this is a template. Leave it out here, and tick "I will send the link myself" on the envelope you make from the template. Nothing was saved.`);
    run('UPDATE recipients SET link_by_sender=? WHERE id=?', tick, rid);
  }
}

// Why a person whose link the sender passes on cannot go out like this: one rule for the editor and the server, in
// src/lib/bysender.ts. assertSendable in envelopes.ts asks it when an envelope is sent and whenever one that is out
// is changed.
export { bySenderProblem };

/** The quick correction (POST /envelopes/:id/correct) of someone who stays without an address cannot ask for a code by email. */
export function assertBySenderCorrection(e: any, recipientId: string, patch: any) {
  const r = e?.recipients?.find((x: any) => x.id === recipientId);
  if (!r?.link_by_sender || str(patch?.email, 254).trim()) return;
  const after = { ...r, verify: patch?.verify !== undefined ? patch.verify : r.verify, text_link: patch?.text_link !== undefined ? yes(patch.text_link) : r.text_link };
  const problem = bySenderProblem(after, e);
  if (problem) throw bad(`${problem} Nothing was changed.`);
}

/** Who a person is for the daily limit on new people: their address, or, without one, this one person on this envelope. */
export const reachKey = (r: any): string => (r?.link_by_sender && !r.email ? `link:${r.id}` : r?.email || '');

/** Who reported, for counting different people towards the automatic pause. */
export const reporterKey = (r: any): string => (r?.link_by_sender && !r.email ? `link:${r.id}` : r?.email || '');

/** A copy goes with an envelope that is copied as an envelope, and not into a template or to a row that brings an address. */
export function copyBySender(from: any, newId: string, fill: any, kind: string) {
  if (!from?.link_by_sender || kind !== 'envelope' || str(fill?.email, 254).trim()) return;
  run('UPDATE recipients SET link_by_sender=1 WHERE id=?', newId);
}

/**
 * In place of every email to this person (notifyRecipient in envelopes.ts). Nothing is written to them. When their
 * turn comes because someone before them finished, the sender is the only one who can tell them, so the sender is
 * told. On the first send the sender is looking at the envelope page, which says it.
 */
export async function bySenderNotice(e: any, r: any, kind: string): Promise<false> {
  if (kind === 'new' && (e.recipients || []).some((x: any) => x.id !== r.id && x.status === 'completed' && x.role !== 'cc'))
    await notifySender(e, 'always', `Your turn to pass it on: ${e.subject}`, `It is now ${r.name}'s turn`,
      [`It is now ${r.name}'s turn to ${verbOf(r)} "${e.subject}". You said you would send them the link yourself, so we did not write to them.`,
        'Open the envelope to copy their link, or share it on WhatsApp or by text message from there.']);
  return false;
}

/** A nudge by hand to one such person is refused in words: there is nobody to email. The timer is answered elsewhere. */
export function assertNudgeable(e: any, recipientId: string | undefined, actor: Actor) {
  const r = recipientId && actor.name !== SYSTEM.name ? (e.recipients || []).find((x: any) => x.id === recipientId) : null;
  if (r?.link_by_sender) throw bad(`${r.name} gets no email from us: you said you would send them the link yourself. Copy it from the envelope page and send it to them again. Nothing was sent.`);
}

/**
 * The reminder the timer sends (the envelope's "remind every N days") reaches these people through the sender, so it
 * goes to the sender, once for all of them, and the record says so.
 */
export async function remindThroughSender(e: any, waiting: any[], actor: Actor) {
  const l = waiting.filter((r) => r.link_by_sender && !r.muted);
  if (!l.length || actor.name !== SYSTEM.name) return;
  await notifySender(e, 'always', `Reminder to pass on: ${e.subject}`, `${names(l)} ${l.length === 1 ? 'has' : 'have'} not finished yet`,
    [`You said you would send the link to ${names(l)} yourself, so the reminder this envelope is set to send comes to you instead.`,
      `If ${l.length === 1 ? 'they need' : 'anyone needs'} it again, open the envelope and copy the link, or share it on WhatsApp or by text message from there.`]);
  audit(e.id, SYSTEM, 'Reminder sent to the sender', `${l.map(labelOf).join(', ')}. Their link is shared by the sender, so the reminder went to the sender.`);
}

/** The sender's warning that a deadline is near, about people nobody else can tell. */
export const untoldLines = (waiting: any[]): string[] => {
  const l = waiting.filter((r) => r.link_by_sender);
  return l.length ? [`You send the link to ${names(l)} yourself, so we did not tell ${l.length === 1 ? 'them' : 'any of them'} about the deadline. Let them know if they still need to ${l.every((r) => verbOf(r) === 'sign') ? 'sign' : 'finish'}.`] : [];
};

/** "Not opened yet", said to the sender in the words that fit how each person got their link. */
export function unopenedLines(list: any[]): string[] {
  const mailed = list.filter((r) => !r.link_by_sender);
  const shared = list.filter((r) => r.link_by_sender);
  return [
    ...(mailed.length ? ['The email may be sitting in a spam folder or have gone to the wrong address.', 'From the envelope page you can copy their signing link and send it yourself by text or chat, nudge them, or correct the address without voiding anything.'] : []),
    ...(shared.length ? [`You said you would send the link to ${names(shared)} yourself. If you have, it has not been opened yet. Copy it again from the envelope page, or check that it went to the right chat.`] : []),
  ];
}

/** The completed copy for someone with no address: the record says it was not emailed and where it is instead. */
export function noteNoCopy(e: any, r: any) {
  if (r?.link_by_sender) audit(e.id, SYSTEM, 'Copy not emailed', `${labelOf(r)}. There is no email address for them, so no copy was emailed. Their link opens the completed document, and the sender can pass it on again.`);
}

/** What the sender's "complete" email adds, so the people only they can reach get their copy. */
export const senderCopyLines = (e: any): string[] => {
  const l = (e?.recipients || []).filter((r: any) => r.link_by_sender);
  return l.length ? [`We have no email address for ${names(l)}, so no copy went to ${l.length === 1 ? 'them' : 'them by email'}. ${l.length === 1 ? 'Their link opens' : 'Each of their links opens'} the completed document: copy it from the envelope page and send it on, or send them the PDF yourself.`] : [];
};

/** The sender's way to answer a question from someone with no address. */
export const answerLine = (r: any): string =>
  r?.email ? `Reply to this email to answer ${r.name} (${r.email}) directly.` : `${r?.name} has no email address here, so this email has no reply address of theirs. Answer them the way you sent them the link.`;
