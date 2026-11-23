import { all, get, run, tx } from './db.ts';
import { hmac, id, now, baseUrl, shortCode, token } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { creditsEnabled, grant, takeBackGift } from './credits.ts';
import { sendMail } from './mail.ts';
import { isDeploymentBilling } from '../lib/billingmode.ts';
import { PRICING } from '../lib/impact.ts';
import { expiryMoment } from '../lib/policy.ts';
import { referralRulesFrom, referralOfferOn, referralPath, isReferralCode, normalEmail, normalPhone, REFERRAL_CODE_LENGTH, REFERRAL_REFUSALS, type ReferralRefusal, type ReferralRules } from '../lib/referral.ts';
import { smsProvider } from '../lib/checks.ts';
import { onSessionUse } from './sessionuse.ts';
import type { Ctx } from './router.ts';

// Invite a friend (the rules and the words are in src/lib/referral.ts).
//
//   1. Every account has one invite link, <site>/r/<code>. Whoever opens it lands on the sign-up page, and their
//      browser keeps the code in a cookie for 30 days, so it also counts when they sign up with Google or Microsoft.
//   2. A sign-up through the link writes one line in `referrals` (pending, or refused with the reason). Nothing is
//      given yet.
//   3. The reward lands once the friend's account is real: their email address is confirmed, they gave a phone
//      number (where the server asks for one), and somebody has signed a document they sent (a signature that
//      counted, not their own). Then the inviting account and the friend's account each get the free signatures, as
//      a lot of their own that expires like the trial's (credits.ts, source "referral"). The owner of the inviting
//      account gets one email.
//   4. Nobody is rewarded for inviting themselves: the same mailbox, the same phone number, the same account, a
//      browser or an internet address the inviting account was used from. The browser and address of an account
//      are noted whenever a person uses it signed in (once a day at most), and a reward waits while the inviting
//      account has none on record. The signature that makes the friend real is one by somebody else: not the
//      friend, not a member of the inviting account, not from an address the inviting account uses, not in person.
//      One reward per friend, and a limit per month and in total for each inviting account. A friend who was
//      promised the reward while the link was open still gets theirs when the inviter has reached a limit since,
//      up to the same limits again.
//   5. When the friend's account is paused for abuse, what is left of both rewards is taken back.
// Nothing is emailed in anybody's name: the inviter passes the link on themselves.

export const referralSettings = (): ReferralRules => referralRulesFrom(process.env);
// Signatures are only counted with a payment provider connected, and never on a server under a yearly agreement
// (BILLING_MODE=deployment). Where nothing is counted there is nothing to give, so nothing is offered. REFERRALS=0
// switches the offer off on its own.
export const referralsOn = (): boolean => creditsEnabled() && !isDeploymentBilling() && referralOfferOn(process.env);

const DAY = 864e5;
const REF_COOKIE = 'gs_ref';
const DEVICE_COOKIE = 'gs_dev';
const REF_COOKIE_DAYS = 30;
// How long the browsers and internet addresses of an account are remembered for the rule against inviting yourself.
const DEVICE_KEEP_DAYS = 90;
const SAME_IP_HOURS = 24;

const mark = (kind: string, value: string) => hmac(`referral:${kind}:${value}`);
const friendMark = (email: string) => mark('email', normalEmail(email));
// An address we cannot tell apart (no proxy in front) says nothing about who is who, so it never counts as "the same".
const ipMark = (ip: string) => (ip && ip !== 'unknown' ? mark('ip', ip) : '');

/**
 * The phone number of a login, as the keyed fingerprint sign-up keeps of it (users.phone_key, src/server/signuprules.ts),
 * or '' when the login gave none. The number itself can be encrypted at rest, so two logins are compared by this
 * fingerprint and never by the number. A row that has a plain number and no fingerprint (written by hand) is read too.
 */
export function phoneKey(u: any): string {
  if (!u) return '';
  if (typeof u.phone_key === 'string' && u.phone_key) return u.phone_key;
  return typeof u.phone === 'string' && /^\+?[\d\s().-]{6,24}$/.test(u.phone) && normalPhone(u.phone).length >= 6 ? mark('phone', normalPhone(u.phone)) : '';
}
// A server that does not ask its people for a phone number (SIGNUP_PHONE=off) cannot wait for one. The same rule as
// phoneRequired in src/server/signuprules.ts, written out here because that file registers routes when it loads and
// this one is loaded on the way to the router (tests/referrals.test.ts holds the two together).
export function phoneAsked(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.SIGNUP_PHONE ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(v)) return false;
  if (['required', 'on', '1', 'true', 'yes'].includes(v)) return true;
  return !isDeploymentBilling(env as any);
}

