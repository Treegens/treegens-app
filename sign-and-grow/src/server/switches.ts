// Small switches for senders and admins (research/docusign-gaps.json, batch "switches"). The words and rules the
// pages share are in src/lib/switches.ts; the routes are in routes-switches.ts. Each switch keeps today's behaviour
// until an admin changes it.
//
//   Pass it on          accounts.sw_pass_on, and per envelope envelopes.sw_pass_on (NULL: as the account said when it
//                       was sent). With sw_pass_copy on, the first person stays on as someone who gets a copy.
//   Questions/comments  accounts.sw_comments, envelopes.sw_comments. Off: nobody can start or add to a conversation
//                       from the signing page; what was written before stays readable.
//   Ways to sign        accounts.sw_sign_ways ("type,draw", NULL for all three). How each signature and initials
//                       was made is kept on the recipient (sig_how, ini_how) and printed on the certificate.
//   Stamps              accounts.sw_stamps. Off: members cannot place new stamp fields. Sent envelopes stay as they are.
//   Mark words          accounts.sw_mark_words: the big words across a copy made while the document is still out.
//   Form limits         powerforms.max_signed and powerforms.closes_at.
//
// An envelope sent before these switches existed has NULL in its own columns and keeps today's behaviour (on), so an
// admin who changes the account later never changes a document that is already out.
import { get, run } from './db.ts';
import { bad, id, now, token, checkCode, str } from './util.ts';
import { clockIn, validZone } from '../lib/dates.ts';
import { powerformIdleHours } from '../lib/policy.ts';
import { audit, type Actor } from './envelopes.ts';
import { waysOf, waysLimited, howOf, wayOfHow, howText, markWords, markWordsProblem, WAY_LABELS, FORM_LIMIT_MAX, formLastDay, dayWords, type SignWay, type SigningSwitches } from '../lib/switches.ts';

const acct = (accountId: string) => get('SELECT sw_pass_on, sw_pass_copy, sw_comments, sw_sign_ways, sw_stamps, sw_mark_words FROM accounts WHERE id=?', accountId) || {};
const on = (v: any, fallback = true) => (v === null || v === undefined ? fallback : !!Number(v));

/** The account's switches, as the Settings card and the API show them. */
export function accountSwitches(accountId: string) {
  const a = acct(accountId);
  return {
    pass_on: on(a.sw_pass_on),
    pass_on_copy: on(a.sw_pass_copy, false),
    comments: on(a.sw_comments),
    sign_ways: waysOf(a.sw_sign_ways),
    members_stamps: on(a.sw_stamps),
    mark_words: markWords(a.sw_mark_words),
  };
}

/** One envelope's own switches: its own value, the account's while it is a draft, and on for one sent before. */
export function envelopeSwitches(e: any) {
  const a = acct(e.account_id);
  const pick = (own: any, account: any, fallback: boolean) => (own !== null && own !== undefined ? !!Number(own) : e.status === 'draft' ? on(account, fallback) : fallback);
  return {
    pass_on: pick(e.sw_pass_on, a.sw_pass_on, true),
    pass_on_copy: pick(e.sw_pass_copy, a.sw_pass_copy, false),
    comments: pick(e.sw_comments, a.sw_comments, true),
  };
}

/**
 * The ways of making a signature for one envelope: as written down when it was sent, the account's while it is a
 * draft (or for one sent before the ways were written down).
 */
export const waysFor = (e: any): SignWay[] => waysOf(e.status !== 'draft' && e.sw_sign_ways ? e.sw_sign_ways : acct(e.account_id).sw_sign_ways);

/** What the signing page is given: whether this person may pass it on, may write a comment, and how they may sign. */
export function signingSwitches(e: any): SigningSwitches {
  const s = envelopeSwitches(e);
  return { pass_on: s.pass_on, comments: s.comments, ways: waysFor(e) };
}

/** Written down when the envelope is sent, so a later change in Settings never changes a document that is out. */
export function snapSwitches(e: any) {
  const s = envelopeSwitches({ ...e, status: 'draft' });
  const a = acct(e.account_id);
  run('UPDATE envelopes SET sw_pass_on=COALESCE(sw_pass_on, ?), sw_pass_copy=COALESCE(sw_pass_copy, ?), sw_comments=COALESCE(sw_comments, ?), sw_sign_ways=COALESCE(sw_sign_ways, ?), sw_mark_words=COALESCE(sw_mark_words, ?) WHERE id=?',
    s.pass_on ? 1 : 0, s.pass_on_copy ? 1 : 0, s.comments ? 1 : 0, waysOf(a.sw_sign_ways).join(','), markWords(a.sw_mark_words), e.id);
}

