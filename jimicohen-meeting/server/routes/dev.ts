/**
 * Dev-only routes and the small pieces of dev state they share with the dev server and the
 * provider mocks. server/api.ts registers these routes only when ctx.env.mockProviders is true,
 * and every handler checks again, so they can never answer in production.
 *
 *   GET    /dev/outbox     everything the mocks "sent"            → { outbox: [...] }
 *   DELETE /dev/outbox     forget it
 *   POST   /dev/reset      wipe ALL stored data (fresh first run) → { ok, deleted }
 *   GET    /dev/clock      the fake clock                         → { now: ISO | null }
 *   POST   /dev/clock      { now: ISO } freezes time, { now: null } returns to real time,
 *                          { advanceMs: n } moves on from the current (fake or real) time
 *   POST   /dev/run-jobs   what the cron function does            → result of runScheduled
 *
 * Controls for the provider mocks (server/lib/mocks.ts) and direct views for end-to-end tests:
 *
 *   GET    /dev/google/busy[?email=]     busy time the mock Google reports → { busy: { email: [...] } }
 *   PUT    /dev/google/busy              { email, busy: [{ start, end, calendarId? }], keepCache? }
 *   DELETE /dev/google/busy[?email=]     clear one account, or all of them
 *   GET    /dev/google/accounts          mock Google accounts seen so far  → { accounts: [...] }
 *   PUT    /dev/google/account           { email, timezone?, calendars?, revoked? }
 *   GET    /dev/google/events[?email=]   events on the mock calendars      → { events: [...] }
 *   GET    /dev/fail                     failure injection in force        → { fail: { service: spec } }
 *   PUT    /dev/fail                     { service, mode?, status?, code?, message?, ms?, times?, account? }
 *   DELETE /dev/fail[?service=]          clear one service, or all of them
 *   GET    /dev/jobs                     queued jobs, soonest first        → { now, jobs: [...] }
 *   GET    /dev/calls                    calls placed through mock Twilio  → { calls: [...] }
 *   GET    /dev/bookings                 every booking with its manage link → { bookings: [...] }
 *   GET    /dev/kv?prefix= | ?key=       raw look into the store           → { keys } | { key, value }
 *   PUT    /dev/llm-script               { replies: [...] } answers the mock model gives next, in order
 *   DELETE /dev/llm-script
 *   PUT    /dev/ics                      { name, body? | events?: [{ start, end, summary? }], status? } → { url }
 *   DELETE /dev/ics[?name=]
 */
import { runScheduled } from '../cron';
import { manageToken } from '../lib/booking';
import type { Ctx, KV } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';
import { KEYS, getBookingIndex, getBookings, listJobs } from '../lib/repo';

export const DEV_CLOCK_KEY = 'dev/clock';
export const DEV_OUTBOX_KEY = 'dev/outbox';

// ───────────────────────── state shared with the provider mocks ─────────────────────────

/** `dev/google-busy/<email>`: busy intervals the mock Google account reports (on top of its own events). */
export const DEV_GOOGLE_BUSY_PREFIX = 'dev/google-busy/';
/** `dev/google-account/<email>`: what is known about a mock Google account. */
export const DEV_GOOGLE_ACCOUNT_PREFIX = 'dev/google-account/';
/** `dev/google-events/<email>/<eventId>`: events created through the mock Calendar API. */
export const DEV_GOOGLE_EVENT_PREFIX = 'dev/google-events/';
/** `dev/fail/<service>`: makes that mocked service fail until the key is removed. */
export const DEV_FAIL_PREFIX = 'dev/fail/';
/** `dev/twilio-calls/<sid>`: calls the mock Twilio was asked to place. */
export const DEV_TWILIO_CALL_PREFIX = 'dev/twilio-calls/';
/** Replies the mock model gives next, first in first out. Empty = it answers from the caller's words. */
export const DEV_LLM_SCRIPT_KEY = 'dev/llm-script';
/** `dev/ics/<name>`: calendar feeds the mock serves at `${DEV_ICS_ORIGIN}/<name>.ics`. */
export const DEV_ICS_PREFIX = 'dev/ics/';
export const DEV_ICS_ORIGIN = 'https://feeds.mockcal.dev';

export interface DevBusyInterval {
  start: string;
  end: string;
  /** which calendar of the account is busy; left out = the primary calendar */
  calendarId?: string;
}

export interface DevGoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