// ---- The link ----------------------------------------------------------------------------------------------------

/** The invite code of an account, made the first time it is asked for. */
export function codeOf(accountId: string): string {
  const have = get('SELECT code FROM referral_codes WHERE account_id=?', accountId)?.code;
  if (have) return have;
  for (let i = 0; i < 20; i++) {
    const code = shortCode(REFERRAL_CODE_LENGTH).toLowerCase();
    if (run('INSERT OR IGNORE INTO referral_codes (account_id, code, created_at) VALUES (?,?,?)', accountId, code, now()).changes) return code;
    const mine = get('SELECT code FROM referral_codes WHERE account_id=?', accountId)?.code;
    if (mine) return mine;
  }
  throw new Error('Could not make an invite code.');
}
export const inviteUrl = (code: string) => `${baseUrl()}${referralPath(code)}`;

const monthStart = () => `${now().slice(0, 7)}-01T00:00:00.000Z`;
/** How many friends an inviting account was rewarded for, this calendar month (UTC) and ever. */
export function rewardedCounts(accountId: string) {
  const row = get(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN decided_at >= ? THEN 1 ELSE 0 END), 0) month
    FROM referrals WHERE inviter_account_id=? AND inviter_got > 0`, monthStart(), accountId);
  return { total: Number(row?.total) || 0, month: Number(row?.month) || 0 };
}
/** Whether this account's link still earns its owner anything: under both limits, and not paused or being closed. */
function linkOpen(account: any): boolean {
  if (!account || account.suspended_at || account.closing_at) return false;
  const r = referralSettings();
  const n = rewardedCounts(account.id);
  return n.total < r.total_max && n.month < r.monthly_max;
}
const accountOfCode = (code: unknown) => (isReferralCode(code) ? get('SELECT a.* FROM referral_codes c JOIN accounts a ON a.id=c.account_id WHERE c.code=?', code) : null);

/**
 * The sign-up page asks whether a code is one of ours (GET /public/referrals/:code). When it is, and the offer is on,
 * the browser keeps the code for 30 days. The answer never says whose link it is.
 */
export function lookAtCode(c: Ctx, code: string): { ok: boolean; signatures: number; expiry_days: number } {
  const r = referralSettings();
  const ok = referralsOn() && linkOpen(accountOfCode(code));
  if (ok) c.cookies.push(cookie(REF_COOKIE, promise(code, Date.now() + REF_COOKIE_DAYS * DAY), REF_COOKIE_DAYS * 86400, c.secure));
  // Shown nothing, promised nothing: an older promise in this browser ends with this look.
  else if (readCookie(c.req, REF_COOKIE)) c.cookies.push(cookie(REF_COOKIE, '', 0, c.secure));
  return { ok, signatures: r.signatures, expiry_days: r.expiry_days };
}
// What the browser keeps after the sign-up page showed the promise: the code, until when, and our seal on both. So
// a sign-up can tell "this browser was promised the reward while the link was open" from a code somebody typed.
const promise = (code: string, until: number) => `${code}.${until.toString(36)}.${hmac(`referral-promise:${code}:${until}`).slice(0, 24)}`;
/** The code this browser was promised a reward for, or '' (no cookie, not ours, or older than 30 days). */
function promisedCode(c: Ctx): string {
  const [code, untilText, seal] = String(readCookie(c.req, REF_COOKIE) || '').split('.');
  const until = parseInt(untilText || '', 36);
  return isReferralCode(code) && seal && until > Date.now() && promise(code, until) === `${code}.${untilText}.${seal}` ? code : '';
}

// ---- Browsers and internet addresses, as fingerprints ----------------------------------------------------------------

/** The fingerprint of this browser: a random cookie it keeps for a year. Made here when it has none. */
function deviceOf(c: Ctx): string {
  let d = readCookie(c.req, DEVICE_COOKIE) || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(d)) {
    d = token(18);
    c.cookies.push(cookie(DEVICE_COOKIE, d, 365 * 86400, c.secure));
  }
  return mark('device', d);
}
/** Notes that this account was used from this browser and this internet address just now. */
export function noteDevice(c: Ctx, accountId: string) {
  // Only a person in a browser: an API key keeps no cookie, so every call of one would look like a new browser.
  if (!referralsOn() || !accountId || c.auth?.via === 'api_key') return;
  const t = now();
  // first_at: when this browser at this address was first seen with the account; at: when last. Both matter for
  // "the same internet address within a day".
  run('INSERT INTO referral_devices (account_id, device, ip, at, first_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id, device, ip) DO UPDATE SET at=excluded.at, first_at=COALESCE(first_at, at)', accountId, deviceOf(c), ipMark(c.ip), t, t);
}
// Every use of an account by a person signed in notes the browser and the address, once a day for each (the
// router calls this). Before, only sign-up and the invite card did, so an account older than 90 days, or one that
// took its link from an email, had nothing on record to compare a "friend" with.
const seenToday = new Map<string, string>();
onSessionUse('referrals', (c: Ctx) => {
  if (!c.account?.id || !referralsOn()) return;
  const day = now().slice(0, 10);
  const key = `${c.account.id}|${readCookie(c.req, DEVICE_COOKIE) || ''}|${c.ip}`;
  if (seenToday.get(key) === day && readCookie(c.req, DEVICE_COOKIE)) return;
  if (seenToday.size > 20000) seenToday.clear();
  seenToday.set(key, day);
  noteDevice(c, c.account.id);
});

// ---- A sign-up through a link ------------------------------------------------------------------------------------------

const refuse = (why: ReferralRefusal) => why;

/** Why this friend can never count for this inviting account, from what is known about both right now. */
function whyNot(inviter: any, friend: { userId: string; accountId: string; email: string; at: string }): ReferralRefusal | null {
  if (inviter.id === friend.accountId || get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', inviter.id, friend.userId)) return refuse('same_account');
  const members = all('SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=?', inviter.id);
  const me = normalEmail(friend.email);
  if (members.some((u) => normalEmail(u.email) === me)) return refuse('same_email');
  const phone = phoneKey(get('SELECT * FROM users WHERE id=?', friend.userId));
  if (phone && members.some((u) => phoneKey(u) === phone)) return refuse('same_phone');
  // The friend's browser or internet address at sign-up against every one the inviting account was used from: the
  // same browser at any time, the same internet address within a day before or after.
  const mine = all('SELECT device, ip, at, COALESCE(first_at, at) first_at FROM referral_devices WHERE account_id=?', friend.accountId);
  const theirs = all('SELECT device, ip, at, COALESCE(first_at, at) first_at FROM referral_devices WHERE account_id=?', inviter.id);
  if (mine.some((m) => theirs.some((t) => t.device === m.device))) return refuse('same_device');
  // Each line says from when until when an account was seen at an address. Two accounts were at the same address
  // "within a day" when those stretches come within 24 hours of each other.
  const slack = SAME_IP_HOURS * 3600_000;
  const near = (m: any, t: any) => Date.parse(m.first_at) <= Date.parse(t.at) + slack && Date.parse(t.first_at) <= Date.parse(m.at) + slack;
  if (mine.some((m) => m.ip && theirs.some((t) => t.ip === m.ip && near(m, t)))) return refuse('same_ip');
  return null;
}

/**
 * Called once for every new login with a workspace of its own (createLogin in routes-account.ts), after it exists.
 * Notes the browser, and when the browser carries an invite code, writes the line that says who invited whom.
 * `welcomedBefore`: the address had a login here before (routes-trust.ts wasWelcomed), so this is not a new friend.
 * The answer says whether the invite counts so far, for the tests; the person who signed up is told nothing more
 * than the sign-up page already said.
 */
export function noteSignup(c: Ctx, user: { id: string; email: string }, accountId: string, o: { ref?: unknown; welcomedBefore?: boolean } = {}): 'none' | 'pending' | 'refused' {
  if (!referralsOn()) return 'none';
  noteDevice(c, accountId);
  const promised = promisedCode(c);
  const code = isReferralCode(o.ref) ? o.ref : promised;
  // The code is used up by this sign-up, whatever comes of it.
  if (readCookie(c.req, REF_COOKIE)) c.cookies.push(cookie(REF_COOKIE, '', 0, c.secure));
  const inviter = accountOfCode(code);
  if (!inviter) return 'none';
  const at = now();
  const r = referralSettings();
  const counts = rewardedCounts(inviter.id);
  // A link at its limit promises nothing, so a sign-up through it is no invite. The one exception is a browser that
  // was shown the promise while the link was open (the sealed cookie): that friend is kept, and rewardOne decides.
  const why: ReferralRefusal | null = inviter.suspended_at || inviter.closing_at ? 'inviter_closed'
    : !linkOpen(inviter) && promised !== code ? (counts.total >= r.total_max ? 'total_limit' : 'monthly_limit')
    : o.welcomedBefore || get("SELECT 1 x FROM referrals WHERE friend_mark=? AND status IN ('rewarded','taken_back')", friendMark(user.email)) ? 'welcomed_before'
    : whyNot(inviter, { userId: user.id, accountId, email: user.email, at });
  const made = run('INSERT OR IGNORE INTO referrals (id, inviter_account_id, friend_user_id, friend_account_id, friend_mark, status, reason, at, decided_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id('ref'), inviter.id, user.id, accountId, friendMark(user.email), why ? 'refused' : 'pending', why || '', at, why ? at : null).changes;
  return !made ? 'none' : why ? 'refused' : 'pending';
}

// ---- The reward ----------------------------------------------------------------------------------------------------------

const lotRef = (side: 'invite' | 'friend', referralId: string) => `${side}:${referralId}`;
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
const logLine = (accountId: string, what: string, ref: string, detail: string) =>
  run('INSERT INTO billing_log (account_id, at, what, ref, detail) VALUES (?,?,?,?,?)', accountId, now(), what, ref, detail);

/**
 * Whether somebody else has signed a document the friend sent. "Somebody else" for the reward is stricter than for
 * paying: not an address of the friend's own account (a document sent to yourself under another name), not an
 * address of the inviting account (the inviter signing their "friend's" document), not from an internet address the
 * inviting account is used from, and not in person on the friend's own device.
 */
function signedBySomeoneElse(row: any): boolean {
  const members = (accountId: string) => all('SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=?', accountId).map((u) => normalEmail(u.email));
  const own = new Set([...members(row.friend_account_id), ...members(row.inviter_account_id)]);
  const theirIps = new Set(all("SELECT DISTINCT ip FROM referral_devices WHERE account_id=? AND ip != ''", row.inviter_account_id).map((d) => d.ip));
  // The ledger line of a signature is named "<recipient id>|<address>|..." (sigRef in credits.ts).
  for (const line of all("SELECT ref FROM credits WHERE account_id=? AND reason='signature' ORDER BY id LIMIT 200", row.friend_account_id)) {
    const [recipientId, email] = String(line.ref).split('|');
    if (own.has(normalEmail(email))) continue;
    const rcp = get('SELECT role, email, ip FROM recipients WHERE id=?', recipientId);
    if (rcp && (rcp.role === 'inperson' || own.has(normalEmail(rcp.email)) || (ipMark(String(rcp.ip || '')) && theirIps.has(ipMark(String(rcp.ip)))))) continue;
    return true;
  }
  return false;
}
/**
 * Whether the friend's account is real yet: a confirmed address, a phone number (confirmed by a code where this
 * server sends text messages, so a made-up number is not enough), and a signature by somebody else.
 */
function friendReady(row: any): { user: any; ready: boolean } {
  const user = get('SELECT * FROM users WHERE id=?', row.friend_user_id);
  const phoneOk = !phoneAsked() || (!!phoneKey(user) && (!smsProvider() || !!user?.phone_verified_at));
  return { user, ready: !!user && !!user.email_verified && phoneOk && signedBySomeoneElse(row) };
}

/**
 * Looks at every invite that is still waiting, for one account (as the inviter or as the friend) or for all of them,
 * and gives the rewards that are due. Safe to call as often as anyone likes: a reward is one ledger line per side,
 * and the same line can never be written twice. The answer is how many friends were rewarded.
 */
export async function settleReferrals(accountId?: string): Promise<number> {
  if (!referralsOn()) return 0;
  const rows = accountId
    ? all("SELECT * FROM referrals WHERE status='pending' AND (inviter_account_id=? OR friend_account_id=?) ORDER BY at", accountId, accountId)
    : all("SELECT * FROM referrals WHERE status='pending' ORDER BY at LIMIT 500");
  let done = 0;
  for (const row of rows) {
    const mail = tx(() => rewardOne(row.id));
    if (!mail) continue;
    done++;
    if (mail.to) await sendMail(mail.mail).catch(() => {});
  }
  return done;
}

// One invite, inside a transaction. Null when nothing was given (not ready yet, or refused for good).
function rewardOne(referralId: string): { to: string | null; mail: any } | null {
  const row = get("SELECT * FROM referrals WHERE id=? AND status='pending'", referralId);
  if (!row) return null;
  const { user, ready } = friendReady(row);
  const friendAccount = get('SELECT * FROM accounts WHERE id=?', row.friend_account_id);
  const inviter = get('SELECT * FROM accounts WHERE id=?', row.inviter_account_id);
  const t = now();
  const refused = (why: ReferralRefusal) => void run("UPDATE referrals SET status='refused', reason=?, decided_at=? WHERE id=?", why, t, row.id);
  // A friend whose login or workspace is gone can never become real.
  if (!user || !friendAccount) return refused('friend_closed'), null;
  if (friendAccount.suspended_at) return refused('friend_closed'), null;
  if (!inviter || inviter.suspended_at || inviter.closing_at) return refused('inviter_closed'), null;
  if (!ready) return null;
  // Nothing is known yet about where the inviting account is used from (it has not been opened for 90 days, or
  // never since this was built): the reward waits until a person signs in to it, and is decided then.
  if (!get('SELECT 1 x FROM referral_devices WHERE account_id=? LIMIT 1', inviter.id)) return null;
  // Decided again with what is known now: the phone number, and every browser and address noted since sign-up.
  const why = whyNot(inviter, { userId: user.id, accountId: friendAccount.id, email: user.email, at: row.at });
  if (why) return refused(why), null;
  const pm = phoneKey(user) || null;
  if (pm && get("SELECT 1 x FROM referrals WHERE phone_mark=? AND id != ? AND status IN ('rewarded','taken_back')", pm, row.id)) return refused('phone_used'), null;
  const r = referralSettings();
  const counts = rewardedCounts(inviter.id);
  // At a limit, of the month or in all: the friend was promised theirs and gets it; the inviting account gets none
  // for this friend, and the record says why. Friends rewarded this way have the same two limits of their own, so
  // a link cannot hand out signatures without end.
  const inviterGets = counts.total < r.total_max && counts.month < r.monthly_max ? r.signatures : 0;
  if (!inviterGets) {
    const only = get(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN decided_at >= ? THEN 1 ELSE 0 END), 0) month
      FROM referrals WHERE inviter_account_id=? AND inviter_got = 0 AND friend_got > 0`, monthStart(), inviter.id);
    if (Number(only?.total) >= r.total_max) return refused('total_limit'), null;
    if (Number(only?.month) >= r.monthly_max) return refused('monthly_limit'), null;
  }
  grant(friendAccount.id, r.signatures, 'referral', lotRef('friend', row.id), t);
  if (inviterGets) grant(inviter.id, inviterGets, 'referral', lotRef('invite', row.id), t);
  run("UPDATE referrals SET status='rewarded', reason=?, decided_at=?, phone_mark=?, inviter_got=?, friend_got=? WHERE id=?", inviterGets ? '' : `The inviting account had reached its limit of rewarded friends ${counts.total >= r.total_max ? 'in all' : 'for the month'}, so only the friend was rewarded.`, t, pm, inviterGets, r.signatures, row.id);
  const until = expiryMoment(new Date(Date.parse(t) + r.expiry_days * DAY).toISOString());
  logLine(friendAccount.id, 'referral', row.id, `${sigs(r.signatures)} added for joining through a friend's invite link. They expire on ${until}.`);
  if (!inviterGets) return { to: null, mail: null };
  logLine(inviter.id, 'referral', row.id, `${sigs(inviterGets)} added because a friend you invited had their first document signed. They expire on ${until}.`);
  const owner = get("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role='owner' AND u.closing_at IS NULL ORDER BY m.created_at LIMIT 1", inviter.id);
  const code = get('SELECT code, mail_off FROM referral_codes WHERE account_id=?', inviter.id);
  if (!owner || !code || code.mail_off) return { to: null, mail: null };
  const left = Math.max(0, Math.min(r.total_max - counts.total - 1, r.monthly_max - counts.month - 1));
  return { to: owner.email, mail: {
    to: owner.email, subject: `Your friend signed their first document: ${sigs(inviterGets)} for you`, heading: 'Your invite worked',
    lines: [
      `Your friend signed their first document. You both got ${r.signatures} free signatures.`,
      `They are in your account now and last until ${until}. Each one plants ${PRICING.treesPerSignature} trees.`,
      left > 0 ? `You can invite ${left === 1 ? 'one more friend' : `${left} more friends`} this month with the same link.` : 'That was the last friend your link is rewarded for this month.',
    ],
    cta: { label: 'See your signatures', url: `${baseUrl()}/app/settings?tab=billing#invite` },
    links: [{ label: 'Stop these emails', url: stopUrl(inviter.id), note: 'We send this email once for each friend, and we never write to your friends. This link works without logging in. Rewards still arrive.' }],
  } };
}

