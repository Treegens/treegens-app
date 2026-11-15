/**
 * Google integration: OAuth 2.0 (web server flow), Calendar v3 and Gmail send.
 * Plain HTTPS through ctx.fetch, no SDK. Tokens never leave this module in the clear:
 * refresh tokens are sealed on the host record, access tokens are sealed in the cache,
 * and nothing that could contain either is ever logged.
 */
import { IANAZone } from 'luxon';
import { MAX_GOOGLE_ACCOUNTS_PER_HOST } from '../../shared/defaults';
import type { GoogleAccount, GoogleCalendarListItem, Host, IanaZone } from '../../shared/types';
import { hmacHex, open, randomToken, seal, sha256Hex, signPayload, verifyPayload } from './crypto';
import { BASE_PATH, type Ctx } from './ctx';
import {
  accountCount,
  accountsOf,
  findAccount,
  foldIntoMain,
  heldElsewhere,
  legacyMainId,
  mainOf,
  removeExtra,
  upsertAccount,
  writeExtra,
  type AccountRef,
  type ConnectIntent,
  type ConnectOutcome,
  type IncomingGrant,
  type UpsertResult,
} from './googleAccounts';
import { HttpError } from './http';
import { mergeBusy } from './icsfeed';
import { cacheGet, cacheSet, claim, getHost, getSecrets, listHosts, updateHost } from './repo';
import type { Interval } from './time';

export type { AccountRef } from './googleAccounts';

// ───────────────────────── constants ─────────────────────────

const SCOPE_CALENDAR_FULL = 'https://www.googleapis.com/auth/calendar';
const SCOPE_CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const SCOPE_CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';

export const GOOGLE_CALENDAR_SCOPES: string[] = ['openid', 'email', SCOPE_CALENDAR_READONLY, SCOPE_CALENDAR_EVENTS];
export const GMAIL_SEND_SCOPE: string = 'https://www.googleapis.com/auth/gmail.send';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const STATE_PURPOSE = 'gstate';
const RETURN_PURPOSE = 'gstate-return';
const REFRESH_PURPOSE = 'google-refresh';
const ACCESS_PURPOSE = 'google-access';
const STATE_TTL_SEC = 600;

const REQUEST_TIMEOUT_MS = 6_000;
/**
 * A free/busy read gives up sooner, so that its one retry still fits inside the time a booking waits for
 * the calendars (BOOKING_READ_BUDGET_MS in booking.ts, 8.5 s). With the full 6 s a retry could never land.
 */
const FREEBUSY_TIMEOUT_MS = 3_500;
const RETRY_PAUSE_MS = 150;
/** A Gmail send is not repeated after an unclear failure, so it gets longer to answer than other requests. */
const GMAIL_SEND_TIMEOUT_MS = 15_000;
/** Access tokens are dropped from the cache this long before Google expires them. */
const TOKEN_EXPIRY_MARGIN_SEC = 60;
/** A Meet link Google is still creating: how often to look again right after the insert, and how long to wait each time. */
const MEET_LOOKS = 3;
const MEET_LOOK_PAUSE_MS = 600;

const FREEBUSY_CHUNK_MS = 60 * 86_400_000;
/** freeBusy expands at most 50 calendars per request. */
const FREEBUSY_MAX_CALENDARS = 50;
const CALENDAR_LIST_MAX_PAGES = 10;

const DEFAULT_RETURN = `${BASE_PATH}/admin`;
const RECONNECT_MESSAGE = 'Google Calendar needs to be reconnected.';

// ───────────────────────── errors ─────────────────────────

/** reconnect needed */
export class GoogleAuthError extends Error {
  constructor(message: string = RECONNECT_MESSAGE) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** A Google request failed for a reason other than authorisation. `status` is 0 when no response arrived. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(message: string, status = 0, reason = '') {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

// ───────────────────────── small helpers ─────────────────────────

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Error codes are echoed into messages and logs: keep only what looks like a code. */
function codeOf(v: unknown): string {
  const s = str(v);
  return /^[A-Za-z0-9_.-]{1,60}$/.test(s) ? s : '';
}

/** `reason` of a Google API error body: `{ error: { errors: [{ reason }], status } }`. */
function apiErrorReason(body: unknown): string {
  if (!isRecord(body)) return '';
  const err = body.error;
  if (typeof err === 'string') return codeOf(err);
  if (!isRecord(err)) return '';
  const first = Array.isArray(err.errors) ? err.errors[0] : null;
  return (isRecord(first) ? codeOf(first.reason) : '') || codeOf(err.status);
}

function isValidZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && IANAZone.isValidZone(tz);
}

function oneLine(v: unknown, max: number): string {
  return str(v)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim()
    .slice(0, max);
}

async function clientCredentials(ctx: Ctx): Promise<{ clientId: string; clientSecret: string } | null> {
  const google = (await getSecrets(ctx)).google;
  if (!google || !google.clientId || !google.clientSecret) return null;
  return { clientId: google.clientId, clientSecret: google.clientSecret };
}

/** The account a call is made as. Every Google call names one, so none can fall back to "the host's connection". */
function requireAccount(ref: AccountRef | null | undefined): GoogleAccount {
  if (!ref?.account) throw new GoogleAuthError('Google Calendar is not connected.');
  return ref.account;
}

/** The sentence when a person would go past the ceiling. */
export const TOO_MANY_ACCOUNTS_MESSAGE = `You have connected ${MAX_GOOGLE_ACCOUNTS_PER_HOST} Google accounts, the most one person can connect here. Remove one to add another.`;

// ───────────────────────── OAuth: start ─────────────────────────

export function googleRedirectUri(ctx: Ctx): string {
  return `${ctx.env.publicBaseUrl}/api/google/callback`;
}

/**
 * Accepts only a path inside the app ("/meeting", "/meeting/..."), and returns it normalised
 * (dot segments resolved). Absolute URLs, scheme-relative URLs, backslash tricks and paths
 * that climb out of the base path all give null.
 */
function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null;
  if (/[\u0000-\u001F\u007F\\]/.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://return.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://return.invalid') return null;
  const path = url.pathname;
  if (path.includes('//')) return null;
  if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) return null;
  return `${path}${url.search}${url.hash}`;
}

