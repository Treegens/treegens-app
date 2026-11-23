import { route, json, type Ctx } from './router.ts';
import { counterMe } from './counter.ts';
import { paperOn } from './paper.ts';
import { whatsappProvider, voiceProvider, waDailyPerAccount } from '../lib/channels.ts';
import { adminOrgs, refuseOrgAdminRole, orgMe } from './orgs.ts';
import { DATE_FORMATS } from '../lib/dates.ts';
import { chosenLocale, defaultFor } from './locales.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, rateLimit, rateWait, baseUrl, safeEqual, HttpError } from './util.ts';
import { hashPassword, checkPassword, hasPassword, cutEarlierAccess, createSession, cookie, sessionEnd, SESSION_COOKIE } from './auth.ts';
import { rememberedDevice } from './twostep.ts';
import { PROVIDER_NAMES, isProviderId, type Removed } from '../lib/signin.ts';
import { forgetEarlierSetup, tellRemoved } from './reclaim.ts';
import { deviceName } from '../lib/phone.ts';
import { handedOver } from './handover.ts';
import { SESSION_DAYS, SESSION_MAX_DAYS, SESSION_TOUCH_MINUTES } from '../lib/policy.ts';
import { smsProvider } from '../lib/checks.ts';
import { sendMail } from './mail.ts';
import { assertPublicUrl, WEBHOOK_EVENTS, redeliver, deliveryView, MAX_WEBHOOKS, KEEP_BODIES } from './webhooks.ts';
import { webhookHostsRule } from '../lib/outside.ts';
import { billingEnabled, verifyChain, notifyPrefs, closingText, loadEnvelope } from './envelopes.ts';
import { nameRefusal, hasNotPaid, inviteRefusal, noteInvited } from './envelopes.ts';
import { grant, creditSummary, findFreeCode, sameEmail } from './credits.ts';
import { tick } from './cron.ts';
import { redeemCode } from './routes-billing.ts';
import { emailProblem } from './bounces.ts';
import { trustInfo, keysOf, keyList, tellTeamsAboutKeys, handOver, wasWelcomed } from './routes-trust.ts';
import { impactOf, PRICING } from '../lib/impact.ts';
import { treesOfAccount, treesOfEveryone } from './impact.ts';
import { clientPolicy } from './tenantpolicy.ts';
import { keyDatesOn } from './airepo.ts';
import { delegationOn } from './delegation.ts';
import { DEFAULT_REMINDER_DAYS } from '../lib/policy.ts';
import { noteSignup } from './referrals.ts';
import { forgottenFile, disputeFacts } from './evidence.ts';
import { importedForVerify } from './importer.ts';
import { sealForVerify } from './seal.ts';
import { holdForSecondStep, holdWrongPassword, needCode, twoStepOn, twoStepMe, sessionMade, passwordChanged } from './twostep.ts';
// The security record of each account: one line where something happens (seclog.ts).
import { record, signedIn, signedUp, signInFailed, settingsChanged } from './seclog.ts';
import { converterOn } from './convert.ts';
import { newPasswordOk, notePassword, inviteAccount, rulesMe, endedWhy } from './secpolicy.ts';
import { readCookie } from './auth.ts';
import { passwordAllowed, afterPassword, signupAllowed, enforcedFor, handOverAllowed } from './orgsso.ts';
import { newConfirmCode, confirmWithCode, codesOpen } from './confirmcode.ts';
import { showCode, CONFIRM_CODE_HOURS } from '../lib/confirm.ts';
import { envelopeOfCopy, subjectOfCopy } from './visibility.ts';
import { can, myRole, roleIn, roleChoice, assertMayGive, assertMayManage, type RoleChoice } from './perm.ts';
import { isDeploymentBilling, agreementLine, agreementOf } from '../lib/billingmode.ts';
import { askedSenderLocale, noteSeenLocale } from './senderlocale.ts';
import { directoryManaged, invitesAllowed } from './scim.ts';
import { seal } from './colcrypt.ts';
import { membersMayStamp } from './switches.ts';
// No + in the address of a new login, one login per mailbox, and a phone number (signuprules.ts).
import { refusePlus, newAddressOk, emailKeyOf, readPhone, phoneFree, savePhone, phoneState, phoneRequired, phoneBeforeSend } from './signuprules.ts';
import { PLUS_INVITE_REFUSAL, plusInEmail } from '../lib/signup.ts';
import './routes-signuprules.ts';

// The role an invitation or a change gives (perm.ts): "admin", a role the team made (its id), and anything else
// "member", as it always was. Refused when it can do more than the person giving it.
function givenRole(c: Ctx, value: unknown): RoleChoice {
  // No role given: a Member, as always. Anything that is not a role of this team is refused (roleChoice), never
  // quietly made a Member.
  const choice = roleChoice(c.account.id, value);
  assertMayGive(c, choice);
  return choice;
}

// `c`: with an API key, two_step is left out, because no key reads anything of two-step login (twostep.ts).
export const publicUser = (u: any, c?: Ctx) => ({ id: u.id, email: u.email, name: u.name, title: u.title, company: u.company, email_verified: !!u.email_verified, ...(u.email_verified ? {} : { confirm_by_code: codesOpen(u) }), has_password: hasPassword(u), ...(c?.auth?.via === 'api_key' ? {} : { two_step: twoStepOn(u) }), signature_png: u.signature_png, initials_png: u.initials_png, notify: notifyPrefs(u), locale: u.locale || null });
const okImage = (s: any, max = 700_000) => typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < max;

// `via` names the provider when the login was made by signing in with Google or Microsoft and the provider did not
// stand behind the address. Whoever reads the email is then told how the login came about, so someone who did not
// make it knows not to confirm it. The email does not repeat the name the login was made under: anyone can sign up
// with anyone's address, and a name is words a stranger typed.
// The email is short (50 words or fewer, research/ux-charter.md quick win 1): the 6-digit code to type in the tab the
// person signed up in (confirmcode.ts), and the button for anyone who prefers it. What the button does in another
// browser (it asks for the password) is said on that page when it happens, not here. Each email has a new code, which
// replaces the one before; once too many wrong codes were typed, the email has the button only.
export async function sendVerification(u: any, via?: string) {
  const code = newConfirmCode(u.id);
  await sendMail({
    to: u.email, subject: 'Confirm your email for GrowSigning', heading: 'Confirm your email', brief: true,
    lines: [
      ...(code ? [`Your code is ${showCode(code)}.`, `Type it where you signed up, or press the button. It works for ${CONFIRM_CODE_HOURS} hours.`] : ['Press the button to confirm your email.']),
      via ? `Someone signed in with ${via} and gave this address. If it was not you, do not confirm.`
        : 'Did not sign up? Ignore this email. Without it, that login cannot send or see what was sent to you.',
    ],
    cta: { label: 'Confirm email', url: `${baseUrl()}/verify-email?token=${u.verify_token}` },
    // A try that is late because the mail server would not take it is not made once the code has run out.
    ...(code ? { expiresAt: new Date(Date.now() + CONFIRM_CODE_HOURS * 3600_000).toISOString() } : {}),
  });
}

// A workspace of one's own: made at sign-up, and for someone who signs in and belongs to no account any more
// (removed from their only team), so a login is never a dead end. The welcome signatures go to a person once,
// however many workspaces are made for them.
function ownWorkspace(userId: string, name: string, t = now()): string {
  const accountId = id('acc');
  // The workspace is named after the whole name as the person wrote it. Which word of a name is the given name
  // differs from country to country, so none is picked out. The name can be changed under Settings, Account.
  // A new account starts with automatic reminders on (DEFAULT_REMINDER_DAYS in src/lib/policy.ts), because the
  // public pages promise reminders. The review step shows the choice before every send, and Settings changes it.
  run('INSERT INTO accounts (id, name, created_at, default_reminder_days) VALUES (?,?,?,?)', accountId, `${name}'s workspace`, t, DEFAULT_REMINDER_DAYS);
  run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'owner',?)", accountId, userId, t);
  // Once per person, and once per email address: a login that was deleted and made again under the same address
  // was welcomed before (wasWelcomed in routes-trust.ts). Every way a login or a workspace is made comes through
  // here, with a password or with Google or Microsoft, so this is the one place that decides.
  const first = run('UPDATE users SET welcomed_at=? WHERE id=? AND welcomed_at IS NULL', t, userId).changes;
  // A server paid for under a contract (BILLING_MODE=deployment) counts nothing, so it gives nothing to count.
  if (first && !isDeploymentBilling() && !wasWelcomed(get('SELECT email FROM users WHERE id=?', userId)?.email)) grant(accountId, PRICING.welcomeSignatures, 'welcome', accountId);
  return accountId;
}

// An invitation that this address may use right now. The same rule whichever way the person joins: signing up from
// the invitation, signing in from it, or accepting it while signed in.
function openInvite(tokenText: string, email: string): any {
  const inv = tokenText ? get('SELECT i.*, a.name account_name, a.closing_at FROM invites i JOIN accounts a ON a.id=i.account_id WHERE i.token=? AND i.accepted_at IS NULL', tokenText) : null;
  if (!inv || !sameEmail(inv.email, email)) throw bad(`This invitation cannot be used with ${email}. It was sent to another address, it was used already, or it was cancelled. Ask the person who invited you to send a new one.`);
  // Whoever joined an account that is being closed would lose everything they sent when it is deleted.
  if (inv.closing_at) throw bad(closingText({ name: inv.account_name, closing_at: inv.closing_at }, 'Nobody can join it now'), 403);
  return inv;
}
// Makes the person a member. Call inside tx().
function join(inv: any, userId: string, t = now(), c?: Ctx) {
  // An admin of an organisation above this account never joins it as an owner or admin (src/server/orgs.ts).
  refuseOrgAdminRole(inv.account_id, userId, inv.role);
  // A role the team made travels with the invitation (perm.ts). One deleted since is refused at delete time.
  const pid = inv.profile_id && get('SELECT id FROM perm_profiles WHERE id=? AND account_id=?', inv.profile_id, inv.account_id) ? inv.profile_id : null;
  if (run('INSERT OR IGNORE INTO memberships (account_id, user_id, role, created_at, profile_id) VALUES (?,?,?,?,?)', inv.account_id, userId, inv.role, t, pid).changes)
    record('member.joined', { c, by: { type: 'user', id: userId }, accounts: inv.account_id, about: ['user', userId], details: { role: inv.role, invite: inv.id, ...(pid ? { role_name: get('SELECT name FROM perm_profiles WHERE id=?', pid)?.name } : {}) } });
  run('UPDATE invites SET accepted_at=? WHERE id=?', t, inv.id);
  run('UPDATE users SET last_account_id=? WHERE id=?', inv.account_id, userId);
}

