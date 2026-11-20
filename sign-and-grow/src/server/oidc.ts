import crypto from 'node:crypto';
import { type ProviderId, type SignInError, PROVIDER_NAMES, MICROSOFT_PERSONAL_TENANT, microsoftTenant, signInProviders } from '../lib/signin.ts';
import { isEmail, safeEqual } from './util.ts';

// Signing in at Google or Microsoft (OpenID Connect, authorization code flow), written out with fetch and
// node:crypto. This file talks to the provider and decides whether what came back is genuine. It knows nothing
// about logins or the database: routes-signin.ts decides who the person is.

export type Provider = { id: ProviderId; name: string; clientId: string; clientSecret: string; authorize: string; token: string; jwks: string; tenant?: string };

// A provider is on only when both of its values are set. Its addresses are fixed here and never taken from a token
// or a request, so nothing a caller sends can point us at somebody else's server.
export function provider(id: ProviderId): Provider | null {
  if (!signInProviders().includes(id)) return null;
  if (id === 'google')
    return { id, name: PROVIDER_NAMES[id], clientId: process.env.GOOGLE_CLIENT_ID!.trim(), clientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' };
  const tenant = microsoftTenant()!;
  const base = `https://login.microsoftonline.com/${tenant}`;
  return { id, name: PROVIDER_NAMES[id], clientId: process.env.MICROSOFT_CLIENT_ID!.trim(), clientSecret: process.env.MICROSOFT_CLIENT_SECRET!.trim(),
    authorize: `${base}/oauth2/v2.0/authorize`, token: `${base}/oauth2/v2.0/token`, jwks: `${base}/discovery/v2.0/keys`, tenant };
}

// A sign-in that did not go through. `code` is what the person is told (see signInErrorText), `why` is for the
// server log only: it can name a claim or a provider's error, which mean nothing to the person signing in.
export class SignInRefused extends Error {
  code: SignInError;
  constructor(code: SignInError, why: string) {
    super(why);
    this.code = code;
  }
}
const refuse = (why: string) => new SignInRefused('failed', why);

/** PKCE (S256): the provider is sent the hash, and only whoever holds the verifier can redeem the code. */
export const pkceChallenge = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function authorizeUrl(p: Provider, o: { state: string; nonce: string; verifier: string; redirectUri: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId, response_type: 'code', response_mode: 'query', scope: 'openid email profile', redirect_uri: o.redirectUri,
    state: o.state, nonce: o.nonce, code_challenge: pkceChallenge(o.verifier), code_challenge_method: 'S256',
    // Always ask which account, so a shared computer does not sign the next person in as the last one.
    prompt: 'select_account',
  });
  if (o.loginHint) q.set('login_hint', o.loginHint);
  return `${p.authorize}?${q}`;
}

const TIMEOUT_MS = 10_000;
async function ask(url: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e: any) {
    throw refuse(`no answer from ${new URL(url).host}: ${e?.message || e}`);
  }
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Swaps the code from the callback for the ID token, proving who we are with the client secret and the PKCE verifier. */
export async function exchangeCode(p: Provider, code: string, verifier: string, redirectUri: string): Promise<string> {
  const r = await ask(p.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: p.clientId, client_secret: p.clientSecret, code_verifier: verifier }).toString(),
  });
  if (r.status !== 200 || typeof r.data?.id_token !== 'string')
    throw refuse(`the token endpoint answered ${r.status} ${String(r.data?.error || '').slice(0, 80)} ${String(r.data?.error_description || '').slice(0, 200)}`.trim());
  return r.data.id_token;
}