interface StatePayload {
  hostId: string;
  /** sealed: it can carry a co-host's self-service token, and the state travels through Google */
  returnTo: string;
  gmail: boolean;
  n: string;
  /** what the sign-in is for. Absent on states signed by the previous deploy: read as 'main'. */
  intent?: ConnectIntent;
  /** with 'reconnect': the account being reconnected */
  aid?: string;
  /** started from a co-host's private link: a mark of that link (linkMark), checked when Google sends the person back */
  lt?: string;
}

const INTENTS: readonly ConnectIntent[] = ['main', 'extra', 'reconnect', 'replace'];

function intentOf(v: unknown): ConnectIntent {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v) ? (v as ConnectIntent) : 'main';
}

/**
 * A mark of a co-host's private link as it is now. A sign-in started from the link carries it, so a link that
 * was replaced while the person was at Google cannot finish the connection. Not a secret, and no key to anything.
 */
export function linkMark(ctx: Ctx, inviteTokenHash: string): string {
  return hmacHex(ctx, 'gstate-link', inviteTokenHash).slice(0, 16);
}

/**
 * `intent`: 'main' (the plain Connect and Reconnect buttons), 'extra' ("Add another Google account": the
 * account chooser, no hint, refused at the ceiling), 'reconnect' (one account, `accountId`, hinted by its
 * address), 'replace' ("Use a different Google account": the account chooser, no hint).
 * `selectAccount` is the older name for 'replace'.
 */
export async function buildGoogleAuthUrl(
  ctx: Ctx,
  p: { hostId: string; returnTo: string; gmail?: boolean; loginHint?: string; selectAccount?: boolean; intent?: ConnectIntent; accountId?: string; linkMark?: string },
): Promise<string> {
  const creds = await clientCredentials(ctx);
  if (!creds) {
    throw new HttpError(400, 'google_not_configured', 'Add the Google client ID and client secret under Integrations before connecting a calendar.');
  }
  const returnTo = safeReturnTo(p.returnTo);
  if (!returnTo) throw new HttpError(400, 'invalid_return', 'That return address is not allowed.');
  const host = await getHost(ctx, p.hostId);
  if (!host) throw new HttpError(404, 'host_not_found', 'That team member does not exist.');

  const intent: ConnectIntent = p.intent ?? (p.selectAccount === true ? 'replace' : 'main');
  let hint = oneLine(p.loginHint, 254);
  let aid: string | undefined;
  if (intent === 'extra') {
    if (accountCount(host) >= MAX_GOOGLE_ACCOUNTS_PER_HOST) throw new HttpError(409, 'too_many_google_accounts', TOO_MANY_ACCOUNTS_MESSAGE);
    hint = '';
  } else if (intent === 'reconnect') {
    const ref = p.accountId ? findAccount(host, { id: p.accountId }) : null;
    if (!ref) throw new HttpError(404, 'google_account_not_found', 'That Google account is not connected any more. Reload the page.');
    aid = ref.account.id;
    hint = oneLine(ref.account.email, 254);
  } else if (intent === 'replace') {
    hint = '';
  }
  // Gmail is only ever asked for on the main account (the route only offers it to the owner).
  const gmail = p.gmail === true && intent !== 'extra';

  const payload: StatePayload = { hostId: p.hostId, returnTo: seal(ctx, RETURN_PURPOSE, returnTo), gmail, n: randomToken(16), intent };
  if (aid) payload.aid = aid;
  if (p.linkMark) payload.lt = p.linkMark;
  const scopes = gmail ? [...GOOGLE_CALENDAR_SCOPES, GMAIL_SEND_SCOPE] : GOOGLE_CALENDAR_SCOPES;
  const chooser = intent === 'extra' || intent === 'replace';
  const query = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: googleRedirectUri(ctx),
    response_type: 'code',
    scope: scopes.join(' '),
    // offline + consent: Google only hands out a refresh token when the user sees the consent screen
    access_type: 'offline',
    prompt: chooser ? 'consent select_account' : 'consent',
    include_granted_scopes: 'true',
    state: signPayload(ctx, STATE_PURPOSE, payload, STATE_TTL_SEC),
  });
  if (!chooser && hint.includes('@') && !/\s/.test(hint)) query.set('login_hint', hint);
  return `${AUTH_ENDPOINT}?${query.toString()}`;
}

export interface GoogleStateInfo {
  hostId: string;
  returnTo: string;
  nonce: string;
  intent: ConnectIntent;
  aid?: string;
  /** the link mark, when the sign-in was started from a co-host's private link by this deploy */
  lt?: string;
}

/**
 * What a `state` says, for the callback route to check before anything else happens: whose
 * connection it is, where it returns to, and its single-use nonce (the connect route ties that to
 * the browser with a cookie). Null for a state that is not ours, was altered or has expired.
 * Spends nothing: completeGoogleAuth still claims the nonce.
 */
export function readGoogleState(ctx: Ctx, state: string): GoogleStateInfo | null {
  const payload = verifyPayload<Partial<StatePayload>>(ctx, STATE_PURPOSE, state);
  if (!payload || typeof payload.hostId !== 'string' || typeof payload.n !== 'string' || payload.n === '' || typeof payload.returnTo !== 'string') return null;
  const info: GoogleStateInfo = {
    hostId: payload.hostId,
    returnTo: safeReturnTo(open(ctx, RETURN_PURPOSE, payload.returnTo)) ?? DEFAULT_RETURN,
    nonce: payload.n,
    intent: intentOf(payload.intent),
  };
  if (typeof payload.aid === 'string' && payload.aid !== '') info.aid = payload.aid;
  if (typeof payload.lt === 'string' && payload.lt !== '') info.lt = payload.lt;
  return info;
}

// ───────────────────────── OAuth: token endpoint ─────────────────────────

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  id_token?: unknown;
  /** sent while the OAuth consent screen is in "Testing" (the refresh token then dies after 7 days), or for time-limited access picked on the consent screen */
  refresh_token_expires_in?: unknown;
  error?: unknown;
}

/** POST to the token endpoint. One retry on a network failure or a 5xx; the form (secrets) is never logged. */
async function tokenRequest(ctx: Ctx, form: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === 0) {
        await pause(RETRY_PAUSE_MS);
        continue;
      }
      throw new GoogleApiError('Google could not be reached. Please try again.', 0, 'network');
    }
    if (res.status >= 500 && attempt === 0) {
      await drain(res);
      await pause(RETRY_PAUSE_MS);
      continue;
    }
    const body = await readJsonBody(res);
    return { status: res.status, body: isRecord(body) ? (body as TokenResponse) : {} };
  }
}

