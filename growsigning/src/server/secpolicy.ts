// The sign-in rules of an account (Settings, Security, "Sign-in rules"), enforced. Three rules, all off until an
// owner or admin sets them, plus the leaked-password check that is on for everyone:
//
//   min_password_length   members choose a password of at least this many characters (8 to 64). It applies when a
//                         password is chosen (sign-up from an invitation, the emailed link, Settings). Someone whose
//                         password is shorter is found out the next time they sign in with it, the only moment we
//                         hold the password, and then nothing in the account opens until they have chosen a longer
//                         one. We do not keep the length of anyone's password: users.pw_below holds only "shorter
//                         than N" for a person who broke a rule of N, and is cleared when they choose a new one.
//   idle_minutes          a browser that is signed in and not used for this long (15 to 480 minutes) is signed out.
//   one_session           a person is signed in to the account in one browser at a time: arriving in another signs
//                         the earlier one out.
//
// A rule belongs to the account, and applies to a browser while it works in that account. For a person on several
// teams, the workspace their browser is in decides: sessions.seen_account notes where the idle clock was last
// counted, and a browser that arrives in a workspace (signs in, switches, is moved) starts a fresh clock there.
// API keys are not affected by any of the three.
//
// Nobody is locked out for good. The owner is never held by the password rule (they are told on the card instead),
// everyone held by it is shown the form that fixes it, idle and one-browser sign-outs say why on the sign-in page,
// and switching the idle rule on starts every clock at that moment (accounts.idle_since).
//
// Not here on purpose: passwords that expire, rules about capitals and digits, security questions
// (src/lib/signinrules.ts says why).
import { all, get, run } from './db.ts';
import { bad, now, sha256, HttpError } from './util.ts';
import { record, settingsChanged } from './seclog.ts';
import { pwnedLookup } from './pwned.ts';
import { refuseLoosening } from './orgs.ts';
import { rulesOf, PASSWORD_MIN, QUIET_HEADER, type SignInRules } from '../lib/signinrules.ts';
import { SOURCE_LOCALE, t } from '../lib/i18n.ts';
import type { Auth } from './auth.ts';
import type { Ctx } from './router.ts';

const say = (key: string, vars: Record<string, string | number> = {}) => t(SOURCE_LOCALE, key, vars);
/** The idle clock is written down at most this often, so reading a page is not a write to the database every time. */
const SEEN_EVERY_MS = 10_000;
/** How long the reason a browser was signed out is kept for that browser to read. */
const NOTE_HOURS = 24;

// ---- Choosing a password ---------------------------------------------------------------------------------------

/** The longest "at least" among the teams this person is on (and the ones they are about to join), with whose it is. */
export function passwordRuleFor(userId: string | null, alsoAccounts: (string | null | undefined)[] = []): { min: number; account: string | null } {
  const ids = [...new Set([...(userId ? all('SELECT account_id FROM memberships WHERE user_id=?', userId).map((m) => m.account_id as string) : []), ...alsoAccounts.filter(Boolean) as string[]])];
  let out = { min: PASSWORD_MIN, account: null as string | null };
  for (const accountId of ids) {
    const a = get('SELECT name, min_password_length FROM accounts WHERE id=?', accountId);
    const min = rulesOf(a).min_password_length;
    if (min > out.min) out = { min, account: a.name };
  }
  return out;
}

/** The account an invitation leads to, or null: for the rule of the team someone is joining. */
export const inviteAccount = (tokenText: unknown): string | null =>
  (typeof tokenText === 'string' && tokenText ? get('SELECT account_id FROM invites WHERE token=? AND accepted_at IS NULL', tokenText)?.account_id : null) || null;

/**
 * Refuses a new password that is too short for this person's teams, or that is in the list of leaked passwords.
 * When the list cannot be asked, the password is allowed and nothing says it was checked (pwned.ts).
 */