export interface DevGoogleAccount {
  email: string;
  /** Calendar time zone (settings/timezone). Set from the OAuth code, changeable through PUT /dev/google/account. */
  timezone?: string;
  /** replaces the default calendar list */
  calendars?: DevGoogleCalendar[];
  /** true = Google answers invalid_grant / 401 for this account until it connects again */
  revoked?: boolean;
}

export interface DevFailSpec {
  /** error: answer `status`; timeout: never answer; network: fail to connect; delay: answer normally after `ms` */
  mode: 'error' | 'timeout' | 'network' | 'delay';
  /** HTTP status for mode "error" (default 500) */
  status?: number;
  /** provider error code put into the error body (a Twilio code such as 21610, a Google reason, ...) */
  code?: number | string;
  message?: string;
  /** timeout: give up after this long instead of waiting for the caller to abort. delay: how long to wait. */
  ms?: number;
  /** fail only this many calls, then clear itself */
  times?: number;
  /** only for calls made as this Google account */
  account?: string;
}

export interface DevIcsFeed {
  body?: string;
  events?: { start: string; end: string; summary?: string }[];
  /** answer with this HTTP status instead of the feed */
  status?: number;
}

/** Account emails are compared and stored in lower case. */
export function devAccountKey(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

const FAIL_MODES: readonly string[] = ['error', 'timeout', 'network', 'delay'];

/**
 * Reads a failure spec as stored under `dev/fail/<service>`. Shorthands: `true` or "error" (500),
 * a status number, "timeout", "network". Anything else that is not a spec object gives null.
 */
export function parseFailSpec(value: unknown): DevFailSpec | null {
  if (value === true || value === 'error') return { mode: 'error', status: 500 };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) return { mode: 'error', status: value };
  if (typeof value === 'string') {
    if (value === 'timeout' || value === 'network') return { mode: value };
    return /^[45]\d\d$/.test(value) ? { mode: 'error', status: Number(value) } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const mode = typeof v.mode === 'string' && FAIL_MODES.includes(v.mode) ? (v.mode as DevFailSpec['mode']) : v.mode === undefined ? 'error' : null;
  if (!mode) return null;
  const spec: DevFailSpec = { mode };
  if (mode === 'error') spec.status = typeof v.status === 'number' && Number.isInteger(v.status) && v.status >= 400 && v.status <= 599 ? v.status : 500;
  if (typeof v.code === 'number' || (typeof v.code === 'string' && v.code !== '')) spec.code = v.code;
  if (typeof v.message === 'string' && v.message !== '') spec.message = v.message.slice(0, 500);
  if (typeof v.ms === 'number' && Number.isFinite(v.ms) && v.ms >= 0) spec.ms = Math.min(Math.round(v.ms), 120_000);
  if (typeof v.times === 'number' && Number.isInteger(v.times) && v.times >= 1) spec.times = v.times;
  if (typeof v.account === 'string' && v.account.includes('@')) spec.account = devAccountKey(v.account);
  return spec;
}

function invalid(message: string, field: string): HttpError {
  return new HttpError(422, 'invalid', message, { [field]: message });
}

function requireEmail(value: unknown): string {
  const email = typeof value === 'string' ? devAccountKey(value) : '';
  if (!/^[^\s@/]+@[^\s@/]+$/.test(email)) throw invalid('Send the email address of the mock Google account.', 'email');
  return email;
}

function requireName(value: unknown, field: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw invalid(`Send a short ${field} made of letters, digits, dots and dashes.`, field);
  return name;
}

function parseBusy(value: unknown): DevBusyInterval[] {
  if (!Array.isArray(value)) throw invalid('Send busy as a list of { start, end }.', 'busy');
  return value.map((item, i) => {
    const v = (item ?? {}) as Record<string, unknown>;
    const start = typeof v.start === 'string' || typeof v.start === 'number' ? new Date(v.start).getTime() : NaN;
    const end = typeof v.end === 'string' || typeof v.end === 'number' ? new Date(v.end).getTime() : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw invalid(`Busy entry ${i + 1} needs a start and a later end.`, 'busy');
    const interval: DevBusyInterval = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    if (typeof v.calendarId === 'string' && v.calendarId !== '') interval.calendarId = v.calendarId;
    return interval;
  });
}

async function deletePrefix(kv: KV, prefix: string): Promise<number> {
  const keys = await kv.list(prefix);
  for (const key of keys) await kv.delete(key);
  return keys.length;
}

async function readPrefix<T>(kv: KV, prefix: string): Promise<{ key: string; value: T }[]> {
  const out: { key: string; value: T }[] = [];
  for (const key of await kv.list(prefix)) {
    const value = await kv.getJSON<T>(key);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

/** The frozen dev time, or null when the real clock is in use. */
export async function readDevClock(kv: KV): Promise<Date | null> {
  const record = await kv.getJSON<{ now?: unknown }>(DEV_CLOCK_KEY);
  if (!record || typeof record.now !== 'string') return null;
  const ms = Date.parse(record.now);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Appends one record to the outbox (compare-and-swap, so parallel mock calls never lose an entry). */
export async function appendOutbox(kv: KV, entry: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const found = await kv.getJSONWithEtag<unknown[]>(DEV_OUTBOX_KEY);
    const next = [...(Array.isArray(found?.value) ? found.value : []), entry];
    const written = await kv.setJSON(DEV_OUTBOX_KEY, next, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    if (written.modified) return;
    await Promise.resolve();
  }
  throw new Error('dev outbox: too much contention');
}

/** The outbox array, followed by any entries stored one per key under `dev/outbox/` (in key order). */
export async function readOutbox(kv: KV): Promise<unknown[]> {
  const list = await kv.getJSON<unknown[]>(DEV_OUTBOX_KEY);
  const out: unknown[] = Array.isArray(list) ? [...list] : [];
  for (const key of await kv.list(`${DEV_OUTBOX_KEY}/`)) {
    const entry = await kv.getJSON<unknown>(key);
    if (entry !== null) out.push(entry);
  }
  return out;
}

export async function clearOutbox(kv: KV): Promise<void> {
  await kv.delete(DEV_OUTBOX_KEY);
  for (const key of await kv.list(`${DEV_OUTBOX_KEY}/`)) await kv.delete(key);
}

function assertDev(ctx: Ctx): void {
  if (!ctx.env.mockProviders) throw new HttpError(404, 'not_found', 'Not found.');
}

async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('json')) return {};
  return readJson<Record<string, unknown>>(req);
}

export const routes: Route[] = [
  route('GET', '/dev/outbox', async ({ ctx }) => {
    assertDev(ctx);
    return json({ outbox: await readOutbox(ctx.kv) });
  }),

  route('DELETE', '/dev/outbox', async ({ ctx }) => {
    assertDev(ctx);
    await clearOutbox(ctx.kv);
    return json({ ok: true });
  }),

  route('POST', '/dev/reset', async ({ ctx }) => {
    assertDev(ctx);
    const keys = await ctx.kv.list('');
    for (const key of keys) await ctx.kv.delete(key);
    return json({ ok: true, deleted: keys.length });
  }),

  route('GET', '/dev/clock', async ({ ctx }) => {
    assertDev(ctx);
    return json({ now: (await readDevClock(ctx.kv))?.toISOString() ?? null });
  }),

  route('POST', '/dev/clock', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readOptionalJson(req);
    if (typeof body.advanceMs === 'number' && Number.isFinite(body.advanceMs)) {
      // ctx.now() is already the fake time when one is set.
      const next = new Date(ctx.now().getTime() + body.advanceMs).toISOString();
      await ctx.kv.setJSON(DEV_CLOCK_KEY, { now: next });
      return json({ now: next });
    }
    if (body.now === null || body.now === undefined || body.now === '') {
      await ctx.kv.delete(DEV_CLOCK_KEY);
      return json({ now: null });
    }
    const ms = typeof body.now === 'string' ? Date.parse(body.now) : NaN;
    if (!Number.isFinite(ms)) throw new HttpError(422, 'invalid', 'Send { now: ISO date } or { now: null }.', { now: 'Not a valid date.' });
    const next = new Date(ms).toISOString();
    await ctx.kv.setJSON(DEV_CLOCK_KEY, { now: next });
    return json({ now: next });
  }),

  route('POST', '/dev/run-jobs', async ({ ctx }) => {
    assertDev(ctx);
    return json(await runScheduled(ctx));
  }),

  // ───────────── mock Google ─────────────

  route('GET', '/dev/google/busy', async ({ ctx, url }) => {
    assertDev(ctx);
    const only = url.searchParams.get('email');
    const busy: Record<string, DevBusyInterval[]> = {};
    if (only) {
      const email = requireEmail(only);
      busy[email] = (await ctx.kv.getJSON<DevBusyInterval[]>(`${DEV_GOOGLE_BUSY_PREFIX}${email}`)) ?? [];
    } else {
      for (const { key, value } of await readPrefix<DevBusyInterval[]>(ctx.kv, DEV_GOOGLE_BUSY_PREFIX)) busy[key.slice(DEV_GOOGLE_BUSY_PREFIX.length)] = value;
    }
    return json({ busy });
  }),

  route('PUT', '/dev/google/busy', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readJson<Record<string, unknown>>(req);
    const email = requireEmail(body.email);
    const busy = parseBusy(body.busy);
    if (busy.length === 0) await ctx.kv.delete(`${DEV_GOOGLE_BUSY_PREFIX}${email}`);
    else await ctx.kv.setJSON(`${DEV_GOOGLE_BUSY_PREFIX}${email}`, busy);
    // The app remembers free/busy answers for a minute. A test that changes the calendar wants to see it now.
    if (body.keepCache !== true) await deletePrefix(ctx.kv, `${KEYS.cachePrefix}busy-`);
    return json({ email, busy });
  }),

  route('DELETE', '/dev/google/busy', async ({ ctx, url }) => {
    assertDev(ctx);
    const only = url.searchParams.get('email');
    if (only) await ctx.kv.delete(`${DEV_GOOGLE_BUSY_PREFIX}${requireEmail(only)}`);
    else await deletePrefix(ctx.kv, DEV_GOOGLE_BUSY_PREFIX);
    if (url.searchParams.get('keepCache') !== '1') await deletePrefix(ctx.kv, `${KEYS.cachePrefix}busy-`);
    return json({ ok: true });
  }),

  route('GET', '/dev/google/accounts', async ({ ctx }) => {
    assertDev(ctx);
    return json({ accounts: (await readPrefix<DevGoogleAccount>(ctx.kv, DEV_GOOGLE_ACCOUNT_PREFIX)).map((entry) => entry.value) });
  }),

  route('PUT', '/dev/google/account', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readJson<Record<string, unknown>>(req);
    const email = requireEmail(body.email);
    const key = `${DEV_GOOGLE_ACCOUNT_PREFIX}${email}`;
    const account: DevGoogleAccount = { ...((await ctx.kv.getJSON<DevGoogleAccount>(key)) ?? {}), email };
    if (typeof body.timezone === 'string' && body.timezone !== '') account.timezone = body.timezone;
    if (typeof body.revoked === 'boolean') account.revoked = body.revoked;
    if (body.calendars === null) delete account.calendars;
    else if (Array.isArray(body.calendars)) {
      account.calendars = body.calendars.map((item, i) => {
        const v = (item ?? {}) as Record<string, unknown>;
        if (typeof v.id !== 'string' || v.id === '') throw invalid(`Calendar ${i + 1} needs an id.`, 'calendars');
        const calendar: DevGoogleCalendar = { id: v.id, summary: typeof v.summary === 'string' && v.summary !== '' ? v.summary : v.id };
        if (v.primary === true) calendar.primary = true;
        if (typeof v.accessRole === 'string') calendar.accessRole = v.accessRole;
        if (typeof v.backgroundColor === 'string') calendar.backgroundColor = v.backgroundColor;
        return calendar;
      });
    }
    await ctx.kv.setJSON(key, account);
    return json({ account });
  }),

  route('GET', '/dev/google/events', async ({ ctx, url }) => {
    assertDev(ctx);
    const only = url.searchParams.get('email');
    const prefix = only ? `${DEV_GOOGLE_EVENT_PREFIX}${requireEmail(only)}/` : DEV_GOOGLE_EVENT_PREFIX;
    return json({ events: (await readPrefix<unknown>(ctx.kv, prefix)).map((entry) => entry.value) });
  }),

  // ───────────── failure injection ─────────────

  route('GET', '/dev/fail', async ({ ctx }) => {
    assertDev(ctx);
    const fail: Record<string, DevFailSpec> = {};
    for (const { key, value } of await readPrefix<unknown>(ctx.kv, DEV_FAIL_PREFIX)) {
      const spec = parseFailSpec(value);
      if (spec) fail[key.slice(DEV_FAIL_PREFIX.length)] = spec;
    }
    return json({ fail });
  }),

  route('PUT', '/dev/fail', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readJson<Record<string, unknown>>(req);
    const service = requireName(body.service, 'service');
    const { service: _service, ...rest } = body;
    const spec = parseFailSpec(Object.keys(rest).length === 0 ? true : rest);
    if (!spec) throw invalid('Send mode "error", "timeout", "network" or "delay".', 'mode');
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}${service}`, spec);
    return json({ service, fail: spec });
  }),

  route('DELETE', '/dev/fail', async ({ ctx, url }) => {
    assertDev(ctx);
    const only = url.searchParams.get('service');
    if (only) await ctx.kv.delete(`${DEV_FAIL_PREFIX}${requireName(only, 'service')}`);
    else await deletePrefix(ctx.kv, DEV_FAIL_PREFIX);
    return json({ ok: true });
  }),

  // ───────────── direct views ─────────────

  route('GET', '/dev/jobs', async ({ ctx }) => {
    assertDev(ctx);
    return json({ now: ctx.now().toISOString(), jobs: await listJobs(ctx) });
  }),

  route('GET', '/dev/calls', async ({ ctx }) => {
    assertDev(ctx);
    // One entry per call the mock Twilio accepted, joined with our own record of that call.
    const placed = await readPrefix<Record<string, unknown>>(ctx.kv, DEV_TWILIO_CALL_PREFIX);
    const calls = [];
    for (const { value } of placed) {
      const callId = typeof value.callId === 'string' ? value.callId : '';
      const record = /^[A-Za-z0-9_-]{1,80}$/.test(callId) ? await ctx.kv.getJSON<unknown>(`${KEYS.callPrefix}${callId}`) : null;
      calls.push({ ...value, record });
    }
    calls.sort((a, b) => String((a as { createdAt?: unknown }).createdAt ?? '').localeCompare(String((b as { createdAt?: unknown }).createdAt ?? '')));
    return json({ calls });
  }),

  route('GET', '/dev/bookings', async ({ ctx }) => {
    assertDev(ctx);
    const index = await getBookingIndex(ctx);
    const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
    const bookings = (await getBookings(ctx, index.map((entry) => entry.id)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((booking) => {
        const token = manageToken(ctx, booking.id);
        return { ...booking, manageToken: token, manageUrl: `${base}/booking/${encodeURIComponent(booking.id)}?t=${encodeURIComponent(token)}` };
      });
    return json({ bookings });
  }),

  route('GET', '/dev/kv', async ({ ctx, url }) => {
    assertDev(ctx);
    const key = url.searchParams.get('key');
    if (key) return json({ key, value: await ctx.kv.getJSON<unknown>(key) });
    return json({ keys: await ctx.kv.list(url.searchParams.get('prefix') ?? '') });
  }),

  // ───────────── mock model, mock calendar feeds ─────────────

  route('PUT', '/dev/llm-script', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readJson<Record<string, unknown>>(req);
    if (!Array.isArray(body.replies) || body.replies.some((reply) => !reply || typeof reply !== 'object' || Array.isArray(reply))) {
      throw invalid('Send replies as a list of objects, for example [{ "say": "...", "action": "continue" }].', 'replies');
    }
    if (body.replies.length === 0) await ctx.kv.delete(DEV_LLM_SCRIPT_KEY);
    else await ctx.kv.setJSON(DEV_LLM_SCRIPT_KEY, body.replies);
    return json({ replies: body.replies });
  }),

  route('DELETE', '/dev/llm-script', async ({ ctx }) => {
    assertDev(ctx);
    await ctx.kv.delete(DEV_LLM_SCRIPT_KEY);
    return json({ ok: true });
  }),

  route('PUT', '/dev/ics', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readJson<Record<string, unknown>>(req);
    const name = requireName(body.name, 'name');
    const feed: DevIcsFeed = {};
    if (typeof body.body === 'string') feed.body = body.body;
    if (Array.isArray(body.events)) feed.events = parseBusy(body.events).map((e, i) => ({ start: e.start, end: e.end, summary: String((body.events as { summary?: unknown }[])[i]?.summary ?? 'Busy') }));
    if (typeof body.status === 'number' && Number.isInteger(body.status) && body.status >= 200 && body.status <= 599) feed.status = body.status;
    await ctx.kv.setJSON(`${DEV_ICS_PREFIX}${name}`, feed);
    if (body.keepCache !== true) await deletePrefix(ctx.kv, `${KEYS.cachePrefix}busy-`);
    return json({ name, url: `${DEV_ICS_ORIGIN}/${name}.ics` });
  }),

  route('DELETE', '/dev/ics', async ({ ctx, url }) => {
    assertDev(ctx);
    const only = url.searchParams.get('name');
    if (only) await ctx.kv.delete(`${DEV_ICS_PREFIX}${requireName(only, 'name')}`);
    else await deletePrefix(ctx.kv, DEV_ICS_PREFIX);
    return json({ ok: true });
  }),
];
