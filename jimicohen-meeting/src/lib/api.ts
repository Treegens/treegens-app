/**
 * Typed client for every route under `/meeting/api` (spec sections 4.5 and 4.6).
 * One named function per route. All of them throw ApiFailure { status, code, message, fields }.
 *
 * Response shapes this client expects (it also accepts the bare entity where a wrapper is listed):
 *   PUT  /admin/site                     → { site }
 *   POST|PUT /admin/event-types...       → { eventType }
 *   GET  /admin/hosts                    → { hosts }           PUT /admin/hosts/:id, PUT /host/:id → { host }
 *   GET  .../calendars                   → { calendars }
 *   GET|POST /admin/bookings/:id...      → { booking }
 *   POST /public/bookings/:id/(cancel|reschedule|confirm) → { booking }
 *   GET  /public/slots                   → SlotsResponse; `from` / `to` are sent as UTC ISO strings
 *
 * In dev with VITE_MOCK_API set, requests are answered by src/dev/mockApi.ts (in-memory data).
 * That branch is compiled out of production builds.
 */
import type {
  AdminBooking,
  AdminBookingsResponse,
  AdminBootstrap,
  AdminHost,
  AdminOverview,
  AssetUploadResponse,
  AuthState,
  CreateBookingRequest,
  CreateBookingResponse,
  EventType,
  GetBookingResponse,
  GoogleCalendarListItem,
  HostInviteResponse,
  HostSelfResponse,
  HostUpdate,
  IntegrationTestRequest,
  IntegrationTestResponse,
  IntegrationsStatus,
  IntegrationsUpdate,
  PublicBooking,
  PublicEventResponse,
  PublicSite,
  SharedHoursCheck,
  SiteSettings,
  SlotsResponse,
} from '../../shared/types';
import { ApiFailure, defaultMessageForStatus } from './apiError';
import { readFileAsDataUrl } from '../ui/util';

export { ApiFailure, errorMessage, isApiFailure } from './apiError';

/** "/meeting": the path the app is mounted at, without a trailing slash. */
export const APP_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
/** "/meeting/api" */
export const API_BASE = `${APP_BASE}/api`;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface CallOptions {
  /** cancel the request, e.g. when the visitor moves to another month */
  signal?: AbortSignal;
}

function queryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

let onUnauthorized: (() => void) | null = null;

/** The dashboard shell registers this to return to the sign-in screen when the session expires. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function notifyUnauthorized(path: string, status: number): void {
  if (status === 401 && path.startsWith('/admin') && onUnauthorized) onUnauthorized();
}

async function request<T>(method: Method, path: string, options: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API) {
    const { mockRequest } = await import('../dev/mockApi');
    try {
      return await mockRequest<T>(method, path, options.query ?? {}, options.body, options.signal);
    } catch (e) {
      if (e instanceof ApiFailure) notifyUnauthorized(path, e.status);
      throw e;
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'meeting' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${queryString(options.query)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiFailure(0, 'network', defaultMessageForStatus(0));
  }

  let data: unknown = undefined;
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: unknown; message?: unknown; fields?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : res.status === 401 ? 'unauthorized' : 'http_error';
    const message = typeof err?.message === 'string' && err.message ? err.message : defaultMessageForStatus(res.status);
    const fields = err?.fields && typeof err.fields === 'object' ? (err.fields as Record<string, string>) : undefined;
    notifyUnauthorized(path, res.status);
    throw new ApiFailure(res.status, code, message, fields);
  }
  return data as T;
}

/** Accepts `{ [key]: value }` or the bare value. */
function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === 'object' && !Array.isArray(res) && key in (res as Record<string, unknown>)) {
    return (res as Record<string, unknown>)[key] as T;
  }
  return res as T;
}

const enc = encodeURIComponent;

function toIso(t: string | number | Date): string {
  return typeof t === 'string' ? t : new Date(t).toISOString();
}

// ═════════════════════════════ public ═════════════════════════════

/** GET /public/site: profile, theme and the listed event types. */
export function getPublicSite(opts?: CallOptions): Promise<PublicSite> {
  return request('GET', '/public/site', opts);
}

/** GET /public/event/:slug: one event type (also resolves unlisted ones) plus the site. 404 when unknown or inactive. */
export function getPublicEvent(slug: string, opts?: CallOptions): Promise<PublicEventResponse> {
  return request('GET', `/public/event/${enc(slug)}`, opts);
}