// ---- Auth ----------------------------------------------------------------------------------

route('POST', '/auth/signup', async (c) => {
  try {
    rateLimit(`signup:${c.ip}`, 10, 3600_000);
  } catch {
    // Said for what it is: a shared office or school can reach this honestly.
    throw new HttpError(429, `Too many new accounts from this connection in the last hour. Try again in about ${Math.max(1, Math.ceil(rateWait(`signup:${c.ip}`, 10) / 60_000))} minutes, or sign in if you already have a login.`);
  }
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim().toLowerCase();
  const password = str(b.password, 200);
  if (!name) throw bad('Tell us your name.');
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  // No + in the address of a new login (signuprules.ts). Said before anything else about the address.
  refusePlus(email);
  // An organisation that signs everyone at its domain in through its own service: the login is made there (orgsso.ts).
  signupAllowed(email);
  // The phone number: asked for on the form, read for the country chosen there, and not another login's.
  const phone = phoneRequired() || str(b.phone, 40).trim() ? readPhone(b) : null;
  // Long enough for the team being joined, and not a password from a leak (secpolicy.ts, pwned.ts).
  await newPasswordOk(password, { accounts: [inviteAccount(b.invite)] });
  if (get('SELECT id FROM users WHERE email=?', email)) throw bad(b.invite ? 'You already have a GrowSigning login with this address. Sign in with it and the invitation is accepted.' : 'An account with this email already exists. Sign in instead.', 409);
  // The same mailbox under another spelling (dots at Gmail, googlemail) is the same person: one login.
  newAddressOk(email);
  if (phone) phoneFree(phone);
  const made = await createLogin(c, { name, email, passwordHash: hashPassword(password), invite: b.invite, code: b.code, ref: b.ref, phone });
  return { user: publicUser(made.user) };
}, 'public');

// Makes a new login and signs it in. One way, whether the person chose a password or came from Google or Microsoft:
// a workspace of their own with the welcome signatures, or the team whose invitation they carry, and a code that
// makes the plan free applied at once. `verified` says someone else has already stood behind the address (the
// provider); an invitation does the same, because it was sent there. Everyone else is emailed our confirmation link.
// An invitation or a code that cannot be used is refused before anything is created. `also` runs inside the same
// transaction as the new login, for what must exist with it or not at all.
export async function createLogin(c: Ctx, p: { name: string; email: string; passwordHash: string; verified?: boolean; invite?: any; code?: any; ref?: any; via?: string; also?: (userId: string) => void; phone?: string | null; org?: boolean }) {
  // Every way a login is made comes through here, so this is where the rules for a new address are kept
  // (signuprules.ts): no + before the @, and no login on that mailbox yet. `org`: an organisation made the login
  // through its own sign-in service for a domain it has shown to be its own; it answers for its people's addresses,
  // and they are not asked for a phone number.
  if (!p.org) newAddressOk(p.email);
  if (p.phone) phoneFree(p.phone);
  const invite = p.invite ? openInvite(str(p.invite), p.email) : null;
  // A code that makes the plan free is checked before anything is created, so a typo is said out loud instead of
  // quietly giving an ordinary account. It only applies to a new workspace, not to joining someone else's team.
  const typedCode = str(p.code, 80).trim();
  if (typedCode && !invite && !findFreeCode(typedCode)) throw bad('We do not recognise that code. Check the spelling, or leave the code box empty and add it later on the Plan page.');
  const uid = id('usr');
  let accountId = invite?.account_id;
  const t = now();
  tx(() => {
    run('INSERT INTO users (id, email, name, password_hash, email_verified, verify_token, created_at, email_key, phone_rule) VALUES (?,?,?,?,?,?,?,?,?)', uid, p.email, p.name, p.passwordHash, invite || p.verified ? 1 : 0, token(), t, emailKeyOf(p.email), p.org ? 2 : 1);
    // A login made with Google or Microsoft has no number yet: it gives one on the "One more thing" screen.
    if (p.phone) savePhone(uid, p.phone);
    if (invite) join(invite, uid, t, c);
    else {
      // With a few free signatures to try the product with. Once per person.
      accountId = ownWorkspace(uid, p.name, t);
      run('UPDATE users SET last_account_id=? WHERE id=?', accountId, uid);
    }
    p.also?.(uid);
  });
  // A free-plan code entered at sign-up takes effect straight away, and is confirmed by email like one entered later.
  if (typedCode && !invite) await redeemCode(accountId, typedCode);
  const user = get('SELECT * FROM users WHERE id=?', uid);
  if (!user.email_verified) await sendVerification(user, p.via);
  c.cookies.push(createSession(uid, accountId, c.secure));
  // Invite a friend (referrals.ts): a new workspace made through someone's invite link is written down, so both get
  // their free signatures once this account is real. The code comes with the form or from the browser's cookie, which
  // is how it survives a trip through Google or Microsoft. Joining a team by invitation is not a new friend.
  if (!invite) noteSignup(c, user, accountId, { ref: p.ref, welcomedBefore: wasWelcomed(p.email) });
  // A new login is signed in at once: that is a sign-in in the security record too (seclog.ts).
  signedUp(c, user, p.via);
  return { user, joined: (invite?.account_name as string) || null };
}

route('POST', '/auth/login', async (c) => {
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  rateLimit(`login:${c.ip}`, 30, 900_000);
  rateLimit(`login:${email}`, 10, 900_000);
  // An address whose organisation signs everyone in through its own service gets no password sign-in, except the
  // owner's way back in (orgsso.ts): asked for with way_back, and decided once the password is known to be right.
  const sso = passwordAllowed(email, b.way_back === true);
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (!u || !checkPassword(str(b.password, 200), u.password_hash)) {
    // A login with two-step login answers a wrong password as it answers the right one, with the second screen, so
    // a password cannot be found out by trying it here (twostep.ts).
    const held = holdWrongPassword(c, u, b.invite);
    if (held) return held;
    // Only for a login that exists, and not while the second screen hides whether the password was right (above):
    // such a sign-in is written when its code is typed (routes-twostep.ts).
    if (u) signInFailed(c, u, 'wrong_password');
    throw bad('That email and password do not match.', 401);
  }
  // The one moment we hold the password: whether it is shorter than a team of theirs asks is noted (secpolicy.ts).
  notePassword(u.id, str(b.password, 200), [inviteAccount(b.invite)]);
  if (sso) afterPassword(c, u, sso);
  const r = await signInAs(c, u, b.invite);
  // Held for the second step: nothing about the login goes back yet, not even that the password was right.
  return 'two_step' in r ? r : { user: publicUser(u), ...r };
}, 'public');

// Everything that happens once we know who is signing in, whichever way they showed it (their password, Google or
// Microsoft): a login that is being closed comes back, an invitation carried along is accepted, the workspace used
// last opens, and someone who belongs to no account any more gets one of their own. Sets the session cookie and
// returns what happened, so the first screen can say it.
// `o.passed`: the second step was done (POST /auth/two-step). Otherwise a login with two-step login gets no session
// here: the sign-in waits for the code, with `o.next` and `o.note` (what a provider sign-in did) kept for afterwards.
export async function signInAs(c: Ctx, u: any, inviteToken?: any, o: { passed?: boolean; next?: string | null; note?: any; via?: string } = {}) {
  if (!o.passed) {
    const held = await holdForSecondStep(c, u, { invite: inviteToken, next: o.next, note: o.note, via: o.via });
    if (held) return held;
  }
  // Signing in during the grace period after closing an account brings it straight back.
  const restored = !!u.closing_at;
  if (restored) {
    run('UPDATE users SET closing_at=NULL WHERE id=?', u.id);
    run("UPDATE accounts SET closing_at=NULL WHERE id IN (SELECT account_id FROM memberships WHERE user_id=? AND role='owner')", u.id);
    // Their API keys work again from here. The admins of their teams were told the keys went off, so they hear this too.
    await tellTeamsAboutKeys(u, keysOf(u.id), 'back');
  }
  // Someone who already has a login accepts a team invitation by signing in from it. An invitation that cannot be
  // used never stops the sign-in: the person is in, and is told why they did not join.
  let joined: any = null;
  let inviteError = '';
  if (inviteToken) {
    try {
      joined = openInvite(str(inviteToken), u.email);
      tx(() => join(joined, u.id, now(), c));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      joined = null;
      inviteError = e.message;
    }
  }
  // Opens the team just joined, else the workspace this person used last, else their oldest. Someone who belongs to
  // no account any more (an admin removed them from their only team) gets an empty workspace of their own, as at
  // sign-up, so they can still sign in, read their inbox and be invited again.
  const mine: string[] = all('SELECT account_id FROM memberships WHERE user_id=? ORDER BY created_at', u.id).map((m) => m.account_id);
  const fresh = !mine.length;
  const accountId = joined?.account_id || (mine.includes(u.last_account_id) ? u.last_account_id : mine[0]) || tx(() => ownWorkspace(u.id, u.name));
  if (accountId !== u.last_account_id) run('UPDATE users SET last_account_id=? WHERE id=?', accountId, u.id);
  c.cookies.push(createSession(u.id, accountId, c.secure));
  signedIn(c, u, o.via, o.passed);
  if (restored) record('account.close_undone', { c, by: { type: 'user', id: u.id }, member: u.id, about: ['user', u.id] });
  // What the second step left for this session: the remembered device it is tied to, and whether a reset stopped.
  const step = sessionMade(c);
  return { restored, fresh, joined: (joined?.account_name as string) || null, invite_error: inviteError || null, ...step };
}

