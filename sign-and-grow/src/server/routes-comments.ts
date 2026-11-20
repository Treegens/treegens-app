// Questions and comments on a document while it is out, so a question about a clause is asked and answered where the
// document is, before anyone signs. Who reads which thread is decided in comments.ts; here are the routes for both
// sides, the limits, and the emails.
//
// The emails. The sender gets one email about new comments, at most one every COMMENT_MAIL_MINUTES for each envelope,
// with the comments in it. A person on the envelope gets one when the sender's side answers them: in their private
// thread, or in a thread for everyone that they wrote in. A comment for everyone that the sender starts emails nobody,
// and the sender is told so. What the sender's side writes goes to someone's inbox in the sender's name, so it is held
// to the rules of every such email (emailRefusal in envelopes.ts): it waits while sending is paused, and it is refused
// when it reads like a fake payment notice, because the signing page would show it on our address too.
//
// The record. The audit trail says that a comment was written, by whom and when, never its words. Comments are not
// printed on the document and are not part of what is signed. The sender's export and evidence pack carry the full
// threads. Once the envelope is no longer out they can be read and not changed, and they go with the envelope.
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, now, rateLimit, rateWait, baseUrl } from './util.ts';
import { sendMail, type Mail } from './mail.ts';
import { fireWebhooks } from './webhooks.ts';
import { audit, loadEnvelope, senderOf, signUrl, pausedText } from './envelopes.ts';
import { find, look } from './routes-sign.ts';
import { mine } from './routes-envelopes.ts';
import { partyOf, sees, threadsOf, newThread, newComment, type Viewer } from './comments.ts';
import { holdsDevice } from './handlive.ts';
import { senderRefusal, batchRefusal, signerLure, settleLimit, noteSettle, sameAgain, FILTERED, type Audience } from './commentrules.ts';
import { pinWords, type Pin } from '../lib/comments.ts';
import { COMMENT_MAX_CHARS, COMMENTS_PER_PERSON, COMMENT_BURST, COMMENT_BURST_MINUTES, COMMENT_MAIL_MINUTES, COMMENTS_NOT_SIGNED } from '../lib/policy.ts';

const brandOf = (accountId: string) => {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
};
const joinNames = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
const senderName = (e: any) => senderOf(e)?.name || 'the sender';
const reachSender = (e: any) => {
  const s = senderOf(e);
  return s?.email ? `${s.name} (${s.email})` : senderName(e);
};

// What is typed, as it is kept. Control characters other than line breaks and tabs are taken out: they print nothing
// and can hide or reorder words on the other person's screen. Nothing is cut short without a word: a comment that is
// too long is refused and says by how much.
function textOf(v: any): string {
  if (v != null && typeof v !== 'string') throw bad('Send the comment as text in "text". Nothing was sent.');
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  if (!s) throw bad('Type your question or comment first. Nothing was sent.');
  if (s.length > COMMENT_MAX_CHARS) throw bad(`A comment can be up to ${COMMENT_MAX_CHARS} characters, and this one has ${s.length}. Make it shorter or split it in two. Nothing was sent.`);
  return s;
}

// A place on a page, or the whole document when left out. Checked like a field: a document of this envelope, a page
// it has, and a point given as fractions of the page from its top left corner, both or neither.
function pinFrom(e: any, p: any): Pin | null {
  if (p == null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) throw bad('"pin" is an object with "document_id" and "page", and "x" and "y" if you like. Leave it out for a comment on the whole document. Nothing was sent.');
  const d = (e.documents || []).find((x: any) => x.id === p.document_id);
  if (!d) throw bad(`"pin.document_id" names no document on this envelope. It has: ${e.documents.map((x: any) => `${x.id} (${x.name})`).join(', ')}. Nothing was sent.`);
  if (!Number.isInteger(p.page) || p.page < 0 || p.page >= d.pages) throw bad(`"pin.page" counts from 0, and ${d.name} has ${d.pages} page${d.pages === 1 ? '' : 's'}, so it is a whole number from 0 to ${d.pages - 1}. Nothing was sent.`);
  const frac = (v: any, k: string) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw bad(`"pin.${k}" is a fraction of the page from 0 to 1, measured from its top left corner. Nothing was sent.`);
    return v;
  };
  const x = frac(p.x, 'x'), y = frac(p.y, 'y');
  if ((x == null) !== (y == null)) throw bad('Give both "pin.x" and "pin.y" for a place on the page, or neither for the whole page. Nothing was sent.');
  return { document_id: d.id, document: d.name, page: p.page, x, y };
}

