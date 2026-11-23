// SAML 2.0 single sign-on for an organisation: the second kind of "your sign-in service" on the Single sign-on card
// (src/components/settings/OrgSso.tsx), next to OpenID Connect (oidc.ts). It shares everything else with it
// (orgsso.ts): the claimed email domains, "Try a sign-in", "Everyone at these domains signs in through it", the
// owner's way back in and the shorter sessions. The routes are routes-saml.ts.
//
//   Checking the XML signature is left to @node-saml/node-saml (MIT, maintained) and the xml-crypto it uses: XML
//   signature checks written by hand are where signature-wrapping attacks succeed. We set it up to ask for every check
//   the standard has, and check some things again ourselves where the library only warns:
//     - the assertion itself must be signed (a signed Response around an unsigned assertion is not enough), by one of
//       the certificates in the identity provider's metadata the admin pasted;
//     - its Issuer is that metadata's entity id, its Audience is our entity id for this account;
//     - a bearer SubjectConfirmation whose Recipient is exactly our address (SAML_ACS_PATH), whose NotOnOrAfter is
//       still ahead (with SAML_CLOCK_SECONDS for clocks), and whose InResponseTo is the AuthnRequest this browser's
//       sign-in sent (saml_requests, used once);
//     - an assertion ID accepted once is refused after (saml_seen, kept until the assertion would have expired).
//   We never sign our AuthnRequests and never decrypt assertions: an identity provider that requires either is not
//   supported, and the card says so through the error it shows.
//
// Not here: single logout, the HTTP-POST binding for our request (we send it by HTTP-Redirect), encrypted assertions,
// metadata fetched from an address (the admin pastes or uploads it), and SCIM groups.
import { DOMParser } from '@xmldom/xmldom';
import { SAML, generateServiceProviderMetadata, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { get, run } from './db.ts';
import { bad, token, now, baseUrl, isEmail, sha256 } from './util.ts';
import { cookie } from './auth.ts';
import { readCert } from './x509.ts';
import { record } from './seclog.ts';
import { SAML_ACS_PATH, SAML_SP_PATH, SAML_METADATA_MAX, SAML_REQUEST_MINUTES, SAML_CLOCK_SECONDS, samlWhyOf, type SamlWhy } from '../lib/samlscim.ts';
import { SSO_NAME_MAX } from '../lib/orgsso.ts';
import { SOURCE_LOCALE, t, type Vars } from '../lib/i18n.ts';
import type { Ctx } from './router.ts';

const say = (key: string, vars: Vars = {}) => t(SOURCE_LOCALE, key, vars);
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

export const acsUrl = () => `${baseUrl()}${SAML_ACS_PATH}`;

// ---- Our side: the entity id and metadata of each account ----------------------------------------------------------

/** The account's SAML line, made the first time an admin opens the card, so our address exists before theirs. */
export function spRow(accountId: string): any {
  run('INSERT OR IGNORE INTO org_saml (account_id, sp_id, updated_at) VALUES (?,?,?)', accountId, token(12).replace(/[-_]/g, 'x'), now());
  return get('SELECT * FROM org_saml WHERE account_id=?', accountId);
}
export const entityIdOf = (spId: string) => `${baseUrl()}${SAML_SP_PATH}${spId}`;

/** What the admin gives their identity provider: our entity id (which is also where our metadata is) and our ACS. */
export function spView(accountId: string) {
  const r = spRow(accountId);
  return { entity_id: entityIdOf(r.sp_id), metadata_url: entityIdOf(r.sp_id), acs_url: acsUrl() };
}

/** Our metadata for one account, or null for an id we never made. */
export function spMetadata(spId: string): string | null {
  const r = typeof spId === 'string' && /^[A-Za-z0-9]{8,40}$/.test(spId) ? get('SELECT * FROM org_saml WHERE sp_id=?', spId) : null;
  if (!r) return null;
  return generateServiceProviderMetadata({ issuer: entityIdOf(r.sp_id), callbackUrl: acsUrl(), wantAssertionsSigned: true, identifierFormat: null });
}

// ---- Their side: the identity provider's metadata ------------------------------------------------------------------

export type IdpMeta = { entityId: string; ssoUrl: string; certs: string[]; ends: string[] };

/** Reads pasted identity provider metadata. Throws, in words for the admin, what is wrong with it. */
export function readIdpMetadata(raw: unknown): IdpMeta {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const no = (key: string, vars: Vars = {}) => bad(say(`saml.err.${key}`, vars), 400, { field: 'metadata' });
  if (!text) throw no('metadata_missing');
  if (text.length > SAML_METADATA_MAX) throw no('metadata_long');
  // A DOCTYPE can declare entities that blow up when read. Real metadata never has one.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw no('metadata_form');
  let doc: any;
  try {
    doc = new DOMParser({ errorHandler: { warning: () => {}, error: (m: string) => { throw new Error(m); }, fatalError: (m: string) => { throw new Error(m); } } }).parseFromString(text, 'text/xml');
  } catch {
    throw no('metadata_form');
  }
  const entities = doc?.getElementsByTagNameNS ? Array.from(doc.getElementsByTagNameNS(MD, 'EntityDescriptor') as ArrayLike<any>) : [];
  const idps = entities.filter((e: any) => e.getElementsByTagNameNS(MD, 'IDPSSODescriptor').length > 0);
  if (!idps.length) throw no('metadata_form');
  if (idps.length > 1) throw no('metadata_many', { count: idps.length });
  const ent = idps[0];
  const entityId = String(ent.getAttribute('entityID') || '').trim();
  if (!entityId || entityId.length > 1000) throw no('metadata_form');
  const desc = ent.getElementsByTagNameNS(MD, 'IDPSSODescriptor')[0];
  const sso = Array.from(desc.getElementsByTagNameNS(MD, 'SingleSignOnService') as ArrayLike<any>).find((s: any) => s.getAttribute('Binding') === REDIRECT);
  if (!sso) throw no('metadata_no_redirect');
  let ssoUrl = '';
  try {
    const u = new URL(String(sso.getAttribute('Location') || '').trim());
    if (u.protocol === 'https:' && !u.username && !u.password) ssoUrl = u.toString();
  } catch {}
  if (!ssoUrl) throw no('metadata_https');
  const certs: string[] = [];
  const ends: string[] = [];
  for (const kd of Array.from(desc.getElementsByTagNameNS(MD, 'KeyDescriptor') as ArrayLike<any>)) {
    const use = kd.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const x of Array.from(kd.getElementsByTagNameNS(DS, 'X509Certificate') as ArrayLike<any>)) {
      const b64 = String(x.textContent || '').replace(/\s+/g, '');
      try {
        const cert = readCert(Buffer.from(b64, 'base64'));
        if (!certs.includes(b64)) {
          certs.push(b64);
          ends.push(cert.notAfter.toISOString());
        }
      } catch {
        throw no('metadata_cert');
      }
    }
  }
  if (!certs.length) throw no('metadata_no_cert');
  // A certificate past its end is still the key the provider signs with, so it is kept. But if every one has ended,
  // the metadata is old: the admin is asked for fresh metadata before anything uses it.
  if (ends.every((e) => e < now())) throw no('metadata_ended', { day: ends.sort().slice(-1)[0].slice(0, 10) });
  return { entityId, ssoUrl, certs, ends };
}

