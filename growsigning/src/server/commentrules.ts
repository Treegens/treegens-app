// The rules around what is written in the comments, beside who may read it (comments.ts) and the routes and emails
// (routes-comments.ts): the fake-payment-notice filter read over a day of words with the names printed beside them,
// how often a conversation can be marked as settled and how often that goes into the record, the same comment sent
// twice, and what is left of a comment in the webhook log once its envelope is deleted.
import { all, get, run } from './db.ts';
import { bad, now, rateLimit, rateWait } from './util.ts';
import { emailRefusal } from './envelopes.ts';
import { lureIn } from './fakenotice.ts';

const DAY_MS = 864e5;
const since = (ms = DAY_MS) => new Date(Date.now() - ms).toISOString();
const keyOf = (x: any) => `${x.recipient_id}|${x.party}`;
// A comment as it is printed: what it says and the name it is printed under.
const words = (rows: any[]) => rows.flatMap((x) => [x.body, x.name]);

// ---- The fake-payment-notice filter -----------------------------------------------------------------------------
//
// A notice split over three comments ("PayPal invoice", "$499 was charged", "call +1 888 ...") is shown together in
// one thread and arrives together in one email, so one comment at a time is never what is read. What the sender's
// side writes is read with everything that person wrote on the envelope in the last day, and with everything from the
// sender's side in the last day that each reader of the new comment can read, together with the names it is printed
// under (an admin who calls themselves "PayPal Resolution Center" is printed beside their words). emailRefusal reads
// the rest: the envelope's own text and the sender's and the account's names, and it decides which accounts the
// filter applies to.

export type Audience = { private: boolean; recipient_id?: string | null; party?: string | null };

// Why an answer was not emailed when the filter turned it down at the moment of sending (batchRefusal). It is not kept
// waiting for ever behind later answers: it is dropped with this reason, the sender is told, and what comes after it
// still goes. Such an answer is not read again with later ones: it was never sent.
export const FILTERED = 'Together with what they were already emailed about this document today, it reads like a payment notice from a well-known company with a phone number to call, and comments with words like these are not emailed. It is still on their signing page. Later answers are emailed as usual.';

export function senderRefusal(e: any, o: { author: string; name: string; text: string; to: Audience }): { status: number; message: string } | null {
  const recent = all(`SELECT c.body, c.name, c.author, t.private, t.recipient_id, t.party FROM comments c JOIN comment_threads t ON t.id=c.thread_id
    WHERE c.envelope_id=? AND c.by_sender=1 AND c.at > ? AND c.id NOT IN (SELECT comment_id FROM comment_news WHERE envelope_id=? AND dropped=?)`, e.id, since(), e.id, FILTERED);
  const ask = (rows: any[]) => emailRefusal(e, [], { extra: [...words(rows), o.text, o.name], pause: false });
  // Nothing in all of it together: then nothing in any part of it either. This is the usual answer, and one read.
  if (!ask(recent)) return null;
  const shared = recent.filter((x) => !x.private);
  // The readers of the new comment: the one person a private thread is with; for a thread for everyone, each person
  // with a private thread of their own (they read both), and everyone else (who reads the shared ones).
  const readers: (string | null)[] = o.to.private ? [keyOf(o.to)] : [null, ...new Set(recent.filter((x) => x.private).map(keyOf))];
  for (const rows of [recent.filter((x) => x.author === o.author), ...readers.map((k) => [...shared, ...(k ? recent.filter((x) => x.private && keyOf(x) === k) : [])])]) {
    const no = ask(rows);
    if (no) return no;
  }
  return null;
}

// At the moment answers are emailed to one person: the batch is read with what was emailed to them about this
// envelope in the last day, so a notice cannot be sent in parts ten minutes apart. Answers the filter turned down
// before are not read again (they were never sent), so a harmless answer after them still goes.
export function batchRefusal(e: any, audience: string, pending: any[]): { status: number; message: string } | null {
  const sent = all(`SELECT c.body, c.name FROM comment_news n JOIN comments c ON c.id=n.comment_id WHERE n.envelope_id=? AND n.audience=? AND n.mailed_at > ?`, e.id, audience, since());
  return emailRefusal(e, [], { extra: [...words(pending), ...words(sent)] });
}

