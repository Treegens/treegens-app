import { beforeEach, describe, expect, it } from 'vitest';
import type { Host, HostGoogle } from '../../shared/types';
import { open, seal, signPayload } from '../../server/lib/crypto';
import {
  GMAIL_SEND_SCOPE,
  GOOGLE_CALENDAR_SCOPES,
  GoogleApiError,
  GoogleAuthError,
  buildGoogleAuthUrl,
  completeGoogleAuth,
  disconnectGoogle,
  getGoogleAccessToken,
  gmailSendRaw,
  googleCreateEvent,
  googleDeleteEvent,
  googleFreeBusy,
  googleGetTimezone,
  googleListCalendars,
  googleRedirectUri,
  googleUpdateEvent,
  type CalendarEventInput,
} from '../../server/lib/google';
import { HttpError } from '../../server/lib/http';
import { getHost, getSite, saveSecrets, updateHost } from '../../server/lib/repo';
import { makeTestCtx, type TestCtx } from '../helpers/ctx';
import { accountIdFor, mainOf, type AccountRef } from '../../server/lib/googleAccounts';

/** The host's main Google account, the way every Google call now names the account it is made as. */
function main(host: Host): AccountRef {
  const ref = mainOf(host);
  if (!ref) throw new Error('no main account');
  return ref;
}

// ───────────────────────── fake fetch ─────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