/**
 * Where an account's access token is kept. The main account keeps the name it always had, so a deploy mints
 * no new token for it and an older deploy running at the same time shares the entry (the fingerprint ties a
 * cached token to its refresh token, so two accounts can never mix). Other accounts have one of their own.
 */
function tokenCacheName(ref: AccountRef): string {
  return ref.main ? `gtok-${ref.host.id}` : `gtok-${ref.host.id}-${ref.account.id}`;
}

/** Ties a cached access token to the refresh token it was minted from, so a reconnect can never reuse the old account's token. */
function grantFingerprint(refreshTokenEnc: string): string {
  return sha256Hex(refreshTokenEnc).slice(0, 16);
}

async function cacheAccessToken(ctx: Ctx, ref: AccountRef, refreshTokenEnc: string, accessToken: string, expiresIn: unknown): Promise<void> {
  const ttl = Math.floor(Number(expiresIn)) - TOKEN_EXPIRY_MARGIN_SEC;
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  await cacheSet(ctx, tokenCacheName(ref), { t: seal(ctx, ACCESS_PURPOSE, accessToken), fp: grantFingerprint(refreshTokenEnc) }, ttl);
}

async function forgetAccessToken(ctx: Ctx, ref: AccountRef): Promise<void> {
  await cacheSet(ctx, tokenCacheName(ref), null, 0);
}

function grantedScopes(scope: unknown, requested: string[]): string[] {
  const list = str(scope).split(/\s+/).filter(Boolean);
  return list.length > 0 ? list : requested;
}

interface Identity {
  email: string;
  /** Google's own id for the account; '' when Google did not say */
  sub: string;
}

function identityOf(claims: Record<string, unknown>): Identity | null {
  const email = oneLine(claims.email, 254);
  if (!email.includes('@')) return null;
  const sub = oneLine(claims.sub, 255);
  // Google's ids are digits; anything printable without spaces is accepted.
  return { email, sub: /^[\x21-\x7E]{1,255}$/.test(sub) ? sub : '' };
}

/**
 * Who an ID token we received straight from Google's token endpoint over TLS says signed in (so its
 * signature needs no second check); audience and issuer are still compared.
 */
function identityFromIdToken(idToken: unknown, clientId: string): Identity | null {
  const parts = str(idToken).split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!isRecord(claims)) return null;
    if (claims.aud !== clientId) return null;
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return null;
    return identityOf(claims);
  } catch {
    return null;
  }
}

async function identityFromUserinfo(ctx: Ctx, accessToken: string): Promise<Identity | null> {
  try {
    const res = await ctx.fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await drain(res);
      return null;
    }
    const body = await readJsonBody(res);
    return isRecord(body) ? identityOf(body) : null;
  } catch {
    return null;
  }
}

// ───────────────────────── OAuth: callback ─────────────────────────

export interface GoogleAuthResult {
  ok: boolean;
  hostId?: string;
  returnTo: string;
  /** a sentence that can be shown to the person who tried to connect */
  error?: string;
  /** the Google account that is now connected */
  email?: string;
  /** its id (gacc_...) */
  accountId?: string;
  outcome?: ConnectOutcome;
  /** the person picked another account at Google than the one the button was for */
  note?: 'other_account';
  wanted?: string;
  /** true when this host had no Google account at all before */
  firstConnect?: boolean;
  /** when the new connection stops working, if Google said so (consent screen still in "Testing", or a time limit picked) */
  expiresAt?: string;
  /** the main account that "Use a different Google account" dropped */
  dropped?: GoogleAccount;
  intent?: ConnectIntent;
}

const CEILING_REFUSED = `You have connected ${MAX_GOOGLE_ACCOUNTS_PER_HOST} Google accounts, the most one person can have here. Remove one, then add this one again.`;
const NO_LONG_TERM_ACCESS = 'Google did not provide long-term access. Open myaccount.google.com/permissions, remove this app from the list, then connect again.';

/**
 * Handles the redirect back from Google. Never throws: every failure comes back as
 * `{ ok: false, returnTo, error }` so the route can always send the browser somewhere sensible.
 */
