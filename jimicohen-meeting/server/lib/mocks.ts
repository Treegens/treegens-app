/**
 * In-process stand-ins for the outside world: Google (OAuth, Calendar, Gmail), Resend, Twilio,
 * Anthropic and calendar feeds. The dev server passes `mockFetch` as ctx.fetch, so no test or
 * local run ever talks to a real provider.
 *
 * Each stand-in answers in the shape of the real API, including its errors, because the code
 * under test is the real client code. Every request is recorded in the dev outbox
 * (GET /dev/outbox) as one compact entry:
 *
 *   { id, at, service, kind, method, url, status, ok, ...details }
 *
 *   service  google | gmail | resend | twilio | anthropic | ics | unknown
 *   kind     token, userinfo, revoke, calendar_list, timezone, freebusy, calendar_insert,
 *            calendar_get, calendar_patch, calendar_delete, email, email_duplicate, sms, call,
 *            call_update, call_get, llm, ics_feed, unknown
 *   at       the dev clock when it is frozen, otherwise the clock handed to configureMocks
 *
 * Conventions a test can rely on:
 *   - OAuth code `mock:<email>:<zone>[:flag...]` signs in as that Google account with that
 *     Calendar time zone. Flags: gmail (grant gmail.send), norefresh (no refresh token),
 *     nocalendar (calendar scopes not granted), noidtoken (identity only through userinfo),
 *     testing (the consent screen is in "Testing": the refresh token ends after 7 days).
 *   - A credential that starts with "invalid" (client secret, API key, auth token) is turned
 *     down the way the real provider turns down a wrong one.
 *   - KV `dev/google-busy/<email>` holds extra busy intervals of an account. Events created
 *     through the mock are busy as well, for the organiser and for attendees who did not decline.
 *   - KV `dev/fail/<service>` makes a service fail (see DevFailSpec). Service names, from narrow
 *     to wide: google-token, google-userinfo, google-revoke, google-oauth, google-freebusy,
 *     google-calendar-list, google-timezone, google-events-insert, google-events-get,
 *     google-events-patch, google-events-delete, google-events, google-calendar, gmail, google,
 *     resend, email, twilio-sms, sms, twilio-calls, twilio-call-update, call, twilio,
 *     anthropic, llm, ics.
 *   - Anything without a stand-in answers 501 and is recorded with kind "unknown".
 */
import { createHash, randomBytes } from 'node:crypto';
import { IANAZone } from 'luxon';
import {
  DEV_FAIL_PREFIX,
  DEV_GOOGLE_ACCOUNT_PREFIX,
  DEV_GOOGLE_BUSY_PREFIX,
  DEV_GOOGLE_EVENT_PREFIX,
  DEV_ICS_ORIGIN,
  DEV_ICS_PREFIX,
  DEV_LLM_SCRIPT_KEY,
  DEV_TWILIO_CALL_PREFIX,
  appendOutbox,
  devAccountKey,
  ensureMockAccount,
  mockAccountBySub,
  parseFailSpec,
  readDevClock,
  type DevBusyInterval,
  type DevFailSpec,
  type DevGoogleAccount,
  type DevGoogleCalendar,
  type DevIcsFeed,
} from '../routes/dev';
import type { KV } from './ctx';

// ───────────────────────── set-up ─────────────────────────

export interface MockOptions {
  kv: KV;
  /** The clock to stamp records with while the dev clock is not frozen. */
  now?: () => Date;
}

let configured: MockOptions | null = null;

export function configureMocks(opts: MockOptions): void {
  configured = opts;
}

/** The KV handed over by the dev server, or null when the mocks run without one. */
export function getMockKV(): KV | null {
  return configured?.kv ?? null;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** A fetch that answers from the stand-ins, with its own store. Tests use this with memoryKV. */
export function createMockFetch(opts: MockOptions): typeof fetch {
  return (input: FetchInput, init?: FetchInit) => serve(opts, input, init);
}

/** The fetch the dev server installs. Uses whatever configureMocks was last given. */
export async function mockFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  if (!configured) {
    return jsonResponse(501, { error: { code: 'mock_not_configured', message: 'The provider mocks have no store yet. Call configureMocks({ kv }) first.' } });
  }
  return serve(configured, input, init);
}

// Compile-time proof that mockFetch can stand in for fetch.
const _typecheck: typeof fetch = mockFetch;
void _typecheck;

// ───────────────────────── plumbing ─────────────────────────

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  signal: AbortSignal;
}

interface Mock {
  kv: KV;
  /** ISO time of this call: the frozen dev clock, else the configured clock, else null */
  at: string | null;
  /** the same instant as epoch ms, or null when no clock is known */
  nowMs: number | null;
}

interface Outcome {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** details added to the outbox entry */
  entry?: Record<string, unknown>;
  /** overrides the kind of the plan (a repeated send becomes "email_duplicate") */
  kind?: string;
}

interface Plan {
  service: string;
  kind: string;
  /** names under dev/fail/ that hit this call, narrowest first */
  tags: string[];
  /** the Google account the call is made as, when the request says so */
  account?: string;
  run: (mock: Mock) => Promise<Outcome>;
}