route('POST', '/auth/logout', (c) => {
  if (c.auth?.sessionId && run('DELETE FROM sessions WHERE id=?', c.auth.sessionId).changes) record('session.ended', { c, member: c.user.id, about: ['user', c.user.id], details: { how: 'signed_out' } });
  c.cookies.push(cookie(SESSION_COOKIE, '', 0, c.secure));
  return { ok: true };
}, 'public');

// Confirming an address has to show two things: that the person can read the mailbox (the link), and that they are
// the one who made the login (its session, or its password). The link alone is not enough. Anyone can sign up with
// somebody else's address, and if the owner of the mailbox then clicked the link out of habit, a stranger's login
// would count as theirs: it could send in their name and read what was sent to them. So the link confirms at once
// only in a browser that is signed in to that login. Anywhere else it asks for the login's password, and a login
// that has none (made with Google or Microsoft) is confirmed after signing in.
route('POST', '/auth/verify', async (c) => {
  const b = await c.body();
  const t = str(b.token);
  const u = t ? get('SELECT id, email_verified, password_hash FROM users WHERE verify_token=?', t) : null;
  if (!u) throw bad('This confirmation link is not valid any more.');
  if (u.email_verified) return { ok: true };
  if (!(c.auth?.via === 'session' && c.user.id === u.id)) {
    if (!hasPassword(u)) throw bad('This link confirms the address of a GrowSigning login. To show that the login is yours, sign in first, the same way you signed up, and then open this link again in the same browser. If you did not sign up for GrowSigning, close this page: nothing was confirmed.', 401, { code: 'sign_in_first' });
    if (b.password === undefined || b.password === null || b.password === '') throw bad('This link confirms the address of a GrowSigning login. To show that the login is yours, type the password you chose when you signed up. If you did not sign up for GrowSigning, close this page: nothing was confirmed.', 401, { code: 'password_needed' });
    rateLimit(`confirm:${u.id}`, 10, 900_000);
    if (!checkPassword(str(b.password, 200), u.password_hash)) throw bad('That password is not right, so nothing was confirmed. Type the password you chose when you signed up, or sign in to GrowSigning first and open this link again.', 401, { code: 'password_needed' });
  }
  run('UPDATE users SET email_verified=1 WHERE id=?', u.id);
  return { ok: true };
}, 'public');

// The 6-digit code from the confirmation email, typed in a browser signed in to the login (confirmcode.ts).
route('POST', '/auth/verify-code', async (c) => {
  const b = await c.body();
  if (c.auth?.via !== 'session') throw bad('Type the code in GrowSigning, in the browser where you are signed in to this login.', 403);
  confirmWithCode(c.user, b.code);
  return { ok: true };
});

route('POST', '/auth/resend-verification', async (c) => {
  rateLimit(`verify:${c.user.id}`, 5, 3600_000);
  if (!c.user.email_verified) await sendVerification(c.user);
  return { ok: true };
});