/** Called when somebody signs a document of this account (completeRecipient in envelopes.ts). Never throws. */
export async function afterSignature(accountId: string) {
  try {
    if (referralsOn() && get("SELECT 1 x FROM referrals WHERE friend_account_id=? AND status='pending'", accountId)) await settleReferrals(accountId);
  } catch (e) {
    console.error('[referrals] could not settle after a signature', e);
  }
}

// ---- Taking it back ------------------------------------------------------------------------------------------------------

/**
 * An account was paused for abuse (by the reports of recipients, or by a person here). Invites it was the friend in
 * are undone: what is left of the reward leaves both accounts (signatures already used stay used), and the record
 * says so. Invites that were still waiting are refused. Its own link stops working while the pause lasts (linkOpen).
 */
export function referralAbuse(accountId: string): number {
  let taken = 0;
  const t = now();
  for (const row of all("SELECT * FROM referrals WHERE friend_account_id=? AND status IN ('pending','rewarded')", accountId)) {
    if (row.status === 'pending') {
      run("UPDATE referrals SET status='refused', reason=?, decided_at=? WHERE id=?", 'friend_closed', t, row.id);
      continue;
    }
    const fromInviter = row.inviter_got ? takeBackGift(row.inviter_account_id, 'referral', lotRef('invite', row.id), `referral-back:${row.id}`) : 0;
    const fromFriend = takeBackGift(row.friend_account_id, 'referral', lotRef('friend', row.id), `referral-back:${row.id}`);
    run("UPDATE referrals SET status='taken_back', reason=?, taken_back_at=?, taken_back=? WHERE id=?", 'friend_closed', t, fromInviter + fromFriend, row.id);
    if (row.inviter_got) logLine(row.inviter_account_id, 'referral-back', row.id, `A friend you invited was paused for abuse, so the reward for that invite was taken back: ${sigs(fromInviter)} left your balance${fromInviter < row.inviter_got ? `, and the ${sigs(row.inviter_got - fromInviter)} already used or expired ${row.inviter_got - fromInviter === 1 ? 'stays' : 'stay'} as ${row.inviter_got - fromInviter === 1 ? 'it is' : 'they are'}` : ''}.`);
    taken += fromInviter + fromFriend;
  }
  return taken;
}