export async function newPasswordOk(password: string, o: { userId?: string | null; accounts?: (string | null | undefined)[] } = {}): Promise<void> {
  const rule = passwordRuleFor(o.userId || null, o.accounts || []);
  if (password.length < rule.min) throw bad(rule.account ? say('rules.password.too_short_team', { min: rule.min, account: rule.account }) : say('rules.password.too_short', { min: rule.min }), 400, { code: 'password_too_short', min: rule.min });
  if ((await pwnedLookup(password)) === 'leaked') throw bad(say('rules.password.leaked'), 400, { code: 'password_leaked' });
}

/**
 * Called at the two moments we hold a password: when it is typed to sign in, and when it is chosen. Notes whether
 * it is shorter than a rule of one of the person's teams (the lowest such rule), or clears the note.
 */
export function notePassword(userId: string, password: string, alsoAccounts: (string | null | undefined)[] = []): void {
  const ids = [...new Set([...all('SELECT account_id FROM memberships WHERE user_id=?', userId).map((m) => m.account_id as string), ...alsoAccounts.filter(Boolean) as string[]])];
  let below: number | null = null;
  for (const accountId of ids) {
    const min = rulesOf(get('SELECT min_password_length FROM accounts WHERE id=?', accountId)).min_password_length;
    if (min > PASSWORD_MIN && password.length < min && (below === null || min < below)) below = min;
  }
  const was = get('SELECT pw_below FROM users WHERE id=?', userId);
  if (was && (was.pw_below ?? null) !== below) run('UPDATE users SET pw_below=? WHERE id=?', below, userId);
}

/** The rule this person's password is known to be shorter than in this account, or null. */
function passwordShort(user: any, account: any): number | null {
  const min = rulesOf(account).min_password_length;
  const below = Number(user?.pw_below) || 0;
  return min > PASSWORD_MIN && below > 0 && min >= below ? min : null;
}

// While a member's password is shorter than the account asks, only what concerns their own login opens: choosing a
// new password, the second step it may ask for, going to another workspace, leaving, where they are signed in.
const OPEN_WHILE_SHORT = [/^POST \/me\/password$/, /^POST \/me\/phone/, /^[A-Z]+ \/me\/two-step/, /^[A-Z]+ \/me\/idle/, /^POST \/auth\/switch$/, /^POST \/account\/leave$/, /^POST \/auth\/resend-verification$/, /^POST \/auth\/verify-code$/, /^[A-Z]+ \/me\/sessions/, /^POST \/me\/delete$/, /^GET \/me\/signin$/];
/** Called by the router for every route that needs signing in, next to the two-step rule. */
export function rulesGate(auth: Auth | null, what: string): void {
  if (auth?.via !== 'session' || auth.role === 'owner') return;
  const min = passwordShort(auth.user, auth.account);
  if (!min || OPEN_WHILE_SHORT.some((re) => re.test(what))) return;
  throw new HttpError(403, say('rules.password.gate', { min, account: auth.account.name }), { code: 'password_too_short', min });
}

/** The part of GET /me about the rules: what the app needs to warn before an idle sign-out and to ask for a longer password. */
export function rulesMe(c: Ctx): { rules: { idle_minutes: number | null; one_session: boolean; password_needed: number | null; password_short: number | null } } | Record<string, never> {
  if (c.auth?.via !== 'session') return {};
  const r = rulesOf(c.account);
  const short = passwordShort(c.user, c.account);
  // The owner is told on the card and never held; everyone else is asked before anything opens.
  return { rules: { idle_minutes: r.idle_minutes, one_session: r.one_session, password_needed: c.role === 'owner' ? null : short, password_short: short } };
}

// ---- Why a browser was signed out ------------------------------------------------------------------------------