route('POST', '/auth/forgot', async (c) => {
  rateLimit(`forgot:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  const u = get('SELECT * FROM users WHERE email=?', email);
  // A password would not open this login: its organisation signs it in through its own service. The email says so
  // instead of sending a link that leads nowhere. The owner keeps the link: their password is the way back in.
  const sso = u ? enforcedFor(email) : null;
  if (u && sso && !get("SELECT 1 x FROM memberships WHERE account_id=? AND user_id=? AND role='owner'", sso.accountId, u.id))
    await sendMail({ to: u.email, subject: `Sign in to GrowSigning with ${sso.name} sign-in`, heading: 'No password needed', lines: [`${sso.name} signs everyone at ${sso.domain} in to GrowSigning through its own sign-in service, so a password does not open your login.`, `Open the sign-in page, type ${u.email}, and press "Continue with ${sso.name} sign-in". If you did not ask for this, ignore this email.`], cta: { label: 'Open the sign-in page', url: `${baseUrl()}/login?email=${encodeURIComponent(u.email)}` } });
  else if (u) await sendPasswordLink(u);
  return { ok: true }; // same answer either way, so emails cannot be probed
}, 'public');

// The emailed link that lets someone choose a password. It is asked for on the "Forgot password" page, or under
// Settings by someone whose login has no password yet because they sign in with Google or Microsoft. That person
// may have come to "Forgot password" only because they did not remember how they sign in, so their email says it,
// and says what choosing a password does to that way of signing in (see POST /auth/reset).
export async function sendPasswordLink(u: any) {
  const t = token();
  const until = new Date(Date.now() + 3600_000).toISOString();
  run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(t), u.id, until);
  const url = `${baseUrl()}/reset?token=${t}`;
  // expiresAt: if the mail server will not take this now, it is tried again, but never once the link in it has run out.
  if (hasPassword(u)) return void (await sendMail({ to: u.email, subject: 'Reset your GrowSigning password', heading: 'Reset your password', lines: ['This link works for one hour. If you did not ask for it, ignore this email.'], cta: { label: 'Choose a new password', url }, expiresAt: until }));
  const ways: any[] = all('SELECT provider, vouched FROM identities WHERE user_id=?', u.id).filter((i) => isProviderId(i.provider));
  const names = (list: any[]) => [...new Set(list.map((i) => PROVIDER_NAMES[i.provider as 'google' | 'microsoft']))].join(' and ');
  const cut = u.email_verified ? [] : ways.filter((i) => !i.vouched);
  await sendMail({ to: u.email, subject: 'Choose a password for GrowSigning', heading: 'Choose a password',
    lines: [`This GrowSigning login has no password yet${ways.length ? `. It is opened by signing in with ${names(ways)}` : ''}. With this link you choose a password, so that you can also sign in with this email address.`,
      ...(cut.length ? [`This address has not been confirmed yet, so choosing a password here also disconnects ${names(cut)} from the login. Once you are signed in you can connect it again under Settings.`] : ways.length ? [`Signing in with ${names(ways)} keeps working as before.`] : []),
      'The link works for one hour. If you did not ask for it, ignore this email and nothing changes.'],
    cta: { label: 'Choose a password', url }, expiresAt: until });
}

route('POST', '/auth/reset', async (c) => {
  const b = await c.body();
  const r = get('SELECT * FROM password_resets WHERE token_hash=? AND expires_at > ?', sha256(str(b.token)), now());
  if (!r) throw bad('This reset link has expired. Ask for a new one.');
  await newPasswordOk(str(b.password, 200), { userId: r.user_id });
  // The check above waited for an answer: the link is looked at once more, so it still chooses one password only.
  if (!get('SELECT 1 x FROM password_resets WHERE token_hash=? AND user_id=? AND expires_at > ?', r.token_hash, r.user_id, now())) throw bad('This reset link has expired. Ask for a new one.');
  const hash = hashPassword(str(b.password, 200));
  // Opening this link shows that the address belongs to whoever is choosing the password now. If nobody had shown
  // that before, whatever else leads into the login was put there by someone who never did: it is cut off here, so
  // a stranger who made a login in this person's name does not stay in it. `disconnected` names what was removed.
  let removed: Removed = {};
  const disconnected = tx(() => {
    const was = get('SELECT email, email_verified v FROM users WHERE id=?', r.user_id);
    // What was set up in it goes as well (reclaim.ts). The name was typed by nobody we know either: until the person
    // gives theirs, it is the part of the address before the @, and they are told so.
    if (was && !was.v) removed = forgetEarlierSetup(r.user_id, String(was.email).split('@')[0]);
    const cut = was?.v ? [] : cutEarlierAccess(r.user_id);
    if (cut.length) removed.disconnected = [...new Set(cut.map((p) => (isProviderId(p) ? PROVIDER_NAMES[p] : p)))];
    run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', hash, r.user_id);
    run('DELETE FROM password_resets WHERE user_id=?', r.user_id);
    run('DELETE FROM sessions WHERE user_id=?', r.user_id);
    record('password.reset', { c, by: { type: 'user', id: r.user_id }, member: r.user_id, about: ['user', r.user_id], details: { address_confirmed_now: !was?.v, disconnected: cut.length } });
    return cut;
  });
  // A sign-in that typed the old password and waits for its code ends (twostep.ts).
  notePassword(r.user_id, str(b.password, 200));
  await passwordChanged({ id: r.user_id }, 'email');
  await tellRemoved(get('SELECT email FROM users WHERE id=?', r.user_id), removed, 'You chose a password for your GrowSigning login with the link we emailed to you.');
  // two_step: the next sign-in asks for the code as well, because a reset by email is not a second step (twostep.ts).
  // removed: what was taken out of a login that had never been confirmed, for the page to say (removedText).
  return { ok: true, disconnected: [...new Set(disconnected)].map((p) => (isProviderId(p) ? PROVIDER_NAMES[p] : p)), removed, two_step: twoStepOn(get('SELECT two_step_on_at, two_step_secret FROM users WHERE id=?', r.user_id)) };
}, 'public');

route('POST', '/auth/switch', async (c) => {
  const accountId = str((await c.body()).account_id);
  if (!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', accountId, c.user.id)) throw bad('You are not a member of that account.', 403);
  if (c.auth?.sessionId) run('UPDATE sessions SET account_id=? WHERE id=?', accountId, c.auth.sessionId);
  // Remembered, so the next sign-in opens this workspace and not the oldest one.
  run('UPDATE users SET last_account_id=? WHERE id=?', accountId, c.user.id);
  return { ok: true };
});

route('GET', '/me', (c) => {
  // handed_over: this browser is signed in, but was handed to someone to sign in person and is locked until its
  // owner types their password. The app shows the screen that asks for it, not the sign-in page.
  if (!c.auth) {
    // A browser that a sign-in rule signed out hears why, for the sign-in page to say (secpolicy.ts): every time it
    // asks with that cookie, for a day, so two pages asking at once both hear it. Signing in gives a new cookie.
    const why = endedWhy(readCookie(c.req, SESSION_COOKIE));
    return { user: null, ...(handedOver(c.req) ? { handed_over: handedOver(c.req) } : {}), ...(why ? { signed_out: why } : {}) };
  }
  const a = c.account;
  // The browser says which time zone it is in. Emails with dates in them (renewals, cancellations) use it, so the
  // day in the email is the day on the screen.
  const tz = str(c.req.headers.get('x-tz'), 64);
  if (tz && tz !== c.user.tz && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      run('UPDATE users SET tz=? WHERE id=?', tz, c.user.id);
    } catch {}
  }
  // The sender language the browser asks for, for the emails to this person while they chose none (senderlocale.ts).
  noteSeenLocale(c.user, c.req);
  return {
    user: publicUser(c.user, c),
    // The phone number of this login and whether it still has to be given (signuprules.ts). Only to the person in
    // their own browser: no key reads it, and nobody else on the team is ever sent it.
    ...(c.auth.via === 'session' ? { phone: phoneState(c.user) } : {}),
    role: c.role,
    // The role by name and what it can do (perm.ts): Owner, Admin, Member, or a role the team made.
    my_role: myRole(c),
    account: { id: a.id, name: a.name, plan: a.plan, brand_color: a.brand_color, brand_logo: a.brand_logo, default_reminder_days: a.default_reminder_days, default_expire_days: a.default_expire_days, default_date_format: a.default_date_format || null, default_locale: defaultFor(a), own_docs_default: !!a.own_docs_default, subscription_status: a.subscription_status, paused: a.suspended_at ? a.suspended_reason || 'under review' : null, ends_at: a.promo_code ? null : a.cancel_at, free_with: a.promo_code || null },
    // What the account switched on or off for itself (tenantpolicy.ts): { impact_display, ai_helper, white_label }.
    policy: clientPolicy(a.id),
    // Key dates is on for this account (airepo.ts): the sidebar's More then lists it. Absent otherwise.
    ...(keyDatesOn(a.id) ? { key_dates: true } : {}),
    // Delegates are allowed in this account (delegation.ts): Settings then lists Away and sharing. Absent otherwise.
    ...(delegationOn(a.id) ? { delegation: true } : {}),
    // Admins turned stamps off for members (switches.ts): a member's editor then offers no Stamp field. Absent otherwise.
    ...(c.role === 'member' && !membersMayStamp(a.id) ? { no_stamps: true } : {}),
    // People who can look after the account: the owner, the admins, and a role an admin made only when it keeps both
    // the team and the settings (perm.ts). An "Office manager" without the settings does not count.
    admins: all("SELECT user_id FROM memberships WHERE account_id=? AND role IN ('owner','admin')", a.id)
      .filter((m) => { const t = roleIn(a.id, m.user_id).things; return t.has('team') && t.has('settings'); }).length,
    members: get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', a.id).n,
    ...trustInfo(c),
    // Oldest membership first: the order leaving a team goes by (POST /account/leave), so the Leave dialog can name
    // the workspace the person lands in.
    accounts: all('SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=? ORDER BY m.created_at', c.user.id),
    billing: { enabled: billingEnabled(), signatures: billingEnabled() ? creditSummary(a.id) : null },
    // This server runs under a government agreement (BILLING_MODE=deployment, src/lib/billingmode.ts): the one line
    // Settings, Plan shows in place of the plan. Absent otherwise, so the plan draws at once without a second request.
    ...(isDeploymentBilling() ? { agreement: agreementLine(agreementOf()) } : {}),
    outbox: devOutbox(),
    // Whether the operator of this server has switched text messages on. When not, nothing offers them.
    text_messages: !!smsProvider(),
    // Whether the account's admins switched on "People may sign on paper" (paper.ts). When not, nothing offers it.
    paper_signing: paperOn(a.id),
    // Whether this server sends the signing link by WhatsApp, and can call a number to read a code (src/lib/channels.ts).
    whatsapp: !!whatsappProvider(),
    phone_calls: !!voiceProvider(),
    // How many WhatsApp messages one account can cause in 24 hours, for the admin's line in Settings. Only when on.
    ...(whatsappProvider() ? { whatsapp_daily: waDailyPerAccount() } : {}),
    // Whether this server turns Word, Excel and other files into a PDF on upload. When not, nothing offers them.
    converts: converterOn(),
    // Set when an email to this login came back for good ({ address, since, reason }), so every page can say so
    // until the address is changed or the person says it works again. null otherwise. See routes-bounces.ts.
    email_problem: emailProblem(c.user),
    // Two-step login: whether it is on, and whether this account asks for it while it is not (setup_required: the app
    // shows the screen that sets it up and nothing else). See twostep.ts.
    two_step: twoStepMe(c),
    // The sign-in rules of this account that the app acts on: the idle sign-out and a password that is too short.
    ...rulesMe(c),
    // An admin of an organisation above accounts sees Settings, Organisation (src/server/orgs.ts). Absent otherwise.
    ...(c.auth.via === 'session' && adminOrgs(c.user.id).length ? { org_admin: true } : {}),
    // Counter: only for a person an admin gave the counter permission (counter.ts). Absent otherwise.
    ...counterMe(c),
    // The organisation above this account, if any: who set the two-step rule, and sending switched off from above.
    ...orgMe(a),
  };
}, 'public');

route('PATCH', '/me', async (c) => {
  const b = await c.body();
  for (const k of ['signature_png', 'initials_png']) if (b[k] != null && b[k] !== '' && !okImage(b[k])) throw bad('That signature image is too large or not a PNG or JPEG.');
  const notify = b.notify && typeof b.notify === 'object' ? JSON.stringify({ ...notifyPrefs(c.user), ...Object.fromEntries(Object.entries(b.notify).filter(([k, v]) => k in notifyPrefs(null) && typeof v === 'boolean')) }) : c.user.notify;
  // Emails to recipients go out under this name, also the ones about envelopes that are already out. So a name
  // that reads like a well-known brand is refused here, while the checks apply to the account, and not only at
  // the next send.
  const renamed = b.name != null && str(b.name, 120).trim() !== c.user.name && hasNotPaid(c.account) ? nameRefusal([str(b.name, 120)]) : null;
  if (renamed) throw bad(`${renamed} Nothing was changed.`, 422);
  // The language of this person's own screens and of the emails to them (Settings, Profile; senderlocale.ts). Checked
  // before anything is written, so a refusal changes nothing.
  const locale = askedSenderLocale(b.locale);
  if (locale !== undefined) run('UPDATE users SET locale=? WHERE id=?', locale, c.user.id);
  run('UPDATE users SET name=?, title=?, company=?, notify=? WHERE id=?',
    str(b.name ?? c.user.name, 120).trim() || c.user.name, str(b.title ?? c.user.title, 120) || null, str(b.company ?? c.user.company, 120) || null, notify, c.user.id);
  // The saved signature and initials are written only when this request sends them. Written back as read, a value
  // this server cannot open (a key missing after a restart) would be lost for good (colcrypt.ts openValue).
  for (const k of ['signature_png', 'initials_png'] as const)
    if (b[k] !== undefined) run(`UPDATE users SET ${k}=? WHERE id=?`, seal(`users.${k}`, b[k] || null), c.user.id);
  return { user: publicUser(get('SELECT * FROM users WHERE id=?', c.user.id), c) };
});

route('POST', '/me/password', async (c) => {
  const b = await c.body();
  // Someone who signs in with Google or Microsoft has no current password to type. The first one is chosen through
  // a link sent to their address (POST /me/signin/password-link), which shows the mailbox is theirs.
  if (!hasPassword(c.user)) throw bad(`This login has no password yet. Under Settings, Security, Ways to sign in, choose "Email me a link to set a password". The link goes to ${c.user.email}.`);
  if (!checkPassword(str(b.current, 200), c.user.password_hash)) throw bad('Your current password is not right.');
  // A moment we hold the current password: whether it is shorter than a team asks is noted again (secpolicy.ts).
  notePassword(c.user.id, str(b.current, 200));
  // Before the code is asked for: a password that is refused must not use up the code that was typed with it.
  await newPasswordOk(str(b.password, 200), { userId: c.user.id });
  await needCode(c, b.code, 'change your password');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(str(b.password, 200)), c.user.id);
  notePassword(c.user.id, str(b.password, 200));
  run('DELETE FROM sessions WHERE user_id=? AND id != ?', c.user.id, c.auth?.sessionId || '');
  record('password.changed', { c, member: c.user.id, about: ['user', c.user.id] });
  // A sign-in that typed the old password and waits for its code ends, and a reset by email under way stops.
  await passwordChanged(c.user, 'settings');
  return { ok: true };
});

// ---- Where a person is signed in -------------------------------------------------------------
// Every browser that signed in has a session of its own, and signing in on one never signs another out. Here a
// person sees them (the device and browser as the browser described itself, when it signed in, when it was last
// used) and ends the ones that should not be signed in any more: a phone that was lost, a computer at work. What
// names a session to the page is a short fingerprint of its row, never the cookie or the hash we look it up by.
// No API key reaches these routes (PERSON_ONLY in router.ts).
const sessionHandle = (s: any): string => sha256(`session:${s.id}`).slice(0, 16);
// Only what still signs in: also not a row past the most a session may last (sessionEnd in auth.ts).
const sessionsOf = (userId: string): any[] => all('SELECT * FROM sessions WHERE user_id=? AND expires_at > ?', userId, now()).filter((s) => sessionEnd(s) > Date.now());
route('GET', '/me/sessions', (c) => {
  const mine = sessionsOf(c.user.id).map((s) => ({
    id: sessionHandle(s), ...deviceName(s.ua), signed_in_at: s.created_at || null, last_used_at: s.last_used_at || null, signs_out_at: new Date(sessionEnd(s)).toISOString(),
    current: s.id === c.auth?.sessionId, handed_over: !!s.locked_at,
  }));
  // This browser first, then the most recently used.
  mine.sort((a, b) => Number(b.current) - Number(a.current) || String(b.last_used_at || b.signed_in_at || '').localeCompare(String(a.last_used_at || a.signed_in_at || '')));
  return { sessions: mine, days: SESSION_DAYS, max_days: SESSION_MAX_DAYS, noted_every_minutes: SESSION_TOUCH_MINUTES };
});
route('POST', '/me/sessions/sign-out-others', (c) => {
  const n = Number(run('DELETE FROM sessions WHERE user_id=? AND id != ?', c.user.id, c.auth?.sessionId || '').changes);
  // "Every browser except this one" covers two-step login too: a lost phone that is remembered there would sign in
  // again with a saved password alone. Only this browser stays remembered.
  const keep = rememberedDevice(c, c.user)?.id || '';
  const forgot = Number(run('DELETE FROM two_step_devices WHERE user_id=? AND id != ?', c.user.id, keep).changes);
  // And a sign-in somewhere else that is waiting for its code does not finish either.
  run('DELETE FROM two_step_pending WHERE user_id=?', c.user.id);
  record('signout.everywhere', { c, member: c.user.id, about: ['user', c.user.id], details: { signed_out: n, devices_forgotten: forgot } });
  return { ok: true, signed_out: n, ...(forgot ? { two_step_devices_forgotten: forgot } : {}) };
});
route('DELETE', '/me/sessions/:id', (c) => {
  const s = sessionsOf(c.user.id).find((x) => sessionHandle(x) === c.params.id);
  if (!s) throw bad('That browser is not signed in any more, so there was nothing to sign out.', 404);
  run('DELETE FROM sessions WHERE id=?', s.id);
  const current = s.id === c.auth?.sessionId;
  record('session.ended', { c, member: c.user.id, about: ['user', c.user.id], details: { how: current ? 'signed_out' : 'ended_from_settings' } });
  if (current) c.cookies.push(cookie(SESSION_COOKIE, '', 0, c.secure));
  return { ok: true, current };
});

// ---- Account, team -------------------------------------------------------------------------

route('PATCH', '/account', async (c) => {
  const b = await c.body();
  if (b.brand_color && !/^#[0-9a-f]{6}$/i.test(b.brand_color)) throw bad('Brand colour must look like #1f6f43.');
  if (b.brand_logo && !okImage(b.brand_logo, 300_000)) throw bad('Logo must be a PNG or JPEG under 200 KB.');
  const a = c.account;
  // Nothing sent, null, an empty string or anything that is not a number leaves the setting as it is: Number(null)
  // and Number('') are 0, and 0 would switch reminders off without anyone having asked for that.
  const days = (v: any, lo: number, hi: number, d: number) => (v == null || typeof v === 'boolean' || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  // The account's name is the brand line of every email, also for envelopes that are already out: see PATCH /me.
  const renamed = b.name != null && str(b.name, 120).trim() !== a.name && hasNotPaid(a) ? nameRefusal([str(b.name, 120)]) : null;
  if (renamed) throw bad(`${renamed} Nothing was changed.`, 422);
  // The date format new envelopes start with. One that does not exist is refused, never swapped for another.
  if (b.default_date_format != null && b.default_date_format !== '' && !(DATE_FORMATS as readonly string[]).includes(b.default_date_format))
    throw bad(`The date format "${str(b.default_date_format, 40)}" does not exist. Use one of: ${DATE_FORMATS.join(', ')}. Nothing was changed.`);
  // The language new recipients start in (locales.ts): checked before anything is written, like the date format.
  const locale = b.default_locale === undefined ? undefined : chosenLocale(b.default_locale, 'The default language ("default_locale")', 'Nothing was changed.');
  if (b.own_docs_default !== undefined && typeof b.own_docs_default !== 'boolean') throw bad('"own_docs_default" is true or false. Nothing was changed.');
  if (b.default_date_format !== undefined) run('UPDATE accounts SET default_date_format=? WHERE id=?', b.default_date_format || null, a.id);
  if (locale !== undefined) run('UPDATE accounts SET default_locale=? WHERE id=?', locale, a.id);
  // "Each person sees only their files" for new envelopes and templates (visibility.ts). A yes or a no, nothing else.
  if (b.own_docs_default !== undefined) run('UPDATE accounts SET own_docs_default=? WHERE id=?', b.own_docs_default ? 1 : 0, a.id);
  run('UPDATE accounts SET name=?, brand_color=?, brand_logo=?, default_reminder_days=?, default_expire_days=? WHERE id=?',
    str(b.name ?? a.name, 120).trim() || a.name, b.brand_color === undefined ? a.brand_color : b.brand_color || null,
    b.brand_logo === undefined ? a.brand_logo : b.brand_logo || null, days(b.default_reminder_days, 0, 60, a.default_reminder_days), days(b.default_expire_days, 1, 365, a.default_expire_days), a.id);
  settingsChanged({ c }, a, get('SELECT * FROM accounts WHERE id=?', a.id), { name: 'value', brand_color: 'value', brand_logo: 'changed', default_reminder_days: 'value', default_expire_days: 'value', default_date_format: 'value', default_locale: 'value', own_docs_default: 'value' });
  return { ok: true };
}, 'admin');

route('GET', '/account/members', (c) => ({
  // role_id and role_name: a role the team made (perm.ts), on top of the built-in role it started from.
  // can: what each one's role can do, so the Team page offers only the changes the server allows and counts who
  // can really look after the account.
  members: all('SELECT u.id, u.name, u.email, m.role, m.created_at, p.id role_id, p.name role_name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN perm_profiles p ON p.id=m.profile_id AND p.account_id=m.account_id WHERE m.account_id=? ORDER BY m.created_at', c.account.id)
    .map((m) => ({ ...m, can: [...roleIn(c.account.id, m.id).things] })),
  invites: can(c, 'team') ? all('SELECT i.id, i.email, i.role, i.created_at, p.id role_id, p.name role_name FROM invites i LEFT JOIN perm_profiles p ON p.id=i.profile_id AND p.account_id=i.account_id WHERE i.account_id=? AND i.accepted_at IS NULL', c.account.id) : [],
  // "Members are managed by your directory" (scim.ts): the Team tab shows that line in place of Invite.
  managed_by_directory: directoryManaged(c.account.id),
}));

route('POST', '/account/invites', async (c) => {
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  // "admin", "member", or a role the team made (its id, perm.ts). Nobody invites with more than their own role allows.
  const given = givenRole(c, b.role);
  const role = given.role;
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  // A new login cannot be made with a + in its address (signuprules.ts), so nobody is invited at one. Someone who
  // already has a login with exactly this address keeps it and can be invited as before.
  if (plusInEmail(email) && !get('SELECT 1 x FROM users WHERE email=?', email)) throw bad(PLUS_INVITE_REFUSAL, 400, { code: 'plus_in_email' });
  // Nobody is invited into an account that is about to be deleted.
  if (c.account.closing_at) throw bad(closingText(c.account, 'Nobody can be invited to it now'), 403);
  // An account whose members come from its directory invites nobody by hand (scim.ts).
  invitesAllowed(c.account.id);
  if (get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email=?', c.account.id, email)) throw bad('That person is already on the team.');
  // An invitation is an email to an address the inviter typed, under names the inviter chose. So it has the rules an
  // envelope has: a confirmed address first, then the pause, the check on the names it prints and a daily limit of
  // its own (inviteRefusal). Without them it was a way to mail any words to anyone from a login one minute old.
  if (!c.user.email_verified) throw bad('Confirm your email address before you invite anyone. Type the 6-digit code from our email at the top of the app, or press the button in that email. "Send a new code" there emails a new one.', 403);
  const no = inviteRefusal(c.account, c.user, email);
  if (no) throw bad(no.message, no.status);
  // Only in an account below an organisation, about an admin of that organisation: they may join as a member only.
  if (c.account.org_id) refuseOrgAdminRole(c.account.id, get('SELECT id FROM users WHERE lower(email)=lower(?)', email)?.id, role);
  run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', c.account.id, email);
  const t = token();
  const inviteId = id('inv');
  run('INSERT INTO invites (id, token, account_id, email, role, created_at, profile_id) VALUES (?,?,?,?,?,?,?)', inviteId, t, c.account.id, email, role, now(), given.profile_id);
  record('member.invited', { c, about: ['invite', inviteId], details: { role, ...(given.profile_id ? { role_name: given.name } : {}) } });
  noteInvited(c.account.id, email);
  // Someone who already has a login joins by signing in. Everyone else makes a login first. The email goes to the
  // invited address only, so it tells the person inviting nothing about who has an account.
  const known = !!get('SELECT 1 x FROM users WHERE email=?', email);
  await sendMail({ to: email, about: c.user.id, subject: `${c.user.name} invited you to ${c.account.name} on GrowSigning`, heading: `Join ${c.account.name}`,
    lines: [`${c.user.name} invited you to send and sign documents together. Every subscription plants trees.`, ...(known ? ['You already have a GrowSigning login with this address. Sign in with it and you are on the team. Anything you already have on GrowSigning stays as it is.'] : [])],
    cta: { label: known ? 'Sign in to accept' : 'Accept invitation', url: `${baseUrl()}/${known ? 'login' : 'signup'}?invite=${t}&email=${encodeURIComponent(email)}` } });
  return { ok: true };
}, 'admin');

route('POST', '/invites/accept', async (c) => {
  const inv = openInvite(str((await c.body()).token), c.user.email);
  tx(() => {
    join(inv, c.user.id, now(), c);
    if (c.auth?.sessionId) run('UPDATE sessions SET account_id=? WHERE id=?', inv.account_id, c.auth.sessionId);
  });
  return { ok: true, joined: inv.account_name };
});

route('DELETE', '/account/invites/:id', (c) => {
  // Withdrawing an invitation changes who can get in: a line in the security record, by role, never the address.
  const inv = get('SELECT role FROM invites WHERE id=? AND account_id=? AND accepted_at IS NULL', c.params.id, c.account.id);
  if (run('DELETE FROM invites WHERE id=? AND account_id=?', c.params.id, c.account.id).changes && inv) record('member.invite_withdrawn', { c, about: ['invite', c.params.id], details: { role: inv.role } });
}, 'admin');

route('PATCH', '/account/members/:id', async (c) => {
  const given = givenRole(c, (await c.body()).role);
  const role = given.role;
  const m = get('SELECT role, profile_id FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('Member not found.', 404);
  if (m.role === 'owner') throw bad('The owner role cannot be changed.');
  // Nobody changes the role of someone whose role can do more than their own (perm.ts).
  assertMayManage(c, c.params.id, 'changed');
  refuseOrgAdminRole(c.account.id, c.params.id, role);
  const was = roleIn(c.account.id, c.params.id).name;
  run('UPDATE memberships SET role=?, profile_id=? WHERE account_id=? AND user_id=?', role, given.profile_id, c.account.id, c.params.id);
  if (m.role !== role || (m.profile_id || null) !== given.profile_id)
    record('member.role_changed', { c, about: ['user', c.params.id], details: { from: m.role, to: role, ...(m.profile_id || given.profile_id ? { from_name: was, to_name: given.name } : {}) } });
}, 'admin');

route('DELETE', '/account/members/:id', async (c) => {
  const m = get('SELECT m.role, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('Member not found.', 404);
  if (m.role === 'owner') throw bad('The owner cannot be removed. Make someone else the owner first.');
  assertMayManage(c, c.params.id, 'removed');
  // Nobody removes themselves: whoever leaves must not be the one who keeps their envelopes, and with them the
  // signed copies that arrive later. Another admin does it, and chooses who takes over.
  if (c.params.id === c.user.id) throw bad(`You cannot remove yourself from ${c.account.name} this way. To leave, use "Leave this team" on the Team tab (POST /account/leave): you choose who takes over your envelopes, templates and bulk sends, and nothing you sent is lost. To give up your whole login instead, use Settings, Records and data.`);
  // Their envelopes, templates and bulk sends stay with the team: they pass to a chosen successor, or to whoever
  // removed them. The successor is someone who stays. A name we do not know is refused, never quietly replaced.
  const to = c.q.get('to');
  if (to && (to === c.params.id || !get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', c.account.id, to)))
    throw bad(`Choose another member of ${c.account.name} to take over what ${m.name} sent. The person named in "to" is not on the team. Nothing was changed.`);
  // Someone who is closing their own login is not someone who stays: what they were handed would move a second
  // time when their login is deleted. The same rule as on POST /account/leave.
  const closing = to ? get('SELECT name FROM users WHERE id=? AND closing_at IS NOT NULL', to) : null;
  if (closing) throw bad(`${closing.name} is closing their login, so they cannot take over what ${m.name} sent. Choose someone else. Nothing was changed.`);
  const successor = to || c.user.id;
  const keys = all('SELECT id, name, prefix, scope, last_used_at FROM api_keys WHERE account_id=? AND user_id=? AND stopped_at IS NULL', c.account.id, c.params.id);
  const admins = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND m.user_id!=?", c.account.id, c.params.id);
  // Their API keys stop with them, and whatever used those keys breaks. Nobody should learn that from a failing
  // integration. The keys stay listed as stopped, and the answer, the admins and the person removed are all told
  // which ones they were.
  const handed = tx(() => {
    const n = handOver(c.account.id, { id: c.params.id, name: m.name, email: m.email }, successor, c.actor, `${m.name} was removed from the team`);
    run('DELETE FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
    run('DELETE FROM sessions WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
    run('UPDATE api_keys SET stopped_at=? WHERE account_id=? AND user_id=? AND stopped_at IS NULL', now(), c.account.id, c.params.id);
    record('member.removed', { c, about: ['user', c.params.id], details: { role: m.role, keys_stopped: keys.length, handed_over: n, handed_to: successor } });
    return n;
  });
  if (keys.length) {
    const n = keys.length === 1 ? 'An API key' : `${keys.length} API keys`;
    const list = keyList(keys);
    for (const a of admins)
      await sendMail({ to: a.email, about: c.params.id, subject: `${n} stopped working: ${m.name} was removed from ${c.account.name}`, heading: `${n} stopped working`,
        lines: [`${c.user.name} removed ${m.name} from ${c.account.name}. The API keys ${m.name} created stopped working at that moment:`, list, 'Anything that used one of them now gets an error that says the key has stopped. To carry on, create a new key and put it into the integration.'],
        cta: { label: 'Open API keys', url: `${baseUrl()}/app/settings?tab=developers` } });
  }
  // The person removed hears it from us, in words, and not from a sign-in that suddenly opens an empty workspace.
  const heir = get('SELECT name FROM users WHERE id=?', successor);
  // Where they land is said as it is, by the rule signing in follows (signInAs): the workspace they used last if they
  // still belong to it, else the one they joined first, else a new one of their own.
  const mine: any[] = all('SELECT a.id, a.name FROM memberships x JOIN accounts a ON a.id=x.account_id WHERE x.user_id=? ORDER BY x.created_at', c.params.id);
  const last = get('SELECT last_account_id l FROM users WHERE id=?', c.params.id)?.l;
  const lands = (mine.find((a) => a.id === last) || mine[0])?.name;
  await sendMail({ to: m.email, subject: `You were removed from ${c.account.name} on GrowSigning`, heading: `You are no longer on the team ${c.account.name}`,
    lines: [`${c.user.name} removed you from ${c.account.name}. You can no longer open that team's documents.`,
      handed ? `Nothing you sent there is lost: your envelopes, drafts, templates and bulk sends now belong to ${heir?.name || 'another member of the team'}, and anything out for signature carries on.` : 'You had sent nothing there, so there was nothing to hand over.',
      ...(keys.length ? [`The API keys you created there stopped working at that moment:`, keyList(keys), `If something still uses one of them, it now gets an error. Ask an admin of ${c.account.name} for a new key.`] : []),
      `Your own login stays. The next time you sign in you are in ${lands ? `${lands}, another workspace you belong to` : 'a workspace of your own'}, and documents other people sent you to sign are still in your inbox there. If you think this was a mistake, ask the person who removed you: they can invite you back at any time.`],
    cta: { label: 'Sign in', url: `${baseUrl()}/login` } });
  return { ok: true, keys_stopped: keys, handed_over: handed, handed_to: successor };
}, 'admin');