const yesNo = (v: unknown, name: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw bad(`Send "${name}" as true or false. Nothing was changed.`, 400, { field: name });
  return v;
};

/** Changes the account's switches from a request body. Returns what changed, for the account's history. */
export function saveAccountSwitches(accountId: string, b: any): Record<string, { from: unknown; to: unknown }> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON object with the switches to change. Nothing was changed.');
  const was = accountSwitches(accountId);
  const next: any = { ...was };
  const known = ['pass_on', 'pass_on_copy', 'comments', 'sign_ways', 'members_stamps', 'mark_words'];
  const unknown = Object.keys(b).filter((k) => !known.includes(k));
  if (unknown.length) throw bad(`"${unknown[0]}" is not one of these switches. They are: ${known.join(', ')}. Nothing was changed.`, 400, { field: unknown[0] });
  for (const k of ['pass_on', 'pass_on_copy', 'comments', 'members_stamps']) {
    const v = yesNo(b[k], k);
    if (v !== undefined) next[k] = v;
  }
  if (b.sign_ways !== undefined) {
    const list = Array.isArray(b.sign_ways) ? b.sign_ways.map((x: any) => String(x)) : null;
    const wrong = list?.find((x: string) => !(x in WAY_LABELS));
    if (!list || wrong !== undefined) throw bad(`Send "sign_ways" as a list of "type", "draw" and "upload"${wrong !== undefined ? `. "${str(wrong, 30)}" is not one of them` : ''}. Nothing was changed.`, 400, { field: 'sign_ways' });
    if (!list.length) throw bad('Keep at least one way of making a signature, or nobody could sign. Nothing was changed.', 400, { field: 'sign_ways' });
    next.sign_ways = waysOf(list.join(','));
  }
  if (b.mark_words !== undefined) {
    const w = str(b.mark_words, 200).replace(/\s+/g, ' ').trim();
    const no = markWordsProblem(w);
    if (no) throw bad(no, 400, { field: 'mark_words' });
    next.mark_words = markWords(w);
  }
  run('UPDATE accounts SET sw_pass_on=?, sw_pass_copy=?, sw_comments=?, sw_sign_ways=?, sw_stamps=?, sw_mark_words=? WHERE id=?',
    next.pass_on ? 1 : 0, next.pass_on_copy ? 1 : 0, next.comments ? 1 : 0, waysLimited(next.sign_ways) ? next.sign_ways.join(',') : null, next.members_stamps ? 1 : 0, next.mark_words === markWords(null) ? null : next.mark_words, accountId);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of known) if (JSON.stringify((was as any)[k]) !== JSON.stringify(next[k])) changed[k] = { from: (was as any)[k], to: next[k] };
  return changed;
}

/** One envelope's own switches from a request body: a draft, or one that is out (a change applies from now on). */
export function saveEnvelopeSwitches(e: any, b: any, actor: Actor) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON object with "pass_on", "pass_on_copy" or "comments", each true or false. Nothing was changed.');
  if (e.kind !== 'envelope') throw bad('These switches are kept for each envelope. A template takes the account\'s, under Settings, Sending. Nothing was changed.', 409);
  if (e.status !== 'draft' && e.status !== 'sent') throw bad('This envelope is no longer out for signing, so there is nothing left to switch. Nothing was changed.', 409);
  const known = ['pass_on', 'pass_on_copy', 'comments'];
  const unknown = Object.keys(b).filter((k) => !known.includes(k));
  if (unknown.length) throw bad(`"${unknown[0]}" is not one of these switches. They are: ${known.join(', ')}. Nothing was changed.`, 400, { field: unknown[0] });
  const was = envelopeSwitches(e);
  const next = { ...was };
  for (const k of known) {
    const v = yesNo(b[k], k);
    if (v !== undefined) (next as any)[k] = v;
  }
  run('UPDATE envelopes SET sw_pass_on=?, sw_pass_copy=?, sw_comments=? WHERE id=?', next.pass_on ? 1 : 0, next.pass_on_copy ? 1 : 0, next.comments ? 1 : 0, e.id);
  if (e.status === 'sent') {
    const said: string[] = [];
    if (was.pass_on !== next.pass_on) said.push(next.pass_on ? 'People may pass it to someone else again.' : 'People may no longer pass it to someone else.');
    if (was.pass_on_copy !== next.pass_on_copy) said.push(next.pass_on_copy ? 'Someone who passes it on keeps a copy.' : 'Someone who passes it on no longer keeps a copy.');
    if (was.comments !== next.comments) said.push(next.comments ? 'Questions and comments are allowed again.' : 'Questions and comments are off. What was written before can still be read.');
    if (said.length) audit(e.id, actor, 'Settings changed', said.join(' '));
  }
  return next;
}

