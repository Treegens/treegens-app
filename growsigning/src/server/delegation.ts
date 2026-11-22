import { get, run, all } from './db.ts';
import { bad, id, token, now, isEmail, str, baseUrl, checkCode, rateLimit } from './util.ts';
import { sendMail } from './mail.ts';
import { audit, senderOf, emailRefusal, loadEnvelope, samePerson, mixesAlphabets, type Actor } from './envelopes.ts';
import { posesAs } from './fakenotice.ts';
import { gateOf, linkStamp } from './signercode.ts';
import { refuse } from './signlang.ts';
import { record } from './seclog.ts';
import type { Ctx } from './router.ts';
import { datesProblem, datesWords, dayWords, todayIn, certLineFor, dayOf } from '../lib/delegation.ts';

// Someone who signs for a person while they are away.
//
// What is kept. An admin switches it on for the account (accounts.delegation, off by default). Then a person in that
// account with a confirmed address names one delegate, a name and an address, for some days (delegations). Only
// documents sent from that same account are affected: a document from anyone else still goes to the person only, so
// no outside sender is ever surprised by it.
//
// What happens. When a request (signer or approver) reaches the person's address on one of those days, the person is
// emailed as always and their email says the delegate has it too; the delegate gets a link of their own
// (delegate_links) and always types a one-time code sent to their own address before the document opens. Whoever
// agrees first takes it on, as in a signing group (groups.ts), but the request stays the person's one row: one place
// in the order, one signature held and used. If the delegate takes it on, the row from then on carries the
// delegate's name, address and link (recipients.delegate_link_id and delegate_for say for whom), the person's own
// link says who is signing for them, and the person is emailed. If the person agrees first, the delegate's link says
// so. The delegate never sees the person's saved signature: they sign with their own.
//
// Never for: someone signing in person, a witness, a public form, a group, a counter, someone whose link the sender
// passes on, the sender's own signature, and an envelope whose sender ticked "Only the person named may sign".
// Not here (left out on purpose): delegating to a group, and a delegate who names a delegate of their own.

const SYSTEM: Actor = { name: 'System' };
const lower = (s: any) => String(s ?? '').trim().toLowerCase();
const ACTING = new Set(['signer', 'approver']);
const brandOf = (accountId: string) => {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
};

// Characters nobody sees, marks that turn the direction of text, and markup have no place in a name on a certificate.
const cleanName = (v: any) => str(v, 500).replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, ' ').trim().replace(/\s+/g, ' ');

/** Why this name cannot be the delegate's, or null. */
function nameProblem(c: Ctx, name: string, email: string): string | null {
  if (/[<>]/.test(name)) return 'A name cannot hold the signs < or >. Type the name as it is written.';
  if (name.replace(/[^\p{L}]/gu, '').length < 2) return 'Type the name of the person, as it is written.';
  if (mixesAlphabets(name)) return 'That name mixes letters from two alphabets in one word. Type it in one alphabet, as the person writes it.';
  if (posesAs(name)) return 'That name reads like a well-known company. Type the name of the person who signs for you.';
  if (samePerson(c.user.name, name)) return 'That is your own name. Type the name of the person who signs for you.';
  // Someone else in this account, at another address: the record would name them for what someone else did.
  const other = all('SELECT u.name, u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.account_id=?', c.account.id)
    .find((u: any) => lower(u.email) !== lower(email) && samePerson(u.name, name));
  if (other) return `${other.name} is in this account with another address (${other.email}). If you mean them, use that address. If not, type the full name of the person you mean.`;
  return null;
}

// A link whose last day is over in the person's own time zone is over, whether or not anyone opened Settings.
function isOver(l: any): boolean {
  if (!l?.ends_on) return false;
  const d = get('SELECT ends_on FROM delegations WHERE id=?', l.delegation_id);
  const last = d?.ends_on && d.ends_on < l.ends_on ? d.ends_on : l.ends_on;
  const u = get('SELECT tz FROM users WHERE lower(email)=lower(?)', l.for_email);
  return last < todayIn(u?.tz);
}

// ---- The switch, and a person's own delegate --------------------------------------------------------------

/** Whether the admins of this account allowed delegates. Off by default. */
export const delegationOn = (accountId: string | null | undefined): boolean => !!accountId && get('SELECT delegation v FROM accounts WHERE id=?', accountId)?.v === 1;