const REVOKED_PREFIX = 'dev/google-revoked/';
const RESEND_IDEMPOTENCY_PREFIX = 'dev/resend-idem/';
const MAX_TEXT = 20_000;
const MAX_HTML = 60_000;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function toResponse(outcome: Outcome): Response {
  if (outcome.status === 204 || outcome.status === 304) return new Response(null, { status: outcome.status, headers: outcome.headers });
  if (outcome.text !== undefined) {
    return new Response(outcome.text, { status: outcome.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...outcome.headers } });
  }
  return jsonResponse(outcome.status, outcome.json ?? {}, outcome.headers);
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function b64u(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseJson(text: string): unknown {
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Never answers. Rejects when the caller gives up, or after `ms` like a connection that timed out. */
function hang(signal: AbortSignal, ms: number | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, ms ?? 30_000);
    (timer as { unref?: () => void }).unref?.();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function serve(opts: MockOptions, input: FetchInput, init?: FetchInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.signal.aborted) throw abortReason(request.signal);
  const call: Call = {
    method: request.method.toUpperCase(),
    url: new URL(request.url),
    headers: request.headers,
    body: request.body ? await request.text() : '',
    signal: request.signal,
  };

  const now = (await readDevClock(opts.kv)) ?? opts.now?.() ?? null;
  const mock: Mock = { kv: opts.kv, at: now ? now.toISOString() : null, nowMs: now ? now.getTime() : null };
  const plan = route(call);
  const base: Record<string, unknown> = {
    id: `out_${hex(6)}`,
    at: mock.at,
    service: plan.service,
    kind: plan.kind,
    method: call.method,
    url: `${call.url.origin}${call.url.pathname}`,
  };
  if (plan.account) base.account = plan.account;

  const failure = await takeFailure(opts.kv, plan.tags, plan.account);
  if (failure && failure.spec.mode === 'delay') {
    await sleep(failure.spec.ms ?? 1000, call.signal);
    base.delayedMs = failure.spec.ms ?? 1000;
  } else if (failure) {
    const { spec } = failure;
    await appendOutbox(opts.kv, { ...base, status: spec.mode === 'error' ? (spec.status ?? 500) : 0, ok: false, injected: spec.mode, failService: failure.service });
    if (spec.mode === 'network') throw new TypeError('fetch failed');
    if (spec.mode === 'timeout') return hang(call.signal, spec.ms);
    return toResponse(injectedError(plan, failure.service, spec));
  }

  let outcome: Outcome;
  try {
    outcome = await plan.run(mock);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = { status: 500, json: { error: { code: 'mock_crashed', message: `The mock for ${plan.service} ${plan.kind} failed: ${message}` } }, entry: { mockError: message } };
  }
  await appendOutbox(opts.kv, {
    ...base,
    ...(outcome.kind ? { kind: outcome.kind } : {}),
    status: outcome.status,
    ok: outcome.status >= 200 && outcome.status < 300,
    ...outcome.entry,
  });
  return toResponse(outcome);
}

// ───────────────────────── failure injection ─────────────────────────

async function takeFailure(kv: KV, tags: string[], account: string | undefined): Promise<{ service: string; spec: DevFailSpec } | null> {
  for (const service of tags) {
    const key = `${DEV_FAIL_PREFIX}${service}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const found = await kv.getJSONWithEtag<unknown>(key);
      const spec = found ? parseFailSpec(found.value) : null;
      if (!found || !spec) break;
      if (spec.account && spec.account !== devAccountKey(account ?? '')) break;
      if (spec.times === undefined) return { service, spec };
      // Counted failures: each call takes one, and the last one removes the key.
      const next = spec.times > 1 ? { ...spec, times: spec.times - 1 } : { mode: 'spent' };
      const written = await kv.setJSON(key, next, { onlyIfMatch: found.etag });
      if (!written.modified) continue;
      if (spec.times <= 1) await kv.delete(key);
      return { service, spec };
    }
  }
  return null;
}

function injectedError(plan: Plan, failService: string, spec: DevFailSpec): Outcome {
  const status = spec.status ?? 500;
  const message = spec.message ?? `Injected failure (dev/fail/${failService}).`;
  if (plan.service === 'twilio') return { status, json: twilioErrorBody(status, typeof spec.code === 'number' ? spec.code : 20500, message) };
  if (plan.service === 'resend') return { status, json: { statusCode: status, name: typeof spec.code === 'string' ? spec.code : 'internal_server_error', message } };
  if (plan.service === 'anthropic') {
    const type = typeof spec.code === 'string' ? spec.code : status === 529 ? 'overloaded_error' : status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error';
    return { status, json: { type: 'error', error: { type, message }, request_id: `req_mock_${hex(6)}` }, headers: { 'request-id': `req_mock_${hex(6)}` } };
  }
  if (plan.service === 'ics') return { status, text: message };
  if (plan.kind === 'token' || plan.kind === 'revoke') return { status, json: { error: typeof spec.code === 'string' ? spec.code : 'server_error', error_description: message } };
  return googleError(status, typeof spec.code === 'string' ? spec.code : 'backendError', message, status >= 500 ? 'INTERNAL' : undefined);
}

// ───────────────────────── routing ─────────────────────────

function route(call: Call): Plan {
  const { method, url } = call;
  const host = url.hostname;
  const path = url.pathname;

  if (host === 'oauth2.googleapis.com' && method === 'POST' && path === '/token') return planGoogleToken(call);
  if (host === 'oauth2.googleapis.com' && method === 'POST' && path === '/revoke') return planGoogleRevoke(call);
  if (host === 'openidconnect.googleapis.com' && method === 'GET' && path === '/v1/userinfo') return planGoogleUserinfo(call);
  if (host === 'www.googleapis.com' && path.startsWith('/calendar/v3/')) {
    const plan = planCalendar(call, path.slice('/calendar/v3'.length));
    if (plan) return plan;
  }
  if (host === 'gmail.googleapis.com' && method === 'POST' && path === '/gmail/v1/users/me/messages/send') return planGmailSend(call);
  if (host === 'api.resend.com' && method === 'POST' && path === '/emails') return planResend(call);
  if (host === 'api.twilio.com') {
    const plan = planTwilio(call);
    if (plan) return plan;
  }
  if (host === 'api.anthropic.com' && method === 'POST' && path === '/v1/messages') return planAnthropic(call);
  if (url.origin === DEV_ICS_ORIGIN && method === 'GET') return planIcsFeed(call);

  return {
    service: 'unknown',
    kind: 'unknown',
    tags: [],
    run: async () => ({
      status: 501,
      json: { error: { code: 'mock_not_implemented', message: `No mock for ${method} ${url.origin}${url.pathname}. Add one to server/lib/mocks.ts.` } },
      entry: { query: url.search, requestBody: clip(call.body, 2000) },
    }),
  };
}

// ───────────────────────── Google: accounts and tokens ─────────────────────────

const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
const SCOPE_CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const SCOPE_CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const ACCESS_TOKEN_TTL_SEC = 3599;

interface TokenClaims {
  /** account email when the token was minted */
  e: string;
  /** the account's sub: a token belongs to the Google account, not to an address */
  u?: string;
  /** grant generation the token was minted in: a revoke ends every older one */
  g?: number;
  /** Calendar time zone from the sign-in code */
  z: string;
  /** granted scopes */
  s: string[];
  /** expiry, epoch ms (access tokens only, and only when a clock is known) */
  x?: number;
}

function mintToken(prefix: 'mock-at' | 'mock-rt', claims: TokenClaims): string {
  return `${prefix}.${b64u(JSON.stringify(claims))}.${hex(8)}`;
}

function readToken(prefix: 'mock-at' | 'mock-rt', token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const claims = parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!isRecord(claims) || typeof claims.e !== 'string' || typeof claims.z !== 'string' || !Array.isArray(claims.s)) return null;
  return {
    e: claims.e,
    z: claims.z,
    s: claims.s.filter((s): s is string => typeof s === 'string'),
    ...(typeof claims.x === 'number' ? { x: claims.x } : {}),
    ...(typeof claims.u === 'string' ? { u: claims.u } : {}),
    ...(typeof claims.g === 'number' ? { g: claims.g } : {}),
  };
}

function bearer(call: Call): string {
  return /^Bearer\s+(\S+)$/i.exec(call.headers.get('authorization') ?? '')?.[1] ?? '';
}

interface AuthCode {
  email: string;
  zone: string;
  flags: Set<string>;
}

/** `mock:<email>:<zone>[:flag...]` */
function parseAuthCode(code: string): AuthCode | null {
  const parts = code.split(':');
  if (parts.length < 3 || parts[0] !== 'mock') return null;
  const email = devAccountKey(parts[1]);
  const zone = parts[2];
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !IANAZone.isValidZone(zone)) return null;
  return { email, zone, flags: new Set(parts.slice(3).map((f) => f.toLowerCase())) };
}

async function loadAccount(kv: KV, email: string): Promise<DevGoogleAccount> {
  return (await kv.getJSON<DevGoogleAccount>(`${DEV_GOOGLE_ACCOUNT_PREFIX}${email}`)) ?? { email };
}

/**
 * The account a token belongs to: found by its sub wherever its address is now (a renamed account keeps
 * working), null when no account has that sub any more. Tokens from before subs were kept go by address.
 */
async function accountOfToken(kv: KV, claims: TokenClaims): Promise<DevGoogleAccount | null> {
  if (claims.u) return mockAccountBySub(kv, claims.u);
  return loadAccount(kv, claims.e);
}

/** Whether a revoke since the token was minted ended its grant. */
function grantEnded(account: DevGoogleAccount, claims: TokenClaims): boolean {
  return (claims.g ?? 0) < (account.grant ?? 0);
}

function oauthError(status: number, error: string, description: string): Outcome {
  return { status, json: { error, error_description: description }, entry: { error } };
}

function googleError(status: number, reason: string, message: string, statusText?: string): Outcome {
  return {
    status,
    json: { error: { code: status, message, errors: [{ domain: 'global', reason, message }], ...(statusText ? { status: statusText } : {}) } },
    entry: { error: reason },
  };
}

function planGoogleToken(call: Call): Plan {
  const form = new URLSearchParams(call.body);
  const grant = form.get('grant_type') ?? '';
  const code = parseAuthCode(form.get('code') ?? '');
  const refresh = readToken('mock-rt', form.get('refresh_token') ?? '');
  const account = grant === 'authorization_code' ? code?.email : refresh?.e;

  return {
    service: 'google',
    kind: 'token',
    tags: ['google-token', 'google-oauth', 'google'],
    account,
    run: async (mock) => {
      const clientId = form.get('client_id') ?? '';
      const clientSecret = form.get('client_secret') ?? '';
      if (!clientId || !clientSecret) return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
      if (clientId.startsWith('invalid') || clientSecret.startsWith('invalid')) return oauthError(401, 'invalid_client', 'Unauthorized');

      if (grant === 'authorization_code') {
        if (!code) return oauthError(400, 'invalid_grant', 'Malformed auth code. The mock expects code=mock:<email>:<zone>.');
        if (!(form.get('redirect_uri') ?? '').endsWith('/api/google/callback')) return oauthError(400, 'redirect_uri_mismatch', 'Bad Request');
        const scopes = ['openid', SCOPE_EMAIL];
        if (!code.flags.has('nocalendar')) scopes.push(SCOPE_CALENDAR_READONLY, SCOPE_CALENDAR_EVENTS);
        if (code.flags.has('gmail')) scopes.push(SCOPE_GMAIL_SEND);
        // Signing in again makes the account whole: a fresh grant, with the zone the code names.
        const known = await ensureMockAccount(mock.kv, code.email);
        await mock.kv.setJSON(`${DEV_GOOGLE_ACCOUNT_PREFIX}${code.email}`, { ...known, email: code.email, timezone: code.zone, revoked: false });
        const claims: TokenClaims = { e: code.email, z: code.zone, s: scopes, u: known.sub, g: known.grant ?? 0 };

        const body: Record<string, unknown> = {
          access_token: mintToken('mock-at', withExpiry(claims, mock)),
          expires_in: ACCESS_TOKEN_TTL_SEC,
          scope: scopes.join(' '),
          token_type: 'Bearer',
        };
        if (!code.flags.has('norefresh')) body.refresh_token = mintToken('mock-rt', claims);
        // What Google adds while the OAuth consent screen is still in "Testing": the grant ends after 7 days.
        if (code.flags.has('testing') && !code.flags.has('norefresh')) body.refresh_token_expires_in = 604_799;
        if (!code.flags.has('noidtoken')) body.id_token = idToken(code.email, known.sub ?? '', clientId, mock);
        return { status: 200, json: body, entry: { grant, scopes, refreshTokenIssued: !code.flags.has('norefresh'), timezone: code.zone } };
      }

      if (grant === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!refresh) return oauthError(400, 'invalid_grant', 'Bad Request');
        const owner = await accountOfToken(mock.kv, refresh);
        const revoked = !owner || (await mock.kv.getJSON<unknown>(`${REVOKED_PREFIX}${sha(token).slice(0, 32)}`)) !== null || owner.revoked === true || grantEnded(owner, refresh);
        if (!owner || revoked) return oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
        return {
          status: 200,
          json: { access_token: mintToken('mock-at', withExpiry({ ...refresh, e: owner.email }, mock)), expires_in: ACCESS_TOKEN_TTL_SEC, scope: refresh.s.join(' '), token_type: 'Bearer' },
          entry: { grant, scopes: refresh.s },
        };
      }

      return oauthError(400, 'unsupported_grant_type', `Invalid grant_type: ${grant}`);
    },
  };
}

function withExpiry(claims: TokenClaims, mock: Mock): TokenClaims {
  const { x: _old, ...rest } = claims;
  return mock.nowMs === null ? rest : { ...rest, x: mock.nowMs + ACCESS_TOKEN_TTL_SEC * 1000 };
}

function idToken(email: string, sub: string, clientId: string, mock: Mock): string {
  const iat = Math.floor((mock.nowMs ?? 0) / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    azp: clientId,
    aud: clientId,
    sub,
    email,
    email_verified: true,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SEC,
  };
  return `${b64u(JSON.stringify({ alg: 'RS256', kid: 'mock', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}.${b64u('mock-signature')}`;
}

function planGoogleRevoke(call: Call): Plan {
  const token = new URLSearchParams(call.body).get('token') ?? '';
  const claims = readToken('mock-rt', token) ?? readToken('mock-at', token);
  return {
    service: 'google',
    kind: 'revoke',
    tags: ['google-revoke', 'google-oauth', 'google'],
    account: claims?.e,
    run: async (mock) => {
      if (!claims) return oauthError(400, 'invalid_token', 'Token expired or revoked');
      await mock.kv.setJSON(`${REVOKED_PREFIX}${sha(token).slice(0, 32)}`, { at: mock.at });
      // Like Google: the revoke ends the whole grant of that account for this app, every token of it.
      const owner = await accountOfToken(mock.kv, claims);
      if (owner) await mock.kv.setJSON(`${DEV_GOOGLE_ACCOUNT_PREFIX}${owner.email}`, { ...owner, grant: (owner.grant ?? 0) + 1 });
      return { status: 200, json: {}, entry: { grantEnded: !!owner } };
    },
  };
}

/** Checks the bearer token the way Google does: unknown, expired and revoked tokens all get a 401. */
async function googleSession(mock: Mock, call: Call): Promise<{ claims: TokenClaims; account: DevGoogleAccount } | Outcome> {
  const claims = readToken('mock-at', bearer(call));
  const denied = googleError(401, 'authError', 'Invalid Credentials', 'UNAUTHENTICATED');
  if (!claims) return denied;
  if (claims.x !== undefined && mock.nowMs !== null && mock.nowMs >= claims.x) return denied;
  const account = await accountOfToken(mock.kv, claims);
  if (!account || account.revoked === true || grantEnded(account, claims)) return denied;
  return { claims, account };
}

function isOutcome(v: { claims: TokenClaims; account: DevGoogleAccount } | Outcome): v is Outcome {
  return 'status' in v;
}

function planGoogleUserinfo(call: Call): Plan {
  return {
    service: 'google',
    kind: 'userinfo',
    tags: ['google-userinfo', 'google-oauth', 'google'],
    account: readToken('mock-at', bearer(call))?.e,
    run: async (mock) => {
      const session = await googleSession(mock, call);
      if (isOutcome(session)) return session;
      const { email } = session.account;
      return { status: 200, json: { sub: session.account.sub ?? (await ensureMockAccount(mock.kv, email)).sub, email, email_verified: true } };
    },
  };
}

// ───────────────────────── Google Calendar ─────────────────────────

interface StoredEvent {
  account: string;
  calendarId: string;
  event: Record<string, unknown>;
}

function calendarsOf(account: DevGoogleAccount): DevGoogleCalendar[] {
  const primary: DevGoogleCalendar = { id: account.email, summary: account.email, primary: true, accessRole: 'owner', backgroundColor: '#9fe1e7' };
  const custom = account.calendars ?? [];
  if (custom.length > 0) return custom.some((c) => c.primary) ? custom : [primary, ...custom];
  return [
    primary,
    { id: `family${sha(account.email).slice(0, 20)}@group.calendar.google.com`, summary: 'Family', accessRole: 'owner', backgroundColor: '#f691b2' },
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', accessRole: 'reader', backgroundColor: '#16a765' },
  ];
}

function findCalendar(account: DevGoogleAccount, id: string): DevGoogleCalendar | null {
  const calendars = calendarsOf(account);
  if (id === 'primary') return calendars.find((c) => c.primary) ?? null;
  return calendars.find((c) => c.id.toLowerCase() === id.toLowerCase()) ?? null;
}

function zoneOf(session: { claims: TokenClaims; account: DevGoogleAccount }): string {
  return session.account.timezone || session.claims.z;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function planCalendar(call: Call, path: string): Plan | null {
  const account = readToken('mock-at', bearer(call))?.e;
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const make = (kind: string, tags: string[], run: (mock: Mock, session: { claims: TokenClaims; account: DevGoogleAccount }) => Promise<Outcome>): Plan => ({
    service: 'google',
    kind,
    tags: [...tags, 'google-calendar', 'google'],
    account,
    run: async (mock) => {
      const session = await googleSession(mock, call);
      return isOutcome(session) ? session : run(mock, session);
    },
  });

  if (call.method === 'GET' && path === '/users/me/calendarList') {
    return make('calendar_list', ['google-calendar-list'], async (_mock, session) => {
      const zone = zoneOf(session);
      const items = calendarsOf(session.account).map((c) => ({
        kind: 'calendar#calendarListEntry',
        etag: `"${sha(c.id).slice(0, 16)}"`,
        id: c.id,
        summary: c.summary,
        timeZone: zone,
        accessRole: c.accessRole ?? 'owner',
        backgroundColor: c.backgroundColor ?? '#9fe1e7',
        foregroundColor: '#000000',
        selected: true,
        ...(c.primary ? { primary: true } : {}),
      }));
      return { status: 200, json: { kind: 'calendar#calendarList', etag: `"${hex(8)}"`, items }, entry: { calendars: items.map((i) => i.id) } };
    });
  }

  if (call.method === 'GET' && path === '/users/me/settings/timezone') {
    return make('timezone', ['google-timezone'], async (_mock, session) => {
      const value = zoneOf(session);
      return { status: 200, json: { kind: 'calendar#setting', etag: `"${sha(value).slice(0, 16)}"`, id: 'timezone', value }, entry: { timezone: value } };
    });
  }

  if (call.method === 'POST' && path === '/freeBusy') {
    return make('freebusy', ['google-freebusy'], (mock, session) => freeBusy(mock, call, session));
  }

  if (segments[0] === 'calendars' && segments[2] === 'events' && segments.length === 3 && call.method === 'POST') {
    return make('calendar_insert', ['google-events-insert', 'google-events'], (mock, session) => insertEvent(mock, call, session, segments[1]));
  }
  if (segments[0] === 'calendars' && segments[2] === 'events' && segments.length === 4) {
    const [, calendarId, , eventId] = segments;
    if (call.method === 'GET') return make('calendar_get', ['google-events-get', 'google-events'], (mock, session) => getEvent(mock, session, calendarId, eventId));
    if (call.method === 'PATCH' || call.method === 'PUT') {
      return make('calendar_patch', ['google-events-patch', 'google-events'], (mock, session) => patchEvent(mock, call, session, calendarId, eventId));
    }
    if (call.method === 'DELETE') return make('calendar_delete', ['google-events-delete', 'google-events'], (mock, session) => deleteEvent(mock, call, session, calendarId, eventId));
  }
  return null;
}

function eventKey(account: string, eventId: string): string {
  return `${DEV_GOOGLE_EVENT_PREFIX}${account}/${eventId}`;
}

function eventInterval(event: Record<string, unknown>): { start: number; end: number } | null {
  const instant = (v: unknown): number => {
    if (!isRecord(v)) return NaN;
    return Date.parse(str(v.dateTime) || (str(v.date) ? `${str(v.date)}T00:00:00Z` : ''));
  };
  const start = instant(event.start);
  const end = instant(event.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function attendeesOf(event: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(event.attendees) ? event.attendees.filter(isRecord) : [];
}

/** Busy time of one calendar: what a test configured, plus the events that sit on it. */
async function busyOfCalendar(mock: Mock, account: DevGoogleAccount, calendar: DevGoogleCalendar): Promise<{ start: number; end: number }[]> {
  const out: { start: number; end: number }[] = [];
  for (const entry of (await mock.kv.getJSON<DevBusyInterval[]>(`${DEV_GOOGLE_BUSY_PREFIX}${account.email}`)) ?? []) {
    const onPrimary = !entry.calendarId || entry.calendarId === 'primary' || entry.calendarId.toLowerCase() === account.email;
    if (calendar.primary ? !onPrimary : entry.calendarId !== calendar.id) continue;
    const start = Date.parse(entry.start);
    const end = Date.parse(entry.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
  }
  for (const key of await mock.kv.list(DEV_GOOGLE_EVENT_PREFIX)) {
    const stored = await mock.kv.getJSON<StoredEvent>(key);
    if (!stored || stored.event.status === 'cancelled' || stored.event.transparency === 'transparent') continue;
    const own = stored.account === account.email && stored.calendarId === calendar.id;
    // An invitation lands on the guest's main calendar and blocks it unless they declined.
    const invited =
      calendar.primary === true &&
      stored.account !== account.email &&
      attendeesOf(stored.event).some((a) => devAccountKey(str(a.email)) === account.email && a.responseStatus !== 'declined');
    if (!own && !invited) continue;
    const interval = eventInterval(stored.event);
    if (interval) out.push(interval);
  }
  return out;
}

async function freeBusy(mock: Mock, call: Call, session: { claims: TokenClaims; account: DevGoogleAccount }): Promise<Outcome> {
  const body = parseJson(call.body);
  if (!isRecord(body)) return googleError(400, 'parseError', 'Parse Error');
  const timeMin = Date.parse(str(body.timeMin));
  const timeMax = Date.parse(str(body.timeMax));
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) return googleError(400, 'required', 'Missing timeMin or timeMax parameter.');
  if (timeMax <= timeMin) return googleError(400, 'timeRangeEmpty', 'The specified time range is empty.');
  const ids = (Array.isArray(body.items) ? body.items : []).map((item) => (isRecord(item) ? str(item.id) : '')).filter(Boolean);

  const calendars: Record<string, unknown> = {};
  const summary: Record<string, { start: string; end: string }[]> = {};
  for (const id of ids) {
    const calendar = findCalendar(session.account, id);
    if (!calendar) {
      calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
      continue;
    }
    const clipped = (await busyOfCalendar(mock, session.account, calendar))
      .map((iv) => ({ start: Math.max(iv.start, timeMin), end: Math.min(iv.end, timeMax) }))
      .filter((iv) => iv.end > iv.start)
      .sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const iv of clipped) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
      else merged.push({ ...iv });
    }
    const busy = merged.map((iv) => ({ start: new Date(iv.start).toISOString(), end: new Date(iv.end).toISOString() }));
    calendars[id] = { busy };
    summary[id] = busy;
  }
  return {
    status: 200,
    json: { kind: 'calendar#freeBusy', timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), calendars },
    entry: { timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), calendars: ids, busy: summary },
  };
}

function normaliseAttendees(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((a) => ({ ...a, responseStatus: str(a.responseStatus) || 'needsAction' }));
}

function meetFor(eventId: string, requestId: string): Record<string, unknown> {
  const digest = sha(`meet:${eventId}`);
  const letters = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + (parseInt(digest.slice(i * 2, i * 2 + 2), 16) % 26))).join('');
  const code = `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7, 10)}`;
  const uri = `https://meet.google.com/${code}`;
  return {
    hangoutLink: uri,
    conferenceData: {
      createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'success' } },
      entryPoints: [{ entryPointType: 'video', uri, label: `meet.google.com/${code}` }],
      conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
      conferenceId: code,
    },
  };
}

function wantsMeet(call: Call, body: Record<string, unknown>): string | null {
  if (Number(call.url.searchParams.get('conferenceDataVersion') ?? '0') < 1) return null;
  const request = isRecord(body.conferenceData) && isRecord(body.conferenceData.createRequest) ? body.conferenceData.createRequest : null;
  if (!request) return null;
  const key = isRecord(request.conferenceSolutionKey) ? str(request.conferenceSolutionKey.type) : '';
  return key === '' || key === 'hangoutsMeet' ? str(request.requestId) || hex(8) : null;
}

/** The parts of an event a test asserts on. */
function compactEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'status', 'summary', 'description', 'location', 'start', 'end', 'attendees', 'hangoutLink', 'extendedProperties', 'sequence', 'htmlLink', 'guestsCanModify', 'reminders']) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  if (isRecord(event.organizer)) out.organizer = event.organizer.email;
  return out;
}

