import { route, json, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { hashPassword, checkPassword, createSession, cookie, SESSION_COOKIE } from './auth.ts';
import { sendMail } from './mail.ts';
import { assertPublicUrl, WEBHOOK_EVENTS, redeliver } from './webhooks.ts';
import { billingEnabled, verifyChain, notifyPrefs } from './envelopes.ts';
import { grant, creditSummary } from './credits.ts';
import { tick } from './cron.ts';
import { trustInfo } from './routes-trust.ts';
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
  if (get('SELECT id FROM users WHERE email=?', email)) throw bad('An account with this email already exists. Sign in instead.', 409);
  const invite = b.invite ? get('SELECT * FROM invites WHERE token=? AND accepted_at IS NULL', str(b.invite)) : null;
  if (b.invite && (!invite || invite.email.toLowerCase() !== email)) throw bad('This invitation is not valid for that email address.');
  const uid = id('usr');
  let accountId = invite?.account_id;
  const t = now();
  tx(() => {
    run('INSERT INTO users (id, email, name, password_hash, email_verified, verify_token, created_at) VALUES (?,?,?,?,?,?,?)', uid, email, name, hashPassword(password), invite ? 1 : 0, token(), t);
    if (invite) {
      run('INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)', invite.account_id, uid, invite.role, t);
      run('UPDATE invites SET accepted_at=? WHERE id=?', t, invite.id);
    } else {
      accountId = id('acc');
      run('INSERT INTO accounts (id, name, created_at) VALUES (?,?,?)', accountId, `${name.split(' ')[0]}'s workspace`, t);
      run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'owner',?)", accountId, uid, t);
      // A few free signatures to try the product with. Once per account.
      grant(accountId, PRICING.welcomeSignatures, 'welcome', accountId);
    }
  });
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
  const m = get('SELECT account_id FROM memberships WHERE user_id=? ORDER BY created_at LIMIT 1', u.id);
  if (!m) throw bad('This user no longer belongs to any account.', 403);
  // Signing in during the grace period after closing an account brings it straight back.
  const restored = !!u.closing_at;
  if (restored) {
    run('UPDATE users SET closing_at=NULL WHERE id=?', u.id);
    run("UPDATE accounts SET closing_at=NULL WHERE id IN (SELECT account_id FROM memberships WHERE user_id=? AND role='owner')", u.id);
  }
  c.cookies.push(createSession(u.id, m.account_id, c.secure));
  return { user: publicUser(u), restored };
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
    await sendMail({ to: u.email, subject: 'Reset your Sign&Grow password', heading: 'Reset your password', lines: ['This link works for one hour. If you did not ask for it, ignore this email.'], cta: { label: 'Choose a new password', url: `${baseUrl()}/reset?token=${t}` } });
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
  return { ok: true };
});