type Why = 'idle' | 'elsewhere';
function noteEnd(sessionId: string, why: Why) {
  run('DELETE FROM session_ends WHERE at < ?', new Date(Date.now() - NOTE_HOURS * 3600_000).toISOString());
  run('INSERT OR REPLACE INTO session_ends (id, why, at) VALUES (?,?,?)', sessionId, why, now());
}
/** Why the session of this cookie ended, when a rule ended it in the last day. */
export function endedWhy(cookieToken: string | null): Why | null {
  if (!cookieToken) return null;
  const r = get('SELECT why, at FROM session_ends WHERE id=?', sha256(cookieToken));
  return r && Date.parse(r.at) > Date.now() - NOTE_HOURS * 3600_000 && (r.why === 'idle' || r.why === 'elsewhere') ? r.why : null;
}
export const endedWords = (why: Why) => say(`rules.out.${why}`);

// ---- The rules of the account a browser is in ------------------------------------------------------------------

/** When this session last counted as used in the account it is in. Never before the idle rule was switched on. */
function lastUse(s: any, account: any): number {
  return Math.max(Date.parse(s.seen_at || '') || 0, Date.parse(s.created_at || '') || 0, Date.parse(account.idle_since || '') || 0);
}

/**
 * Called by authenticate() for a session that is otherwise good. Signs it out when it sat unused for longer than
 * its account allows, counts this request as use (unless it is the page's own quiet look at the clock), and on
 * arriving in an account that allows one browser at a time signs the person's other browsers out of it.
 * Answers the refusal for a session it ended, else null.
 */
export function sessionRule(s: any, req: Request): { status: number; message: string; data: Record<string, any> } | null {
  const a = get('SELECT id, name, idle_minutes, idle_since, one_session FROM accounts WHERE id=?', s.account_id);
  if (!a) return null;
  const r = rulesOf(a);
  if (!r.idle_minutes && !r.one_session) {
    // No rule here. A clock that was counted in another workspace is put away, so it is never read as this one's.
    if (s.seen_account) run('UPDATE sessions SET seen_account=NULL, seen_at=NULL WHERE id=?', s.id);
    return null;
  }
  const t0 = Date.now();
  const arrived = s.seen_account !== a.id;
  if (r.idle_minutes && !arrived && t0 - lastUse(s, a) > r.idle_minutes * 60_000) {
    run('DELETE FROM sessions WHERE id=?', s.id);
    noteEnd(s.id, 'idle');
    record('session.ended', { by: { type: 'system' }, accounts: a.id, about: ['user', s.user_id], details: { how: 'idle', minutes: r.idle_minutes } });
    return { status: 401, message: endedWords('idle'), data: { code: 'signed_out', why: 'idle' } };
  }
  if (arrived) {
    run('UPDATE sessions SET seen_account=?, seen_at=? WHERE id=?', a.id, new Date(t0).toISOString(), s.id);
    if (r.one_session) endOthers(s.user_id, a.id, s.id);
  } else if (r.idle_minutes && req.headers.get(QUIET_HEADER) !== '1' && t0 - (Date.parse(s.seen_at || '') || 0) > SEEN_EVERY_MS) {
    run('UPDATE sessions SET seen_at=? WHERE id=?', new Date(t0).toISOString(), s.id);
  }
  return null;
}

/** Signs this person's other browsers out of the account, and leaves each a note of why. */
function endOthers(userId: string, accountId: string, keep: string): number {
  const others = all('SELECT id FROM sessions WHERE user_id=? AND account_id=? AND id != ?', userId, accountId, keep);
  for (const o of others) {
    run('DELETE FROM sessions WHERE id=?', o.id);
    noteEnd(o.id, 'elsewhere');
  }
  if (others.length) record('session.ended', { by: { type: 'user', id: userId }, accounts: accountId, about: ['user', userId], details: { how: 'signed_in_elsewhere', browsers: others.length } });
  return others.length;
}

