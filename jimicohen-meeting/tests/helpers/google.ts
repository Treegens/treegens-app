/**
 * Google accounts for unit tests: a stored account with a sealed token `refresh-<email>`, a way to add an
 * extra one to a host, and a fake Google that answers every call by the bearer token it carries, so a test
 * can say exactly which account a request was made as.
 *
 *   const g = fakeGoogle(ctx, { accounts: { 'jimi@work.example': { busy: [[start, end]] } } });
 *   await addExtra(ctx, 'host_owner', { email: 'jimi@work.example' });
 *   g.calls.filter((c) => c.account === 'jimi@work.example')
 */
import type { GoogleAccount, Host, HostGoogle } from '../../shared/types';
import { seal } from '../../server/lib/crypto';
import { accountIdFor } from '../../server/lib/googleAccounts';
import { updateHost } from '../../server/lib/repo';
import type { TestCtx } from './ctx';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CAL = 'https://www.googleapis.com/calendar/v3';

export const CALENDAR_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

/** One stored account: its sub is `sub-<email>`, its sealed refresh token `refresh-<email>`. */
export function googleAccount(ctx: TestCtx, over: Partial<HostGoogle> & { email: string }, hostId = 'host_owner'): GoogleAccount {
  const sub = over.sub ?? `sub-${over.email}`;
  return {
    id: over.id ?? accountIdFor(hostId, sub),
    sub,
    refreshTokenEnc: seal(ctx, 'google-refresh', `refresh-${over.email}`),
    scopes: [...CALENDAR_SCOPES],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: ctx.now().toISOString(),
    ...over,
  };
}

/** The host's main account. */
export async function setMain(ctx: TestCtx, hostId: string, over: Partial<HostGoogle> & { email: string }): Promise<Host> {
  const saved = await updateHost(ctx, hostId, (h) => ({ ...h, google: googleAccount(ctx, over, hostId) }));
  if (!saved) throw new Error(`no host ${hostId}`);
  return saved;
}

/** One more account on the host, after the ones it has. */
export async function addExtra(ctx: TestCtx, hostId: string, over: Partial<HostGoogle> & { email: string }): Promise<Host> {
  const saved = await updateHost(ctx, hostId, (h) => ({ ...h, googleExtra: [...(h.googleExtra ?? []), googleAccount(ctx, over, hostId)] }));
  if (!saved) throw new Error(`no host ${hostId}`);
  return saved;
}

export interface FakeEvent {
  calendarId: string;
  body: Record<string, unknown>;
  status: 'confirmed' | 'cancelled';
}

export interface FakeAccount {
  sub?: string;
  /** busy [start, end] pairs as ISO strings, on the primary calendar */
  busy?: [string, string][];
  zone?: string;
  calendars?: { id: string; summary: string; primary?: boolean }[];
  /** every call made as this account answers with this (only the calls of `failKinds`, when given) */
  fail?: 'invalid_grant' | 500 | 'timeout';
  failKinds?: FakeCall['kind'][];
  events?: Record<string, FakeEvent>;
}

export interface FakeCall {
  url: string;
  method: string;
  /** the account the call was made as: by the refresh token for a token request, by the bearer token otherwise */
  account: string | null;
  kind: 'token' | 'revoke' | 'userinfo' | 'freebusy' | 'calendar_list' | 'timezone' | 'event_insert' | 'event_get' | 'event_patch' | 'event_delete' | 'other';
  body: string;
  at: number;
}

