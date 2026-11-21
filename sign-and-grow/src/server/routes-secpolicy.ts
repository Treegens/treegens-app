// The sign-in rules of an account: reading and changing them (owner and admins, in a browser), how long a browser
// has left before the idle rule signs it out, and the signing page's second look at its link after a long break.
// The rules themselves are in secpolicy.ts.
import { route } from './router.ts';
import { setByField, floorForAccount } from './orgs.ts';
import { run } from './db.ts';
import { bad, now } from './util.ts';
import { needCode, twoStepOn } from './twostep.ts';
import { find } from './routes-sign.ts';
import { saveRules, idleLeft, awayMinutes } from './secpolicy.ts';
import { pwnedOn } from './pwned.ts';
import { isOperator } from './routes-trust.ts';
import { switchedOff } from '../lib/outside.ts';
import { rulesOf, wholeIn, PASSWORD_MIN, PASSWORD_RULE_MAX, IDLE_MIN_MINUTES, IDLE_MAX_MINUTES, IDLE_WARN_SECONDS } from '../lib/signinrules.ts';
import { SOURCE_LOCALE, t } from '../lib/i18n.ts';

const say = (key: string, vars: Record<string, string | number> = {}) => t(SOURCE_LOCALE, key, vars);
// The limits a person can choose from: never below what an organisation above the account asks (src/server/orgs.ts),
// so the box and its hint say "From 12 to 64" when the Government asks for 12.
const floorLimits = (accountId: string) => {
  const f = floorForAccount(accountId).policy;
  return { password: [Math.max(PASSWORD_MIN, f.min_password_length || 0), PASSWORD_RULE_MAX], idle_minutes: [IDLE_MIN_MINUTES, Math.min(IDLE_MAX_MINUTES, f.idle_minutes || IDLE_MAX_MINUTES)] };
};
const view = (c: any) => ({
  ...rulesOf(c.account),
  limits: { ...floorLimits(c.account.id), warn_seconds: IDLE_WARN_SECONDS },
  // Whether new passwords are looked up in the list of leaked passwords on this server. Off: the card says nothing of it.
  leak_check: pwnedOn(),
  two_step_required: !!c.account.two_step_required_at,
  // Rules an organisation above the account decided: "Set by Ministry of Health" (src/server/orgs.ts).
  ...setByField(c.account.id),
  // Changing the rules asks for the code of two-step login from someone who has it.
  code_needed: twoStepOn(c.user),
});

route('GET', '/account/rules', (c) => view(c), 'admin');

route('PATCH', '/account/rules', async (c) => {
  // The rules decide who gets into the account, so a leaked key must not be able to loosen them.
  if (c.auth?.via !== 'session') throw bad('An API key cannot change the sign-in rules. Sign in to the app as an owner or admin and change them under Settings, Security.', 403);
  const b = await c.body();
  const was = rulesOf(c.account);
  const next = { ...was };
  if (b.min_password_length !== undefined) {
    const n = wholeIn(b.min_password_length, PASSWORD_MIN, PASSWORD_RULE_MAX);
    if (n === null) throw bad(say('rules.refused.password', { lo: PASSWORD_MIN, hi: PASSWORD_RULE_MAX, kept: was.min_password_length }), 400, { field: 'min_password_length' });
    next.min_password_length = n;
  }
  if (b.idle_minutes !== undefined) {
    if (b.idle_minutes === null || b.idle_minutes === '' || b.idle_minutes === false || b.idle_minutes === 0) next.idle_minutes = null;
    else {
      const n = wholeIn(b.idle_minutes, IDLE_MIN_MINUTES, IDLE_MAX_MINUTES);
      if (n === null) throw bad(say('rules.refused.idle', { lo: IDLE_MIN_MINUTES, hi: IDLE_MAX_MINUTES, kept: was.idle_minutes ? say('rules.kept.minutes', { count: was.idle_minutes }) : say('rules.kept.off') }), 400, { field: 'idle_minutes' });
      next.idle_minutes = n;
    }
  }
  if (b.one_session !== undefined) {
    if (typeof b.one_session !== 'boolean') throw bad('One session at a time is on or off, so nothing was changed. Send "one_session" as true or false.', 400, { field: 'one_session' });
    next.one_session = b.one_session;
  }
  if (JSON.stringify(next) === JSON.stringify(was)) return { ok: true, signed_out: 0, ...view(c) };
  await needCode(c, b.code, 'change the sign-in rules');
  const r = saveRules(c, next);
  return { ok: true, ...r, ...view({ ...c, account: { ...c.account, min_password_length: next.min_password_length, idle_minutes: next.idle_minutes, one_session: next.one_session ? 1 : 0 } }) };
}, 'admin');

// How long this browser has left. The app asks with the "x-quiet" header, so asking is not use.
route('GET', '/me/idle', (c) => idleLeft(c));
// "Stay signed in", and the page's note that someone is working: the request itself is the use.
route('POST', '/me/idle/stay', (c) => {
  if (c.auth?.sessionId) run('UPDATE sessions SET seen_at=? WHERE id=? AND seen_account=?', now(), c.auth.sessionId, c.account.id);
  return idleLeft(c);
});

// The signing page of an account with the idle rule asks this on the first action after a long break: the link is
// looked up again exactly as when the page was opened (and refused in the same words when it no longer opens). What
// comes back is what the page compares with what it shows: the document's state and version, and whether this
// person has finished. When one differs (cancelled, expired, corrected, finished in another tab), the page loads again.
route('GET', '/sign/:token/away', (c) => {
  const { e, r } = find(c);
  return { ok: true, minutes: awayMinutes(e.account_id), status: e.status, version: e.content_version ?? null, done: r?.status === 'completed' };
}, 'public');

// For /app/operator: whether this server looks new passwords up in the list of leaked ones, and if not, why. Only
// "off" is drawn there (one line), so a server with the check on shows nothing new.
route('GET', '/operator/leak-check', (c) => {
  if (!isOperator(c.user)) throw bad('Not found', 404);
  const on = pwnedOn();
  return { on, why: on ? null : switchedOff().some((s) => s.id === 'pwned') ? 'outside_calls' : 'setting' };
});