// ---- What the inviter sees -------------------------------------------------------------------------------------------------

/** The Invite friends card: the link, the counts and the numbers of the rules. No friend is ever named. */
export function referralState(accountId: string) {
  const r = referralSettings();
  if (!referralsOn()) return { on: false as const, rules: r };
  const code = codeOf(accountId);
  const n = get(`SELECT COUNT(*) joined, COALESCE(SUM(CASE WHEN inviter_got > 0 THEN 1 ELSE 0 END), 0) rewarded,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) waiting, COALESCE(SUM(inviter_got), 0) signatures
    FROM referrals WHERE inviter_account_id=? AND status != 'refused'`, accountId);
  const counts = rewardedCounts(accountId);
  const account = get('SELECT * FROM accounts WHERE id=?', accountId);
  return {
    on: true as const, code, url: inviteUrl(code), rules: r,
    joined: Number(n.joined) || 0, rewarded: Number(n.rewarded) || 0, waiting: Number(n.waiting) || 0, signatures: Number(n.signatures) || 0,
    month_left: Math.max(0, r.monthly_max - counts.month), total_left: Math.max(0, r.total_max - counts.total),
    // false once a limit is reached, or while the account is paused: the link then earns nothing, and the card says so.
    open: linkOpen(account),
    emails: !get('SELECT mail_off FROM referral_codes WHERE account_id=?', accountId)?.mail_off,
  };
}

