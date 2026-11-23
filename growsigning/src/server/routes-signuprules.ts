// The routes of the rules for making an account (signuprules.ts): giving or changing the phone number of a login,
// "Not now", checking the number by a code where the server sends text messages, and what the people who run the
// server see. Loaded by routes-account.ts.
import crypto from 'node:crypto';
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual, HttpError } from './util.ts';
import { smsProvider } from '../lib/checks.ts';
import { readPhone, phoneFree, savePhone, phoneState, phoneKeyOf, ready } from './signuprules.ts';
import { showPhone } from '../lib/signup.ts';

const person = (c: Ctx) => {
  if (c.auth?.via !== 'session') throw new HttpError(403, 'An API key cannot see or change the phone number of a login. That needs a person signed in to the app.');
};

// Gives or changes the number of the login that is signed in.
route('POST', '/me/phone', async (c) => {
  person(c);
  rateLimit(`phone:${c.user.id}`, 10, 3600_000);
  const e164 = readPhone(await c.body());
  phoneFree(e164, c.user.id);
  savePhone(c.user.id, e164);
  return { ok: true, phone: phoneState(get('SELECT * FROM users WHERE id=?', c.user.id)) };
});

// "Not now", once, and only for a login from before the rule. It is asked again when it sends something new.
route('POST', '/me/phone/later', (c) => {
  person(c);
  if (phoneState(c.user).ask !== 'may_wait') throw bad('Please add your phone number to go on.', 409, { code: 'phone_needed' });
  run('UPDATE users SET phone_asked_at=? WHERE id=?', now(), c.user.id);
  return { ok: true };
});

// ---- Checking the number by code: only where the server can send text messages, and never required ----

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const codeMark = (userId: string, code: string) => hmac(`login-tel-code:${userId}:${code}`);

route('POST', '/me/phone/code', async (c) => {
  person(c);
  if (!smsProvider()) throw bad('This server does not send text messages, so a number cannot be checked by code. Your number is saved as it is.', 404, { code: 'no_texts' });
  if (!c.user.phone) throw bad('Add your phone number first.', 409);
  if (c.user.phone_verified_at) return { ok: true, verified: true };
  rateLimit(`phone-code:${c.user.id}`, 3, 3600_000);
  rateLimit(`phone-code-ip:${c.ip}`, 10, 3600_000);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const until = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
  run('UPDATE users SET phone_code=? WHERE id=?', JSON.stringify({ mark: codeMark(c.user.id, code), until, wrong: 0 }), c.user.id);
  // Loaded only here: the text module carries the whole signing side with it.
  const { sendText } = await import('./sms.ts');
  const sent = await sendText({ to: c.user.phone, accountId: c.account.id, kind: 'code', expiresAt: until, text: `Your GrowSigning code is ${code.slice(0, 3)} ${code.slice(3)}. It works for ${CODE_MINUTES} minutes. Nobody from GrowSigning will ask you for it.` });
  if (sent.status === 'failed') throw bad('The text message could not be sent just now. Your number is saved, and you can try the code again later.', 502, { code: 'text_failed' });
  return { ok: true, minutes: CODE_MINUTES };
});

route('POST', '/me/phone/verify', async (c) => {
  person(c);
  const typed = str((await c.body()).code, 20).replace(/\D/g, '');
  let held: any = null;
  try {
    held = JSON.parse(c.user.phone_code || 'null');
  } catch {}
  if (!c.user.phone || !held || held.until <= now() || held.wrong >= CODE_TRIES) throw bad('That code no longer works. Ask for a new one.', 410, { code: 'code_gone' });
  if (!safeEqual(codeMark(c.user.id, typed), String(held.mark))) {
    run('UPDATE users SET phone_code=? WHERE id=?', JSON.stringify({ ...held, wrong: held.wrong + 1 }), c.user.id);
    throw bad('That is not the code from the text message. Please check it and try again.', 400, { code: 'wrong_code' });
  }
  run('UPDATE users SET phone_verified_at=?, phone_code=NULL WHERE id=?', now(), c.user.id);
  return { ok: true, verified: true };
});

// ---- The people who run the server -------------------------------------------------------------------

const operator = async (c: Ctx) => {
  const { isOperator } = await import('./routes-trust.ts');
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
};

// The people of one account with their numbers, for whoever answers a help request or looks at a report.
route('GET', '/operator/accounts/:id/people', async (c) => {
  await operator(c);
  ready();
  if (!get('SELECT 1 x FROM accounts WHERE id=?', c.params.id)) throw bad('Account not found.', 404);
  return {
    people: all('SELECT u.id, u.name, u.email, u.phone, u.phone_key, u.phone_verified_at, u.phone_rule, u.created_at, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', c.params.id).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
      phone: u.phone ? showPhone(u.phone) : null, phone_verified: !!u.phone_verified_at,
      // How many other logins have the same number (more than 0 only for a number that was allowed for more).
      phone_also_on: u.phone_key ? get('SELECT COUNT(*) n FROM users WHERE phone_key=? AND id != ?', u.phone_key, u.id).n : 0,
      phone_shared: !!u.phone_key && !!get('SELECT 1 x FROM phone_shared WHERE phone_key=?', u.phone_key),
      asked: phoneState(u).ask,
    })),
  };
});

// Allows one number for more than one login (a family, a shop with one phone), or takes that back. Logins that
// already share it keep it either way.
route('POST', '/operator/phones', async (c) => {
  await operator(c);
  ready();
  const b = await c.body();
  if (typeof b.shared !== 'boolean') throw bad('Say what to change: "shared": true or false, with the "phone". Nothing was changed.');
  const key = phoneKeyOf(readPhone(b));
  if (b.shared) run('INSERT OR IGNORE INTO phone_shared (phone_key, by_user, at) VALUES (?,?,?)', key, c.user.id, now());
  else run('DELETE FROM phone_shared WHERE phone_key=?', key);
  return { ok: true, shared: b.shared };
});
