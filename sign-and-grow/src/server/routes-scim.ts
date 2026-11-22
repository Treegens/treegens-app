// Members from your directory: the SCIM 2.0 endpoints a directory calls (scim.ts), at /api/scim/v2, and the card's
// routes under /account/directory. The directory's calls carry the account's bearer token, never a person's cookie or
// an API key, and are answered in SCIM's own form (application/scim+json, errors with "schemas" and "detail").
import { route, type Ctx } from './router.ts';
import { bad, rateLimit, HttpError } from './util.ts';
import { needCode, twoStepOn } from './twostep.ts';
import { ssoAvailable } from './orgsso.ts';
import { roleOf } from './perm.ts';
import {
  ScimError, scimErrorBody, accountOfToken, createUser, getUser, listUsers, replaceUser, patchUser, deleteUser, serviceProviderConfig,
  directoryView, makeToken, removeToken, setDirectory,
} from './scim.ts';
import { SCIM_CALLS_PER_MINUTE } from '../lib/samlscim.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);
const scim = (data: any, status = 200) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store' } }));

/** Runs one directory call: the token first, a limit per account, then the work, every refusal in SCIM's form. */
function directory(fn: (accountId: string, c: Ctx) => Promise<any> | any, status = 200) {
  return async (c: Ctx) => {
    try {
      const accountId = accountOfToken(c.req);
      try {
        rateLimit(`scim:${accountId}`, SCIM_CALLS_PER_MINUTE, 60_000);
      } catch {
        throw new ScimError(429, `More than ${SCIM_CALLS_PER_MINUTE} calls in a minute. Wait a minute and try again.`);
      }
      const out = await fn(accountId, c);
      return scim(out ?? null, out === undefined ? 204 : status);
    } catch (e: any) {
      if (e instanceof ScimError) return scim(scimErrorBody(e), e.status);
      if (e instanceof HttpError) return scim(scimErrorBody(new ScimError(e.status, e.message, e.status === 400 ? 'invalidSyntax' : undefined)), e.status);
      throw e;
    }
  };
}

route('GET', '/scim/v2/ServiceProviderConfig', directory(() => serviceProviderConfig()), 'public');
route('GET', '/scim/v2/Users', directory((a, c) => listUsers(a, c.q)), 'public');
route('POST', '/scim/v2/Users', directory(async (a, c) => createUser(a, await c.body()), 201), 'public');
route('GET', '/scim/v2/Users/:id', directory((a, c) => getUser(a, c.params.id)), 'public');
route('PUT', '/scim/v2/Users/:id', directory(async (a, c) => replaceUser(a, c.params.id, await c.body())), 'public');
route('PATCH', '/scim/v2/Users/:id', directory(async (a, c) => patchUser(a, c.params.id, await c.body())), 'public');
route('DELETE', '/scim/v2/Users/:id', directory(async (a, c) => void (await deleteUser(a, c.params.id))), 'public');
// Groups are not kept here. Said plainly, so the directory's setup page shows why.
route('GET', '/scim/v2/Groups', directory(() => {
  throw new ScimError(404, 'Groups are not supported here. Assign people to this app one by one in your directory.');
}), 'public');

// ---- Settings, Security: "Members from your directory" -------------------------------------------------------------

// Who can add and remove members through a token is decided by a person signed in, never by a key. The directory can
// remove anyone on the team but the owner, admins included, so only the owner or someone with the built-in Admin role
// (never a role an admin made, which can do less) sets it up, changes it or stops it. The router already asks for Team.
export const mayRunDirectory = (c: Ctx) => {
  const r = roleOf(c);
  return !r.profile && (r.base === 'owner' || r.base === 'admin');
};
function person(c: Ctx) {
  if (c.auth?.via !== 'session') throw bad(say('sso.err.key'), 403);
  if (!mayRunDirectory(c)) throw bad(say('directory.err.full_admin'), 403, { code: 'role_too_narrow' });
  if (!ssoAvailable()) throw bad(say('sso.err.no_key'), 409, { code: 'sso_unavailable' });
}

route('GET', '/account/directory', (c) => {
  if (c.auth?.via !== 'session') throw bad(say('sso.err.key'), 403);
  if (!ssoAvailable()) return { available: false };
  return { available: true, ...directoryView(c.account.id), code_needed: twoStepOn(c.user), may_change: mayRunDirectory(c) };
}, 'admin');

// A new token. Shown once in the answer; asking again replaces it, and the old one stops at once.
route('POST', '/account/directory/token', async (c) => {
  person(c);
  rateLimit(`scimtoken:${c.account.id}`, 20, 3600_000);
  const b = await c.body().catch(() => ({}));
  await needCode(c, b.code, say('directory.code_what'));
  return { token: makeToken(c), directory: directoryView(c.account.id) };
}, 'admin');

route('DELETE', '/account/directory/token', async (c) => {
  person(c);
  const b = await c.body().catch(() => ({}));
  await needCode(c, b.code, say('directory.code_what'));
  removeToken(c);
  return { ok: true };
}, 'admin');

route('PATCH', '/account/directory', async (c) => {
  person(c);
  const b = await c.body();
  return { directory: setDirectory(c, b) };
}, 'admin');