// The provider's published signing keys, kept for an hour. A token signed with a key id that is not among them
// makes us fetch the list once more, because providers change keys and announce the new one there first.
const g = globalThis as any;
const keyCache: Map<string, { at: number; keys: any[] }> = (g.__tsjwks ??= new Map());
const KEYS_FOR_MS = 3600_000;
async function signingKey(p: Provider, kid: string): Promise<any | null> {
  const pick = (keys: any[]) => keys.find((k) => k && k.kid === kid && k.kty === 'RSA' && (k.use == null || k.use === 'sig') && (k.alg == null || k.alg === 'RS256')) || null;
  const have = keyCache.get(p.jwks);
  const known = have && Date.now() - have.at < KEYS_FOR_MS ? pick(have.keys) : null;
  if (known) return known;
  const r = await ask(p.jwks, { headers: { accept: 'application/json' } });
  if (r.status !== 200 || !Array.isArray(r.data?.keys)) throw refuse(`the key list answered ${r.status}`);
  keyCache.set(p.jwks, { at: Date.now(), keys: r.data.keys });
  return pick(r.data.keys);
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const LEEWAY_S = 60; // clocks differ a little
const ORG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Checks an ID token ourselves and returns its claims, or throws. In this order: it is signed with RS256 and nothing
 * else (so "none", and a token signed with our own copy of the public key as if it were a shared secret, never reach
 * a key), the signature fits one of the provider's published keys, it was issued by this provider, for us, for this
 * sign-in (the nonce), and it has not run out.
 */
export async function verifyIdToken(p: Provider, jwt: string, nonce: string): Promise<Record<string, any>> {
  const part = typeof jwt === 'string' ? jwt.split('.') : [];
  if (part.length !== 3 || !part.every((x) => B64URL.test(x))) throw refuse('the ID token is not three signed parts');
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(part[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(part[1], 'base64url').toString('utf8'));
  } catch {
    throw refuse('the ID token could not be read');
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw refuse('the ID token could not be read');
  if (header.alg !== 'RS256') throw refuse(`the ID token says it is signed with "${String(header.alg).slice(0, 20)}", and only RS256 is accepted`);
  if (typeof header.kid !== 'string' || !header.kid) throw refuse('the ID token names no key');
  const jwk = await signingKey(p, header.kid);
  if (!jwk) throw refuse('the ID token is signed with a key the provider does not publish');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw refuse('the published key could not be read');
  }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw refuse('the published key is not an RSA key of at least 2048 bits');
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${part[0]}.${part[1]}`), key, Buffer.from(part[2], 'base64url'))) throw refuse('the signature on the ID token is not right');

  // Issued by this provider. Microsoft signs for every organization with the same keys, so there the issuer has to
  // name the organization the token itself says the person belongs to (tid), and that organization has to be one
  // this server lets in.
  if (p.id === 'google') {
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw refuse('the issuer is not Google');
  } else {
    if (typeof claims.tid !== 'string' || !ORG.test(claims.tid)) throw refuse('the token names no organization');
    if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) throw refuse('the issuer does not belong to the organization in the token');
    const personal = claims.tid === MICROSOFT_PERSONAL_TENANT;
    if (p.tenant === 'organizations' ? personal : p.tenant === 'consumers' ? !personal : p.tenant !== 'common' && claims.tid !== p.tenant) throw refuse('the organization in the token is not one this server lets in');
  }
  // Issued for us: a token made for another app is somebody else's sign-in.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(p.clientId) || (aud.length > 1 && claims.azp !== p.clientId) || (claims.azp != null && claims.azp !== p.clientId)) throw refuse('the token was issued for another app');
  const t = Date.now() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp <= t - LEEWAY_S) throw refuse('the token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf > t + LEEWAY_S) throw refuse('the token is not valid yet');
  if (typeof claims.iat === 'number' && claims.iat > t + 5 * 60) throw refuse('the token says it was issued in the future');
  // Issued for this sign-in and no other.
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) throw refuse('the nonce is not the one this sign-in started with');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw refuse('the token names no person');
  return claims;
}

export type Identity = { subject: string; email: string; vouched: boolean; name: string };

/**
 * Who a verified token is about. The person is the provider's own id for them (subject), never the email address:
 * at Microsoft an organization's admin can put any address into "email". `vouched` says whether the provider itself
 * stands behind the address:
 *   Google: it says the address is confirmed AND it runs the mailbox (gmail.com, or a Google Workspace domain, which
 *   is what the "hd" claim says). A Google account made with an address from somewhere else was confirmed once, some
 *   time ago, and that is not enough to open an existing login.
 *   Microsoft: the optional claim xms_edov is true, which says the owner of the address's domain was verified.
 */
export function identityOf(p: Provider, claims: Record<string, any>): Identity {
  const mail = (v: any) => (isEmail(v) ? v.trim().toLowerCase() : '');
  const nameOr = (email: string) => (typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : [claims.given_name, claims.family_name].filter((x) => typeof x === 'string' && x.trim()).join(' ') || email.split('@')[0] || 'New member').slice(0, 120);
  if (p.id === 'google') {
    const email = mail(claims.email);
    const runsMailbox = /@(gmail|googlemail)\.com$/.test(email) || (typeof claims.hd === 'string' && !!claims.hd);
    return { subject: claims.sub, email, vouched: !!email && claims.email_verified === true && runsMailbox, name: nameOr(email) };
  }
  // The same person has a different "sub" in every app but one "oid" in their organization. Whichever is used is
  // written into the subject, so the two can never be mistaken for each other.
  const who = typeof claims.oid === 'string' && claims.oid && claims.oid.length <= 100 ? `oid/${claims.oid}` : `sub/${claims.sub}`;
  const claimed = mail(claims.email);
  const email = claimed || mail(claims.preferred_username);
  return { subject: `${claims.tid}/${who}`, email, vouched: !!claimed && claims.xms_edov === true, name: nameOr(email) };
}