// The limits: 50 comments for each person on one envelope, and a burst limit for each signing link (or each person
// on the sender's side), so neither side can bury the other or fill an inbox. Asked once everything else about the
// request is known to be right, and the burst is only used up by a comment that is stored (spend): a mistyped thread
// or a refused audience must never lock a person out of asking their real question.
function limits(e: any, author: string, burstKey: string, burst: number) {
  const n = get('SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND author=?', e.id, author).n;
  if (n >= COMMENTS_PER_PERSON) throw bad(`You have written ${COMMENTS_PER_PERSON} comments on this document, which is as many as one person can. Nothing was sent. If there is more to say, ${author.startsWith('u:') ? 'call or email them' : `email ${reachSender(e)}`}.`, 429);
  const wait = rateWait(burstKey, burst);
  if (wait) throw bad(`That is ${burst} comments in ${COMMENT_BURST_MINUTES} minutes, which is as many as we take in that time. Nothing was sent. Wait ${Math.max(1, Math.ceil(wait / 60_000))} minute${Math.ceil(wait / 60_000) > 1 ? 's' : ''} and send it again: what you typed is still in the box.`, 429);
}
const spend = (burstKey: string) => rateLimit(burstKey, Infinity, COMMENT_BURST_MINUTES * 60_000);

// Said to someone on the envelope whose words for everyone, or whose words as a public form's visitor, read like a
// fake payment notice (signerLure in commentrules.ts). Whoever they are, they get a way to say what they meant.
function lureWords(e: any, l: { brand: string; money: string; phone: string }, visitor: boolean): string {
  return `This reads like a payment notice from a well-known company with a phone number to call, which is how scams look, so we do not pass it on${visitor ? '' : ' to the other people on this document'}. What set it off, in what you wrote here today and your name: the name ${l.brand}, words about money ("${l.money}") and what looks like a phone number (${l.phone}). Take one of the three out and send it again.${visitor ? '' : ` To ask ${senderName(e)} about a payment, choose "Only ${senderName(e)}" instead: that goes to them alone.`} Nothing was sent.`;
}

// ---- The signing page ------------------------------------------------------------------------

const visitorOf = (e: any, r: any) => !!e.powerform_id && e.form_recipient_id === r.id;
// On a device where people sign in person one after the other, the page of someone who no longer holds it reads only
// what is for everyone: no private thread is with "away", and nothing is written there in that person's name
// (handlive.ts). Without a request (the emails) the viewer is the person themselves.
const AWAY = 'away';
const viewerOf = (r: any, c?: Ctx): Viewer & { side: 'recipient' } => ({ side: 'recipient', rid: r.id, party: c && !holdsDevice(c, r) ? AWAY : partyOf(r) });
const awayText = (e: any, r: any) => `This is the signing page of ${r.name}, and this device has been handed to someone else since. So ${r.name}'s private questions are not shown here, and nothing can be written here in their name. What is written for everyone is still shown. If you are ${r.name}, ask ${senderName(e)} to open your page for you again with "Host signing now".`;

// Someone on the envelope reads comments while they can read the document: once it is their turn, while it is out and
// after everyone finished. They write only while it is out. A closed envelope keeps its comments for the sender.
function signerSide(e: any, r: any, writing: boolean) {
  if (r.status === 'pending') throw bad(`It is not your turn yet, so this document and its comments are not open to you yet. We will email you when it is. To reach ${reachSender(e)} before that, reply to the email you got from us.`, 403, { code: 'not_your_turn' });
  if (e.status !== 'sent' && e.status !== 'completed') throw bad(`This document is closed, so its comments are closed too. ${senderName(e)} still has them.`, 403, { code: 'closed' });
  if (writing && e.status !== 'sent') throw bad(`Everyone has finished, so the comments on this document can be read but no longer added to. To reach ${reachSender(e)}, write to them directly.`, 409, { code: 'read_only' });
}