// Leaving a team is the member's own decision and needs nobody's permission. What they sent stays with the team:
// it passes to the member they choose, or to the owner. The owner is the one person who cannot walk out, because
// the account would have nobody responsible for it: they hand it over first, or close it.
route('POST', '/account/leave', async (c) => {
  const to = str((await c.body()).to);
  const me = { id: c.user.id, name: c.user.name, email: c.user.email };
  // Everything is decided inside one transaction, after the body was read, from the rows as they are now and not
  // from what the sign-in found. Two requests at the same moment (the owner handing the account to this person, the
  // chosen successor leaving too, or Leave pressed twice) must never leave the account without an owner, hand what
  // was sent to someone who is no longer on the team, or tell the admins twice.
  const { others, heir, keys, ...left } = tx(() => {
    const role = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', c.account.id, me.id)?.role;
    if (!role) throw bad(`You are no longer on the team ${c.account.name}, so there was nothing to leave. Nothing was changed. Reload the page to see the workspace you are in now.`, 409);
    if (role === 'owner') throw bad(`You own ${c.account.name}, so you cannot leave it. Make someone else the owner first (Team tab, Make owner) and then leave, or close the account under Settings, Records and data.`);
    const others: any[] = all('SELECT m.user_id, m.role, u.name, u.email, u.closing_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id!=?', c.account.id, me.id);
    // The successor is someone who stays. Without a choice it is the owner. A name we do not know is refused.
    const heir = to ? others.find((o) => o.user_id === to) : others.find((o) => o.role === 'owner');
    if (!heir) throw bad(`Choose a member of ${c.account.name} to take over what you sent. The person named in "to" is not on the team. Nothing was changed.`);
    if (heir.closing_at) throw bad(`${heir.name} is closing their login, so they cannot take over what you sent. Choose someone else. Nothing was changed.`);
    const keys = all('SELECT id, name, prefix, scope, last_used_at FROM api_keys WHERE account_id=? AND user_id=? AND stopped_at IS NULL', c.account.id, me.id);
    const handed = handOver(c.account.id, me, heir.user_id, c.actor, `${me.name} left the team`);
    run('DELETE FROM memberships WHERE account_id=? AND user_id=?', c.account.id, me.id);
    run('UPDATE api_keys SET stopped_at=? WHERE account_id=? AND user_id=? AND stopped_at IS NULL', now(), c.account.id, me.id);
    // The person stays signed in, in another workspace of theirs. If this was their only one they get their own.
    const next = get('SELECT account_id FROM memberships WHERE user_id=? ORDER BY created_at LIMIT 1', me.id)?.account_id || ownWorkspace(me.id, me.name);
    run('UPDATE sessions SET account_id=? WHERE account_id=? AND user_id=?', next, c.account.id, me.id);
    run('UPDATE users SET last_account_id=? WHERE id=?', next, me.id);
    record('member.left', { c, accounts: c.account.id, about: ['user', me.id], details: { role, keys_stopped: keys.length, handed_over: handed, handed_to: heir.user_id } });
    return { handed, next, others, heir, keys };
  });
  // The people who run the team hear it from us, not from a missing name in a list.
  const n = keys.length === 1 ? 'An API key' : `${keys.length} API keys`;
  for (const a of others.filter((o) => o.role !== 'member' || o.user_id === heir.user_id))
    await sendMail({ to: a.email, about: me.id, subject: `${me.name} left ${c.account.name}`, heading: `${me.name} left the team`,
      lines: [`${me.name} (${me.email}) left ${c.account.name} on GrowSigning and no longer has access to it.`,
        left.handed ? `What ${me.name} sent stays with the team: ${left.handed} ${left.handed === 1 ? 'envelope, draft or template' : 'envelopes, drafts and templates'} and any bulk sends now belong to ${a.user_id === heir.user_id ? 'you' : `${heir.name}`}. Anything out for signature carries on, and each audit trail says who handed it to whom.` : `${me.name} had sent nothing, so there was nothing to hand over.`,
        ...(keys.length ? [`${n} that ${me.name} created stopped working at that moment:`, keyList(keys), 'Anything that used one of them now gets an error that says the key has stopped. To carry on, create a new key and put it into the integration.'] : []),
        'You can invite them back at any time on the Team tab.'],
      cta: { label: 'Open the team', url: `${baseUrl()}/app/settings?tab=team` } });
  return { ok: true, left: c.account.name, now_in: get('SELECT id, name FROM accounts WHERE id=?', left.next), handed_over: left.handed, handed_to: { id: heir.user_id, name: heir.name }, keys_stopped: keys };
});

