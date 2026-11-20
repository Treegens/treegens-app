import { route, json, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { hashPassword, checkPassword, createSession, cookie, SESSION_COOKIE } from './auth.ts';
import { sendMail } from './mail.ts';
import { assertPublicUrl, WEBHOOK_EVENTS, redeliver, deliveryView, MAX_WEBHOOKS, KEEP_BODIES } from './webhooks.ts';
import { billingEnabled, verifyChain, notifyPrefs, closingText } from './envelopes.ts';
import { grant, creditSummary, findFreeCode, sameEmail } from './credits.ts';
import { tick } from './cron.ts';
import { redeemCode } from './routes-billing.ts';
import { trustInfo, keysOf, keyList, tellTeamsAboutKeys, handOver } from './routes-trust.ts';
import { impactOf, PRICING, mangrovesFor } from '../lib/impact.ts';

const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, title: u.title, company: u.company, email_verified: !!u.email_verified, signature_png: u.signature_png, initials_png: u.initials_png, notify: notifyPrefs(u) });
const okImage = (s: any, max = 700_000) => typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < max;

async function sendVerification(u: any) {
  await sendMail({
    to: u.email, subject: 'Confirm your email for Sign&Grow', heading: 'Confirm your email',
    lines: [`Hi ${u.name}, confirm this address so documents sent to you show up in your inbox.`],
    cta: { label: 'Confirm email', url: `${baseUrl()}/verify-email?token=${u.verify_token}` },
  });
}

// A workspace of one's own: made at sign-up, and for someone who signs in and belongs to no account any more
// (removed from their only team), so a login is never a dead end. The welcome signatures go to a person once,
// however many workspaces are made for them.
function ownWorkspace(userId: string, name: string, t = now()): string {
  const accountId = id('acc');
  run('INSERT INTO accounts (id, name, created_at) VALUES (?,?,?)', accountId, `${name.split(' ')[0]}'s workspace`, t);
  run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'owner',?)", accountId, userId, t);
  if (run('UPDATE users SET welcomed_at=? WHERE id=? AND welcomed_at IS NULL', t, userId).changes) grant(accountId, PRICING.welcomeSignatures, 'welcome', accountId);
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
function join(inv: any, userId: string, t = now()) {
  run('INSERT OR IGNORE INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)', inv.account_id, userId, inv.role, t);
  run('UPDATE invites SET accepted_at=? WHERE id=?', t, inv.id);
  run('UPDATE users SET last_account_id=? WHERE id=?', inv.account_id, userId);
}

// ---- Auth ----------------------------------------------------------------------------------

route('POST', '/auth/signup', async (c) => {
  rateLimit(`signup:${c.ip}`, 10, 3600_000);
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim().toLowerCase();
  const password = str(b.password, 200);
  if (!name) throw bad('Tell us your name.');
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  if (password.length < 8) throw bad('Use a password of at least 8 characters.');
  if (get('SELECT id FROM users WHERE email=?', email)) throw bad(b.invite ? 'You already have a Sign&Grow login with this address. Sign in with it and the invitation is accepted.' : 'An account with this email already exists. Sign in instead.', 409);
  const invite = b.invite ? openInvite(str(b.invite), email) : null;
  // A code that makes the plan free is checked before anything is created, so a typo is said out loud instead of
  // quietly giving an ordinary account. It only applies to a new workspace, not to joining someone else's team.
  const typedCode = str(b.code, 80).trim();
  if (typedCode && !invite && !findFreeCode(typedCode)) throw bad('We do not recognise that code. Check the spelling, or leave the code box empty and add it later on the Plan page.');
  const uid = id('usr');
  let accountId = invite?.account_id;
  const t = now();
  tx(() => {
    run('INSERT INTO users (id, email, name, password_hash, email_verified, verify_token, created_at) VALUES (?,?,?,?,?,?,?)', uid, email, name, hashPassword(password), invite ? 1 : 0, token(), t);
    if (invite) join(invite, uid, t);
    else {
      // With a few free signatures to try the product with. Once per person.
      accountId = ownWorkspace(uid, name, t);
      run('UPDATE users SET last_account_id=? WHERE id=?', accountId, uid);
    }
  });
  // A free-plan code entered at sign-up takes effect straight away, and is confirmed by email like one entered later.
  if (typedCode && !invite) await redeemCode(accountId, typedCode);
  const u = get('SELECT * FROM users WHERE id=?', uid);
  if (!invite) await sendVerification(u);
  c.cookies.push(createSession(uid, accountId, c.secure));
  return { user: publicUser(u) };
}, 'public');