function notifiedBy(call: Call, event: Record<string, unknown>, organizer: string): { sendUpdates: string; notified: string[] } {
  const sendUpdates = call.url.searchParams.get('sendUpdates') ?? 'none';
  const guests = attendeesOf(event)
    .map((a) => str(a.email))
    .filter((email) => email !== '' && devAccountKey(email) !== organizer);
  return { sendUpdates, notified: sendUpdates === 'all' ? guests : [] };
}

function validateEventTimes(body: Record<string, unknown>): Outcome | null {
  const has = (v: unknown): boolean => isRecord(v) && (str(v.dateTime) !== '' || str(v.date) !== '');
  if (!has(body.start)) return googleError(400, 'required', 'Missing start time.');
  if (!has(body.end)) return googleError(400, 'required', 'Missing end time.');
  if (!eventInterval(body)) return googleError(400, 'timeRangeEmpty', 'The specified time range is empty.');
  return null;
}

async function insertEvent(mock: Mock, call: Call, session: { claims: TokenClaims; account: DevGoogleAccount }, calendarId: string): Promise<Outcome> {
  const email = session.account.email;
  if (!session.claims.s.includes(SCOPE_CALENDAR_EVENTS)) return googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', 'PERMISSION_DENIED');
  const calendar = findCalendar(session.account, calendarId);
  if (!calendar) return googleError(404, 'notFound', 'Not Found');
  if (calendar.accessRole === 'reader' || calendar.accessRole === 'freeBusyReader') {
    return googleError(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.');
  }
  const body = parseJson(call.body);
  if (!isRecord(body)) return googleError(400, 'parseError', 'Parse Error');
  const bad = validateEventTimes(body);
  if (bad) return bad;

  const id = body.id === undefined ? hex(13) : str(body.id);
  if (!/^[a-v0-9]{5,1024}$/.test(id)) return googleError(400, 'invalid', 'Invalid resource id value.');
  const stamp = mock.at ?? new Date(0).toISOString();
  const { id: _id, conferenceData: _conference, attendees: _attendees, ...fields } = body;
  const event: Record<string, unknown> = {
    kind: 'calendar#event',
    etag: `"${hex(8)}"`,
    id,
    status: 'confirmed',
    htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${email}`, 'utf8').toString('base64url')}`,
    created: stamp,
    updated: stamp,
    creator: { email, self: true },
    organizer: { email: calendar.id, self: true },
    iCalUID: `${id}@google.com`,
    sequence: 0,
    eventType: 'default',
    ...fields,
  };
  const attendees = normaliseAttendees(body.attendees);
  if (attendees.length > 0) event.attendees = attendees;
  const meetRequest = wantsMeet(call, body);
  if (meetRequest) Object.assign(event, meetFor(id, meetRequest));

  // Ids stay taken for good, also by deleted events: a second insert is a conflict, like on the real API.
  const written = await mock.kv.setJSON(eventKey(email, id), { account: email, calendarId: calendar.id, event } satisfies StoredEvent, { onlyIfNew: true });
  if (!written.modified) return googleError(409, 'duplicate', 'The requested identifier already exists.');
  return {
    status: 200,
    json: event,
    entry: { calendarId: calendar.id, eventId: id, conferenceRequested: meetRequest !== null, meetUrl: event.hangoutLink ?? null, event: compactEvent(event), ...notifiedBy(call, event, email) },
  };
}

async function loadEvent(mock: Mock, session: { account: DevGoogleAccount }, calendarId: string, eventId: string): Promise<{ stored: StoredEvent; etag: string } | Outcome> {
  const calendar = findCalendar(session.account, calendarId);
  const found = calendar ? await mock.kv.getJSONWithEtag<StoredEvent>(eventKey(session.account.email, eventId)) : null;
  if (!calendar || !found || found.value.calendarId !== calendar.id) return googleError(404, 'notFound', 'Not Found');
  return { stored: found.value, etag: found.etag };
}

async function getEvent(mock: Mock, session: { claims: TokenClaims; account: DevGoogleAccount }, calendarId: string, eventId: string): Promise<Outcome> {
  const loaded = await loadEvent(mock, session, calendarId, eventId);
  if ('status' in loaded) return { ...loaded, entry: { ...loaded.entry, calendarId, eventId } };
  return { status: 200, json: loaded.stored.event, entry: { calendarId: loaded.stored.calendarId, eventId, event: compactEvent(loaded.stored.event) } };
}

async function patchEvent(mock: Mock, call: Call, session: { claims: TokenClaims; account: DevGoogleAccount }, calendarId: string, eventId: string): Promise<Outcome> {
  if (!session.claims.s.includes(SCOPE_CALENDAR_EVENTS)) return googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', 'PERMISSION_DENIED');
  const body = parseJson(call.body);
  if (!isRecord(body)) return googleError(400, 'parseError', 'Parse Error');
  for (let attempt = 0; attempt < 8; attempt++) {
    const loaded = await loadEvent(mock, session, calendarId, eventId);
    if ('status' in loaded) return { ...loaded, entry: { ...loaded.entry, calendarId, eventId, patch: body } };
    const before = loaded.stored.event;
    const { id: _id, kind: _kind, conferenceData: _conference, attendees: _attendees, ...fields } = body;
    const event: Record<string, unknown> = { ...before, ...fields, etag: `"${hex(8)}"`, updated: mock.at ?? str(before.updated) };
    if (body.attendees !== undefined) {
      const attendees = normaliseAttendees(body.attendees);
      if (attendees.length > 0) event.attendees = attendees;
      else delete event.attendees;
    }
    if (!eventInterval(event)) return googleError(400, 'timeRangeEmpty', 'The specified time range is empty.');
    const moved = JSON.stringify([before.start, before.end]) !== JSON.stringify([event.start, event.end]);
    if (moved) event.sequence = Number(before.sequence ?? 0) + 1;
    const meetRequest = wantsMeet(call, body);
    if (meetRequest && !before.hangoutLink) Object.assign(event, meetFor(eventId, meetRequest));

    const written = await mock.kv.setJSON(eventKey(session.account.email, eventId), { ...loaded.stored, event }, { onlyIfMatch: loaded.etag });
    if (!written.modified) continue;
    return {
      status: 200,
      json: event,
      entry: { calendarId: loaded.stored.calendarId, eventId, patch: body, moved, meetUrl: event.hangoutLink ?? null, event: compactEvent(event), ...notifiedBy(call, event, session.account.email) },
    };
  }
  return googleError(409, 'conflict', 'The event changed while it was being updated.');
}

async function deleteEvent(mock: Mock, call: Call, session: { claims: TokenClaims; account: DevGoogleAccount }, calendarId: string, eventId: string): Promise<Outcome> {
  if (!session.claims.s.includes(SCOPE_CALENDAR_EVENTS)) return googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', 'PERMISSION_DENIED');
  const loaded = await loadEvent(mock, session, calendarId, eventId);
  if ('status' in loaded) return { ...loaded, entry: { ...loaded.entry, calendarId, eventId } };
  const { stored } = loaded;
  if (stored.event.status === 'cancelled') return { ...googleError(410, 'deleted', 'Resource has been deleted'), entry: { error: 'deleted', calendarId: stored.calendarId, eventId } };
  const event = { ...stored.event, status: 'cancelled', etag: `"${hex(8)}"`, updated: mock.at ?? str(stored.event.updated) };
  await mock.kv.setJSON(eventKey(session.account.email, eventId), { ...stored, event });
  return { status: 204, entry: { calendarId: stored.calendarId, eventId, event: compactEvent(event), ...notifiedBy(call, event, session.account.email) } };
}

// ───────────────────────── email: decoding ─────────────────────────

export interface DecodedEmail {
  from: string;
  fromEmail: string;
  to: string[];
  toRaw: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** every http(s) address linked from the HTML body, in order, without repeats */
  links: string[];
  hasIcs: boolean;
  ics: { filename: string | null; method: string | null; contentType: string; content: string; inline: boolean } | null;
  attachments: { filename: string | null; contentType: string }[];
}

function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const clean = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < clean.length; i++) {
    const pair = clean[i] === '=' ? clean.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else {
      for (const b of Buffer.from(clean[i], 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded-words back to text. White space between two encoded words is not part of the value. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_all, _charset: string, encoding: string, data: string) =>
      encoding.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQuotedPrintable(data.replace(/_/g, ' ')).toString('utf8'),
    );
}

function headerParams(value: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const head = value.split(';')[0].trim().toLowerCase();
  for (const m of value.matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g)) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '');
  }
  return { value: head, params };
}