export async function completeGoogleAuth(ctx: Ctx, params: URLSearchParams): Promise<GoogleAuthResult> {
  const payload = verifyPayload<Partial<StatePayload>>(ctx, STATE_PURPOSE, params.get('state') ?? '');
  if (!payload || typeof payload.hostId !== 'string' || typeof payload.n !== 'string' || payload.n === '' || typeof payload.returnTo !== 'string') {
    return { ok: false, returnTo: DEFAULT_RETURN, error: 'This Google sign-in link has expired. Please start again.' };
  }
  const returnTo = safeReturnTo(open(ctx, RETURN_PURPOSE, payload.returnTo)) ?? DEFAULT_RETURN;
  const hostId = payload.hostId;
  const intent = intentOf(payload.intent);
  const aid = typeof payload.aid === 'string' && payload.aid !== '' ? payload.aid : undefined;
  const fail = (error: string): GoogleAuthResult => ({ ok: false, hostId, returnTo, error, intent });

  try {
    // Single use, whatever happens next: a state that was seen once is spent.
    if (!(await claim(ctx, `gstate-${payload.n}`))) return fail('This Google sign-in link was already used. Please start again.');

    const denied = params.get('error');
    if (denied) {
      if (denied === 'access_denied') return fail('Google sign-in was cancelled, so nothing was connected.');
      if (denied === 'admin_policy_enforced') {
        return fail("Your organisation's Google admin does not allow this app for that account. Ask them to allow it, or connect another account.");
      }
      const code = codeOf(denied);
      return fail(code ? `Google could not complete the sign-in (${code}).` : 'Google could not complete the sign-in.');
    }
    const code = params.get('code');
    if (!code) return fail('Google did not send a sign-in code. Please try again.');

    const host = await getHost(ctx, hostId);
    if (!host) return fail('This team member no longer exists.');
    const creds = await clientCredentials(ctx);
    if (!creds) return fail('Google is not set up yet. Add the client ID and client secret under Integrations.');

    const { status, body } = await tokenRequest(ctx, {
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: googleRedirectUri(ctx),
      grant_type: 'authorization_code',
    });
    const accessToken = str(body.access_token);
    if (status !== 200 || !accessToken) {
      const reason = codeOf(body.error);
      ctx.log('warn', 'google oauth: code exchange failed', { status, reason });
      if (reason === 'invalid_client' || reason === 'unauthorized_client') {
        return fail('Google rejected the client ID or client secret. Check them under Integrations.');
      }
      if (reason === 'redirect_uri_mismatch') {
        return fail('The redirect address is not registered in Google Cloud. Add the exact redirect address shown under Integrations.');
      }
      if (reason === 'admin_policy_enforced') {
        return fail("Your organisation's Google admin does not allow this app for that account. Ask them to allow it, or connect another account.");
      }
      return fail('Google did not accept the sign-in. Please try again.');
    }

    const requested = payload.gmail === true ? [...GOOGLE_CALENDAR_SCOPES, GMAIL_SEND_SCOPE] : GOOGLE_CALENDAR_SCOPES;
    const scopes = grantedScopes(body.scope, requested);
    const canRead = scopes.includes(SCOPE_CALENDAR_FULL) || scopes.includes(SCOPE_CALENDAR_READONLY);
    const canWrite = scopes.includes(SCOPE_CALENDAR_FULL) || scopes.includes(SCOPE_CALENDAR_EVENTS);
    const newRefreshToken = str(body.refresh_token);
    const revokeFresh = async (): Promise<void> => {
      if (newRefreshToken) await revokeToken(ctx, newRefreshToken, hostId);
    };
    if (!canRead || !canWrite) {
      return fail('Calendar access was not granted. Please connect again and tick every calendar permission on the Google screen.');
    }

    // Accounts are told apart by Google's own id: an address can be renamed, or reused by another account.
    const fromToken = identityFromIdToken(body.id_token, creds.clientId);
    const identity = fromToken?.sub ? fromToken : ((await identityFromUserinfo(ctx, accessToken)) ?? fromToken);
    if (!identity || !identity.sub) return fail('Google did not tell us which account signed in. Please try again.');

    // Google says when the refresh token runs out while the consent screen is still in "Testing" (a
    // connection lasts 7 days there), and when the person picked a time limit on the consent screen. It is
    // stored so the dashboard can say so in time. A later connect without the field (a published app,
    // ongoing access) clears it.
    const expiresInSec = Number(body.refresh_token_expires_in);
    const refreshExpiresAt =
      Number.isFinite(expiresInSec) && expiresInSec > 0 ? new Date(ctx.now().getTime() + Math.floor(expiresInSec) * 1000).toISOString() : undefined;
    if (body.refresh_token_expires_in !== undefined) {
      ctx.log('warn', 'google oauth: the refresh token expires. Publish the OAuth consent screen ("In production") to keep the connection alive, or connect again with ongoing access if a time limit was picked.', { refreshExpiresAt });
    }

    const incoming: IncomingGrant = {
      email: identity.email,
      sub: identity.sub,
      refreshTokenEnc: newRefreshToken ? seal(ctx, REFRESH_PURPOSE, newRefreshToken) : null,
      scopes,
      gmailSend: scopes.includes(GMAIL_SEND_SCOPE),
      ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
      at: ctx.now().toISOString(),
    };
    const canOpen = (sealed: string): boolean => open(ctx, REFRESH_PURPOSE, sealed) !== null;

    const refusal = async (why: 'ceiling' | 'no_refresh_token'): Promise<GoogleAuthResult> => {
      if (why === 'no_refresh_token') return fail(NO_LONG_TERM_ACCESS);
      // Nothing was stored. The fresh grant goes back to Google, unless that account is connected somewhere already.
      if (!heldElsewhere(await listHosts(ctx), hostId, '', identity)) await revokeFresh();
      return fail(CEILING_REFUSED);
    };
    // Read first, so a refusal stores nothing at all.
    const preview = upsertAccount(host, incoming, intent, aid, canOpen);
    if (preview.refused) return refusal(preview.refused);

    let result: UpsertResult = preview;
    const saved = await updateHost(ctx, hostId, (h) => {
      result = upsertAccount(h, incoming, intent, aid, canOpen);
      return result.refused ? h : result.host;
    });
    if (!saved) return fail('This team member no longer exists.');
    if (result.refused) return refusal(result.refused);

    const ref = result.accountId ? findAccount(saved, { id: result.accountId }) : null;
    if (ref) await cacheAccessToken(ctx, ref, ref.account.refreshTokenEnc, accessToken, body.expires_in);
    const answer: GoogleAuthResult = {
      ok: true,
      hostId,
      returnTo,
      email: identity.email,
      accountId: result.accountId,
      outcome: result.outcome,
      firstConnect: result.firstEver,
      intent,
      ...(refreshExpiresAt ? { expiresAt: refreshExpiresAt } : {}),
    };
    if (result.note) answer.note = result.note;
    if (result.wanted) answer.wanted = result.wanted;
    if (result.dropped) answer.dropped = result.dropped;
    return answer;
  } catch (err) {
    ctx.log('error', 'google oauth: callback failed', { error: err instanceof Error ? err.name : 'unknown' });
    return fail(err instanceof GoogleApiError && err.reason === 'network' ? 'Google could not be reached. Please try again.' : 'Something went wrong while connecting Google. Please try again.');
  }
}

// ───────────────────────── access tokens ─────────────────────────

/** Marks one account as needing a reconnect, but only while its stored grant is still the one that failed. */
async function markNeedsReconnect(ctx: Ctx, ref: AccountRef): Promise<void> {
  const failedGrant = ref.account.refreshTokenEnc;
  try {
    await updateHost(ctx, ref.host.id, (h) => {
      if (ref.main) {
        return h.google && h.google.refreshTokenEnc === failedGrant && h.google.status !== 'needs_reconnect' ? { ...h, google: { ...h.google, status: 'needs_reconnect' } } : h;
      }
      const current = findAccount(h, { id: ref.account.id });
      if (!current || current.main || current.account.refreshTokenEnc !== failedGrant || current.account.status === 'needs_reconnect') return h;
      return writeExtra(h, ref.account.id, (a) => ({ ...a, status: 'needs_reconnect' }));
    });
    await forgetAccessToken(ctx, ref);
  } catch {
    ctx.log('error', 'google: could not record that a reconnect is needed', { hostId: ref.host.id, accountId: ref.account.id });
  }
}

/**
 * A main account connected before accounts were told apart by Google's own id has none on record. After
 * its first successful refresh one userinfo call learns it (every grant has openid), and one write stores
 * it with the account's id, but only while the stored grant is still the one that was refreshed. An extra
 * entry that turns out to be the same Google account is folded into the main one in the same write.
 */
