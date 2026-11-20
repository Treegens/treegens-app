// Signing in person: the sender hosts the signing on their own phone, tablet or laptop and puts it in the signer's
// hands. That browser is signed in to the sender's account. Without anything more, the signer holding it is one
// tap on Back away from every envelope, contact and setting of the sender.
//
// So the moment the signing page of someone who signs in person is opened in a browser that is signed in to the
// host's account, that browser's session is locked (sessions.locked_at). A locked session opens nothing: every
// call that needs signing in is refused, and the app shows one screen that asks for the owner's password
// ("I am ..."). Typing it takes the lock off and nothing else changes: no other browser is signed out, nothing is
// lost. Five wrong passwords sign the browser out for good, so the lock cannot be worked on at leisure.
//
// What this covers is GrowSigning in that browser. It does not cover the rest of the device (the host's email, where
// signing links and password resets arrive, other apps), a password the browser has saved and offers to fill in,
// or a Google or Microsoft account that is signed in on the device when the host signs in here that way. The
// pages that offer in-person signing say so (IN_PERSON_LOCK in src/lib/phone.ts).
import { route, type Ctx } from './router.ts';
import { get, run } from './db.ts';
import { bad, now, rateLimit, sha256, str } from './util.ts';
import { checkPassword, hasPassword, readCookie, cookie, sessionEnd, SESSION_COOKIE } from './auth.ts';
import { HAND_OVER_TRIES } from '../lib/policy.ts';
import { noteHand, clearHand } from './handlive.ts';

const note = (s: any): { envelope_id?: string; signer?: string; wrong?: number } => {
  try {
    return JSON.parse(s?.locked_note || '{}') || {};
  } catch {
    return {};
  }
};
const lockedSession = (req: Request): any => {
  const t = readCookie(req, SESSION_COOKIE);
  const s = t ? get('SELECT * FROM sessions WHERE id=? AND expires_at > ? AND locked_at IS NOT NULL', sha256(t), now()) : null;
  return s && sessionEnd(s) > Date.now() ? s : null;
};

// Called when a signing page is opened (GET /sign/:token). Locks the browser's session when the page belongs to
// someone who signs in person and still has to, and the browser is signed in to the account the envelope is from.
// Only then: a signer who opens a link on a device of their own, signed in to an account of their own, is left alone.
export function handDevice(c: Ctx, e: any, r: any): void {
  if (r?.role !== 'inperson' || r.status === 'completed' || e?.status !== 'sent') return;
  // Who holds the device is noted too, so the next person on it never reads this one's private questions (handlive.ts).
  if (c.auth?.via !== 'session' || !c.auth.sessionId) return noteHand(c, e, r, false);
  if (!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', e.account_id, c.user.id)) return noteHand(c, e, r, false);
  run('UPDATE sessions SET locked_at=?, locked_note=?, unlock_tries=0 WHERE id=? AND locked_at IS NULL', now(), JSON.stringify({ envelope_id: e.id, signer: str(r.name, 120) }), c.auth.sessionId);
  noteHand(c, e, r, true);
}

// What the app's lock screen needs to know about this browser, or null when it is not locked: whose it is (the name
// is on the signing page the device just showed), whether that person has a password to type, who it was handed to
// and which envelope to go back to.
export function handedOver(req: Request): { name: string; has_password: boolean; signer: string | null; envelope_id: string | null; tries_left: number } | null {
  const s = lockedSession(req);
  if (!s) return null;
  const u = get('SELECT name, password_hash FROM users WHERE id=?', s.user_id);
  const n = note(s);
  return u ? { name: u.name, has_password: hasPassword(u), signer: n.signer || null, envelope_id: n.envelope_id || null, tries_left: Math.max(0, HAND_OVER_TRIES - (s.unlock_tries || 0)) } : null;
}

// The browser is signed out for good: the sign-in page, with its own limits, is the only way back. An answer, not a
// thrown error, because a thrown error would lose the cookie that clears it.
const signOut = (c: Ctx, sessionId: string): Response => {
  run('DELETE FROM sessions WHERE id=?', sessionId);
  c.cookies.push(cookie(SESSION_COOKIE, '', 0, c.secure));
  return new Response(JSON.stringify({ error: `That was ${HAND_OVER_TRIES} wrong passwords, so this browser has been signed out. Sign in again from the sign-in page. Nothing in the account was changed.`, code: 'signed_out' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
};

// "I am ...": the owner of the session types their password and the lock comes off. Public, because a locked
// session counts as nobody. Nothing here says more than the lock screen already shows.
route('POST', '/auth/unlock', async (c) => {
  // The body is read first, so that nothing waits between counting a try and checking it below. Read after the
  // session, forty tries sent at once all started from the same count and all had their password checked.
  const password = str((await c.body().catch(() => ({}))).password, 200);
  // Each check costs the server real work, and one address has no business trying more than a few devices' locks.
  rateLimit(`unlock:${c.ip}`, 30, 900_000);
  const s = lockedSession(c.req);
  if (!s) throw bad('This browser is not locked. If you are not signed in any more, sign in again.', 409, { code: 'not_locked' });
  rateLimit(`unlock:${s.id}`, 20, 900_000);
  const u = get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u || !hasPassword(u)) throw bad('This login has no password, because you sign in with Google or Microsoft. Sign in again that way to come back to your account.', 400, { code: 'no_password' });
  if (!password) throw bad('Type your password to come back to your account.', 400, { code: 'wrong_password' });
  // The try is counted before the password is looked at, in one statement that only changes the row while tries
  // are left. However many arrive together, from however many server processes, only HAND_OVER_TRIES of them get a
  // number; every later one finds nothing to change and is refused unchecked, even with the right password: once
  // the last try is used, the lock is shut for everyone and the browser is signed out.
  const tryNo = Number(get('UPDATE sessions SET unlock_tries=unlock_tries+1 WHERE id=? AND locked_at IS NOT NULL AND unlock_tries < ? RETURNING unlock_tries n', s.id, HAND_OVER_TRIES)?.n || 0);
  if (!tryNo) return signOut(c, s.id);
  if (!checkPassword(password, u.password_hash)) {
    if (tryNo >= HAND_OVER_TRIES) return signOut(c, s.id);
    const left = HAND_OVER_TRIES - tryNo;
    throw bad(`That password is not right, so the account stays locked on this device. ${left === 1 ? 'One more try' : `${left} more tries`}, then this browser is signed out.`, 401, { code: 'wrong_password', tries_left: left });
  }
  run('UPDATE sessions SET locked_at=NULL, locked_note=NULL, unlock_tries=0 WHERE id=?', s.id);
  // The device is back with its owner: nobody signing in person holds it any more (handlive.ts).
  clearHand(c);
  return { ok: true, envelope_id: note(s).envelope_id || null };
}, 'public');