function signerView(e: any, r: any, c: Ctx) {
  const v = viewerOf(r, c);
  const away = v.party === AWAY;
  const threads = threadsOf(e, v);
  const left = COMMENTS_PER_PERSON - get('SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND author=?', e.id, `r:${r.id}|${v.party}`).n;
  return {
    threads,
    // Questions of this person that the sender's side has not answered yet: said, never blocking, before Finish.
    waiting: threads.filter((t) => t.waiting && t.comments[t.comments.length - 1]?.mine).length,
    may_write: e.status === 'sent' && !away,
    away: away ? awayText(e, r) : null,
    // A visitor of a public form typed their own name: what they write goes to the form's owner only.
    for_everyone: !visitorOf(e, r),
    // Where an answer is emailed, or null when it is not: no address, signing in person on the host's device, an
    // address that bounced or that marked our email as spam (reach, the same rule the emails follow).
    answers_to: ((to) => (typeof to === 'string' ? null : to.email))(reachOf(e, r)),
    left: Math.max(0, left), max_chars: COMMENT_MAX_CHARS, not_signed: COMMENTS_NOT_SIGNED,
  };
}

route('GET', '/sign/:token/comments', (c) => {
  const { e, r } = find(c);
  signerSide(e, r, false);
  return signerView(e, r, c);
}, 'public');

async function writeAsSigner(c: Ctx, body: any) {
  // Read the body, then look the link up again: see checkedBody in routes-sign.ts.
  const { e, r, actor } = look(c);
  signerSide(e, r, true);
  const text = textOf(body.text);
  const v = viewerOf(r, c);
  if (v.party === AWAY) throw bad(`${awayText(e, r)} Nothing was sent.`, 403, { code: 'handed_on' });
  const author = `r:${r.id}|${v.party}`;
  const visitor = visitorOf(e, r);
  // Where it goes is settled first, and nothing is counted or stored before everything about it is known to be right.
  let t: any = null, pin: Pin | null = null, everyone: boolean;
  if (body.thread_id != null) {
    t = get('SELECT * FROM comment_threads WHERE id=? AND envelope_id=?', String(body.thread_id), e.id);
    // Another person's private thread is answered exactly like one that does not exist: nothing about it is given away.
    if (!t || !sees(t, v)) throw bad('That conversation is not on this document. Load the page again to see the ones you can read. Nothing was sent.', 404);
    everyone = !t.private;
  } else {
    // The usual is private: people ask things they do not want the other party to read.
    const forWhom = body.for ?? 'sender';
    if (forWhom !== 'sender' && forWhom !== 'everyone') throw bad('"for" is "sender" (only the sender\'s side reads it, the usual) or "everyone" (everyone on this document reads it). Nothing was sent.');
    everyone = forWhom === 'everyone';
    pin = pinFrom(e, body.pin);
  }
  // A visitor of a public form typed their own name, and the others on the document did not choose them: they write
  // to the form's owner only, also when the owner started a conversation for everyone.
  if (everyone && visitor) throw bad(t ? `On a public form, what you write here goes to ${senderName(e)} only, and everyone on the document reads this conversation. Ask ${senderName(e)} in a question of your own instead. Nothing was sent.` : `On a public form, what you write here goes to ${senderName(e)} only. Send it to them instead. Nothing was sent.`, 403);
  const again = sameAgain(e, { author, text, threadId: t?.id, to: t ? undefined : { private: !everyone, recipient_id: r.id, party: v.party, pin } });
  if (again) return { thread_id: again.thread_id, comment_id: again.id, again: true, ...signerView(e, r, c) };
  const burstKey = `comment:${c.params.token}`;
  limits(e, author, burstKey, COMMENT_BURST);
  const lure = signerLure(e, { author, name: r.name, text, everyone, visitor });
  if (lure) throw bad(lureWords(e, lure, visitor), 422);
  spend(burstKey);
  const tid: string = t?.id ?? newThread(e, { private: !everyone, recipient_id: r.id, party: v.party, party_name: r.name, pin });
  const cm = newComment(e, tid, { by_sender: false, author, recipient_id: r.id, party: v.party, name: r.name, email: r.email || null, body: text });
  audit(e.id, actor, 'Comment', `${r.name} wrote a comment. What it says is kept with the comments and is not part of this record or of what is signed.`);
  run('INSERT INTO comment_news (envelope_id, comment_id, audience, at) VALUES (?,?,?,?)', e.id, cm.id, 'sender', now());
  hook(e, cm);
  await flushComments(e.id);
  return { thread_id: tid, comment_id: cm.id, ...signerView(loadEnvelope(e.id), r, c) };
}

