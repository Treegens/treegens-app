// Two-step login: the screen after the password (or after Google or Microsoft), setting it up and looking after it
// under Settings, the team rule, and the ways back for someone who lost their phone. The rules are in twostep.ts.
// Nothing here gives a session except POST /auth/two-step with a right code, through signInAs like every sign-in.
// No API key reaches any of it (PERSON_ONLY in router.ts).
import crypto from 'node:crypto';
import { route } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, now, rateLimit, sha256, str, token, baseUrl } from './util.ts';
import { checkPassword, hasPassword } from './auth.ts';
import { sendMail } from './mail.ts';
import { signInAs, publicUser } from './routes-account.ts';
import { linkProvider } from './routes-signin.ts';
import { record, signInFailed } from './seclog.ts';
import { deviceName } from '../lib/phone.ts';
import { refuseLoosening, setByFor } from './orgs.ts';
import { twoStepOffAllowed } from './orgsso.ts';
import { TWO_STEP_SIGNIN_MINUTES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_PAUSE_MINUTES, TWO_STEP_TRIES, TWO_STEP_LOST_PER_DAY, TWO_STEP_RESET_BLOCK_DAYS } from '../lib/policy.ts';
import {
  twoStepOn, toBase32, otpauthUri, matchStep, newRecoveryCodes, recoveryLeft, needCode, useCode, logStep, clearTwoStep, pendingOf, endPending,
  rememberDevice, pausedUntil, pausedFor, ownsAnAccount, startEmailReset, stopEmailReset, mailReset, whenFor, passedSecondStep, emailResetAllowed,
  resetBlockedUntil, adminResetTeams, ISSUER, TOTP_DIGITS, TOTP_SECONDS, type LogWhat,
} from './twostep.ts';

const user = (id: string) => get('SELECT * FROM users WHERE id=?', id);
const names = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
// The teams of this person that ask everyone for two-step login.
const requiredBy = (userId: string): string[] => all('SELECT a.name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=? AND a.two_step_required_at IS NOT NULL ORDER BY a.name', userId).map((r) => r.name);
const unconfirmed = (u: any) => bad(`Confirm your email address first, then switch two-step login on. We sent a confirmation link to ${u.email} when your login was made, and you can have it sent again at the top of the page. Until an address is confirmed, two-step login cannot be switched on, so that nobody can put their phone in front of a login made in someone else's name.`, 409, { code: 'confirm_first' });
const expired = () => bad(`This sign-in is no longer waiting for a code. It waits ${TWO_STEP_SIGNIN_MINUTES} minutes, only in the browser where it started, and a newer sign-in there replaces it. Start again on the sign-in page.`, 401, { code: 'two_step_expired' });

// ---- Signing in: the second screen ----------------------------------------------------------------------------

// What the second screen needs to know. The same for a right and a wrong password: both wait here.
route('GET', '/auth/two-step', (c) => {
  const p = pendingOf(c);
  if (!p) return { waiting: false, minutes: TWO_STEP_SIGNIN_MINUTES };
  // password_asked: the first step was Google or Microsoft, so "I lost my phone" asks for the password (POST /lost).
  return { waiting: true, via: p.via || null, expires_at: p.expires_at, paused_until: pausedFor(user(p.user_id), c.ip), password_asked: !!p.via };
}, 'public');

route('POST', '/auth/two-step', async (c) => {
  const b = await c.body();
  rateLimit(`two-step:${c.ip}`, 60, 900_000);
  const p = pendingOf(c);
  if (!p) throw expired();
  const u = user(p.user_id);
  if (!u) throw expired();
  // Throws, in words, for a wrong code, a wrong password before it (said the same way) and a pause. The waiting
  // sign-in stays, so a typo in the code costs a try and not the password.
  const used = await useCode(u, b.code, { passwordOk: !!p.password_ok, at: 'signin', ip: c.ip }).catch((e) => {
    // A wrong code, or a wrong password before it: the security record says it was one of the two, as this screen
    // does, so that an admin of a team this person is on cannot use the record to find out a password.
    if (e?.data?.code === 'wrong_code') signInFailed(c, u, 'wrong_password_or_code', p.via);
    throw e;
  });
  endPending(c, p);
  let note: any = {};
  try {
    note = JSON.parse(p.note || '{}') || {};
  } catch {}
  // Google or Microsoft that was not connected to this login yet is connected only now, after the code: whoever has
  // only the mailbox behind the address gets no way in (routes-signin.ts).
  const { link, ...said } = note;
  if (link?.provider && link.who) Object.assign(said, await linkProvider(u.id, link.provider, link.who, c));
  const device = b.remember === true ? rememberDevice(c, u.id) : null;
  // The phone (or a recovery code) is there after all: a reset by email that was under way is not needed, and stops.
  const stopped = await passedSecondStep(c, user(u.id), 'signed_in', device);
  const r = await signInAs(c, user(u.id), p.invite, { passed: true, via: p.via });
  return { user: publicUser(user(u.id)), ...said, ...r, next: p.next || null, used: used.kind, recovery_left: used.left, reset_stopped: stopped };
}, 'public');

