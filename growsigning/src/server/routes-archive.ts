// Archive addresses: Settings, Records and data (src/components/settings/ArchiveSettings.tsx), the page an address confirms on
// (src/app/archive-confirm/page.tsx), and what the mail provider says about the copies. The copies themselves are made
// in mail.ts with archivemail.ts; the rules and the words are in src/lib/archivemail.ts.
//
//   GET    /account/archive-addresses        admins: every address and how it stands; members: how many take copies
//   POST   /account/archive-addresses        admins, a person signed in: add an address, or send its link again
//   DELETE /account/archive-addresses/:id    admins, a person signed in: remove one
//   GET    /public/archive-confirm?token=    what the link asks, for the page it opens (changes nothing)
//   POST   /public/archive-confirm           { token, answer: 'yes' | 'no' | 'undo' } from that page
//
// Nobody can archive into a stranger's inbox: nothing but the email that asks is sent to an address until someone
// with that inbox presses Confirm on the page, and a mail program that opens the link to check it changes nothing.
// The email that asks is kept short of a nuisance too: only a login with a confirmed address of its own can send it,
// only to one plain address, a few times a day for one inbox whatever its spelling ("+tag"), and never again for
// 30 days once the reader said no on the page or marked it as spam.
// An API key can read the list but not change it, because a leaked key that added its own address would receive the
// account's emails from then on. Every change is in the account's security record, and the owner and admins are
// emailed when an address starts taking copies, is removed, or is paused.
// What the person's role allows (perm.ts): 'settings' here, where this file once asked for an admin.
import { can } from './perm.ts';
import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, baseUrl, id, isEmail, now, rateLimit, sha256, str, token } from './util.ts';
import { sendMail, recordMail, deliverQueued, onMailOutcome } from './mail.ts';
import { hasNotPaid, nameRefusal, pausedText } from './envelopes.ts';
import { complainedAt } from './bounces.ts';
import { record } from './seclog.ts';
import { mailEventsOn } from '../lib/policy.ts';
import {
  ARCHIVE_MAX_ADDRESSES, ARCHIVE_BOUNCES_TO_PAUSE, ARCHIVE_CONFIRM_DAYS, ARCHIVE_ASKS_PER_DAY, ARCHIVE_ASKS_PER_ADDRESS_DAY,
  ARCHIVE_REFUSED_DAYS, ARCHIVE_UNDO_MINUTES, ARCHIVE_SPAM_STOP, ARCHIVE_WHAT, ARCHIVE_LIMITS, ARCHIVE_ADDED, ARCHIVE_NO, ARCHIVE_BAD_ADDRESS, ARCHIVE_TEAM_MEMBER,
  archiveMoment, archiveAddress, archiveKey,
} from '../lib/archivemail.ts';