export interface FakeGoogle {
  calls: FakeCall[];
  accounts: Record<string, FakeAccount>;
  /** revoked refresh tokens, by account */
  revoked: string[];
  /** holds every free/busy request until this resolves (to see they all started at once) */
  gate?: Promise<void>;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function googleError(status: number, reason: string): Response {
  return json({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
}

/** A fetch that is Google, for the given accounts (any address used without being listed gets an empty account). */
export function fakeGoogle(ctx: TestCtx, o: { accounts?: Record<string, FakeAccount>; gate?: Promise<void>; other?: (url: string, init?: RequestInit) => Response | null } = {}): FakeGoogle {
  const fake: FakeGoogle = { calls: [], accounts: o.accounts ?? {}, revoked: [], gate: o.gate };
  const accountOf = (email: string): FakeAccount => (fake.accounts[email] ??= {});
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    const bearer = /^Bearer access-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1] ?? null;
    const record = (kind: FakeCall['kind'], account: string | null): void => {
      fake.calls.push({ url, method, account, kind, body, at: Date.now() });
    };

    if (url === TOKEN_URL) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        // code "c:<email>" signs in as that account; its sub comes from `accounts` (default sub-<email>).
        const email = (form.get('code') ?? '').replace(/^c:/, '');
        record('token', email);
        const acc = accountOf(email);
        const claims = { iss: 'https://accounts.google.com', aud: form.get('client_id'), sub: acc.sub ?? `sub-${email}`, email, email_verified: true };
        const idToken = `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
        return json({ access_token: `access-${email}`, expires_in: 3599, refresh_token: `refresh-${email}`, scope: CALENDAR_SCOPES.join(' '), id_token: idToken, token_type: 'Bearer' });
      }
      const email = (form.get('refresh_token') ?? '').replace(/^refresh-/, '');
      record('token', email);
      const acc = accountOf(email);
      const failing = !acc.failKinds || acc.failKinds.includes('token');
      if ((failing && acc.fail === 'invalid_grant') || fake.revoked.includes(email)) return json({ error: 'invalid_grant' }, 400);
      if (failing && acc.fail === 500) return json({ error: 'server_error' }, 500);
      return json({ access_token: `access-${email}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (url === REVOKE_URL) {
      const email = (new URLSearchParams(body).get('token') ?? '').replace(/^refresh-/, '');
      record('revoke', email);
      fake.revoked.push(email);
      return new Response(null, { status: 200 });
    }
    if (url === USERINFO_URL) {
      record('userinfo', bearer);
      if (!bearer) return json({}, 401);
      return json({ sub: accountOf(bearer).sub ?? `sub-${bearer}`, email: bearer, email_verified: true });
    }
    if (url.startsWith(CAL)) {
      const path = url.slice(CAL.length).split('?')[0];
      const acc = bearer ? accountOf(bearer) : null;
      const kind: FakeCall['kind'] =
        path === '/freeBusy'
          ? 'freebusy'
          : path === '/users/me/calendarList'
            ? 'calendar_list'
            : path === '/users/me/settings/timezone'
              ? 'timezone'
              : method === 'POST'
                ? 'event_insert'
                : method === 'GET'
                  ? 'event_get'
                  : method === 'PATCH'
                    ? 'event_patch'
                    : method === 'DELETE'
                      ? 'event_delete'
                      : 'other';
      record(kind, bearer);
      if (!acc) return googleError(401, 'authError');
      if (kind === 'freebusy' && fake.gate) await fake.gate;
      const failing = !acc.failKinds || acc.failKinds.includes(kind);
      if (failing && acc.fail === 500) return googleError(500, 'backendError');
      if (failing && acc.fail === 'timeout') {
        const signal = init?.signal;
        await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));
      }
      if (kind === 'freebusy') {
        const items = (JSON.parse(body || '{}').items ?? []) as { id: string }[];
        const calendars: Record<string, unknown> = {};
        for (const item of items) calendars[item.id] = { busy: item.id === 'primary' ? (acc.busy ?? []).map(([start, end]) => ({ start, end })) : [] };
        return json({ calendars });
      }
      if (kind === 'calendar_list') return json({ items: acc.calendars ?? [{ id: bearer, summary: bearer, primary: true, accessRole: 'owner' }] });
      if (kind === 'timezone') return json({ value: acc.zone ?? 'UTC' });
      const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
      const events = (acc.events ??= {});
      if (kind === 'event_insert') {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        const id = String(parsed.id ?? '');
        if (events[id]) return googleError(409, 'duplicate');
        events[id] = { calendarId: segments[1], body: parsed, status: 'confirmed' };
        return json({ id, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${id}`, ...parsed });
      }
      const eventId = segments[3];
      const event = events[eventId];
      if (!event) return googleError(404, 'notFound');
      if (kind === 'event_get') return json({ id: eventId, status: event.status, ...event.body });
      if (kind === 'event_patch') {
        Object.assign(event.body, JSON.parse(body || '{}'));
        return json({ id: eventId, status: event.status, ...event.body });
      }
      if (kind === 'event_delete') {
        if (event.status === 'cancelled') return googleError(410, 'deleted');
        event.status = 'cancelled';
        return new Response(null, { status: 204 });
      }
    }
    const other = o.other?.(url, init);
    if (other) {
      record('other', null);
      return other;
    }
    record('other', null);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return fake;
}

/** An event already in an account's calendar, as we write them (our booking id in its private properties). */
export function eventFor(bookingId: string, start: string, end: string, extra: Record<string, unknown> = {}): FakeEvent {
  return {
    calendarId: 'primary',
    status: 'confirmed',
    body: { start: { dateTime: start }, end: { dateTime: end }, extendedProperties: { private: { meetingBookingId: bookingId } }, ...extra },
  };
}