// ---- 1. Pass it on ---------------------------------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const PASS_OFF = (sender: string) => `${cap(sender)} turned off passing this document to someone else, so it was not passed on. Nothing was changed. If someone else should sign, ask ${sender} to send it to the right person.`;

/** Refuses a hand-over when the sender switched it off. */
export function assertMayPassOn(e: any, senderName: string) {
  if (!envelopeSwitches(e).pass_on) throw bad(PASS_OFF(senderName), 403, { code: 'pass_on_off' });
}

/**
 * After a hand-over: the first person stays on the envelope as someone who gets a copy, when the sender chose that.
 * Not when the new person has the same address (one inbox gets one copy), and not for a group's member.
 */
export function keepFirstAsCopy(e: any, before: { id: string; name: string; email: string; routing_order: number; token?: string | null }, after: { email: string }, actor: Actor) {
  // Passed back to someone who was kept as a copy: they sign again, so they are not also on it as a copy.
  const back = after.email ? get("SELECT id, name, email FROM recipients WHERE envelope_id=? AND role='cc' AND kept_from IS NOT NULL AND lower(email)=lower(?)", e.id, after.email) : null;
  if (back) {
    run('DELETE FROM recipients WHERE id=?', back.id);
    audit(e.id, actor, 'No longer kept as a copy', `${back.name} <${back.email}> was passed the document again, so they sign it now instead of only getting a copy.`);
  }
  if (!envelopeSwitches(e).pass_on_copy || !before.email || String(before.email).toLowerCase() === String(after.email || '').toLowerCase()) return false;
  if (get("SELECT 1 FROM recipients WHERE envelope_id=? AND role='cc' AND lower(email)=lower(?)", e.id, before.email)) return false;
  const pos = (get('SELECT MAX(position) p FROM recipients WHERE envelope_id=?', e.id)?.p ?? 0) + 1;
  const t = now();
  // They already had the document, so their part is done: they get the signed copy with everyone else at the end.
  run("INSERT INTO recipients (id, envelope_id, role, name, email, routing_order, position, status, token, check_code, sent_at, completed_at, free, kept_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id('rcp'), e.id, 'cc', before.name, before.email, before.routing_order, pos, 'completed', token(), checkCode(), t, t, 1, before.token || '');
  audit(e.id, actor, 'Kept as a copy', `${before.name} <${before.email}> passed it on and stays on the envelope as someone who gets a copy, as the sender chose. They get the signed copy when everyone has finished.`);
  return true;
}

/** What the link of someone who passed it on and was kept as a copy says now: why it stopped, and what comes next. */
export const KEPT_COPY_LINK = 'You passed this document on to someone else, so this link no longer opens it. You are still on it as someone who gets a copy: the signed document is emailed to you when everyone has finished. There is nothing more for you to do.';
export function keptCopyLink(oldToken: string): boolean {
  return !!oldToken && !!get("SELECT 1 x FROM recipients WHERE kept_from=? AND role='cc'", oldToken);
}

// ---- 2. Questions and comments --------------------------------------------------------------------------------

export const COMMENTS_OFF = (sender: string) => `${cap(sender)} turned off questions and comments for this document, so this was not sent. What was written before can still be read. To ask ${sender} something, reply to the email you got about this document.`;
export const COMMENTS_OFF_SENDER = 'Questions and comments are off for this document, so a new conversation cannot be started on it. You can still answer one that was there before. Nothing was sent.';

export function assertSignerMayComment(e: any, senderName: string) {
  if (!envelopeSwitches(e).comments) throw bad(COMMENTS_OFF(senderName), 403, { code: 'comments_off' });
}

export function assertSenderMayStart(e: any, threadId: unknown) {
  if (threadId == null && !envelopeSwitches(e).comments) throw bad(COMMENTS_OFF_SENDER, 403, { code: 'comments_off' });
}

// ---- 3. Ways of making a signature ------------------------------------------------------------------------------

/**
 * Reads how the signature and initials were made from the Finish (or save) body, refuses a way the account does not
 * offer, and keeps what it says on the recipient. What a browser reports cannot be proved: the certificate says
 * "as the signing page reported".
 */
export function noteHow(e: any, r: any, b: any, finishing = false) {
  // Only while their part is open: a second Finish or a late save never changes what the record says of a signature.
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) return;
  const ways = waysFor(e);
  // With fewer ways than all three, Finish needs to be told how a new signature was made (the signing page always
  // says). Without that, the limit could be stepped around by leaving the answer out.
  if (finishing && waysLimited(ways))
    for (const [png, key, col, word] of [['signature_png', 'signature_how', 'sig_how', 'signature'], ['initials_png', 'initials_how', 'ini_how', 'initials']] as const)
      if (typeof b?.[png] === 'string' && b[png] && !howOf(b?.[key]) && !r[col])
        throw bad(`This document can be signed in these ways only: ${ways.map((w) => WAY_LABELS[w].toLowerCase()).join(', ')}. Make your ${word} again in one of them, then finish.`, 400, { code: 'sign_way_off', ways });
  const out: Record<string, string | null> = {};
  for (const [key, col] of [['signature_how', 'sig_how'], ['initials_how', 'ini_how']] as const) {
    if (b?.[key] === undefined) continue;
    const how = howOf(b[key]);
    const way = wayOfHow(how);
    if (way && way !== 'saved' && !ways.includes(way as SignWay)) throw bad(`This document can be signed in these ways only: ${ways.map((w) => WAY_LABELS[w].toLowerCase()).join(', ')}. Make your ${key === 'signature_how' ? 'signature' : 'initials'} again in one of them, then finish.`, 400, { code: 'sign_way_off', ways });
    if (way === 'saved' && waysLimited(ways)) throw bad(`This document can be signed in these ways only: ${ways.map((w) => WAY_LABELS[w].toLowerCase()).join(', ')}. Make your ${key === 'signature_how' ? 'signature' : 'initials'} again in one of them, then finish.`, 400, { code: 'sign_way_off', ways });
    out[col] = how;
  }
  if ('sig_how' in out) run('UPDATE recipients SET sig_how=? WHERE id=?', out.sig_how, r.id);
  if ('ini_how' in out) run('UPDATE recipients SET ini_how=? WHERE id=?', out.ini_how, r.id);
}