// Hand the account to someone else, so it never depends on one person's mailbox.
route('POST', '/account/transfer-owner', async (c) => {
  if (c.role !== 'owner') throw bad('Only the current owner can hand the account over.', 403);
  const to = str((await c.body()).user_id);
  // Checked again inside the transaction, after the body was read: the one handing over must still be the owner and
  // the one taking over must still be on the team. Otherwise handing over while that person presses Leave would
  // leave an account with no owner, which nobody could hand on or close.
  tx(() => {
    if (get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.user.id)?.role !== 'owner') throw bad('Only the current owner can hand the account over.', 403);
    if (to === c.user.id) throw bad('You own this account already. Choose another member of this team.');
    if (!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', c.account.id, to)) throw bad('Choose another member of this team. The person you chose is not on the team now, so nothing was changed.');
    // Someone who is closing their own login cannot be handed a team: it would be left without an owner when they go.
    refuseOrgAdminRole(c.account.id, to, 'owner');
    // While everyone at the domains signs in through the account's service, the owner's way back in is their password
    // with two-step login, so the new owner needs it on (orgsso.ts).
    handOverAllowed(c.account.id, to);
    if (get('SELECT closing_at FROM users WHERE id=?', to)?.closing_at) throw bad('That person is closing their login, so the account cannot be handed to them. Choose someone else, or ask them to sign in again first (that keeps their login).');
    run("UPDATE memberships SET role='admin' WHERE account_id=? AND user_id=?", c.account.id, c.user.id);
    run("UPDATE memberships SET role='owner' WHERE account_id=? AND user_id=?", c.account.id, to);
    record('owner.handed_over', { c, about: ['user', to], details: { from: c.user.id, to } });
  });
});

