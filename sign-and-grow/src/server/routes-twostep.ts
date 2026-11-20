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
import { deviceName } from '../lib/phone.ts';
import { TWO_STEP_SIGNIN_MINUTES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_PAUSE_MINUTES, TWO_STEP_TRIES } from '../lib/policy.ts';
import {
  twoStepOn, toBase32, otpauthUri, matchStep, newRecoveryCodes, recoveryLeft, needCode, useCode, logStep, clearTwoStep, pendingOf, endPending,
  rememberDevice, pausedUntil, ownsAnAccount, startEmailReset, stopEmailReset, whenFor, ISSUER, TOTP_DIGITS, TOTP_SECONDS, type LogWhat,
} from './twostep.ts';

const user = (id: string) => get('SELECT * FROM users WHERE id=?', id);
const names = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
// The teams of this person that ask everyone for two-step login.
const requiredBy = (userId: string): string[] => all('SELECT a.name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=? AND a.two_step_required_at IS NOT NULL ORDER BY a.name', userId).map((r) => r.name);
const expired = () => bad(`This sign-in is no longer waiting for a code. It waits ${TWO_STEP_SIGNIN_MINUTES} minutes, only in the browser where it started, and a newer sign-in there replaces it. Start again on the sign-in page.`, 401, { code: 'two_step_expired' });

// ---- Signing in: the second screen ----------------------------------------------------------------------------

// What the second screen needs to know. The same for a right and a wrong password: both wait here.
route('GET', '/auth/two-step', (c) => {
  const p = pendingOf(c);
  if (!p) return { waiting: false, minutes: TWO_STEP_SIGNIN_MINUTES };
  return { waiting: true, via: p.via || null, expires_at: p.expires_at, paused_until: pausedUntil(user(p.user_id)) };
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
  const used = await useCode(u, b.code, { passwordOk: !!p.password_ok, at: 'signin' });
  endPending(c, p);
  // The phone (or a recovery code) is there after all: a reset by email that was under way is not needed, and stops.
  const stopped = await stopEmailReset(u, 'signed_in');
  if (b.remember === true) rememberDevice(c, u.id);
  let note: any = {};
  try {
    note = JSON.parse(p.note || '{}') || {};
  } catch {}
  const r = await signInAs(c, user(u.id), p.invite, { passed: true });
  return { user: publicUser(user(u.id)), ...note, ...r, next: p.next || null, used: used.kind, recovery_left: used.left, reset_stopped: stopped };
}, 'public');

// "I lost my phone and my recovery codes", on the second screen. The answer is the same whether the password before
// it was right or not; only the mailbox of the login hears what happens next, and only when it was.
route('POST', '/auth/two-step/lost', async (c) => {
  const p = pendingOf(c);
  if (!p) throw expired();
  rateLimit(`two-step-lost:${p.user_id}`, 3, 3600_000);
  if (p.password_ok) await sendWayBack(user(p.user_id));
  return { ok: true };
}, 'public');

// The same from Settings, for someone still signed in somewhere who no longer has the phone.
route('POST', '/me/two-step/lost', async (c) => {
  rateLimit(`two-step-lost:${c.user.id}`, 3, 3600_000);
  if (!twoStepOn(c.user)) throw bad('Two-step login is not on for your login, so there is nothing to reset.', 409);
  await sendWayBack(c.user);
  return { ok: true, sent_to: c.user.email, owner: ownsAnAccount(c.user.id) };
});