export function setSwitch(c: Ctx, on: boolean) {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change this setting. That needs an owner or an admin signed in to the app, under Settings, Team. Nothing was changed.', 403);
  const was = delegationOn(c.account.id);
  if (was !== on) {
    run('UPDATE accounts SET delegation=? WHERE id=?', on ? 1 : 0, c.account.id);
    // Off again: every delegation in the account stops at once, and links that nobody has acted on stop working.
    if (!on) {
      const t = now();
      for (const d of all('SELECT id FROM delegations WHERE account_id=? AND ended_at IS NULL', c.account.id)) endDelegation(d.id, t);
    }
    record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { delegation: { from: was ? 'on' : 'off', to: on ? 'on' : 'off' } } } });
  }
  return { on };
}

const view = (d: any) => (d ? { id: d.id, name: d.name, email: d.email, starts_on: d.starts_on, ends_on: d.ends_on, created_at: d.created_at, dates: datesWords(d.starts_on, d.ends_on) } : null);
const current = (userId: string, accountId: string) => get('SELECT * FROM delegations WHERE user_id=? AND account_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', userId, accountId);

/** What Settings, Away and sharing shows: whether it is allowed here, and the delegate the person named, if any. */
export function myDelegation(c: Ctx) {
  const today = todayIn(c.user.tz);
  let d = current(c.user.id, c.account.id);
  // One whose last day is over is over: it is closed when it is next looked at, so the card starts empty again.
  if (d && d.ends_on < today) (endDelegation(d.id, now()), (d = null));
  return { allowed: delegationOn(c.account.id), confirmed: !!c.user.email_verified, today, delegate: view(d), active: !!d && d.starts_on <= today };
}

function endDelegation(delegationId: string, t: string) {
  run('UPDATE delegations SET ended_at=? WHERE id=? AND ended_at IS NULL', t, delegationId);
  // A link nobody has acted on yet stops working. One the delegate already took on stays theirs: they agreed to it
  // while it was allowed, and the record says so.
  run(`UPDATE delegate_links SET removed_at=? WHERE delegation_id=? AND removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.id=delegate_links.recipient_id AND r.delegate_link_id=delegate_links.id)`, t, delegationId);
}

export async function saveDelegation(c: Ctx, body: any) {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot name a delegate. Sign in to the app and use Settings, Away and sharing. Nothing was saved.', 403);
  if (!delegationOn(c.account.id)) throw bad(`The admins of ${c.account.name} have not allowed delegates, so nobody can be named. Ask one of them: Settings, Team lists who they are. Nothing was saved.`, 403, { code: 'delegation_off' });
  if (!c.user.email_verified) throw bad(`Confirm your email address first: type the 6-digit code from our email in the box at the top. Documents only go to a delegate for an address that is confirmed. Nothing was saved.`, 403, { code: 'confirm_email' });
  const name = cleanName(body?.name);
  const email = str(body?.email, 500).trim();
  if (!name) throw bad('Type the name of the person who signs for you. Nothing was saved.');
  if (name.length > 120) throw bad(`That name is ${name.length} characters long, and the most that fits is 120. Nothing was saved.`);
  if (!isEmail(email)) throw bad(`Type a valid email address for ${name}${email ? `: "${str(email, 120)}" is not one` : ''}. Nothing was saved.`);
  if (lower(email) === lower(c.user.email)) throw bad('That is your own address. Name someone else, who signs for you while you are away. Nothing was saved.');
  // The name is printed on the certificate, in emails and in the record, so it follows the rules a signer's own name
  // follows (renameSelf in envelopes.ts), and it can never be the person's own name or someone else's in the account.
  const why = nameProblem(c, name, email);
  if (why) throw bad(`${why} Nothing was saved.`);
  const today = todayIn(c.user.tz);
  const problem = datesProblem(body?.starts_on, body?.ends_on, today);
  if (problem) throw bad(`${problem} Nothing was saved.`);
  // Each save emails the delegate, so a few a day is plenty: nobody can use this to fill someone's inbox.
  rateLimit(`delegate:${c.user.id}`, 6, 86400_000);
  const was = current(c.user.id, c.account.id);
  const t = now();
  if (was) endDelegation(was.id, t);
  const did = id('dlg');
  run('INSERT INTO delegations (id, user_id, account_id, name, email, starts_on, ends_on, created_at) VALUES (?,?,?,?,?,?,?,?)', did, c.user.id, c.account.id, name, email, dayOf(body.starts_on), dayOf(body.ends_on), t);
  const d = get('SELECT * FROM delegations WHERE id=?', did);
  record('settings.changed', { c, about: ['user', c.user.id], details: { settings: { delegate: { from: was ? `${was.name} <${was.email}>` : 'none', to: `${name} <${email}>, ${d.starts_on} to ${d.ends_on}` } } } });
  // The delegate hears it from us at once, so nobody is surprised later by a document in someone else's name.
  await sendMail({
    to: email, subject: `${c.user.name} named you to sign for them while they are away`, heading: `${c.user.name} named you to sign for them`,
    lines: [`${c.user.name} (${c.user.email}) named you to sign for them ${datesWords(d.starts_on, d.ends_on)}, while they are away. They did this in GrowSigning, for documents sent to them from ${c.account.name}.`,
      'You do not have to do anything now. If such a document arrives on one of those days, we email it to you as well, with a link of your own. Whoever of you agrees first takes it on. You would sign with your own name and signature, for them, and the record says so.',
      `If you did not expect this, you can ignore it, or tell ${c.user.name}. Nothing reaches you unless a document is sent to them on those days.`],
    brand: brandOf(c.account.id), replyTo: c.user.email, fromName: c.user.name,
  });
  return myDelegation(c);
}

