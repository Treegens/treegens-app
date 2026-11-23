import { all, get, run, tx } from './db.ts';
import { hmac, id, now, baseUrl, shortCode, token } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { creditsEnabled, grant, takeBackGift } from './credits.ts';
import { sendMail } from './mail.ts';
import { isDeploymentBilling } from '../lib/billingmode.ts';
import { PRICING } from '../lib/impact.ts';
import { expiryMoment } from '../lib/policy.ts';
import { referralRulesFrom, referralOfferOn, referralPath, isReferralCode, normalEmail, normalPhone, REFERRAL_CODE_LENGTH, REFERRAL_REFUSALS, type ReferralRefusal, type ReferralRules } from '../lib/referral.ts';
import type { Ctx } from './router.ts';

// Invite a friend (the rules and the words are in src/lib/referral.ts).
//
//   1. Every account has one invite link, <site>/r/<code>. Whoever opens it lands on the sign-up page, and their
//      browser keeps the code in a cookie for 30 days, so it also counts when they sign up with Google or Microsoft.
//   2. A sign-up through the link writes one line in `referrals` (pending, or refused with the reason). Nothing is
//      given yet.
//   3. The reward lands once the friend's account is real: their email address is confirmed, they gave a phone
//      number, and somebody has signed a document they sent (a signature that counted, not their own). Then the
//      inviting account and the friend's account each get the free signatures, as a lot of their own that expires
//      like the trial's (credits.ts, source "referral"). The owner of the inviting account gets one email.
//   4. Nobody is rewarded for inviting themselves: the same mailbox, the same phone number, the same account, a
//      browser or an internet address the inviting account was used from. One reward per friend, and a limit per
//      month and in total for each inviting account.
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
const phoneMark = (phone: string) => mark('phone', normalPhone(phone));
// An address we cannot tell apart (no proxy in front) says nothing about who is who, so it never counts as "the same".
const ipMark = (ip: string) => (ip && ip !== 'unknown' ? mark('ip', ip) : '');

/**
 * The phone number a login gave ('' when none). It is users.phone; a column of the users row with another name for
 * the same thing (phone_e164, mobile and the like) is read too, so this does not depend on how sign-up names it.
 * The number is read as plain text: a build that encrypts that column has to open it before this sees it.
 */
export function userPhone(u: any): string {
  if (!u) return '';
  const names = ['phone', ...Object.keys(u).filter((k) => /phone|mobile/.test(k) && !/verif|hash|code|_at$|tries|calls/.test(k))];
  for (const k of names) if (typeof u[k] === 'string' && normalPhone(u[k]).length >= 6) return u[k];
  return '';
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
  if (ok) c.cookies.push(cookie(REF_COOKIE, code, REF_COOKIE_DAYS * 86400, c.secure));
  return { ok, signatures: r.signatures, expiry_days: r.expiry_days };
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
  run('INSERT INTO referral_devices (account_id, device, ip, at) VALUES (?,?,?,?) ON CONFLICT(account_id, device, ip) DO UPDATE SET at=excluded.at', accountId, deviceOf(c), ipMark(c.ip), now());
}

// ---- A sign-up through a link ------------------------------------------------------------------------------------------

const refuse = (why: ReferralRefusal) => why;

/** Why this friend can never count for this inviting account, from what is known about both right now. */
function whyNot(inviter: any, friend: { userId: string; accountId: string; email: string; at: string }): ReferralRefusal | null {
  if (inviter.id === friend.accountId || get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', inviter.id, friend.userId)) return refuse('same_account');
  const members = all('SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=?', inviter.id);
  const me = normalEmail(friend.email);
  if (members.some((u) => normalEmail(u.email) === me)) return refuse('same_email');
  const phone = normalPhone(userPhone(get('SELECT * FROM users WHERE id=?', friend.userId)));
  if (phone && members.some((u) => normalPhone(userPhone(u)) === phone)) return refuse('same_phone');
  // The friend's browser or internet address at sign-up against every one the inviting account was used from: the
  // same browser at any time, the same internet address within a day before or after.
  const mine = all('SELECT device, ip, at FROM referral_devices WHERE account_id=?', friend.accountId);
  const theirs = all('SELECT device, ip, at FROM referral_devices WHERE account_id=?', inviter.id);
  if (mine.some((m) => theirs.some((t) => t.device === m.device))) return refuse('same_device');
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_IP_HOURS * 3600_000;
  if (mine.some((m) => m.ip && theirs.some((t) => t.ip === m.ip && near(t.at, friend.at)))) return refuse('same_ip');
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
  const code = isReferralCode(o.ref) ? o.ref : readCookie(c.req, REF_COOKIE);
  // The code is used up by this sign-up, whatever comes of it.
  if (readCookie(c.req, REF_COOKIE)) c.cookies.push(cookie(REF_COOKIE, '', 0, c.secure));
  const inviter = accountOfCode(code);
  if (!inviter) return 'none';
  const at = now();
  const r = referralSettings();
  const counts = rewardedCounts(inviter.id);
  const why: ReferralRefusal | null = inviter.suspended_at || inviter.closing_at ? 'inviter_closed'
    : counts.total >= r.total_max ? 'total_limit'
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

/** Whether the friend's account is real yet: a confirmed address, a phone number, and a signature that counted. */
function friendReady(row: any): { user: any; ready: boolean } {
  const user = get('SELECT * FROM users WHERE id=?', row.friend_user_id);
  const signed = !!get("SELECT 1 x FROM credits WHERE account_id=? AND reason='signature' LIMIT 1", row.friend_account_id);
  return { user, ready: !!user && !!user.email_verified && !!userPhone(user) && signed };
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
  // Decided again with what is known now: the phone number, and every browser and address noted since sign-up.
  const why = whyNot(inviter, { userId: user.id, accountId: friendAccount.id, email: user.email, at: row.at });
  if (why) return refused(why), null;
  const pm = phoneMark(userPhone(user));
  if (get("SELECT 1 x FROM referrals WHERE phone_mark=? AND id != ? AND status IN ('rewarded','taken_back')", pm, row.id)) return refused('phone_used'), null;
  const r = referralSettings();
  const counts = rewardedCounts(inviter.id);
  if (counts.total >= r.total_max) return refused('total_limit'), null;
  // Over the limit of the month: the friend was promised theirs and gets it; the inviting account gets none for
  // this friend, and the record says why.
  const inviterGets = counts.month < r.monthly_max ? r.signatures : 0;
  grant(friendAccount.id, r.signatures, 'referral', lotRef('friend', row.id), t);
  if (inviterGets) grant(inviter.id, inviterGets, 'referral', lotRef('invite', row.id), t);
  run("UPDATE referrals SET status='rewarded', reason=?, decided_at=?, phone_mark=?, inviter_got=?, friend_got=? WHERE id=?", inviterGets ? '' : 'The inviting account had reached its limit of rewarded friends for the month.', t, pm, inviterGets, r.signatures, row.id);
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
      `Yours are on the Plan page of ${inviter.name} now. Use them by ${until}: after that, unused ones expire. Each one plants ${PRICING.treesPerSignature} trees when it is signed.`,
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

/** On the timer: rewards that are due, and fingerprints of browsers and addresses older than DEVICE_KEEP_DAYS go. */
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
    : `Or invite a friend from the Plan page: you both get ${n} free signatures after their first signed document.`;
}