route('POST', '/sign/:token/comments', async (c) => {
  find(c);
  const body = await c.body();
  return writeAsSigner(c, body);
}, 'public');

// "Ask the sender a question" was a separate email. It is now a private comment, so there is one way to ask and the
// answer lands where the question is. Kept for pages and programs that still call it.
route('POST', '/sign/:token/ask', async (c) => {
  find(c);
  const body = await c.body();
  return writeAsSigner(c, { text: body.message ?? body.text, for: 'sender' });
}, 'public');

// The person who started a thread, or the one a private thread is with, can say it is settled ("that answers it").
route('POST', '/sign/:token/comments/:thread/settle', async (c) => {
  find(c);
  const body = await c.body().catch(() => ({}));
  const { e, r, actor } = look(c);
  signerSide(e, r, true);
  const v = viewerOf(r, c);
  if (v.party === AWAY) throw bad(awayText(e, r), 403, { code: 'handed_on' });
  const t = get('SELECT * FROM comment_threads WHERE id=? AND envelope_id=?', c.params.thread, e.id);
  if (!t || !sees(t, v)) throw bad('That conversation is not on this document. Load the page again to see the ones you can read.', 404);
  const first = get('SELECT * FROM comments WHERE thread_id=? ORDER BY at, rowid LIMIT 1', t.id);
  const theirs = (t.private && t.recipient_id === v.rid && t.party === v.party) || (!!first && !first.by_sender && first.recipient_id === v.rid && first.party === v.party);
  if (!theirs) throw bad('Only the person who started this conversation, or the sender, can mark it as settled. You can still answer in it.', 403);
  settle(e, t, body.settled !== false, r.name, actor, `r:${c.params.token}`);
  return signerView(loadEnvelope(e.id), r, c);
}, 'public');

// `by` is who is counted for the limit: the signing link, or the person on the sender's side. A change that changes
// nothing is not counted. The record gets one line for each conversation an hour at most (commentrules.ts).
function settle(e: any, t: any, on: boolean, who: string, actor: any, by: string) {
  if (on === !!t.settled_at) return;
  settleLimit(t.id, by);
  run('UPDATE comment_threads SET settled_at=?, settled_by=? WHERE id=?', on ? now() : null, on ? who : null, t.id);
  if (noteSettle(t.id)) audit(e.id, actor, on ? 'Comment settled' : 'Comment opened again', `${who} marked a conversation in the comments as ${on ? 'settled' : 'open again'}.`);
}

// ---- The sender's side -----------------------------------------------------------------------

function senderSide(c: Ctx, writing: boolean) {
  const e = mine(c, c.params.id, 'envelope', { removed: !writing });
  if (e.status === 'draft') throw bad('This envelope has not been sent, so nobody can comment on it yet.', 409, { code: 'draft' });
  if (writing && e.status !== 'sent') throw bad('This envelope is no longer out for signing, so its comments can be read but no longer added to or changed. They are kept with the envelope, and its export and evidence pack carry them.', 409, { code: 'read_only' });
  return e;
}

// The people the sender's side can write to privately now: whoever can read the document. A group that nobody has
// taken on is no one person yet, so it is written to with a comment for everyone.
const reachable = (e: any) => e.recipients.filter((r: any) => r.status !== 'pending' && !(r.group_name && !r.claimed_by));

function senderView(e: any) {
  // Whether each person is emailed an answer, and why not, so the card never promises an email that does not go.
  const mailable = (to: any) => (typeof to === 'string' ? { emailed: false, not_emailed: to } : { emailed: true, not_emailed: null });
  const party = new Map(all('SELECT id, party FROM comment_threads WHERE envelope_id=? AND private=1', e.id).map((x) => [x.id, x.party]));
  const threads = threadsOf(e, { side: 'sender' }).map((t) => (t.with ? { ...t, with: { ...t.with, ...mailable(reach(e, `${t.with.recipient_id}|${party.get(t.id)}`)) } } : t));
  return {
    threads,
    // Who has not been answered: each thread whose last word is from someone on the envelope, with their name.
    waiting: threads.filter((t) => t.waiting).map((t) => ({ thread_id: t.id, name: t.comments[t.comments.length - 1].name })),
    may_write: e.status === 'sent',
    people: e.status === 'sent' ? reachable(e).map((r: any) => ({ id: r.id, name: r.name, role: r.role, ...mailable(reachOf(e, r)) })) : [],
    // Answers wait while sending is paused: the card says so instead of only "waiting".
    paused: !!get('SELECT suspended_at FROM accounts WHERE id=?', e.account_id)?.suspended_at,
    max_chars: COMMENT_MAX_CHARS, mail_minutes: COMMENT_MAIL_MINUTES, not_signed: COMMENTS_NOT_SIGNED,
  };
}