// ---- The stop link of the reward email ---------------------------------------------------------------------------------------

const stopToken = (accountId: string) => `${accountId}.${hmac(`referral-stop:${accountId}`).slice(0, 32)}`;
export const stopUrl = (accountId: string) => `${baseUrl()}/api/public/referral-emails?token=${encodeURIComponent(stopToken(accountId))}`;
/** The account a stop link is for, or null. */
export function accountOfStop(tokenText: unknown): any {
  const [accountId, sig] = String(tokenText ?? '').split('.');
  if (!accountId || !sig || stopToken(accountId) !== `${accountId}.${sig}`) return null;
  return get('SELECT id, name FROM accounts WHERE id=?', accountId) || null;
}
export function setReferralMail(accountId: string, on: boolean) {
  codeOf(accountId);
  run('UPDATE referral_codes SET mail_off=? WHERE account_id=?', on ? 0 : 1, accountId);
}

// ---- The operators ------------------------------------------------------------------------------------------------------------

/** Who invited whom, newest first, with where each invite stands and why. For the operator page. */
export function referralRecord(limit = 200, accountId?: string) {
  const rows = all(`SELECT r.*, ia.name inviter_name, fa.name friend_account_name, fu.email friend_email, fu.name friend_name,
      (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=r.inviter_account_id AND m.role='owner' ORDER BY m.created_at LIMIT 1) inviter_email
    FROM referrals r LEFT JOIN accounts ia ON ia.id=r.inviter_account_id LEFT JOIN accounts fa ON fa.id=r.friend_account_id LEFT JOIN users fu ON fu.id=r.friend_user_id
    ${accountId ? 'WHERE r.inviter_account_id=? OR r.friend_account_id=?' : ''} ORDER BY r.at DESC LIMIT ?`, ...(accountId ? [accountId, accountId] : []), Math.min(500, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id, at: r.at, status: r.status, decided_at: r.decided_at,
    reason: (REFERRAL_REFUSALS as Record<string, string>)[r.reason] || r.reason || '',
    inviter: { account_id: r.inviter_account_id, account: r.inviter_name || null, email: r.inviter_email || null, signatures: r.inviter_got },
    friend: { account_id: r.friend_account_id, account: r.friend_account_name || null, email: r.friend_email || null, name: r.friend_name || null, signatures: r.friend_got },
    taken_back_at: r.taken_back_at, taken_back: r.taken_back,
  }));
}

