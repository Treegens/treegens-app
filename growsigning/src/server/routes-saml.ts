// SAML 2.0 sign-in for an organisation (saml.ts): our metadata, the address the identity provider posts its answer
// to (HTTP-POST only), and the step that ends the sign-in in the browser that started it. Starting is in
// routes-orgsso.ts (/sso/start and "Try a sign-in"), which hands a SAML account to beginSaml; what a good answer
// leads to is finishOrgSignIn there, the same for OpenID Connect and SAML. The card's routes are at the end.
//
// Why two steps at the end: the identity provider's page posts to us from its own site, and a browser does not send
// our SameSite=Lax cookies with such a post. So the answer is checked first (/sso/saml/acs), who it vouched for is
// kept on the sign-in's own line for two minutes, and the browser is sent on to /sso/saml/finish, where the cookie
// set when the sign-in started must come back. An answer taken from someone else's browser therefore signs nobody in.
import { route, type Ctx } from './router.ts';
import { get, run } from './db.ts';
import { bad, sha256, now, rateLimit, baseUrl, safeEqual, str } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { needCode } from './twostep.ts';
import { ssoAvailable, accountOfProvider } from './orgsso.ts';
import { finishOrgSignIn } from './routes-orgsso.ts';
import { isSaml, spMetadata, checkAnswer, saveSaml, samlCookie, SamlRefused } from './saml.ts';
import type { SsoError } from '../lib/orgsso.ts';
import type { SamlWhy } from '../lib/samlscim.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);
const redirect = (path: string, status = 302) => new Response(null, { status, headers: { location: `${baseUrl()}${path}`, 'cache-control': 'no-store' } });
const FINISH_SECONDS = 120;
const RESPONSE_MAX = 1_000_000;

/** Back to where the sign-in started. An admin's "Try a sign-in" is also told why a SAML answer was refused (`why`). */
function fail(row: any, code: SsoError, why?: SamlWhy): Response {
  if (row?.mode === 'test') return redirect(`/app/settings?${new URLSearchParams({ tab: 'security', sso_error: code, ...(why ? { sso_why: why } : {}) })}`, 303);
  const q = new URLSearchParams({ sso_error: code });
  if (row?.invite) q.set('invite', row.invite);
  if (row?.next) q.set('next', row.next);
  return redirect(`/login?${q}`, 303);
}

// Our metadata for one account: what the admin gives their identity provider (or its address, which is our entity id).
route('GET', '/sso/saml/sp/:sp', (c) => {
  const xml = ssoAvailable() ? spMetadata(c.params.sp) : null;
  if (!xml) throw bad(say('saml.err.no_metadata'), 404);
  return new Response(xml, { headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' } });
}, 'public');

// The identity provider's answer, posted by its page (HTTP-POST binding). Checked here, used at /sso/saml/finish.
route('POST', '/sso/saml/acs', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(null, 'failed');
  }
  const relay = str(form.get('RelayState'), 200);
  const answer = form.get('SAMLResponse');
  const row = relay ? get('SELECT * FROM signin_states WHERE id=?', sha256(relay)) : null;
  // A sign-in we did not start (one the identity provider started by itself), one used already, or one too old.
  if (!row || row.verifier !== 'saml' || row.code || row.expires_at <= now()) {
    if (row && !row.code) run('DELETE FROM signin_states WHERE id=?', row.id);
    return fail(row, 'expired');
  }
  const accountId = accountOfProvider(row.provider);
  if (!accountId || !ssoAvailable() || !isSaml(accountId)) {
    run('DELETE FROM signin_states WHERE id=?', row.id);
    return fail(row, 'off');
  }
  try {
    rateLimit(`login:${c.ip}`, 30, 900_000);
  } catch {
    return fail(row, 'busy');
  }
  if (typeof answer !== 'string' || !answer || answer.length > RESPONSE_MAX) {
    run('DELETE FROM signin_states WHERE id=?', row.id);
    return fail(row, 'failed');
  }
  let who: Awaited<ReturnType<typeof checkAnswer>>;
  try {
    who = await checkAnswer(accountId, row.nonce, answer);
  } catch (e) {
    run('DELETE FROM signin_states WHERE id=?', row.id);
    if (!(e instanceof SamlRefused)) throw e;
    console.error(`[sso] ${accountId} SAML answer refused (${e.reason}): ${e.message}`);
    return fail(row, 'failed', e.reason);
  }
  // Kept on the line only until the browser comes back with its cookie, and only once.
  if (!run('UPDATE signin_states SET code=?, expires_at=? WHERE id=? AND code IS NULL', JSON.stringify(who), new Date(Date.now() + FINISH_SECONDS * 1000).toISOString(), row.id).changes) return fail(row, 'expired');
  return redirect(`/api/sso/saml/finish?${new URLSearchParams({ state: relay })}`, 303);
}, 'public');

route('GET', '/sso/saml/finish', async (c) => {
  const inBrowser = readCookie(c.req, samlCookie(c)) || '';
  c.cookies.push(cookie(samlCookie(c), '', 0, c.secure));
  const state = str(c.q.get('state'), 200);
  const row = state ? get('SELECT * FROM signin_states WHERE id=?', sha256(state)) : null;
  if (row) run('DELETE FROM signin_states WHERE id=?', row.id);
  const accountId = row ? accountOfProvider(row.provider) : null;
  if (!row || row.verifier !== 'saml' || !row.code || !accountId || row.expires_at <= now() || !inBrowser || !safeEqual(inBrowser, state))
    return fail(c.auth?.via === 'session' && row?.mode === 'test' ? row : null, 'expired');
  const idp = get('SELECT name, kind FROM org_idps WHERE account_id=?', accountId);
  if (!idp || idp.kind !== 'saml') return fail(row, 'off');
  const who = JSON.parse(row.code);
  return finishOrgSignIn(c, row, accountId, { id: `org:${accountId}`, name: idp.name, issuer: who.issuer }, { email: who.email, sub: who.sub, name: who.name });
}, 'public');

// ---- Settings, Security: the SAML part of the Single sign-on card ---------------------------------------------------

function person(c: Ctx) {
  if (c.auth?.via !== 'session') throw bad(say('sso.err.key'), 403);
  if (!ssoAvailable()) throw bad(say('sso.err.no_key'), 409, { code: 'sso_unavailable' });
}

// Saves the name and the identity provider's metadata (pasted, or read from the uploaded file by the page).
route('PUT', '/account/sso/saml', async (c) => {
  person(c);
  rateLimit(`ssosaml:${c.account.id}`, 30, 3600_000);
  const b = await c.body();
  await needCode(c, b.code, say('sso.code_what'));
  saveSaml(c, b);
  return { ok: true };
}, 'admin');