/** The certificate's lines for how one person's signature and initials were made. None when nothing was reported. */
export function howCertLines(r: any): [string, string][] {
  const out: [string, string][] = [];
  const sig = howText(r.sig_how);
  const ini = howText(r.ini_how);
  if (sig && r.signature_png) out.push(['Signature made', `${sig}, as their signing page reported`]);
  if (ini && r.initials_png) out.push(['Initials made', `${ini}, as their signing page reported`]);
  return out;
}

// ---- 4. Stamps ----------------------------------------------------------------------------------------------------

/**
 * A member of an account whose admins turned stamps off cannot place a new stamp field. Stamp fields already on the
 * envelope or the template it came from stay, and an envelope that is out is unchanged.
 */
export function assertStampsAllowed(c: { role: string; account: any }, b: any, e?: any) {
  if (c.role !== 'member' || on(acct(c.account.id).sw_stamps)) return;
  const had = new Set((e?.fields || []).filter((f: any) => f.type === 'stamp').map((f: any) => String(f.id)));
  const fields = [...(Array.isArray(b?.fields) ? b.fields : []), ...(Array.isArray(b?.documents) ? b.documents.flatMap((d: any) => (Array.isArray(d?.fields) ? d.fields : [])) : [])];
  if (fields.some((f: any) => f?.type === 'stamp' && !had.has(String(f.id)))) throw bad('Your admins have turned off stamps for members, so a stamp field cannot be added. Nothing was saved. Remove the stamp field, or ask an admin to add it.', 403, { code: 'stamps_off' });
}

export const membersMayStamp = (accountId: string) => on(acct(accountId).sw_stamps);

// ---- 5. Public forms: how many and until when --------------------------------------------------------------------