// Reading is also for an admin after the sender removed a finished envelope from their lists: the account keeps it,
// and its evidence pack carries these same threads (mine with `removed`).
route('GET', '/envelopes/:id/comments', (c) => senderView(senderSide(c, false)));

route('POST', '/envelopes/:id/comments', async (c) => {
  const body = await c.body();
  const e = senderSide(c, true);
  const text = textOf(body.text);
  const author = `u:${c.user.id}`;
  // Where it goes is settled first, and nothing is counted or stored before everything about it is known to be right.
  let t: any = null, to: Audience & { pin?: Pin | null; name?: string };
  if (body.thread_id != null) {
    t = get('SELECT * FROM comment_threads WHERE id=? AND envelope_id=?', String(body.thread_id), e.id);
    if (!t) throw bad('That conversation is not on this envelope. Load the page again. Nothing was sent.', 404);
    to = { private: !!t.private, recipient_id: t.recipient_id, party: t.party };
  } else {
    // Who can read a new thread is never guessed: a private word sent to everyone by mistake cannot be taken back.
    const forWhom = body.for;
    if (forWhom === 'everyone') to = { private: false, pin: pinFrom(e, body.pin) };
    else {
      const r = typeof forWhom === 'string' ? e.recipients.find((x: any) => x.id === forWhom) : null;
      if (!r) throw bad(`Say who can read it: "for": "everyone", or the id of one person on the envelope to write to them alone.${reachable(e).length ? ` They are: ${reachable(e).map((x: any) => `${x.id} (${x.name})`).join(', ')}.` : ''} Nothing was sent.`);
      if (!reachable(e).includes(r)) throw bad(r.status === 'pending' ? `It is not ${r.name}'s turn yet, so they cannot open the document or its comments. Write to them once it is, or write for everyone. Nothing was sent.` : `Nobody in ${r.group_name} has taken the document on yet, so there is no one person to write to privately. Write for everyone on the document instead. Nothing was sent.`, 409);
      to = { private: true, recipient_id: r.id, party: partyOf(r), name: r.name, pin: pinFrom(e, body.pin) };
    }
  }
  const again = sameAgain(e, { author, text, threadId: t?.id, to: t ? undefined : to });
  if (again) return senderAnswer(e, again.thread_id, again.id, 'This was already sent a moment ago, so it was not sent again.');
  // A person on the sender's side answers many people, so their burst is wider than one signing link's.
  const burstKey = `comment:${author}:${e.id}`;
  limits(e, author, burstKey, COMMENT_BURST * 3);
  // Shown on a signing page on our address and emailed in the sender's name: read like any email the sender starts,
  // together with what was written before and the name it is printed under (senderRefusal in commentrules.ts).
  const fake = senderRefusal(e, { author, name: c.user.name, text, to });
  if (fake) throw bad(`${fake.message} Nothing was sent.`, 422);
  spend(burstKey);
  if (!t) t = get('SELECT * FROM comment_threads WHERE id=?', to.private
    ? newThread(e, { private: true, recipient_id: to.recipient_id, party: to.party, party_name: to.name, pin: to.pin })
    : newThread(e, { private: false, pin: to.pin }));
  const cm = newComment(e, t.id, { by_sender: true, author, name: c.user.name, email: c.user.email, body: text });
  audit(e.id, c.actor, 'Comment', `${c.user.name} wrote a comment. What it says is kept with the comments and is not part of this record or of what is signed.`);
  // Who hears about it: the person a private thread is with, or in a thread for everyone, whoever on the envelope
  // wrote in it. They are answered. Nobody else is emailed.
  const audiences = t.private ? [`${t.recipient_id}|${t.party}`]
    : [...new Set(all('SELECT recipient_id, party FROM comments WHERE thread_id=? AND by_sender=0', t.id).map((x) => `${x.recipient_id}|${x.party}`))];
  for (const a of audiences) run('INSERT INTO comment_news (envelope_id, comment_id, audience, at) VALUES (?,?,?,?)', e.id, cm.id, a, now());
  hook(e, cm);
  await flushComments(e.id);
  return senderAnswer(loadEnvelope(e.id), t.id, cm.id, ['Saved. Everyone it is for sees it on their signing page.',
    ...(!audiences.length ? ['Nobody is emailed about a new comment for everyone: each person sees it when they open the document.'] : [])].join(' '));
});