async function learnSub(ctx: Ctx, ref: AccountRef, accessToken: string, idToken: unknown): Promise<void> {
  try {
    const creds = await clientCredentials(ctx);
    const fromToken = creds ? identityFromIdToken(idToken, creds.clientId) : null;
    const identity = fromToken?.sub ? fromToken : await identityFromUserinfo(ctx, accessToken);
    if (!identity?.sub) return;
    const grant = ref.account.refreshTokenEnc;
    await updateHost(ctx, ref.host.id, (h) => {
      if (!h.google || h.google.refreshTokenEnc !== grant || h.google.sub) return h;
      const id = typeof h.google.id === 'string' && h.google.id !== '' ? h.google.id : (legacyMainId(h) ?? ref.account.id);
      return foldIntoMain({ ...h, google: { ...h.google, id, sub: identity.sub } }).host;
    });
  } catch (err) {
    ctx.log('warn', 'google: could not learn which Google account a connection is', { hostId: ref.host.id, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/**
 * A valid access token for one account: from the cache while it has more than a minute left,
 * otherwise freshly minted with that account's refresh token. `force` skips the cache (used after a 401).
 * Throws GoogleAuthError when the account has to be connected again.
 */
export async function getGoogleAccessToken(ctx: Ctx, ref: AccountRef, opts?: { force?: boolean }): Promise<string> {
  const google = requireAccount(ref);
  if (google.status === 'needs_reconnect') throw new GoogleAuthError();

  if (!opts?.force) {
    const cached = await cacheGet<{ t?: unknown; fp?: unknown }>(ctx, tokenCacheName(ref));
    if (cached && typeof cached.t === 'string' && cached.fp === grantFingerprint(google.refreshTokenEnc)) {
      const token = open(ctx, ACCESS_PURPOSE, cached.t);
      if (token) return token;
    }
  }

  const refreshToken = open(ctx, REFRESH_PURPOSE, google.refreshTokenEnc);
  if (!refreshToken) {
    // sealed with a key we no longer have
    await markNeedsReconnect(ctx, ref);
    throw new GoogleAuthError();
  }
  const creds = await clientCredentials(ctx);
  if (!creds) throw new GoogleApiError('Google is not set up. Add the client ID and client secret under Integrations.', 0, 'not_configured');

  const { status, body } = await tokenRequest(ctx, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const accessToken = str(body.access_token);
  if (status === 200 && accessToken) {
    await cacheAccessToken(ctx, ref, google.refreshTokenEnc, accessToken, body.expires_in);
    if (ref.main && !google.sub) await learnSub(ctx, ref, accessToken, body.id_token);
    return accessToken;
  }
  const reason = codeOf(body.error);
  ctx.log('warn', 'google: token refresh failed', { hostId: ref.host.id, accountId: google.id, status, reason });
  if (reason === 'invalid_grant') {
    // revoked, expired, or the account's password changed: only a new consent fixes it
    await markNeedsReconnect(ctx, ref);
    throw new GoogleAuthError();
  }
  if (reason === 'invalid_client' || reason === 'unauthorized_client') {
    throw new GoogleApiError('Google rejected the client ID or client secret. Check them under Integrations.', status, reason);
  }
  throw new GoogleApiError(`Google did not issue an access token (${status}).`, status, reason);
}

// ───────────────────────── authorised requests ─────────────────────────

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'PERMISSION_DENIED']);

interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  /** non-2xx statuses the caller wants back instead of an exception */
  allow?: number[];
  /** how long one attempt may take (default REQUEST_TIMEOUT_MS) */
  timeoutMs?: number;
  /**
   * false for a request that must never be sent twice. A Gmail send carries no idempotency key, so after a
   * network failure, a timeout or a 5xx (when Google may have sent the message anyway) it is not posted again
   * here: the job runner decides about a later attempt. A 429 or a rate-limit 403 is a refusal, nothing was
   * done, so that is still tried once more, and a 401 still gets one fresh token.
   */
  repeatable?: boolean;
}

/**
 * One Google API call as one account. Retries once on a network failure, a 5xx or a rate limit
 * (only on a rate limit when `repeatable` is false), and once more with a fresh token after a 401.
 * Everything else becomes GoogleApiError, or GoogleAuthError when only a new consent can fix it.
 */
async function googleApi<T>(ctx: Ctx, ref: AccountRef, req: ApiRequest): Promise<{ status: number; data: T | null }> {
  let token = await getGoogleAccessToken(ctx, ref);
  let retried = false;
  let refreshed = false;
  for (;;) {
    let res: Response;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      res = await ctx.fetch(req.url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (!retried && req.repeatable !== false) {
        retried = true;
        await pause(RETRY_PAUSE_MS);
        continue;
      }
      throw new GoogleApiError('Google could not be reached. Please try again.', 0, 'network');
    }

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await drain(res);
      token = await getGoogleAccessToken(ctx, ref, { force: true });
      continue;
    }
    if (res.ok || req.allow?.includes(res.status)) {
      return { status: res.status, data: res.status === 204 ? null : ((await readJsonBody(res)) as T | null) };
    }

    const reason = apiErrorReason(await readJsonBody(res));
    const refused = res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.has(reason));
    const transient = refused || (res.status >= 500 && req.repeatable !== false);
    if (transient && !retried) {
      retried = true;
      await pause(RETRY_PAUSE_MS);
      continue;
    }
    ctx.log('warn', 'google: request failed', { hostId: ref.host.id, accountId: ref.account.id, method: req.method, status: res.status, reason });
    if (res.status === 401) throw new GoogleAuthError();
    if (res.status === 403 && SCOPE_REASONS.has(reason)) {
      throw new GoogleAuthError('Google permission is missing. Connect Google again and allow every permission it asks for.');
    }
    throw new GoogleApiError(`Google request failed (${res.status}${reason ? ` ${reason}` : ''}).`, res.status, reason);
  }
}

function withQuery(url: string, query: Record<string, string>): string {
  const q = new URLSearchParams(query).toString();
  return q === '' ? url : `${url}?${q}`;
}

// ───────────────────────── free/busy ─────────────────────────