const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString();
const admins = (accountId: string): { email: string; name: string }[] =>
  all("SELECT u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);

/** How one address stands, for Settings and the API. Never the link or its fingerprint. */
function view(a: any) {
  const state = a.paused_at ? 'paused' : a.confirmed_at ? 'confirmed' : a.confirm_until && a.confirm_until > now() ? 'waiting' : 'expired';
  return {
    id: a.id, email: a.email, state, added_at: a.added_at, added_by: a.added_by_name || null,
    link_sent_at: a.confirm_sent_at || null, link_works_until: a.confirm_hash && a.confirm_until > now() ? a.confirm_until : null,
    confirmed_at: a.confirmed_at || null, copies: a.copies, last_copy_at: a.last_copy_at || null,
    bounces: a.bounces, paused_at: a.paused_at || null, paused_why: a.paused_why || null, missed: a.missed,
    problem: a.problem || null, problem_at: a.problem_at || null,
  };
}

route('GET', '/account/archive-addresses', (c) => {
  const rows = all('SELECT * FROM archive_addresses WHERE account_id=? ORDER BY added_at', c.account.id);
  const taking = rows.filter((a) => a.confirmed_at && !a.paused_at).length;
  // A member, and a key with the "send" scope, learn only that copies go somewhere: the addresses are for admins.
  if (!can(c, 'settings') || (c.auth?.via === 'api_key' && c.auth.scope !== 'admin')) return { may_change: false, taking };
  const refused = all('SELECT email, at, until, why FROM archive_refused WHERE account_id=? AND until > ? ORDER BY at', c.account.id, now());
  return {
    may_change: c.auth?.via !== 'api_key', taking, max: ARCHIVE_MAX_ADDRESSES, addresses: rows.map(view),
    refused: refused.map((r) => ({ email: r.email, at: r.at, can_ask_again_at: r.until, why: r.why === 'spam' ? 'spam' : 'no' })),
    // Without news from the mail provider an address that stops working is not noticed here (routes-bounces.ts).
    bounce_news: mailEventsOn(), what: ARCHIVE_WHAT, limits: ARCHIVE_LIMITS,
  };
}, 'user');

// An API key can read the list but never change it: see the top of this file.
function person(c: Ctx, what: string) {
  if (c.auth?.via === 'api_key') throw bad(`An API key cannot ${what}. That needs a person signed in to the app, because an address added by a leaked key would get the account's emails.`, 403);
}

// The email that asks an address to confirm. It goes to an address someone typed, so it has the rules of a team
// invitation: a login with a confirmed address (checked by the route), none while paused, no name that reads like a
// brand or a notice while the checks apply to the account, and limits of its own per day, counted for the inbox
// (archiveKey) and not for one spelling of it. Its subject and its first words are ours: the names the account
// chose come later, in quotes and cut short, so a name written to alarm does not read as the email.
async function askToConfirm(c: Ctx, a: any): Promise<{ delivery: string; until: string }> {
  const account = get('SELECT * FROM accounts WHERE id=?', c.account.id);
  if (account.suspended_at) throw bad(pausedText(account), 403);
  // Names that read like a brand or a payment notice: refused while the checks apply to the account, and for any
  // other account left out of this email, which goes to someone who never asked for it. The sign-in address stays.
  const lure = nameRefusal([c.user?.name, account.name]);
  if (lure && hasNotPaid(account)) throw bad(lure, 422);
  const since = iso(Date.now() - DAY);
  run('DELETE FROM archive_asked WHERE at < ?', iso(Date.now() - 2 * DAY));
  const forAccount = get('SELECT COUNT(*) n, MIN(at) first FROM archive_asked WHERE account_id=? AND at > ?', account.id, since);
  const key = archiveKey(a.email);
  const forAddress = get('SELECT COUNT(*) n, MIN(at) first FROM archive_asked WHERE account_id=? AND email=? AND at > ?', account.id, key, since);
  const later = (first: string) => `You can send one again from ${archiveMoment(iso(Date.parse(first) + DAY))}.`;
  // Several strangers marked this account's asking email as spam: it asks nobody new for a while.
  // One mark for each inbox, oldest first. Asking works again once fewer than ARCHIVE_SPAM_STOP are younger than
  // ARCHIVE_REFUSED_DAYS: with n marks that is the day the (n - ARCHIVE_SPAM_STOP + 1)th oldest one ages out.
  const marks = all("SELECT MAX(at) at FROM archive_refused WHERE account_id=? AND why='spam' AND at > ? GROUP BY COALESCE(email_key, email) ORDER BY 1", account.id, iso(Date.now() - ARCHIVE_REFUSED_DAYS * DAY));
  const marked = { n: marks.length, first: marks.length >= ARCHIVE_SPAM_STOP ? marks[marks.length - ARCHIVE_SPAM_STOP].at : null };
  if (marked.n >= ARCHIVE_SPAM_STOP) throw bad(`${marked.n} people marked the email that asks an address to confirm as spam in the last ${ARCHIVE_REFUSED_DAYS} days, so this account cannot ask any address until ${archiveMoment(iso(Date.parse(marked.first) + ARCHIVE_REFUSED_DAYS * DAY))}. Addresses already confirmed keep getting their copies. Check that each address is typed right and expects the email before you add it then. Nothing was sent.`, 429, { code: 'asks_stopped' });
  if (forAddress.n >= ARCHIVE_ASKS_PER_ADDRESS_DAY) throw bad(`We have sent ${ARCHIVE_ASKS_PER_ADDRESS_DAY} emails asking ${a.email} to confirm in the last 24 hours, which is as many as we send to one inbox in a day. ${later(forAddress.first)} Meanwhile the newest link works: ask whoever reads that inbox to look for it, also among spam.`, 429);
  if (forAccount.n >= ARCHIVE_ASKS_PER_DAY) throw bad(`This account has sent ${ARCHIVE_ASKS_PER_DAY} emails asking addresses to confirm in the last 24 hours, which is as many as we send for one account in a day. ${later(forAccount.first)}`, 429);
  const tok = token();
  const until = iso(Date.now() + ARCHIVE_CONFIRM_DAYS * DAY);
  run('UPDATE archive_addresses SET confirm_hash=?, confirm_sent_at=?, confirm_until=? WHERE id=?', sha256(tok), now(), until, a.id);
  run('INSERT INTO archive_asked (account_id, email, at) VALUES (?,?,?)', account.id, key, now());
  const team = lure ? '' : `, "${str(account.name, 80)}",`;
  const who = `${!lure && str(c.user?.name, 80) ? `"${str(c.user?.name, 80)}", ` : 'someone '}signed in as ${c.user.email}`;
  const mid = recordMail({
    to: a.email, subject: 'Should this address get copies of a team\'s emails?', heading: 'Should this address get copies?',
    lines: [
      `A team that uses GrowSigning to get documents signed${team} asked us to send ${a.email} a copy of every email the team sends about its documents, with any signed PDF attached, for their records. The request was made by ${who}.`,
      `Nothing is sent here unless someone with this inbox confirms. The button opens a page that asks first. The link works until ${archiveMoment(until)}.`,
      `Did not expect this? Open the page and choose "${ARCHIVE_NO}", or do nothing.`,
    ],
    cta: { label: 'Open the request', url: `${baseUrl()}/archive-confirm?token=${tok}` },
    // To someone who may never have heard of us: the footer is the help address, with nothing that sells.
    expiresAt: until, brief: true, replyTo: c.user.email,
  });
  // Marked as this address's email, so news about it from the mail provider counts for the address (archiveNews)
  // and the timer asks archiveCheck before it tries again.
  run('UPDATE emails SET archive_to=?, archive_account=? WHERE id=?', a.id, account.id, mid);
  return { delivery: (await deliverQueued(mid)) || 'queued', until };
}

route('POST', '/account/archive-addresses', async (c) => {
  person(c, 'add an address that gets copies');
  const b = await c.body();
  // As for a team invitation: a login that has not confirmed its own address emails nobody.
  if (!c.user?.email_verified) throw bad('Confirm your own email address before you add an address here. Type the 6-digit code from our email at the top of the app, or press the button in that email. "Send a new code" there emails a new one. Nothing was added.', 403, { code: 'unconfirmed' });
  // One plain address: a name in front, brackets, quotes, a comma or a full stop at the end are other spellings of
  // an inbox, and the limits and a "no" from its reader must hold for the inbox.
  const email = archiveAddress(str(b.email, 300));
  if (!email || !isEmail(email)) throw bad(ARCHIVE_BAD_ADDRESS, 400, { code: 'bad_address' });
  const key = archiveKey(email);
  const refused = get('SELECT until, why FROM archive_refused WHERE account_id=? AND (email=? OR email_key=? OR email=?) AND until > ? ORDER BY until DESC', c.account.id, email, key, key, now());
  if (refused) throw bad(`Whoever reads ${email} ${refused.why === 'spam' ? 'marked the email that asked as spam' : 'said no to the copies'}, so this account cannot ask that inbox again until ${archiveMoment(refused.until)}. If that was a mistake, they can tell you, and you can add it again from then. Nothing was sent.`, 409, { code: 'refused' });
  // Someone who marked an email from this account as spam is not emailed by it, about this either.
  if (complainedAt(c.account.id, email) || complainedAt(c.account.id, key)) throw bad(`Whoever reads ${email} marked an earlier email from this account as spam, so we do not email that address for this account. Nothing was added and nothing was sent.`, 409, { code: 'marked_spam' });
  let a = get('SELECT * FROM archive_addresses WHERE account_id=? AND email=?', c.account.id, email);
  if (a?.confirmed_at && !a.paused_at) throw bad(`${email} is confirmed already and gets a copy of every email about this account's documents. Nothing was sent.`, 409, { code: 'confirmed' });
  let added = false;
  if (!a) {
    const n = get('SELECT COUNT(*) n FROM archive_addresses WHERE account_id=?', c.account.id).n;
    if (n >= ARCHIVE_MAX_ADDRESSES) throw bad(`This account already has ${ARCHIVE_MAX_ADDRESSES} addresses that get copies. Remove one first. Nothing was added.`, 409, { code: 'too_many' });
    const aid = id('arc');
    run('INSERT INTO archive_addresses (id, account_id, email, added_by, added_by_name, added_at) VALUES (?,?,?,?,?,?)', aid, c.account.id, email, c.user?.id || null, str(c.user?.name, 120) || null, now());
    a = get('SELECT * FROM archive_addresses WHERE id=?', aid);
    added = true;
  }
  let sent;
  try {
    sent = await askToConfirm(c, a);
  } catch (e) {
    // An address that was only just typed and could not be asked is not kept: nothing would ever confirm it.
    if (added) run('DELETE FROM archive_addresses WHERE id=?', a.id);
    throw e;
  }
  record('settings.changed', { c, about: ['archive_address', a.id], details: { settings: { archive_addresses: { changed: true } }, change: added ? 'added, waiting for confirmation' : 'link sent again' } });
  // Allowed, a one-person office keeps its own archive this way, but said: they get everything twice.
  const onTeam = !!get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND lower(u.email) IN (?,?)', c.account.id, email, key);
  return {
    ok: true, address: view(get('SELECT * FROM archive_addresses WHERE id=?', a.id)), delivery: sent.delivery, team_member: onTeam,
    message: `${sent.delivery === 'failed'
      ? `${email} is added, but our mail server would not take the email that asks it to confirm just now. It is tried again by itself. Nothing is sent there until it is confirmed.`
      : ARCHIVE_ADDED}${onTeam ? ` ${ARCHIVE_TEAM_MEMBER}` : ''}`,
  };
}, 'admin');

route('DELETE', '/account/archive-addresses/:id', async (c) => {
  person(c, 'remove an address that gets copies');
  const a = get('SELECT * FROM archive_addresses WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!a) throw bad('That address is not on this account any more. Nothing was changed.', 404);
  run('DELETE FROM archive_addresses WHERE id=?', a.id);
  record('settings.changed', { c, about: ['archive_address', a.id], details: { settings: { archive_addresses: { changed: true } }, change: 'removed' } });
  if (a.confirmed_at) await tellAdmins(c.account.id, `No more copies go to ${a.email}`, 'An address that got copies was removed', [
    `${str(c.user?.name, 120) || 'An admin'} removed ${a.email} from the addresses that get copies of the emails of ${c.account.name}. From now on it gets no copies of the team's emails about its documents. Copies that were waiting to go there are not sent.`,
    'If this was not meant, an admin can add it again in Settings, under "Copies of every email". It has to be confirmed from that inbox again.',
  ]);
  return { ok: true, message: `${a.email} is removed. It gets no more copies, also none that were waiting.` };
}, 'admin');

// ---- The page the link opens ---------------------------------------------------------------------------------

const byToken = (tok: any) => {
  const t = str(tok, 200).trim();
  return t ? get('SELECT a.*, acc.name account_name FROM archive_addresses a JOIN accounts acc ON acc.id=a.account_id WHERE a.confirm_hash=?', sha256(t)) : null;
};
const GONE = 'This link does not work any more. It was replaced by a newer one, the address was removed, or it was answered already. If copies should come here, ask the team that sent it to send the link again.';

route('GET', '/public/archive-confirm', (c) => {
  rateLimit(`archive-confirm:${c.ip}`, 60, 600_000);
  const a = byToken(c.q.get('token'));
  if (!a) throw bad(GONE, 404);
  const open = a.confirm_until > now();
  return {
    email: a.email, account: a.account_name, asked_by: a.added_by_name || null, asked_at: a.confirm_sent_at,
    state: a.confirmed_at && !a.paused_at ? 'confirmed' : open ? 'waiting' : 'expired', works_until: a.confirm_until, what: ARCHIVE_WHAT, limits: ARCHIVE_LIMITS, refused_days: ARCHIVE_REFUSED_DAYS,
  };
}, 'public');

route('POST', '/public/archive-confirm', async (c) => {
  rateLimit(`archive-confirm:${c.ip}`, 60, 600_000);
  const b = await c.body();
  const answer = str(b.answer, 10);
  if (answer === 'undo') return undoRefusal(b.token);
  if (answer !== 'yes' && answer !== 'no') throw bad(`Choose Confirm or "${ARCHIVE_NO}". Nothing was changed.`);
  const a = byToken(b.token);
  if (!a) throw bad(GONE, 404);
  if (a.confirm_until <= now()) throw bad(`This link ran out on ${archiveMoment(a.confirm_until)}, so nothing was changed. If copies should come here, ask ${a.account_name} to send the link again.`, 410);
  if (answer === 'no') {
    refuse(a, 'no');
    return { ok: true, state: 'refused', message: `Done. Nothing is sent to ${a.email}, and ${a.account_name} cannot ask this address again for ${ARCHIVE_REFUSED_DAYS} days.`, undo_minutes: ARCHIVE_UNDO_MINUTES };
  }
  if (a.confirmed_at && !a.paused_at) return { ok: true, state: 'confirmed', message: `${a.email} was confirmed already. Copies keep coming here.` };
  const again = !!a.confirmed_at;
  run('UPDATE archive_addresses SET confirmed_at=?, confirm_hash=NULL, confirm_until=NULL, paused_at=NULL, paused_why=NULL, bounces=0, missed=0, problem=NULL, problem_at=NULL WHERE id=?', now(), a.id);
  record('settings.changed', { accounts: a.account_id, by: { type: 'system' }, about: ['archive_address', a.id], details: { settings: { archive_addresses: { changed: true } }, change: again ? 'confirmed again, copies resume' : 'confirmed, copies start' } });
  await tellAdmins(a.account_id, `Copies of your team's emails now go to ${a.email}`, 'An address was confirmed for copies', [
    `${a.email} was ${again ? 'confirmed again' : 'confirmed'} from its own inbox. From now on it gets a copy of every email ${a.account_name} sends about its documents, with signing links, security codes and one-time codes taken out.${a.added_by_name ? ` ${a.added_by_name} added it.` : ''}`,
    'If nobody on your team meant this, remove it in Settings, under "Copies of every email", at once: copies carry the names, messages and signed PDFs of your documents.',
  ]);
  return { ok: true, state: 'confirmed', message: `Confirmed. From now on ${a.email} gets a copy of every email ${a.account_name} sends about its documents. Copies of emails sent before now do not come.` };
}, 'public');

// "No" from whoever reads the address, by the button on the page or by marking the email that asked as spam: the
// address goes, and the account cannot ask that inbox, in any spelling, for ARCHIVE_REFUSED_DAYS. A spam mark keeps
// no link, so only the button can be taken back.
function refuse(a: any, why: 'no' | 'spam') {
  tx(() => {
    run('INSERT OR REPLACE INTO archive_refused (account_id, email, email_key, why, at, until, token_hash, added_by, added_by_name, added_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      a.account_id, a.email, archiveKey(a.email), why, now(), iso(Date.now() + ARCHIVE_REFUSED_DAYS * DAY), why === 'no' ? a.confirm_hash : null, a.added_by, a.added_by_name, a.added_at);
    run('DELETE FROM archive_addresses WHERE id=?', a.id);
  });
  record('settings.changed', { accounts: a.account_id, by: { type: 'system' }, about: ['archive_address', a.id], details: { settings: { archive_addresses: { changed: true } }, change: why === 'spam' ? 'the email that asked was marked as spam: removed, not asked again for 30 days' : 'refused by whoever reads the address' } });
}

// "No" pressed by mistake: the same page can take it back for a while, with the same link.
function undoRefusal(tok: any) {
  const t = str(tok, 200).trim();
  const r = t ? get('SELECT f.*, acc.name account_name FROM archive_refused f JOIN accounts acc ON acc.id=f.account_id WHERE f.token_hash=? AND f.at > ?', sha256(t), iso(Date.now() - ARCHIVE_UNDO_MINUTES * 60_000)) : null;
  if (!r) throw bad(`That can only be taken back within ${ARCHIVE_UNDO_MINUTES} minutes, from the page where it was pressed. Nothing was changed. Ask the team to add this address again once they can.`, 410);
  if (get('SELECT COUNT(*) n FROM archive_addresses WHERE account_id=?', r.account_id).n >= ARCHIVE_MAX_ADDRESSES) throw bad(`${r.account_name} has ${ARCHIVE_MAX_ADDRESSES} addresses that get copies now, which is the most, so this one cannot come back. Nothing was changed.`, 409);
  const aid = id('arc');
  tx(() => {
    run('INSERT INTO archive_addresses (id, account_id, email, added_by, added_by_name, added_at, confirm_hash, confirm_sent_at, confirm_until) VALUES (?,?,?,?,?,?,?,?,?)',
      aid, r.account_id, r.email, r.added_by, r.added_by_name, r.added_at || now(), r.token_hash, r.at, iso(Date.now() + DAY));
    run('DELETE FROM archive_refused WHERE account_id=? AND email=?', r.account_id, r.email);
  });
  return { ok: true, state: 'waiting', message: 'Taken back. Nothing is sent here yet: press Confirm if this address should get the copies.' };
}

// ---- The owner and the admins ------------------------------------------------------------------------------------

async function tellAdmins(accountId: string, subject: string, heading: string, lines: string[]) {
  for (const u of admins(accountId))
    await sendMail({ to: u.email, subject, heading, lines, cta: { label: 'Open Settings', url: `${baseUrl()}/app/settings?tab=data` } }).catch((e) => console.error('[archive] could not tell an admin', e?.message));
}

async function pause(a: any, why: 'bounced' | 'spam') {
  if (!run('UPDATE archive_addresses SET paused_at=?, paused_why=? WHERE id=? AND paused_at IS NULL', now(), why, a.id).changes) return;
  const account = get('SELECT name FROM accounts WHERE id=?', a.account_id);
  await tellAdmins(a.account_id, `Copies to ${a.email} are paused`, 'Copies to an address are paused', [
    why === 'spam'
      ? `Whoever reads ${a.email} marked one of the copies of your team's emails as spam, so no more copies go there.`
      : `${ARCHIVE_BOUNCES_TO_PAUSE} copies of your team's emails to ${a.email} came back, with none arriving in between, so no more copies go there. The address may be mistyped, full or closed.`,
    `Emails about ${account?.name || 'your'} documents are not copied there while it is paused, and they are not sent later. Check with whoever reads it first, then choose "Send the link again" in Settings, under "Copies of every email". Copies start again once it is confirmed from that inbox.`,
  ]);
}

/**
 * News from the mail provider about a copy, or about the email that asks an address to confirm (routes-bounces.ts).
 * It counts for the archive address and nothing else: no recipient, no login and no do-not-mail list is marked, and
 * nothing counts as a report against the account (as for a team invitation marked as spam). A spam mark on the
 * email that asked is a "no" for 30 days (refuse); one on a copy pauses the copies.
 */
export async function archiveNews(m: any, ev: { type: string }, at: string): Promise<'applied' | 'repeat'> {
  const a = get('SELECT * FROM archive_addresses WHERE id=?', m.archive_to);
  if (ev.type === 'delivered') {
    if (m.delivered_at) return 'repeat';
    run("UPDATE emails SET delivered_at=?, bounce_kind=CASE WHEN bounce_kind='soft' THEN NULL ELSE bounce_kind END WHERE id=?", at, m.id);
    // An email that arrives is the proof that the address works: copies that came back before it no longer count.
    if (a && m.bounce_kind !== 'hard' && (!a.last_bounce_at || a.last_bounce_at <= (m.tried_at || m.at))) run('UPDATE archive_addresses SET bounces=0 WHERE id=?', a.id);
    return 'applied';
  }
  if (ev.type === 'complaint') {
    if (m.complained_at) return 'repeat';
    run('UPDATE emails SET complained_at=? WHERE id=?', at, m.id);
    // The email that asked, marked as spam: that is a "no". No copy ever went there, so nothing is paused, and
    // the admins read it in Settings like any other "no". A copy marked as spam pauses the copies.
    // An address removed before the mark arrived still counts for the account that asked, or removing each
    // address at once would keep every mark out of the stop (ARCHIVE_SPAM_STOP).
    if (!m.archive_envelope && (a || (m.archive_account && get('SELECT 1 x FROM accounts WHERE id=?', m.archive_account)))) refuse(a || { id: m.archive_to, account_id: m.archive_account, email: m.to_email, confirm_hash: null, added_by: null, added_by_name: null, added_at: null }, 'spam');
    else if (a) await pause(a, 'spam');
    return 'applied';
  }
  if (ev.type === 'bounce') {
    if (m.bounce_kind === 'hard') return 'repeat';
    run("UPDATE emails SET bounced_at=?, bounce_kind='hard', bounce_reason=? WHERE id=?", at, 'the address does not take email', m.id);
    if (!a) return 'applied';
    run('UPDATE archive_addresses SET bounces=bounces+1, last_bounce_at=?, problem=?, problem_at=? WHERE id=?', at, m.archive_envelope ? 'A copy came back: the address does not take email.' : 'The email asking it to confirm came back: the address does not take email.', at, a.id);
    if (a.bounces + 1 >= ARCHIVE_BOUNCES_TO_PAUSE && a.confirmed_at) await pause(a, 'bounced');
    return 'applied';
  }
  // "Try later", or the provider did not send it because of a setting there: noted on the email, nothing more.
  if (m.bounce_kind || m.delivered_at) return 'repeat';
  run("UPDATE emails SET bounced_at=?, bounce_kind='soft', bounce_reason=? WHERE id=?", at, ev.type === 'not_sent' ? 'our mail provider did not send it, because of a setting on our side' : 'not delivered yet, the receiving mail server said to try later', m.id);
  return 'applied';
}

// A copy our mail server would not take after the last try: said on its address in Settings. It does not count
// towards the pause, because a mail server of ours that is down for a day says nothing about the address.
onMailOutcome('archive', (m, what) => {
  if (what !== 'gave_up' || !m?.id) return;
  const row = get('SELECT archive_to, archive_envelope FROM emails WHERE id=?', m.id);
  if (row?.archive_to) run('UPDATE archive_addresses SET problem=?, problem_at=? WHERE id=?', row.archive_envelope ? 'A copy could not be handed to our mail server after every try, so it did not go.' : 'The email asking it to confirm could not be handed to our mail server after every try.', now(), row.archive_to);
});