// The answer to a comment of the sender's side: what became of it for each person it is for, in words for the screen.
function senderAnswer(e: any, threadId: string, commentId: string, said: string) {
  const view = senderView(e);
  const account = get('SELECT suspended_at, suspended_reason FROM accounts WHERE id=?', e.account_id);
  const told = view.threads.find((x) => x.id === threadId)?.comments.find((x: any) => x.id === commentId)?.news || [];
  return {
    thread_id: threadId, comment_id: commentId, told,
    message: [said, ...(account?.suspended_at && told.some((n: any) => !n.mailed_at && !n.not_emailed) ? [`It is not emailed while sending is paused, and goes out by itself once the pause is lifted. ${pausedText(account)}`] : [])].join(' '),
    ...view,
  };
}

route('POST', '/envelopes/:id/comments/:thread/settle', async (c) => {
  const body = await c.body().catch(() => ({}));
  const e = senderSide(c, true);
  const t = get('SELECT * FROM comment_threads WHERE id=? AND envelope_id=?', c.params.thread, e.id);
  if (!t) throw bad('That conversation is not on this envelope. Load the page again.', 404);
  settle(e, t, body.settled !== false, c.user.name, c.actor, `u:${c.user.id}`);
  return senderView(loadEnvelope(e.id));
});

// "comment.created", for the account's own systems, with what was written: it is the account's own business.
function hook(e: any, cm: any) {
  const t = get('SELECT private, recipient_id, document_id, page, x, y FROM comment_threads WHERE id=?', cm.thread_id);
  fireWebhooks(e.account_id, 'comment.created', e.id, {
    ...(cm.recipient_id ? { recipient_id: cm.recipient_id } : {}),
    comment: { id: cm.id, thread_id: cm.thread_id, private: !!t?.private, with_recipient_id: t?.private ? t.recipient_id : null, by_sender: !!cm.by_sender, name: cm.name, text: cm.body, at: cm.at,
      pin: t?.document_id ? { document_id: t.document_id, page: t.page, x: t.x, y: t.y } : null },
  });
}

// ---- Emails ------------------------------------------------------------------------------------

// Where an answer to one person goes, or why it does not. `audience` is the recipient row and which person on it.
function reach(e: any, audience: string): { name: string; email: string; url: string; code: string | null; rid: string } | string {
  const [rid, party] = audience.split('|');
  const r = e.recipients.find((x: any) => x.id === rid);
  if (!r) return 'They were taken off the document.';
  let who = r;
  if (party.startsWith('m:')) {
    const mid = party.slice(2);
    if (r.claimed_by !== mid) {
      const m = get('SELECT * FROM recipient_members WHERE id=? AND recipient_id=? AND removed_at IS NULL', mid, rid);
      if (!m || !r.group_name) return 'They are no longer one of the people the document is for.';
      if (r.claimed_by) return 'Someone else in their group has the document now.';
      who = { ...r, name: m.name, email: m.email, token: m.token, check_code: m.check_code };
    }
  } else if (partyOf(r) !== party) return 'Someone else has their place on the document now.';
  if (who.role === 'inperson') return R_INPERSON;
  if (!who.email) return R_NO_ADDRESS;
  if (r.complained_at) return R_SPAM;
  if (r.bounced_at) return R_BOUNCED;
  return { name: who.name, email: who.email, url: signUrl(who), code: who.check_code || null, rid };
}
// Why someone is not emailed, as the sender's page says it under an answer. The digest says the same about each
// person who wrote (digestLine), so no screen or email promises an email that never goes.
const R_INPERSON = 'They sign in person on your device, so they are not emailed. They see it on the signing page.';
const R_NO_ADDRESS = 'They have no email address here. They see it when they open their link again.';
const R_SPAM = 'They marked an email about this document as spam, so nothing more is emailed to them about it.';
const R_BOUNCED = 'The last email to their address came back. Correct the address first; they see it on their signing page meanwhile.';
const reachOf = (e: any, r: any) => reach(e, `${r.id}|${partyOf(r)}`);
function digestLine(name: string, why: string): string {
  if (why === R_INPERSON) return `${name} signs in person on your device, so they are not emailed your answer. They see it on the signing page.`;
  if (why === R_NO_ADDRESS) return `${name} has no email address here, so they are not emailed your answer. They see it when they open their link again.`;
  if (why === R_SPAM) return `${name} marked an email about this document as spam, so they are not emailed your answer. They see it on their signing page.`;
  if (why === R_BOUNCED) return `The last email to ${name}'s address came back, so they are not emailed your answer until you correct the address. They see it on their signing page.`;
  return `${name} is not emailed your answer. ${why}`;
}