interface FreeBusyResponse {
  calendars?: Record<string, { errors?: { domain?: string; reason?: string }[]; busy?: { start?: string; end?: string }[] }>;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Busy time on the selected calendars of one account, merged, inside `range`.
 * Fails as a whole when Google reports a problem with any one calendar: a partial answer
 * would show the host as free when they may not be.
 */
export async function googleFreeBusy(ctx: Ctx, ref: AccountRef, range: Interval): Promise<Interval[]> {
  const google = requireAccount(ref);
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return [];
  const ids = [...new Set(google.busyCalendarIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) ids.push('primary');

  // Mint (or load) the token once, so the parallel requests below all find it in the cache.
  await getGoogleAccessToken(ctx, ref);
  const requests: Promise<Interval[]>[] = [];
  for (let from = range.start; from < range.end; from += FREEBUSY_CHUNK_MS) {
    const to = Math.min(from + FREEBUSY_CHUNK_MS, range.end);
    for (const group of chunk(ids, FREEBUSY_MAX_CALENDARS)) {
      requests.push(
        googleApi<FreeBusyResponse>(ctx, ref, {
          method: 'POST',
          url: `${CALENDAR_BASE}/freeBusy`,
          body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: group.map((id) => ({ id })) },
          timeoutMs: FREEBUSY_TIMEOUT_MS,
        }).then(({ data }) => {
          const calendars = isRecord(data) && isRecord(data.calendars) ? data.calendars : null;
          if (!calendars) throw new GoogleApiError('Google sent an unreadable free/busy answer.', 200, 'bad_response');
          // Entries are keyed by calendar id; "primary" may come back under the account's address,
          // so the answer is checked by count rather than by key.
          const entries = Object.values(calendars);
          if (entries.length < group.length) throw new GoogleApiError('Google left a calendar out of its free/busy answer.', 200, 'bad_response');
          const busy: Interval[] = [];
          for (const entry of entries) {
            if (!isRecord(entry)) throw new GoogleApiError('Google sent an unreadable free/busy answer.', 200, 'bad_response');
            if (Array.isArray(entry.errors) && entry.errors.length > 0) {
              const reason = isRecord(entry.errors[0]) ? codeOf(entry.errors[0].reason) : '';
              throw new GoogleApiError(`Google could not read one of the selected calendars${reason ? ` (${reason})` : ''}.`, 200, reason || 'calendar_error');
            }
            for (const b of Array.isArray(entry.busy) ? entry.busy : []) {
              const start = Date.parse(str(isRecord(b) ? b.start : ''));
              const end = Date.parse(str(isRecord(b) ? b.end : ''));
              if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start: Math.max(start, range.start), end: Math.min(end, range.end) });
            }
          }
          return busy;
        }),
      );
    }
  }
  return mergeBusy((await Promise.all(requests)).flat());
}

// ───────────────────────── calendar list, settings ─────────────────────────

interface CalendarListResponse {
  items?: unknown[];
  nextPageToken?: string;
}

export async function googleListCalendars(ctx: Ctx, ref: AccountRef): Promise<GoogleCalendarListItem[]> {
  requireAccount(ref);
  const out: GoogleCalendarListItem[] = [];
  let pageToken = '';
  for (let page = 0; page < CALENDAR_LIST_MAX_PAGES; page++) {
    const query: Record<string, string> = { maxResults: '250', minAccessRole: 'freeBusyReader' };
    if (pageToken) query.pageToken = pageToken;
    const { data } = await googleApi<CalendarListResponse>(ctx, ref, { method: 'GET', url: withQuery(`${CALENDAR_BASE}/users/me/calendarList`, query) });
    for (const item of isRecord(data) && Array.isArray(data.items) ? data.items : []) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id === '' || item.deleted === true) continue;
      const entry: GoogleCalendarListItem = {
        id: item.id,
        summary: oneLine(item.summaryOverride, 200) || oneLine(item.summary, 200) || item.id,
        primary: item.primary === true,
        accessRole: str(item.accessRole),
      };
      if (typeof item.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.backgroundColor)) entry.backgroundColor = item.backgroundColor;
      out.push(entry);
    }
    pageToken = isRecord(data) ? str(data.nextPageToken) : '';
    if (!pageToken) break;
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
}

/** The time zone set in one account's Google Calendar settings, or null when it is missing or not a zone we know. */
export async function googleGetTimezone(ctx: Ctx, ref: AccountRef): Promise<IanaZone | null> {
  requireAccount(ref);
  const { data } = await googleApi<{ value?: unknown }>(ctx, ref, { method: 'GET', url: `${CALENDAR_BASE}/users/me/settings/timezone` });
  const value = isRecord(data) ? data.value : null;
  return isValidZone(value) ? value : null;
}

// ───────────────────────── events ─────────────────────────

export interface CalendarEventInput {
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  timezone: IanaZone;
  attendees: { email: string; name?: string; accepted?: boolean }[];
  location?: string;
  createMeet: boolean;
  bookingId: string;
  notifyAttendees: boolean;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  htmlLink?: string;
  extendedProperties?: { private?: Record<string, unknown> };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
    createRequest?: { status?: { statusCode?: string } };
  };
}

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
}

function sendUpdates(notify: boolean): 'all' | 'none' {
  return notify ? 'all' : 'none';
}

/**
 * Event id derived from the booking (Google accepts client ids made of 0-9 and a-v, 5 to 1024 long).
 * Creating the same booking twice, for example when a slow first attempt is retried, then
 * collides with a 409 instead of putting a second event on the calendar.
 */
function eventIdForBooking(bookingId: string): string {
  return `mtg${sha256Hex(bookingId).slice(0, 40)}`;
}

function eventInstant(iso: string | undefined, what: string): string {
  const ms = Date.parse(str(iso));
  if (!Number.isFinite(ms)) throw new GoogleApiError(`The calendar event has no valid ${what} time.`, 0, 'invalid_input');
  return new Date(ms).toISOString();
}

function eventTime(iso: string | undefined, timezone: string | undefined, what: string): Record<string, string> {
  const time: Record<string, string> = { dateTime: eventInstant(iso, what) };
  if (isValidZone(timezone)) time.timeZone = timezone;
  return time;
}

