import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, now, isEmail, str, rateLimit, baseUrl, shortCode, codeFrom, sha256, hmac, safeEqual, parseCode, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { loadEnvelope, helpAsked, canBeStuck } from './envelopes.ts';
import { sameEmail } from './credits.ts';
import { isOperator } from './routes-trust.ts';
import { supportFirstReplyHours, supportUrgentReplyHours, supportReachable, SUPPORT_TOPICS, SUPPORT_URGENT_TOPICS, SUPPORT_REOPEN_DAYS, SUPPORT_MEDIAN_DAYS, SUPPORT_MEDIAN_MIN, SUPPORT_REPLIES_PER_REQUEST, SUPPORT_REPLIES_PER_ADDRESS } from '../lib/policy.ts';
import { TOPIC_LABEL, firstName, whenText, knownZone } from '../lib/support.ts';

// Help requests as tickets. Every request has a reference, a state the customer can see (open: waiting for us,
// waiting: we asked them something, answered, closed), an owner, a time by which a person will have answered, and a
// thread. The first message is on the request itself (support_requests.message); everything after it, and a line for
// everything that was done, is in support_messages.
//
// These routes are for people. No API key may use them: the operator routes are refused for every key by the
// router (PERSON_ONLY), and the ones for a signed-in customer are refused here (person()).

// ---- Who answers -----------------------------------------------------------------------------------