/** Who a visitor of a closed form can write to: the person whose template it is, else whoever gave them the link. */
function formContact(p: any): string {
  const u = get('SELECT u.name, u.email FROM envelopes t JOIN users u ON u.id=t.sender_id WHERE t.id=?', p.template_id);
  return u?.name && u?.email ? `write to ${u.name} at ${u.email}` : u?.name ? `ask ${u.name}` : 'ask whoever gave you this link';
}

/**
 * Why a form takes nobody new, in words for the visitor, or null. Counted: who signed, and who is filling it in now
 * (an unfinished start is cleared after a day without use, and then counts no more).
 */
export function formLimitClosed(p: any): string | null {
  if (p.closes_at && Date.parse(p.closes_at) <= Date.now()) return `This form closed on ${dayWords(formLastDay(p))} and takes no more signatures. If you still need to sign, ${formContact(p)}.`;
  if (p.max_signed) {
    const n = get("SELECT SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END) signed, SUM(CASE WHEN r.status!='completed' AND e.status='sent' AND r.status IN ('pending','sent','viewed') THEN 1 ELSE 0 END) going FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=?", p.id) || {};
    const signed = Number(n.signed || 0), going = Number(n.going || 0);
    if (signed >= p.max_signed) return `This form has taken as many signatures as it was set up for, so it is closed. If you still need to sign, ${formContact(p)}.`;
    if (signed + going >= p.max_signed) return `This form is full for now: the last places are taken by people who started filling it in and have not finished. If one of them stops, a place opens again within ${powerformIdleHours()} hours. If you need to sign soon, ${formContact(p)}.`;
  }
  return null;
}

/** The end of one day in a time zone, as a moment: the last millisecond before the next day starts there. */
export function endOfDayIn(day: string, tz: string | null): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  if (!tz) return new Date(target).toISOString();
  let t = target;
  // Two steps settle it, also on a day the clocks change.
  for (let i = 0; i < 2; i++) {
    const c = clockIn(new Date(t), tz);
    if (!c) break;
    const wall = Date.UTC(c.y, c.m, c.d, c.hh, c.mm, 59, 999);
    t += target - wall;
  }
  return new Date(t).toISOString();
}

/**
 * Reads "max_signed" (a whole number, or null for no limit) and "closes_at" (a day, or null) for PATCH
 * /powerforms/:id. A day is the end of that day in "tz" (a time zone such as "Europe/Berlin", sent by the Forms page),
 * or in UTC without one. Both are checked before either is written, so a refusal changes nothing.
 */
export function saveFormLimits(p: any, b: any) {
  let most: number | null | undefined;
  let close: { at: string | null; day: string | null } | undefined;
  if (b.max_signed !== undefined) {
    const n = b.max_signed === null || b.max_signed === '' ? null : Number(b.max_signed);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > FORM_LIMIT_MAX)) throw bad(`Send "max_signed" as a whole number from 1 to ${FORM_LIMIT_MAX}, or null for no limit. Nothing was changed.`, 400, { field: 'max_signed' });
    most = n;
  }
  if (b.closes_at !== undefined) {
    const d = b.closes_at === null || b.closes_at === '' ? null : String(b.closes_at).trim();
    const refuse = () => bad('Send "closes_at" as a day (2026-12-31) or null for no closing date. Nothing was changed.', 400, { field: 'closes_at' });
    if (d === null) close = { at: null, day: null };
    else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw refuse();
      if (b.tz !== undefined && b.tz !== null && b.tz !== '' && !validZone(b.tz)) throw bad('Send "tz" as a time zone such as "Europe/Berlin", or leave it out for UTC. Nothing was changed.', 400, { field: 'tz' });
      close = { at: endOfDayIn(d, validZone(b.tz)), day: d };
    } else {
      const t = Date.parse(d);
      if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(d)) throw refuse();
      close = { at: new Date(t).toISOString(), day: new Date(t).toISOString().slice(0, 10) };
    }
  }
  if (most !== undefined) run('UPDATE powerforms SET max_signed=? WHERE id=?', most, p.id);
  if (close) run('UPDATE powerforms SET closes_at=?, closes_day=? WHERE id=?', close.at, close.day, p.id);
}

// ---- 6. The words across an unfinished copy ----------------------------------------------------------------------

/** The two lines of the mark on a copy made while the envelope is still out. The small line never changes. */
export const unfinishedMark = (e: any): [string, string] => [markWords(e.sw_mark_words || acct(e.account_id).sw_mark_words), 'NOT EVERYONE HAS SIGNED'];