/** A fetch that records every request and answers from `handler`. */
function recorder(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-value';
const OWNER = 'host_owner';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** An ID token. Without a `sub` of its own, every address is its own Google account: sub-<address>. */
function idToken(claims: Record<string, unknown>): string {
  const withSub = 'sub' in claims ? claims : { ...claims, sub: `sub-${String(claims.email ?? '')}` };
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(withSub)}.signature`;
}

const GOOD_CLAIMS = { iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'jimi@example.com', email_verified: true };
const ALL_SCOPES = GOOGLE_CALENDAR_SCOPES.join(' ');

/** Swaps the network behaviour of an existing context. */
function useFetch(ctx: TestCtx, handler: Handler): Call[] {
  const r = recorder(handler);
  ctx.fetch = r.fetch;
  return r.calls;
}

async function newCtx(): Promise<TestCtx> {
  const ctx = makeTestCtx();
  await getSite(ctx); // creates the owner host
  await saveSecrets(ctx, { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
  return ctx;
}

async function connect(ctx: TestCtx, over: Partial<HostGoogle> = {}, hostId = OWNER): Promise<Host> {
  const google: HostGoogle = {
    email: 'jimi@example.com',
    sub: `sub-${over.email ?? 'jimi@example.com'}`,
    refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-1'),
    scopes: [...GOOGLE_CALENDAR_SCOPES],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: ctx.now().toISOString(),
    ...over,
  };
  const saved = await updateHost(ctx, hostId, (h) => ({ ...h, google }));
  if (!saved) throw new Error('host missing');
  return saved;
}

/** Answers token requests with numbered access tokens and hands everything else to `api`. */
function withTokens(api: Handler): Handler {
  let minted = 0;
  return (call, index) => {
    if (call.url === TOKEN_URL) {
      minted++;
      return jsonResponse({ access_token: `access-${minted}`, expires_in: 3599, scope: ALL_SCOPES, token_type: 'Bearer' });
    }
    return api(call, index);
  };
}

function stateOf(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) throw new Error('no state');
  return state;
}

function callbackParams(state: string, extra: Record<string, string> = { code: 'auth-code-1' }): URLSearchParams {
  return new URLSearchParams({ state, ...extra });
}

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await newCtx();
});

// ───────────────────────── OAuth start ─────────────────────────

describe('buildGoogleAuthUrl', () => {
  it('builds the redirect URI from the public base URL', () => {
    expect(googleRedirectUri(ctx)).toBe('https://jimicohen.com/meeting/api/google/callback');
  });

  it('asks Google for offline calendar access with a signed state', async () => {
    const url = new URL(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('https://jimicohen.com/meeting/api/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(q.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
    expect(q.get('login_hint')).toBeNull();
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(url.href).not.toContain(CLIENT_SECRET);
  });

  it('adds the Gmail scope and the login hint only when asked', async () => {
    const url = new URL(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', gmail: true, loginHint: ' jimi@example.com ' }));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_CALENDAR_SCOPES, GMAIL_SEND_SCOPE]);
    expect(url.searchParams.get('login_hint')).toBe('jimi@example.com');
    const noHint = new URL(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', loginHint: 'not an address' }));
    expect(noHint.searchParams.has('login_hint')).toBe(false);
  });

  it('uses a fresh nonce every time and keeps the return path out of sight', async () => {
    const returnTo = '/meeting/host/host_owner?t=SELF-SERVICE-TOKEN';
    const a = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo }));
    const b = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo }));
    expect(a).not.toBe(b);
    const decoded = Buffer.from(a.split('.')[0], 'base64url').toString('utf8');
    expect(decoded).toContain(OWNER);
    expect(decoded).not.toContain('SELF-SERVICE-TOKEN');
  });

  it.each([
    'https://evil.example/meeting',
    '//evil.example/meeting',
    '/other/place',
    '/meetingevil',
    '/meeting/../admin',
    '/meeting/%2e%2e/admin',
    '/meeting\\..\\evil',
    '/meeting/admin\r\nSet-Cookie: x=1',
    'meeting/admin',
    '',
  ])('refuses the return address %j', async (returnTo) => {
    await expect(buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo })).rejects.toMatchObject({ status: 400, code: 'invalid_return' });
  });

  it('needs Google credentials and an existing host', async () => {
    await expect(buildGoogleAuthUrl(ctx, { hostId: 'host_nobody', returnTo: '/meeting/admin' })).rejects.toMatchObject({ status: 404 });
    await saveSecrets(ctx, {});
    const err = await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: 'google_not_configured' });
  });
});

// ───────────────────────── OAuth callback ─────────────────────────

describe('completeGoogleAuth', () => {
  it('exchanges the code, stores a sealed refresh token and caches the access token', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations?tab=google' }));
    const calls = useFetch(ctx, () =>
      jsonResponse({ access_token: 'access-A', expires_in: 3599, refresh_token: 'refresh-A', scope: ALL_SCOPES, token_type: 'Bearer', id_token: idToken(GOOD_CLAIMS) }),
    );

    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result).toEqual({
      ok: true,
      hostId: OWNER,
      returnTo: '/meeting/admin/integrations?tab=google',
      email: 'jimi@example.com',
      firstConnect: true,
      outcome: 'first',
      intent: 'main',
      accountId: accountIdFor(OWNER, 'sub-jimi@example.com'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      code: 'auth-code-1',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: 'https://jimicohen.com/meeting/api/google/callback',
      grant_type: 'authorization_code',
    });

    const host = await getHost(ctx, OWNER);
    expect(host?.google).toMatchObject({
      email: 'jimi@example.com',
      scopes: GOOGLE_CALENDAR_SCOPES,
      busyCalendarIds: ['primary'],
      writeCalendarId: 'primary',
      gmailSend: false,
      status: 'ok',
      connectedAt: ctx.now().toISOString(),
    });
    expect(host?.google?.refreshTokenEnc).not.toContain('refresh-A');
    expect(open(ctx, 'google-refresh', host?.google?.refreshTokenEnc ?? '')).toBe('refresh-A');

    // the access token from the exchange is reused without another request
    expect(await getGoogleAccessToken(ctx, main(host as Host))).toBe('access-A');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the userinfo endpoint when there is no ID token', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', gmail: true }));
    const calls = useFetch(ctx, (call) =>
      call.url === TOKEN_URL
        ? jsonResponse({ access_token: 'access-A', expires_in: 3599, refresh_token: 'refresh-A', scope: `${ALL_SCOPES} ${GMAIL_SEND_SCOPE}` })
        : jsonResponse({ sub: 'sub-owner@example.org', email: 'owner@example.org', email_verified: true }),
    );
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result.ok).toBe(true);
    expect(calls[1].url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(calls[1].headers.get('authorization')).toBe('Bearer access-A');
    const host = await getHost(ctx, OWNER);
    expect(host?.google?.email).toBe('owner@example.org');
    expect(host?.google?.gmailSend).toBe(true);
  });

  it('ignores an ID token that was issued to another client', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    useFetch(ctx, (call) =>
      call.url === TOKEN_URL
        ? jsonResponse({ access_token: 'a', expires_in: 3599, refresh_token: 'r', scope: ALL_SCOPES, id_token: idToken({ ...GOOD_CLAIMS, aud: 'someone-else', email: 'attacker@example.com' }) })
        : jsonResponse({ sub: 'sub-real', email: 'real@example.com' }),
    );
    expect((await completeGoogleAuth(ctx, callbackParams(state))).email).toBe('real@example.com');
  });

  it('rejects a tampered, foreign or missing state without calling Google', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/team' }));
    const calls = useFetch(ctx, () => jsonResponse({}));
    const [body, sig] = state.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { d: { hostId: string } };
    payload.d.hostId = 'host_attacker';
    const forgedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const otherPurpose = signPayload(ctx, 'session', { hostId: OWNER, returnTo: '/meeting/admin', gmail: false, n: 'x' }, 600);

    for (const bad of [`${forgedBody}.${sig}`, `${body}.${sig.slice(0, -2)}xx`, otherPurpose, 'garbage', '']) {
      const result = await completeGoogleAuth(ctx, callbackParams(bad));
      expect(result.ok).toBe(false);
      expect(result.returnTo).toBe('/meeting/admin');
      expect(result.hostId).toBeUndefined();
    }
    expect(await completeGoogleAuth(ctx, new URLSearchParams({ code: 'x' }))).toMatchObject({ ok: false, returnTo: '/meeting/admin' });
    expect(calls).toHaveLength(0);
    expect((await getHost(ctx, OWNER))?.google ?? null).toBeNull();
  });

  it('rejects an expired state', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    const calls = useFetch(ctx, () => jsonResponse({}));
    ctx.clock.advance(601_000);
    expect((await completeGoogleAuth(ctx, callbackParams(state))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('accepts a state only once', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/team' }));
    const calls = useFetch(ctx, () => jsonResponse({ access_token: 'a', expires_in: 3599, refresh_token: 'r', scope: ALL_SCOPES, id_token: idToken(GOOD_CLAIMS) }));
    expect((await completeGoogleAuth(ctx, callbackParams(state))).ok).toBe(true);
    const replay = await completeGoogleAuth(ctx, callbackParams(state, { code: 'auth-code-2' }));
    expect(replay).toMatchObject({ ok: false, hostId: OWNER, returnTo: '/meeting/admin/team' });
    expect(replay.error).toMatch(/already used/);
    expect(calls).toHaveLength(1);
  });

  it('reports a cancelled consent and still spends the state', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations' }));
    const calls = useFetch(ctx, () => jsonResponse({}));
    const denied = await completeGoogleAuth(ctx, callbackParams(state, { error: 'access_denied' }));
    expect(denied).toMatchObject({ ok: false, hostId: OWNER, returnTo: '/meeting/admin/integrations' });
    expect(denied.error).toMatch(/cancelled/);
    expect((await completeGoogleAuth(ctx, callbackParams(state))).error).toMatch(/already used/);
    expect(calls).toHaveLength(0);
  });

  it('explains how to get a refresh token when Google sends none', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    useFetch(ctx, () => jsonResponse({ access_token: 'a', expires_in: 3599, scope: ALL_SCOPES, id_token: idToken(GOOD_CLAIMS) }));
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('myaccount.google.com/permissions');
    expect((await getHost(ctx, OWNER))?.google ?? null).toBeNull();
  });

  it('remembers when Google says the connection will end (consent screen in Testing), and forgets it after a connect without an end', async () => {
    const tokens = (extra: Record<string, unknown>) => () =>
      jsonResponse({ access_token: 'access-A', expires_in: 3599, refresh_token: 'refresh-A', scope: ALL_SCOPES, id_token: idToken(GOOD_CLAIMS), ...extra });

    const first = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations' }));
    useFetch(ctx, tokens({ refresh_token_expires_in: 604799 }));
    const result = await completeGoogleAuth(ctx, callbackParams(first));
    const ends = new Date(ctx.now().getTime() + 604_799_000).toISOString();
    expect(result).toMatchObject({ ok: true, expiresAt: ends });
    expect((await getHost(ctx, OWNER))?.google?.refreshExpiresAt).toBe(ends);
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('Publish the OAuth consent screen'))).toBe(true);

    // The owner published the consent screen and connected again: Google no longer names an end.
    const second = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations' }));
    useFetch(ctx, tokens({}));
    const again = await completeGoogleAuth(ctx, callbackParams(second));
    expect(again.ok).toBe(true);
    expect(again).not.toHaveProperty('expiresAt');
    expect((await getHost(ctx, OWNER))?.google).not.toHaveProperty('refreshExpiresAt');

    // A value that is not a positive number of seconds is not stored.
    const third = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations' }));
    useFetch(ctx, tokens({ refresh_token_expires_in: 'soon' }));
    await completeGoogleAuth(ctx, callbackParams(third));
    expect((await getHost(ctx, OWNER))?.google).not.toHaveProperty('refreshExpiresAt');
  });

  it('keeps the stored refresh token and calendar choices when a re-consent omits the token', async () => {
    const before = await connect(ctx, { busyCalendarIds: ['primary', 'team@group.calendar.google.com'], writeCalendarId: 'team@group.calendar.google.com' });
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', gmail: true }));
    useFetch(ctx, () => jsonResponse({ access_token: 'a', expires_in: 3599, scope: `${ALL_SCOPES} ${GMAIL_SEND_SCOPE}`, id_token: idToken(GOOD_CLAIMS) }));
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result).toMatchObject({ ok: true, firstConnect: false });
    const after = await getHost(ctx, OWNER);
    expect(after?.google?.refreshTokenEnc).toBe(before.google?.refreshTokenEnc);
    expect(after?.google?.busyCalendarIds).toEqual(['primary', 'team@group.calendar.google.com']);
    expect(after?.google?.writeCalendarId).toBe('team@group.calendar.google.com');
    expect(after?.google?.gmailSend).toBe(true);
  });

  it('does not keep another account\'s refresh token', async () => {
    await connect(ctx, { email: 'old-account@example.com' });
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    useFetch(ctx, () => jsonResponse({ access_token: 'a', expires_in: 3599, scope: ALL_SCOPES, id_token: idToken(GOOD_CLAIMS) }));
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result.ok).toBe(false);
    expect((await getHost(ctx, OWNER))?.google?.email).toBe('old-account@example.com');
  });

  it('refuses a consent that left out calendar access', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    useFetch(ctx, () =>
      jsonResponse({ access_token: 'a', expires_in: 3599, refresh_token: 'r', scope: 'openid email https://www.googleapis.com/auth/calendar.readonly', id_token: idToken(GOOD_CLAIMS) }),
    );
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/calendar/i);
    expect((await getHost(ctx, OWNER))?.google ?? null).toBeNull();
  });

  it('turns a rejected code into a readable error and logs no secrets', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    useFetch(ctx, () => jsonResponse({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401));
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/client ID or client secret/);
    const logged = JSON.stringify(ctx.logs);
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain('auth-code-1');
  });

  it('survives Google being unreachable', async () => {
    const state = stateOf(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin' }));
    const calls = useFetch(ctx, () => {
      throw new TypeError('fetch failed');
    });
    const result = await completeGoogleAuth(ctx, callbackParams(state));
    expect(result).toMatchObject({ ok: false, returnTo: '/meeting/admin' });
    expect(result.error).toMatch(/could not be reached/);
    expect(calls).toHaveLength(2); // one retry
  });
});

// ───────────────────────── access tokens ─────────────────────────

describe('getGoogleAccessToken', () => {
  it('refreshes with the stored refresh token and caches the sealed result', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({})));

    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: 'refresh-token-1',
      grant_type: 'refresh_token',
    });

    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-1');
    expect(calls).toHaveLength(1);
    const stored = JSON.stringify(await ctx.kv.getJSON('cache/gtok-host_owner'));
    expect(stored).not.toContain('access-1');

    // still valid 61 s before expiry, gone inside the last minute
    ctx.clock.advance((3599 - 61) * 1000);
    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-1');
    ctx.clock.advance(2000);
    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-2');
    expect(calls).toHaveLength(2);
  });

  it('never serves a token cached for an earlier grant', async () => {
    const first = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({})));
    expect(await getGoogleAccessToken(ctx, main(first))).toBe('access-1');
    const second = await connect(ctx, { refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-2') });
    expect(await getGoogleAccessToken(ctx, main(second))).toBe('access-2');
    expect(new URLSearchParams(calls[1].body).get('refresh_token')).toBe('refresh-token-2');
  });

  it('marks the host for reconnection on invalid_grant', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));

    await expect(getGoogleAccessToken(ctx, main(host))).rejects.toBeInstanceOf(GoogleAuthError);
    const stored = await getHost(ctx, OWNER);
    expect(stored?.google?.status).toBe('needs_reconnect');
    expect(calls).toHaveLength(1);

    // once marked, no more requests are wasted on a dead grant
    await expect(getGoogleAccessToken(ctx, main(stored as Host))).rejects.toBeInstanceOf(GoogleAuthError);
    expect(calls).toHaveLength(1);
    const logged = JSON.stringify(ctx.logs);
    expect(logged).not.toContain('refresh-token-1');
    expect(logged).not.toContain(CLIENT_SECRET);
  });

  it('treats an unreadable refresh token as a lost connection', async () => {
    const host = await connect(ctx, { refreshTokenEnc: 'v1.not-a-sealed-value' });
    const calls = useFetch(ctx, () => jsonResponse({}));
    await expect(getGoogleAccessToken(ctx, main(host))).rejects.toBeInstanceOf(GoogleAuthError);
    expect(calls).toHaveLength(0);
    expect((await getHost(ctx, OWNER))?.google?.status).toBe('needs_reconnect');
  });

  it('does not blame the host when the OAuth client itself is rejected', async () => {
    const host = await connect(ctx);
    useFetch(ctx, () => jsonResponse({ error: 'invalid_client' }, 401));
    const err = await getGoogleAccessToken(ctx, main(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).not.toBeInstanceOf(GoogleAuthError);
    expect((await getHost(ctx, OWNER))?.google?.status).toBe('ok');
  });

  it('needs a connection', async () => {
    const host = (await getHost(ctx, OWNER)) as Host;
    await expect(getGoogleAccessToken(ctx, mainOf(host) as AccountRef)).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

// ───────────────────────── free/busy ─────────────────────────

describe('googleFreeBusy', () => {
  const DAY = 86_400_000;
  const start = Date.parse('2026-11-01T00:00:00.000Z');

  it('asks for the selected calendars and merges their busy time', async () => {
    const host = await connect(ctx, { busyCalendarIds: ['primary', 'team@group.calendar.google.com'] });
    const calls = useFetch(
      ctx,
      withTokens(() =>
        jsonResponse({
          kind: 'calendar#freeBusy',
          calendars: {
            primary: { busy: [{ start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' }, { start: '2026-11-05T08:00:00+03:00', end: '2026-11-05T09:00:00+03:00' }] },
            'team@group.calendar.google.com': { busy: [{ start: '2026-11-03T10:30:00Z', end: '2026-11-03T12:00:00Z' }] },
          },
        }),
      ),
    );
    const busy = await googleFreeBusy(ctx, main(host), { start, end: start + 7 * DAY });
    expect(busy).toEqual([
      { start: Date.parse('2026-11-03T10:00:00Z'), end: Date.parse('2026-11-03T12:00:00Z') },
      { start: Date.parse('2026-11-05T05:00:00Z'), end: Date.parse('2026-11-05T06:00:00Z') },
    ]);
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api).toHaveLength(1);
    expect(api[0].url).toBe(`${CAL}/freeBusy`);
    expect(api[0].method).toBe('POST');
    expect(api[0].headers.get('authorization')).toBe('Bearer access-1');
    expect(api[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(api[0].body)).toEqual({
      timeMin: '2026-11-01T00:00:00.000Z',
      timeMax: '2026-11-08T00:00:00.000Z',
      items: [{ id: 'primary' }, { id: 'team@group.calendar.google.com' }],
    });
  });

  it('splits long ranges into 60 day requests and joins busy time across the seams', async () => {
    const host = await connect(ctx);
    const seam = start + 60 * DAY;
    const calls = useFetch(
      ctx,
      withTokens((call) => {
        const body = JSON.parse(call.body) as { timeMin: string; timeMax: string };
        const min = Date.parse(body.timeMin);
        const max = Date.parse(body.timeMax);
        const busy: { start: string; end: string }[] = [];
        // one meeting that straddles the first seam, reported clipped by each request
        const from = seam - 3_600_000;
        const to = seam + 3_600_000;
        if (from < max && to > min) busy.push({ start: new Date(Math.max(from, min)).toISOString(), end: new Date(Math.min(to, max)).toISOString() });
        return jsonResponse({ calendars: { primary: { busy } } });
      }),
    );
    const busy = await googleFreeBusy(ctx, main(host), { start, end: start + 130 * DAY });
    expect(busy).toEqual([{ start: seam - 3_600_000, end: seam + 3_600_000 }]);

    const windows = calls
      .filter((c) => c.url !== TOKEN_URL)
      .map((c) => JSON.parse(c.body) as { timeMin: string; timeMax: string })
      .sort((a, b) => a.timeMin.localeCompare(b.timeMin));
    expect(windows.map((w) => [w.timeMin, w.timeMax])).toEqual([
      [new Date(start).toISOString(), new Date(start + 60 * DAY).toISOString()],
      [new Date(start + 60 * DAY).toISOString(), new Date(start + 120 * DAY).toISOString()],
      [new Date(start + 120 * DAY).toISOString(), new Date(start + 130 * DAY).toISOString()],
    ]);
    // the token is minted once, not once per request
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('defaults to the primary calendar and skips the network for an empty range', async () => {
    const host = await connect(ctx, { busyCalendarIds: [] });
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ calendars: { primary: { busy: [] } } })));
    expect(await googleFreeBusy(ctx, main(host), { start, end: start })).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await googleFreeBusy(ctx, main(host), { start, end: start + DAY })).toEqual([]);
    expect(JSON.parse(calls[1].body).items).toEqual([{ id: 'primary' }]);
  });

  it('fails when Google reports an error for one calendar', async () => {
    const host = await connect(ctx, { busyCalendarIds: ['primary', 'gone@group.calendar.google.com'] });
    useFetch(
      ctx,
      withTokens(() =>
        jsonResponse({
          calendars: {
            primary: { busy: [{ start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' }] },
            'gone@group.calendar.google.com': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
          },
        }),
      ),
    );
    const err = await googleFreeBusy(ctx, main(host), { start, end: start + DAY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).reason).toBe('notFound');
  });

  it('fails when a calendar is missing from the answer', async () => {
    const host = await connect(ctx, { busyCalendarIds: ['primary', 'other@example.com'] });
    useFetch(ctx, withTokens(() => jsonResponse({ calendars: { primary: { busy: [] } } })));
    await expect(googleFreeBusy(ctx, main(host), { start, end: start + DAY })).rejects.toBeInstanceOf(GoogleApiError);
  });
});

// ───────────────────────── retries ─────────────────────────

describe('request handling', () => {
  const range = { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2026-11-02T00:00:00Z') };
  const empty = (): Response => jsonResponse({ calendars: { primary: { busy: [] } } });

  it('refreshes the token once after a 401 and repeats the request', async () => {
    const host = await connect(ctx);
    let apiCalls = 0;
    const calls = useFetch(
      ctx,
      withTokens(() => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401) : empty();
      }),
    );
    // start from a cached token so the first call does not have to mint one
    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-1');
    expect(await googleGetTimezone(ctx, main(host))).toBeNull();
    expect(calls.map((c) => (c.url === TOKEN_URL ? 'token' : c.headers.get('authorization')))).toEqual(['token', 'Bearer access-1', 'token', 'Bearer access-2']);
    // the replacement token is the cached one from now on
    expect(await getGoogleAccessToken(ctx, main(host))).toBe('access-2');
  });

  it('gives up with GoogleAuthError when the fresh token is refused as well', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401)));
    await expect(googleFreeBusy(ctx, main(host), range)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('retries once on a 5xx', async () => {
    const host = await connect(ctx);
    let apiCalls = 0;
    const calls = useFetch(
      ctx,
      withTokens(() => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, 503) : empty();
      }),
    );
    expect(await googleFreeBusy(ctx, main(host), range)).toEqual([]);
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('retries once on a network failure, then reports it', async () => {
    const host = await connect(ctx);
    let apiCalls = 0;
    const calls = useFetch(
      ctx,
      withTokens(() => {
        apiCalls++;
        if (apiCalls === 1) throw new TypeError('fetch failed');
        return empty();
      }),
    );
    expect(await googleFreeBusy(ctx, main(host), range)).toEqual([]);
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);

    const down = useFetch(
      ctx,
      withTokens(() => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await googleFreeBusy(ctx, main(host), range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).reason).toBe('network');
    expect(down.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('does not retry a plain client error', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ error: { code: 400, message: 'Bad Request', errors: [{ reason: 'badRequest' }] } }, 400)));
    const err = await googleFreeBusy(ctx, main(host), range).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'GoogleApiError', status: 400, reason: 'badRequest' });
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(1);
  });

  it('asks for a reconnect when a permission is missing', async () => {
    const host = await connect(ctx);
    useFetch(ctx, withTokens(() => jsonResponse({ error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } }, 403)));
    await expect(googleFreeBusy(ctx, main(host), range)).rejects.toBeInstanceOf(GoogleAuthError);
    // a missing scope says nothing about the grant itself
    expect((await getHost(ctx, OWNER))?.google?.status).toBe('ok');
  });
});

// ───────────────────────── events ─────────────────────────

const EVENT: CalendarEventInput = {
  summary: 'Intro call: Ada Lovelace and Jimi Cohen',
  description: 'Booked by Ada Lovelace\nManage: https://jimicohen.com/meeting/booking/bk_1?t=abc',
  startIso: '2026-11-17T12:00:00.000Z',
  endIso: '2026-11-17T12:30:00.000Z',
  timezone: 'Africa/Nairobi',
  attendees: [
    { email: 'alex@example.com', name: 'Alex Co-host', accepted: true },
    { email: 'ada@example.com', name: 'Ada Lovelace', accepted: true },
    { email: 'guest@example.com' },
    { email: 'ADA@example.com', name: 'duplicate' },
    { email: 'jimi@example.com', name: 'the organiser' },
    { email: 'not-an-address' },
  ],
  location: 'Google Meet',
  createMeet: true,
  bookingId: 'bk_abc123',
  notifyAttendees: true,
};

describe('googleCreateEvent', () => {
  it('creates the event with attendees, a Meet request and updates for everyone', async () => {
    const host = await connect(ctx, { writeCalendarId: 'team@group.calendar.google.com' });
    const calls = useFetch(
      ctx,
      withTokens((call) => {
        const sent = JSON.parse(call.body) as { id: string };
        return jsonResponse({
          id: sent.id,
          status: 'confirmed',
          htmlLink: 'https://www.google.com/calendar/event?eid=abc',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          conferenceData: { createRequest: { requestId: 'bk_abc123', status: { statusCode: 'success' } } },
        });
      }),
    );

    const result = await googleCreateEvent(ctx, main(host), EVENT);
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api).toHaveLength(1);
    expect(api[0].method).toBe('POST');
    expect(api[0].url).toBe(`${CAL}/calendars/team%40group.calendar.google.com/events?conferenceDataVersion=1&sendUpdates=all`);

    const body = JSON.parse(api[0].body) as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.stringMatching(/^[a-v0-9]{5,1024}$/),
      summary: EVENT.summary,
      description: EVENT.description,
      location: 'Google Meet',
      start: { dateTime: '2026-11-17T12:00:00.000Z', timeZone: 'Africa/Nairobi' },
      end: { dateTime: '2026-11-17T12:30:00.000Z', timeZone: 'Africa/Nairobi' },
      attendees: [
        { email: 'alex@example.com', displayName: 'Alex Co-host', responseStatus: 'accepted' },
        { email: 'ada@example.com', displayName: 'Ada Lovelace', responseStatus: 'accepted' },
        { email: 'guest@example.com' },
      ],
      extendedProperties: { private: { meetingBookingId: 'bk_abc123' } },
      conferenceData: { createRequest: { requestId: 'bk_abc123', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
      guestsCanModify: false,
    });
    expect(result).toEqual({
      eventId: body.id,
      calendarId: 'team@group.calendar.google.com',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('leaves out the conference and silences updates when asked', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ id: 'evt1', status: 'confirmed' })));
    const result = await googleCreateEvent(ctx, main(host), { ...EVENT, createMeet: false, notifyAttendees: false, location: undefined });
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api[0].url).toBe(`${CAL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`);
    const body = JSON.parse(api[0].body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('conferenceData');
    expect(body).not.toHaveProperty('location');
    expect(result).toEqual({ eventId: 'evt1', calendarId: 'primary' });
  });

  it('reads the Meet link from the video entry point', async () => {
    const host = await connect(ctx);
    useFetch(
      ctx,
      withTokens(() =>
        jsonResponse({
          id: 'evt1',
          conferenceData: {
            entryPoints: [
              { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
              { entryPointType: 'video', uri: 'https://meet.google.com/xyz-abcd-efg' },
            ],
          },
        }),
      ),
    );
    expect((await googleCreateEvent(ctx, main(host), EVENT)).meetUrl).toBe('https://meet.google.com/xyz-abcd-efg');
  });

  it('looks once more when the Meet link is still being created', async () => {
    const host = await connect(ctx);
    const calls = useFetch(
      ctx,
      withTokens((call) =>
        call.method === 'POST'
          ? jsonResponse({ id: 'evt1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } })
          : jsonResponse({ id: 'evt1', hangoutLink: 'https://meet.google.com/late-link-now' }),
      ),
    );
    expect((await googleCreateEvent(ctx, main(host), EVENT)).meetUrl).toBe('https://meet.google.com/late-link-now');
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(api[1].url).toBe(`${CAL}/calendars/primary/events/evt1`);
  });

  it('adopts the existing event when the same booking was already written', async () => {
    const host = await connect(ctx);
    const calls = useFetch(
      ctx,
      withTokens((call) =>
        call.method === 'POST'
          ? jsonResponse({ error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } }, 409)
          : jsonResponse({ id: 'from-first-attempt', status: 'confirmed', htmlLink: 'https://www.google.com/calendar/event?eid=1', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' }),
      ),
    );
    const first = await googleCreateEvent(ctx, main(host), EVENT);
    expect(first).toEqual({
      eventId: 'from-first-attempt',
      calendarId: 'primary',
      htmlLink: 'https://www.google.com/calendar/event?eid=1',
      meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    });
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    const sentId = (JSON.parse(api[0].body) as { id: string }).id;
    expect(api[1].method).toBe('GET');
    expect(api[1].url).toBe(`${CAL}/calendars/primary/events/${sentId}`);

    // the id depends on the booking only
    const again = useFetch(ctx, withTokens(() => jsonResponse({ id: 'x' })));
    await googleCreateEvent(ctx, main(host), { ...EVENT, summary: 'changed' });
    await googleCreateEvent(ctx, main(host), { ...EVENT, bookingId: 'bk_other' });
    const ids = again.filter((c) => c.url !== TOKEN_URL).map((c) => (JSON.parse(c.body) as { id: string }).id);
    expect(ids[0]).toBe(sentId);
    expect(ids[1]).not.toBe(sentId);
  });

  it('rejects impossible times before calling Google', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ id: 'x' })));
    await expect(googleCreateEvent(ctx, main(host), { ...EVENT, startIso: 'yesterday-ish' })).rejects.toBeInstanceOf(GoogleApiError);
    await expect(googleCreateEvent(ctx, main(host), { ...EVENT, endIso: EVENT.startIso })).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(0);
  });
});

describe('googleUpdateEvent and googleDeleteEvent', () => {
  it('patches only what changed', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ id: 'evt1' })));
    await googleUpdateEvent(ctx, main(host), 'primary', 'evt 1/x', { startIso: '2026-11-18T09:00:00.000Z', endIso: '2026-11-18T09:30:00.000Z', timezone: 'Europe/London' });
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api).toHaveLength(1);
    expect(api[0].method).toBe('PATCH');
    expect(api[0].url).toBe(`${CAL}/calendars/primary/events/evt%201%2Fx?conferenceDataVersion=1&sendUpdates=all`);
    expect(JSON.parse(api[0].body)).toEqual({
      start: { dateTime: '2026-11-18T09:00:00.000Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-18T09:30:00.000Z', timeZone: 'Europe/London' },
    });

    await googleUpdateEvent(ctx, main(host), 'primary', 'evt1', { description: 'new text', notifyAttendees: false });
    const second = calls.filter((c) => c.url !== TOKEN_URL)[1];
    expect(second.url).toContain('sendUpdates=none');
    expect(JSON.parse(second.body)).toEqual({ description: 'new text' });

    // nothing to change, nothing sent
    await googleUpdateEvent(ctx, main(host), 'primary', 'evt1', {});
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('deletes with the right notification setting and tolerates events that are already gone', async () => {
    const host = await connect(ctx);
    const statuses = [204, 404, 410];
    const calls = useFetch(
      ctx,
      withTokens(() => {
        const status = statuses.shift() ?? 204;
        return status === 204 ? new Response(null, { status }) : jsonResponse({ error: { code: status, message: 'gone', errors: [{ reason: 'deleted' }] } }, status);
      }),
    );
    await googleDeleteEvent(ctx, main(host), 'primary', 'evt1', true);
    await googleDeleteEvent(ctx, main(host), 'primary', 'evt1', false);
    await googleDeleteEvent(ctx, main(host), 'primary', 'evt1', false);
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api.map((c) => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
    expect(api[0].url).toBe(`${CAL}/calendars/primary/events/evt1?sendUpdates=all`);
    expect(api[1].url).toBe(`${CAL}/calendars/primary/events/evt1?sendUpdates=none`);
  });

  it('still reports a delete that really failed', async () => {
    const host = await connect(ctx);
    useFetch(ctx, withTokens(() => jsonResponse({ error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }, 403)));
    await expect(googleDeleteEvent(ctx, main(host), 'primary', 'evt1', true)).rejects.toMatchObject({ name: 'GoogleApiError', status: 403 });
  });
});

// ───────────────────────── calendar list, settings, gmail, disconnect ─────────────────────────

describe('calendar list and settings', () => {
  it('lists calendars across pages, primary first', async () => {
    const host = await connect(ctx);
    const calls = useFetch(
      ctx,
      withTokens((call) => {
        const page = new URL(call.url).searchParams.get('pageToken');
        return page === null
          ? jsonResponse({
              items: [
                { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', backgroundColor: '#16a765' },
                { id: 'hidden@group.calendar.google.com', summary: 'Removed', accessRole: 'reader', deleted: true },
              ],
              nextPageToken: 'page-2',
            })
          : jsonResponse({
              items: [
                { id: 'jimi@example.com', summary: 'jimi@example.com', summaryOverride: 'Personal', primary: true, accessRole: 'owner', backgroundColor: 'red' },
                { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader' },
              ],
            });
      }),
    );
    expect(await googleListCalendars(ctx, main(host))).toEqual([
      { id: 'jimi@example.com', summary: 'Personal', primary: true, accessRole: 'owner' },
      { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', primary: false, accessRole: 'reader' },
      { id: 'team@group.calendar.google.com', summary: 'Team', primary: false, accessRole: 'writer', backgroundColor: '#16a765' },
    ]);
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api[0].url).toBe(`${CAL}/users/me/calendarList?maxResults=250&minAccessRole=freeBusyReader`);
    expect(new URL(api[1].url).searchParams.get('pageToken')).toBe('page-2');
  });

  it('reads the calendar time zone and ignores values that are not zones', async () => {
    const host = await connect(ctx);
    const values: unknown[] = ['Africa/Nairobi', 'Mars/Olympus_Mons', 42];
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ kind: 'calendar#setting', id: 'timezone', value: values.shift() })));
    expect(await googleGetTimezone(ctx, main(host))).toBe('Africa/Nairobi');
    expect(await googleGetTimezone(ctx, main(host))).toBeNull();
    expect(await googleGetTimezone(ctx, main(host))).toBeNull();
    expect(calls.filter((c) => c.url !== TOKEN_URL)[0].url).toBe(`${CAL}/users/me/settings/timezone`);
  });
});

describe('gmailSendRaw', () => {
  const mime = 'From: Jimi <jimi@example.com>\r\nTo: ada@example.com\r\nSubject: =?UTF-8?B?4pyT?=\r\n\r\nSee you soon, Zoë.\r\n';

  it('posts the message as base64url', async () => {
    const host = await connect(ctx, { gmailSend: true });
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ id: 'msg-1', threadId: 'thr-1', labelIds: ['SENT'] })));
    expect(await gmailSendRaw(ctx, main(host), mime)).toEqual({ id: 'msg-1' });
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(api[0].method).toBe('POST');
    const raw = (JSON.parse(api[0].body) as { raw: string }).raw;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe(mime);
  });

  it('refuses without the Gmail permission', async () => {
    const host = await connect(ctx, { gmailSend: false });
    const calls = useFetch(ctx, withTokens(() => jsonResponse({ id: 'x' })));
    await expect(gmailSendRaw(ctx, main(host), mime)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(calls).toHaveLength(0);
  });

  // Gmail has no idempotency key: a message it took but did not confirm must not be posted a second time.
  it.each([
    ['the network fails after Gmail took the message', () => Promise.reject(new TypeError('fetch failed'))],
    ['the answer does not come in time', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['Gmail answers with a 5xx', () => Promise.resolve(jsonResponse({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, 503))],
  ])('posts once and reports a failure when %s', async (_name, answer) => {
    const host = await connect(ctx, { gmailSend: true });
    const calls = useFetch(ctx, withTokens(() => answer()));
    await expect(gmailSendRaw(ctx, main(host), mime)).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(1);
  });

  it.each([
    ['a 429', 429, 'rateLimitExceeded'],
    ['a rate-limit 403', 403, 'userRateLimitExceeded'],
  ])('tries once more after %s, which is a refusal and sent nothing', async (_name, status, reason) => {
    const host = await connect(ctx, { gmailSend: true });
    let apiCalls = 0;
    const calls = useFetch(
      ctx,
      withTokens(() => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ error: { code: status, message: 'Rate Limit Exceeded', errors: [{ reason }] } }, status) : jsonResponse({ id: 'msg-2' });
      }),
    );
    expect(await gmailSendRaw(ctx, main(host), mime)).toEqual({ id: 'msg-2' });
    expect(calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('still gets a fresh token after a 401 and sends then', async () => {
    const host = await connect(ctx, { gmailSend: true });
    let apiCalls = 0;
    const calls = useFetch(
      ctx,
      withTokens(() => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401) : jsonResponse({ id: 'msg-3' });
      }),
    );
    expect(await gmailSendRaw(ctx, main(host), mime)).toEqual({ id: 'msg-3' });
    expect(calls.map((c) => (c.url === TOKEN_URL ? 'token' : c.headers.get('authorization')))).toEqual(['token', 'Bearer access-1', 'token', 'Bearer access-2']);
  });

});

describe('disconnectGoogle', () => {
  it('removes the connection, forgets the cached token and revokes the grant', async () => {
    const host = await connect(ctx);
    const calls = useFetch(ctx, withTokens(() => new Response(null, { status: 200 })));
    await getGoogleAccessToken(ctx, main(host));

    await disconnectGoogle(ctx, OWNER);
    const stored = await getHost(ctx, OWNER);
    expect(stored?.google).toBeNull();
    const revoke = calls[calls.length - 1];
    expect(revoke.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(revoke.method).toBe('POST');
    expect(new URLSearchParams(revoke.body).get('token')).toBe('refresh-token-1');

    // a later connection starts from scratch
    const again = await connect(ctx);
    const before = calls.length;
    await getGoogleAccessToken(ctx, main(again));
    expect(calls.length).toBe(before + 1);
  });

  it('disconnects even when Google cannot be reached, and is a no-op for unknown hosts', async () => {
    await connect(ctx);
    useFetch(ctx, () => {
      throw new TypeError('fetch failed');
    });
    await disconnectGoogle(ctx, OWNER);
    expect((await getHost(ctx, OWNER))?.google).toBeNull();
    await expect(disconnectGoogle(ctx, 'host_nobody')).resolves.toBeUndefined();
  });
});