const operatorEmails = (): string[] => [...new Set((process.env.OPERATOR_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(isEmail))];
const supportEmail = (): string | null => (isEmail((process.env.SUPPORT_EMAIL || '').trim()) ? process.env.SUPPORT_EMAIL!.trim() : null);
// The people who can work the queue: a confirmed login under an address in OPERATOR_EMAILS.
const operators = (): any[] => {
  const list = operatorEmails();
  return list.length ? all(`SELECT id, name, email, tz FROM users WHERE email_verified=1 AND email IN (${list.map(() => '?').join(',')}) ORDER BY name`, ...list) : [];
};
// Where a new request is announced: the support address, or the operators when there is none, so a response time is
// never promised with nobody told.
const desk = (): string[] => (supportEmail() ? [supportEmail()!] : operatorEmails());
// Everyone who answers, for a request that is late.
const everyone = (): string[] => [...new Set([(supportEmail() || '').toLowerCase(), ...operatorEmails()].filter(Boolean))];
const operator = (c: Ctx) => {
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
};
const person = (c: Ctx) => {
  if (c.auth?.via === 'api_key') throw new HttpError(403, 'An API key cannot read or answer help requests. That needs a person signed in to the app.');
};

// ---- What a request is -----------------------------------------------------------------------------

const ALERT_NAME = 'Sign&Grow (automatic alert)';
// A payment problem the software filed by itself (tellOperators in routes-billing.ts). Nobody wrote it and nobody is
// waiting for an email, so it has no response time and is never answered by email: an operator notes what was done
// and closes it. The form gives every request a reference and an alert has none, so typing this name into the form
// does not turn a request into one.
const isAlert = (t: any) => !t.ref && !t.user_id && t.name === ALERT_NAME;
// A request from before references were kept has the one it was answered with then. An alert is filed without a
// reference (that is also how it is told from a request), so its reference is worked out from its id in the same
// alphabet nobody can misread: the queue and "handed to you" emails never show a 0 next to an O, and it is the
// same every time for the same alert.
const refOf = (t: any): string => t.ref || (isAlert(t) ? codeFrom(`alert:${t.id}`) : t.id.slice(-8).toUpperCase());
const priorityOf = (t: any): 'urgent' | 'normal' => (t.priority === 'urgent' || t.priority === 'normal' ? t.priority : !isAlert(t) && SUPPORT_URGENT_TOPICS.includes(t.topic) ? 'urgent' : 'normal');
const hoursFor = (priority: string) => (priority === 'urgent' ? supportUrgentReplyHours() : supportFirstReplyHours());
// The moment by which a person will have answered a message written now. Real hours. With nobody to reach, no time
// is promised: a promise nobody can keep is worse than none.
const dueFrom = (priority: string): string | null => (supportReachable() ? new Date(Date.now() + hoursFor(priority) * 3600_000).toISOString() : null);
const isLate = (t: any) => t.status === 'open' && !!t.due_at && t.due_at < now();
// The operator who has the request. Someone who is no longer an operator has it no more: it shows as nobody's.
const ownerOf = (t: any): any => (t.owner_id ? operators().find((o) => o.id === t.owner_id) || null : null);
const who = (t: any) => `${t.name || 'Someone'} <${t.email}>`; // always with the address in this form, so deleting an account finds our copies
const load = (rid: string): any => get('SELECT * FROM support_requests WHERE id=?', str(rid, 60));

type By = { id?: string | null; name: string };
const say = (t: any, kind: 'customer' | 'answer' | 'question' | 'note' | 'event', body: string, by: By) =>
  run('INSERT INTO support_messages (request_id, kind, by_id, by_name, body, at) VALUES (?,?,?,?,?,?)', t.id, kind, by.id ?? null, by.name, body, now());

// The private link to a request: its secret is made from the server's own secret, so every email about a request
// can carry the same link, and the database only ever holds a fingerprint of it. Whoever has the link has the
// mailbox it was sent to. That is the proof, so the link is only ever put in an email, never on a screen.
function linkFor(t: any): string {
  const key = hmac(`support-link:${t.id}`).slice(0, 40);
  const print = sha256(key);
  if (t.secret_hash !== print) run('UPDATE support_requests SET secret_hash=? WHERE id=?', print, t.id);
  return `${baseUrl()}/help/request/${t.id}/${key}`;
}
const NO_LINK = 'This link does not open a request. It may have been cut short on the way: open it again from our latest email about your request. If that does not help, write to us on the help page and give your reference.';
function byLink(c: Ctx): any {
  rateLimit(`ticket:${c.ip}`, 120, 3600_000);
  const t = load(c.params.id);
  // One answer for a request that does not exist and for a wrong secret, so a link tells nobody which requests exist.
  if (!t?.secret_hash || isAlert(t) || !safeEqual(t.secret_hash, sha256(str(c.params.key, 200)))) throw bad(NO_LINK, 404);
  return t;
}

const NO_REPLY = 'Please do not reply to this email: a reply does not reach your request.';
// An email about a help request often goes to someone who only came to sign, and the pages promise those people no
// marketing. mail.ts leaves the line that sells out of an email that carries a list of links, and an empty list is
// one, so every email to the customer about a request ends with where it came from and nothing more.
const PLAIN: { links: { label: string; url: string }[] } = { links: [] };
const tzOf = (email: string): string | null => get('SELECT tz FROM users WHERE email=?', email)?.tz || null;
const customerZone = (t: any): string | null => t.tz || tzOf(t.email);

// ---- What each side is shown -----------------------------------------------------------------------

// The customer's view. Nothing but the request itself: no address, no account, no internal note, no record of who
// did what, and of the people who answer only a first name. `mine` is true for the signed-in person who wrote it.
// Anyone can type any address into the form. So the words of a first message that came from nobody we know are
// not shown back until a person on our side has read it and written back: until then the link in the
// acknowledgement would put a stranger's words on our page under our name.
function forCustomer(t: any, mine = false) {
  const rows = all("SELECT kind, by_name, body, at FROM support_messages WHERE request_id=? AND kind IN ('customer','answer','question') ORDER BY id", t.id);
  const held = !(mine || t.verified || rows.some((m) => m.kind !== 'customer'));
  const owner = ownerOf(t);
  const late = isLate(t);
  const old = t.follows ? load(t.follows) : null;
  return {
    reference: refOf(t), topic: t.topic, status: t.status, priority: priorityOf(t), at: t.at, updated_at: t.updated_at || t.at,
    owner: owner ? firstName(owner.name) : null,
    due_at: t.status === 'open' ? t.due_at || null : null, late, passed_on: late && t.escalated_for === t.due_at,
    closed_at: t.status === 'closed' ? t.closed_at || null : null, closed_how: t.status === 'closed' ? t.closed_how || 'answered' : null,
    reopen_until: t.status === 'closed' && t.closed_at ? new Date(Date.parse(t.closed_at) + SUPPORT_REOPEN_DAYS * 864e5).toISOString() : null,
    follows: old ? refOf(old) : null,
    held,
    thread: [{ from: 'you', kind: 'message', name: null, at: t.at, body: held ? '' : t.message },
      ...rows.map((m) => ({ from: m.kind === 'customer' ? 'you' : 'us', kind: m.kind === 'question' ? 'question' : 'message', name: m.kind === 'customer' ? null : firstName(m.by_name) || null, at: m.at, body: m.body }))],
  };
}

// The account a request is about, read-only, for the operator: the one it was written from, or else the one owned
// by the confirmed login under its address. Plan, paused or not, and the last payment.
function accountFacts(t: any) {
  const login = get('SELECT id, name, email_verified, closing_at, created_at FROM users WHERE email=?', t.email);
  const viaAddress = login?.email_verified ? get("SELECT account_id FROM memberships WHERE user_id=? AND role='owner' LIMIT 1", login.id)?.account_id : null;
  const a = t.account_id || viaAddress ? get('SELECT id, name, plan, created_at, trusted_at, suspended_at, suspended_reason, subscription_status, renews_at, cancel_at, promo_code, dispute_at, closing_at FROM accounts WHERE id=?', t.account_id || viaAddress) : null;
  const pay = a ? get('SELECT amount_cents, currency, at, kind, refunded_cents FROM payments WHERE account_id=? ORDER BY at DESC LIMIT 1', a.id) : null;
  return {
    login: login ? { name: login.name, confirmed: !!login.email_verified, closing_at: login.closing_at || null, created_at: login.created_at } : null,
    account: a ? { ...a, via: t.account_id ? 'written_from' : 'address', free_with: a.promo_code || null, promo_code: undefined, last_payment: pay || null } : null,
  };
}

function forOperator(t: any, full = false) {
  const owner = ownerOf(t);
  const old = t.follows ? load(t.follows) : null;
  const base = {
    id: t.id, reference: refOf(t), alert: isAlert(t), email: t.email, name: t.name, topic: t.topic, message: t.message, envelope_id: t.envelope_id,
    status: t.status, priority: priorityOf(t), at: t.at, updated_at: t.updated_at || t.at, due_at: t.status === 'open' ? t.due_at || null : null, late: isLate(t),
    owner: owner ? { id: owner.id, name: owner.name } : null, first_reply_at: t.first_reply_at || null, closed_at: t.closed_at || null, closed_how: t.closed_how || null,
    forget: !!t.forget, follows: old ? { id: old.id, reference: refOf(old) } : null,
    // Whether the writer is known: signed in under their own confirmed address, signed in but writing for another
    // or an unconfirmed address, or not signed in at all (anyone can type any address).
    written: t.verified ? 'own' : t.user_id ? 'signed_in_other' : 'not_signed_in',
  };
  if (!full) return { ...base, replies: get("SELECT COUNT(*) n FROM support_messages WHERE request_id=? AND kind!='event'", t.id).n };
  return {
    ...base, ...accountFacts(t),
    // Everything, oldest first: messages both ways, internal notes, and what was done with who and when. A message
    // from the customer with nobody's login behind it came through the private link, so from their mailbox.
    thread: [{ kind: 'customer', at: t.at, by: t.name || null, via: t.user_id ? 'app' : 'form', body: t.message },
      ...all('SELECT kind, by_id, by_name, body, at FROM support_messages WHERE request_id=? ORDER BY id', t.id).map((m) => ({ kind: m.kind, at: m.at, by: m.by_name, via: m.kind === 'customer' ? (m.by_id ? 'app' : 'link') : undefined, body: m.body }))],
  };
}

// ---- Honest numbers --------------------------------------------------------------------------------

// The real median time to a first answer from a person, over the requests first answered in the last 30 days, and
// how many requests that is. Null when there are too few to say anything: the page then shows the target only.
function replyStats() {
  const rows = all('SELECT at, first_reply_at f FROM support_requests WHERE first_reply_at IS NOT NULL AND first_reply_at >= ?', new Date(Date.now() - SUPPORT_MEDIAN_DAYS * 864e5).toISOString());
  if (rows.length < SUPPORT_MEDIAN_MIN) return null;
  const mins = rows.map((r) => Math.max(0, (Date.parse(r.f) - Date.parse(r.at)) / 60_000)).sort((a, b) => a - b);
  const mid = mins.length >> 1;
  return { minutes: Math.round(mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2), count: rows.length, days: SUPPORT_MEDIAN_DAYS,
    late_now: get("SELECT COUNT(*) n FROM support_requests WHERE status='open' AND due_at IS NOT NULL AND due_at < ?", now()).n };
}

route('GET', '/public/support', () => ({
  email: process.env.SUPPORT_EMAIL || null, topics: SUPPORT_TOPICS, urgent_topics: SUPPORT_URGENT_TOPICS,
  // The published response times, or null when nobody can be reached and so none is promised.
  reply: supportReachable() ? { hours: supportFirstReplyHours(), urgent_hours: supportUrgentReplyHours() } : null,
  median: supportReachable() ? replyStats() : null,
}), 'public');

// ---- A new request ---------------------------------------------------------------------------------

// How many messages an address has sent us in the last 24 hours, new requests and replies together. Counted in the
// database, so a restart does not reset it and it holds whichever device the messages come from.
const fromAddress = (email: string) => {
  const since = new Date(Date.now() - 864e5).toISOString();
  return get('SELECT COUNT(*) n FROM support_requests WHERE lower(email)=lower(?) AND at > ?', email, since).n
    + get("SELECT COUNT(*) n FROM support_messages m JOIN support_requests s ON s.id=m.request_id WHERE lower(s.email)=lower(?) AND m.kind='customer' AND m.at > ?", email, since).n;
};
const TOO_MANY = 'We already have a lot of messages from this address in the last 24 hours, and a person reads every one of them. To keep the queue usable for everyone, more can be added tomorrow.';

function openRequest(r: { email: string; name: string | null; topic: string; message: string; envelope_id?: string | null; user_id?: string | null; account_id?: string | null; verified: boolean; tz?: string | null; follows?: string | null }): any {
  const sid = id('sup');
  // The reference is read out on the phone and typed into emails, so it is made of characters nobody can misread,
  // and it is kept with the request, so the queue, the emails and "Your requests" show the very same one.
  const priority = SUPPORT_URGENT_TOPICS.includes(r.topic) ? 'urgent' : 'normal';
  run('INSERT INTO support_requests (id, ref, email, name, topic, message, envelope_id, user_id, account_id, at, updated_at, priority, due_at, verified, tz, follows) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    sid, shortCode(), r.email, r.name, r.topic, r.message, r.envelope_id ?? null, r.user_id ?? null, r.account_id ?? null, now(), now(), priority, dueFrom(priority), r.verified, r.tz ?? null, r.follows ?? null);
  return load(sid);
}

// Tells the people who answer. The customer is named as "Name <address>" so that deleting an account finds this copy.
async function announce(t: any, extra: string[] = []) {
  const account = t.account_id ? get('SELECT name, plan FROM accounts WHERE id=?', t.account_id) : null;
  for (const to of desk())
    await sendMail({ to, subject: `[${t.topic}] ${refOf(t)}: ${t.message.slice(0, 60)}`, heading: `Help request ${refOf(t)}`,
      lines: [`From ${who(t)}${account ? `, account ${account.name} (${account.plan})` : ', not logged in'}.`, ...(t.envelope_id ? [`About envelope ${t.envelope_id}.`] : []), ...extra,
        t.due_at ? `${priorityOf(t) === 'urgent' ? 'Urgent. ' : ''}The customer was told a person will have answered by ${whenText(t.due_at, tzOf(to))}.` : 'No response time was promised for this one.',
        t.message, 'Answer it from the queue, not by replying to this email: only an answer written there reaches the request, is emailed to the customer and stops the clock.'],
      cta: { label: 'Open the request', url: `${baseUrl()}/app/operator?ticket=${t.id}` } });
}

// Anyone can type any address into the form. So the acknowledgement only repeats the message to an address we know
// belongs to the writer: someone signed in, writing from their own confirmed address. Everyone else gets the
// reference and nothing a stranger wrote, or the form would send any text to any inbox under our name.
async function acknowledge(t: any, extra: string[] = []) {
  const hours = hoursFor(priorityOf(t));
  await sendMail({ to: t.email, subject: `We got your message (${refOf(t)})`, heading: 'A person will reply to you',
    lines: [`Your reference is ${refOf(t)}.`, ...extra,
      ...(t.due_at ? [`A person will have answered by ${whenText(t.due_at, customerZone(t))}. That is within ${hours} hour${hours === 1 ? '' : 's'} of your message, counted in real hours: nights and weekends count too. If we are ever late, the request says so and the whole team is told.`] : []),
      ...(t.verified ? ['What you sent us:', t.message] : ['If you did not write to us, someone typed your address into our help form by mistake. You can ignore this email.']),
      `${NO_REPLY} To add something, to read our answer or to see where things stand, use the button below. It opens your request without signing in, so do not forward this email.`],
    cta: { label: 'Open my request', url: linkFor(t) }, ...PLAIN });
}

// ---- Which document a message is about -------------------------------------------------------------

// The help link on the signing page and in every email about a document carries the security code of that
// recipient's emails, the one people type into /check. It never carries the signing link's own secret, which would
// end up in logs and browser histories as part of the help page's address. The code names one person on one
// envelope, and whoever has it was sent that email, which is more than typing an address shows. A code whose link
// has been replaced since (the sender corrected the address, or the document was passed on) still says which
// envelope is meant and no more: `r` is empty then, and the address typed has to be on the envelope as before.
function aboutCode(typed: any): { e: any; r: any | null } | null {
  const code = parseCode(typed);
  if (code.length !== 12) return null;
  const live = get('SELECT id, envelope_id FROM recipients WHERE check_code=? AND token IS NOT NULL', code);
  const old = live ? null : get('SELECT envelope_id FROM retired_tokens WHERE check_code=? AND envelope_id IS NOT NULL ORDER BY retired_at DESC LIMIT 1', code);
  const e = live || old ? loadEnvelope((live || old).envelope_id) : null;
  if (!e || e.kind !== 'envelope') return null;
  return { e, r: live ? e.recipients.find((x: any) => x.id === live.id) || null : null };
}

// What the form shows the writer before they send: which document their message will be about, who sent it, and
// whether its sender is told that they need help (tells_sender). It says no more than /check says to the same
// code, and nothing at all for a code we do not know or one whose link has been replaced.
route('POST', '/public/support/about', async (c) => {
  rateLimit(`about:${c.ip}`, 40, 3600_000);
  const hit = aboutCode((await c.body()).code);
  // replaced: the code of an email we sent whose link was replaced since. /check says that much to the same code.
  if (!hit?.r) return { known: false, ...(hit ? { replaced: true } : {}) };
  return { known: true, subject: hit.e.subject, sender: get('SELECT name FROM users WHERE id=?', hit.e.sender_id)?.name || null, for_name: hit.r.name, tells_sender: canBeStuck(hit.e, hit.r) };
}, 'public');

// Open to everyone: signers, free users, former customers, and people who cannot log in.
route('POST', '/public/support', async (c) => {
  rateLimit(`support:${c.ip}`, 8, 3600_000);
  const b = await c.body();
  const email = str(b.email || c.user?.email, 254).trim();
  const message = str(b.message, 5000).trim();
  if (!isEmail(email)) throw bad('Enter an email address we can reply to.');
  if (message.length < 10) throw bad('Tell us a little more so we can help on the first reply.');
  // Every request sends an email to the address typed. The limit per address keeps the form from filling a
  // stranger's inbox, whichever device the requests come from.
  if (fromAddress(email) >= SUPPORT_REPLIES_PER_ADDRESS) throw bad(TOO_MANY, 429);
  const topic = SUPPORT_TOPICS.includes(b.topic) ? b.topic : 'other';
  const known = !!c.user?.email_verified && sameEmail(email, c.user.email);
  // Which document it is about: the security code the help link of a signing page or a signing email carries, or
  // else an envelope id. The request keeps the envelope's id either way, so the people who answer see it.
  const coded = aboutCode(b.code);
  const t = openRequest({ email, name: str(b.name || c.user?.name, 120) || null, topic, message, envelope_id: coded?.e.id || str(b.envelope_id, 60) || null, user_id: c.user?.id ?? null, account_id: c.account?.id ?? null, verified: known, tz: knownZone(b.tz) || (known ? c.user.tz : null) });
  await announce(t);
  await acknowledge(t);
  // A problem with signing that names a document the writer is a recipient of also goes to its sender, who can
  // usually fix it at once. The writer is on it when they hold the security code of the email we sent that
  // recipient, or when the address they typed is on the envelope they named. The answer is the same whether or not
  // anything matched, so the form cannot be used to find out who is on a document. The writer's words are passed on
  // only from someone signed in under their own confirmed address, as before: the form says so before sending.
  const about = topic !== 'signing' ? null : coded ? coded.e : b.envelope_id ? loadEnvelope(str(b.envelope_id, 60)) : null;
  const signer = coded?.r || about?.recipients.find((r: any) => r.email && sameEmail(r.email, email));
  if (about && signer) await helpAsked(about, signer, known ? message : null, { name: 'Sign&Grow help form', ip: c.ip, ua: c.ua }, !!coded?.r && !sameEmail(signer.email, email));
  // The private link is not in this answer. It goes to the mailbox only, because having it is what proves the
  // mailbox is yours.
  return { reference: refOf(t), priority: t.priority, due_at: t.due_at, reply_hours: t.due_at ? hoursFor(t.priority) : null };
}, 'public');

// ---- The customer writes again, or says it is solved -----------------------------------------------

// A reply reopens a request that was answered or closed, and restarts the clock. A request closed longer ago than
// SUPPORT_REOPEN_DAYS stays closed: the reply starts a new one that names it. `userId` is the signed-in writer, or
// null for the private link.
async function customerReply(t: any, text: any, userId: string | null) {
  const message = str(text, 5000).trim();
  if (message.length < 2) throw bad('Write your message first.');
  // The link, and a signed-in session, could otherwise be used to bury the people who answer.
  const today = get("SELECT COUNT(*) n FROM support_messages WHERE request_id=? AND kind='customer' AND at > ?", t.id, new Date(Date.now() - 864e5).toISOString()).n;
  if (today >= SUPPORT_REPLIES_PER_REQUEST) throw bad(`You have added ${SUPPORT_REPLIES_PER_REQUEST} messages to this request in the last 24 hours, and we have them all. A person reads everything you sent. You can add more tomorrow.`, 429);
  if (fromAddress(t.email) >= SUPPORT_REPLIES_PER_ADDRESS) throw bad(TOO_MANY, 429);
  const by: By = { id: userId, name: t.name || 'The customer' };

  if (t.status === 'closed' && t.closed_at && Date.parse(t.closed_at) + SUPPORT_REOPEN_DAYS * 864e5 < Date.now()) {
    // Whoever writes here holds the link from the mailbox or is signed in under the confirmed address, so the new
    // request is known to be theirs.
    const fresh = openRequest({ email: t.email, name: t.name, topic: t.topic, message, envelope_id: t.envelope_id, user_id: userId, account_id: userId ? t.account_id : null, verified: true, tz: t.tz, follows: t.id });
    say(fresh, 'event', `Opened as a follow-up to request ${refOf(t)}, which was closed more than ${SUPPORT_REOPEN_DAYS} days before`, by);
    say(t, 'event', `The customer wrote again after ${SUPPORT_REOPEN_DAYS} days. That opened request ${refOf(fresh)}`, by);
    await announce(fresh, [`This continues request ${refOf(t)}, which was closed on ${t.closed_at.slice(0, 10)}.`]);
    await acknowledge(fresh, [`Your earlier request ${refOf(t)} was closed more than ${SUPPORT_REOPEN_DAYS} days ago, so this is a new one. It is linked to the old one, and the person who answers sees both.`]);
    return { fresh, moved: true };
  }

  const was = t.status;
  const due = was === 'open' ? t.due_at : dueFrom(priorityOf(t));
  tx(() => {
    say(t, 'customer', message, by);
    // Adding to a request we have not answered yet does not move the time we promised, in either direction.
    if (was !== 'open') say(t, 'event', was === 'waiting' ? 'The customer answered our question. The clock runs again' : `The customer wrote back, so the request is open again (it was ${was})`, by);
    run("UPDATE support_requests SET status='open', due_at=?, closed_at=NULL, closed_how=NULL, updated_at=? WHERE id=?", due, now(), t.id);
  });
  const fresh = load(t.id);
  // The request is back in the queue. One email says so, to whoever has it or else to the desk. Further messages
  // while it is still waiting for us send nothing more: it is already on the list.
  if (was !== 'open') {
    const owner = ownerOf(fresh);
    for (const to of owner ? [owner.email] : desk())
      await sendMail({ to, subject: `[reply] ${refOf(t)}: ${message.slice(0, 60)}`, heading: `${t.name || 'The customer'} replied on request ${refOf(t)}`,
        lines: [`From ${who(t)}.`, message, due ? `They were told a person will have answered by ${whenText(due, tzOf(to))}.` : 'No response time was promised for this one.', 'Answer it from the queue, not by replying to this email.'],
        cta: { label: 'Open the request', url: `${baseUrl()}/app/operator?ticket=${t.id}` } });
  }
  return { fresh, moved: false };
}

// A request whose writer deleted their account since was only kept so that it could be answered. Once it is, the
// request goes with its whole thread (the database removes the messages with it), and so do our copies of the
// emails about it that the mail server has already taken.
function forgetNow(t: any) {
  run('DELETE FROM support_requests WHERE id=?', t.id);
  run("DELETE FROM emails WHERE envelope_id IS NULL AND status='sent' AND instr(subject, ?) > 0 AND (lower(to_email)=lower(?) OR instr(lower(html), '&lt;' || lower(?) || '&gt;') > 0)", refOf(t), t.email, t.email);
}

// The customer says it is done, or that they never wrote it. Nobody on our side closes a request without a written
// answer, and the customer never needs one.
function customerCloses(t: any, notMine: boolean, userId: string | null) {
  if (t.status === 'closed') return;
  const by: By = { id: userId, name: t.name || 'The customer' };
  if (t.forget) return forgetNow(t);
  tx(() => {
    say(t, 'event', notMine ? 'The person at this address said they did not write this. Closed, and nothing more is sent to them' : 'The customer marked it as solved', by);
    run("UPDATE support_requests SET status='closed', closed_at=?, closed_how=?, due_at=NULL, updated_at=? WHERE id=?", now(), notMine ? 'disowned' : 'solved', now(), t.id);
  });
}

// The private link from our emails. It works without a login, because the people who need help most are locked out.
// "I lost the email with the link." The links to an address's requests are sent again, to that address only. The
// answer is the same whether or not there are any, so the form tells nobody who has written to us. The link of a
// request never changes, so nothing an earlier email carries stops working.
route('POST', '/public/support/find', async (c) => {
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter the email address you wrote to us from.');
  rateLimit(`support-find:${c.ip}`, 6, 3600_000);
  rateLimit(`support-find:${email}`, 3, 864e5);
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const found = all('SELECT * FROM support_requests WHERE lower(email)=? AND at > ? ORDER BY at DESC LIMIT 20', email, since).filter((t) => !isAlert(t));
  if (found.length)
    await sendMail({ to: email, subject: `Your requests to Sign&Grow: ${found.length === 1 ? 'the link' : 'the links'} again`, heading: found.length === 1 ? 'Here is the link to your request' : 'Here are the links to your requests',
      lines: ['Someone, we hope you, asked on our help page for the links to the requests written from this address. Each link opens one request without signing in: there you read everything written so far and reply.',
        'If you did not ask for this, you can ignore it: nothing was changed, and only this inbox received the links.', NO_REPLY],
      links: found.map((t) => ({ label: `Request ${refOf(t)}`, url: linkFor(t), note: `${TOPIC_LABEL[t.topic] || 'Help request'}, written ${t.at.slice(0, 10)}, ${t.status === 'open' ? 'waiting for our answer' : t.status === 'waiting' ? 'waiting for your answer' : t.status}` })) });
  return { ok: true };
}, 'public');

route('GET', '/public/support/ticket/:id/:key', (c) => ({ request: forCustomer(byLink(c)) }), 'public');
route('POST', '/public/support/ticket/:id/:key/reply', async (c) => {
  const t = byLink(c);
  rateLimit(`ticket-reply:${c.ip}`, 30, 3600_000);
  const r = await customerReply(t, (await c.body()).message, null);
  // A follow-up request has a link of its own. The caller holds the old one, so the same mailbox, and may have it.
  return r.moved ? { moved: true, reference: refOf(r.fresh), url: linkFor(r.fresh).slice(baseUrl().length) } : { request: forCustomer(r.fresh) };
}, 'public');
route('POST', '/public/support/ticket/:id/:key/solved', async (c) => {
  const t = byLink(c);
  rateLimit(`ticket-reply:${c.ip}`, 30, 3600_000);
  customerCloses(t, !!(await c.body().catch(() => ({}))).not_mine, null);
  const after = load(t.id);
  return after ? { request: forCustomer(after) } : { deleted: true };
}, 'public');

// What you asked and where it stands, for people who are logged in. Requests filed while signed in as this user,
// and requests filed from this user's address once the address is confirmed. Signing up with somebody else's
// address proves nothing, so an unconfirmed address never matches.
// The answers are written to the address on the request. So the thread, and replying, are only for someone whose
// own confirmed address that is. A request this person filed under another address is listed with what they
// wrote and where it stands, and nothing of what was answered to that mailbox.
const theirs = (c: Ctx, t: any) => !!c.user.email_verified && sameEmail(t.email, c.user.email);
route('GET', '/support/mine', (c) => {
  person(c);
  // An alert the software filed is under the address of whoever answers. It is theirs to work on, not their request.
  const rows = all(`SELECT * FROM support_requests WHERE (user_id=?${c.user.email_verified ? ' OR lower(email)=lower(?)' : ''}) AND NOT (ref IS NULL AND user_id IS NULL AND COALESCE(name, '')=?) ORDER BY COALESCE(updated_at, at) DESC LIMIT 30`,
    ...(c.user.email_verified ? [c.user.id, c.user.email] : [c.user.id]), ALERT_NAME);
  return { requests: rows.map((t) => {
    const v = forCustomer(t, t.user_id === c.user.id); // what they wrote themselves is always shown back to them
    const full = theirs(c, t);
    return { id: t.id, ...v, message: v.held ? '' : t.message, can_reply: full, thread: full ? v.thread : null };
  }) };
});
function mine(c: Ctx): any {
  person(c);
  const t = load(c.params.id);
  // The same answer for a request that does not exist and for somebody else's.
  if (!t || isAlert(t) || !theirs(c, t)) throw bad('We cannot find that request under your address. Requests are shown here for an email address you have confirmed.', 404);
  return t;
}
route('POST', '/support/mine/:id/reply', async (c) => {
  const t = mine(c);
  rateLimit(`ticket-reply:${c.user.id}`, 30, 3600_000);
  const r = await customerReply(t, (await c.body()).message, c.user.id);
  return r.moved ? { moved: true, reference: refOf(r.fresh) } : { ok: true };
});
route('POST', '/support/mine/:id/solved', async (c) => {
  const t = mine(c);
  customerCloses(t, !!(await c.body().catch(() => ({}))).not_mine, c.user.id);
  return { ok: true };
});

// ---- The people who answer -------------------------------------------------------------------------

// The queue. Requests waiting for us come first, by the time a person should have answered: the late ones are
// the oldest of those, so they lead. Then the ones no time was promised for, oldest first, then everything else by
// what happened last.
const ORDER = `CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 WHEN 'answered' THEN 2 ELSE 3 END,
  CASE WHEN status='open' AND due_at IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN status='open' THEN due_at END, CASE WHEN status='open' THEN at END, COALESCE(updated_at, at) DESC`;
route('GET', '/operator/support', (c) => {
  operator(c);
  const ops = operators();
  const ids = ops.map((o) => o.id);
  const nobodys = `(owner_id IS NULL${ids.length ? ` OR owner_id NOT IN (${ids.map(() => '?').join(',')})` : ''})`;
  const FILTERS: Record<string, [string, any[]]> = {
    open: ["status='open'", []],
    mine: ["owner_id=? AND status IN ('open','waiting')", [c.user.id]],
    unowned: [`status='open' AND ${nobodys}`, ids],
    waiting: ["status='waiting'", []],
    all: ['1=1', []],
  };
  const filter = FILTERS[c.q.get('filter') || ''] ? c.q.get('filter')! : 'open';
  const count = (f: string) => get(`SELECT COUNT(*) n FROM support_requests WHERE ${FILTERS[f][0]}`, ...FILTERS[f][1]).n;
  // ?q= looks through every request, whatever the tab and whatever its state: the reference a customer reads out
  // (with or without the dash people add), an address, a name, or words from the first message. An alert has no
  // stored reference, so alerts are matched on the one worked out for them.
  const q = str(c.q.get('q'), 100).trim();
  const found = (): any[] => {
    const like = `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const code = parseCode(q);
    const hits = all(`SELECT * FROM support_requests WHERE ref=? OR upper(substr(id, -8))=? OR lower(email) LIKE ? ESCAPE '\\' OR lower(COALESCE(name, '')) LIKE ? ESCAPE '\\' OR lower(message) LIKE ? ESCAPE '\\' ORDER BY ${ORDER} LIMIT 200`, code, q.toUpperCase(), like, like, like);
    const alerts = code.length === 8 ? all('SELECT * FROM support_requests WHERE ref IS NULL AND user_id IS NULL AND name=?', ALERT_NAME).filter((t) => refOf(t) === code && !hits.some((h) => h.id === t.id)) : [];
    return [...alerts, ...hits];
  };
  return {
    filter, q,
    requests: (q ? found() : all(`SELECT * FROM support_requests WHERE ${FILTERS[filter][0]} ORDER BY ${ORDER} LIMIT 200`, ...FILTERS[filter][1])).map((t) => forOperator(t)),
    counts: { open: count('open'), mine: count('mine'), unowned: count('unowned'), waiting: count('waiting'), all: count('all'),
      late: get("SELECT COUNT(*) n FROM support_requests WHERE status='open' AND due_at IS NOT NULL AND due_at < ?", now()).n },
    operators: ops.map((o) => ({ id: o.id, name: o.name, me: o.id === c.user.id })),
    reply: supportReachable() ? { hours: supportFirstReplyHours(), urgent_hours: supportUrgentReplyHours() } : null,
  };
});
route('GET', '/operator/support/:id', (c) => {
  operator(c);
  const t = load(c.params.id);
  if (!t) throw bad('That request is not in the queue any more. It may have been deleted with its writer\'s account.', 404);
  return { request: forOperator(t, true) };
});

// Everything an operator does to a request. Each action is written to the request's history with who and when.
//   take                  it is mine now
//   assign { to }         hand it to another operator, who is told by email
//   answer { text }       emailed to the customer in full; the request is answered
//   ask { text }          a question to the customer, emailed; the request waits for them and the clock stops
//   note { text }         for operators only; the customer never sees it
//   close { text }        the closing answer, emailed. Nobody closes a request without a written answer in its thread
//   spam                  nobody at that address wrote it: closed with a short note to the address that repeats nothing typed
//   reopen                open again, with a new time to answer by
//   priority { priority } 'urgent' or 'normal'
route('POST', '/operator/support/:id', async (c) => {
  operator(c);
  const b = await c.body();
  const t = load(c.params.id);
  if (!t) throw bad('That request is not in the queue any more. It may have been deleted with its writer\'s account.', 404);
  // The earlier shape of this call: { status: 'closed' } or { status: 'open' }.
  const action = str(b.action, 20) || (b.status === 'closed' ? 'close' : b.status === 'open' ? 'reopen' : '');
  const text = str(b.text ?? b.answer, 5000).trim();
  const me: By = { id: c.user.id, name: c.user.name };
  const alert = isAlert(t);
  const ref = refOf(t);
  const need = (what: string) => {
    if (text.length < 2) throw bad(what);
  };
  const noCustomer = () => {
    if (alert) throw bad('This is an alert the software filed by itself. Nobody is waiting for an email about it. Add a note, or close it with a note that says what was done.');
  };
  const notClosed = () => {
    if (t.status === 'closed') throw bad('This request is closed. Reopen it first.');
  };
  // Writing to the customer makes the request yours unless somebody has it already.
  const owner = ownerOf(t);
  const keep = owner ? owner.id : c.user.id;
  const button = { label: 'Open my request', url: '' };
  const mail = async (subject: string, heading: string, lines: string[]) => {
    // Once a request is forgotten (see forgetNow) its link opens nothing, so the email carries none.
    await sendMail({ to: t.email, subject, heading, lines, ...PLAIN, ...(t.forget && action !== 'ask' ? {} : { cta: { ...button, url: linkFor(t) } }) });
  };
  const FORGOTTEN = `You closed your Sign&Grow account while this request was open. Now that it is answered we have deleted it, as we said we would, and the link in our earlier email no longer opens it. Please do not reply to this email. If you need anything else, write to us at ${baseUrl()}/help.`;
  const first = firstName(c.user.name) || 'A person on our team';

  if (action === 'take') {
    if (owner?.id === c.user.id) return { request: forOperator(t, true) };
    tx(() => {
      run('UPDATE support_requests SET owner_id=?, updated_at=? WHERE id=?', c.user.id, now(), t.id);
      say(t, 'event', owner ? `Took it over from ${owner.name}` : 'Took it', me);
    });
  } else if (action === 'assign') {
    const to = operators().find((o) => o.id === b.to);
    if (!to) throw bad('Choose one of the people who work this queue. Someone has to be listed in OPERATOR_EMAILS, with a confirmed login, to be handed a request.');
    if (to.id !== owner?.id) {
      tx(() => {
        run('UPDATE support_requests SET owner_id=?, updated_at=? WHERE id=?', to.id, now(), t.id);
        say(t, 'event', `Handed it to ${to.name}`, me);
      });
      if (to.id !== c.user.id)
        await sendMail({ to: to.email, subject: `Request ${ref} was handed to you`, heading: `${c.user.name} handed you request ${ref}`,
          lines: [alert ? 'It is an alert the software filed by itself.' : `It is from ${who(t)}.`, isLate(t) ? `It is late: a person should have answered by ${whenText(t.due_at, to.tz || null)}.` : t.status === 'open' && t.due_at ? `A person should have answered by ${whenText(t.due_at, to.tz || null)}.` : 'No answer is due on it right now.', ...(text ? [`${c.user.name} wrote: ${text}`] : [])],
          cta: { label: 'Open the request', url: `${baseUrl()}/app/operator?ticket=${t.id}` } });
    }
  } else if (action === 'note') {
    need('Write the note first.');
    tx(() => {
      say(t, 'note', text, me);
      run('UPDATE support_requests SET updated_at=? WHERE id=?', now(), t.id);
    });
  } else if (action === 'answer' || action === 'ask') {
    noCustomer();
    notClosed();
    need(action === 'ask' ? 'Write the question first. It is emailed to the customer as you write it.' : 'Write the answer first. It is emailed to the customer as you write it.');
    tx(() => {
      say(t, action === 'ask' ? 'question' : 'answer', text, me);
      // Asking stops the clock: from here we wait for the customer, and a new time starts when they reply.
      run('UPDATE support_requests SET status=?, due_at=NULL, owner_id=?, first_reply_at=COALESCE(first_reply_at, ?), updated_at=? WHERE id=?', action === 'ask' ? 'waiting' : 'answered', keep, now(), now(), t.id);
    });
    if (action === 'ask')
      await mail(`We have a question about your request (${ref})`, `${first} needs one thing from you`, [text, `We wait for your answer, and the time we promised is paused until we have it. ${NO_REPLY} Answer with the button below. It works without signing in.`]);
    else if (t.forget) {
      await mail(`An answer to your request (${ref})`, `${first} answered your request`, [text, FORGOTTEN]);
      forgetNow(t);
      return { ok: true, deleted: true };
    } else await mail(`An answer to your request (${ref})`, `${first} answered your request`, [text, `${NO_REPLY} To write back, or to say that this solved it, use the button below. It works without signing in.`]);
  } else if (action === 'close') {
    notClosed();
    if (alert) {
      need('Write a note that says what was done about this alert. It stays with it.');
      tx(() => {
        say(t, 'note', text, me);
        say(t, 'event', 'Closed', me);
        run("UPDATE support_requests SET status='closed', closed_at=?, closed_how='handled', due_at=NULL, owner_id=?, updated_at=? WHERE id=?", now(), keep, now(), t.id);
      });
      return { request: forOperator(load(t.id), true) };
    }
    // Nobody closes a request without a written answer in its thread, and closing sends that answer: the one
    // written now, or the one already given if nothing came from the customer since.
    const given = t.status === 'answered' ? get("SELECT body FROM support_messages WHERE request_id=? AND kind='answer' ORDER BY id DESC LIMIT 1", t.id)?.body : null;
    if (!given) need('Write the answer this request is closed with. It is emailed to the customer, and nobody closes a request without one.');
    tx(() => {
      if (text) say(t, 'answer', text, me);
      say(t, 'event', text ? 'Closed with that answer' : 'Closed. The answer already given was sent again', me);
      run("UPDATE support_requests SET status='closed', closed_at=?, closed_how='answered', due_at=NULL, owner_id=?, first_reply_at=COALESCE(first_reply_at, ?), updated_at=? WHERE id=?", now(), keep, now(), now(), t.id);
    });
    const answer = text ? [text] : ['Our answer was:', given];
    if (t.forget) {
      await mail(`Your request ${ref} is closed`, `${first} closed your request`, [...answer, FORGOTTEN]);
      forgetNow(t);
      return { ok: true, deleted: true };
    }
    await mail(`Your request ${ref} is closed`, `${first} closed your request`, [...answer,
      `Not solved after all? Use the button below and write back within ${SUPPORT_REOPEN_DAYS} days: this same request opens again. After that, what you write there starts a new request that is linked to this one. ${NO_REPLY}`]);
  } else if (action === 'spam') {
    noCustomer();
    notClosed();
    // The one way to close without an answer, and only where an answer would go to someone who never asked: the
    // writer was not signed in under this address, and nothing has come back through the link from its mailbox.
    if (t.verified || get("SELECT 1 x FROM support_messages WHERE request_id=? AND kind='customer'", t.id))
      throw bad('This request is known to come from the owner of the address: they were signed in under it, or they wrote back through the link in our email. Close it with an answer instead.');
    tx(() => {
      say(t, 'event', 'Closed as not written by the owner of the address. They were told so, without the text, and how to open it again', me);
      run("UPDATE support_requests SET status='closed', closed_at=?, closed_how='spam', due_at=NULL, updated_at=? WHERE id=?", now(), now(), t.id);
    });
    if (t.forget) {
      forgetNow(t);
      return { ok: true, deleted: true };
    }
    // Even this is not closed without a word. If the operator is wrong and the owner of the address did write, a
    // silent close is the very thing people complain about. So the address gets one short note: what happened and
    // how to open it again. It repeats nothing of what was typed, so a stranger's words still reach nobody.
    await mail(`We closed request ${ref} without an answer`, 'Closed, because it did not look like it came from you',
      ['A message was sent to our help form under this email address. A person on our team read it and thought someone else had typed your address, so it was closed without an answer.',
        'If you did not write to us, there is nothing to do. We will not write to you about it again.',
        `If you did write it, we are sorry. Use the button below and tell us: the request opens again and a person answers it. ${NO_REPLY}`]);
  } else if (action === 'reopen') {
    if (t.status === 'open') return { request: forOperator(t, true) };
    tx(() => {
      say(t, 'event', `Opened it again (it was ${t.status})`, me);
      run("UPDATE support_requests SET status='open', due_at=?, closed_at=NULL, closed_how=NULL, updated_at=? WHERE id=?", alert ? null : dueFrom(priorityOf(t)), now(), t.id);
    });
  } else if (action === 'priority') {
    noCustomer();
    const to = b.priority === 'urgent' ? 'urgent' : b.priority === 'normal' ? 'normal' : null;
    if (!to) throw bad('The priority is "urgent" or "normal".');
    if (to !== priorityOf(t)) {
      // A time we told the customer is never moved later. Making a request urgent can only bring it forward.
      const sooner = to === 'urgent' && t.status === 'open' ? dueFrom('urgent') : null;
      const due = sooner && (!t.due_at || sooner < t.due_at) ? sooner : t.due_at;
      tx(() => {
        say(t, 'event', `Marked it ${to}${due !== t.due_at ? '. A person should now have answered sooner than first said' : ''}`, me);
        run('UPDATE support_requests SET priority=?, due_at=?, updated_at=? WHERE id=?', to, due, now(), t.id);
      });
    }
  } else throw bad('Say what to do with the request: take, assign, answer, ask, note, close, spam, reopen or priority.');
  return { request: forOperator(load(t.id), true) };
});

// ---- The timer -------------------------------------------------------------------------------------

// Called from cron.ts. A request that has passed the time a person should have answered by is escalated: everyone
// who answers is emailed, the customer is told plainly that we are late, and the request says so on every screen.
// Once for each time a request is late: if it is answered, reopened and late again, that is told again.
export async function supportTick(): Promise<{ late: number }> {
  let late = 0;
  const overdue = "status='open' AND due_at IS NOT NULL AND due_at < ? AND (escalated_for IS NULL OR escalated_for != due_at)";
  for (const row of all(`SELECT id FROM support_requests WHERE ${overdue} ORDER BY due_at LIMIT 100`, now())) {
    // The timer can run twice at once. One statement claims the request, so nobody is told twice.
    if (!run(`UPDATE support_requests SET escalated_for=due_at WHERE id=? AND ${overdue}`, row.id, now()).changes) continue;
    const t = load(row.id);
    if (!t || isAlert(t)) continue;
    late++;
    const owner = ownerOf(t);
    const team = everyone();
    say(t, 'event', team.length ? `Late: no answer by the time we promised. Everyone who answers was emailed (${team.length}), and the customer was told` : 'Late: no answer by the time we promised. Nobody could be emailed, because no support address and no operators are set', { name: 'Sign&Grow' });
    if (!team.length) console.error(`[support] REQUEST ${refOf(t)} IS LATE AND NOBODY WAS TOLD (set SUPPORT_EMAIL or OPERATOR_EMAILS)`);
    for (const to of team)
      await sendMail({ to, subject: `Late: help request ${refOf(t)} has no answer`, heading: `Request ${refOf(t)} is late`,
        lines: [`From ${who(t)}, about "${TOPIC_LABEL[t.topic] || t.topic}"${priorityOf(t) === 'urgent' ? ', urgent' : ''}. A person should have answered by ${whenText(t.due_at, tzOf(to))}. ${owner ? `${owner.name} has it.` : 'Nobody has taken it.'}`,
          'The customer has been told that we are late and that the whole team now has it. Whoever can, please answer it from the queue now.'],
        cta: { label: 'Open the request', url: `${baseUrl()}/app/operator?ticket=${t.id}` } });
    await sendMail({ to: t.email, subject: `We are late with your request (${refOf(t)})`, heading: 'We are late. Sorry.',
      lines: [`We said a person would have answered by ${whenText(t.due_at, customerZone(t))}, and that has not happened. Your request has been passed to everyone on the support team and is at the top of their list${owner ? `. ${firstName(owner.name)} still has it` : ''}.`,
        `You do not need to write again, and you keep your place. ${NO_REPLY} To add something or to see where it stands, use the button below.`],
      cta: { label: 'Open my request', url: linkFor(t) }, ...PLAIN });
  }
  // Someone deleted their account while we were waiting for their reply to a question of ours. The request was kept
  // so the reply would not be lost. If none has come after SUPPORT_REOPEN_DAYS, it is deleted like the rest was.
  for (const t of all("SELECT * FROM support_requests WHERE forget=1 AND status='waiting' AND COALESCE(updated_at, at) < ?", new Date(Date.now() - SUPPORT_REOPEN_DAYS * 864e5).toISOString())) forgetNow(t);
  return { late };
}