export interface SlotsQuery {
  slug: string;
  durationMin: number;
  /** start of the range (inclusive): epoch ms, Date or ISO string */
  from: string | number | Date;
  /** end of the range (exclusive). The server clamps the range to 62 days. */
  to: string | number | Date;
  /** when rescheduling: the booking being moved, so its own slot counts as free */
  rescheduleBookingId?: string;
  /** manage token of that booking */
  token?: string;
}

/** GET /public/slots: bookable start times in a range, ascending. */
export function getSlots(q: SlotsQuery, opts?: CallOptions): Promise<SlotsResponse> {
  return request('GET', '/public/slots', {
    query: { slug: q.slug, duration: q.durationMin, from: toIso(q.from), to: toIso(q.to), reschedule: q.rescheduleBookingId, t: q.rescheduleBookingId ? q.token : undefined },
    signal: opts?.signal,
  });
}

/**
 * POST /public/bookings. Errors worth handling by code:
 * 409 `slot_taken` (refresh slots, keep the form), 409 `booking_limit` (too many upcoming meetings for the
 * email), 409 `in_progress` (the same request is still being saved), 503 `calendar_unavailable`,
 * 422 `invalid` (see `fields`), 429 (`phone_limit`: too many bookings with reminders for the number today;
 * `email_limit`: too many bookings made with the email address today).
 * Send the same `requestKey` on every retry of one form: a retry whose first try went through gets that booking back.
 */
export function createBooking(body: CreateBookingRequest): Promise<CreateBookingResponse> {
  return request('POST', '/public/bookings', { body });
}

/**
 * GET /public/bookings/:id?t=: a booking for its manage page. 404 for a wrong token. `as: 'host'` when the
 * page was opened from a host's link: for the signed-in owner the answer then allows what the dashboard does.
 */
export function getBooking(id: string, token: string, opts?: CallOptions & { as?: 'host' }): Promise<GetBookingResponse> {
  return request('GET', `/public/bookings/${enc(id)}`, { query: { t: token, as: opts?.as }, signal: opts?.signal });
}

/**
 * POST /public/bookings/:id/cancel. `as: 'host'` when the page was opened from a host's link: the
 * cancellation is then recorded as made by a host.
 */
export async function cancelBooking(id: string, token: string, reason?: string, as?: 'host'): Promise<PublicBooking> {
  return unwrap(await request('POST', `/public/bookings/${enc(id)}/cancel`, { body: { t: token, reason: reason || undefined, as } }), 'booking');
}

/**
 * POST /public/bookings/:id/reschedule. 409 `slot_taken` when the new time is gone, 409 / 429 `move_limit`
 * when the meeting has been moved too often. `timezone` is the invitee's own zone; with `as: 'host'` (the
 * page was opened from a host's link) leave it out, the server ignores it then anyway.
 */
export async function rescheduleBooking(id: string, token: string, start: string, timezone?: string, as?: 'host'): Promise<PublicBooking> {
  return unwrap(await request('POST', `/public/bookings/${enc(id)}/reschedule`, { body: { t: token, start, timezone, as } }), 'booking');
}

/** POST /public/bookings/:id/confirm: the invitee says "I'll be there". With `as: 'host'` the server refuses (409 `host_link`). */
export async function confirmBooking(id: string, token: string, as?: 'host'): Promise<PublicBooking> {
  return unwrap(await request('POST', `/public/bookings/${enc(id)}/confirm`, { body: { t: token, as } }), 'booking');
}

/** URL of the .ics download for a booking (GET /public/bookings/:id/ics?t=). */
export function bookingIcsUrl(id: string, token: string): string {
  return `${API_BASE}/public/bookings/${enc(id)}/ics?t=${enc(token)}`;
}

/** URL an uploaded image is served from (GET /assets/:id), or null without an id. */
export function assetUrl(id: string | null | undefined): string | null {
  return id ? `${API_BASE}/assets/${enc(id)}` : null;
}