// Someone on the envelope who writes for everyone is shown to people who did not choose them, and a public form's
// visitor writes to the owner as a stranger who typed their own name. Both are read for the notice whoever the account
// is: a day of what that person wrote where the same people read it, with the name printed beside it.
export function signerLure(e: any, o: { author: string; name: string; text: string; everyone: boolean; visitor: boolean }) {
  if (!o.everyone && !o.visitor) return null;
  const rows = all(`SELECT c.body FROM comments c JOIN comment_threads t ON t.id=c.thread_id WHERE c.envelope_id=? AND c.author=? AND c.at > ?${o.visitor ? '' : ' AND t.private=0'}`, e.id, o.author, since());
  return lureIn([...rows.map((x) => x.body), o.text, o.name]);
}

// ---- Settled, open again ----------------------------------------------------------------------------------------
//
// Each change is a line in the audit trail, which is printed in the certificate every party receives. Unlimited, a
// signer flipping it back and forth added hundreds of pages. So each person can change one conversation a few times
// an hour, and the record gets at most one line for each conversation an hour. The latest state is always on the
// thread itself, in the export and the evidence pack.
export const SETTLES_PER_HOUR = 10;
export function settleLimit(threadId: string, who: string) {
  const key = `settle:${threadId}:${who}`;
  const wait = rateWait(key, SETTLES_PER_HOUR);
  if (wait) throw bad(`That conversation was marked as settled or open again ${SETTLES_PER_HOUR} times in the last hour, which is as often as we take. Nothing was changed. Try again in ${Math.max(1, Math.ceil(wait / 60_000))} minute${Math.ceil(wait / 60_000) > 1 ? 's' : ''}, or write in it instead.`, 429);
  rateLimit(key, Infinity, 3600_000);
}
// True when this change is to be written into the record: the first in the last hour for this conversation. Taken in
// one statement, so two changes at the same moment never both write.
export const noteSettle = (threadId: string): boolean =>
  !!get('UPDATE comment_threads SET settle_noted_at=? WHERE id=? AND (settle_noted_at IS NULL OR settle_noted_at <= ?) RETURNING id', now(), threadId, since(3600_000));

// ---- The same comment twice -------------------------------------------------------------------------------------
//
// A double tap, or a program that sends again after a timeout, would post the same words twice and email them twice.
// The same person writing the same words to the same people within a few seconds is taken as the same comment: the
// first one is answered again and nothing more is stored or sent.
const SAME_MS = 15_000;
export function sameAgain(e: any, o: { author: string; text: string; threadId?: string | null; to?: Audience & { pin?: any } }): any | null {
  const rows = all(`SELECT c.id, c.thread_id, t.private, t.recipient_id, t.party, t.document_id, t.page, t.x, t.y,
      (SELECT id FROM comments f WHERE f.thread_id=c.thread_id ORDER BY f.at, f.rowid LIMIT 1) first
    FROM comments c JOIN comment_threads t ON t.id=c.thread_id WHERE c.envelope_id=? AND c.author=? AND col_find(c.body)=? AND c.at > ? ORDER BY c.at DESC, c.rowid DESC`, e.id, o.author, o.text, since(SAME_MS));
  const same = (a: any, b: any) => (a ?? null) === (b ?? null);
  return rows.find((x) => (o.threadId ? x.thread_id === o.threadId
    // A new conversation: the earlier one started its own, with the same readers and the same place on the page.
    : x.first === x.id && !!x.private === !!o.to?.private && same(x.recipient_id, o.to?.private ? o.to.recipient_id : null) && same(x.party, o.to?.private ? o.to.party : null)
      && same(x.document_id, o.to?.pin?.document_id) && same(x.page, o.to?.pin ? o.to.pin.page : null) && same(x.x, o.to?.pin?.x) && same(x.y, o.to?.pin?.y))) || null;
}

// ---- Deleting ---------------------------------------------------------------------------------------------------
//
// The comment.created deliveries in the webhook log hold what was written and who wrote it. When the envelope is
// deleted those words go too: the delivery stays listed, and sending it again sends it without them ("text" and
// "name" are null). Called from forgetEnvelopes (routes-trust.ts), before the envelope goes.
export function forgetCommentHooks(envelopeId: string) {
  for (const d of all("SELECT id, body FROM webhook_deliveries WHERE envelope_id=? AND event='comment.created' AND body IS NOT NULL", envelopeId)) {
    let b: any = null;
    try {
      b = JSON.parse(d.body);
    } catch {}
    if (b?.comment) run('UPDATE webhook_deliveries SET body=? WHERE id=?', JSON.stringify({ ...b, comment: { ...b.comment, text: null, name: null } }), d.id);
    else run('UPDATE webhook_deliveries SET body=NULL WHERE id=?', d.id);
  }
}