export function stopDelegation(c: Ctx) {
  const d = current(c.user.id, c.account.id);
  if (!d) throw bad('You have no delegate named right now, so there was nothing to stop.', 404);
  endDelegation(d.id, now());
  record('settings.changed', { c, about: ['user', c.user.id], details: { settings: { delegate: { from: `${d.name} <${d.email}>`, to: 'none' } } } });
  return myDelegation(c);
}

// ---- The sender's "Only the person named may sign" -----------------------------------------------------------

/** `e` is an envelope this person may open (mine in routes-envelopes.ts, called by the route). */
export function setOnlyNamed(c: Ctx, e: any, only: boolean) {
  if (!['draft', 'sent'].includes(e.status)) throw bad('This document is no longer out for signature, so who may sign it can no longer be changed. Nothing was changed.', 409);
  run('UPDATE envelopes SET delegate_off=? WHERE id=?', only ? 1 : 0, e.id);
  let stopped = 0;
  if (only) {
    // A delegate who has not acted yet is no longer needed: their link says so. One who already took it on keeps it;
    // the sender can still correct that recipient back to the person.
    stopped = Number(run(`UPDATE delegate_links SET removed_at=? WHERE envelope_id=? AND removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.id=delegate_links.recipient_id AND r.delegate_link_id=delegate_links.id)`, now(), e.id).changes);
  }
  if (e.status === 'sent') audit(e.id, { name: c.user.name }, only ? 'Only the person named may sign' : 'Delegates allowed again', only
    ? `The sender said that only the people named on this envelope may sign it.${stopped ? ` ${stopped === 1 ? 'The link of a delegate who had not acted yet' : `The links of ${stopped} delegates who had not acted yet`} stopped working.` : ''}`
    : 'The sender allowed delegates again. Someone the document reaches from now on, who named a delegate, has it go to them too.');
  return { only_named: only, links_stopped: stopped };
}

// ---- When a request reaches a person ---------------------------------------------------------------------------

/** The person's delegation that holds for this request today, or null. */
function delegationFor(e: any, r: any): any {
  if (!r || !ACTING.has(r.role) || !r.email || r.group_name || r.group_id || r.link_by_sender || r.delegate_link_id) return null;
  if (e.kind !== 'envelope' || e.powerform_id || e.delegate_off || !delegationOn(e.account_id)) return null;
  const u = get('SELECT id, name, email, tz, email_verified FROM users WHERE lower(email)=lower(?)', r.email);
  if (!u?.email_verified) return null;
  // The sender's own signature is theirs to give.
  if (u.id === e.sender_id) return null;
  if (!get('SELECT 1 x FROM memberships WHERE user_id=? AND account_id=?', u.id, e.account_id)) return null;
  const d = current(u.id, e.account_id);
  const today = todayIn(u.tz);
  if (!d || d.starts_on > today || d.ends_on < today) return null;
  // This request already went to this delegate once (they took it on and the sender put the person back, or the
  // sender stopped their link): it does not go to them a second time.
  if (r.id && get('SELECT 1 x FROM delegate_links WHERE recipient_id=? AND delegation_id=?', r.id, d.id)) return null;
  // Someone who is on this envelope already, or who sent it, never signs a second time in someone else's name.
  if (lower(d.email) === lower(senderOf(e)?.email) || (e.recipients || []).some((x: any) => lower(x.email) === lower(d.email))) return null;
  return { ...d, person: u };
}