const said = (p: any, docs: number) => `${p.name}${p.private ? ', privately' : ', for everyone on the document'}${p.document_id ? `, about ${pinWords({ document_id: p.document_id, document: p.document, page: p.page, x: p.x, y: p.y }, docs)}` : ''}:\n${p.body}`;

function senderDigest(e: any, sender: any, pending: any[]): Mail {
  const authors = [...new Map(pending.map((p) => [`${p.recipient_id}|${p.party}`, p])).values()];
  const people = authors.map((a) => e.recipients.find((r: any) => r.id === a.recipient_id) || {});
  const reaches = authors.map((a) => reach(e, `${a.recipient_id}|${a.party}`));
  // A visitor of a public form typed that name and address themselves: they are never the name this email comes
  // from, nor where a reply goes. It comes from us, and the owner answers on the envelope page.
  const visitor = authors.map((_, i) => visitorOf(e, people[i]));
  const one = authors.length === 1 && typeof reaches[0] !== 'string' && !visitor[0] ? authors[0] : null;
  const docs = e.documents.length;
  return {
    to: sender.email, subject: `Questions and comments: ${e.subject}`, heading: `${joinNames(authors.map((a) => a.name))} wrote about "${e.subject}"`,
    lines: [
      ...pending.map((p) => said(p, docs)),
      reaches.every((x) => typeof x !== 'string') ? 'Answer on the envelope page. They see your answer on their signing page, and we email it to them.' : 'Answer on the envelope page. They see your answer on their signing page.',
      ...authors.flatMap((a, i) => (typeof reaches[i] === 'string' ? [digestLine(a.name, reaches[i] as string)] : [])),
      ...authors.flatMap((a, i) => (visitor[i] ? [`${a.name} came through your public form and typed that name${a.email ? ' and address' : ''} themselves. We have not checked ${a.email ? 'them' : 'it'}, so this email does not come from them and has no reply address.`] : [])),
      ...(one ? [`Replying to this email writes to ${one.name} (${one.email}) directly, and that reply is not kept with the document.`] : []),
      COMMENTS_NOT_SIGNED,
      `We send at most one email like this every ${COMMENT_MAIL_MINUTES} minutes for each document. Anything written after it comes in the next one.`,
    ],
    cta: { label: 'Answer on the envelope page', url: `${baseUrl()}/app/envelopes/${e.id}#comments` },
    envelopeId: e.id, brand: brandOf(e.account_id), ...(one ? { replyTo: one.email, fromName: one.name } : {}),
  };
}

function answerMail(e: any, sender: any, to: { name: string; email: string; url: string; code: string | null; rid: string }, pending: any[]): Mail {
  const shared = e.recipients.some((x: any) => x.id !== to.rid && String(x.email || '').toLowerCase() === to.email.toLowerCase());
  // Named as written: an admin who answered is the one named, for the sender, never the sender alone.
  const writers = [...new Set(pending.map((p) => String(p.name)))];
  const forSender = writers.some((w) => w !== sender.name) ? `, for ${sender.name},` : '';
  return {
    to: to.email, subject: `${joinNames(writers)} wrote to you about: ${e.subject}`, heading: `${shared ? `For ${to.name}: ` : ''}${joinNames(writers)}${forSender} wrote to you about "${e.subject}"`,
    lines: [
      ...pending.map((p) => said(p, e.documents.length)),
      'Open the document to read the whole conversation and to answer there. Reading or writing comments signs nothing.',
      COMMENTS_NOT_SIGNED,
      `Sent ${forSender ? 'for' : 'by'} ${sender.name} (${sender.email}). Reply to this email to reach them directly.`,
    ],
    cta: { label: 'Open the document', url: to.url }, envelopeId: e.id, recipientId: to.rid, ...(to.code ? { code: to.code } : {}),
    brand: brandOf(e.account_id), replyTo: sender.email, fromName: sender.name,
  };
}