interface MimeNode {
  headers: Record<string, string>;
  type: string;
  params: Record<string, string>;
  disposition: string;
  filename: string | null;
  content: Buffer;
  parts: MimeNode[];
}

function parseMimeNode(raw: string): MimeNode {
  const gap = /\r?\n\r?\n/.exec(raw);
  const head = gap ? raw.slice(0, gap.index) : raw;
  const body = gap ? raw.slice(gap.index + gap[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const contentType = headerParams(headers['content-type'] ?? 'text/plain');
  const disposition = headerParams(headers['content-disposition'] ?? '');
  const node: MimeNode = {
    headers,
    type: contentType.value,
    params: contentType.params,
    disposition: disposition.value,
    filename: disposition.params.filename ?? contentType.params.name ?? null,
    content: Buffer.alloc(0),
    parts: [],
  };

  if (node.type.startsWith('multipart/') && contentType.params.boundary) {
    const delimiter = `--${contentType.params.boundary}`;
    let current: string[] | null = null;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.replace(/[ \t]+$/, '');
      if (trimmed === delimiter || trimmed === `${delimiter}--`) {
        if (current) node.parts.push(parseMimeNode(current.join('\r\n')));
        current = trimmed === delimiter ? [] : null;
      } else if (current) {
        current.push(line);
      }
    }
    return node;
  }

  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  node.content = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : Buffer.from(body, 'utf8');
  return node;
}

function addressList(value: string): { raw: string; emails: string[] } {
  const raw = decodeWords(value);
  const emails: string[] = [];
  for (const piece of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(piece);
    const bare = /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(piece);
    const email = angled?.[1] ?? bare?.[1];
    if (email) emails.push(email);
  }
  return { raw, emails };
}

function linksIn(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (/^https?:\/\//i.test(url)) seen.add(url);
  }
  return [...seen];
}

function icsMethodOf(content: string, declared: string | undefined): string | null {
  return (declared ?? /^METHOD:(\w+)/m.exec(content)?.[1] ?? '').toUpperCase() || null;
}

/** Reads a raw RFC 5322 message (what Gmail's messages.send receives) into its assertable parts. */
export function decodeRawEmail(rawMime: string): DecodedEmail {
  const root = parseMimeNode(rawMime);
  const from = addressList(root.headers.from ?? '');
  const to = addressList(root.headers.to ?? '');
  const replyTo = addressList(root.headers['reply-to'] ?? '');
  const out: DecodedEmail = {
    from: from.raw,
    fromEmail: from.emails[0] ?? '',
    to: to.emails,
    toRaw: to.raw,
    replyTo: replyTo.emails[0] ?? null,
    subject: decodeWords(root.headers.subject ?? ''),
    text: '',
    html: '',
    links: [],
    hasIcs: false,
    ics: null,
    attachments: [],
  };
  let sawText = false;
  let sawHtml = false;
  const walk = (node: MimeNode, insideAlternative: boolean): void => {
    if (node.parts.length > 0 || node.type.startsWith('multipart/')) {
      for (const part of node.parts) walk(part, node.type === 'multipart/alternative');
      return;
    }
    const attached = node.disposition === 'attachment' || node.filename !== null;
    const calendar = node.type === 'text/calendar' || node.type === 'application/ics' || (node.filename ?? '').toLowerCase().endsWith('.ics');
    if (attached) out.attachments.push({ filename: node.filename, contentType: node.type });
    if (calendar) {
      const content = node.content.toString('utf8');
      // The attachment names the file; an inline copy (multipart/alternative) is what mail clients act on.
      if (!out.ics || attached) {
        out.ics = { filename: node.filename ?? out.ics?.filename ?? null, method: icsMethodOf(content, node.params.method), contentType: node.type, content: clip(content, MAX_TEXT), inline: out.ics?.inline === true || insideAlternative };
      } else if (insideAlternative) {
        out.ics.inline = true;
      }
      out.hasIcs = true;
      return;
    }
    if (attached) return;
    if (node.type === 'text/plain' && !sawText) {
      sawText = true;
      out.text = clip(node.content.toString('utf8'), MAX_TEXT);
    } else if (node.type === 'text/html' && !sawHtml) {
      sawHtml = true;
      const html = node.content.toString('utf8');
      out.links = linksIn(html);
      out.html = clip(html, MAX_HTML);
    }
  };
  walk(root, false);
  return out;
}

// ───────────────────────── Gmail ─────────────────────────

function planGmailSend(call: Call): Plan {
  return {
    service: 'gmail',
    kind: 'email',
    tags: ['gmail', 'email', 'google'],
    account: readToken('mock-at', bearer(call))?.e,
    run: async (mock) => {
      const session = await googleSession(mock, call);
      if (isOutcome(session)) return session;
      if (!session.claims.s.includes(SCOPE_GMAIL_SEND)) return googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', 'PERMISSION_DENIED');
      const body = parseJson(call.body);
      const raw = isRecord(body) ? str(body.raw) : '';
      if (!raw) return googleError(400, 'invalidArgument', "'raw' RFC822 payload message string or uploading message via /upload/* URL required");
      const email = decodeRawEmail(Buffer.from(raw, 'base64url').toString('utf8'));
      if (email.to.length === 0) return googleError(400, 'invalidArgument', 'Recipient address required');
      const id = hex(8);
      return { status: 200, json: { id, threadId: id, labelIds: ['SENT'] }, entry: { messageId: id, ...email } };
    },
  };
}

// ───────────────────────── Resend ─────────────────────────

function planResend(call: Call): Plan {
  return {
    service: 'resend',
    kind: 'email',
    tags: ['resend', 'email'],
    run: async (mock) => {
      const key = bearer(call);
      if (!key) return { status: 401, json: { statusCode: 401, name: 'missing_api_key', message: 'Missing API Key' }, entry: { error: 'missing_api_key' } };
      if (key.startsWith('invalid')) return { status: 403, json: { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }, entry: { error: 'invalid_api_key' } };
      const body = parseJson(call.body);
      if (!isRecord(body)) return { status: 422, json: { statusCode: 422, name: 'validation_error', message: 'The request body is not valid JSON.' }, entry: { error: 'validation_error' } };
      const recipients = (Array.isArray(body.to) ? body.to : [body.to]).filter((t): t is string => typeof t === 'string' && t !== '');
      for (const [field, present] of [['from', str(body.from) !== ''], ['to', recipients.length > 0], ['subject', str(body.subject) !== '']] as const) {
        if (!present) return { status: 422, json: { statusCode: 422, name: 'missing_required_field', message: `Missing \`${field}\` field.` }, entry: { error: 'missing_required_field' } };
      }
      const from = addressList(str(body.from));
      const to = addressList(recipients.join(', '));
      if (from.emails.length === 0 || to.emails.length !== recipients.length) {
        return { status: 422, json: { statusCode: 422, name: 'validation_error', message: 'Invalid `from` or `to` field. Use `email@example.com` or `Name <email@example.com>`.' }, entry: { error: 'validation_error' } };
      }

      const html = str(body.html);
      const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter(isRecord);
      const calendar = attachments.find((a) => str(a.content_type).toLowerCase().startsWith('text/calendar') || str(a.filename).toLowerCase().endsWith('.ics'));
      const icsContent = calendar ? Buffer.from(str(calendar.content), 'base64').toString('utf8') : '';
      const replyTo = addressList((Array.isArray(body.reply_to) ? body.reply_to : [body.reply_to]).filter((r): r is string => typeof r === 'string').join(', '));
      const email: DecodedEmail = {
        from: from.raw,
        fromEmail: from.emails[0],
        to: to.emails,
        toRaw: to.raw,
        replyTo: replyTo.emails[0] ?? null,
        subject: str(body.subject),
        text: clip(str(body.text), MAX_TEXT),
        html: clip(html, MAX_HTML),
        links: linksIn(html),
        hasIcs: !!calendar,
        ics: calendar
          ? {
              filename: str(calendar.filename) || null,
              method: icsMethodOf(icsContent, headerParams(str(calendar.content_type)).params.method),
              contentType: headerParams(str(calendar.content_type) || 'text/calendar').value,
              content: clip(icsContent, MAX_TEXT),
              inline: false,
            }
          : null,
        attachments: attachments.map((a) => ({ filename: str(a.filename) || null, contentType: headerParams(str(a.content_type) || 'application/octet-stream').value })),
      };

      // The same Idempotency-Key with the same request is the same email: Resend answers with the first
      // id and sends nothing new. The same key with a different request is refused with a 409.
      const idempotencyKey = call.headers.get('idempotency-key') ?? '';
      const id = `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
      if (idempotencyKey) {
        const slot = `${RESEND_IDEMPOTENCY_PREFIX}${sha(idempotencyKey).slice(0, 32)}`;
        const bodyHash = sha(call.body ?? '').slice(0, 32);
        const written = await mock.kv.setJSON(slot, { id, bodyHash }, { onlyIfNew: true });
        if (!written.modified) {
          const stored = await mock.kv.getJSON<{ id: string; bodyHash?: string }>(slot);
          if (stored?.bodyHash && stored.bodyHash !== bodyHash) {
            return {
              status: 409,
              json: { statusCode: 409, name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' },
              kind: 'email_conflict',
              entry: { error: 'invalid_idempotent_request', idempotencyKey },
            };
          }
          const first = stored?.id ?? id;
          return { status: 200, json: { id: first }, kind: 'email_duplicate', entry: { messageId: first, idempotencyKey, ...email } };
        }
      }
      return { status: 200, json: { id }, entry: { messageId: id, ...(idempotencyKey ? { idempotencyKey } : {}), ...email } };
    },
  };
}

// ───────────────────────── Twilio ─────────────────────────

interface MockTwilioCall {
  sid: string;
  accountSid: string;
  to: string;
  from: string;
  status: string;
  /** our own call id, taken from the `c` parameter of the webhook URL */
  callId: string | null;
  url: string;
  method: string;
  statusCallback: string | null;
  statusCallbackEvent: string | null;
  asyncAmdStatusCallback: string | null;
  machineDetection: string | null;
  timeout: number | null;
  timeLimit: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  updates: { at: string | null; status?: string; twiml?: string }[];
}

function twilioErrorBody(status: number, code: number, message: string): Record<string, unknown> {
  return { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status };
}

function twilioError(status: number, code: number, message: string): Outcome {
  return { status, json: twilioErrorBody(status, code, message), entry: { error: code } };
}

const E164 = /^\+[1-9]\d{6,14}$/;

function planTwilio(call: Call): Plan | null {
  const m = /^\/2010-04-01\/Accounts\/([^/]+)\/(Messages\.json|Calls\.json|Calls\/([^/]+)\.json)$/.exec(call.url.pathname);
  if (!m) return null;
  const accountSid = decodeSegment(m[1]);
  const resource = m[2];
  const callSid = m[3] ? decodeSegment(m[3]) : '';
  const form = new URLSearchParams(call.body);

  const authorise = (): Outcome | null => {
    const basic = /^Basic\s+(\S+)$/i.exec(call.headers.get('authorization') ?? '')?.[1] ?? '';
    const [user, ...rest] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    const token = rest.join(':');
    if (!user || !token || user !== accountSid || token.startsWith('invalid') || user.startsWith('invalid')) return twilioError(401, 20003, 'Authenticate');
    return null;
  };
  const make = (kind: string, tags: string[], run: (mock: Mock) => Promise<Outcome>): Plan => ({
    service: 'twilio',
    kind,
    tags: [...tags, 'twilio'],
    run: async (mock) => authorise() ?? run(mock),
  });

  if (resource === 'Messages.json' && call.method === 'POST') {
    return make('sms', ['twilio-sms', 'sms'], async (mock) => {
      const to = form.get('To') ?? '';
      const from = form.get('From') ?? '';
      const service = form.get('MessagingServiceSid') ?? '';
      const text = form.get('Body') ?? '';
      if (!E164.test(to)) return twilioError(400, 21211, `The 'To' number ${to} is not a valid phone number.`);
      if (!from && !service) return twilioError(400, 21603, "A 'From' or 'MessagingServiceSid' parameter is required to send a message.");
      if (!text) return twilioError(400, 21602, 'Message body is required.');
      if (text.length > 1600) return twilioError(400, 21617, 'The concatenated message body exceeds the 1600 character limit.');
      const sid = `SM${hex(16)}`;
      return {
        status: 201,
        json: {
          sid,
          account_sid: accountSid,
          to,
          from: from || null,
          messaging_service_sid: service || null,
          body: text,
          status: 'queued',
          num_segments: String(Math.max(1, Math.ceil(text.length / 153))),
          direction: 'outbound-api',
          error_code: null,
          error_message: null,
          date_created: mock.at ? new Date(mock.at).toUTCString() : null,
          uri: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
        },
        entry: { sid, to, from: from || null, messagingServiceSid: service || null, body: text, text, statusCallback: form.get('StatusCallback') },
      };
    });
  }

  if (resource === 'Calls.json' && call.method === 'POST') {
    return make('call', ['twilio-calls', 'call'], async (mock) => {
      const to = form.get('To') ?? '';
      const from = form.get('From') ?? '';
      const url = form.get('Url') ?? '';
      if (!E164.test(to)) return twilioError(400, 21211, `The 'To' number ${to} is not a valid phone number.`);
      if (!E164.test(from)) return twilioError(400, 21212, `The provided 'From' number ${from} is not valid.`);
      if (!/^https?:\/\//i.test(url)) return twilioError(400, 21205, 'Url parameter is required.');
      let callId: string | null = null;
      try {
        callId = new URL(url).searchParams.get('c');
      } catch {
        callId = null;
      }
      const number = (name: string): number | null => (form.get(name) && Number.isFinite(Number(form.get(name))) ? Number(form.get(name)) : null);
      const placed: MockTwilioCall = {
        sid: `CA${hex(16)}`,
        accountSid,
        to,
        from,
        status: 'queued',
        callId,
        url,
        method: form.get('Method') ?? 'POST',
        statusCallback: form.get('StatusCallback'),
        statusCallbackEvent: form.get('StatusCallbackEvent'),
        asyncAmdStatusCallback: form.get('AsyncAmdStatusCallback'),
        machineDetection: form.get('MachineDetection'),
        timeout: number('Timeout'),
        timeLimit: number('TimeLimit'),
        createdAt: mock.at,
        updatedAt: mock.at,
        updates: [],
      };
      await mock.kv.setJSON(`${DEV_TWILIO_CALL_PREFIX}${placed.sid}`, placed);
      return { status: 201, json: twilioCallResource(placed), entry: { sid: placed.sid, to, from, callId, webhookUrl: url, statusCallback: placed.statusCallback, amdCallback: placed.asyncAmdStatusCallback, machineDetection: placed.machineDetection } };
    });
  }

  if (callSid && (call.method === 'POST' || call.method === 'GET')) {
    const update = call.method === 'POST';
    return make(update ? 'call_update' : 'call_get', update ? ['twilio-call-update', 'twilio-calls'] : ['twilio-calls'], async (mock) => {
      const key = `${DEV_TWILIO_CALL_PREFIX}${callSid}`;
      const placed = /^CA[0-9A-Za-z]+$/.test(callSid) ? await mock.kv.getJSON<MockTwilioCall>(key) : null;
      if (!placed || placed.accountSid !== accountSid) {
        return twilioError(404, 20404, `The requested resource /2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json was not found`);
      }
      if (!update) return { status: 200, json: twilioCallResource(placed), entry: { sid: callSid } };
      const status = form.get('Status') ?? undefined;
      const twiml = form.get('Twiml') ?? undefined;
      const next: MockTwilioCall = {
        ...placed,
        status: status ?? placed.status,
        updatedAt: mock.at,
        updates: [...placed.updates, { at: mock.at, ...(status ? { status } : {}), ...(twiml ? { twiml } : {}) }],
      };
      await mock.kv.setJSON(key, next);
      return { status: 200, json: twilioCallResource(next), entry: { sid: callSid, to: placed.to, callId: placed.callId, ...(status ? { callStatus: status } : {}), ...(twiml ? { twiml, text: twimlText(twiml) } : {}) } };
    });
  }
  return null;
}

function twilioCallResource(placed: MockTwilioCall): Record<string, unknown> {
  return {
    sid: placed.sid,
    account_sid: placed.accountSid,
    to: placed.to,
    from: placed.from,
    status: placed.status,
    direction: 'outbound-api',
    answered_by: null,
    date_created: placed.createdAt ? new Date(placed.createdAt).toUTCString() : null,
    date_updated: placed.updatedAt ? new Date(placed.updatedAt).toUTCString() : null,
    uri: `/2010-04-01/Accounts/${placed.accountSid}/Calls/${placed.sid}.json`,
  };
}

/** What a TwiML document says out loud, as plain text. */
function twimlText(twiml: string): string {
  return [...twiml.matchAll(/<Say\b[^>]*>([\s\S]*?)<\/Say>/g)]
    .map((m) => xmlUnescape(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function xmlUnescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// ───────────────────────── Anthropic ─────────────────────────

interface VoiceTurn {
  caller: string;
  pendingCancel: boolean;
  linkSent: boolean;
}

/** Reads the turn message the voice module sends: call state plus a transcript with the newest caller words last. */
function readVoiceTurn(text: string): VoiceTurn | null {
  const said = [...text.matchAll(/<caller>([\s\S]*?)<\/caller>/g)];
  if (said.length === 0) return null;
  return {
    caller: xmlUnescape(said[said.length - 1][1]).trim(),
    pendingCancel: /cancellation_waiting_for_confirmation:\s*yes/.test(text),
    linkSent: /link_already_sent_on_this_call:\s*yes/.test(text),
  };
}

/** A small, predictable stand-in for the model: the reply follows from the caller's latest words. */
function chooseVoiceMove(turn: VoiceTurn): { say: string; action: string } {
  const words = ` ${turn.caller.toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim()} `;
  const has = (...phrases: string[]): boolean => phrases.some((p) => words.includes(` ${p} `));
  const yes = has('yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'absolutely', 'definitely', 'of course', 'i will', "i'll be there", 'i will be there', 'confirm', 'ok', 'okay', 'pressed 1');
  const no = has('no', 'nope', 'not', "don't", 'do not', 'never mind', 'keep it', "can't", 'cannot');

  if (turn.pendingCancel) {
    if (yes && !no) return { say: 'All right, your meeting is cancelled. Thank you, and take care. Goodbye.', action: 'confirm_cancel' };
    return { say: 'No problem, I have left the meeting as it is. Is there anything else I can help with?', action: 'continue' };
  }
  if (words.includes(' cancel')) return { say: 'I can cancel the meeting for you. Just to be sure, do you want me to cancel it? Yes or no?', action: 'request_cancel' };
  if (words.includes(' reschedul') || has('another time', 'different time', 'move it', 'move the meeting', 'change the time', 'the link', 'a link')) {
    if (turn.linkSent) return { say: 'The link is already on its way to you. Is there anything else?', action: 'continue' };
    return { say: 'No problem. I am sending you a link where you can pick a new time. Is there anything else?', action: 'send_manage_link' };
  }
  if (has('bye', 'goodbye', "that's all", 'that is all', 'nothing else', 'no thanks', 'no thank you')) return { say: 'Thank you. Have a great day. Goodbye.', action: 'end_call' };
  if (has('robot', 'human', 'real person', 'an ai', 'a machine', 'who is this', 'who are you')) {
    return { say: 'I am an AI assistant calling with a reminder about your meeting. Are you still able to make it?', action: 'continue' };
  }
  if (yes && !no) return { say: 'Wonderful, I have noted that you will be there. Is there anything else?', action: 'confirm_attendance' };
  if (no) return { say: 'I understand. Would you like a link to pick another time, or should I cancel the meeting?', action: 'continue' };
  return { say: 'Sorry, I did not catch that. Are you still able to make the meeting?', action: 'continue' };
}

async function nextScriptedReply(kv: KV): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const found = await kv.getJSONWithEtag<unknown[]>(DEV_LLM_SCRIPT_KEY);
    if (!found || !Array.isArray(found.value) || found.value.length === 0) return null;
    const [first, ...rest] = found.value;
    const written = await kv.setJSON(DEV_LLM_SCRIPT_KEY, rest, { onlyIfMatch: found.etag });
    if (written.modified) return isRecord(first) ? first : null;
  }
  return null;
}

function anthropicError(status: number, type: string, message: string): Outcome {
  const requestId = `req_mock_${hex(6)}`;
  return { status, json: { type: 'error', error: { type, message }, request_id: requestId }, headers: { 'request-id': requestId }, entry: { error: type } };
}

function planAnthropic(call: Call): Plan {
  return {
    service: 'anthropic',
    kind: 'llm',
    tags: ['anthropic', 'llm'],
    run: async (mock) => {
      const key = call.headers.get('x-api-key') || bearer(call);
      if (!key) return anthropicError(401, 'authentication_error', 'x-api-key header is required');
      if (key.startsWith('invalid')) return anthropicError(401, 'authentication_error', 'invalid x-api-key');
      const body = parseJson(call.body);
      if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) return anthropicError(400, 'invalid_request_error', 'messages: at least one message is required');
      if (typeof body.model !== 'string' || body.model === '') return anthropicError(400, 'invalid_request_error', 'model: field required');
      if (typeof body.max_tokens !== 'number') return anthropicError(400, 'invalid_request_error', 'max_tokens: field required');

      const last = body.messages[body.messages.length - 1];
      const content = isRecord(last) ? last.content : '';
      const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (isRecord(block) ? str(block.text) : '')).join('\n') : '';
      const turn = readVoiceTurn(prompt);
      const structured = isRecord(body.output_config) && isRecord(body.output_config.format) && body.output_config.format.type === 'json_schema';
      const betas = (call.headers.get('anthropic-beta') ?? '').split(',').map((b) => b.trim()).filter(Boolean);

      let text: string;
      let stopReason = 'end_turn';
      let stopDetails: Record<string, unknown> | null = null;
      let reply: Record<string, unknown> | null = null;
      const scripted = await nextScriptedReply(mock.kv);
      if (scripted) {
        if (typeof scripted.status === 'number' && scripted.status >= 400) {
          return anthropicError(scripted.status, str(scripted.errorType) || 'api_error', str(scripted.message) || 'Scripted error.');
        }
        if (typeof scripted.stopReason === 'string') stopReason = scripted.stopReason;
        if (stopReason === 'refusal') stopDetails = { type: 'refusal', category: scripted.category ?? null, explanation: null };
        if (typeof scripted.text === 'string') text = scripted.text;
        else if (stopReason === 'refusal') text = '';
        else {
          reply = { say: str(scripted.say), action: str(scripted.action) || 'continue' };
          text = JSON.stringify(reply);
        }
      } else if (turn) {
        reply = chooseVoiceMove(turn);
        text = JSON.stringify(reply);
      } else if (structured) {
        reply = { say: 'Hello, how can I help with your meeting?', action: 'continue' };
        text = JSON.stringify(reply);
      } else {
        text = 'ready';
      }

      const requestId = `req_mock_${hex(6)}`;
      const message = {
        id: `msg_mock_${hex(10)}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        container: null,
        diagnostics: null,
        content: text === '' ? [] : [{ type: 'text', text, citations: null }],
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details: stopDetails,
        usage: {
          input_tokens: Math.ceil((str(body.system).length + prompt.length) / 4),
          output_tokens: Math.max(1, Math.ceil(text.length / 4)),
          cache_creation: null,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: 'standard',
          speed: 'standard',
        },
      };
      return {
        status: 200,
        json: message,
        headers: { 'request-id': requestId },
        entry: {
          model: body.model,
          betas,
          structured,
          scripted: scripted !== null,
          caller: turn?.caller ?? null,
          pendingCancel: turn?.pendingCancel ?? null,
          stopReason,
          reply,
          text: clip(text, 2000),
          prompt: clip(prompt, 4000),
          system: clip(str(body.system), 4000),
        },
      };
    },
  };
}