// ---- The timer --------------------------------------------------------------------------------------------------------------------

/** On the timer: rewards that are due, and fingerprints of browsers and addresses not seen for DEVICE_KEEP_DAYS go. */
export async function referralsTick(): Promise<{ rewarded: number; forgotten: number }> {
  const forgotten = Number(run('DELETE FROM referral_devices WHERE at < ?', new Date(Date.now() - DEVICE_KEEP_DAYS * DAY).toISOString()).changes) || 0;
  return { rewarded: await settleReferrals(), forgotten };
}

// ---- The offer in words, where someone is told they have run out -------------------------------------------------------------------

/**
 * One sentence for the refusal a send gets with too few signatures, and for the email at two left and at none:
 * the other way to get more. Empty where the offer is off or the account's link has reached a limit. `withLink`
 * prints the link itself (an email to the account's own people); the refusal on screen names the Plan page.
 */
export function inviteSentence(accountId: string, withLink = false): string {
  if (!referralsOn() || !linkOpen(get('SELECT * FROM accounts WHERE id=?', accountId))) return '';
  const n = referralSettings().signatures;
  return withLink
    ? `Or invite a friend: when their first document is signed, you both get ${n} free signatures. Your invite link: ${inviteUrl(codeOf(accountId))}`
    : `Or invite a friend from the Plan page and you both get ${n} free signatures.`;
}