// ---- Contacts ------------------------------------------------------------------------------

// The address book is one list for the account, and admins see all of it. A member is shown, and can change or
// delete, only the people they added themselves (contact_users) or sent to themselves: who a colleague sends to is
// that colleague's business, like their envelopes and their folders.
const ownContacts = (c: Ctx): [string, any[]] => (can(c, 'see_all') ? ['', []]
  : [` AND (id IN (SELECT contact_id FROM contact_users WHERE user_id=?) OR EXISTS (SELECT 1 FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.account_id=contacts.account_id AND e.sender_id=? AND r.email=contacts.email))`, [c.user.id, c.user.id]]);
const keepContact = (c: Ctx, contactId: string) => run('INSERT OR IGNORE INTO contact_users (contact_id, user_id) VALUES (?,?)', contactId, c.user.id);

route('GET', '/contacts', (c) => {
  const [mine, who] = ownContacts(c);
  return { contacts: all(`SELECT id, name, email, company FROM contacts WHERE account_id=?${mine} ORDER BY name COLLATE NOCASE`, c.account.id, ...who) };
});
route('POST', '/contacts', async (c) => {
  const b = await c.body();
  if (!str(b.name).trim() || !isEmail(str(b.email).trim())) throw bad('Enter a name and a valid email address.');
  run('INSERT INTO contacts (id, account_id, name, email, company, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id, email) DO UPDATE SET name=excluded.name, company=excluded.company',
    id('con'), c.account.id, str(b.name, 120).trim(), str(b.email, 254).trim(), str(b.company, 120) || null, now());
  keepContact(c, get('SELECT id FROM contacts WHERE account_id=? AND email=?', c.account.id, str(b.email, 254).trim()).id);
});
route('PATCH', '/contacts/:id', async (c) => {
  const b = await c.body();
  if (!str(b.name).trim() || !isEmail(str(b.email).trim())) throw bad('Enter a name and a valid email address.');
  const [mine, who] = ownContacts(c);
  if (!get(`SELECT 1 x FROM contacts WHERE id=? AND account_id=?${mine}`, c.params.id, c.account.id, ...who)) throw bad('That contact is not in your list any more. Nothing was changed.', 404);
  if (get('SELECT 1 x FROM contacts WHERE account_id=? AND email=? AND id!=?', c.account.id, str(b.email).trim(), c.params.id)) throw bad('Another contact already uses that email address.');
  run('UPDATE contacts SET name=?, email=?, company=? WHERE id=? AND account_id=?', str(b.name, 120).trim(), str(b.email, 254).trim(), str(b.company, 120) || null, c.params.id, c.account.id);
  // Stays in this person's list also when the address was changed to one they have not sent to yet.
  keepContact(c, c.params.id);
});
route('DELETE', '/contacts/:id', (c) => {
  const [mine, who] = ownContacts(c);
  run(`DELETE FROM contacts WHERE id=? AND account_id=?${mine}`, c.params.id, c.account.id, ...who);
});

// ---- API keys and webhooks -----------------------------------------------------------------