// ───────────────────────── calendar feeds ─────────────────────────

function icsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsFrom(feed: DevIcsFeed, name: string): string {
  if (typeof feed.body === 'string') return feed.body;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//meeting dev mocks//feed//EN', 'CALSCALE:GREGORIAN'];
  (feed.events ?? []).forEach((event, i) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${name}-${i + 1}@feeds.mockcal.dev`,
      `DTSTAMP:${icsStamp(event.start)}`,
      `DTSTART:${icsStamp(event.start)}`,
      `DTEND:${icsStamp(event.end)}`,
      `SUMMARY:${(event.summary ?? 'Busy').replace(/[\r\n,;\\]/g, ' ')}`,
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

function planIcsFeed(call: Call): Plan {
  const name = decodeSegment(call.url.pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.ics$/i, '');
  return {
    service: 'ics',
    kind: 'ics_feed',
    tags: ['ics'],
    run: async (mock) => {
      const feed = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? await mock.kv.getJSON<DevIcsFeed>(`${DEV_ICS_PREFIX}${name}`) : null;
      if (!feed) return { status: 404, text: 'Not found', entry: { feed: name } };
      if (typeof feed.status === 'number' && feed.status !== 200) return { status: feed.status, text: `Feed answered ${feed.status}`, entry: { feed: name } };
      const body = icsFrom(feed, name);
      return { status: 200, text: body, headers: { 'Content-Type': 'text/calendar; charset=utf-8' }, entry: { feed: name, bytes: Buffer.byteLength(body, 'utf8') } };
    },
  };
}
