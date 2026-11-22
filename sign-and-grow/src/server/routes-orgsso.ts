// Single sign-on for an organisation: the admin's card under Settings, Security, and the sign-in through the
// organisation's own service. The rules are in orgsso.ts, the talking to the service in oidc.ts.
//
// The sign-in works like Google and Microsoft in routes-signin.ts: a state that works once and only in the browser
// that started (a cookie and a row of signin_states, provider "org:<account>"), PKCE, a nonce, and a token checked
// here. Who the person is: the service's own id for them (issuer and "sub"), kept in identities. An address the
// service gives must be at a claimed domain of that account that uses the service; for such an address the account
// that proved the domain speaks for it, so an existing login with that address is connected (and its owner emailed).
import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, sha256, now, rateLimit, baseUrl, safeEqual, str, isEmail, HttpError } from './util.ts';
import { cookie, readCookie, cutEarlierAccess, NO_PASSWORD } from './auth.ts';
import { signInAs, createLogin } from './routes-account.ts';
import { authorizeUrl, exchangeCode, verifyIdToken, SignInRefused, DiscoveryProblem, type OrgProvider } from './oidc.ts';
import { forgetEarlierSetup } from './reclaim.ts';
import { needCode, twoStepOn } from './twostep.ts';
import { record } from './seclog.ts';
import { sendMail } from './mail.ts';
import {
  ssoAvailable, ssoFor, ssoHours, providerOf, idpView, saveIdp, setRules, removeIdp, noteTried, addDomain, removeDomain, setDomainUse,
  checkDomain, domainView, accountOfProvider, domainUsesSso, issuerProblemWords, enforcing,
} from './orgsso.ts';
import { safeNext, SIGNIN_MINUTES, SIGNIN_NOTE_COOKIE, type SignInNote } from '../lib/signin.ts';
import { SSO_CALLBACK_PATH, type SsoError } from '../lib/orgsso.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);
const stateCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}sg_sso`;
const noteCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}${SIGNIN_NOTE_COOKIE}`;
const redirect = (path: string) => new Response(null, { status: 302, headers: { location: `${baseUrl()}${path}`, 'cache-control': 'no-store' } });
const redirectUri = () => `${baseUrl()}${SSO_CALLBACK_PATH}`;
const lower = (v: unknown) => str(v, 254).trim().toLowerCase();

// Single sign-on decides who gets into an account, so only a person signed in to the app changes it: never a key.
function person(c: Ctx) {
  if (c.auth?.via !== 'session') throw bad(say('sso.err.key'), 403);
  if (!ssoAvailable()) throw bad(say('sso.err.no_key'), 409, { code: 'sso_unavailable' });
}
const ownerOf = (accountId: string) => get("SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role='owner'", accountId);

// ---- Settings, Security: the card ---------------------------------------------------------------------------------

route('GET', '/account/sso', (c) => {
  if (c.auth?.via !== 'session') throw bad(say('sso.err.key'), 403);
  // Without FILE_ENCRYPTION_KEY the client secret cannot be kept, and the card is not shown at all.
  if (!ssoAvailable()) return { available: false };
  const owner = ownerOf(c.account.id);
  return {
    available: true,
    domains: all('SELECT * FROM org_domains WHERE account_id=? ORDER BY created_at', c.account.id).map(domainView),
    service: idpView(c.account.id),
    redirect_uri: redirectUri(),
    session_hours: ssoHours(),
    owner_two_step: !!owner && twoStepOn(owner),
    code_needed: twoStepOn(c.user),
  };
}, 'admin');

route('POST', '/account/sso/domains', async (c) => {
  person(c);
  rateLimit(`ssodomain:${c.account.id}`, 30, 3600_000);
  return { domain: addDomain(c, (await c.body()).domain) };
}, 'admin');