// "I lost my phone and my recovery codes", on the second screen. The reset by email needs the right password (the
// owner's decision): after a password the server knows whether it was right, and after Google or Microsoft it is
// typed here. The answer is the same either way; only the mailbox of the login hears what happens next, and only
// when the password was right.
route('POST', '/auth/two-step/lost', async (c) => {
  const p = pendingOf(c);
  if (!p) throw expired();
  let b: any = {};
  try {
    b = await c.body();
  } catch {}
  rateLimit(`two-step-lost:${c.ip}`, 10, 3600_000);
  const u = user(p.user_id);
  let known = !!p.password_ok;
  if (p.via) {
    // Counted before the password is looked at, so the limit says nothing about it either.
    rateLimit(`two-step-lost-pw:${p.user_id}`, 5, 3600_000);
    known = !!u && hasPassword(u) && checkPassword(str(b.password, 200), u.password_hash);
  }
  if (known) await sendWayBack(u);
  return { ok: true };
}, 'public');

// The same from Settings, for someone still signed in somewhere who no longer has the phone. The password is asked
// here too, so that a browser left signed in is not enough to start a reset.
route('POST', '/me/two-step/lost', async (c) => {
  let b: any = {};
  try {
    b = await c.body();
  } catch {}
  if (!twoStepOn(c.user)) throw bad('Two-step login is not on for your login, so there is nothing to reset.', 409);
  rateLimit(`two-step-lost-pw:${c.user.id}`, 5, 3600_000);
  if (!hasPassword(c.user)) throw bad('A reset by email needs the password of your login, and your login has none yet. Choose one first under Settings, Security, Ways to sign in ("Email me a link to set a password"), then come back here.', 409, { code: 'password_first' });
  if (!checkPassword(str(b.password, 200), c.user.password_hash)) throw bad(b.password ? 'That password is not right, so nothing was emailed. Type the password you sign in with.' : 'Type your password as well: a reset by email needs it. Nothing was emailed.', 403, { code: 'password_needed' });
  const what = await sendWayBack(c.user);
  if (!what) throw bad(`We have emailed you about a lost phone ${TWO_STEP_LOST_PER_DAY} times in the last day already, so nothing more was sent. Look for those emails, also among spam, or ask again tomorrow.`, 429, { code: 'lost_limit' });
  return { ok: true, sent_to: c.user.email, what };
});