const openLink = (r: any) => get('SELECT * FROM delegate_links WHERE recipient_id=? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1', r.id);
// Whether the person has started on it themselves: agreed, typed or saved a signature.
const personStarted = (row: any) => !!(row.consent_at || row.touched_at || row.signature_png || row.initials_png);
// The delegate's link still stands for this row: not stopped, the same person, and nobody acted yet.
const stillOpen = (row: any, l: any) => !!l && !l.removed_at && !isOver(l) && !row.delegate_link_id && Number(row.person_gen || 0) === Number(l.person_gen || 0) && lower(row.email) === lower(l.for_email) && !personStarted(row) && (row.status === 'sent' || row.status === 'viewed' || row.status === 'pending');

/**
 * Called by notifyRecipient() while it writes the email to a person: on the first email of a request it makes the
 * delegate's link when the person's delegation holds today. Answers the line that email carries about it (empty when
 * nobody else has it).
 */
export function delegateLines(e: any, r: any, kind: string): string[] {
  let l = openLink(r);
  if (!l && kind === 'new') {
    const d = delegationFor(e, r);
    if (d) {
      const lid = id('dlk');
      run(`INSERT INTO delegate_links (id, recipient_id, envelope_id, delegation_id, for_name, for_email, for_token, person_gen, name, email, token, check_code, set_on, starts_on, ends_on, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lid, r.id, e.id, d.id, r.name, r.email, r.token, Number(r.person_gen || 0), d.name, d.email, token(), checkCode(), d.created_at, d.starts_on, d.ends_on, now());
      audit(e.id, SYSTEM, 'Also sent to a delegate', `${r.name} <${r.email}> named ${d.name} <${d.email}> to sign for them ${datesWords(d.starts_on, d.ends_on)}, and this reached them on one of those days. ${d.name} gets a link of their own and has to type a one-time code sent to that address. Whoever of the two agrees first takes it on.`);
      l = openLink(r);
    }
  }
  const row = get('SELECT * FROM recipients WHERE id=?', r.id);
  if (!l || !row || !stillOpen(row, l)) return [];
  return [`While you are away, ${l.name} can also ${r.role === 'approver' ? 'approve' : 'sign'} this for you: you named them in GrowSigning. Whoever of you agrees first takes it on, and the other one's link then says so.`];
}

/** Called by notifyRecipient() after the email to the person: the delegate gets the request, or its reminder, too. */
export async function alsoDelegate(e: any, r: any, kind: string): Promise<void> {
  if (!['new', 'reminder', 'expiring', 'updated', 'reopened', 'resumed'].includes(kind)) return;
  const l = openLink(r);
  const row = l && get('SELECT * FROM recipients WHERE id=?', r.id);
  if (!l || !row || !stillOpen(row, l) || (kind === 'new' && l.sent_at) || (kind !== 'new' && !l.sent_at)) return;
  if (emailRefusal(e)) return;
  const sender = senderOf(e) || { name: 'The sender', email: '' };
  const verb = r.role === 'approver' ? 'approve' : 'sign';
  const how = await sendMail({
    to: l.email,
    subject: `${kind === 'new' ? '' : kind === 'reminder' ? 'Reminder: ' : kind === 'expiring' ? 'Expires soon: ' : 'Updated: '}For ${l.for_name}: ${e.subject}`,
    heading: `${sender.name} sent ${l.for_name} a document to ${verb}`,
    lines: [
      e.subject,
      `${l.for_name} named you to ${verb} for them ${datesWords(l.starts_on, l.ends_on)}, while they are away, and this reached them on one of those days. So it comes to you too.`,
      `Whoever of you agrees first takes it on. If it is you, you ${verb} with your own name and your own signature, for ${l.for_name}, and the record says so. ${l.for_name} is emailed when you do.`,
      'Before it opens, we email you a one-time code to type, at this address.',
      `If you should not ${verb} this for ${l.for_name}, do nothing: ${l.for_name} can still do it themselves.`,
      ...(row.access_code ? [`It also needs an access code, which ${sender.name} gave ${l.for_name}. It is not in this email.`] : []),
      `Reply to this email to reach ${sender.name} (${sender.email}).`,
    ],
    cta: { label: r.role === 'approver' ? 'Review and approve' : 'Review and sign', url: `${baseUrl()}/sign/${l.token}` },
    envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email || undefined, fromName: sender.name,
  });
  if (kind === 'new') {
    run('UPDATE delegate_links SET sent_at=? WHERE id=?', now(), l.id);
    audit(e.id, SYSTEM, how === 'outbox' ? 'Not emailed' : 'Sent to delegate', `${l.name} <${l.email}>, for ${l.for_name}${how === 'outbox' ? '. No mail server is set up, so no email went out' : ''}`);
  }
}

// ---- The links ---------------------------------------------------------------------------------------------------

/**
 * The delegate link a signing link belongs to, or null. That is the delegate's own link, and the person's own link
 * once no recipient row carries it any more (the delegate took the request on).
 */
export function delegateLinkOf(tok: string): any {
  if (!tok) return null;
  const l = get('SELECT * FROM delegate_links WHERE token=?', tok);
  if (l) return l;
  const p = get('SELECT * FROM delegate_links WHERE for_token=? ORDER BY created_at DESC LIMIT 1', tok);
  if (!p || get('SELECT 1 x FROM recipients WHERE token=?', tok)) return null;
  return { ...p, as_person: true };
}

/** Whether this row was taken on by this link's delegate, and still is (the sender did not put someone else there). */
const takenBy = (row: any, l: any) => !!l && row.delegate_link_id === l.id && Number(row.person_gen || 0) === Number(l.person_gen || 0) && lower(row.email) === lower(l.email);

// What each state of a delegate's link may do. The first part of the path after the token ('' is the page itself).
//   open:    nobody has acted. Reading, the code, the access code, agreeing (which takes it on) and declining, and
//            what the page asks on the side that writes nothing of the person's (the break check, trees, who comes
//            next, stamps, a summary). The person's private questions, language and reminders are not the delegate's.
//   taken:   the person started on it themselves, or it is closed. The link says so, and nothing more.
//   removed: the sender said only the person named may sign, the person stopped the delegation, or someone else
//            was put in the person's place.
const MAY: Record<string, string[]> = { open: ['', 'doc', 'download', 'consent', 'decline', 'code', 'unlock', 'ask-code', 'print-check', 'away', 'impact', 'step', 'stamps', 'summary'], taken: [''], removed: [''], by_delegate: [''] };
// Once the delegate took it on they act like any recipient, except that they cannot pass it on or rename themselves:
// no chain of delegates, and the name on the record stays the one the person gave.
const NOT_FOR_DELEGATE = ['reassign', 'name'];

/** Called by look() in routes-sign.ts for a link that belongs to a delegation. Answers what look() answers. */
export function delegateLook(c: Ctx, e: any, row: any, l: any, locked: boolean, needUnlocked: boolean) {
  const what = c.url.pathname.replace(/^\/api/, '').split('/')[3] || '';
  // The person's own link after the delegate took it on: who is signing for them, and nothing else.
  if (l.as_person) {
    if (!takenBy(row, l)) throw refuse('unknown_link', 404);
    if (!MAY.by_delegate.includes(what)) throw bad(`${l.name} is ${row.role === 'approver' ? 'approving' : 'signing'} this for you, so this link no longer opens the document. If that is wrong, contact ${senderOf(e)?.name || 'the sender'}.`, 409, { code: 'delegate_has_it' });
    const r = { ...row, name: l.for_name, email: l.for_email, token: l.for_token, signature_png: null, initials_png: null, delegate_state: 'by_delegate', delegate_facts: facts(row, l, 'person', 'by_delegate') };
    return { e, r, locked: false, gate: null, actor: { name: `${l.for_name} <${l.for_email}>`, ip: c.ip, ua: c.ua } };
  }
  if (takenBy(row, l)) {
    if (NOT_FOR_DELEGATE.includes(what)) throw bad(`You are signing this for ${l.for_name}, so it cannot be passed on or renamed from here. If someone else should sign, ask ${senderOf(e)?.name || 'the sender'}.`, 409, { code: 'delegate' });
    const gate = gateOf(c.req, row);
    if (gate && needUnlocked) throw refuse('one_time_code_first', 401);
    const r = { ...row, delegate_facts: facts(row, l, 'delegate', 'mine') };
    return { e, r, locked, gate, actor: { name: `${row.name}, for ${l.for_name} <${row.email}>`, ip: c.ip, ua: c.ua } };
  }
  const closed = e.status !== 'sent' || !['sent', 'viewed', 'pending'].includes(row.status);
  const gone = !!l.removed_at || isOver(l) || Number(row.person_gen || 0) !== Number(l.person_gen || 0) || lower(row.email) !== lower(l.for_email) || !!row.delegate_link_id || (!!e.delegate_off);
  const state = gone ? 'removed' : closed || personStarted(row) ? 'taken' : 'open';
  if (!MAY[state].includes(what)) {
    if (state === 'removed') throw bad(`You no longer need to act on this for ${l.for_name}. There is nothing for you to do.`, 403, { code: 'removed' });
    if (state === 'taken') throw bad(`${l.for_name} is dealing with this themselves, so there is nothing for you to do.`, 409, { code: 'taken' });
    throw bad(`Agree first. Until you do, nothing can be filled in or saved through this link.`, 409, { code: 'not_taken' });
  }
  // The delegate as the recipient: their name, address, link and code; a one-time code by email always; nothing of
  // the person's own (no saved signature, no consent, no reminders setting).
  const r = { ...row, name: l.name, email: l.email, token: l.token, check_code: l.check_code, verify: 'email_code', phone: null, text_link: 0, wa_link: 0,
    signature_png: null, initials_png: null, consent_at: null, muted: 0, viewed_at: l.viewed_at, checked_at: null, checked_how: null, checked_for: null,
    complained_at: null, reported_at: null, bounced_at: null, delegate_link: l, delegate_state: state, delegate_facts: facts(row, l, 'delegate', state) };
  if (state !== 'open') return { e, r, locked: false, gate: null, actor: { name: `${l.name}, delegate of ${l.for_name} <${l.email}>`, ip: c.ip, ua: c.ua } };
  const gate = gateOf(c.req, r);
  if (gate && needUnlocked) throw refuse('one_time_code_first', 401);
  if (!gate && !locked && !l.viewed_at && what === '') run('UPDATE delegate_links SET viewed_at=? WHERE id=? AND viewed_at IS NULL', now(), l.id);
  return { e, r, locked, gate, actor: { name: `${l.name}, delegate of ${l.for_name} <${l.email}>`, ip: c.ip, ua: c.ua } };
}

function facts(row: any, l: any, as: 'delegate' | 'person', state: string) {
  return { as, state, for_name: l.for_name, by_name: l.name, dates: datesWords(l.starts_on, l.ends_on), at: row.delegate_link_id === l.id ? row.delegate_at : null, done: row.status === 'completed', declined: row.status === 'declined' };
}

/**
 * What the signing page is told (recipient.delegate), or null when no delegate is involved: the delegate's own link
 * in any state, the person's link once the delegate has it, and the person's own page while the delegate could
 * still take it ("as": "person", "state": "open"), so the person knows before agreeing.
 */
export function delegateFacts(e: any, r: any): any {
  if (r?.delegate_facts) return r.delegate_facts;
  if (!r?.id || r.member) return null;
  const l = openLink(r);
  const row = l && get('SELECT * FROM recipients WHERE id=?', r.id);
  return l && row && stillOpen(row, l) && e.status === 'sent' ? facts(row, l, 'person', 'open') : null;
}

/** Whether the page is shown only who has it, and no document. */
export const delegateAway = (r: any): boolean => !!r?.delegate_state && r.delegate_state !== 'open' && r.delegate_state !== 'mine';

// ---- Taking it on ---------------------------------------------------------------------------------------------

/**
 * Called where a delegate agrees (and before a delegate declines). One statement takes the request on for whoever is
 * first, only while the person has not started and it is open. From here the row is the delegate's: their name,
 * address, link, the one-time code they passed, no saved signature, and the fields as the sender set them.
 */
export function delegateTakeOn<T extends { e: any; r: any; actor: Actor }>(x: T, why = ''): T {
  const l = x.r?.delegate_link;
  if (!l || x.r.delegate_state !== 'open') return x;
  if (!ACTING.has(x.r.role)) return x;
  const t = now();
  const done = run(`UPDATE recipients SET name=?, email=?, token=?, check_code=?, delegate_verify_was=COALESCE(verify, ''), verify='email_code', checked_at=?, checked_how=?, checked_for=?, delegate_link_id=?, delegate_for=?, delegate_for_email=?, delegate_at=?,
      signature_png=NULL, initials_png=NULL, viewed_at=COALESCE(?, viewed_at, ?), ip=?, user_agent=?, sender_name=NULL, self_name=NULL, tz=NULL, muted=0, text_link=0, wa_link=0, complained_at=NULL, bounced_at=NULL
    WHERE id=? AND token=? AND delegate_link_id IS NULL AND consent_at IS NULL AND touched_at IS NULL AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent'`,
  l.name, l.email, l.token, l.check_code, l.checked_at, l.checked_how, l.checked_at ? linkStamp({ id: x.r.id, token: l.token, person_gen: x.r.person_gen }) : null, l.id, l.for_name, l.for_email, t,
  l.viewed_at, t, x.actor.ip || null, (x.actor.ua || '').slice(0, 300) || null, x.r.id, l.for_token).changes;
  if (!done) throw bad(`${l.for_name} has started on this themselves, or it changed a moment ago, so it was not taken on. Open your link again to see where it stands.`, 409, { code: 'taken' });
  run("UPDATE fields SET value=prefill WHERE recipient_id=? AND readonly=0 AND type!='note'", x.r.id);
  const actor = { ...x.actor, name: `${l.name}, for ${l.for_name} <${l.email}>` };
  audit(x.e.id, actor, 'Taken on for someone away', `${l.name} <${l.email}> took this on for ${l.for_name} <${l.for_email}>${why || `, by agreeing to ${x.r.role === 'approver' ? 'approve' : 'sign'} it`}, as the delegate ${l.for_name} named on ${dayWords(String(l.set_on).slice(0, 10))} for ${datesWords(l.starts_on, l.ends_on)}. ${l.checked_how ? `${l.checked_how}, typed correctly.` : ''} ${l.for_name}'s own link now says who has it.`.replace(/\s+$/, ''));
  void tellPerson(x.e, l, 'took').catch(() => {});
  const e = loadEnvelope(x.e.id);
  const r = e.recipients.find((y: any) => y.id === x.r.id);
  return { ...x, e, r: { ...r, delegate_facts: facts(r, l, 'delegate', 'mine') }, actor };
}

/** The person is told when their delegate takes a request on, and when they finish or decline it. */
async function tellPerson(e: any, l: any, what: 'took' | 'completed' | 'declined') {
  if (emailRefusal(e)) return;
  const sender = senderOf(e) || { name: 'the sender', email: '' };
  const subject = what === 'took' ? `${l.name} is signing for you: ${e.subject}` : what === 'completed' ? `${l.name} signed for you: ${e.subject}` : `${l.name} declined for you: ${e.subject}`;
  const lines = what === 'took'
    ? [`${l.name} agreed to sign "${e.subject}" for you, as the person you named while you are away. Your own link now says so, and you do not sign it yourself.`,
      `If ${l.name} should not sign it, tell ${sender.name} straight away${sender.email ? ` (${sender.email})` : ''}: only they can change who signs it now.`]
    : what === 'completed'
      ? [`${l.name} finished "${e.subject}" for you, with their own name and signature. The record says they signed for you, under the delegation you set, and that GrowSigning does not know whether they have the authority to.`,
        `If you need a copy, ask ${sender.name}${sender.email ? ` (${sender.email})` : ''}.`]
      : [`${l.name} declined "${e.subject}" for you, so it is closed. ${sender.name} has been told.`, `If that was not what you wanted, contact ${sender.name}${sender.email ? ` (${sender.email})` : ''}.`];
  await sendMail({ to: l.for_email, subject, heading: subject.split(':')[0], lines, envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email || undefined, fromName: sender.name });
}

/** Called after a delegate who has the request finished or declined it. */
export async function delegateFinished(e: any, recipientId: string, what: 'completed' | 'declined') {
  const row = get('SELECT * FROM recipients WHERE id=?', recipientId);
  const l = row?.delegate_link_id && get('SELECT * FROM delegate_links WHERE id=?', row.delegate_link_id);
  if (!l || !takenBy(row, l)) return;
  await tellPerson(e, l, what).catch(() => {});
}

/** Checked before a delegate who has not taken it on declines: a decline that will be refused takes nothing on. */
export function assertDelegateDecline(r: any, reason: string) {
  if (!r?.delegate_link || r.delegate_state !== 'open') return;
  if (r.role !== 'signer' && r.role !== 'approver') throw bad('Only signers and approvers can decline.');
  if (!reason.trim()) throw bad('Please tell the sender why you are declining.');
}

// ---- The certificate and the sender's page ----------------------------------------------------------------------

/** The certificate's line for a recipient a delegate took on, or none. */
export function delegateCertLines(e: any, r: any): [string, string][] {
  const l = r?.delegate_link_id && get('SELECT * FROM delegate_links WHERE id=?', r.delegate_link_id);
  if (!l || !takenBy(r, l)) return [];
  return [['Signed for', certLineFor(r.role, { delegate: r.name, person: l.for_name, setOn: l.set_on, from: l.starts_on, to: l.ends_on })]];
}

/**
 * For the sender's envelope page and the API: on each recipient, "delegation" when one is involved: who, for whom, and
 * where it stands ("open": both can act, "took": the delegate has it, "stopped"). Never a link or a code.
 */
export function attachDelegates(e: any) {
  if (!e?.id || e.status === 'draft') return;
  const links = all('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  if (!links.length) return;
  for (const r of e.recipients || []) {
    const l = links.filter((x: any) => x.recipient_id === r.id).sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!l) continue;
    const took = takenBy(r, l);
    r.delegation = { name: l.name, email: l.email, for_name: l.for_name, dates: datesWords(l.starts_on, l.ends_on), state: took ? 'took' : stillOpen(r, l) ? 'open' : 'stopped', at: took ? r.delegate_at : null };
  }
}

/**
 * Called by correctRecipient() in envelopes.ts after the sender put a new address on a request a delegate had taken
 * on: the request is no longer the delegate's. The row forgets the delegation and gets back the check the sender
 * chose, so the person (or whoever the sender named) is not asked for a one-time code nobody asked for.
 */
export function delegateCorrected(recipientId: string) {
  run(`UPDATE recipients SET verify=CASE WHEN delegate_verify_was IS NULL THEN verify ELSE NULLIF(delegate_verify_was, '') END,
      delegate_link_id=NULL, delegate_for=NULL, delegate_for_email=NULL, delegate_at=NULL, delegate_verify_was=NULL WHERE id=? AND delegate_link_id IS NOT NULL`, recipientId);
}

/**
 * For the sender in step 3: who among these people is away today and named someone to sign for them, so the one
 * choice about it ("Only the person named may sign") is offered only where it means something, and names them.
 * `people` are the rows as the editor has them now ({ name, email, role, group_id }). Never an address of a delegate.
 */
export function awayFor(e: any, people: any[]): { email: string; name: string; delegate: string; role: string }[] {
  if (!e || e.kind !== 'envelope' || e.powerform_id || !delegationOn(e.account_id)) return [];
  const rows = (Array.isArray(people) ? people : []).slice(0, 100).map((p: any) => ({ name: str(p?.name, 120), email: str(p?.email, 254).trim(), role: String(p?.role || ''), group_id: p?.group_id || null, group_name: p?.group_name || null }));
  const as = { ...e, delegate_off: 0, recipients: rows };
  const out: { email: string; name: string; delegate: string; role: string }[] = [];
  for (const r of rows) {
    if (!r.email || out.some((o) => lower(o.email) === lower(r.email))) continue;
    const d = delegationFor(as, r);
    if (d) out.push({ email: r.email, name: r.name || d.person.name, delegate: d.name, role: r.role });
  }
  return out;
}