// Sends what is due: for each envelope and person, everything new in one email, unless one went to them about this
// envelope less than COMMENT_MAIL_MINUTES ago. The rest waits for the next comment or the timer. Each step from the
// check to marking the rows as sent runs without waiting, so two calls at the same moment never send one twice.
export async function flushComments(envelopeId?: string): Promise<{ mailed: number; held: number; dropped: number }> {
  const due = all(`SELECT DISTINCT envelope_id, audience FROM comment_news WHERE mailed_at IS NULL AND dropped IS NULL${envelopeId ? ' AND envelope_id=?' : ''}`, ...(envelopeId ? [envelopeId] : []));
  let mailed = 0, held = 0, dropped = 0;
  for (const { envelope_id, audience } of due) {
    const last = get('SELECT MAX(mailed_at) m FROM comment_news WHERE envelope_id=? AND audience=?', envelope_id, audience)?.m;
    if (last && Date.now() - Date.parse(last) < COMMENT_MAIL_MINUTES * 60_000) continue;
    const e = loadEnvelope(envelope_id);
    if (!e) continue;
    const pending = all(`SELECT n.id nid, c.*, t.private, t.document_id, t.page, t.x, t.y, d.name document FROM comment_news n JOIN comments c ON c.id=n.comment_id
      JOIN comment_threads t ON t.id=c.thread_id LEFT JOIN documents d ON d.id=t.document_id AND d.envelope_id=t.envelope_id
      WHERE n.envelope_id=? AND n.audience=? AND n.mailed_at IS NULL AND n.dropped IS NULL ORDER BY n.id`, envelope_id, audience);
    if (!pending.length) continue;
    const mark = (col: 'mailed_at' | 'dropped', v: string) => { for (const p of pending) run(`UPDATE comment_news SET ${col}=? WHERE id=?`, v, p.nid); };
    const sender = senderOf(e);
    if (!sender?.email) { mark('dropped', 'The sender has no login any more.'); continue; }
    if (audience === 'sender') {
      mark('mailed_at', now());
      await sendMail(senderDigest(e, sender, pending));
      mailed++;
      continue;
    }
    if (e.status !== 'sent' && e.status !== 'completed') { mark('dropped', 'The document was closed before it went out.'); continue; }
    const to = reach(e, audience);
    if (typeof to === 'string') { mark('dropped', to); continue; }
    const no = batchRefusal(e, audience, pending);
    // Held while the account is paused: it goes by itself once the pause is lifted, the next time a comment is written
    // or the timer runs.
    if (no?.status === 403) { held++; continue; }
    // Read like a fake payment notice with what they were sent today: dropped, never held for ever, and never in the
    // way of what is written after it. The sender is told on the envelope page and by email.
    if (no) {
      mark('dropped', FILTERED);
      dropped++;
      await sendMail(filteredMail(e, sender, to.name, pending, no.message));
      continue;
    }
    mark('mailed_at', now());
    await sendMail(answerMail(e, sender, to, pending));
    mailed++;
  }
  return { mailed, held, dropped };
}

function filteredMail(e: any, sender: any, name: string, pending: any[], why: string): Mail {
  return {
    to: sender.email, subject: `Not emailed to ${name}: comments on ${e.subject}`, heading: `What was written to ${name} was not emailed`,
    lines: [
      `These comments on "${e.subject}" were not emailed to ${name}:`,
      ...pending.map((p) => said(p, e.documents.length)),
      `Together with what ${name} was already emailed about this document today: ${why}`,
      `Comments with words like these are not emailed. ${name} still sees them on their signing page. Later answers are emailed as usual.`,
    ],
    cta: { label: 'Open the envelope page', url: `${baseUrl()}/app/envelopes/${e.id}#comments` }, envelopeId: e.id, brand: brandOf(e.account_id),
  };
}