route('POST', '/account/sso/domains/:id/check', async (c) => {
  person(c);
  rateLimit(`ssocheck:${c.account.id}`, 60, 3600_000);
  const d = get('SELECT * FROM org_domains WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!d) throw bad(say('sso.err.domain_gone'), 404);
  return checkDomain(d, c);
}, 'admin');

// Taking a domain out of single sign-on, or removing it, can lift "everyone signs in through it" for that domain, so
// while that rule is on it asks for the two-step code like the switch itself does.
route('PATCH', '/account/sso/domains/:id', async (c) => {
  person(c);
  const b = await c.body();
  if (enforcing(c.account.id)) await needCode(c, b.code, say('sso.code_what'));
  return { domain: setDomainUse(c, c.params.id, b.use_sso) };
}, 'admin');

route('DELETE', '/account/sso/domains/:id', async (c) => {
  person(c);
  const b = await c.body().catch(() => ({}));
  if (enforcing(c.account.id)) await needCode(c, b.code, say('sso.code_what'));
  removeDomain(c, c.params.id);
  return { ok: true };
}, 'admin');

route('PUT', '/account/sso', async (c) => {
  person(c);
  const b = await c.body();
  await needCode(c, b.code, say('sso.code_what'));
  return { service: await saveIdp(c, b) };
}, 'admin');

route('PATCH', '/account/sso/rules', async (c) => {
  person(c);
  const b = await c.body();
  await needCode(c, b.code, say('sso.code_what'));
  return { service: setRules(c, b) };
}, 'admin');

route('DELETE', '/account/sso', async (c) => {
  person(c);
  const b = await c.body().catch(() => ({}));
  await needCode(c, b.code, say('sso.code_what'));
  removeIdp(c);
  return { ok: true };
}, 'admin');

// "Try a sign-in": the admin goes through the service once. Nothing on the sign-in page uses it before that worked.
route('POST', '/account/sso/try', async (c) => {
  person(c);
  rateLimit(`signin:${c.ip}`, 30, 900_000);
  let p: OrgProvider | null;
  try {
    p = await providerOf(c.account.id);
  } catch (e) {
    if (e instanceof DiscoveryProblem) throw bad(issuerProblemWords(e), 400, { why: e.why });
    throw e;
  }
  if (!p) throw bad(say('sso.err.no_service'), 404);
  return { url: begin(c, p, { mode: 'test', userId: c.user.id, hint: c.user.email }) };
}, 'admin');

// ---- The sign-in page ---------------------------------------------------------------------------------------------

// As the person leaves the email box: whether their address goes to an organisation's sign-in. Only the domain is
// looked at, never whether a login exists, and what a domain uses is public in its DNS anyway.
route('GET', '/sso/lookup', (c) => {
  try {
    rateLimit(`ssolookup:${c.ip}`, 120, 900_000);
  } catch {
    return { sso: null };
  }
  const r = ssoFor(lower(c.q.get('email')));
  return { sso: r ? { name: r.name, password: r.enforce ? 'owner_only' : 'allowed' } : null };
}, 'public');

function begin(c: Ctx, p: OrgProvider, o: { mode: 'login' | 'test'; userId?: string | null; invite?: string | null; next?: string | null; hint?: string }): string {
  const state = token(), nonce = token(), verifier = token(48);
  run('DELETE FROM signin_states WHERE expires_at < ?', now());
  run('INSERT INTO signin_states (id, provider, nonce, verifier, mode, invite, code, next, user_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sha256(state), p.id, nonce, verifier, o.mode, o.invite || null, null, o.next || null, o.userId || null, new Date(Date.now() + SIGNIN_MINUTES * 60_000).toISOString());
  c.cookies.push(cookie(stateCookie(c), state, SIGNIN_MINUTES * 60, c.secure));
  return authorizeUrl(p, { state, nonce, verifier, redirectUri: redirectUri(), loginHint: o.hint || undefined });
}

// "Continue with <name> sign-in" leads here, with the address typed on the page.
route('GET', '/sso/start', async (c) => {
  const email = lower(c.q.get('email'));
  const back = (code: SsoError) => redirect(`/login?${new URLSearchParams({ sso_error: code, ...(isEmail(email) ? { email } : {}) })}`);
  // The cookie that binds the sign-in to this browser only comes back on the configured address (see routes-signin.ts).
  if (new URL(c.origin).host !== new URL(baseUrl()).host && !c.q.get('moved')) {
    const q = new URLSearchParams(c.q);
    q.set('moved', '1');
    return redirect(`/api/sso/start?${q}`);
  }
  try {
    rateLimit(`signin:${c.ip}`, 30, 900_000);
  } catch {
    return back('busy');
  }
  const r = ssoFor(email);
  if (!r) return back('off');
  let p: OrgProvider | null = null;
  try {
    p = await providerOf(r.accountId);
  } catch (e) {
    console.error(`[sso] ${r.accountId} discovery failed: ${(e as any)?.message}`);
  }
  if (!p) return back('off');
  const url = begin(c, p, { mode: 'login', invite: str(c.q.get('invite'), 200) || null, next: safeNext(c.q.get('next'), '') || null, hint: email });
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
}, 'public');

function fail(c: Ctx, row: any, code: SsoError, email = ''): Response {
  if (row?.mode === 'test') return redirect(`/app/settings?${new URLSearchParams({ tab: 'security', sso_error: code })}`);
  const q = new URLSearchParams({ sso_error: code });
  if (email) q.set('email', email);
  if (row?.invite) q.set('invite', row.invite);
  if (row?.next) q.set('next', row.next);
  return redirect(`/login?${q}`);
}
function done(c: Ctx, row: any, note: SignInNote): Response {
  c.cookies.push(`${noteCookie(c)}=${encodeURIComponent(JSON.stringify(note))}; Path=/; SameSite=Lax; Max-Age=120${c.secure ? '; Secure' : ''}`);
  return redirect(`/signin/done?next=${encodeURIComponent(safeNext(row.next))}`);
}

const nameOf = (claims: any, email: string) => (typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : [claims.given_name, claims.family_name].filter((x) => typeof x === 'string' && x.trim()).join(' ') || email.split('@')[0] || 'New member').slice(0, 120);
const addIdentity = (userId: string, p: OrgProvider, subject: string, email: string) =>
  run('INSERT INTO identities (id, provider, subject, user_id, email, vouched, created_at) VALUES (?,?,?,?,?,1,?)', id('idn'), p.id, subject, userId, email, now());

// An invitation the server makes for itself when "Add people from these domains as members" is on, so joining goes
// the one way joining always goes (routes-account.ts).
function joinInvite(accountId: string, email: string): string {
  const old = get('SELECT token FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', accountId, email);
  if (old) return old.token;
  const t = token();
  run("INSERT INTO invites (id, token, account_id, email, role, created_at) VALUES (?,?,?,?,'member',?)", id('inv'), t, accountId, email, now());
  return t;
}

route('GET', '/sso/callback', async (c) => {
  const inBrowser = readCookie(c.req, stateCookie(c)) || '';
  c.cookies.push(cookie(stateCookie(c), '', 0, c.secure));
  const state = str(c.q.get('state'), 200);
  const row = state ? get('SELECT * FROM signin_states WHERE id=?', sha256(state)) : null;
  if (row) run('DELETE FROM signin_states WHERE id=?', row.id);
  const accountId = row ? accountOfProvider(row.provider) : null;
  if (!row || !accountId || row.expires_at <= now() || !inBrowser || !safeEqual(inBrowser, state)) return fail(c, c.auth?.via === 'session' && row?.mode === 'test' ? row : null, 'expired');
  if (c.q.get('error')) {
    const what = str(c.q.get('error'), 80);
    if (what !== 'access_denied') console.error(`[sso] ${accountId} sent the person back with "${what}": ${str(c.q.get('error_description'), 300)}`);
    return fail(c, row, what === 'access_denied' ? 'cancelled' : 'failed');
  }
  try {
    rateLimit(`login:${c.ip}`, 30, 900_000);
  } catch {
    return fail(c, row, 'busy');
  }
  let p: OrgProvider | null = null;
  try {
    p = await providerOf(accountId);
  } catch (e) {
    console.error(`[sso] ${accountId} discovery failed: ${(e as any)?.message}`);
  }
  if (!p) return fail(c, row, 'off');
  let claims: Record<string, any>;
  try {
    claims = await verifyIdToken(p, await exchangeCode(p, str(c.q.get('code'), 4000), row.verifier, redirectUri()), row.nonce);
  } catch (e) {
    if (!(e instanceof SignInRefused)) throw e;
    console.error(`[sso] ${accountId} sign-in refused: ${e.message}`);
    return fail(c, row, 'failed');
  }
  // The address the service gives, which it must not say is unconfirmed, at a domain this account proved.
  const email = isEmail(claims.email) ? claims.email.trim().toLowerCase() : '';
  if (!email || claims.email_verified === false) return fail(c, row, 'no_email');
  if (!domainUsesSso(accountId, email)) return fail(c, row, 'domain', row.mode === 'test' ? '' : email);
  const subject = `${p.issuer} ${claims.sub}`;

  // ---- An admin trying the service from Settings ----
  if (row.mode === 'test') {
    const m = c.auth?.via === 'session' && c.user.id === row.user_id ? get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', accountId, c.user.id) : null;
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) return fail(c, row, 'session');
    noteTried(accountId, c.user.id, c);
    return redirect(`/app/settings?${new URLSearchParams({ tab: 'security', sso: 'tried' })}`);
  }

  // ---- Signing in ----
  const rule = ssoFor(email);
  if (!rule || rule.accountId !== accountId) return fail(c, row, 'off', email);
  const known = get('SELECT * FROM identities WHERE provider=? AND subject=?', p.id, subject);
  let u = known ? get('SELECT * FROM users WHERE id=?', known.user_id) : null;
  if (known && known.email !== email) run('UPDATE identities SET email=? WHERE id=?', email, known.id);
  if (!u) {
    try {
      rateLimit(`login:${email}`, 10, 900_000);
    } catch {
      return fail(c, row, 'busy', email);
    }
    const existing = get('SELECT * FROM users WHERE email=?', email);
    if (existing) {
      // Another person of the same service is already connected to this login: two people, one address. Refused.
      if (get('SELECT 1 x FROM identities WHERE user_id=? AND provider=?', existing.id, p.id)) return fail(c, row, 'taken', email);
      tx(() => {
        // Nobody had confirmed the address: whoever started the login showed nothing, so what they left goes (reclaim.ts).
        if (!existing.email_verified) {
          forgetEarlierSetup(existing.id, nameOf(claims, email));
          cutEarlierAccess(existing.id);
          run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', NO_PASSWORD, existing.id);
          run('DELETE FROM password_resets WHERE user_id=?', existing.id);
        }
        addIdentity(existing.id, p!, subject, email);
        record('signin_method.connected', { c, by: { type: 'user', id: existing.id }, member: existing.id, about: ['user', existing.id], details: { provider: p!.name, how: 'organisation_sign_in' } });
      });
      await sendMail({
        to: email, subject: say('sso.mail.connected.subject', { name: p.name }), heading: say('sso.mail.connected.heading', { name: p.name }),
        lines: [say('sso.mail.connected.line1', { name: p.name, email, domain: rule.domain }), say('sso.mail.connected.line2')],
        cta: { label: say('sso.mail.connected.cta'), url: `${baseUrl()}/app/settings?tab=security` },
      }).catch((e) => console.error('[sso] could not email about a connection', e?.message));
      u = get('SELECT * FROM users WHERE id=?', existing.id);
    } else {
      if (c.auth?.via === 'session' && !row.invite && c.user.email !== email) {
        // A browser signed in to someone else: no second login in passing. Sign out first.
        return fail(c, row, 'session', email);
      }
      try {
        rateLimit(`signup:${c.ip}`, 10, 3600_000);
      } catch {
        return fail(c, row, 'busy', email);
      }
      const invite = row.invite || (rule.joinNew ? joinInvite(accountId, email) : null);
      try {
        const made = await createLogin(c, { name: nameOf(claims, email), email, passwordHash: NO_PASSWORD, verified: true, invite, via: p.name, also: (uid) => void addIdentity(uid, p!, subject, email) });
        return done(c, row, { joined: made.joined, sso_made: p.name });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        // An invitation for another address: made again without it.
        const made = await createLogin(c, { name: nameOf(claims, email), email, passwordHash: NO_PASSWORD, verified: true, invite: rule.joinNew ? joinInvite(accountId, email) : null, via: p.name, also: (uid) => void addIdentity(uid, p!, subject, email) });
        return done(c, row, { joined: made.joined, invite_error: e.message, sso_made: p.name });
      }
    }
  }
  const member = !!get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', accountId, u.id);
  const invite = row.invite || (rule.joinNew && !member ? joinInvite(accountId, email) : null);
  const r = await signInAs(c, u, invite, { next: safeNext(row.next), via: p.name });
  if ('two_step' in r) return redirect('/login/two-step');
  return done(c, row, r as SignInNote);
}, 'public');