// An owner gets the link that starts a reset by email. Someone who owns no account has an owner who can reset it,
// and is told who. Nothing is emailed when two-step login is not on any more.
async function sendWayBack(u: any) {
  if (!u || !twoStepOn(u)) return;
  if (ownsAnAccount(u.id)) {
    const t = token();
    const until = new Date(Date.now() + 3600_000).toISOString();
    run('DELETE FROM two_step_resets WHERE user_id=? OR expires_at <= ?', u.id, now());
    run('INSERT INTO two_step_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(t), u.id, until);
    return void (await sendMail({ to: u.email, subject: 'Reset two-step login of your Sign&Grow login', heading: 'Lost your phone?', expiresAt: until,
      lines: ['Someone who knew the password of your Sign&Grow login said they no longer have the phone with the authenticator app, nor the recovery codes, and asked for a way in.',
        `Open the link below to start a reset. Your second step is then switched off ${TWO_STEP_EMAIL_RESET_DAYS} days later, and from then on your password alone signs in until you set it up again. We email you when it starts and every day until then. The wait is there so that someone who has only got into your mailbox cannot get into your login quietly.`,
        'The link works once, for one hour. If you did not ask for it, ignore this email and nothing changes. Someone knows your password, though: change it.'],
      cta: { label: 'Start the reset', url: `${baseUrl()}/two-step-reset?token=${t}` } }));
  }
  const teams = all("SELECT a.name, (SELECT group_concat(u2.name, ', ') FROM memberships m2 JOIN users u2 ON u2.id=m2.user_id WHERE m2.account_id=a.id AND m2.role IN ('owner','admin') AND m2.user_id!=?) people FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?", u.id, u.id);
  await sendMail({ to: u.email, subject: 'Getting back into your Sign&Grow login without your phone', heading: 'Ask an admin of your team',
    lines: ['Someone who knew the password of your Sign&Grow login said they no longer have the phone with the authenticator app, nor the recovery codes.',
      `An owner or an admin of your team can switch your second step off under Settings, Team. You are emailed when they do, and it is written down who did it. Ask one of them, best by phone or in person, so that they know it is you: ${teams.map((t) => `${t.name} (${t.people || 'its owner'})`).join('; ')}.`,
      'Then sign in with your password and set two-step login up again with your new phone. If you did not ask for this, someone knows your password: change it.'] });
}

// The link from that email: the reset starts, and takes effect TWO_STEP_EMAIL_RESET_DAYS later.
route('POST', '/auth/two-step/email-reset', async (c) => {
  rateLimit(`two-step-reset:${c.ip}`, 20, 3600_000);
  const t = str((await c.body()).token, 200);
  const r = t ? get('SELECT * FROM two_step_resets WHERE token_hash=? AND expires_at > ?', sha256(t), now()) : null;
  if (!r) throw bad('This link does not work any more. It works once, for one hour. Ask for a new one on the sign-in screen: after your password, choose "I lost my phone and my recovery codes".', 410, { code: 'link_expired' });
  run('DELETE FROM two_step_resets WHERE user_id=?', r.user_id);
  const u = user(r.user_id);
  if (!u || !twoStepOn(u)) return { ok: true, off: true };
  const at = await startEmailReset(u);
  return { ok: true, takes_effect_at: at, when: whenFor(u, at), days: TWO_STEP_EMAIL_RESET_DAYS };
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
};
const logText = (l: any) => (l.what === 'reset_by_admin' ? `Switched off by ${l.by_name || 'an admin'}, an admin of ${l.account_name || 'a team'}.` : LOG_TEXT[l.what as LogWhat] || l.what);
const deviceHandle = (d: any) => sha256(`two-step-device:${d.id}`).slice(0, 16);
const devicesOf = (userId: string): any[] => all('SELECT * FROM two_step_devices WHERE user_id=? AND expires_at > ? ORDER BY last_used_at DESC', userId, now());

route('GET', '/me/two-step', (c) => {
  const u = c.user;
  const on = twoStepOn(u);
  return {
    on, since: on ? u.two_step_on_at : null, recovery_left: on ? recoveryLeft(u) : 0, has_password: hasPassword(u),
    paused_until: pausedUntil(u), reset_at: u.two_step_reset_at || null, required_by: requiredBy(u.id), owner: ownsAnAccount(u.id),
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
  if (!/^\d{6}$/.test(typed)) throw bad('Type the 6 digits your authenticator app shows for Sign&Grow.', 400, { code: 'code_needed' });
  const k = matchStep(u.two_step_new_secret, typed);
  if (k < 0) throw bad('That code does not match, so nothing was switched on. Check that the app shows the entry you added from this page (each start makes a new one), that the time on your phone is set automatically, and type the newest 6 digits.', 400, { code: 'wrong_code' });
  const moving = twoStepOn(u);
  // A reset by email that was under way would switch the new app off again in a few days.
  await stopEmailReset(u, 'settings');
  const done = tx(() => {
    run('UPDATE users SET two_step_secret=two_step_new_secret, two_step_on_at=COALESCE(two_step_on_at, ?), two_step_last_step=?, two_step_new_secret=NULL, two_step_new_at=NULL, two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=NULL WHERE id=?', now(), k, u.id);
    logStep(u.id, moving ? 'moved' : 'on');
    if (moving) return { codes: null, signed_out: 0 };
    // Every other browser signed in to this login got in without the second step, so it is signed out now.
    const n = Number(run('DELETE FROM sessions WHERE user_id=? AND id != ?', u.id, c.auth?.sessionId || '').changes);
    return { codes: newRecoveryCodes(u.id), signed_out: n };
  });
  await sendMail({ to: u.email, subject: moving ? 'Two-step login of your Sign&Grow login moved to another app' : 'Two-step login is on for your Sign&Grow login', heading: moving ? 'Your second step moved' : 'Two-step login is on',
    lines: [moving ? 'From now on, signing in to your Sign&Grow login asks for the code of the authenticator app that was just added. The app used before no longer works for it. Your recovery codes stay as they were.'
      : `From now on, signing in to your Sign&Grow login asks for the code from your authenticator app after the password, or after Google or Microsoft. ${done.signed_out ? 'Every other browser that was signed in was signed out.' : ''}`.trim(),
      'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'],
    cta: { label: 'Open Settings', url: `${baseUrl()}/app/settings?tab=profile#two-step` } });
  return { ok: true, moved: moving, codes: done.codes, signed_out: done.signed_out };
});

route('POST', '/me/two-step/recovery-codes', async (c) => {
  const b = await c.body();
  if (!twoStepOn(c.user)) throw bad('Two-step login is not on, so there are no recovery codes to make. Switch it on first.', 409, { code: 'two_step_off' });
  await needCode(c, b.code, 'make new recovery codes');
  const codes = tx(() => {
    const l = newRecoveryCodes(c.user.id);
    logStep(c.user.id, 'codes');
    return l;
  });
  await sendMail({ to: c.user.email, subject: 'New recovery codes for your Sign&Grow login', heading: 'New recovery codes',
    lines: ['New recovery codes for two-step login were made in your Sign&Grow login, under Settings. The codes you had before no longer work.', 'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'] });
  return { codes };
});

route('POST', '/me/two-step/off', async (c) => {
  const b = await c.body();
  if (!twoStepOn(c.user)) return { ok: true, already: true };
  const teams = requiredBy(c.user.id);
  if (teams.length) throw bad(`${names(teams)} ${teams.length === 1 ? 'asks' : 'ask'} everyone on the team to use two-step login, so it cannot be switched off while you are on ${teams.length === 1 ? 'that team' : 'those teams'}. To use another phone, choose "Move to another app" instead. Nothing was changed.`, 409, { code: 'required_by_team', teams });
  await needCode(c, b.code, 'switch two-step login off');
  tx(() => {
    clearTwoStep(c.user.id);
    logStep(c.user.id, 'off', { id: c.user.id, name: c.user.name });
  });
  await sendMail({ to: c.user.email, subject: 'Two-step login is off for your Sign&Grow login', heading: 'Two-step login is off',
    lines: ['Two-step login was switched off under Settings, in a browser signed in to your Sign&Grow login. Your password alone signs in now. Remembered devices and recovery codes were removed.', 'If you did not do this, someone else is in your login: write to us through the help page, and change your password.'] });
  return { ok: true };
});

// Browsers that skip the second step. Withdrawing one never needs a code: it only takes a way in away.
route('DELETE', '/me/two-step/devices/:id', (c) => {
  const d = devicesOf(c.user.id).find((x) => deviceHandle(x) === c.params.id);
  if (!d) throw bad('That device does not skip the second step any more, so there was nothing to withdraw.', 404);
  run('DELETE FROM two_step_devices WHERE id=?', d.id);
  return { ok: true };
});
route('DELETE', '/me/two-step/devices', (c) => {
  const n = Number(run('DELETE FROM two_step_devices WHERE user_id=?', c.user.id).changes);
  if (n) logStep(c.user.id, 'devices_forgotten');
  return { ok: true, withdrawn: n };
});

route('POST', '/me/two-step/reset/stop', async (c) => ({ ok: true, stopped: await stopEmailReset(c.user, 'settings') }));

// ---- Teams ----------------------------------------------------------------------------------------------------

route('GET', '/account/two-step', (c) => {
  const last = new Map(all("SELECT user_id, at, by_name FROM two_step_log WHERE account_id=? AND what='reset_by_admin' ORDER BY id", c.account.id).map((l) => [l.user_id, { at: l.at, by: l.by_name }]));
  const members = all('SELECT u.id, u.name, u.email, u.two_step_on_at, u.two_step_secret, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', c.account.id).map((m) => {
    const on = twoStepOn(m);
    return { id: m.id, name: m.name, email: m.email, role: m.role, on, can_reset: on && m.id !== c.user.id && m.role !== 'owner', last_reset: last.get(m.id) || null };
  });
  return { required: !!c.account.two_step_required_at, required_since: c.account.two_step_required_at || null, can_require: c.role === 'owner', you_on: twoStepOn(c.user), members };
}, 'admin');

route('POST', '/account/two-step', async (c) => {
  if (c.role !== 'owner') throw bad('Only the owner of the account can decide that everyone on it signs in with two-step login.', 403);
  const b = await c.body();
  if (typeof b.required !== 'boolean') throw bad('Send "required": true to ask everyone for two-step login, or false to stop asking.');
  if (b.required === !!c.account.two_step_required_at) return { ok: true, required: b.required, told: 0 };
  // The owner first: whoever asks it of others has it, and cannot be shut out of their own account by it.
  if (b.required && !twoStepOn(c.user)) throw bad('Switch two-step login on for yourself first, under Settings, Profile. Then you can ask it of everyone.', 409, { code: 'set_up_first' });
  await needCode(c, b.code, b.required ? 'ask everyone for two-step login' : 'stop asking everyone for two-step login');
  run('UPDATE accounts SET two_step_required_at=? WHERE id=?', b.required ? now() : null, c.account.id);
  let told = 0;
  if (b.required) {
    // Everyone who does not have it hears it from us before the next time they open the app.
    for (const m of all('SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id!=?', c.account.id, c.user.id).filter((u) => !twoStepOn(u))) {
      told++;
      await sendMail({ to: m.email, about: m.id, subject: `${c.account.name} asks you to use two-step login`, heading: 'Two-step login for your team',
        lines: [`${c.user.name}, the owner of ${c.account.name} on Sign&Grow, asks everyone on the team to sign in with two-step login: after the password, a 6-digit code from an authenticator app on your phone.`,
          `The next time you open ${c.account.name}, you are asked to set it up, and until then nothing else in it opens. It takes a minute. You need an authenticator app, such as the one your phone may already have for passwords, or any app that shows 6-digit sign-in codes.`],
        cta: { label: 'Set it up now', url: `${baseUrl()}/app/settings?tab=profile#two-step` } });
    }
  }
  return { ok: true, required: b.required, told };
}, 'admin');

// For a member who lost their phone and their recovery codes. Written down with who did it, and the member is
// emailed at once. The owner's second step is not anyone else's to reset: the owner uses the reset by email.
route('POST', '/account/members/:id/two-step/reset', async (c) => {
  const b = await c.body();
  const m = get('SELECT u.*, m.role member_role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('That person is not on this team.', 404);
  if (m.id === c.user.id) throw bad('Your own second step is changed under Settings, Profile, not here. If you lost your phone and your recovery codes, sign out and choose "I lost my phone and my recovery codes" after your password.', 400);
  if (m.member_role === 'owner') throw bad(`${m.name} owns ${c.account.name}, and nobody else can reset the second step of an owner. The owner uses the reset by email on the sign-in screen, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days.`, 403, { code: 'owner' });
  if (!twoStepOn(m)) throw bad(`${m.name} does not have two-step login on, so there is nothing to reset.`, 409, { code: 'two_step_off' });
  rateLimit(`two-step-admin-reset:${c.user.id}`, 10, 3600_000);
  await needCode(c, b.code, `reset the second step of ${m.name}`);
  tx(() => {
    clearTwoStep(m.id);
    logStep(m.id, 'reset_by_admin', { id: c.user.id, name: `${c.user.name} (${c.user.email})` }, c.account);
  });
  await sendMail({ to: m.email, subject: `${c.user.name} switched off two-step login of your Sign&Grow login`, heading: 'Your second step was reset',
    lines: [`${c.user.name} (${c.user.email}), an admin of ${c.account.name}, switched off two-step login of your Sign&Grow login just now. Your password alone signs in now, and your recovery codes and remembered devices were removed.`,
      `Set it up again under Settings, Profile, with the authenticator app on your phone.${c.account.two_step_required_at ? ` ${c.account.name} asks everyone for it, so you are asked to do that the next time you open it.` : ''}`,
      `If you did not ask for this, tell ${c.user.name} and change your password, because whoever knows it can now sign in with it alone.`],
    cta: { label: 'Set it up again', url: `${baseUrl()}/app/settings?tab=profile#two-step` } });
  return { ok: true, name: m.name };
}, 'admin');

