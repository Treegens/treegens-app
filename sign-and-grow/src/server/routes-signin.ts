import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, token, sha256, now, rateLimit, baseUrl, safeEqual, str, HttpError } from './util.ts';
import { cookie, readCookie, hasPassword, cutEarlierAccess, NO_PASSWORD } from './auth.ts';
import { sendMail } from './mail.ts';
import { sameEmail } from './credits.ts';
import { signInAs, createLogin, sendPasswordLink } from './routes-account.ts';
import { provider, authorizeUrl, exchangeCode, verifyIdToken, identityOf, SignInRefused, type Provider, type Identity } from './oidc.ts';
import { PROVIDER_IDS, PROVIDER_NAMES, SIGNIN_MINUTES, callbackPath, isProviderId, safeNext, signInProviders, SIGNIN_NOTE_COOKIE, type SignInError, type SignInNote } from '../lib/signin.ts';

// Signing in and signing up with Google or Microsoft, next to email and password. The talking to the provider and
// the checking of what it answers are in oidc.ts. This file decides who the person is, and that rule is short:
//
//   A person is the provider's own id for them (provider, subject), kept in the identities table. Never the email
//   address in the token alone: at Microsoft the admin of any organization can put any address there.
//   - An identity we know signs its login in.
//   - An identity we do not know, with the address of an existing login: connected and signed in only when the
//     provider itself stands behind the address (identityOf says when). Otherwise nobody is signed in, and the person
//     is told to sign in with their password once and connect the provider under Settings.
//   - An identity we do not know and an address we do not know: a new login, made the way sign-up makes one.
//   - Someone who is signed in can connect an identity to their own login under Settings.
//
// With no provider configured every route here answers 404 and no page shows a button.

// Over https both cookies carry the "__Host-" prefix. A browser only takes such a cookie from this very host, so a
// neighbouring site under the same domain cannot plant a state of its own (and with it its own sign-in) in
// somebody's browser, or words of its own on the first screen.
const stateCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}sg_signin`;
const noteCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}${SIGNIN_NOTE_COOKIE}`;

const on = (name: string): Provider => {
  const p = isProviderId(name) ? provider(name) : null;
  if (!p) throw new HttpError(404, 'Not found');
  return p;
};
// Every redirect of ours goes to a page of this site, built from APP_URL and a path we chose.
const redirect = (path: string) => new Response(null, { status: 302, headers: { location: `${baseUrl()}${path}`, 'cache-control': 'no-store' } });
const redirectUri = (p: Provider) => `${baseUrl()}${callbackPath(p.id)}`;

route('GET', '/auth/providers', () => ({ providers: signInProviders().map((p) => ({ id: p, name: PROVIDER_NAMES[p] })) }), 'public');