// Someone who typed the right password says the phone and the recovery codes are gone. What we email depends on
// what can be done for them: the link that starts a reset by email, or that one is under way already or has to wait,
// or who on their team can reset it, or that nobody can. At most TWO_STEP_LOST_PER_DAY a day, counted in the one
// statement that writes it down, so that requests at the same moment cannot pass the limit; false when that many
// went out already and nothing was sent. Nothing is emailed when two-step login is not on any more.
type WayBack = 'link' | 'under_way' | 'blocked' | 'admins' | 'nobody';
async function sendWayBack(u: any): Promise<WayBack | false> {
  if (!u || !twoStepOn(u)) return 'nobody';
  if (!run("INSERT INTO two_step_log (user_id, at, what) SELECT ?, ?, 'lost_asked' WHERE (SELECT COUNT(*) FROM two_step_log WHERE user_id=? AND what='lost_asked' AND at > ?) < ?", u.id, now(), u.id, new Date(Date.now() - 864e5).toISOString(), TWO_STEP_LOST_PER_DAY).changes) return false;
  const teams = adminResetTeams(u.id).map((id) => get("SELECT a.name, (SELECT group_concat(u2.name, ', ') FROM memberships m2 JOIN users u2 ON u2.id=m2.user_id WHERE m2.account_id=a.id AND m2.role IN ('owner','admin') AND m2.user_id!=?) people FROM accounts a WHERE a.id=?", u.id, id)).filter(Boolean);
  const admins = teams.length ? `An owner or an admin of your team can switch it off at once under Settings, Team. Ask one of them, best by phone or in person, so that they know it is you: ${teams.map((t) => `${t.name} (${t.people || 'its owner'})`).join('; ')}. You are emailed when they do, and it is written down who did it.` : '';
  const said = 'Someone who typed the right password of your GrowSigning login said they no longer have the phone with the authenticator app, nor the recovery codes.';
  const notYou = 'If you did not ask for this, someone knows your password: change it.';
  if (!emailResetAllowed(u)) {
    await sendMail({ to: u.email, subject: 'Getting back into your GrowSigning login without your phone', heading: admins ? 'Ask an admin of your team' : 'Only a recovery code can help now',
      lines: [said, 'You switched the reset by email off under Settings, Security, so it cannot be done by email.',
        admins ? `${admins} Then sign in with your password and set two-step login up again with your new phone.`
          : 'Nobody else can switch your second step off either, because you own a workspace or are an admin of more than one, and it would open those too. One of your recovery codes, or a device that is remembered for your login, is the way in that is left.',
        notYou] });
    return admins ? 'admins' : 'nobody';
  }
  if (u.two_step_reset_at) {
    await mailReset(u, u.two_step_reset_at, 'again');
    return 'under_way';
  }
  const blocked = resetBlockedUntil(u);
  if (blocked) {
    await sendMail({ to: u.email, subject: 'A reset of your two-step login cannot start yet', heading: 'Lost your phone?',
      lines: [said, `A reset by email of your login was stopped recently, so a new one can be asked for from ${whenFor(u, blocked)}. The wait is there so that nobody can start one over and over. Signing in with your code ends it.`, ...(admins ? [admins] : []), notYou] });
    return 'blocked';
  }
  const t = token();
  const until = new Date(Date.now() + 3600_000).toISOString();
  run('DELETE FROM two_step_resets WHERE user_id=? OR expires_at <= ?', u.id, now());
  run('INSERT INTO two_step_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(t), u.id, until);
  await sendMail({ to: u.email, subject: 'Reset two-step login of your GrowSigning login', heading: 'Lost your phone?', expiresAt: until,
    lines: [`${said} They asked for a way in.`,
      `Open the link below to start a reset by email. Your second step is then switched off ${TWO_STEP_EMAIL_RESET_DAYS} days later, and from then on signing in asks for no code until you set it up again. Every day until then we email you, with a link that stops it, and every browser where you are signed in says so. The wait is there so that someone who got into your mailbox and knows your password cannot get into your login quietly.`,
      ...(admins ? [`Faster: ${admins}`] : []),
      'The link works once, for one hour. If you did not ask for it, ignore this email and nothing changes. Someone knows your password, though: change it.'],
    cta: { label: 'Start the reset', url: `${baseUrl()}/two-step-reset?token=${t}` } });
  return 'link';
}

// The link from that email: the reset starts, and takes effect TWO_STEP_EMAIL_RESET_DAYS later. The switch and a
// recent stop are looked at again, because either may have come after the email.
route('POST', '/auth/two-step/email-reset', async (c) => {
  rateLimit(`two-step-reset:${c.ip}`, 20, 3600_000);
  const t = str((await c.body()).token, 200);
  const r = t ? get('SELECT * FROM two_step_resets WHERE token_hash=? AND expires_at > ?', sha256(t), now()) : null;
  if (!r) throw bad('This link does not work any more. It works once, for one hour. Ask for a new one on the sign-in screen: after your password, choose "I lost my phone and my recovery codes".', 410, { code: 'link_expired' });
  run('DELETE FROM two_step_resets WHERE user_id=?', r.user_id);
  const u = user(r.user_id);
  if (!u || !twoStepOn(u)) return { ok: true, off: true };
  if (!emailResetAllowed(u)) throw bad('The reset by email was switched off for this login under Settings, Security, so nothing was started. A recovery code, a remembered device or an admin of your team are the ways left.', 409, { code: 'email_reset_off' });
  const blocked = !u.two_step_reset_at && resetBlockedUntil(u);
  if (blocked) throw bad(`A reset of this login was stopped recently, so a new one can start from ${whenFor(u, blocked)}. Nothing was started.`, 409, { code: 'reset_blocked', until: blocked });
  const already = !!u.two_step_reset_at;
  const at = await startEmailReset(u);
  return { ok: true, takes_effect_at: at, when: whenFor(u, at), days: TWO_STEP_EMAIL_RESET_DAYS, already };
}, 'public');

// The link in every email about a reset under way: it stops it, without signing in. A page with a button sends this
// (src/app/two-step-reset), so a mail program that opens links to check them stops nothing.
route('POST', '/auth/two-step/email-reset/stop', async (c) => {
  rateLimit(`two-step-stop:${c.ip}`, 20, 3600_000);
  const t = str((await c.body()).token, 200);
  const r = t ? get('SELECT user_id FROM two_step_stops WHERE token_hash=?', sha256(t)) : null;
  const u = r ? user(r.user_id) : null;
  if (!u?.two_step_reset_at) throw bad('There is no reset under way that this link could stop: it was stopped already, or it has taken effect. If you can sign in, Settings, Security shows what happened to your second step.', 410, { code: 'nothing_to_stop' });
  await stopEmailReset(u, 'link');
  const again = resetBlockedUntil(user(u.id));
  return { ok: true, stopped: true, again_from: again, again_when: again ? whenFor(u, again) : null };
}, 'public');

// ---- Settings: your second step -------------------------------------------------------------------------------

const LOG_TEXT: Record<LogWhat, string> = {
  on: 'Switched on.',
  moved: 'Moved to another authenticator app.',
  off: 'Switched off under Settings.',
  codes: 'New recovery codes were made. The ones before stopped working.',
  recovery_used: 'A recovery code was used.',
  paused: `Paused for ${TWO_STEP_PAUSE_MINUTES} minutes after ${TWO_STEP_TRIES} wrong codes in a row.`,
  reset_by_admin: 'Switched off by an admin of a team.',
  email_reset_started: `A reset by email was started. It takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days.`,
  email_reset_stopped: 'The reset by email was stopped.',
  email_reset_done: 'Switched off by the reset by email.',
  devices_forgotten: 'Every remembered device was withdrawn.',
  lost_asked: 'Someone who typed your password said the phone and recovery codes are lost, and we emailed you what can be done.',
  email_reset_off: 'The reset by email was switched off.',
  email_reset_on: 'The reset by email was allowed again.',
};
// Who reset it: the name as it was, and the address while that login exists. The record keeps no address, so it does
// not outlive the admin's own login.
const byWhom = (l: any) => {
  const who = l.by_id ? get('SELECT email FROM users WHERE id=?', l.by_id) : null;
  return `${l.by_name || 'an admin'}${who ? ` (${who.email})` : ''}`;
};
const logText = (l: any) => (l.what === 'reset_by_admin' ? `Switched off by ${byWhom(l)}, an admin of ${l.account_name || 'a team'}.` : LOG_TEXT[l.what as LogWhat] || l.what);
const deviceHandle = (d: any) => sha256(`two-step-device:${d.id}`).slice(0, 16);
const devicesOf = (userId: string): any[] => all('SELECT * FROM two_step_devices WHERE user_id=? AND expires_at > ? ORDER BY last_used_at DESC', userId, now());

route('GET', '/me/two-step', (c) => {
  const u = c.user;
  const on = twoStepOn(u);
  return {
    on, since: on ? u.two_step_on_at : null, recovery_left: on ? recoveryLeft(u) : 0, has_password: hasPassword(u),
    paused_until: pausedUntil(u), reset_at: u.two_step_reset_at || null, required_by: requiredBy(u.id), owner: ownsAnAccount(u.id), email_verified: !!u.email_verified,
    // The switch "Allow a reset by email", and what is left without it: whether an admin of a team may reset it.
    email_reset: { allowed: emailResetAllowed(u), admins_can: adminResetTeams(u.id).length > 0, blocked_until: resetBlockedUntil(u), days: TWO_STEP_EMAIL_RESET_DAYS },
    devices: devicesOf(u.id).map((d) => ({ id: deviceHandle(d), ...deviceName(d.ua), since: d.created_at, last_used_at: d.last_used_at, until: d.expires_at })),
    log: all('SELECT * FROM two_step_log WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id).map((l) => ({ at: l.at, text: logText(l) })),
  };
});

// Starts setting it up: a new secret, shown once, that counts only after a code from it was typed (confirm). Switching
// it on asks for the password (or a sign-in within the last 15 minutes, for a login without one), so a browser that
// was left signed in cannot be used to put somebody else's phone between its owner and their login. Moving to
// another app while it is on asks for the current code instead.
const FRESH_MINUTES = 15;
route('POST', '/me/two-step/setup', async (c) => {
  const b = await c.body();
  rateLimit(`two-step-setup:${c.user.id}`, 10, 3600_000);
  // A login whose address nobody confirmed may have been made in someone else's name. Its maker must not be able to
  // put their phone in front of it: the real owner could then never get in, because proving the address does not
  // take two-step login away (auth.ts, cutEarlierAccess).
  if (!twoStepOn(c.user) && !c.user.email_verified) throw unconfirmed(c.user);
  if (twoStepOn(c.user)) await needCode(c, b.code, 'move two-step login to another app');
  else if (hasPassword(c.user)) {
    rateLimit(`two-step-setup-pw:${c.user.id}`, 10, 900_000);
    if (!checkPassword(str(b.password, 200), c.user.password_hash)) throw bad(b.password ? 'That password is not right, so two-step login was not set up. Type the password you sign in with.' : 'To switch two-step login on, type your current password as well.', 403, { code: 'password_needed' });
  } else {
    const s = c.auth?.sessionId ? get('SELECT created_at FROM sessions WHERE id=?', c.auth.sessionId) : null;
    if (!s?.created_at || Date.now() - Date.parse(s.created_at) > FRESH_MINUTES * 60_000)
      throw bad(`Your login has no password, so to switch two-step login on, sign out and sign in again first (with Google or Microsoft), and come back here within ${FRESH_MINUTES} minutes.`, 403, { code: 'sign_in_again' });
  }
  const secret = toBase32(crypto.randomBytes(20));
  run('UPDATE users SET two_step_new_secret=?, two_step_new_at=? WHERE id=?', secret, now(), c.user.id);
  return { secret, uri: otpauthUri(secret, c.user.email), issuer: ISSUER, account: c.user.email, digits: TOTP_DIGITS, period: TOTP_SECONDS, moving: twoStepOn(c.user) };
});

// A code from the new secret switches it on (or moves it). Ten recovery codes come back the first time, once.
route('POST', '/me/two-step/confirm', async (c) => {
  const b = await c.body();
  const u = user(c.user.id);
  if (!u.two_step_new_secret || Date.now() - Date.parse(u.two_step_new_at || '') > 3600_000) throw bad('Start again with "Set up two-step login". The secret shown for setting it up is only kept for an hour, and a new one is made each time you start.', 409, { code: 'setup_first' });
  rateLimit(`two-step-confirm:${c.user.id}`, 10, 900_000);
  const typed = str(b.code, 20).replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(typed)) throw bad('Type the 6 digits your authenticator app shows for GrowSigning.', 400, { code: 'code_needed' });
  const k = matchStep(u.two_step_new_secret, typed);
  if (k < 0) throw bad('That code does not match, so nothing was switched on. Check that the app shows the entry you added from this page (each start makes a new one), that the time on your phone is set automatically, and type the newest 6 digits.', 400, { code: 'wrong_code' });
  const moving = twoStepOn(u);
  if (!moving && !u.email_verified) throw unconfirmed(u);
  // A reset by email that was under way would switch the new app off again in a few days.
  await stopEmailReset(u, 'settings');
  const done = tx(() => {
    run('UPDATE users SET two_step_secret=two_step_new_secret, two_step_on_at=COALESCE(two_step_on_at, ?), two_step_last_step=?, two_step_new_secret=NULL, two_step_new_at=NULL, two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=NULL WHERE id=?', now(), k, u.id);
    logStep(u.id, moving ? 'moved' : 'on');
    record('two_step.on', { c, member: u.id, about: ['user', u.id], details: { moved_to_another_app: moving } });
    if (moving) return { codes: null, signed_out: 0 };
    // Every other browser signed in to this login got in without the second step, so it is signed out now.
    const n = Number(run('DELETE FROM sessions WHERE user_id=? AND id != ?', u.id, c.auth?.sessionId || '').changes);
    return { codes: newRecoveryCodes(u.id), signed_out: n };
  });
  await sendMail({ to: u.email, subject: moving ? 'Two-step login of your GrowSigning login moved to another app' : 'Two-step login is on for your GrowSigning login', heading: moving ? 'Your second step moved' : 'Two-step login is on',
    lines: [moving ? 'From now on, signing in to your GrowSigning login asks for the code of the authenticator app that was just added. The app used before no longer works for it. Your recovery codes stay as they were.'
      : `From now on, signing in to your GrowSigning login asks for the code from your authenticator app after the password, or after Google or Microsoft. ${done.signed_out ? 'Every other browser that was signed in was signed out.' : ''}`.trim(),
      'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'],
    cta: { label: 'Open Settings', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
  return { ok: true, moved: moving, codes: done.codes, signed_out: done.signed_out };
});

route('POST', '/me/two-step/recovery-codes', async (c) => {
  const b = await c.body();
  if (!twoStepOn(c.user)) throw bad('Two-step login is not on, so there are no recovery codes to make. Switch it on first.', 409, { code: 'two_step_off' });
  await needCode(c, b.code, 'make new recovery codes');
  const codes = tx(() => {
    const l = newRecoveryCodes(c.user.id);
    logStep(c.user.id, 'codes');
    // That new codes were made, never a code (seclog.ts).
    record('two_step.codes_renewed', { c, member: c.user.id, about: ['user', c.user.id] });
    return l;
  });
  await sendMail({ to: c.user.email, subject: 'New recovery codes for your GrowSigning login', heading: 'New recovery codes',
    lines: ['New recovery codes for two-step login were made in your GrowSigning login, under Settings. The codes you had before no longer work.', 'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'] });
  return { codes };
});

route('POST', '/me/two-step/off', async (c) => {
  const b = await c.body();
  if (!twoStepOn(c.user)) return { ok: true, already: true };
  const teams = requiredBy(c.user.id);
  if (teams.length) throw bad(`${names(teams)} ${teams.length === 1 ? 'asks' : 'ask'} everyone on the team to use two-step login, so it cannot be switched off while you are on ${teams.length === 1 ? 'that team' : 'those teams'}. To use another phone, choose "Move to another app" instead. Nothing was changed.`, 409, { code: 'required_by_team', teams });
  // The owner's way back in while everyone at their domains signs in through their own service (orgsso.ts).
  twoStepOffAllowed(c.user.id);
  await needCode(c, b.code, 'switch two-step login off');
  tx(() => {
    clearTwoStep(c.user.id);
    logStep(c.user.id, 'off', { id: c.user.id, name: c.user.name });
    record('two_step.off', { c, member: c.user.id, about: ['user', c.user.id] });
  });
  await sendMail({ to: c.user.email, subject: 'Two-step login is off for your GrowSigning login', heading: 'Two-step login is off',
    lines: ['Two-step login was switched off under Settings, in a browser signed in to your GrowSigning login. Signing in asks for no code now. Remembered devices and recovery codes were removed.', 'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'] });
  return { ok: true };
});

// Browsers that skip the second step. Withdrawing one never needs a code: it only takes a way in away. The browser is
// signed out too (its session was tied to the device when it was made, see sessionMade in twostep.ts), because a
// device that was not yours should not stay in. The browser this is done from stays signed in.
route('DELETE', '/me/two-step/devices/:id', (c) => {
  const d = devicesOf(c.user.id).find((x) => deviceHandle(x) === c.params.id);
  if (!d) throw bad('That device does not skip the second step any more, so there was nothing to withdraw.', 404);
  run('DELETE FROM two_step_devices WHERE id=?', d.id);
  const out = Number(run('DELETE FROM sessions WHERE user_id=? AND two_step_device=? AND id != ?', c.user.id, d.id, c.auth?.sessionId || '').changes);
  record('two_step.devices_forgotten', { c, member: c.user.id, about: ['user', c.user.id], details: { devices: 1, signed_out: out } });
  return { ok: true, signed_out: out };
});
route('DELETE', '/me/two-step/devices', (c) => {
  const ids = devicesOf(c.user.id).map((d) => d.id);
  const n = Number(run('DELETE FROM two_step_devices WHERE user_id=?', c.user.id).changes);
  let out = 0;
  for (const id of ids) out += Number(run('DELETE FROM sessions WHERE user_id=? AND two_step_device=? AND id != ?', c.user.id, id, c.auth?.sessionId || '').changes);
  if (n) logStep(c.user.id, 'devices_forgotten');
  if (n) record('two_step.devices_forgotten', { c, member: c.user.id, about: ['user', c.user.id], details: { devices: n, signed_out: out } });
  return { ok: true, withdrawn: n, signed_out: out };
});

route('POST', '/me/two-step/reset/stop', async (c) => ({ ok: true, stopped: await stopEmailReset(c.user, 'settings'), again_from: resetBlockedUntil(user(c.user.id)) }));

// "Allow a reset by email" (the owner's decision: on by default). Switched off, someone who loses phone and
// recovery codes can only be reset by an admin of their team, or by nobody (adminResetTeams). Either way it changes
// the second step, so a current code is asked for.
route('POST', '/me/two-step/email-reset', async (c) => {
  const b = await c.body();
  if (typeof b.allowed !== 'boolean') throw bad('Send "allowed": true to allow a reset by email, or false to switch it off.');
  if (!twoStepOn(c.user)) throw bad('Two-step login is not on for your login, so there is nothing to reset by email. Switch it on first.', 409, { code: 'two_step_off' });
  if (b.allowed === emailResetAllowed(c.user)) return { ok: true, allowed: b.allowed };
  await needCode(c, b.code, b.allowed ? 'allow a reset by email' : 'switch the reset by email off');
  run('UPDATE users SET two_step_email_reset_off=? WHERE id=?', b.allowed ? null : now(), c.user.id);
  logStep(c.user.id, b.allowed ? 'email_reset_on' : 'email_reset_off');
  if (!b.allowed) {
    run('DELETE FROM two_step_resets WHERE user_id=?', c.user.id);
    await stopEmailReset(c.user, 'off');
  }
  await sendMail({ to: c.user.email, subject: b.allowed ? 'A reset by email of your two-step login is allowed again' : 'The reset by email of your two-step login is off', heading: b.allowed ? 'Reset by email allowed' : 'Reset by email switched off',
    lines: [b.allowed
      ? `It was allowed again under Settings, Security, in a browser signed in to your GrowSigning login. If you lose your phone and your recovery codes, you can ask for a reset by email after your password: it takes effect ${TWO_STEP_EMAIL_RESET_DAYS} days later, and we email you every day until then.`
      : `It was switched off under Settings, Security, in a browser signed in to your GrowSigning login. If you lose your phone and your recovery codes, ${adminResetTeams(c.user.id).length ? 'only an admin of your team can switch your second step off' : 'nobody can switch your second step off: keep your recovery codes safe'}.`,
      'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'],
    cta: { label: 'Open Settings', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
  return { ok: true, allowed: b.allowed };
});

// ---- Teams ----------------------------------------------------------------------------------------------------

route('GET', '/account/two-step', (c) => {
  const last = new Map(all("SELECT user_id, at, by_id, by_name FROM two_step_log WHERE account_id=? AND what='reset_by_admin' ORDER BY id", c.account.id).map((l) => [l.user_id, { at: l.at, by: byWhom(l) }]));
  const members = all('SELECT u.id, u.name, u.email, u.two_step_on_at, u.two_step_secret, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', c.account.id).map((m) => {
    const on = twoStepOn(m);
    // Only someone this team speaks for alone (adminResetTeams); for anyone else it is their own reset by email.
    const can = on && m.id !== c.user.id && adminResetTeams(m.id).includes(c.account.id);
    return { id: m.id, name: m.name, email: m.email, role: m.role, on, can_reset: can, only_by_email: on && m.id !== c.user.id && !can, last_reset: last.get(m.id) || null };
  });
  return { required: !!c.account.two_step_required_at, required_since: c.account.two_step_required_at || null, can_require: c.role === 'owner', you_on: twoStepOn(c.user), members, ...(setByFor(c.account.id).two_step_required ? { set_by: setByFor(c.account.id).two_step_required } : {}) };
}, 'admin');

route('POST', '/account/two-step', async (c) => {
  if (c.role !== 'owner') throw bad('Only the owner of the account can decide that everyone on it signs in with two-step login.', 403);
  const b = await c.body();
  if (typeof b.required !== 'boolean') throw bad('Send "required": true to ask everyone for two-step login, or false to stop asking.');
  if (b.required === !!c.account.two_step_required_at) return { ok: true, required: b.required, told: 0 };
  // An organisation above the account may ask it of every account below it (src/server/orgs.ts).
  if (!b.required) refuseLoosening(c.account.id, { two_step_required: null });
  // The owner first: whoever asks it of others has it, and cannot be shut out of their own account by it.
  if (b.required && !twoStepOn(c.user)) throw bad('Switch two-step login on for yourself first, under Settings, Security. Then you can ask it of everyone.', 409, { code: 'set_up_first' });
  await needCode(c, b.code, b.required ? 'ask everyone for two-step login' : 'stop asking everyone for two-step login');
  run('UPDATE accounts SET two_step_required_at=? WHERE id=?', b.required ? now() : null, c.account.id);
  record('settings.changed', { c, details: { settings: { two_step_required: { from: !b.required, to: b.required } } } });
  let told = 0;
  if (b.required) {
    // Everyone who does not have it hears it from us before the next time they open the app.
    for (const m of all('SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id!=?', c.account.id, c.user.id).filter((u) => !twoStepOn(u))) {
      told++;
      await sendMail({ to: m.email, about: m.id, subject: `${c.account.name} asks you to use two-step login`, heading: 'Two-step login for your team',
        lines: [`${c.user.name}, the owner of ${c.account.name} on GrowSigning, asks everyone on the team to sign in with two-step login: after the password, a 6-digit code from an authenticator app on your phone.`,
          `The next time you open ${c.account.name}, you are asked to set it up, and until then nothing else in it opens. It takes a minute. You need an authenticator app, such as the one your phone may already have for passwords, or any app that shows 6-digit sign-in codes.`],
        cta: { label: 'Set it up now', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
    }
  }
  return { ok: true, required: b.required, told };
}, 'admin');

// For a member who lost their phone and their recovery codes (the owner's decision): only a member of this team who
// is not an owner or admin of any other workspace, because switching their second step off would open that one too,
// and only after the admin typed their own code, if they have two-step login. Written down with who did it, and the
// member is emailed at once. Everyone else uses their own reset by email.
route('POST', '/account/members/:id/two-step/reset', async (c) => {
  const b = await c.body();
  const m = get('SELECT u.*, m.role member_role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('That person is not on this team.', 404);
  if (m.id === c.user.id) throw bad('Your own second step is changed under Settings, Security, not here. If you lost your phone and your recovery codes, sign out and choose "I lost my phone and my recovery codes" after your password.', 400);
  if (m.member_role === 'owner') throw bad(`${m.name} owns ${c.account.name}, and nobody else can reset the second step of an owner. The owner uses the reset by email on the sign-in screen, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days.`, 403, { code: 'owner' });
  if (!adminResetTeams(m.id).includes(c.account.id)) throw bad(`${m.name} owns a workspace or is an admin of another one, so nobody on ${c.account.name} can switch their second step off: it would open that workspace too. ${m.name} can use the reset by email on the sign-in screen, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days. Nothing was changed.`, 403, { code: 'admin_elsewhere' });
  if (!twoStepOn(m)) throw bad(`${m.name} does not have two-step login on, so there is nothing to reset.`, 409, { code: 'two_step_off' });
  rateLimit(`two-step-admin-reset:${c.user.id}`, 10, 3600_000);
  await needCode(c, b.code, `reset the second step of ${m.name}`);
  tx(() => {
    clearTwoStep(m.id);
    logStep(m.id, 'reset_by_admin', { id: c.user.id, name: c.user.name }, c.account);
    record('two_step.reset', { c, member: m.id, about: ['user', m.id], details: { how: 'by_an_admin', account: c.account.id } });
  });
  await sendMail({ to: m.email, subject: `${c.user.name} switched off two-step login of your GrowSigning login`, heading: 'Your second step was reset',
    lines: [`${c.user.name}, an admin of ${c.account.name}, switched off two-step login of your GrowSigning login just now. Signing in asks for no code now, and your recovery codes and remembered devices were removed.`,
      `Set it up again under Settings, Security, with the authenticator app on your phone.${c.account.two_step_required_at ? ` ${c.account.name} asks everyone for it, so you are asked to do that the next time you open it.` : ''}`,
      `If you did not ask for this, tell ${c.user.name} and change your password, because whoever knows it can now sign in with it alone.`],
    cta: { label: 'Set it up again', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
  return { ok: true, name: m.name };
}, 'admin');