route('GET', '/me', (c) => {
  if (!c.auth) return { user: null };
  const a = c.account;
  return {
    user: publicUser(c.user),
    role: c.role,
    account: { id: a.id, name: a.name, plan: a.plan, brand_color: a.brand_color, brand_logo: a.brand_logo, default_reminder_days: a.default_reminder_days, default_expire_days: a.default_expire_days, subscription_status: a.subscription_status, paused: a.suspended_at ? a.suspended_reason || 'under review' : null, ends_at: a.cancel_at },
    admins: get("SELECT COUNT(*) n FROM memberships WHERE account_id=? AND role IN ('owner','admin')", a.id).n,
    ...trustInfo(c),
    accounts: all('SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?', c.user.id),
    // used/limit are kept at their neutral values for older screens; signatures is the real balance.
    billing: { enabled: billingEnabled(), used: 0, limit: null, signatures: billingEnabled() ? creditSummary(a.id) : null },
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
  if (get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email=?', c.account.id, email)) throw bad('That person is already on the team.');
  run('DELETE FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', c.account.id, email);
  const t = token();
  run('INSERT INTO invites (id, token, account_id, email, role, created_at) VALUES (?,?,?,?,?,?)', id('inv'), t, c.account.id, email, role, now());
  await sendMail({ to: email, subject: `${c.user.name} invited you to ${c.account.name} on Sign&Grow`, heading: `Join ${c.account.name}`, lines: [`${c.user.name} invited you to send and sign documents together. Every subscription plants trees.`], cta: { label: 'Accept invitation', url: `${baseUrl()}/signup?invite=${t}&email=${encodeURIComponent(email)}` } });
  return { ok: true };
}, 'admin');

route('POST', '/invites/accept', async (c) => {
  const inv = get('SELECT * FROM invites WHERE token=? AND accepted_at IS NULL', str((await c.body()).token));
  if (!inv || inv.email.toLowerCase() !== c.user.email.toLowerCase()) throw bad('This invitation is not valid for your account.');
  tx(() => {
    run('INSERT OR IGNORE INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)', inv.account_id, c.user.id, inv.role, now());
    run('UPDATE invites SET accepted_at=? WHERE id=?', now(), inv.id);
    if (c.auth?.sessionId) run('UPDATE sessions SET account_id=? WHERE id=?', inv.account_id, c.auth.sessionId);
  });
  return { ok: true };
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

route('DELETE', '/account/members/:id', (c) => {
  const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
  if (!m) throw bad('Member not found.', 404);
  if (m.role === 'owner') throw bad('The owner cannot be removed. Make someone else the owner first.');
  // Their envelopes and templates stay with the team: they pass to a chosen successor, or to whoever removed them.
  const to = c.q.get('to');
  const successor = to && get('SELECT user_id FROM memberships WHERE account_id=? AND user_id=? AND user_id!=?', c.account.id, to, c.params.id) ? to : c.user.id;
  run('UPDATE envelopes SET sender_id=? WHERE account_id=? AND sender_id=?', successor, c.account.id, c.params.id);
  run('DELETE FROM memberships WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
  run('DELETE FROM sessions WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
  run('DELETE FROM api_keys WHERE account_id=? AND user_id=?', c.account.id, c.params.id);
}, 'admin');

// Hand the account to someone else, so it never depends on one person's mailbox.
route('POST', '/account/transfer-owner', async (c) => {
  if (c.role !== 'owner') throw bad('Only the current owner can hand the account over.', 403);
  const to = str((await c.body()).user_id);
  if (to === c.user.id || !get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', c.account.id, to)) throw bad('Choose another member of this team.');
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

route('GET', '/api-keys', (c) => ({ keys: all('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE account_id=? AND user_id=?', c.account.id, c.user.id) }));
route('POST', '/api-keys', async (c) => {
  const key = `tsk_${token(30)}`;
  run('INSERT INTO api_keys (id, account_id, user_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?,?)', id('key'), c.account.id, c.user.id, str((await c.body()).name, 80) || 'API key', key.slice(0, 10), sha256(key), now());
  return { key }; // shown once
});
route('DELETE', '/api-keys/:id', (c) => {
  run('DELETE FROM api_keys WHERE id=? AND account_id=? AND user_id=?', c.params.id, c.account.id, c.user.id);
});

route('GET', '/webhooks', (c) => ({
  events: WEBHOOK_EVENTS,
  webhooks: all('SELECT id, url, events, active, secret, created_at FROM webhooks WHERE account_id=?', c.account.id),
  deliveries: all('SELECT d.id, d.event, d.envelope_id, d.status, d.error, d.attempts, d.at, d.body IS NOT NULL can_redeliver, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.account_id=? ORDER BY d.id DESC LIMIT 30', c.account.id),
}), 'admin');
route('POST', '/webhooks', async (c) => {
  const b = await c.body();
  try {
    await assertPublicUrl(str(b.url, 500));
  } catch (e: any) {
    throw bad(e.message);
  }
  const events = Array.isArray(b.events) && b.events.length ? b.events.filter((e: any) => WEBHOOK_EVENTS.includes(e)).join(',') : '*';
  run('INSERT INTO webhooks (id, account_id, url, secret, events, created_at) VALUES (?,?,?,?,?,?)', id('whk'), c.account.id, str(b.url, 500), `whsec_${token(24)}`, events || '*', now());
}, 'admin');
route('POST', '/webhooks/deliveries/:id/redeliver', async (c) => {
  const d = get('SELECT d.*, w.account_id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=?', Number(c.params.id));
  if (!d || d.account_id !== c.account.id) throw bad('Delivery not found.', 404);
  if (!d.body) throw bad('This delivery is too old to send again.');
  redeliver(d.webhook_id, d.event, d.envelope_id, d.body);
}, 'admin');
route('DELETE', '/webhooks/:id', (c) => {
  run('DELETE FROM webhooks WHERE id=? AND account_id=?', c.params.id, c.account.id);
}, 'admin');

// ---- Reports and impact --------------------------------------------------------------------

route('GET', '/reports/summary', (c) => {
  const scope = c.admin ? '' : ' AND sender_id=?';
  const p = c.admin ? [c.account.id] : [c.account.id, c.user.id];
  const byStatus = Object.fromEntries(all(`SELECT status, COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope'${scope} GROUP BY status`, ...p).map((r) => [r.status, r.n]));
  const done = get(`SELECT COUNT(*) n, AVG((julianday(completed_at) - julianday(sent_at)) * 24) hours, COALESCE(SUM(sheets),0) sheets FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'${scope}`, ...p);
  const months = all(`SELECT substr(sent_at,1,7) month, COUNT(*) sent, SUM(status='completed') completed FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL${scope} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, ...p).reverse();
  const senders = c.admin ? all("SELECT u.name, COUNT(*) sent, SUM(e.status='completed') completed FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL GROUP BY u.id ORDER BY sent DESC LIMIT 20", c.account.id) : [];
  const sent = Object.entries(byStatus).reduce((n, [k, v]) => n + (k === 'draft' ? 0 : (v as number)), 0);
  return { byStatus, sent, completed: done.n, avgHours: done.hours, completionRate: sent ? done.n / sent : null, months, senders, impact: impactOf(done.sheets) };
});

function globalImpact() {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE kind='envelope' AND status='completed'");
  const pay = get('SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments');
  return { ...impactOf(t.sheets), envelopes: t.envelopes, donatedUsd: pay.cents / 100, treesFunded: mangrovesFor(pay.cents / 100) };
}
route('GET', '/public/impact', () => globalImpact(), 'public');
route('GET', '/impact', (c) => {
  const t = get("SELECT COALESCE(SUM(sheets),0) sheets, COUNT(*) envelopes FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'", c.account.id);
  const pay = get('SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=?', c.account.id);
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