route('POST', '/auth/login', async (c) => {
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  rateLimit(`login:${c.ip}`, 30, 900_000);
  rateLimit(`login:${email}`, 10, 900_000);
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (!u || !checkPassword(str(b.password, 200), u.password_hash)) throw bad('That email and password do not match.', 401);
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
  if (b.invite) {
    try {
      joined = openInvite(str(b.invite), u.email);
      tx(() => join(joined, u.id));
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
  return { user: publicUser(u), restored, fresh, joined: joined?.account_name || null, invite_error: inviteError || null };
}, 'public');

route('POST', '/auth/logout', (c) => {
  if (c.auth?.sessionId) run('DELETE FROM sessions WHERE id=?', c.auth.sessionId);
  c.cookies.push(cookie(SESSION_COOKIE, '', 0, c.secure));
  return { ok: true };
}, 'public');

route('POST', '/auth/verify', async (c) => {
  const t = str((await c.body()).token);
  const u = t ? get('SELECT id FROM users WHERE verify_token=?', t) : null;
  if (!u) throw bad('This confirmation link is not valid any more.');
  run('UPDATE users SET email_verified=1 WHERE id=?', u.id);
  return { ok: true };
}, 'public');

route('POST', '/auth/resend-verification', async (c) => {
  rateLimit(`verify:${c.user.id}`, 5, 3600_000);
  if (!c.user.email_verified) await sendVerification(c.user);
  return { ok: true };
});

route('POST', '/auth/forgot', async (c) => {
  rateLimit(`forgot:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (u) {
    const t = token();
    run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(t), u.id, new Date(Date.now() + 3600_000).toISOString());
    // expiresAt: if the mail server will not take this now, it is tried again, but never once the link in it has run out.
    await sendMail({ to: u.email, subject: 'Reset your Sign&Grow password', heading: 'Reset your password', lines: ['This link works for one hour. If you did not ask for it, ignore this email.'], cta: { label: 'Choose a new password', url: `${baseUrl()}/reset?token=${t}` }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  }
  return { ok: true }; // same answer either way, so emails cannot be probed
}, 'public');

route('POST', '/auth/reset', async (c) => {
  const b = await c.body();
  const r = get('SELECT * FROM password_resets WHERE token_hash=? AND expires_at > ?', sha256(str(b.token)), now());
  if (!r) throw bad('This reset link has expired. Ask for a new one.');
  if (str(b.password, 200).length < 8) throw bad('Use a password of at least 8 characters.');
  run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', hashPassword(str(b.password, 200)), r.user_id);
  run('DELETE FROM password_resets WHERE user_id=?', r.user_id);
  run('DELETE FROM sessions WHERE user_id=?', r.user_id);
  return { ok: true };
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
  if (!c.auth) return { user: null };
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
  return {
    user: publicUser(c.user),
    role: c.role,
    account: { id: a.id, name: a.name, plan: a.plan, brand_color: a.brand_color, brand_logo: a.brand_logo, default_reminder_days: a.default_reminder_days, default_expire_days: a.default_expire_days, subscription_status: a.subscription_status, paused: a.suspended_at ? a.suspended_reason || 'under review' : null, ends_at: a.promo_code ? null : a.cancel_at, free_with: a.promo_code || null },
    admins: get("SELECT COUNT(*) n FROM memberships WHERE account_id=? AND role IN ('owner','admin')", a.id).n,
    members: get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', a.id).n,
    ...trustInfo(c),
    accounts: all('SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?', c.user.id),
    billing: { enabled: billingEnabled(), signatures: billingEnabled() ? creditSummary(a.id) : null },
    outbox: devOutbox(),
  };
}, 'public');

route('PATCH', '/me', async (c) => {
  const b = await c.body();
  for (const k of ['signature_png', 'initials_png']) if (b[k] != null && b[k] !== '' && !okImage(b[k])) throw bad('That signature image is too large or not a PNG or JPEG.');
  const notify = b.notify && typeof b.notify === 'object' ? JSON.stringify({ ...notifyPrefs(c.user), ...Object.fromEntries(Object.entries(b.notify).filter(([k, v]) => k in notifyPrefs(null) && typeof v === 'boolean')) }) : c.user.notify;
  run('UPDATE users SET name=?, title=?, company=?, signature_png=?, initials_png=?, notify=? WHERE id=?',
    str(b.name ?? c.user.name, 120).trim() || c.user.name, str(b.title ?? c.user.title, 120) || null, str(b.company ?? c.user.company, 120) || null,
    b.signature_png === undefined ? c.user.signature_png : b.signature_png || null, b.initials_png === undefined ? c.user.initials_png : b.initials_png || null, notify, c.user.id);
  return { user: publicUser(get('SELECT * FROM users WHERE id=?', c.user.id)) };
});

route('POST', '/me/password', async (c) => {
  const b = await c.body();
  if (!checkPassword(str(b.current, 200), c.user.password_hash)) throw bad('Your current password is not right.');
  if (str(b.password, 200).length < 8) throw bad('Use a password of at least 8 characters.');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(str(b.password, 200)), c.user.id);
  run('DELETE FROM sessions WHERE user_id=? AND id != ?', c.user.id, c.auth?.sessionId || '');
  return { ok: true };
});

// ---- Account, team -------------------------------------------------------------------------

route('PATCH', '/account', async (c) => {
  const b = await c.body();
  if (b.brand_color && !/^#[0-9a-f]{6}$/i.test(b.brand_color)) throw bad('Brand colour must look like #1f6f43.');
  if (b.brand_logo && !okImage(b.brand_logo, 300_000)) throw bad('Logo must be a PNG or JPEG under 200 KB.');
  const a = c.account;
  const days = (v: any, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  run('UPDATE accounts SET name=?, brand_color=?, brand_logo=?, default_reminder_days=?, default_expire_days=? WHERE id=?',
    str(b.name ?? a.name, 120).trim() || a.name, b.brand_color === undefined ? a.brand_color : b.brand_color || null,
    b.brand_logo === undefined ? a.brand_logo : b.brand_logo || null, days(b.default_reminder_days, 0, 60, a.default_reminder_days), days(b.default_expire_days, 1, 365, a.default_expire_days), a.id);
  return { ok: true };
}, 'admin');

route('GET', '/account/members', (c) => ({
  members: all('SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', c.account.id),
  invites: c.admin ? all('SELECT id, email, role, created_at FROM invites WHERE account_id=? AND accepted_at IS NULL', c.account.id) : [],
}));

route('POST', '/account/invites', async (c) => {
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  const role = b.role === 'admin' ? 'admin' : 'member';
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  // Nobody is invited into an account that is about to be deleted.
  if (c.account.closing_at) throw bad(closingText(c.account, 'Nobody can be invited to it now'), 403);
  if (get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email=?', c.account.id, email)) throw bad('That person is already on the team.');
  run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', c.account.id, email);
  const t = token();
  run('INSERT INTO invites (id, token, account_id, email, role, created_at) VALUES (?,?,?,?,?,?)', id('inv'), t, c.account.id, email, role, now());
  // Someone who already has a login joins by signing in. Everyone else makes a login first. The email goes to the
  // invited address only, so it tells the person inviting nothing about who has an account.
  const known = !!get('SELECT 1 x FROM users WHERE email=?', email);
  await sendMail({ to: email, subject: `${c.user.name} invited you to ${c.account.name} on Sign&Grow`, heading: `Join ${c.account.name}`,
    lines: [`${c.user.name} invited you to send and sign documents together. Every subscription plants trees.`, ...(known ? ['You already have a Sign&Grow login with this address. Sign in with it and you are on the team. Anything you already have on Sign&Grow stays as it is.'] : [])],
    cta: { label: known ? 'Sign in to accept' : 'Accept invitation', url: `${baseUrl()}/${known ? 'login' : 'signup'}?invite=${t}&email=${encodeURIComponent(email)}` } });
  return { ok: true };
}, 'admin');

route('POST', '/invites/accept', async (c) => {
  const inv = openInvite(str((await c.body()).token), c.user.email);
  tx(() => {
    join(inv, c.user.id);
    if (c.auth?.sessionId) run('UPDATE sessions SET account_id=? WHERE id=?', inv.account_id, c.auth.sessionId);
  });
  return { ok: true, joined: inv.account_name };
});

route('DELETE', '/account/invites/:id', (c) => {
  run('DELETE FROM invites WHERE id=? AND account_id=?', c.params.id, c.account.id);
}, 'admin');

route('PATCH', '/account/members/:id', async (c) => {
  const role = (await c.body()).role === 'admin' ? 'admin' : 'member';
  const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('Member not found.', 404);
  if (m.role === 'owner') throw bad('The owner role cannot be changed.');
  run('UPDATE memberships SET role=? WHERE account_id=? AND user_id=?', role, c.account.id, c.params.id);
}, 'admin');

route('DELETE', '/account/members/:id', async (c) => {
  const m = get('SELECT m.role, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('Member not found.', 404);
  if (m.role === 'owner') throw bad('The owner cannot be removed. Make someone else the owner first.');
  // Nobody removes themselves: whoever leaves must not be the one who keeps their envelopes, and with them the
  // signed copies that arrive later. Another admin does it, and chooses who takes over.
  if (c.params.id === c.user.id) throw bad(`You cannot remove yourself from ${c.account.name}. To leave, ask the owner or another admin to remove you on the Team tab: they choose who takes over your envelopes, templates and bulk sends, and nothing you sent is lost. To give up your whole login instead, use Settings, Your data.`);
  // Their envelopes, templates and bulk sends stay with the team: they pass to a chosen successor, or to whoever
  // removed them. The successor is someone who stays. A name we do not know is refused, never quietly replaced.
  const to = c.q.get('to');
  if (to && (to === c.params.id || !get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', c.account.id, to)))
    throw bad(`Choose another member of ${c.account.name} to take over what ${m.name} sent. The person named in "to" is not on the team. Nothing was changed.`);
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
    return n;
  });
  if (keys.length) {
    const n = keys.length === 1 ? 'An API key' : `${keys.length} API keys`;
    const list = keyList(keys);
    for (const a of admins)
      await sendMail({ to: a.email, subject: `${n} stopped working: ${m.name} was removed from ${c.account.name}`, heading: `${n} stopped working`,
        lines: [`${c.user.name} removed ${m.name} from ${c.account.name}. The API keys ${m.name} created stopped working at that moment:`, list, 'Anything that used one of them now gets an error that says the key has stopped. To carry on, create a new key and put it into the integration.'],
        cta: { label: 'Open API keys', url: `${baseUrl()}/app/settings?tab=developers` } });
    await sendMail({ to: m.email, subject: `Your API keys for ${c.account.name} stopped working`, heading: `${n} of yours stopped working`,
      lines: [`${c.user.name} removed you from ${c.account.name} on Sign&Grow. The API keys you created there stopped working at that moment:`, list, `If something still uses one of them, it now gets an error. Ask an admin of ${c.account.name} for a new key.`] });
  }
  return { ok: true, keys_stopped: keys, handed_over: handed, handed_to: successor };
}, 'admin');

// Hand the account to someone else, so it never depends on one person's mailbox.
route('POST', '/account/transfer-owner', async (c) => {
  if (c.role !== 'owner') throw bad('Only the current owner can hand the account over.', 403);
  const to = str((await c.body()).user_id);
  if (to === c.user.id || !get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', c.account.id, to)) throw bad('Choose another member of this team.');
  // Someone who is closing their own login cannot be handed a team: it would be left without an owner when they go.
  if (get('SELECT closing_at FROM users WHERE id=?', to)?.closing_at) throw bad('That person is closing their login, so the account cannot be handed to them. Choose someone else, or ask them to sign in again first (that keeps their login).');
  tx(() => {
    run("UPDATE memberships SET role='admin' WHERE account_id=? AND user_id=?", c.account.id, c.user.id);
    run("UPDATE memberships SET role='owner' WHERE account_id=? AND user_id=?", c.account.id, to);
  });
});

// ---- Contacts ------------------------------------------------------------------------------

route('GET', '/contacts', (c) => ({ contacts: all('SELECT id, name, email, company FROM contacts WHERE account_id=? ORDER BY name COLLATE NOCASE', c.account.id) }));
route('POST', '/contacts', async (c) => {
  const b = await c.body();
  if (!str(b.name).trim() || !isEmail(str(b.email).trim())) throw bad('Enter a name and a valid email address.');
  run('INSERT INTO contacts (id, account_id, name, email, company, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id, email) DO UPDATE SET name=excluded.name, company=excluded.company',
    id('con'), c.account.id, str(b.name, 120).trim(), str(b.email, 254).trim(), str(b.company, 120) || null, now());
});
route('PATCH', '/contacts/:id', async (c) => {
  const b = await c.body();
  if (!str(b.name).trim() || !isEmail(str(b.email).trim())) throw bad('Enter a name and a valid email address.');
  if (get('SELECT 1 x FROM contacts WHERE account_id=? AND email=? AND id!=?', c.account.id, str(b.email).trim(), c.params.id)) throw bad('Another contact already uses that email address.');
  run('UPDATE contacts SET name=?, email=?, company=? WHERE id=? AND account_id=?', str(b.name, 120).trim(), str(b.email, 254).trim(), str(b.company, 120) || null, c.params.id, c.account.id);
});
route('DELETE', '/contacts/:id', (c) => {
  run('DELETE FROM contacts WHERE id=? AND account_id=?', c.params.id, c.account.id);
});

// ---- API keys and webhooks -----------------------------------------------------------------

// Members see their own keys. Admins see every key in the account, with its owner, because an integration that
// hangs on one person's key is the whole team's business. The secret is never stored, so it can never be shown.
// A key that does not work says so here too: "stopped_at" when its maker left the account (the name is kept on the
// row once their login is gone), "closing" when its maker is closing their login and the key is off until that day.
route('GET', '/api-keys', (c) => ({
  keys: all(`SELECT k.id, k.name, k.prefix, k.scope, k.created_at, k.last_used_at, k.stopped_at, k.user_id, COALESCE(u.name, k.owner_was) owner_name, u.email owner_email,
      CASE WHEN k.stopped_at IS NULL THEN u.closing_at END closing
    FROM api_keys k LEFT JOIN users u ON u.id=k.user_id WHERE k.account_id=?${c.admin ? '' : ' AND k.user_id=?'} ORDER BY k.created_at`, ...(c.admin ? [c.account.id] : [c.account.id, c.user.id]))
    .map((k) => ({ ...k, mine: k.user_id === c.user.id })),
}));
// A new key gets the "send" scope: everyday work, no account settings. "admin" has to be asked for by name, and
// only an admin can ask. What neither scope can ever do is listed in router.ts.
route('POST', '/api-keys', async (c) => {
  const b = await c.body();
  if (b.scope != null && b.scope !== 'send' && b.scope !== 'admin') throw bad('Choose what the key may do: "send" for everyday work, or "admin" to also change account settings.');
  const scope = b.scope === 'admin' ? 'admin' : 'send';
  if (scope === 'admin' && !c.admin) throw bad('Only account admins can create a key with the "admin" scope. Leave the scope out for a "send" key.', 403);
  const key = `tsk_${token(30)}`;
  run('INSERT INTO api_keys (id, account_id, user_id, name, prefix, key_hash, created_at, scope) VALUES (?,?,?,?,?,?,?,?)', id('key'), c.account.id, c.user.id, str(b.name, 80) || 'API key', key.slice(0, 10), sha256(key), now(), scope);
  return { key, scope }; // the key is shown once
});
// Revoke your own key, or as an admin any key in the account.
route('DELETE', '/api-keys/:id', (c) => {
  run(`DELETE FROM api_keys WHERE id=? AND account_id=?${c.admin ? '' : ' AND user_id=?'}`, ...(c.admin ? [c.params.id, c.account.id] : [c.params.id, c.account.id, c.user.id]));
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
    webhooks: all('SELECT id, url, events, active, secret, created_at FROM webhooks WHERE account_id=?', c.account.id).map((w) => (secrets ? w : { ...w, secret: null })),
    deliveries: page.map(deliveryView),
    next_before: rows.length > DELIVERY_PAGE ? page[page.length - 1].id : null,
  };
}, 'admin');
route('POST', '/webhooks', async (c) => {
  const b = await c.body();
  try {
    await assertPublicUrl(str(b.url, 500));
  } catch (e: any) {
    throw bad(e.message);
  }
  if (get('SELECT COUNT(*) n FROM webhooks WHERE account_id=?', c.account.id).n >= MAX_WEBHOOKS) throw bad(`An account can have up to ${MAX_WEBHOOKS} webhooks. Delete one that is no longer used, then add this one.`);
  const events = Array.isArray(b.events) && b.events.length ? b.events.filter((e: any) => WEBHOOK_EVENTS.includes(e)).join(',') : '*';
  run('INSERT INTO webhooks (id, account_id, url, secret, events, created_at) VALUES (?,?,?,?,?,?)', id('whk'), c.account.id, str(b.url, 500), `whsec_${token(24)}`, events || '*', now());
}, 'admin');
route('POST', '/webhooks/deliveries/:id/redeliver', async (c) => {
  const d = get('SELECT d.*, d.body IS NOT NULL has_body, w.account_id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=?', Number(c.params.id));
  if (!d || d.account_id !== c.account.id) throw bad('Delivery not found.', 404);
  if (deliveryView(d).state === 'pending') throw bad('This delivery is still being tried. Wait a minute, look at the log again, and send it again if it failed.', 409);
  if (!d.body) throw bad(`This delivery is too old to send again: only the latest ${KEEP_BODIES} deliveries of each webhook are kept in full. Read the envelope itself to see how it stands now.`);
  redeliver(d.webhook_id, d.event, d.envelope_id, d.body);
}, 'admin');
route('DELETE', '/webhooks/:id', (c) => {
  run('DELETE FROM webhooks WHERE id=? AND account_id=?', c.params.id, c.account.id);
}, 'admin');

// ---- Reports and impact --------------------------------------------------------------------

route('GET', '/reports/summary', (c) => {
  // A completed envelope its sender deleted is counted nowhere here, so these numbers match the lists they link to.
  // The paper it saved was saved all the same, so GET /impact and the public totals still count it.
  const scope = `${c.admin ? '' : ' AND sender_id=?'} AND hidden_at IS NULL`;
  const p = c.admin ? [c.account.id] : [c.account.id, c.user.id];
  const byStatus = Object.fromEntries(all(`SELECT status, COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope'${scope} GROUP BY status`, ...p).map((r) => [r.status, r.n]));
  const done = get(`SELECT COUNT(*) n, AVG((julianday(completed_at) - julianday(sent_at)) * 24) hours, COALESCE(SUM(sheets),0) sheets FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'${scope}`, ...p);
  const months = all(`SELECT substr(sent_at,1,7) month, COUNT(*) sent, SUM(status='completed') completed FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL${scope} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, ...p).reverse();
  const senders = c.admin ? all("SELECT u.name, COUNT(*) sent, SUM(e.status='completed') completed FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL AND e.hidden_at IS NULL GROUP BY u.id ORDER BY sent DESC LIMIT 20", c.account.id) : [];
  const sent = Object.entries(byStatus).reduce((n, [k, v]) => n + (k === 'draft' ? 0 : (v as number)), 0);
  return { byStatus, sent, completed: done.n, avgHours: done.hours, completionRate: sent ? done.n / sent : null, months, senders, impact: impactOf(done.sheets) };
});

function globalImpact() {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE kind='envelope' AND status='completed'");
  // Only money we know was paid to Sign&Grow by one of its accounts counts: the monthly plan and top-ups.
  const pay = get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id IS NOT NULL AND kind IN ('plan','topup')");
  return { ...impactOf(t.sheets), envelopes: t.envelopes, donatedUsd: pay.cents / 100, treesFunded: mangrovesFor(pay.cents / 100) };
}
route('GET', '/public/impact', () => globalImpact(), 'public');
route('GET', '/impact', (c) => {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'", c.account.id);
  const pay = get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=? AND kind IN ('plan','topup')", c.account.id);
  return { account: { ...impactOf(t.sheets), envelopes: t.envelopes, donatedUsd: pay.cents / 100, treesFunded: mangrovesFor(pay.cents / 100) }, everyone: globalImpact() };
});

// ---- Public verification -------------------------------------------------------------------

route('POST', '/public/verify', async (c) => {
  rateLimit(`verify:${c.ip}`, 60, 3600_000);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw bad('Choose a PDF to verify.');
  if (file.size > 40_000_000) throw bad('That file is too large.');
  const hash = sha256(new Uint8Array(await file.arrayBuffer()));
  const e = get("SELECT e.id, e.subject, e.completed_at, e.sheets, u.name sender FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.final_sha256=? AND e.status='completed'", hash);
  if (!e) return { match: false, hash };
  const chain = verifyChain(e.id);
  const mask = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
  return {
    match: true, hash, envelope: { id: e.id, subject: e.subject, completed_at: e.completed_at, sender: e.sender }, chain,
    signers: all("SELECT name, email, role, completed_at FROM recipients WHERE envelope_id=? AND role != 'cc' ORDER BY routing_order, position", e.id).map((r) => ({ ...r, email: mask(r.email) })),
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
    return new Response(m?.html || 'Not found', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" } });
  }
  return json({ emails: all('SELECT id, to_email, subject, link, status, at FROM emails ORDER BY id DESC LIMIT 100') });
}, 'public');