const pem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----`;

export const isSaml = (accountId: string): boolean => get('SELECT kind FROM org_idps WHERE account_id=?', accountId)?.kind === 'saml';

/** What the card shows of a SAML service: the parts of the metadata an admin can check. */
export function samlView(accountId: string) {
  const r = get('SELECT * FROM org_saml WHERE account_id=?', accountId);
  if (!r?.entity_id) return null;
  const certs: string[] = JSON.parse(r.certs || '[]');
  return {
    idp_entity_id: r.entity_id, sso_url: r.sso_url,
    certificates: certs.map((b) => ({ ends: readCert(Buffer.from(b, 'base64')).notAfter.toISOString() })),
    updated_at: r.updated_at,
  };
}

/**
 * Saves the account's SAML service: a name and the identity provider's metadata. A new entity id needs a new
 * "Try a sign-in" before anything uses it, so while everyone signs in through the service it cannot change; new
 * certificates or a new sign-in address of the same provider can (that is how a provider rolls its key over).
 * Moving from OpenID Connect to SAML is the same as a new entity id.
 */
export function saveSaml(c: Ctx, b: any) {
  const was = get('SELECT * FROM org_idps WHERE account_id=?', c.account.id);
  const name = b.name === undefined && was ? was.name : String(b.name ?? '').trim();
  if (!name || name.length > SSO_NAME_MAX || /[<>\u0000-\u001f]/.test(name)) throw bad(say('sso.err.name_form', { max: SSO_NAME_MAX }), 400, { field: 'name' });
  const old = get('SELECT * FROM org_saml WHERE account_id=?', c.account.id);
  const meta: IdpMeta | null = b.metadata === undefined && was?.kind === 'saml' && old?.entity_id
    ? { entityId: old.entity_id, ssoUrl: old.sso_url, certs: JSON.parse(old.certs), ends: [] }
    : readIdpMetadata(b.metadata);
  if (!meta) throw bad(say('saml.err.metadata_missing'), 400, { field: 'metadata' });
  const moved = !was || was.kind !== 'saml' || was.issuer !== meta.entityId;
  if (was?.enforce && moved) throw bad(say('sso.err.enforced_change', { name: was.name }), 409, { code: 'enforced' });
  const t = now();
  spRow(c.account.id);
  run('UPDATE org_saml SET entity_id=?, sso_url=?, certs=?, updated_at=? WHERE account_id=?', meta.entityId, meta.ssoUrl, JSON.stringify(meta.certs), t, c.account.id);
  if (!was) run("INSERT INTO org_idps (account_id, name, issuer, client_id, secret_sealed, secret_key, created_at, updated_at, kind) VALUES (?,?,?,'','','',?,?,'saml')", c.account.id, name, meta.entityId, t, t);
  else run(`UPDATE org_idps SET name=?, issuer=?, client_id='', secret_sealed='', secret_key='', kind='saml', tested_at=${moved ? 'NULL' : 'tested_at'}, tested_by=${moved ? 'NULL' : 'tested_by'}, updated_at=? WHERE account_id=?`, name, meta.entityId, t, c.account.id);
  // Another provider knows people by other ids, so the old connections go, as they do for OpenID Connect (orgsso.ts).
  const unlinked = was && moved ? Number(run('DELETE FROM identities WHERE provider=?', `org:${c.account.id}`).changes || 0) : 0;
  const keysChanged = !!old?.certs && old.certs !== JSON.stringify(meta.certs);
  record('sso.changed', { c, details: { service: name, standard: 'saml', idp: meta.entityId.slice(0, 200), ...(was ? {} : { added: true }), ...(moved && was ? { needs_a_new_try: true } : {}), ...(keysChanged && !moved ? { certificates_replaced: true } : {}), ...(unlinked ? { connections_removed: unlinked } : {}) } });
}

// ---- The library, set up for one account --------------------------------------------------------------------------

/**
 * Where node-saml keeps what it must remember, in our database. A cache made for checking an answer only knows the
 * one request this browser's sign-in sent (`expect`), so an answer to any other request, even a real one of the same
 * account, is refused.
 */
function cacheFor(accountId: string, expect: string | null): CacheProvider {
  const live = (key: string) => (expect !== null && key !== expect ? null : get('SELECT * FROM saml_requests WHERE id=? AND account_id=? AND expires_at > ?', key, accountId, now()));
  return {
    async saveAsync(key, value) {
      run('DELETE FROM saml_requests WHERE expires_at < ?', now());
      run('INSERT OR REPLACE INTO saml_requests (id, account_id, created_at, expires_at) VALUES (?,?,?,?)', key, accountId, value, new Date(Date.now() + SAML_REQUEST_MINUTES * 60_000).toISOString());
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      return live(key)?.created_at ?? null;
    },
    async removeAsync(key) {
      if (!key) return null;
      const r = get('SELECT created_at FROM saml_requests WHERE id=? AND account_id=?', key, accountId);
      run('DELETE FROM saml_requests WHERE id=? AND account_id=?', key, accountId);
      return r?.created_at ?? null;
    },
    // Read and removed with nothing in between (SQLite here is one connection), so of two copies only one passes.
    async consumeAsync(key) {
      const r = live(key);
      if (!r) return null;
      return run('DELETE FROM saml_requests WHERE id=? AND account_id=?', key, accountId).changes ? r.created_at : null;
    },
    async saveIfAbsentAsync(key, _value, expiresAtMs) {
      run('DELETE FROM saml_seen WHERE expires_at < ?', now());
      return Number(run('INSERT OR IGNORE INTO saml_seen (key, expires_at) VALUES (?,?)', key, new Date(expiresAtMs).toISOString()).changes) === 1;
    },
  };
}

function samlOf(accountId: string, cache: CacheProvider, requestId?: string): SAML {
  const s = get('SELECT * FROM org_saml WHERE account_id=?', accountId);
  if (!s?.entity_id) throw bad(say('sso.err.no_service'), 404);
  return new SAML({
    entryPoint: s.sso_url, issuer: entityIdOf(s.sp_id), callbackUrl: acsUrl(), audience: entityIdOf(s.sp_id),
    idpCert: (JSON.parse(s.certs) as string[]).map(pem), idpIssuer: s.entity_id,
    wantAssertionsSigned: true, wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: SAML_REQUEST_MINUTES * 60_000,
    rejectReplayedAssertions: true, acceptedClockSkewMs: SAML_CLOCK_SECONDS * 1000, cacheProvider: cache,
    identifierFormat: null, disableRequestedAuthnContext: true,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

/** The address of the identity provider to send the browser to, for a request whose id the caller keeps. */
export async function authorizeUrlFor(accountId: string, relayState: string): Promise<{ url: string; requestId: string }> {
  const requestId = `_${token(20)}`;
  const url = await samlOf(accountId, cacheFor(accountId, null), requestId).getAuthorizeUrlAsync(relayState, {});
  return { url, requestId };
}

/**
 * Why an answer was refused. `message` is for the server log only. `reason` is a short code (src/lib/samlscim.ts
 * SAML_WHY) that only an admin's "Try a sign-in" is told, with what to change at the identity provider; a person
 * signing in is told "failed".
 */
export class SamlRefused extends Error {
  reason: SamlWhy;
  constructor(message: string, reason?: SamlWhy) {
    super(message);
    this.reason = reason || samlWhyOf(message);
  }
}

/** One value of an attribute, whatever its name among the usual ones. */
function attr(p: Profile, names: string[]): string {
  const a: any = (p as any).attributes || {};
  for (const n of names) {
    const v = Array.isArray(a[n]) ? a[n][0] : a[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}
const EMAIL_NAMES = ['email', 'mail', 'emailaddress', 'Email', 'EmailAddress', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'User.email'];
const NAME_NAMES = ['displayName', 'name', 'cn', 'urn:oid:2.16.840.1.113730.3.1.241', 'http://schemas.microsoft.com/identity/claims/displayname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];
const GIVEN_NAMES = ['givenName', 'firstName', 'first_name', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'User.FirstName'];
const FAMILY_NAMES = ['sn', 'surname', 'lastName', 'last_name', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'User.LastName'];

/**
 * Checks the identity provider's answer to the request `requestId` and says who signed in, as the same claims an
 * OpenID Connect sign-in gives (email, sub, name), so routes-orgsso.ts decides the rest the one way it always does.
 */
export async function checkAnswer(accountId: string, requestId: string, samlResponse: string): Promise<{ email: string; sub: string; name: string; issuer: string }> {
  let profile: Profile | null;
  try {
    ({ profile } = await samlOf(accountId, cacheFor(accountId, requestId)).validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (e: any) {
    throw new SamlRefused(String(e?.message || e).slice(0, 300));
  }
  if (!profile) throw new SamlRefused('no assertion', 'unsigned');
  const s = get('SELECT * FROM org_saml WHERE account_id=?', accountId);
  const a: any = (profile.getAssertion?.() as any)?.Assertion;
  if (!a) throw new SamlRefused('no verified assertion', 'unsigned');
  if (a.Issuer?.[0]?._ !== s.entity_id && a.Issuer?.[0] !== s.entity_id) throw new SamlRefused('issuer differs', 'issuer');
  // The library only warns about a Recipient that is not ours; we refuse it. And the audience must name us.
  const skew = SAML_CLOCK_SECONDS * 1000;
  const ours = (a.Subject?.[0]?.SubjectConfirmation || []).some((sc: any) => {
    const d = sc?.SubjectConfirmationData?.[0]?.$ || {};
    return sc?.$?.Method === BEARER && d.Recipient === acsUrl() && d.InResponseTo === requestId && !!d.NotOnOrAfter && Date.parse(d.NotOnOrAfter) + skew > Date.now();
  });
  if (!ours) throw new SamlRefused('no bearer confirmation for our address and this request that is still valid', 'recipient');
  const audiences = (a.Conditions?.[0]?.AudienceRestriction || []).flatMap((r: any) => (r.Audience || []).map((x: any) => (typeof x === 'string' ? x : x?._)));
  if (!audiences.includes(entityIdOf(s.sp_id))) throw new SamlRefused('audience is not ours', 'audience');
  const nameId = String(profile.nameID || '').trim();
  const fromName = isEmail(nameId) ? nameId : '';
  const email = (attr(profile, EMAIL_NAMES) || fromName).toLowerCase();
  if (!isEmail(email)) throw new SamlRefused('no email address', 'no_email');
  const given = attr(profile, GIVEN_NAMES), family = attr(profile, FAMILY_NAMES);
  const name = (attr(profile, NAME_NAMES) || [given, family].filter(Boolean).join(' ')).slice(0, 120);
  // A transient NameID changes at every sign-in, so it cannot say who someone is: the address does then.
  const sub = !nameId || profile.nameIDFormat === TRANSIENT ? `email:${email}` : nameId;
  return { email, sub, name, issuer: s.entity_id };
}

// ---- Starting a sign-in -------------------------------------------------------------------------------------------

/** The cookie that ties a SAML sign-in to the browser that started it. Read back at the finish, never at the ACS. */
export const samlCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}sg_saml`;

/**
 * Sends the browser to the identity provider: a line in signin_states (provider "org:<account>", nonce = the id of
 * our AuthnRequest, verifier "saml") and the cookie with the RelayState, exactly as OpenID Connect does with its
 * state. Answers the address to go to.
 */
export async function beginSaml(c: Ctx, accountId: string, o: { mode: 'login' | 'test'; userId?: string | null; invite?: string | null; next?: string | null }): Promise<string> {
  const state = token();
  const { url, requestId } = await authorizeUrlFor(accountId, state);
  run('DELETE FROM signin_states WHERE expires_at < ?', now());
  run('INSERT INTO signin_states (id, provider, nonce, verifier, mode, invite, code, next, user_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sha256(state), `org:${accountId}`, requestId, 'saml', o.mode, o.invite || null, null, o.next || null, o.userId || null, new Date(Date.now() + SAML_REQUEST_MINUTES * 60_000).toISOString());
  c.cookies.push(cookie(samlCookie(c), state, SAML_REQUEST_MINUTES * 60, c.secure));
  return url;
}