/** How long this browser has left before the idle rule signs it out, or null when its account has no such rule. */
export function idleLeft(c: Ctx): { minutes: number | null; seconds_left: number | null } {
  const r = rulesOf(c.account);
  const s = c.auth?.sessionId ? get('SELECT seen_at, created_at FROM sessions WHERE id=?', c.auth.sessionId) : null;
  if (!r.idle_minutes || !s) return { minutes: null, seconds_left: null };
  return { minutes: r.idle_minutes, seconds_left: Math.max(0, Math.round((lastUse(s, c.account) + r.idle_minutes * 60_000 - Date.now()) / 1000)) };
}

/** For the signing page: the minutes of the idle rule of the account an envelope is from, or null. */
export const awayMinutes = (accountId: string | null | undefined): number | null =>
  (accountId ? rulesOf(get('SELECT idle_minutes FROM accounts WHERE id=?', accountId)).idle_minutes : null) || null;

// ---- Changing the rules ----------------------------------------------------------------------------------------

/**
 * The shortest password was lowered from `from` to `to`. A member known to be shorter than a rule between the two is
 * not known to be long enough for the new one (we never keep the length), so they are held by the new rule until
 * they next sign in or choose a password, which is when their password is looked at again (notePassword).
 */
function lowered(accountId: string, from: number, to: number): void {
  if (!(to < from) || to <= PASSWORD_MIN) return;
  run('UPDATE users SET pw_below=? WHERE pw_below > ? AND pw_below <= ? AND id IN (SELECT user_id FROM memberships WHERE account_id=?)', to, to, from, accountId);
}

/**
 * Saves the rules of an account and writes the change to its security record. Switching "one browser at a time" on
 * signs everyone's extra browsers out at once (the one used last stays, and the browser that made the change);
 * switching the idle rule on, or changing its minutes, starts every clock now.
 */
export function saveRules(c: Ctx, next: SignInRules): { signed_out: number } {
  // Never less than an organisation above the account asks (src/server/orgs.ts).
  refuseLoosening(c.account.id, { min_password_length: next.min_password_length > PASSWORD_MIN ? next.min_password_length : null, idle_minutes: next.idle_minutes, one_session: next.one_session || null });
  const was = rulesOf(c.account);
  const idleChanged = was.idle_minutes !== next.idle_minutes;
  run('UPDATE accounts SET min_password_length=?, idle_minutes=?, one_session=?, idle_since=? WHERE id=?',
    next.min_password_length > PASSWORD_MIN ? next.min_password_length : null, next.idle_minutes, next.one_session ? 1 : 0,
    next.idle_minutes ? (idleChanged ? now() : c.account.idle_since || now()) : null, c.account.id);
  lowered(c.account.id, was.min_password_length, next.min_password_length);
  let out = 0;
  if (next.one_session && !was.one_session) {
    const rows = all('SELECT id, user_id, last_used_at, seen_at, created_at FROM sessions WHERE account_id=? AND expires_at > ?', c.account.id, now());
    const by = new Map<string, any[]>();
    for (const s of rows) by.set(s.user_id, [...(by.get(s.user_id) || []), s]);
    const used = (s: any) => String(s.seen_at || s.last_used_at || s.created_at || '');
    for (const [userId, list] of by) {
      if (list.length < 2) continue;
      const keep = list.find((s) => s.id === c.auth?.sessionId) || list.sort((x, y) => used(y).localeCompare(used(x)))[0];
      out += endOthers(userId, c.account.id, keep.id);
    }
  }
  // In the record the shortest password is "min_length": the record never keeps a detail whose name says password
  // (seclog.ts), so a careless one can never put a password in it. The words on the screen are the same.
  const shown = (r: SignInRules) => ({ min_length: r.min_password_length, idle_minutes: r.idle_minutes ?? false, one_session: r.one_session });
  settingsChanged({ c, details: out ? { browsers_signed_out: out } : {} }, shown(was), shown(next), { min_length: 'value', idle_minutes: 'value', one_session: 'value' });
  return { signed_out: out };
}