// Starts a sign-in: remembers what it is for, binds it to this browser with a cookie, and returns the provider's
// address to send the browser to. The state travels through the provider and comes back in the callback, the nonce
// comes back inside the signed token, and the PKCE verifier never leaves this server until the code is redeemed.
function begin(c: Ctx, p: Provider, o: { mode: 'login' | 'signup' | 'connect'; invite?: string | null; code?: string | null; next?: string | null; userId?: string | null }): string {
  const state = token(), nonce = token(), verifier = token(48);
  run('DELETE FROM signin_states WHERE expires_at < ?', now());
  run('INSERT INTO signin_states (id, provider, nonce, verifier, mode, invite, code, next, user_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sha256(state), p.id, nonce, verifier, o.mode, o.invite || null, o.code || null, o.next || null, o.userId || null, new Date(Date.now() + SIGNIN_MINUTES * 60_000).toISOString());
  c.cookies.push(cookie(stateCookie(c), state, SIGNIN_MINUTES * 60, c.secure));
  // Someone who comes from an invitation is offered the account with the invited address first.
  const hint = o.invite ? get('SELECT email FROM invites WHERE token=? AND accepted_at IS NULL', o.invite)?.email : null;
  return authorizeUrl(p, { state, nonce, verifier, redirectUri: redirectUri(p), loginHint: hint || undefined });
}

// The buttons on the sign-in and sign-up pages lead here. An invitation, a code typed on the sign-up page and the
// page to open afterwards are kept with the sign-in on our side, so nothing a provider sends back can change them.
route('GET', '/auth/:provider/start', (c) => {
  const p = on(c.params.provider);
  const mode = c.q.get('mode') === 'signup' ? 'signup' : 'login';
  // The cookie that binds a sign-in to this browser only comes back on the address the provider returns to. Someone
  // who opened the site under another name (www, say) is moved to the configured one first, once.
  if (new URL(c.origin).host !== new URL(baseUrl()).host && !c.q.get('moved')) {
    const q = new URLSearchParams(c.q);
    q.set('moved', '1');
    return redirect(`/api/auth/${p.id}/start?${q}`);
  }
  try {
    rateLimit(`signin:${c.ip}`, 30, 900_000);
  } catch {
    return redirect(`/${mode}?${new URLSearchParams({ signin_error: 'busy', provider: p.id })}`);
  }
  const url = begin(c, p, { mode, invite: str(c.q.get('invite'), 200) || null, code: str(c.q.get('code'), 80).trim() || null, next: safeNext(c.q.get('next'), '') || null });
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
}, 'public');

const addIdentity = (userId: string, p: Provider, who: Identity, userEmail: string) =>
  run('INSERT INTO identities (id, provider, subject, user_id, email, vouched, created_at) VALUES (?,?,?,?,?,?,?)', id('idn'), p.id, who.subject, userId, who.email, who.vouched && sameEmail(who.email, userEmail) ? 1 : 0, now());

// The owner of a login hears about every new way into it, however it came about, with what to do if it was not them.
async function tellConnected(user: any, p: Provider, who: Identity, how: 'settings' | 'address' | 'reclaimed', hadPassword = false) {
  const as = who.email ? ` as ${who.email}` : '';
  await sendMail({
    to: user.email, subject: `${p.name} can now open your Sign&Grow login`, heading: `${p.name} was connected to your login`,
    lines: [
      `Signing in with ${p.name}${as} now opens the Sign&Grow login of ${user.email}.`,
      how === 'settings' ? 'It was connected under Settings, by someone who was signed in to your login.'
        : how === 'address' ? `It was connected because ${p.name} confirmed to us that ${who.email} belongs to the person who just signed in there. Your password is unchanged.`
        : `This login was started earlier, but its address had never been confirmed, so we could not know who started it. ${p.name} has now confirmed that the address is yours. To be safe, ${hadPassword ? 'the password that was set before no longer works, ' : ''}every browser that was signed in has been signed out, and API keys made by this login were revoked. ${hadPassword ? 'You can choose a new password under Settings.' : ''} If you did not start this login yourself, look at what is in it under Settings: the team, the API keys and the webhooks.`.replace(/\s+/g, ' ').trim(),
      'If this was you, there is nothing to do.',
      `If it was not you: sign in, open Settings, Profile, and under "Ways to sign in" disconnect ${p.name}. Then change your password, because someone else may know it. If you cannot get in, use "Forgot password" on the sign-in page, or write to us: ${baseUrl()}/help`,
    ],
    cta: { label: 'Open ways to sign in', url: `${baseUrl()}/app/settings?tab=profile` },
  });
}

// Back to the page the person started from, with a code for what happened. The page turns the code into words
// (signInErrorText), so no text from an address bar is ever shown as ours.
function fail(row: any, p: Provider, code: SignInError, email = ''): Response {
  const q = new URLSearchParams({ signin_error: code, provider: p.id });
  // A connection that failed is said under Settings, where it was started. Unless the person is no longer signed
  // in there: then the sign-in page says it, and Settings opens once they are back in.
  if (row?.user_id && code === 'session') return redirect(`/login?${q}&next=${encodeURIComponent('/app/settings?tab=profile')}`);
  if (row?.user_id) return redirect(`/app/settings?tab=profile&${q}`);
  if (row?.invite) q.set('invite', row.invite);
  // The sign-up form shows the invited address and does not let it be changed, so it goes back with the invitation.
  const address = email || (row?.invite ? get('SELECT email FROM invites WHERE token=?', row.invite)?.email : '');
  if (address) q.set('email', address);
  if (row?.code) q.set('code', row.code);
  if (row?.next) q.set('next', row.next);
  // Someone who already has a login belongs on the sign-in page, wherever they started.
  return redirect(`/${row?.mode === 'signup' && code !== 'exists' ? 'signup' : 'login'}?${q}`);
}

// What the sign-in did, for the first screen to say. A cookie this site sets and the landing page reads and clears:
// it only ever holds what the server wrote, never something from an address bar.
function done(c: Ctx, row: any, note: SignInNote): Response {
  c.cookies.push(`${noteCookie(c)}=${encodeURIComponent(JSON.stringify(note))}; Path=/; SameSite=Lax; Max-Age=120${c.secure ? '; Secure' : ''}`);
  return redirect(`/signin/done?next=${encodeURIComponent(safeNext(row.next))}`);
}

route('GET', '/auth/:provider/callback', async (c) => {
  const p = on(c.params.provider);
  // The state works once and only in the browser that started: its line is deleted the moment anyone presents it,
  // and it has to match the cookie. A link that was used twice, took too long, was opened in another browser or was
  // made up by somebody else all end here.
  const inBrowser = readCookie(c.req, stateCookie(c)) || '';
  c.cookies.push(cookie(stateCookie(c), '', 0, c.secure));
  const state = str(c.q.get('state'), 200);
  const row = state ? get('SELECT * FROM signin_states WHERE id=?', sha256(state)) : null;
  if (row) run('DELETE FROM signin_states WHERE id=?', row.id);
  if (!row || row.provider !== p.id || row.expires_at <= now() || !inBrowser || !safeEqual(inBrowser, state)) return fail(null, p, 'expired');
  const back = (code: SignInError, email = '') => fail(row, p, code, email);
  if (c.q.get('error')) {
    const what = str(c.q.get('error'), 80);
    if (what !== 'access_denied') console.error(`[signin] ${p.id} sent the person back with "${what}": ${str(c.q.get('error_description'), 300)}`);
    return back(what === 'access_denied' ? 'cancelled' : 'failed');
  }
  try {
    rateLimit(`login:${c.ip}`, 30, 900_000);
  } catch {
    return back('busy');
  }
  // The code is swapped for an ID token over our own connection to the provider, and the token is then checked
  // here: signature, issuer, audience, expiry and the nonce of this very sign-in.
  let who: Identity;
  try {
    who = identityOf(p, await verifyIdToken(p, await exchangeCode(p, str(c.q.get('code'), 4000), row.verifier, redirectUri(p)), row.nonce));
  } catch (e) {
    if (!(e instanceof SignInRefused)) throw e;
    console.error(`[signin] ${p.id} sign-in refused: ${e.message}`);
    return back(e.code);
  }
  const known = get('SELECT * FROM identities WHERE provider=? AND subject=?', p.id, who.subject);

  // ---- Connecting a provider to the login that is signed in (started under Settings) ----
  if (row.user_id) {
    if (c.auth?.via !== 'session' || c.user.id !== row.user_id) return back('session');
    if (known && known.user_id !== c.user.id) return back('taken');
    if (!known) {
      addIdentity(c.user.id, p, who, c.user.email);
      // The provider stands behind the very address this login has, for the person at this keyboard: it is confirmed.
      if (who.vouched && sameEmail(who.email, c.user.email) && !c.user.email_verified) run('UPDATE users SET email_verified=1 WHERE id=?', c.user.id);
      await tellConnected(c.user, p, who, 'settings');
    }
    return redirect(`/app/settings?tab=profile&${new URLSearchParams({ signin: 'connected', provider: p.id })}`);
  }

  // ---- Signing in, or signing up ----
  const note: SignInNote = {};
  let u: any;
  if (known) {
    u = get('SELECT * FROM users WHERE id=?', known.user_id);
    if (who.email && !sameEmail(who.email, known.email)) run('UPDATE identities SET email=? WHERE id=?', who.email, known.id);
    if (who.vouched && sameEmail(who.email, u.email) && !u.email_verified) run('UPDATE users SET email_verified=1 WHERE id=?', u.id);
  } else {
    if (!who.email) return back('no_email');
    // From here on an address decides something, so attempts on one address are limited as for a password.
    try {
      rateLimit(`login:${who.email}`, 10, 900_000);
    } catch {
      return back('busy');
    }
    const existing = get('SELECT * FROM users WHERE email=?', who.email);
    if (existing && !who.vouched) return back('exists', who.email);
    if (existing) {
      // The provider stands behind the address, so this person owns the login with that address. If nobody had ever
      // confirmed the address, whoever set the login up before has shown nothing: their password and every other
      // way in they left behind stop here, or a stranger who made a login in this person's name would share it.
      const unconfirmed = !existing.email_verified;
      const hadPassword = hasPassword(existing);
      tx(() => {
        if (unconfirmed) {
          cutEarlierAccess(existing.id);
          run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', NO_PASSWORD, existing.id);
          run('DELETE FROM password_resets WHERE user_id=?', existing.id);
        }
        addIdentity(existing.id, p, who, existing.email);
      });
      await tellConnected(existing, p, who, unconfirmed ? 'reclaimed' : 'address', hadPassword);
      u = get('SELECT * FROM users WHERE id=?', existing.id);
      note.linked = p.name;
      if (unconfirmed) note.reclaimed = hadPassword ? 'password' : 'login';
    } else {
      try {
        rateLimit(`signup:${c.ip}`, 10, 3600_000);
      } catch {
        return back('busy');
      }
      try {
        // Exactly as sign-up does it. The login has no password until its owner chooses one.
        const made = await createLogin(c, { name: who.name, email: who.email, passwordHash: NO_PASSWORD, verified: who.vouched, invite: row.invite, code: row.code, via: p.name, also: (uid) => void addIdentity(uid, p, who, who.email) });
        return done(c, row, { created: p.name, joined: made.joined, confirm: !made.user.email_verified });
      } catch (e) {
        // An invitation for another address, or a code we do not know: nothing was created, and the page says which.
        if (!(e instanceof HttpError)) throw e;
        return back(row.invite ? 'invite' : 'code');
      }
    }
  }
  // Everything a password sign-in does from here on: a closing login comes back, the invitation, the workspace.
  Object.assign(note, await signInAs(c, u, row.invite));
  // A code only makes the plan of a new workspace free. Someone who already had a login is told it was not used.
  if (row.code) note.code_unused = true;
  return done(c, row, note);
}, 'public');

// ---- Settings: ways to sign in ---------------------------------------------------------------
// All of it needs a person who is signed in: PERSON_ONLY in router.ts keeps API keys out of every /me/signin route.

route('GET', '/me/signin', (c) => {
  const live = signInProviders();
  const rows = all('SELECT id, provider, email, created_at FROM identities WHERE user_id=? ORDER BY created_at', c.user.id);
  return {
    email: c.user.email, email_verified: !!c.user.email_verified, password: hasPassword(c.user),
    // A provider is listed when it is switched on, or when this login is still connected to it from a time it was.
    providers: PROVIDER_IDS.filter((p) => live.includes(p) || rows.some((r) => r.provider === p)).map((p) => ({
      id: p, name: PROVIDER_NAMES[p], on: live.includes(p),
      connected: rows.filter((r) => r.provider === p).map((r) => ({ id: r.id, email: r.email, since: r.created_at })),
    })),
  };
});

// The same flow as signing in, tied to the login that is signed in now. It starts with a POST from our own page, so
// another site cannot start it in this person's browser.
route('POST', '/me/signin/:provider/connect', (c) => {
  const p = on(c.params.provider);
  rateLimit(`signin:${c.ip}`, 30, 900_000);
  return { url: begin(c, p, { mode: 'connect', userId: c.user.id }) };
});

// A first password is chosen through a link sent to the login's address, which shows the mailbox is theirs.
route('POST', '/me/signin/password-link', async (c) => {
  rateLimit(`pwlink:${c.user.id}`, 5, 3600_000);
  if (hasPassword(c.user)) throw bad('This login already has a password. You can change it on this page with your current password. If you do not remember it, sign out and use "Forgot password" on the sign-in page.');
  // Until the address is confirmed, choosing a password by email cuts off the providers that do not stand behind it
  // (see POST /auth/reset). For someone who is signed in through one of those, that would be a nasty surprise.
  const cut = c.user.email_verified ? [] : all('SELECT provider FROM identities WHERE user_id=? AND vouched=0', c.user.id).map((r) => PROVIDER_NAMES[r.provider as 'google' | 'microsoft'] || r.provider);
  if (cut.length) throw bad(`Confirm your email address first. We sent a confirmation link to ${c.user.email} when your login was made, and you can have it sent again from this page. Until the address is confirmed, choosing a password by email would disconnect ${[...new Set(cut)].join(' and ')} from your login.`, 409, { code: 'confirm_first' });
  await sendPasswordLink(c.user);
  return { ok: true, sent_to: c.user.email };
});

route('DELETE', '/me/signin/:id', (c) => {
  const row = get('SELECT * FROM identities WHERE id=? AND user_id=?', c.params.id, c.user.id);
  if (!row) throw bad('That connection is no longer on your login. Reload the page to see what is connected now.', 404);
  const name = PROVIDER_NAMES[row.provider as 'google' | 'microsoft'] || row.provider;
  // Never the last way in: without a password and without another provider that works here, nobody could ever
  // sign in to this login again.
  const live = signInProviders();
  const others = all('SELECT provider FROM identities WHERE user_id=? AND id!=?', c.user.id, row.id).filter((i) => live.includes(i.provider));
  if (!hasPassword(c.user) && !others.length)
    throw bad(`${name} is the only way into this login, so it was not disconnected: you could never sign in again. Set a password first with "Email me a link to set a password" on this page, or connect another way to sign in. Then you can disconnect ${name}.`, 409, { code: 'last_way_in' });
  run('DELETE FROM identities WHERE id=?', row.id);
  return { ok: true, disconnected: name };
});
