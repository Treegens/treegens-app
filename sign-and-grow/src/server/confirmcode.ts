import crypto from 'node:crypto';
import { get, run } from './db.ts';
import { bad, hmac, now, rateLimit, safeEqual } from './util.ts';
import { CONFIRM_CODE_DIGITS, CONFIRM_CODE_HOURS, CONFIRM_CODE_MAX_WRONG, CODE_REFUSED, cleanCode, type CodeRefusal } from '../lib/confirm.ts';

// The 6-digit code in the confirmation email, typed in the tab the person signed up in (POST /auth/verify-code).
//
// Confirming an address shows two things: that the person reads the mailbox, and that they made the login. The link
// in the email does both in the browser that is signed in to the login, and asks for the password anywhere else
// (POST /auth/verify in routes-account.ts). The code does the same: it comes from the mailbox, and it is only taken
// from a browser signed in to that login. Whoever made a login with somebody else's address is signed in to it, so
// what stops them is the number of guesses: CONFIRM_CODE_MAX_WRONG wrong codes in all, over every code the login is
// ever sent, and after that only the button in the email confirms it.
//
// users.verify_code_hash: an HMAC of the login and the code, under the server's secret, so a copy of the database does
// not give the code away. verify_code_at: when it was sent; it works for CONFIRM_CODE_HOURS. verify_code_wrong: the
// wrong codes typed so far, never reset.

const keyed = (userId: string, code: string) => hmac(`confirm-code:${userId}:${code}`);
const refuse = (why: CodeRefusal, status = 400) => bad(CODE_REFUSED[why], status, { code: why });

/** Whether codes still work for this login. When they do not, the email has the button only. */
export const codesOpen = (u: any) => Number(u?.verify_code_wrong || 0) < CONFIRM_CODE_MAX_WRONG;

/** A new code for this login, replacing any earlier one. null when codes no longer work for it. */
export function newConfirmCode(userId: string): string | null {
  const u = get('SELECT verify_code_wrong FROM users WHERE id=?', userId);
  if (!u || !codesOpen(u)) return null;
  const code = String(crypto.randomInt(0, 10 ** CONFIRM_CODE_DIGITS)).padStart(CONFIRM_CODE_DIGITS, '0');
  run('UPDATE users SET verify_code_hash=?, verify_code_at=? WHERE id=?', keyed(userId, code), now(), userId);
  return code;
}

/**
 * Confirms the address of the login `u` with the code it typed, or says in words why not. Call it only for a browser
 * that is signed in to `u` with a session. Everything from reading the row to writing it happens without waiting, so
 * two requests at once cannot both use the same try.
 */
export function confirmWithCode(u: any, typed: unknown): void {
  if (u.email_verified) return;
  const code = cleanCode(typed);
  if (!new RegExp(`^[0-9]{${CONFIRM_CODE_DIGITS}}$`).test(code)) throw refuse('code_format');
  // A script typing codes fast is slowed down before it uses up the login's guesses.
  rateLimit(`confirm-code:${u.id}`, 5, 60_000);
  const row = get('SELECT verify_code_hash h, verify_code_at at, verify_code_wrong, email_verified v FROM users WHERE id=?', u.id);
  if (!row) throw refuse('code_wrong');
  if (row.v) return;
  if (!codesOpen(row)) throw refuse('code_closed', 403);
  const right = !!row.h && safeEqual(row.h, keyed(u.id, code));
  if (!right) {
    run('UPDATE users SET verify_code_wrong=verify_code_wrong+1 WHERE id=?', u.id);
    throw refuse(Number(row.verify_code_wrong) + 1 >= CONFIRM_CODE_MAX_WRONG ? 'code_closed' : 'code_wrong', Number(row.verify_code_wrong) + 1 >= CONFIRM_CODE_MAX_WRONG ? 403 : 400);
  }
  if (!row.at || Date.parse(row.at) + CONFIRM_CODE_HOURS * 3600_000 < Date.now()) throw refuse('code_old');
  run('UPDATE users SET email_verified=1, verify_code_hash=NULL WHERE id=?', u.id);
}