// Members see their own keys. Admins see every key in the account, with its owner, because an integration that
// hangs on one person's key is the whole team's business. The secret is never stored, so it can never be shown.
// A key that does not work says so here too: "stopped_at" when its maker left the account (the name is kept on the
// row once their login is gone), "closing" when its maker is closing their login and the key is off until that day.
route('GET', '/api-keys', (c) => ({
  keys: all(`SELECT k.id, k.name, k.prefix, k.scope, k.created_at, k.last_used_at, k.stopped_at, k.user_id, COALESCE(u.name, k.owner_was) owner_name, u.email owner_email,
      CASE WHEN k.stopped_at IS NULL THEN u.closing_at END closing
    FROM api_keys k LEFT JOIN users u ON u.id=k.user_id WHERE k.account_id=?${can(c, 'webhooks') ? '' : ' AND k.user_id=?'} ORDER BY k.created_at`, ...(can(c, 'webhooks') ? [c.account.id] : [c.account.id, c.user.id]))
    .map((k) => ({ ...k, mine: k.user_id === c.user.id })),
}));
// A new key gets the "send" scope: everyday work, no account settings. "admin" has to be asked for by name, and
// only an admin can ask. What neither scope can ever do is listed in router.ts.
route('POST', '/api-keys', async (c) => {
  const b = await c.body();
  if (b.scope != null && b.scope !== 'send' && b.scope !== 'admin') throw bad('Choose what the key may do: "send" for everyday work, or "admin" to also change account settings.');
  // A key sends without a person at the screen, so the login that makes one has given its phone number (signuprules.ts).
  phoneBeforeSend(c);
  // A key reads every document of the account and outlives the browser. Until the address of the login is confirmed,
  // the login may be a stranger's made in somebody else's name (the same rule as for a webhook, below).
  if (!c.user.email_verified) throw bad('Confirm your email address before you create a key. Type the 6-digit code from our email at the top of the app, or press the button in that email. "Send a new code" there emails a new one.', 403);
  const scope = b.scope === 'admin' ? 'admin' : 'send';
  if (scope === 'admin' && !can(c, 'webhooks')) throw bad('Only account admins can create a key with the "admin" scope. Leave the scope out for a "send" key.', 403);
  const key = `tsk_${token(30)}`;
  const keyId = id('key');
  run('INSERT INTO api_keys (id, account_id, user_id, name, prefix, key_hash, created_at, scope) VALUES (?,?,?,?,?,?,?,?)', keyId, c.account.id, c.user.id, str(b.name, 80) || 'API key', key.slice(0, 10), sha256(key), now(), scope);
  record('api_key.created', { c, about: ['api_key', keyId], details: { name: str(b.name, 80) || 'API key', scope } });
  return { key, scope }; // the key is shown once
});
// Revoke your own key, or as an admin any key in the account.
route('DELETE', '/api-keys/:id', (c) => {
  const k = get('SELECT name, scope, user_id, stopped_at FROM api_keys WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (run(`DELETE FROM api_keys WHERE id=? AND account_id=?${can(c, 'webhooks') ? '' : ' AND user_id=?'}`, ...(can(c, 'webhooks') ? [c.params.id, c.account.id] : [c.params.id, c.account.id, c.user.id])).changes)
    record('api_key.revoked', { c, about: ['api_key', c.params.id], details: { name: k?.name, scope: k?.scope, made_by: k?.user_id, was_stopped: !!k?.stopped_at } });
});

// The delivery log, newest first, a page at a time. ?webhook= shows one webhook only, ?before= (the next_before of
// the page before) goes further back.
const DELIVERY_PAGE = 30;
route('GET', '/webhooks', (c) => {
  const hook = c.q.get('webhook');
  const before = Number(c.q.get('before')) || 0;
  const rows = all(`SELECT d.id, d.webhook_id, d.event, d.envelope_id, d.status, d.error, d.attempts, d.at, d.done, d.body IS NOT NULL has_body, w.url
    FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.account_id=?${hook ? ' AND w.id=?' : ''}${before ? ' AND d.id<?' : ''} ORDER BY d.id DESC LIMIT ${DELIVERY_PAGE + 1}`,
    ...[c.account.id, hook, before].filter(Boolean));
  const page = rows.slice(0, DELIVERY_PAGE);
  // A "send" key may read this, but the signing secrets are for people and "admin" keys only.
  const secrets = c.auth?.via !== 'api_key' || c.auth.scope === 'admin';
  return {
    events: WEBHOOK_EVENTS,
    // null: any public https address. A list: the only hosts the operator allows (OUTSIDE_CALLS, WEBHOOK_ALLOW_HOSTS);
    // empty: no webhook can be added or sent on this server (src/lib/outside.ts).
    allowed_hosts: webhookHostsRule(),
    webhooks: all('SELECT id, url, events, active, secret, created_at FROM webhooks WHERE account_id=?', c.account.id).map((w) => (secrets ? w : { ...w, secret: null })),
    deliveries: page.map(deliveryView),
    next_before: rows.length > DELIVERY_PAGE ? page[page.length - 1].id : null,
  };
}, 'admin');
route('POST', '/webhooks', async (c) => {
  const b = await c.body();
  // A webhook hears about every document of the account. Until the address of the login is confirmed, the login may
  // be a stranger's made in somebody else's name, waiting for that person to arrive and send (reclaim.ts).
  if (!c.user.email_verified) throw bad('Confirm your email address before you add a webhook. Type the 6-digit code from our email at the top of the app, or press the button in that email. "Send a new code" there emails a new one.', 403);
  try {
    await assertPublicUrl(str(b.url, 500));
  } catch (e: any) {
    throw bad(e.message);
  }
  if (get('SELECT COUNT(*) n FROM webhooks WHERE account_id=?', c.account.id).n >= MAX_WEBHOOKS) throw bad(`An account can have up to ${MAX_WEBHOOKS} webhooks. Delete one that is no longer used, then add this one.`);
  const events = Array.isArray(b.events) && b.events.length ? b.events.filter((e: any) => WEBHOOK_EVENTS.includes(e)).join(',') : '*';
  const hookId = id('whk');
  run('INSERT INTO webhooks (id, account_id, url, secret, events, created_at) VALUES (?,?,?,?,?,?)', hookId, c.account.id, str(b.url, 500), `whsec_${token(24)}`, events || '*', now());
  // Only the host: the rest of a webhook address often holds a secret of the receiving service.
  record('webhook.created', { c, about: ['webhook', hookId], details: { host: new URL(str(b.url, 500)).host, events: events || '*' } });
  return { ok: true, id: hookId };
}, 'admin');
route('POST', '/webhooks/deliveries/:id/redeliver', async (c) => {
  const d = get('SELECT d.*, d.body IS NOT NULL has_body, w.account_id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=?', Number(c.params.id));
  if (!d || d.account_id !== c.account.id) throw bad('Delivery not found.', 404);
  if (deliveryView(d).state === 'pending') throw bad('This delivery is still being tried. Wait a minute, look at the log again, and send it again if it failed.', 409);
  if (!d.body) throw bad(`This delivery is too old to send again: only the latest ${KEEP_BODIES} deliveries of each webhook are kept in full. Read the envelope itself to see how it stands now.`);
  redeliver(d.webhook_id, d.event, d.envelope_id, d.body);
}, 'admin');
route('DELETE', '/webhooks/:id', (c) => {
  // Its delivery log goes with it. The log holds envelope ids and, for the latest deliveries, what was sent, and
  // nothing else would ever remove it: closing the account only finds the logs of webhooks that still exist.
  tx(() => {
    const w = get('SELECT url, events FROM webhooks WHERE id=? AND account_id=?', c.params.id, c.account.id);
    if (run('DELETE FROM webhooks WHERE id=? AND account_id=?', c.params.id, c.account.id).changes) {
      run('DELETE FROM webhook_deliveries WHERE webhook_id=?', c.params.id);
      let host = '';
      try {
        host = new URL(w?.url).host;
      } catch {}
      record('webhook.removed', { c, about: ['webhook', c.params.id], details: { host, events: w?.events } });
    }
  });
}, 'admin');

// ---- Reports and impact --------------------------------------------------------------------

// GET /reports/summary and the other reports are in routes-reports.ts.

function globalImpact() {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE kind='envelope' AND status='completed'");
  // Only money we know was paid to GrowSigning by one of its accounts counts: the monthly plan and top-ups.
  const pay = get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id IS NOT NULL AND kind IN ('plan','topup')");
  // treesFunded: 5 for every finished signature, free ones included; older ones at what was promised then (impact.ts).
  return { ...impactOf(t.sheets), envelopes: t.envelopes, donatedUsd: pay.cents / 100, treesFunded: treesOfEveryone() };
}
route('GET', '/public/impact', () => globalImpact(), 'public');
route('GET', '/impact', (c) => {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'", c.account.id);
  const pay = get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=? AND kind IN ('plan','topup')", c.account.id);
  return { account: { ...impactOf(t.sheets), envelopes: t.envelopes, donatedUsd: pay.cents / 100, treesFunded: treesOfAccount(c.account.id) }, everyone: globalImpact() };
});

// ---- Public verification -------------------------------------------------------------------

route('POST', '/public/verify', async (c) => {
  rateLimit(`verify:${c.ip}`, 60, 3600_000);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw bad('Choose a PDF to verify.');
  if (file.size > 40_000_000) throw bad('That file is too large.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = sha256(bytes);
  // The digital seal inside the file, when it carries one (src/server/seal.ts): said beside the byte-for-byte answer.
  const seal = await sealForVerify(bytes);
  // A person shown only some of the files has a completed copy of their own, which is just as much this envelope's (visibility.ts).
  const ownOf = envelopeOfCopy(hash);
  const e = get(`SELECT e.id, e.subject, e.completed_at, e.sheets, e.disputed_at, u.name sender FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE ${ownOf ? 'e.id' : 'e.final_sha256'}=? AND e.status='completed'`, ownOf || hash);
  // A file of a completed document whose sender deleted it with their account: we kept its fingerprint, its id and
  // its day, nothing else (keepFingerprint in evidence.ts). "match" stays for a document we still hold.
  // A file an account brought in from elsewhere (importer.ts) is said as such: signed there, never "completed here".
  if (!e) return { match: false, hash, deleted: forgottenFile({ sha256: hash }), imported: importedForVerify(hash), seal };
  const chain = verifyChain(e.id);
  const mask = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
  return {
    // disputed_at: when a person named on it first said they did not sign it, or that it was not them (evidence.ts).
    // own_copy: the file is the completed copy made for one person, holding only their files and the certificate.
    match: true, hash, ...(ownOf ? { own_copy: true } : {}), envelope: { id: e.id, subject: ownOf ? subjectOfCopy(hash, loadEnvelope) : e.subject, completed_at: e.completed_at, sender: e.sender, disputed_at: e.disputed_at || null, ...(e.disputed_at ? disputeFacts(e.id) : {}) }, chain,
    signers: all("SELECT name, email, role, completed_at FROM recipients WHERE envelope_id=? AND role != 'cc' ORDER BY routing_order, position", e.id).map((r) => ({ ...r, email: mask(r.email) })),
    seal,
  };
}, 'public');

// ---- Scheduler and dev outbox --------------------------------------------------------------

route('POST', '/cron', async (c) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(c.req.headers.get('authorization') || '', `Bearer ${secret}`)) throw new HttpError(401, 'Unauthorized.');
  return tick();
}, 'public');

// Without SMTP, emails are only stored. The outbox shows them so every flow can be tried locally.
// It is off in production unless DEV_OUTBOX=1, because it exposes every signing link.
export const devOutbox = () => !process.env.SMTP_URL && (process.env.NODE_ENV !== 'production' || process.env.DEV_OUTBOX === '1');
route('GET', '/dev/outbox', (c) => {
  if (!devOutbox()) throw new HttpError(404, 'Not found');
  if (c.q.get('id')) {
    const m = get('SELECT html FROM emails WHERE id=?', Number(c.q.get('id')));
    // Pictures from this server too ('self'), so the GrowSigning logo in an email (/brand/email-logo.png) shows here as
    // it will in a mail program. Nothing from anywhere else, and the preview frame stays sandboxed.
    return new Response(m?.html || 'Not found', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'" } });
  }
  // Text messages land here too on a machine without a provider (SMS_DEV_OUTBOX=1), with the number masked.
  // delivered_at, bounced_at (with its kind and reason) and complained_at: what the mail provider said afterwards.
  return json({ emails: all('SELECT id, to_email, subject, link, status, at, delivered_at, bounced_at, bounce_kind, bounce_reason, bounce_said, complained_at FROM emails ORDER BY id DESC LIMIT 100'), texts: [...all('SELECT id, to_masked "to", kind, body, status, at FROM texts ORDER BY id DESC LIMIT 100'),
    // WhatsApp messages and calls with a code on a machine without a provider (whatsapp.ts, voice.ts), in the same list.
    ...all("SELECT 'wa' || id id, to_masked \"to\", CASE kind WHEN 'invite' THEN 'link' WHEN 'remind' THEN 'reminder' ELSE kind END kind, 'WhatsApp: ' || body body, status, at FROM wa_messages ORDER BY id DESC LIMIT 50"),
    ...all("SELECT 'call' || id id, to_masked \"to\", 'code' kind, 'Phone call: ' || COALESCE(said, '(not kept)') body, status, at FROM voice_calls ORDER BY id DESC LIMIT 50")].sort((x: any, y: any) => (x.at < y.at ? 1 : -1)) });
}, 'public');