/** Absolute URL of an app route, for sharing: appUrl('/intro') → "https://jimicohen.com/meeting/intro". */
export function appUrl(route = '/'): string {
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${window.location.origin}${APP_BASE}${path === '/' ? '' : path}`;
}

// ═════════════════════════════ auth ═════════════════════════════

/** GET /auth/state: first run? signed in? */
export function getAuthState(opts?: CallOptions): Promise<AuthState> {
  return request('GET', '/auth/state', opts);
}

/** POST /auth/setup: first run only. Creates the admin password and signs in. */
export async function setup(input: { code: string; password: string; deviceTimezone?: string; email?: string }): Promise<void> {
  await request('POST', '/auth/setup', { body: input });
}

/** POST /auth/login. 401 for a wrong password, 429 when rate limited. */
export async function login(password: string): Promise<void> {
  await request('POST', '/auth/login', { body: { password } });
}

/** POST /auth/logout */
export async function logout(): Promise<void> {
  await request('POST', '/auth/logout', { body: {} });
}

/** POST /auth/password */
export async function changePassword(current: string, next: string): Promise<void> {
  await request('POST', '/auth/password', { body: { current, next } });
}

// ═════════════════════════════ admin ═════════════════════════════

/** GET /admin/bootstrap: everything the dashboard needs on load. */
export function getBootstrap(opts?: CallOptions): Promise<AdminBootstrap> {
  return request('GET', '/admin/bootstrap', opts);
}

/** GET /admin/overview: home screen data. */
export function getOverview(opts?: CallOptions): Promise<AdminOverview> {
  return request('GET', '/admin/overview', opts);
}

/** Recursive partial for PUT /admin/site: send only what changed. Arrays are replaced whole. */
export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** PUT /admin/site: partial site settings (profile, theme, assistant, booking, email). Returns the saved site. */
export async function saveSite(patch: DeepPartial<SiteSettings>): Promise<SiteSettings> {
  return unwrap(await request('PUT', '/admin/site', { body: patch }), 'site');
}

/** POST /admin/event-types: the server fills in defaults for everything you leave out. */
export async function createEventType(input: Partial<EventType>): Promise<EventType> {
  return unwrap(await request('POST', '/admin/event-types', { body: input }), 'eventType');
}

/** PUT /admin/event-types/:id */
export async function updateEventType(id: string, patch: Partial<EventType>): Promise<EventType> {
  return unwrap(await request('PUT', `/admin/event-types/${enc(id)}`, { body: patch }), 'eventType');
}

/** DELETE /admin/event-types/:id */
export async function deleteEventType(id: string): Promise<void> {
  await request('DELETE', `/admin/event-types/${enc(id)}`);
}

/** POST /admin/event-types/:id/duplicate */
export async function duplicateEventType(id: string): Promise<EventType> {
  return unwrap(await request('POST', `/admin/event-types/${enc(id)}/duplicate`, { body: {} }), 'eventType');
}

/** PUT /admin/event-types-order: ids in the order they should appear. */
export async function reorderEventTypes(ids: string[]): Promise<void> {
  await request('PUT', '/admin/event-types-order', { body: { ids } });
}

/**
 * POST /admin/event-types-check: for a joint meeting, whether its hosts' working hours ever line
 * up. Takes the event type as it is on screen, saved or not. Nothing is stored.
 */
export function checkSharedHours(draft: Partial<EventType>, opts?: CallOptions): Promise<SharedHoursCheck> {
  return request('POST', '/admin/event-types-check', { body: draft, signal: opts?.signal });
}

/** GET /admin/hosts */
export async function listHosts(opts?: CallOptions): Promise<AdminHost[]> {
  return unwrap(await request('GET', '/admin/hosts', opts), 'hosts');
}

/** POST /admin/hosts: adds a co-host. The invite link in the answer is shown once. */
export function createHost(input: { name: string; email: string }): Promise<HostInviteResponse> {
  return request('POST', '/admin/hosts', { body: input });
}

/** PUT /admin/hosts/:id */
export async function updateHost(id: string, update: HostUpdate): Promise<AdminHost> {
  return unwrap(await request('PUT', `/admin/hosts/${enc(id)}`, { body: update }), 'host');
}

/** A host update together with what the server says about the time zone. */
export interface HostZoneAnswer {
  host: AdminHost;
  /** true when this update moved the host to another zone. null when the answer does not say (the in-browser mock). */
  timezoneChanged: boolean | null;
}

function zoneAnswer(res: unknown): HostZoneAnswer {
  const changed = res && typeof res === 'object' ? (res as { timezoneChanged?: unknown }).timezoneChanged : undefined;
  return { host: unwrap<AdminHost>(res, 'host'), timezoneChanged: typeof changed === 'boolean' ? changed : null };
}

/**
 * PUT /admin/hosts/:id { deviceTimezone }: tells the server which zone this device is in. It only
 * moves a host whose zone follows their device, and `timezoneChanged` says whether it did.
 */
export async function reportDeviceZone(id: string, deviceTimezone: string): Promise<HostZoneAnswer> {
  return zoneAnswer(await request('PUT', `/admin/hosts/${enc(id)}`, { body: { deviceTimezone } }));
}

/** DELETE /admin/hosts/:id. 409 while an event type still uses the host. */
export async function deleteHost(id: string): Promise<void> {
  await request('DELETE', `/admin/hosts/${enc(id)}`);
}

/** POST /admin/hosts/:id/invite: a fresh self-service link. The old one stops working. */
export function regenerateInvite(id: string): Promise<{ inviteUrl: string; host?: AdminHost }> {
  return request('POST', `/admin/hosts/${enc(id)}/invite`, { body: {} });
}

/** GET /admin/hosts/:id/calendars: the host's Google calendars. */
export async function getHostCalendars(id: string, opts?: CallOptions): Promise<GoogleCalendarListItem[]> {
  return unwrap(await request('GET', `/admin/hosts/${enc(id)}/calendars`, opts), 'calendars');
}

/** POST /admin/hosts/:id/google/disconnect */
export async function disconnectGoogle(id: string): Promise<void> {
  await request('POST', `/admin/hosts/${enc(id)}/google/disconnect`, { body: {} });
}

export interface BookingsQuery {
  scope: 'upcoming' | 'past' | 'cancelled';
  /** free text: invitee name or email, event title */
  q?: string;
  limit?: number;
  offset?: number;
}

/** GET /admin/bookings */
export function listBookings(query: BookingsQuery, opts?: CallOptions): Promise<AdminBookingsResponse> {
  return request('GET', '/admin/bookings', { query: { ...query }, signal: opts?.signal });
}

/** GET /admin/bookings/:id */
export async function getAdminBooking(id: string, opts?: CallOptions): Promise<AdminBooking> {
  return unwrap(await request('GET', `/admin/bookings/${enc(id)}`, opts), 'booking');
}

/** POST /admin/bookings/:id/cancel */
export async function adminCancelBooking(id: string, reason?: string): Promise<AdminBooking> {
  return unwrap(await request('POST', `/admin/bookings/${enc(id)}/cancel`, { body: { reason: reason || undefined } }), 'booking');
}

/** POST /admin/bookings/:id/no-show */
export async function setNoShow(id: string, noShow: boolean): Promise<AdminBooking> {
  return unwrap(await request('POST', `/admin/bookings/${enc(id)}/no-show`, { body: { noShow } }), 'booking');
}

/**
 * DELETE /admin/bookings/:id : erases a cancelled or past booking for good (refused with 409 for an upcoming one).
 * 409 `calendar_event_left`: the cancelled meeting's event could not be taken off Google Calendar. Ask the owner,
 * then send `leaveCalendarEvent` to delete it anyway, with the event left where it is.
 */
export async function deleteAdminBooking(id: string, opts?: { leaveCalendarEvent?: boolean }): Promise<void> {
  await request('DELETE', `/admin/bookings/${enc(id)}`, opts?.leaveCalendarEvent ? { query: { leaveCalendarEvent: 1 } } : {});
}

/** URL of the CSV export (GET /admin/bookings.csv). Use it as a download link. */
export function bookingsCsvUrl(query?: { scope?: BookingsQuery['scope']; q?: string }): string {
  return `${API_BASE}/admin/bookings.csv${queryString(query)}`;
}

/** GET /admin/integrations: connection status. Never contains secrets. */
export function getIntegrations(opts?: CallOptions): Promise<IntegrationsStatus> {
  return request('GET', '/admin/integrations', opts);
}

/** PUT /admin/integrations: only the keys you send change. An empty string clears a secret. */
export async function saveIntegrations(update: IntegrationsUpdate): Promise<IntegrationsStatus> {
  return unwrap(await request('PUT', '/admin/integrations', { body: update }), 'integrations');
}

/** POST /admin/integrations/test: sends a real test email, text or call, or probes Google / Anthropic. */
export function testIntegration(body: IntegrationTestRequest): Promise<IntegrationTestResponse> {
  return request('POST', '/admin/integrations/test', { body });
}

export type AssetPurpose = 'avatar' | 'host-avatar' | 'cover' | 'logo' | 'background' | 'event-cover';

/** POST /admin/assets: uploads an image given as a data: URL (png, jpeg, webp or gif, at most 3 MB). */
export function uploadAsset(dataUrl: string, purpose: AssetPurpose | string): Promise<AssetUploadResponse> {
  return request('POST', '/admin/assets', { body: { dataUrl, purpose } });
}

export const MAX_ASSET_BYTES = 3 * 1024 * 1024;
export const ASSET_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Checks a picked file, reads it as a data URL and uploads it. Throws ApiFailure with a friendly message. */
export async function uploadImageFile(file: File, purpose: AssetPurpose | string): Promise<AssetUploadResponse & { dataUrl: string }> {
  if (!ASSET_MIME_TYPES.includes(file.type)) throw new ApiFailure(422, 'invalid', 'Please choose a PNG, JPEG, WebP or GIF image.');
  if (file.size > MAX_ASSET_BYTES) throw new ApiFailure(413, 'too_large', 'That image is larger than 3 MB. Please choose a smaller one.');
  const dataUrl = await readFileAsDataUrl(file).catch(() => {
    throw new ApiFailure(422, 'invalid', 'We could not read that file. Please try another image.');
  });
  const uploaded = await uploadAsset(dataUrl, purpose);
  return { ...uploaded, dataUrl };
}

/** DELETE /admin/assets/:id */
export async function deleteAsset(id: string): Promise<void> {
  await request('DELETE', `/admin/assets/${enc(id)}`);
}

// ═════════════════════════════ co-host self-service ═════════════════════════════

/** GET /host/:id?t=: what a co-host sees through their invite link. 404 for a wrong token. */
export function getHostSelf(id: string, token: string, opts?: CallOptions): Promise<HostSelfResponse> {
  return request('GET', `/host/${enc(id)}`, { query: { t: token }, signal: opts?.signal });
}

/** PUT /host/:id?t=: the co-host updates their own hours, zone, calendars or feeds. */
export async function updateHostSelf(id: string, token: string, update: HostUpdate): Promise<AdminHost> {
  return unwrap(await request('PUT', `/host/${enc(id)}`, { query: { t: token }, body: update }), 'host');
}

/** PUT /host/:id?t= { deviceTimezone }: the co-host's page reports the zone of the device it is opened on. */
export async function reportDeviceZoneSelf(id: string, token: string, deviceTimezone: string): Promise<HostZoneAnswer> {
  return zoneAnswer(await request('PUT', `/host/${enc(id)}`, { query: { t: token }, body: { deviceTimezone } }));
}

/** GET /host/:id/calendars?t= */
export async function getHostSelfCalendars(id: string, token: string, opts?: CallOptions): Promise<GoogleCalendarListItem[]> {
  return unwrap(await request('GET', `/host/${enc(id)}/calendars`, { query: { t: token }, signal: opts?.signal }), 'calendars');
}

/** POST /host/:id/google/disconnect?t=: the co-host disconnects their own Google Calendar. Returns the host as it is now. */
export async function disconnectGoogleSelf(id: string, token: string): Promise<AdminHost> {
  return unwrap(await request('POST', `/host/${enc(id)}/google/disconnect`, { query: { t: token }, body: {} }), 'host');
}

// ═════════════════════════════ google ═════════════════════════════

export interface GoogleConnectParams {
  hostId: string;
  /** where Google sends the person back to: a path under the app base, e.g. `${APP_BASE}/admin/integrations` */
  returnTo: string;
  /** also ask for permission to send email from Gmail */
  gmail?: boolean;
  /** co-host invite token when a co-host connects their own calendar */
  token?: string;
  /** "Use a different Google account": Google shows its account chooser */
  switchAccount?: boolean;
}

/**
 * URL that starts the Google OAuth redirect (GET /google/connect). Navigate the whole page to it
 * (`window.location.assign(url)`): popups are blocked by policy. The person comes back to
 * `returnTo` with `?google=connected` (and `&zone=<IANA zone>` when their time zone changed with
 * it) or `?google=error&reason=...`.
 */
export function googleConnectUrl({ hostId, returnTo, gmail = false, token, switchAccount = false }: GoogleConnectParams): string {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API) {
    const sep = returnTo.includes('?') ? '&' : '?';
    return `${returnTo}${sep}google=connected&mock_google_host=${enc(hostId)}${gmail ? '&mock_google_gmail=1' : ''}`;
  }
  return `${API_BASE}/google/connect${queryString({ host: hostId, gmail: gmail ? 1 : 0, return: returnTo, t: token, switch: switchAccount ? 1 : undefined })}`;
}

/** The query parameters a return from Google leaves on the page it lands on. Read them, then remove them. */
export const GOOGLE_RETURN_PARAMS = ['google', 'reason', 'zone'] as const;