function eventAttendees(list: CalendarEventInput['attendees'], organizerEmail: string): Record<string, string>[] {
  // The organiser is on the event by definition; listing them again only produces a self-invitation.
  const seen = new Set<string>([organizerEmail.trim().toLowerCase()]);
  const out: Record<string, string>[] = [];
  for (const a of list) {
    const email = oneLine(a?.email, 254);
    const key = email.toLowerCase();
    if (!email.includes('@') || /\s/.test(email) || seen.has(key)) continue;
    seen.add(key);
    const attendee: Record<string, string> = { email };
    const name = oneLine(a.name, 200);
    if (name) attendee.displayName = name;
    if (a.accepted === true) attendee.responseStatus = 'accepted';
    out.push(attendee);
  }
  return out;
}

/** Event resource fields for the parts of `input` that are present (everything on create, a subset on patch). */
function eventFields(input: Partial<CalendarEventInput>, organizerEmail: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.summary !== undefined) body.summary = oneLine(input.summary, 1000);
  if (input.description !== undefined) body.description = str(input.description).slice(0, 8000);
  if (input.location !== undefined) body.location = oneLine(input.location, 1000);
  if (input.startIso !== undefined) body.start = eventTime(input.startIso, input.timezone, 'start');
  if (input.endIso !== undefined) body.end = eventTime(input.endIso, input.timezone, 'end');
  if (input.startIso !== undefined && input.endIso !== undefined && Date.parse(input.endIso) <= Date.parse(input.startIso)) {
    throw new GoogleApiError('The calendar event ends before it starts.', 0, 'invalid_input');
  }
  if (input.attendees !== undefined) body.attendees = eventAttendees(input.attendees, organizerEmail);
  if (input.bookingId !== undefined) body.extendedProperties = { private: { meetingBookingId: input.bookingId } };
  if (input.createMeet === true) {
    body.conferenceData = {
      createRequest: { requestId: input.bookingId ?? randomToken(16), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  return body;
}

function meetUrlOf(event: GoogleEvent | null): string | undefined {
  if (!event) return undefined;
  if (typeof event.hangoutLink === 'string' && event.hangoutLink.startsWith('https://')) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find((e) => e?.entryPointType === 'video' && typeof e.uri === 'string' && e.uri.startsWith('https://'));
  return video?.uri;
}

/**
 * Creates the event of a booking in one account, in its "add new meetings to" calendar, or in `calendarId`
 * when given (an event someone deleted comes back where it was).
 */
export async function googleCreateEvent(
  ctx: Ctx,
  ref: AccountRef,
  input: CalendarEventInput,
  opts?: { calendarId?: string },
): Promise<{ eventId: string; calendarId: string; htmlLink?: string; meetUrl?: string }> {
  const google = requireAccount(ref);
  const calendarId = opts?.calendarId || google.writeCalendarId || 'primary';
  const eventId = eventIdForBooking(input.bookingId);
  const fields = {
    ...eventFields(input, google.email),
    reminders: { useDefault: true },
    guestsCanModify: false,
  };
  // conferenceDataVersion=1 is what makes Google act on conferenceData at all
  const query = { conferenceDataVersion: '1', sendUpdates: sendUpdates(input.notifyAttendees) };

  const created = await googleApi<GoogleEvent>(ctx, ref, {
    method: 'POST',
    url: withQuery(eventsUrl(calendarId), query),
    body: { id: eventId, ...fields },
    allow: [409],
  });
  let event = created.status === 409 ? null : created.data;
  if (created.status === 409) {
    // An earlier attempt for this booking already went through: adopt its event.
    event = (await googleApi<GoogleEvent>(ctx, ref, { method: 'GET', url: eventsUrl(calendarId, eventId) })).data;
    if (event?.status === 'cancelled') {
      event = (
        await googleApi<GoogleEvent>(ctx, ref, {
          method: 'PATCH',
          url: withQuery(eventsUrl(calendarId, eventId), query),
          body: { ...fields, status: 'confirmed' },
        })
      ).data;
    }
  }
  if (!event || typeof event.id !== 'string' || event.id === '') {
    throw new GoogleApiError('Google did not return the calendar event.', created.status, 'bad_response');
  }

  let meetUrl = meetUrlOf(event);
  // Meet links are normally there at once. Google creates them asynchronously, though: while it says
  // "pending", look again a few times, with a short pause. "failure" will not change by asking again.
  let pending = event.conferenceData?.createRequest?.status?.statusCode === 'pending';
  for (let look = 0; input.createMeet && !meetUrl && pending && look < MEET_LOOKS; look++) {
    await new Promise((resolve) => setTimeout(resolve, MEET_LOOK_PAUSE_MS));
    try {
      const again = (await googleApi<GoogleEvent>(ctx, ref, { method: 'GET', url: eventsUrl(calendarId, event.id) })).data;
      meetUrl = meetUrlOf(again);
      pending = again?.conferenceData?.createRequest?.status?.statusCode === 'pending';
    } catch {
      // the event exists; a missing link is not worth failing the booking for (the caller asks again later)
      break;
    }
  }
  const result: { eventId: string; calendarId: string; htmlLink?: string; meetUrl?: string } = { eventId: event.id, calendarId };
  if (typeof event.htmlLink === 'string' && event.htmlLink.startsWith('https://')) result.htmlLink = event.htmlLink;
  if (meetUrl) result.meetUrl = meetUrl;
  return result;
}

/**
 * The links of an existing event, read again: the Meet link of an event whose conference Google was still
 * creating when it was inserted. Nothing is changed, so nobody is notified.
 */
export async function googleGetEventLinks(ctx: Ctx, ref: AccountRef, calendarId: string, eventId: string): Promise<{ meetUrl?: string; htmlLink?: string }> {
  requireAccount(ref);
  const event = (await googleApi<GoogleEvent>(ctx, ref, { method: 'GET', url: eventsUrl(calendarId || 'primary', eventId) })).data;
  const out: { meetUrl?: string; htmlLink?: string } = {};
  const meetUrl = meetUrlOf(event);
  if (meetUrl) out.meetUrl = meetUrl;
  if (typeof event?.htmlLink === 'string' && event.htmlLink.startsWith('https://')) out.htmlLink = event.htmlLink;
  return out;
}

/**
 * Reads an event without changing it (nobody is told), to see whether this account holds it: `ours` is
 * true when the event carries our booking id in its private properties. Google keeps those per calendar
 * copy, so an attendee's copy of someone else's event never matches. `status` is 404, 410 or 403 when the
 * account does not have it; other failures throw.
 */
export async function googleGetEvent(ctx: Ctx, ref: AccountRef, calendarId: string, eventId: string): Promise<{ status: number; bookingId: string | null }> {
  requireAccount(ref);
  const { status, data } = await googleApi<GoogleEvent>(ctx, ref, { method: 'GET', url: eventsUrl(calendarId || 'primary', eventId), allow: [403, 404, 410] });
  if (status !== 200) return { status, bookingId: null };
  const id = data?.extendedProperties?.private?.meetingBookingId;
  return { status, bookingId: typeof id === 'string' && id !== '' ? id : null };
}

/**
 * Changes the given fields of an event (PATCH). Attendees are told unless `notifyAttendees` is false:
 * for guests outside Google the update email is the only thing that moves the event in their calendar.
 */
export async function googleUpdateEvent(ctx: Ctx, ref: AccountRef, calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<void> {
  const google = requireAccount(ref);
  const body = eventFields(patch, google.email);
  if (Object.keys(body).length === 0) return;
  await googleApi<GoogleEvent>(ctx, ref, {
    method: 'PATCH',
    url: withQuery(eventsUrl(calendarId || 'primary', eventId), { conferenceDataVersion: '1', sendUpdates: sendUpdates(patch.notifyAttendees !== false) }),
    body,
  });
}

/** Removes an event. An event that is already gone (404 / 410) counts as removed. */
export async function googleDeleteEvent(ctx: Ctx, ref: AccountRef, calendarId: string, eventId: string, notifyAttendees: boolean): Promise<void> {
  requireAccount(ref);
  await googleApi<null>(ctx, ref, {
    method: 'DELETE',
    url: withQuery(eventsUrl(calendarId || 'primary', eventId), { sendUpdates: sendUpdates(notifyAttendees) }),
    allow: [404, 410],
  });
}

// ───────────────────────── gmail ─────────────────────────

/** Sends a complete RFC 5322 message as one account's Gmail (the owner's main account). */
export async function gmailSendRaw(ctx: Ctx, ref: AccountRef, rawMime: string): Promise<{ id: string }> {
  const google = requireAccount(ref);
  if (!google.gmailSend) throw new GoogleAuthError('Sending from Gmail is not enabled. Connect Google again and allow sending email.');
  const { data } = await googleApi<{ id?: unknown }>(ctx, ref, {
    method: 'POST',
    url: GMAIL_SEND_ENDPOINT,
    body: { raw: Buffer.from(rawMime, 'utf8').toString('base64url') },
    // Sent at most once per attempt, with time to answer, so "timed out but sent" stays rare.
    repeatable: false,
    timeoutMs: GMAIL_SEND_TIMEOUT_MS,
  });
  const id = isRecord(data) ? str(data.id) : '';
  if (!id) throw new GoogleApiError('Gmail did not confirm the message.', 200, 'bad_response');
  return { id };
}

// ───────────────────────── removing accounts ─────────────────────────

/** Ends a grant at Google (best effort: nothing local ever waits on it). */
async function revokeToken(ctx: Ctx, refreshToken: string, hostId: string): Promise<void> {
  try {
    const res = await ctx.fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await drain(res);
  } catch {
    ctx.log('warn', 'google: could not revoke the grant', { hostId });
  }
}

/**
 * Google's revoke ends the whole grant of that Google account for this app, not one refresh token. So it
 * only happens when no other entry anywhere is the same Google account: no account of another host, and
 * no other entry of this host.
 */
async function revokeUnlessHeld(ctx: Ctx, hosts: Host[], hostId: string, account: GoogleAccount): Promise<boolean> {
  if (heldElsewhere(hosts, hostId, account.id, account)) return false;
  const refreshToken = typeof account.refreshTokenEnc === 'string' ? open(ctx, REFRESH_PURPOSE, account.refreshTokenEnc) : null;
  if (!refreshToken) return false;
  await revokeToken(ctx, refreshToken, hostId);
  return true;
}

export interface RemovedAccount {
  host: Host;
  removed: GoogleAccount;
  main: boolean;
  /** true when the grant was handed back to Google */
  revoked: boolean;
}

/**
 * Removes one Google account of a host (main or extra) and, when nothing else holds the same Google
 * account, revokes its grant. Removing the main account is the disconnect of old: `host.google` becomes
 * null and the other accounts keep blocking. Null when the host or the account does not exist.
 */
export async function removeGoogleAccount(ctx: Ctx, hostId: string, accountId: string): Promise<RemovedAccount | null> {
  const hosts = await listHosts(ctx);
  const host = hosts.find((h) => h.id === hostId);
  if (!host) return null;
  const target = findAccount(host, { id: accountId });
  if (!target) return null;
  let removed: GoogleAccount | null = null;
  let main = false;
  const saved = await updateHost(ctx, hostId, (h) => {
    const current = findAccount(h, { id: accountId });
    if (!current) {
      removed = null;
      return h;
    }
    removed = current.account;
    main = current.main;
    if (current.main) return { ...h, google: null, calendarHealth: null };
    return { ...removeExtra(h, accountId).host, calendarHealth: null };
  });
  if (!saved || !removed) return null;
  const gone: GoogleAccount = removed;
  await forgetAccessToken(ctx, { host, account: gone, main }).catch(() => undefined);
  const revoked = await revokeUnlessHeld(ctx, hosts, hostId, gone);
  return { host: saved, removed: gone, main, revoked };
}

/**
 * The main account of the host goes (the "Disconnect" of old), revoked unless shared. The other accounts
 * stay and keep blocking.
 */
export async function disconnectGoogle(ctx: Ctx, hostId: string): Promise<void> {
  const host = await getHost(ctx, hostId);
  const main = mainOf(host);
  if (!main) {
    if (host?.google !== undefined && host.google !== null) await updateHost(ctx, hostId, (h) => ({ ...h, google: null, calendarHealth: null }));
    return;
  }
  await removeGoogleAccount(ctx, hostId, main.account.id);
}

/** Every Google account of the host goes, each grant revoked unless something else holds it (deleting a co-host). */
export async function disconnectAllGoogle(ctx: Ctx, hostId: string): Promise<void> {
  // One at a time, each against the record as it is now; bounded, so a record that will not change cannot loop.
  for (let i = 0; i < MAX_GOOGLE_ACCOUNTS_PER_HOST + 5; i++) {
    const host = await getHost(ctx, hostId);
    const ref = host ? accountsOf(host)[0] : undefined;
    if (!ref) return;
    if (!(await removeGoogleAccount(ctx, hostId, ref.account.id))) return;
  }
}
