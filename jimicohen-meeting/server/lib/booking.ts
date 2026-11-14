/**
 * Bookings: the public view of the site, available times, and the whole life of a booking
 * (create, cancel, move, confirm attendance, calendar sync).
 *
 * How the guarantees are kept:
 *
 *   Never double-book. The booking index (one blob, compare-and-swap) is the only place where a time
 *   is taken or given back. Every write to it re-runs the slot check against the index as it is at
 *   that instant, so of two requests racing for overlapping times of any shared host exactly one wins.
 *
 *   Never lose a booking, never free a time by accident. Writes happen in the order that fails safe:
 *     create      index entry first, booking record second (a crash in between leaves a blocked time)
 *     cancel      booking record first, index second       (a crash in between leaves a blocked time)
 *     reschedule  index entry first, booking record second (the index is the commit point; the move is
 *                                                           finished later by reconcileBookings)
 *   reconcileBookings (run from the scheduled function) heals all three leftovers.
 *
 *   Fail closed on calendars. A host whose external calendar cannot be read is never treated as free.
 *
 *   Google is best effort. A slow or failing Google call never costs the booking: the problem is noted
 *   on booking.google.error and a gcal_sync job repeats the work.
 */
import { sanitizeCustomCss } from '../../shared/theme';
import type {
  Booking,
  BookingIndexEntry,
  BookingLocation,
  CreateBookingRequest,
  EventKind,
  EventType,
  Host,
  IanaZone,
  LocationConfig,
  LocationType,
  PublicBooking,
  PublicEventType,
  PublicHost,
  PublicSite,
  Question,
  SendResult,
  SiteSettings,
  SlotsResponse,
  Theme,
} from '../../shared/types';
import { rateLimit } from './auth';
import { getBusyForHosts } from './busy';
import { hmacHex, randomId, safeEqual, sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { GoogleApiError, GoogleAuthError, googleCreateEvent, googleDeleteEvent, googleUpdateEvent, type CalendarEventInput } from './google';
import { HttpError } from './http';
import { calendarLinks } from './ics';
import { cancelBookingJobs, enqueueJob, registerJobHandler, runDueJobs, scheduleBookingJobs } from './jobs';
import {
  assetUrl,
  cacheGet,
  cacheSet,
  claim,
  getBooking,
  getBookingIndex,
  getEventType,
  getSite,
  isStorageId,
  listEventTypes,
  listHosts,
  mutateBookingIndex,
  saveBooking,
  updateBooking,
} from './repo';
import { checkSlot, computeSlots, pickRoundRobinHost, type HostAvailabilityInput, type SlotQuery, type SlotRejection } from './slots';
import { firstName, joinNames, renderTemplate } from './templates';
import { DAY_MS, MINUTE_MS, formatInZone, isValidZone, type Interval } from './time';
import { normalizePhone, twilioFeatures } from './twilio';
import { FieldErrors, cleanLine, cleanText, isEmail, isHttpsUrl, isIsoInstant, isPlainObject, isZone } from './validate';

// ───────────────────────── limits ─────────────────────────

const HOUR_SEC = 3600;
const BOOKINGS_PER_IP_PER_HOUR = 10;
const BOOKINGS_PER_EMAIL_PER_HOUR = 6;
/** Requests without a client address share one counter, so that counter is wider. */
const UNKNOWN_IP_FACTOR = 12;
/** A person needs longer than this to fill in the form. */
const MIN_FORM_MS = 1500;

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_LOCATION_TEXT = 300;
const MAX_ANSWER_SHORT = 500;
const MAX_ANSWER_LONG = 2000;
const MAX_REASON = 500;
const MAX_QUESTIONS = 50;
const MAX_GUESTS = 25;
const MAX_UTM_KEYS = 8;
const MAX_UTM_VALUE = 200;

export const MAX_SLOT_RANGE_MS = 62 * DAY_MS;
/** How long the response waits for Google before the work moves to the background. */
export const CALENDAR_BUDGET_MS = 7000;
/** How long a request waits for the hosts' calendars to say when they are busy. After that it fails closed. */
export const CALENDAR_READ_BUDGET_MS = 6000;
/** A request aims to answer within this time, so the calendar write gets what the earlier steps left over. */
const REQUEST_BUDGET_MS = 9000;
const MIN_CALENDAR_BUDGET_MS = 1000;
const RETRY_AFTER_TIMEOUT_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 2 * MINUTE_MS;
const IMMEDIATE_JOBS_BUDGET_MS = 8000;

const GENERIC_REFUSAL = 'Could not complete the booking. Please try again.';
const BOOKING_NOT_FOUND = 'We could not find that booking. Check the link in your confirmation email.';
const CALENDAR_PENDING = 'Google Calendar did not answer in time. Trying again shortly.';
const CALENDAR_RECONNECT = 'Google Calendar needs to be reconnected.';

// ───────────────────────── small helpers ─────────────────────────

function nowIso(ctx: Ctx): string {
  return ctx.now().toISOString();
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

/** Text that is placed inside a message template must not be read as template tags itself. */
function literal(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', BOOKING_NOT_FOUND);
}

function hostsById(hosts: Host[]): Map<string, Host> {
  return new Map(hosts.map((h) => [h.id, h]));
}

function pickHosts(ids: string[], byId: Map<string, Host>): Host[] {
  const out: Host[] = [];
  for (const id of new Set(ids ?? [])) {
    const host = byId.get(id);
    if (host) out.push(host);
  }
  return out;
}

function ownerOf(site: SiteSettings, hosts: Host[]): Host | null {
  return hosts.find((h) => h.id === site.ownerHostId) ?? hosts.find((h) => h.role === 'owner') ?? hosts[0] ?? null;
}

/** Zone the slot grid is laid out in. An unreadable owner zone must not take the whole site down. */
function ownerZoneOf(ctx: Ctx, site: SiteSettings, hosts: Host[]): IanaZone {
  const owner = ownerOf(site, hosts);
  if (owner && isValidZone(owner.timezone)) return owner.timezone;
  ctx.log('warn', 'booking: the owner has no usable time zone, using UTC');
  return 'UTC';
}

function buffersOf(eventTypes: EventType[]): Record<string, { beforeMin: number; afterMin: number }> {
  const out: Record<string, { beforeMin: number; afterMin: number }> = {};
  for (const et of eventTypes) {
    out[et.id] = { beforeMin: positive(et.scheduling?.bufferBeforeMin), afterMin: positive(et.scheduling?.bufferAfterMin) };
  }
  return out;
}

function positive(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

const TIMED_OUT = Symbol('timed out');

async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** For follow-up work that must not turn a finished booking into an error. */
async function quietly(ctx: Ctx, what: string, bookingId: string, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    ctx.log('error', `booking: ${what} failed`, { bookingId, error: shortError(err) });
    return false;
  }
}

function runImmediateJobs(ctx: Ctx, bookingId: string, after?: Promise<unknown>): void {
  const run = async (): Promise<void> => {
    if (after) await after.catch(() => undefined);
    await runDueJobs(ctx, { onlyBookingId: bookingId, budgetMs: IMMEDIATE_JOBS_BUDGET_MS });
  };
  ctx.waitUntil(
    run().catch((err) => {
      // Nothing is lost: the jobs stay queued and the scheduled run sends them.
      ctx.log('warn', 'booking: could not send the queued messages right away', { bookingId, error: shortError(err) });
    }),
  );
}

// ───────────────────────── manage token ─────────────────────────

/** hmacHex(ctx, 'manage', bookingId) */
export function manageToken(ctx: Ctx, bookingId: string): string {
  return hmacHex(ctx, 'manage', bookingId);
}

export function verifyManageToken(ctx: Ctx, bookingId: string, token: string | null): boolean {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return false;
  if (!isStorageId(bookingId)) return false;
  return safeEqual(token, manageToken(ctx, bookingId));
}

// ───────────────────────── public views ─────────────────────────

const LOCATION_LABELS: Record<LocationType, string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call',
  phone_invitee_calls: 'Phone call',
  in_person: 'In person',
  custom_link: 'Video call',
  ask_invitee: 'Location',
};

export function toPublicHost(ctx: Ctx, host: Host): PublicHost {
  const out: PublicHost = { id: host.id, name: host.name, avatarUrl: assetUrl(ctx, host.avatarAssetId) };
  if (host.title && host.title.trim() !== '') out.title = host.title;
  return out;
}

/**
 * What a visitor may know about a location before booking. Links and phone numbers the owner typed in
 * are only handed out with a booking, so the public page never becomes a way to collect them.
 */
function publicLocation(loc: LocationConfig, leadFirstName: string): PublicEventType['locations'][number] {
  const custom = cleanLine(loc?.label, 80);
  switch (loc?.type) {
    case 'google_meet':
      return { type: 'google_meet', label: custom || 'Google Meet', detail: 'You get the link when you book' };
    case 'phone_host_calls':
      return { type: 'phone_host_calls', label: custom || 'Phone call', detail: `${leadFirstName || 'Your host'} calls you` };
    case 'phone_invitee_calls':
      return { type: 'phone_invitee_calls', label: custom || 'Phone call', detail: 'You get the number when you book' };
    case 'in_person': {
      const address = cleanLine(loc.value, 300);
      return address ? { type: 'in_person', label: custom || 'In person', detail: address } : { type: 'in_person', label: custom || 'In person' };
    }
    case 'custom_link':
      return { type: 'custom_link', label: custom || 'Video call', detail: 'You get the link when you book' };
    default:
      return { type: 'ask_invitee', label: custom || 'Your choice', detail: 'Tell us where suits you' };
  }
}

function publicQuestion(q: Question): Question {
  const out: Question = { id: q.id, label: q.label, type: q.type, required: q.required === true };
  if (Array.isArray(q.options)) out.options = q.options.filter((o) => typeof o === 'string');
  if (typeof q.placeholder === 'string' && q.placeholder !== '') out.placeholder = q.placeholder;
  return out;
}

function publicThemePart<T extends Partial<Theme>>(theme: T): T {
  return typeof theme.customCss === 'string' ? { ...theme, customCss: sanitizeCustomCss(theme.customCss) } : theme;
}

function locationsOf(et: EventType): LocationConfig[] {
  const list = Array.isArray(et.locations) ? et.locations.filter((l) => l && typeof l.type === 'string') : [];
  return list.length > 0 ? list : [{ type: 'google_meet' }];
}

/** `hosts` may be every host of the site: only the ones assigned to the event type are shown. */
export function toPublicEventType(ctx: Ctx, et: EventType, hosts: Host[]): PublicEventType {
  const assigned = pickHosts(et.hostIds, hostsById(hosts));
  const lead = firstName(assigned[0]?.name ?? '');
  const out: PublicEventType = {
    id: et.id,
    slug: et.slug,
    title: et.title,
    description: et.description ?? '',
    coverUrl: assetUrl(ctx, et.coverAssetId),
    kind: et.kind,
    hosts: assigned.map((h) => toPublicHost(ctx, h)),
    durations: [...(et.durations ?? [])],
    defaultDuration: et.defaultDuration,
    locations: locationsOf(et).map((l) => publicLocation(l, lead)),
    questions: (et.questions ?? []).slice(0, MAX_QUESTIONS).map(publicQuestion),
    allowGuests: et.allowGuests === true,
    maxGuests: et.allowGuests === true ? Math.max(0, Math.min(MAX_GUESTS, Math.trunc(positive(et.maxGuests)))) : 0,
    phone: et.phone,
    minNoticeMinutes: positive(et.scheduling?.minNoticeMinutes),
    maxDaysAhead: positive(et.scheduling?.maxDaysAhead),
    themeOverride: et.themeOverride ? publicThemePart(et.themeOverride) : null,
  };
  if (et.emoji) out.emoji = et.emoji;
  if (et.color) out.color = et.color;
  return out;
}

function buildPublicSite(ctx: Ctx, p: { site: SiteSettings; hosts: Host[]; eventTypes: EventType[]; features: { sms: boolean; calls: boolean } }): PublicSite {
  const { site, hosts } = p;
  const booking: PublicSite['booking'] = {
    reminderOptInDefault: site.booking?.reminderOptInDefault === true,
    consentText: site.booking?.consentText ?? '',
  };
  if (site.booking?.privacyUrl) booking.privacyUrl = site.booking.privacyUrl;
  return {
    profile: {
      name: site.profile.name,
      headline: site.profile.headline,
      welcome: site.profile.welcome,
      avatarUrl: assetUrl(ctx, site.profile.avatarAssetId),
      links: (site.profile.links ?? []).map((l) => ({ label: l.label, url: l.url })),
    },
    theme: publicThemePart(site.theme),
    themeAssets: {
      coverUrl: assetUrl(ctx, site.theme.coverAssetId),
      logoUrl: assetUrl(ctx, site.theme.logoAssetId),
      backgroundUrl: assetUrl(ctx, site.theme.background?.imageAssetId),
    },
    eventTypes: p.eventTypes.filter((et) => et.active === true && et.visibility === 'public').map((et) => toPublicEventType(ctx, et, hosts)),
    booking,
    assistantName: site.assistant?.name ?? '',
    features: { sms: p.features.sms === true, calls: p.features.calls === true },
    ownerTimezone: ownerZoneOf(ctx, site, hosts),
  };
}

export async function toPublicSite(ctx: Ctx): Promise<PublicSite> {
  const site = await getSite(ctx);
  const [hosts, eventTypes, features] = await Promise.all([listHosts(ctx), listEventTypes(ctx), twilioFeatures(ctx)]);
  return buildPublicSite(ctx, { site, hosts, eventTypes, features });
}

/** The site plus one event type by its link. Unlisted event types resolve here; paused or unknown ones give null. */
export async function getPublicEvent(ctx: Ctx, slug: string): Promise<{ site: PublicSite; eventType: PublicEventType } | null> {
  const site = await getSite(ctx);
  const [hosts, eventTypes, features] = await Promise.all([listHosts(ctx), listEventTypes(ctx), twilioFeatures(ctx)]);
  const wanted = typeof slug === 'string' ? slug.toLowerCase() : '';
  const et = wanted === '' ? undefined : eventTypes.find((e) => e.slug.toLowerCase() === wanted);
  if (!et || et.active !== true) return null;
  return { site: buildPublicSite(ctx, { site, hosts, eventTypes, features }), eventType: toPublicEventType(ctx, et, hosts) };
}

function selfServiceOpen(b: Booking, nowMs: number): boolean {
  return b.status === 'confirmed' && Date.parse(b.start) > nowMs;
}

function publicBookingOf(ctx: Ctx, b: Booking, hosts: Host[], eventType: EventType | null): PublicBooking {
  const assigned = pickHosts(b.hostIds, hostsById(hosts));
  const open = selfServiceOpen(b, ctx.now().getTime());
  const invitee: PublicBooking['invitee'] = { name: b.invitee.name, email: b.invitee.email, timezone: b.invitee.timezone };
  if (b.invitee.phone) invitee.phone = b.invitee.phone;
  const location: BookingLocation = { type: b.location.type, label: b.location.label };
  if (b.location.value) location.value = b.location.value;
  if (b.location.joinUrl) location.joinUrl = b.location.joinUrl;

  const out: PublicBooking = {
    id: b.id,
    status: b.status,
    eventTitle: b.eventTitle,
    eventSlug: b.eventSlug,
    start: b.start,
    end: b.end,
    durationMin: b.durationMin,
    hosts: assigned.map((h) => toPublicHost(ctx, h)),
    invitee,
    guests: [...(b.guests ?? [])],
    location,
    canReschedule: open && !!eventType && eventType.active === true,
    canCancel: open,
    calendarLinks: calendarLinks({ booking: b, hosts: assigned, baseUrl: ctx.env.publicBaseUrl, manageToken: manageToken(ctx, b.id) }),
    cancellation: b.cancellation ? { at: b.cancellation.at, by: b.cancellation.by, ...(b.cancellation.reason ? { reason: b.cancellation.reason } : {}) } : null,
    rescheduledFromStart: b.rescheduledFromStart ?? null,
    attendanceConfirmed: !!b.attendance?.confirmedAt,
  };
  const message = eventType?.confirmation?.message?.trim();
  if (message) out.confirmationMessage = message;
  const redirectUrl = eventType?.confirmation?.redirectUrl?.trim();
  if (redirectUrl && isHttpsUrl(redirectUrl)) out.redirectUrl = redirectUrl;
  return out;
}

/** The booking as its invitee may see it. Only ever hand this to someone who holds the manage token. */
export async function toPublicBooking(ctx: Ctx, b: Booking): Promise<PublicBooking> {
  const [hosts, eventType] = await Promise.all([listHosts(ctx), getEventType(ctx, b.eventTypeId)]);
  return publicBookingOf(ctx, b, hosts, eventType);
}

/** Everything the manage page needs, or null when the booking does not exist. The caller checks the token. */
export async function getManageView(
  ctx: Ctx,
  bookingId: string,
): Promise<{ booking: PublicBooking; site: PublicSite; eventType: PublicEventType | null } | null> {
  const record = await getBooking(ctx, bookingId);
  if (!record) return null;
  const site = await getSite(ctx);
  const [hosts, eventTypes, features] = await Promise.all([listHosts(ctx), listEventTypes(ctx), twilioFeatures(ctx)]);
  const eventType = eventTypes.find((e) => e.id === record.eventTypeId) ?? null;
  return {
    booking: publicBookingOf(ctx, record, hosts, eventType),
    site: buildPublicSite(ctx, { site, hosts, eventTypes, features }),
    eventType: eventType ? toPublicEventType(ctx, eventType, hosts) : null,
  };
}

// ───────────────────────── availability plumbing ─────────────────────────

interface Scheduling {
  site: SiteSettings;
  hosts: Host[];
  byId: Map<string, Host>;
  eventTypes: EventType[];
  ownerTimezone: IanaZone;
  buffers: Record<string, { beforeMin: number; afterMin: number }>;
}

async function loadScheduling(ctx: Ctx): Promise<Scheduling> {
  const site = await getSite(ctx);
  const [hosts, eventTypes] = await Promise.all([listHosts(ctx), listEventTypes(ctx)]);
  return { site, hosts, byId: hostsById(hosts), eventTypes, ownerTimezone: ownerZoneOf(ctx, site, hosts), buffers: buffersOf(eventTypes) };
}

interface CalendarFailure {
  host: Host;
  error: string;
}

interface ExternalBusy {
  /** hosts whose calendars could be read. A host that is missing here is never offered. */
  inputs: HostAvailabilityInput[];
  failed: CalendarFailure[];
  /** true when the event cannot be offered at all because of calendar trouble */
  blocked: boolean;
}

/**
 * External busy time for the hosts of an event. A host whose calendar cannot be read is left out, which
 * the slot engine reads as "never free". For solo and collective events that closes every time (each host
 * is required); a round robin carries on with the hosts that can be read.
 */
async function loadExternalBusy(ctx: Ctx, kind: EventKind, hosts: Host[], range: Interval, fresh: boolean, budgetMs: number = CALENDAR_READ_BUDGET_MS): Promise<ExternalBusy> {
  const reading = getBusyForHosts(ctx, hosts, range, fresh ? { fresh: true } : undefined);
  const results = await withinBudget(reading, budgetMs);
  if (results === TIMED_OUT) {
    // Slow is not the same as broken, so nobody is alerted. But without an answer nothing can be offered.
    ctx.log('warn', 'booking: the calendars did not answer in time', { hosts: hosts.map((h) => h.id) });
    ctx.waitUntil(reading);
    return { inputs: [], failed: [], blocked: true };
  }
  const inputs: HostAvailabilityInput[] = [];
  const failed: CalendarFailure[] = [];
  hosts.forEach((host, i) => {
    const result = results[i];
    if (result && result.ok) inputs.push({ host, busy: result.busy });
    else failed.push({ host, error: result?.error ?? 'Calendar could not be read.' });
  });
  const blocked = failed.length > 0 && (kind === 'round_robin' ? inputs.length === 0 : true);
  return { inputs, failed, blocked };
}

function bufferPadMs(et: EventType): number {
  return Math.max(positive(et.scheduling?.bufferBeforeMin), positive(et.scheduling?.bufferAfterMin)) * MINUTE_MS;
}

/**
 * Tells the owner that a calendar cannot be read: one email per broken host per day, however many
 * bookings or health checks run into it.
 */
export async function alertCalendarTrouble(ctx: Ctx, failures: { host: Host; error: string }[], during?: { eventTitle?: string }): Promise<number> {
  const day = nowIso(ctx).slice(0, 10);
  const fresh: { host: Host; error: string }[] = [];
  for (const failure of failures) {
    if (await claim(ctx, `alert-calendar-${failure.host.id}-${day}`)) fresh.push(failure);
  }
  if (fresh.length === 0) return 0;

  const names = joinNames(fresh.map((f) => f.host.name.trim() || 'a host'));
  const seen = fresh.map((f) => `${f.host.name.trim() || 'A host'}: ${f.error}`).join('\n');
  const first = during?.eventTitle
    ? `Someone just tried to book "${during.eventTitle}", but the calendar of ${names} could not be read. To avoid a double booking the request was turned away.`
    : `The calendar of ${names} could not be read during a routine check.`;
  const body = [
    'Hi {{host_first_name}},',
    literal(first),
    literal(`Until the calendar can be read again, times that depend on it are not offered on your booking page.\n\nWhat we saw:\n${seen}`),
    'Open your dashboard to reconnect the calendar. You get this email at most once a day for each calendar.',
  ].join('\n\n');
  await enqueueJob(ctx, {
    type: 'message',
    kind: 'host_alert',
    bookingId: '',
    channel: 'email',
    audience: 'host',
    subject: literal(`A calendar needs attention: ${names}`),
    body,
    dueAt: nowIso(ctx),
  });
  return fresh.length;
}

function calendarUnavailable(): HttpError {
  return new HttpError(503, 'calendar_unavailable', 'We could not check the calendar just now, so nothing was booked. Please try again in a minute.');
}

function slotTaken(reason: SlotRejection | 'conflict'): HttpError {
  const message =
    reason === 'too_soon'
      ? 'That time is now too close to book. Please pick a later one.'
      : reason === 'busy' || reason === 'daily_limit' || reason === 'conflict'
        ? 'That time was just taken. Please pick another one.'
        : 'That time is no longer available. Please pick another one.';
  return new HttpError(409, 'slot_taken', message);
}

// ───────────────────────── available times ─────────────────────────

function floorTo(ms: number, step: number): number {
  return Math.floor(ms / step) * step;
}

/**
 * Bookable start times of an event type between fromMs and toMs (clamped to 62 days and to the window
 * the event type allows). With rescheduleBookingId the booking's own time counts as free and the times
 * are those of the hosts already assigned to it. The caller checks the manage token.
 */
export async function getSlots(
  ctx: Ctx,
  p: { slug: string; durationMin: number; fromMs: number; toMs: number; rescheduleBookingId?: string },
): Promise<SlotsResponse> {
  const s = await loadScheduling(ctx);
  const wanted = typeof p.slug === 'string' ? p.slug.toLowerCase() : '';
  const eventType = wanted === '' ? undefined : s.eventTypes.find((e) => e.slug.toLowerCase() === wanted);
  if (!eventType) throw new HttpError(404, 'not_found', 'This meeting type does not exist.');

  const durationMin = Number(p.durationMin);
  const base = { durationMin, hostTimezone: s.ownerTimezone };
  if (eventType.active !== true) return { slots: [], ...base, unavailableReason: 'inactive' };

  let moving: Booking | null = null;
  if (p.rescheduleBookingId) {
    const found = await getBooking(ctx, p.rescheduleBookingId);
    if (found && found.eventTypeId === eventType.id && found.status === 'confirmed') moving = found;
  }
  const plan = planFor(eventType, moving, s.byId);

  if (!Number.isFinite(durationMin) || !(plan.eventType.durations ?? []).includes(durationMin)) {
    throw new HttpError(422, 'invalid', 'That meeting length is not offered.', { duration: 'Please choose one of the offered lengths.' });
  }
  if (!Number.isFinite(p.fromMs) || !Number.isFinite(p.toMs)) {
    throw new HttpError(422, 'invalid', 'A valid date range is needed.', { from: 'Not a valid date.' });
  }

  const nowMs = ctx.now().getTime();
  const maxDays = eventType.scheduling?.maxDaysAhead;
  const horizon = Number.isFinite(maxDays) ? nowMs + (Math.max(0, maxDays) + 1) * DAY_MS : Number.POSITIVE_INFINITY;
  const from = Math.max(Math.floor(p.fromMs), nowMs);
  const to = Math.min(Math.ceil(p.toMs), from + MAX_SLOT_RANGE_MS, horizon);
  if (!(to > from) || plan.hosts.length === 0) return { slots: [], ...base };

  // Whole UTC days, so every visitor looking at the same stretch shares one cached calendar answer.
  const pad = bufferPadMs(eventType);
  const busyRange: Interval = {
    start: floorTo(from - pad, DAY_MS),
    end: floorTo(to + durationMin * MINUTE_MS + pad, DAY_MS) + DAY_MS,
  };
  const external = await loadExternalBusy(ctx, eventType.kind, plan.hosts, busyRange, false);
  if (external.blocked) return { slots: [], ...base, unavailableReason: 'calendar_error' };

  const query: SlotQuery = {
    eventType: plan.eventType,
    durationMin,
    hosts: external.inputs,
    ownerTimezone: s.ownerTimezone,
    range: { start: from, end: to },
    nowMs,
    index: await getBookingIndex(ctx),
    ownBookingBuffers: s.buffers,
  };
  if (moving) query.ignoreBookingId = moving.id;
  const slots = computeSlots(query);
  return { slots: slots.map((slot) => ({ start: new Date(slot.startMs).toISOString() })), ...base };
}

/**
 * The event type and hosts a slot check runs against. A new booking uses the event type as it is. A
 * booking being moved keeps the hosts it already has (a round robin does not hand the meeting to a
 * colleague, a collective keeps its people) and the length it was booked with.
 */
function planFor(eventType: EventType, moving: Booking | null, byId: Map<string, Host>): { eventType: EventType; hosts: Host[] } {
  if (!moving) return { eventType, hosts: pickHosts(eventType.hostIds, byId) };
  const kept = pickHosts(moving.hostIds, byId);
  const hosts = kept.length > 0 ? kept : pickHosts(eventType.hostIds, byId);
  const offered = eventType.durations ?? [];
  const durations = offered.includes(moving.durationMin) ? offered : [...offered, moving.durationMin];
  return { eventType: { ...eventType, hostIds: hosts.map((h) => h.id), durations }, hosts };
}

// ───────────────────────── reading a booking request ─────────────────────────

/** Trims, and lower-cases the domain. The part before the @ is left as typed: it can be case sensitive. */
function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 400) return '';
  const text = raw.normalize('NFKC').trim();
  const at = text.lastIndexOf('@');
  if (at < 1) return text;
  return `${text.slice(0, at)}@${text.slice(at + 1).toLowerCase()}`;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && v.trim() === '');
}

function looksLikeLink(text: string): boolean {
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  if (/\s/.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** One stored answer per question that was answered. Problems are recorded under "answers.<question id>". */
function readAnswers(raw: unknown, questions: Question[], errors: FieldErrors): Booking['answers'] {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) errors.add('answers', 'The answers could not be read.');
  const given: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const out: Booking['answers'] = [];

  for (const q of questions.slice(0, MAX_QUESTIONS)) {
    const key = `answers.${q.id}`;
    const v = Object.prototype.hasOwnProperty.call(given, q.id) ? given[q.id] : undefined;
    const options = (q.options ?? []).filter((o) => typeof o === 'string' && o.trim() !== '');
    const choice = (q.type === 'select' || q.type === 'radio') && options.length > 0;
    const multi = q.type === 'checkbox' && options.length > 0;
    const tick = q.type === 'checkbox' && options.length === 0;
    let value = '';

    if (isEmpty(v)) {
      if (q.required) {
        errors.add(key, tick ? 'Please tick this box to continue.' : choice ? 'Please choose an option.' : multi ? 'Please choose at least one.' : 'Please answer this question.');
      }
      continue;
    }

    if (tick) {
      if (v !== true) {
        errors.add(key, 'That answer could not be read.');
        continue;
      }
      value = 'Yes';
    } else if (multi) {
      const picked = Array.isArray(v) ? v : [v];
      if (picked.length > options.length || !picked.every((item) => typeof item === 'string' && options.includes(item))) {
        errors.add(key, 'Please choose from the options shown.');
        continue;
      }
      value = [...new Set(picked as string[])].join(', ');
    } else if (choice) {
      if (typeof v !== 'string' || !options.includes(v)) {
        errors.add(key, 'Please choose one of the options shown.');
        continue;
      }
      value = v.trim();
    } else {
      const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
      if (typeof text !== 'string') {
        errors.add(key, 'That answer could not be read.');
        continue;
      }
      const max = q.type === 'textarea' ? MAX_ANSWER_LONG : MAX_ANSWER_SHORT;
      if (text.length > max) {
        errors.add(key, `That is a little long. Please keep it under ${max.toLocaleString('en-US')} characters.`);
        continue;
      }
      value = q.type === 'textarea' ? cleanText(text, max) : cleanLine(text, max);
      if (q.type === 'number' && !/^-?\d+(?:[.,]\d+)?$/.test(value)) {
        errors.add(key, 'Please enter a number.');
        continue;
      }
      if (q.type === 'url' && !looksLikeLink(value)) {
        errors.add(key, 'Please enter a link, like https://example.com');
        continue;
      }
      if (value === '') {
        if (q.required) errors.add(key, 'Please answer this question.');
        continue;
      }
    }
    out.push({ questionId: q.id, label: cleanLine(q.label, 300), value });
  }
  return out;
}

function readGuests(raw: unknown, eventType: EventType, inviteeEmail: string, errors: FieldErrors): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.add('guests', 'The guest list could not be read.');
    return [];
  }
  if (raw.length > MAX_GUESTS * 2) {
    errors.add('guests', 'That is too many guests.');
    return [];
  }
  const seen = new Set<string>([inviteeEmail.toLowerCase()]);
  const guests: string[] = [];
  for (const item of raw) {
    if (isEmpty(item)) continue;
    const email = normalizeEmail(item);
    if (email.length > MAX_EMAIL || !isEmail(email)) {
      errors.add('guests', 'One of the guest emails does not look right.');
      return [];
    }
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    guests.push(email);
  }
  if (guests.length === 0) return [];
  const allowed = eventType.allowGuests === true ? Math.max(0, Math.min(MAX_GUESTS, Math.trunc(positive(eventType.maxGuests)))) : 0;
  if (allowed === 0) {
    errors.add('guests', 'Guests cannot be added to this meeting.');
    return [];
  }
  if (guests.length > allowed) {
    errors.add('guests', allowed === 1 ? 'You can add one guest.' : `You can add up to ${allowed} guests.`);
    return [];
  }
  return guests;
}

function readUtm(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_UTM_KEYS) break;
    if (!/^utm_[a-z0-9_]{1,30}$/.test(key) || typeof value !== 'string') continue;
    const clean = cleanLine(value, MAX_UTM_VALUE);
    if (clean === '') continue;
    out[key] = clean;
    count++;
  }
  return count > 0 ? out : undefined;
}

function readLocale(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(text) ? text : undefined;
}

function locationFor(config: LocationConfig, p: { leadFirstName: string; phone?: string; text: string }): BookingLocation {
  const custom = cleanLine(config.label, 80);
  const value = cleanLine(config.value, 500);
  switch (config.type) {
    case 'google_meet':
      // The link is added once Google has created the meeting.
      return { type: 'google_meet', label: custom || LOCATION_LABELS.google_meet };
    case 'phone_host_calls': {
      const who = p.leadFirstName || 'Your host';
      return { type: 'phone_host_calls', label: custom || LOCATION_LABELS.phone_host_calls, value: p.phone ? `${who} will call ${p.phone}` : `${who} will call` };
    }
    case 'phone_invitee_calls':
      return value
        ? { type: 'phone_invitee_calls', label: custom || LOCATION_LABELS.phone_invitee_calls, value }
        : { type: 'phone_invitee_calls', label: custom || LOCATION_LABELS.phone_invitee_calls };
    case 'in_person':
      return value ? { type: 'in_person', label: custom || LOCATION_LABELS.in_person, value } : { type: 'in_person', label: custom || LOCATION_LABELS.in_person };
    case 'custom_link': {
      const out: BookingLocation = { type: 'custom_link', label: custom || LOCATION_LABELS.custom_link };
      if (value) out.value = value;
      if (/^https?:\/\/\S+$/i.test(value)) out.joinUrl = value;
      return out;
    }
    default:
      return { type: 'ask_invitee', label: custom || LOCATION_LABELS.ask_invitee, value: p.text };
  }
}

interface BookingInput {
  startMs: number;
  durationMin: number;
  name: string;
  email: string;
  phone?: string;
  timezone: IanaZone;
  locale?: string;
  guests: string[];
  answers: Booking['answers'];
  locationConfig: LocationConfig;
  locationText: string;
  wantsSms: boolean;
  wantsCall: boolean;
  source: 'page' | 'embed';
  utm?: Record<string, string>;
}

/** Every field of a booking request, cleaned. Throws one 422 that lists all problems by field. */
function readBookingInput(raw: Record<string, unknown>, eventType: EventType, leadFirstName: string): BookingInput {
  const errors = new FieldErrors();

  const nameRaw = typeof raw.name === 'string' ? raw.name : '';
  const name = cleanLine(nameRaw, MAX_NAME + 1);
  if (name === '') errors.add('name', 'Please enter your name.');
  else if (name.length < 2) errors.add('name', 'Please enter your full name.');
  else if (name.length > MAX_NAME) errors.add('name', `Please keep your name under ${MAX_NAME} characters.`);

  const email = normalizeEmail(raw.email);
  if (email === '') errors.add('email', 'Please enter your email address.');
  else if (email.length > MAX_EMAIL || !isEmail(email)) errors.add('email', 'Please enter a valid email address.');

  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  if (!isZone(timezone)) errors.add('timezone', 'We could not read your time zone. Please choose it again.');

  let startMs = NaN;
  if (isIsoInstant(raw.start)) startMs = Date.parse(raw.start);
  if (!Number.isFinite(startMs)) errors.add('start', 'Please pick a time.');

  const durationMin = typeof raw.durationMin === 'number' ? raw.durationMin : NaN;
  if (!Number.isInteger(durationMin) || !(eventType.durations ?? []).includes(durationMin)) errors.add('durationMin', 'Please choose one of the offered lengths.');

  const locations = locationsOf(eventType);
  let locationIndex = 0;
  if (raw.locationIndex !== undefined && raw.locationIndex !== null) {
    locationIndex = typeof raw.locationIndex === 'number' ? raw.locationIndex : NaN;
    if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex >= locations.length) {
      errors.add('locationIndex', 'Please choose where to meet.');
      locationIndex = 0;
    }
  }
  const locationConfig = locations[locationIndex];

  let locationText = '';
  if (locationConfig.type === 'ask_invitee') {
    const text = typeof raw.locationText === 'string' ? raw.locationText : '';
    if (text.length > MAX_LOCATION_TEXT * 2) errors.add('locationText', `Please keep this under ${MAX_LOCATION_TEXT} characters.`);
    else {
      locationText = cleanLine(text, MAX_LOCATION_TEXT + 1);
      if (locationText === '') errors.add('locationText', 'Please tell us where you would like to meet.');
      else if (locationText.length > MAX_LOCATION_TEXT) errors.add('locationText', `Please keep this under ${MAX_LOCATION_TEXT} characters.`);
    }
  }

  // The number is only kept when this meeting asks for one.
  const phoneNeeded = eventType.phone === 'required' || locationConfig.type === 'phone_host_calls';
  const phoneAsked = eventType.phone !== 'hidden' || phoneNeeded;
  let phone: string | undefined;
  if (phoneAsked) {
    if (raw.phone !== undefined && raw.phone !== null && typeof raw.phone !== 'string') {
      errors.add('phone', 'That number does not look right. Check the country code and digits.');
    } else {
      const typed = typeof raw.phone === 'string' ? raw.phone.trim() : '';
      if (typed === '') {
        if (phoneNeeded) {
          errors.add('phone', locationConfig.type === 'phone_host_calls' ? `${leadFirstName || 'Your host'} needs a number to call you on.` : 'Please enter your phone number.');
        }
      } else {
        const e164 = typed.length <= 40 ? normalizePhone(typed) : null;
        if (!e164) errors.add('phone', 'That number does not look right. Check the country code and digits.');
        else phone = e164;
      }
    }
  }

  const guests = readGuests(raw.guests, eventType, email, errors);
  const answers = readAnswers(raw.answers, eventType.questions ?? [], errors);

  errors.throwIfAny();

  const consent = isPlainObject(raw.consent) ? raw.consent : {};
  const input: BookingInput = {
    startMs,
    durationMin,
    name,
    email,
    timezone,
    guests,
    answers,
    locationConfig,
    locationText,
    wantsSms: !!phone && consent.sms === true,
    wantsCall: !!phone && consent.call === true,
    source: raw.source === 'embed' ? 'embed' : 'page',
  };
  if (phone) input.phone = phone;
  const locale = readLocale(raw.locale);
  if (locale) input.locale = locale;
  const utm = readUtm(raw.utm);
  if (utm) input.utm = utm;
  return input;
}

function clientAddress(ctx: Ctx): { id: string; factor: number } {
  const ip = typeof ctx.ip === 'string' ? ctx.ip.trim() : '';
  return ip !== '' ? { id: ip, factor: 1 } : { id: 'unknown', factor: UNKNOWN_IP_FACTOR };
}

// ───────────────────────── create ─────────────────────────

export interface BookingActionOptions {
  /** how long to wait for Google to take the event before answering (default: up to 7 s). The work then finishes in the background. */
  calendarBudgetMs?: number;
  /** how long to wait for the hosts' calendars to report their busy time (default 6 s). After that the request fails closed. */
  calendarReadBudgetMs?: number;
}

/** What is left of a request's time for the calendar write: at most 7 s, less when the earlier steps were slow, never under 1 s. */
export function calendarWriteBudget(elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.max(MIN_CALENDAR_BUDGET_MS, Math.min(CALENDAR_BUDGET_MS, REQUEST_BUDGET_MS - elapsed));
}

function calendarBudget(ctx: Ctx, startedMs: number, opts?: BookingActionOptions): number {
  if (typeof opts?.calendarBudgetMs === 'number' && opts.calendarBudgetMs >= 0) return opts.calendarBudgetMs;
  return calendarWriteBudget(ctx.now().getTime() - startedMs);
}

export async function createBooking(ctx: Ctx, req: CreateBookingRequest, opts?: BookingActionOptions): Promise<{ booking: Booking; manageToken: string }> {
  registerBookingJobHandlers();
  const startedMs = ctx.now().getTime();
  const client = clientAddress(ctx);
  await rateLimit(ctx, 'book-ip', client.id, BOOKINGS_PER_IP_PER_HOUR * client.factor, HOUR_SEC);

  const raw: Record<string, unknown> = isPlainObject(req) ? (req as unknown as Record<string, unknown>) : {};
  // Bots fill every field and submit at once. They get the same answer whatever tripped them.
  const trapped = !isEmpty(raw.website);
  const tooFast = raw.elapsedMs !== undefined && raw.elapsedMs !== null && !(typeof raw.elapsedMs === 'number' && raw.elapsedMs >= MIN_FORM_MS);
  if (trapped || tooFast) throw new HttpError(422, 'invalid', GENERIC_REFUSAL);

  const s = await loadScheduling(ctx);
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  const eventType = slug === '' ? undefined : s.eventTypes.find((e) => e.slug.toLowerCase() === slug);
  if (!eventType || eventType.active !== true) throw new HttpError(404, 'not_found', 'This meeting type is no longer available.');

  const eventHosts = pickHosts(eventType.hostIds, s.byId);
  const input = readBookingInput(raw, eventType, firstName(eventHosts[0]?.name ?? ''));
  await rateLimit(ctx, 'book-email', input.email.toLowerCase(), BOOKINGS_PER_EMAIL_PER_HOUR, HOUR_SEC);

  const nowMs = ctx.now().getTime();
  const startMs = input.startMs;
  const endMs = startMs + input.durationMin * MINUTE_MS;
  if (eventHosts.length === 0) throw slotTaken('outside_hours');

  // Step 2: what the hosts' own calendars say right now. Unknown is never read as free.
  const pad = Math.max(DAY_MS, bufferPadMs(eventType));
  const external = await loadExternalBusy(ctx, eventType.kind, eventHosts, { start: startMs - pad, end: endMs + pad }, true, opts?.calendarReadBudgetMs);
  if (external.failed.length > 0) {
    await quietly(ctx, 'the calendar alert', '', () => alertCalendarTrouble(ctx, external.failed, { eventTitle: eventType.title }));
  }
  if (external.blocked) throw calendarUnavailable();

  // Step 3: is the time free?
  const query: SlotQuery = {
    eventType,
    durationMin: input.durationMin,
    hosts: external.inputs,
    ownerTimezone: s.ownerTimezone,
    range: { start: startMs, end: startMs + 1 },
    nowMs,
    index: await getBookingIndex(ctx),
    ownBookingBuffers: s.buffers,
  };
  const first = checkSlot(query, startMs);
  if (!first.ok) throw slotTaken(first.reason);

  // Everything the record needs is read before the time is taken, so nothing sits between the two writes below.
  const features = await twilioFeatures(ctx).catch(() => ({ sms: false, calls: false }));

  // Step 4: take it. The check runs again inside the swap, on the index as it is at that instant.
  const id = randomId('bkg');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  let assigned: string[] = [];
  const taken = await mutateBookingIndex(ctx, (entries) => {
    const again = checkSlot({ ...query, index: entries }, startMs);
    if (!again.ok) return { abort: again.reason };
    assigned = eventType.kind === 'round_robin' ? [pickRoundRobinHost(again.hostIds, entries, nowMs)] : [...again.hostIds];
    const entry: BookingIndexEntry = {
      id,
      start: startIso,
      end: endIso,
      hostIds: [...assigned],
      eventTypeId: eventType.id,
      status: 'confirmed',
      inviteeName: input.name,
      inviteeEmail: input.email,
      eventTitle: eventType.title,
    };
    return [...entries, entry];
  });
  if (!taken.ok) {
    if (taken.reason === 'contention') throw new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
    throw slotTaken(taken.reason as SlotRejection);
  }

  // Step 5: the booking itself.
  const assignedHosts = pickHosts(assigned, s.byId);
  const sms = input.wantsSms && features.sms;
  const call = input.wantsCall && features.calls;
  const consentHost = eventHosts[0] ?? ownerOf(s.site, s.hosts);
  const consentText =
    sms || call
      ? renderTemplate(s.site.booking?.consentText ?? '', {
          host_first_name: firstName(consentHost?.name ?? s.site.profile.name),
          host_name: consentHost?.name ?? s.site.profile.name,
          assistant_name: s.site.assistant?.name ?? '',
          site_name: s.site.profile.name,
          event_name: eventType.title,
        }).trim()
      : '';
  const at = nowIso(ctx);
  const invitee: Booking['invitee'] = { name: input.name, email: input.email, timezone: input.timezone };
  if (input.phone) invitee.phone = input.phone;
  if (input.locale) invitee.locale = input.locale;
  const record: Booking = {
    id,
    eventTypeId: eventType.id,
    eventSlug: eventType.slug,
    eventTitle: eventType.title,
    kind: eventType.kind,
    hostIds: [...assigned],
    start: startIso,
    end: endIso,
    durationMin: input.durationMin,
    status: 'confirmed',
    invitee,
    guests: input.guests,
    answers: input.answers,
    location: locationFor(input.locationConfig, { leadFirstName: firstName(assignedHosts[0]?.name ?? ''), phone: input.phone, text: input.locationText }),
    consent: { sms, call, at, text: consentText },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: input.source,
    timeline: [{ at, type: 'created', detail: input.source === 'embed' ? 'Booked through an embedded page' : 'Booked from the booking page' }],
    createdAt: at,
    updatedAt: at,
  };
  if (input.utm) record.utm = input.utm;

  try {
    await saveBooking(ctx, record);
  } catch (err) {
    // Without the record the time would stay blocked for nobody: give it back before reporting the failure.
    await quietly(ctx, 'releasing the time of a booking that could not be saved', id, () =>
      mutateBookingIndex(ctx, (entries) => entries.filter((e) => e.id !== id)),
    );
    throw err;
  }

  // Step 6: the calendar. From here on nothing may fail the request: the booking exists.
  const calendar = await calendarStep(ctx, id, 'reconcile', calendarBudget(ctx, startedMs, opts));

  // Step 7: confirmation and reminders.
  const current = (await getBooking(ctx, id).catch(() => null)) ?? record;
  const scheduled = await quietly(ctx, 'scheduling the messages', id, () => scheduleBookingJobs(ctx, current, eventType, 'created'));
  if (!scheduled) {
    // Storage hiccup: one more try, then the booking stands without its messages and says so.
    const retried = await quietly(ctx, 'scheduling the messages again', id, () => scheduleBookingJobs(ctx, current, eventType, 'created'));
    if (!retried) await quietly(ctx, 'the timeline note', id, () => addTimeline(ctx, id, 'messages_not_scheduled', 'The confirmation and reminders could not be queued.'));
  }
  runImmediateJobs(ctx, id, calendar.pending);

  return { booking: (await getBooking(ctx, id).catch(() => null)) ?? current, manageToken: manageToken(ctx, id) };
}

async function addTimeline(ctx: Ctx, bookingId: string, type: string, detail?: string): Promise<void> {
  const entry = { at: nowIso(ctx), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) };
  await updateBooking(ctx, bookingId, (b) => ({ ...b, timeline: [...(b.timeline ?? []), entry] }));
}

// ───────────────────────── cancel ─────────────────────────

const CANCELLED_BY: Record<'invitee' | 'host' | 'assistant', string> = {
  invitee: 'Cancelled by the invitee',
  host: 'Cancelled by the host',
  assistant: 'Cancelled by the invitee on the reminder call',
};

/**
 * Cancels a booking. Calling it again changes nothing and sends nothing. The invitee can cancel until
 * the meeting starts and the assistant (acting for the invitee on a call) until it ends; a host always can.
 * Whoever calls this has already checked the manage token or the admin session.
 */
export async function cancelBooking(
  ctx: Ctx,
  bookingId: string,
  p: { by: 'invitee' | 'host' | 'assistant'; reason?: string },
  opts?: BookingActionOptions,
): Promise<Booking> {
  registerBookingJobHandlers();
  const nowMs = ctx.now().getTime();
  const existing = await getBooking(ctx, bookingId);
  if (!existing) throw notFound();
  if (existing.status === 'cancelled') return existing;

  const by = p.by === 'host' || p.by === 'assistant' ? p.by : 'invitee';
  const deadline = by === 'invitee' ? Date.parse(existing.start) : by === 'assistant' ? Date.parse(existing.end) : Number.POSITIVE_INFINITY;
  if (!(nowMs < deadline)) {
    throw new HttpError(
      410,
      'too_late',
      by === 'assistant' ? 'This meeting is already over, so it can no longer be cancelled.' : 'This meeting has already started, so it can no longer be cancelled here.',
    );
  }

  const at = nowIso(ctx);
  const reason = cleanText(p.reason, MAX_REASON);
  let changed = false;
  const saved = await updateBooking(ctx, bookingId, (b) => {
    if (b.status === 'cancelled') {
      changed = false;
      return b;
    }
    changed = true;
    return {
      ...b,
      status: 'cancelled',
      cancellation: reason ? { at, by, reason } : { at, by },
      timeline: [...(b.timeline ?? []), { at, type: 'cancelled', detail: reason ? `${CANCELLED_BY[by]}: ${reason}`.slice(0, 400) : CANCELLED_BY[by] }],
    };
  });
  if (!saved) throw notFound();
  // Someone else cancelled it a moment ago: they do the follow-up work, once.
  if (!changed) return saved;

  // The record says cancelled. Only now is the time given back.
  await quietly(ctx, 'freeing the time of a cancelled booking', bookingId, async () => {
    const freed = await mutateBookingIndex(ctx, (entries) => entries.map((e) => (e.id === bookingId ? { ...e, status: 'cancelled' as const } : e)));
    if (!freed.ok) throw new Error(`index update failed (${freed.reason})`);
  });

  if (saved.google) await calendarStep(ctx, bookingId, 'push', calendarBudget(ctx, nowMs, opts));
  await quietly(ctx, 'removing the reminders of a cancelled booking', bookingId, () => cancelBookingJobs(ctx, bookingId));
  await quietly(ctx, 'queueing the cancellation messages', bookingId, () => queueCancelledMessages(ctx, saved, by));
  runImmediateJobs(ctx, bookingId);

  return (await getBooking(ctx, bookingId).catch(() => null)) ?? saved;
}

async function queueCancelledMessages(ctx: Ctx, booking: Booking, by: 'invitee' | 'host' | 'assistant'): Promise<void> {
  const site = await getSite(ctx);
  const assigned = pickHosts(booking.hostIds, hostsById(await listHosts(ctx)));
  const base = { type: 'message' as const, kind: 'cancelled' as const, bookingId: booking.id, dueAt: nowIso(ctx) };
  const work: Promise<unknown>[] = [];

  if (isEmail(booking.invitee.email)) work.push(enqueueJob(ctx, { ...base, channel: 'email', audience: 'invitee' }));
  // Someone who cancelled on the page a second ago does not need a text about it as well.
  if (by !== 'invitee' && booking.invitee.phone && booking.consent?.sms === true) work.push(enqueueJob(ctx, { ...base, channel: 'sms', audience: 'invitee' }));

  for (const host of assigned) {
    // The dashboard belongs to the owner: when a host cancels there, the owner already knows.
    if (by === 'host' && host.id === site.ownerHostId) continue;
    if (isEmail(host.email) && host.notify?.email !== false) work.push(enqueueJob(ctx, { ...base, channel: 'email', audience: 'host', hostId: host.id }));
    if (host.phone?.trim() && host.notify?.sms === true) work.push(enqueueJob(ctx, { ...base, channel: 'sms', audience: 'host', hostId: host.id }));
  }
  const failed = (await Promise.allSettled(work)).find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
}

// ───────────────────────── reschedule ─────────────────────────

/**
 * Moves a booking to a new start time, keeping its length and its hosts. The same checks as a new
 * booking apply, except that the booking's own time counts as free. The invitee can move a meeting
 * until it starts. Whoever calls this has already checked the manage token or the admin session.
 */
export async function rescheduleBooking(
  ctx: Ctx,
  bookingId: string,
  p: { startIso: string; by: 'invitee' | 'host'; timezone?: IanaZone },
  opts?: BookingActionOptions,
): Promise<Booking> {
  registerBookingJobHandlers();
  const booking = await getBooking(ctx, bookingId);
  if (!booking) throw notFound();
  if (booking.status !== 'confirmed') throw new HttpError(410, 'cancelled', 'This booking was cancelled, so it cannot be moved. Please book a new time.');

  const nowMs = ctx.now().getTime();
  const by = p.by === 'host' ? 'host' : 'invitee';
  if (by === 'invitee' && !(Date.parse(booking.start) > nowMs)) {
    throw new HttpError(410, 'too_late', 'This meeting has already started, so it can no longer be moved.');
  }
  if (!isIsoInstant(p.startIso)) throw new HttpError(422, 'invalid', 'Please pick a new time.', { start: 'Please pick a time.' });
  const startMs = Date.parse(p.startIso);
  const endMs = startMs + booking.durationMin * MINUTE_MS;
  if (startMs === Date.parse(booking.start)) {
    throw new HttpError(422, 'invalid', 'That is the time you already have. Pick a different one to move your meeting.', { start: 'This is your current time.' });
  }

  const s = await loadScheduling(ctx);
  const eventType = s.eventTypes.find((e) => e.id === booking.eventTypeId) ?? null;
  if (!eventType || eventType.active !== true) {
    throw new HttpError(410, 'not_available', 'This meeting type is not taking bookings right now, so the meeting cannot be moved here. Please get in touch with your host.');
  }
  const plan = planFor(eventType, booking, s.byId);
  if (plan.hosts.length === 0) throw slotTaken('outside_hours');

  const pad = Math.max(DAY_MS, bufferPadMs(eventType));
  const external = await loadExternalBusy(ctx, plan.eventType.kind, plan.hosts, { start: startMs - pad, end: endMs + pad }, true, opts?.calendarReadBudgetMs);
  if (external.failed.length > 0) {
    await quietly(ctx, 'the calendar alert', bookingId, () => alertCalendarTrouble(ctx, external.failed, { eventTitle: eventType.title }));
  }
  if (external.blocked) throw calendarUnavailable();

  const query: SlotQuery = {
    eventType: plan.eventType,
    durationMin: booking.durationMin,
    hosts: external.inputs,
    ownerTimezone: s.ownerTimezone,
    range: { start: startMs, end: startMs + 1 },
    nowMs,
    index: await getBookingIndex(ctx),
    ignoreBookingId: booking.id,
    ownBookingBuffers: s.buffers,
  };
  const first = checkSlot(query, startMs);
  if (!first.ok) throw slotTaken(first.reason);

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const seen = query.index.find((e) => e.id === booking.id) ?? null;
  let assigned: string[] = [];

  // The index is the commit point. It only moves an entry that is still where this request found it,
  // so two moves of the same booking, or a move racing a cancellation, cannot both go through.
  const moved = await mutateBookingIndex(ctx, (entries) => {
    const mine = entries.find((e) => e.id === booking.id) ?? null;
    if (mine && mine.status !== 'confirmed') return { abort: 'cancelled' };
    if (!!mine !== !!seen || (mine && seen && (mine.start !== seen.start || mine.end !== seen.end))) return { abort: 'changed' };
    const again = checkSlot({ ...query, index: entries }, startMs);
    if (!again.ok) return { abort: again.reason };
    assigned = plan.eventType.kind === 'round_robin' ? [pickRoundRobinHost(again.hostIds, entries.filter((e) => e.id !== booking.id), nowMs)] : [...again.hostIds];
    const entry: BookingIndexEntry = {
      id: booking.id,
      start: startIso,
      end: endIso,
      hostIds: [...assigned],
      eventTypeId: booking.eventTypeId,
      status: 'confirmed',
      inviteeName: booking.invitee.name,
      inviteeEmail: booking.invitee.email,
      eventTitle: booking.eventTitle,
    };
    return mine ? entries.map((e) => (e.id === booking.id ? entry : e)) : [...entries, entry];
  });
  if (!moved.ok) {
    if (moved.reason === 'contention') throw new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
    if (moved.reason === 'cancelled') throw new HttpError(410, 'cancelled', 'This booking was cancelled, so it cannot be moved. Please book a new time.');
    if (moved.reason === 'changed') throw new HttpError(409, 'changed', 'This booking was just changed somewhere else. Reload the page to see where it stands.');
    throw slotTaken(moved.reason as SlotRejection);
  }

  const at = nowIso(ctx);
  const timezone = typeof p.timezone === 'string' && isZone(p.timezone.trim()) ? p.timezone.trim() : null;
  const movedFrom = `Moved from ${formatInZone(Date.parse(booking.start), s.ownerTimezone, 'full')} by the ${by === 'host' ? 'host' : 'invitee'}`;
  let applied = false;
  let saved: Booking | null = null;
  try {
    saved = await updateBooking(ctx, bookingId, (b) => {
      if (b.status !== 'confirmed') {
        applied = false;
        return b;
      }
      applied = true;
      return {
        ...b,
        start: startIso,
        end: endIso,
        hostIds: [...assigned],
        invitee: timezone ? { ...b.invitee, timezone } : b.invitee,
        rescheduledFromStart: b.start,
        rescheduleCount: (b.rescheduleCount ?? 0) + 1,
        attendance: {},
        timeline: [...(b.timeline ?? []), { at, type: 'rescheduled', detail: movedFrom }],
      };
    });
  } catch (err) {
    // The index already holds the new time, so no time is unprotected. reconcileBookings finishes the move.
    ctx.log('error', 'booking: the record of a moved booking could not be saved', { bookingId, error: shortError(err) });
    throw err;
  }
  if (!saved) throw notFound();
  if (!applied) {
    // Cancelled while this request was running. Put the (cancelled) entry back where it was.
    const back = seen ?? { start: booking.start, end: booking.end, hostIds: booking.hostIds };
    await quietly(ctx, 'restoring the index entry of a cancelled booking', bookingId, () =>
      mutateBookingIndex(ctx, (entries) => entries.map((e) => (e.id === bookingId ? { ...e, start: back.start, end: back.end, hostIds: [...back.hostIds] } : e))),
    );
    throw new HttpError(410, 'cancelled', 'This booking was cancelled, so it cannot be moved. Please book a new time.');
  }

  const calendar = await calendarStep(ctx, bookingId, 'push', calendarBudget(ctx, nowMs, opts));
  const current = (await getBooking(ctx, bookingId).catch(() => null)) ?? saved;
  await quietly(ctx, 'rescheduling the messages', bookingId, () => scheduleBookingJobs(ctx, current, eventType, 'rescheduled'));
  runImmediateJobs(ctx, bookingId, calendar.pending);
  return (await getBooking(ctx, bookingId).catch(() => null)) ?? current;
}

// ───────────────────────── attendance ─────────────────────────

const CONFIRMED_VIA: Record<'call' | 'sms' | 'link', string> = {
  call: 'Confirmed on the reminder call',
  sms: 'Confirmed by text message',
  link: 'Confirmed from the booking page',
};

/** Records that the invitee said they are coming. The first confirmation stands; later ones change nothing. */
export async function confirmAttendance(ctx: Ctx, bookingId: string, via: 'call' | 'sms' | 'link'): Promise<Booking> {
  const existing = await getBooking(ctx, bookingId);
  if (!existing) throw notFound();
  if (existing.status !== 'confirmed') throw new HttpError(410, 'cancelled', 'This booking was cancelled.');
  if (existing.attendance?.confirmedAt) return existing;
  if (!(Date.parse(existing.end) > ctx.now().getTime())) throw new HttpError(410, 'too_late', 'This meeting has already taken place.');

  const how = via === 'call' || via === 'sms' ? via : 'link';
  const at = nowIso(ctx);
  const saved = await updateBooking(ctx, bookingId, (b) => {
    if (b.status !== 'confirmed' || b.attendance?.confirmedAt) return b;
    return {
      ...b,
      attendance: { ...b.attendance, confirmedAt: at, confirmedVia: how },
      timeline: [...(b.timeline ?? []), { at, type: 'attendance_confirmed', detail: CONFIRMED_VIA[how] }],
    };
  });
  if (!saved) throw notFound();
  if (saved.status !== 'confirmed') throw new HttpError(410, 'cancelled', 'This booking was cancelled.');
  return saved;
}

// ───────────────────────── Google Calendar ─────────────────────────

type SyncMode = 'push' | 'reconcile';

interface SyncOutcome {
  /** synced: Google was changed. unchanged: it already matched. skipped: nothing can or needs to be done. */
  status: 'synced' | 'unchanged' | 'skipped' | 'failed';
  error?: string;
  /** false when trying again cannot help until a person acts (reconnect) */
  retry?: boolean;
}

/**
 * Id of the Google event of a booking. Mirrors eventIdForBooking in google.ts (which keeps it private):
 * it lets a cancellation remove an event whose creation timed out before its id could be stored.
 */
export function calendarEventIdFor(bookingId: string): string {
  return `mtg${sha256Hex(bookingId).slice(0, 40)}`;
}

function usable(host: Host | null | undefined): host is Host {
  return !!host?.google && host.google.status === 'ok';
}

/** The first assigned host with a working Google connection, the owner first. */
function chooseOrganizer(booking: Booking, byId: Map<string, Host>, site: SiteSettings): Host | null {
  const assigned = pickHosts(booking.hostIds, byId);
  const owner = assigned.find((h) => h.id === site.ownerHostId);
  if (usable(owner)) return owner;
  return assigned.find(usable) ?? null;
}

function escapeForCalendar(text: string): string {
  // Google Calendar renders descriptions as HTML, and everything here was typed by a visitor.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function whereLine(location: BookingLocation): string {
  if (location.joinUrl) return location.joinUrl;
  const label = (location.label ?? '').trim();
  const value = (location.value ?? '').trim();
  if (location.type === 'in_person' && value) return value;
  return value && value !== label ? `${label}: ${value}` : label;
}

function calendarDescription(ctx: Ctx, booking: Booking): string {
  const lines = [`Booked by ${escapeForCalendar(booking.invitee.name)} (${escapeForCalendar(booking.invitee.email)})`];
  if (booking.invitee.phone) lines.push(`Phone: ${escapeForCalendar(booking.invitee.phone)}`);
  if (booking.guests.length > 0) lines.push(`Guests: ${escapeForCalendar(booking.guests.join(', '))}`);
  if (booking.location.type !== 'google_meet') lines.push(`Where: ${escapeForCalendar(whereLine(booking.location))}`);
  const answers = booking.answers.filter((a) => a.value.trim() !== '');
  if (answers.length > 0) {
    lines.push('');
    for (const a of answers) {
      const label = a.label.trim();
      lines.push(`${escapeForCalendar(label)}${/[?!.:]$/.test(label) ? '' : ':'} ${escapeForCalendar(a.value.trim())}`);
    }
  }
  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  lines.push('', `Reschedule or cancel: ${base}/booking/${encodeURIComponent(booking.id)}?t=${manageToken(ctx, booking.id)}`);
  return lines.join('\n');
}

function calendarEventInput(ctx: Ctx, booking: Booking, eventType: EventType | null, organizer: Host, assigned: Host[]): CalendarEventInput {
  const attendees: CalendarEventInput['attendees'] = [];
  for (const host of assigned) {
    if (host.id === organizer.id) continue;
    const email = host.google?.email || host.email;
    if (isEmail(email)) attendees.push({ email, name: host.name, accepted: true });
  }
  // The invitee and guests are only put on the event (and emailed by Google) when the event type says so.
  if (eventType?.googleInvite !== false) {
    attendees.push({ email: booking.invitee.email, name: booking.invitee.name, accepted: true });
    for (const guest of booking.guests) attendees.push({ email: guest });
  }
  const people = joinNames([booking.invitee.name, ...assigned.map((h) => h.name)]);
  const input: CalendarEventInput = {
    summary: people ? `${booking.eventTitle}: ${people}` : booking.eventTitle,
    description: calendarDescription(ctx, booking),
    startIso: booking.start,
    endIso: booking.end,
    timezone: isValidZone(organizer.timezone) ? organizer.timezone : 'UTC',
    attendees,
    createMeet: booking.location.type === 'google_meet',
    bookingId: booking.id,
    notifyAttendees: true,
  };
  if (booking.location.type !== 'google_meet') input.location = whereLine(booking.location);
  return input;
}

function describeGoogleError(err: unknown): { message: string; retry: boolean } {
  // Both error classes only carry wording written in google.ts: no tokens, no response bodies.
  if (err instanceof GoogleAuthError) return { message: err.message || CALENDAR_RECONNECT, retry: false };
  if (err instanceof GoogleApiError) return { message: err.message, retry: true };
  return { message: 'Google Calendar could not be updated.', retry: true };
}

/** Writes a calendar problem onto the booking. The timeline gets one line per distinct problem, not one per retry. */
async function noteCalendarError(ctx: Ctx, bookingId: string, organizer: Host | null, message: string, type = 'calendar_sync_failed'): Promise<void> {
  const at = nowIso(ctx);
  await updateBooking(ctx, bookingId, (b) => {
    const current = b.google ?? null;
    if (!current && !organizer) return b;
    const google: NonNullable<Booking['google']> = {
      hostId: current?.hostId ?? organizer!.id,
      calendarId: current?.calendarId ?? (organizer!.google?.writeCalendarId || 'primary'),
      eventId: current?.eventId ?? '',
      ...current,
      error: message,
    };
    const repeated = current?.error === message;
    return { ...b, google, timeline: repeated ? (b.timeline ?? []) : [...(b.timeline ?? []), { at, type, detail: message }] };
  });
}

function withoutError(google: NonNullable<Booking['google']>): NonNullable<Booking['google']> {
  const { error: _dropped, ...rest } = google;
  return rest;
}

async function failSync(ctx: Ctx, bookingId: string, organizer: Host | null, err: unknown): Promise<SyncOutcome> {
  const { message, retry } = describeGoogleError(err);
  ctx.log('warn', 'booking: Google Calendar could not be updated', { bookingId, hostId: organizer?.id, error: message });
  await noteCalendarError(ctx, bookingId, organizer, message);
  return { status: 'failed', error: message, retry };
}

/** Whether the booking moved on (cancelled, moved) while Google was being told about an older state. */
function movedOn(saved: Booking | null, synced: Booking): boolean {
  return !!saved && (saved.status !== synced.status || saved.start !== synced.start || saved.end !== synced.end);
}

async function syncOnce(ctx: Ctx, bookingId: string, mode: SyncMode): Promise<SyncOutcome & { again?: boolean }> {
  const booking = await getBooking(ctx, bookingId);
  if (!booking) return { status: 'skipped' };
  const site = await getSite(ctx);
  const [hosts, eventType] = await Promise.all([listHosts(ctx), getEventType(ctx, booking.eventTypeId)]);
  const byId = hostsById(hosts);
  const g = booking.google ?? null;
  const known = g ? (byId.get(g.hostId) ?? null) : null;
  const at = nowIso(ctx);

  // ── a cancelled booking: its event has to go ──
  if (booking.status === 'cancelled') {
    if (!g) return { status: 'skipped' };
    if (mode === 'reconcile' && !g.error) return { status: 'unchanged' };
    if (!known?.google) {
      // The organiser disconnected Google (or left). Nothing can reach that calendar any more.
      await updateBooking(ctx, bookingId, (b) =>
        b.google ? { ...b, google: withoutError(b.google), timeline: [...(b.timeline ?? []), { at, type: 'calendar_event_left', detail: 'Google Calendar is no longer connected, so the event was not removed.' }] } : b,
      );
      return { status: 'skipped' };
    }
    if (known.google.status !== 'ok') return failSync(ctx, bookingId, known, new GoogleAuthError(CALENDAR_RECONNECT));
    try {
      await googleDeleteEvent(ctx, known, g.calendarId || known.google.writeCalendarId || 'primary', g.eventId || calendarEventIdFor(booking.id), true);
    } catch (err) {
      return failSync(ctx, bookingId, known, err);
    }
    await updateBooking(ctx, bookingId, (b) =>
      b.google ? { ...b, google: { ...withoutError(b.google), syncedAt: at }, timeline: [...(b.timeline ?? []), { at, type: 'calendar_event_removed' }] } : b,
    );
    return { status: 'synced' };
  }

  // ── a confirmed booking that already has an event: keep its time right ──
  if (g?.eventId) {
    if (mode === 'reconcile' && !g.error) return { status: 'unchanged' };
    if (!known?.google) {
      await updateBooking(ctx, bookingId, (b) =>
        b.google ? { ...b, google: withoutError(b.google), timeline: [...(b.timeline ?? []), { at, type: 'calendar_not_updated', detail: 'Google Calendar is no longer connected, so the event was not changed.' }] } : b,
      );
      return { status: 'skipped' };
    }
    if (known.google.status !== 'ok') return failSync(ctx, bookingId, known, new GoogleAuthError(CALENDAR_RECONNECT));
    let gone = false;
    try {
      await googleUpdateEvent(ctx, known, g.calendarId, g.eventId, {
        startIso: booking.start,
        endIso: booking.end,
        timezone: isValidZone(known.timezone) ? known.timezone : 'UTC',
        notifyAttendees: true,
      });
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) gone = true;
      else return failSync(ctx, bookingId, known, err);
    }
    if (!gone) {
      const saved = await updateBooking(ctx, bookingId, (b) =>
        b.google ? { ...b, google: { ...withoutError(b.google), syncedAt: at }, timeline: [...(b.timeline ?? []), { at, type: 'calendar_updated' }] } : b,
      );
      return { status: 'synced', again: movedOn(saved, booking) };
    }
    // Someone deleted the event in Google. Creating it again below brings it back under the same id.
  }

  // ── a confirmed booking without an event: create it ──
  let organizer: Host | null;
  if (g && known?.google) {
    // An earlier attempt may have gone through without us hearing about it: stay on that calendar.
    if (known.google.status !== 'ok') return failSync(ctx, bookingId, known, new GoogleAuthError(CALENDAR_RECONNECT));
    organizer = known;
  } else {
    organizer = chooseOrganizer(booking, byId, site);
  }
  if (!organizer) {
    if (g?.error) await updateBooking(ctx, bookingId, (b) => (b.google ? { ...b, google: b.google.eventId ? withoutError(b.google) : null } : b));
    return { status: 'skipped' };
  }

  const input = calendarEventInput(ctx, booking, eventType, organizer, pickHosts(booking.hostIds, byId));
  let created: Awaited<ReturnType<typeof googleCreateEvent>>;
  try {
    created = await googleCreateEvent(ctx, organizer, input);
    // An event adopted from an earlier attempt still carries that attempt's time.
    if (g && (booking.rescheduleCount ?? 0) > 0) {
      await googleUpdateEvent(ctx, organizer, created.calendarId, created.eventId, {
        startIso: input.startIso,
        endIso: input.endIso,
        timezone: input.timezone,
        notifyAttendees: true,
      });
    }
  } catch (err) {
    return failSync(ctx, bookingId, organizer, err);
  }

  const organizerId = organizer.id;
  const organizerName = organizer.name;
  const saved = await updateBooking(ctx, bookingId, (b) => {
    const google: NonNullable<Booking['google']> = { hostId: organizerId, calendarId: created.calendarId, eventId: created.eventId, syncedAt: at };
    if (created.htmlLink) google.htmlLink = created.htmlLink;
    if (created.meetUrl) google.meetUrl = created.meetUrl;
    return {
      ...b,
      google,
      location: b.location.type === 'google_meet' && created.meetUrl ? { ...b.location, joinUrl: created.meetUrl } : b.location,
      timeline: [...(b.timeline ?? []), { at, type: 'calendar_synced', detail: `Added to the Google Calendar of ${organizerName}` }],
    };
  });
  return { status: 'synced', again: movedOn(saved, booking) };
}

/**
 * Makes Google Calendar match the booking. Never rejects: every outcome, problems included, is
 * returned and (for problems) written to booking.google.error.
 *   push       tell Google about the booking as it is now (after a move or a cancellation)
 *   reconcile  only act when there is something to repair: no event yet, or an earlier problem
 */
async function syncCalendar(ctx: Ctx, bookingId: string, mode: SyncMode): Promise<SyncOutcome> {
  try {
    let outcome: SyncOutcome & { again?: boolean } = { status: 'skipped' };
    for (let round = 0; round < 3; round++) {
      outcome = await syncOnce(ctx, bookingId, round === 0 ? mode : 'push');
      if (!outcome.again) break;
    }
    const { again: _again, ...result } = outcome;
    return result;
  } catch (err) {
    ctx.log('error', 'booking: calendar sync stopped unexpectedly', { bookingId, error: shortError(err) });
    return { status: 'failed', error: 'Calendar sync could not be completed.', retry: true };
  }
}

async function queueCalendarRetry(ctx: Ctx, bookingId: string, delayMs: number): Promise<void> {
  await enqueueJob(ctx, { type: 'gcal_sync', bookingId, dueAt: new Date(ctx.now().getTime() + delayMs).toISOString() });
}

async function noteCalendarPending(ctx: Ctx, bookingId: string): Promise<void> {
  const booking = await getBooking(ctx, bookingId);
  if (!booking) return;
  let organizer: Host | null = null;
  if (!booking.google) {
    const site = await getSite(ctx);
    organizer = chooseOrganizer(booking, hostsById(await listHosts(ctx)), site);
    if (!organizer) return;
  }
  await noteCalendarError(ctx, bookingId, organizer, CALENDAR_PENDING, 'calendar_sync_delayed');
}

/**
 * The calendar part of a request: waits for Google at most `budgetMs`. When Google is slower, the
 * booking is marked, a retry job is queued and the original attempt carries on in the background;
 * `pending` then resolves when that attempt has finished.
 */
async function calendarStep(ctx: Ctx, bookingId: string, mode: SyncMode, budgetMs: number): Promise<{ pending?: Promise<unknown> }> {
  const work = syncCalendar(ctx, bookingId, mode);
  const outcome = await withinBudget(work, budgetMs);
  if (outcome === TIMED_OUT) {
    ctx.log('warn', 'booking: Google Calendar is slow, finishing in the background', { bookingId });
    await quietly(ctx, 'noting the slow calendar', bookingId, () => noteCalendarPending(ctx, bookingId));
    await quietly(ctx, 'queueing the calendar retry', bookingId, () => queueCalendarRetry(ctx, bookingId, RETRY_AFTER_TIMEOUT_MS));
    const finishing = work.then(async (late) => {
      if (late.status !== 'synced' && late.status !== 'unchanged') return;
      // It went through after all: take the "did not answer in time" note off again.
      await quietly(ctx, 'clearing the slow calendar note', bookingId, () =>
        updateBooking(ctx, bookingId, (b) => (b.google?.error === CALENDAR_PENDING ? { ...b, google: withoutError(b.google) } : b)),
      );
    });
    ctx.waitUntil(finishing);
    return { pending: finishing };
  }
  if (outcome.status === 'failed') {
    // Also when a reconnect is needed: the job then finds that out for itself and steps aside.
    await quietly(ctx, 'queueing the calendar retry', bookingId, () => queueCalendarRetry(ctx, bookingId, RETRY_AFTER_FAILURE_MS));
  }
  return {};
}

/**
 * Brings Google Calendar in line with the booking: creates the event when there is none, repairs it
 * after an earlier problem, removes it when the booking is cancelled. Does nothing when no assigned
 * host has Google connected. Google trouble does not reject: it is recorded on booking.google.error.
 */
export async function syncBookingToCalendar(ctx: Ctx, bookingId: string): Promise<void> {
  await syncCalendar(ctx, bookingId, 'reconcile');
}

async function gcalSyncJob(ctx: Ctx, job: { bookingId: string }): Promise<SendResult> {
  const outcome = await syncCalendar(ctx, job.bookingId, 'reconcile');
  if (outcome.status === 'synced' || outcome.status === 'unchanged') return { ok: true, provider: 'google' };
  if (outcome.status === 'skipped') return { ok: false, provider: 'google', skipped: 'nothing_to_sync' };
  // Waiting for a person to reconnect: the periodic check queues a new attempt, so this one can go.
  if (outcome.retry === false) return { ok: false, provider: 'google', skipped: 'needs_reconnect' };
  return { ok: false, provider: 'google', error: outcome.error ?? 'Google Calendar could not be updated.' };
}

/** Registers the gcal_sync job handler. Safe to call any number of times. */
export function registerBookingJobHandlers(): void {
  registerJobHandler('gcal_sync', gcalSyncJob);
}

// ───────────────────────── reconciliation ─────────────────────────

const SUSPECTS_CACHE = 'booking-reconcile-suspects';
const SUSPECTS_TTL_SEC = 6 * HOUR_SEC;
const REQUEUE_TTL_SEC = 2 * HOUR_SEC;
const RECONCILE_READS = 16;

export interface ReconcileResult {
  checked: number;
  /** index entries without a booking record, removed */
  removed: number;
  /** times given back for bookings whose record says cancelled */
  freed: number;
  /** interrupted moves that were completed */
  moved: number;
  /** calendar repairs queued again */
  requeued: number;
}

/**
 * Heals what an interrupted request can leave behind (see the top of this file). It only ever acts in
 * the safe direction, and it only removes or moves something it has seen in the same odd state on two
 * runs, so a request that is still in flight is never disturbed.
 */
export async function reconcileBookings(ctx: Ctx, opts?: { limit?: number }): Promise<ReconcileResult> {
  registerBookingJobHandlers();
  const result: ReconcileResult = { checked: 0, removed: 0, freed: 0, moved: 0, requeued: 0 };
  const nowMs = ctx.now().getTime();
  const limit = Math.max(1, opts?.limit ?? 300);
  const entries = (await getBookingIndex(ctx))
    .filter((e) => e.status === 'confirmed' && Date.parse(e.end) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, limit);

  const records = new Array<Booking | null>(entries.length);
  let cursor = 0;
  const reader = async (): Promise<void> => {
    while (cursor < entries.length) {
      const i = cursor++;
      records[i] = await getBooking(ctx, entries[i].id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILE_READS, entries.length) }, reader));

  const before = (await cacheGet<Record<string, string>>(ctx, SUSPECTS_CACHE)) ?? {};
  const suspects: Record<string, string> = {};

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const record = records[i];
    result.checked++;

    if (!record) {
      // Created in the index, never saved: the visitor saw an error and holds nothing.
      if (before[entry.id] !== 'missing') {
        suspects[entry.id] = 'missing';
        continue;
      }
      if (await getBooking(ctx, entry.id)) continue;
      const done = await mutateBookingIndex(ctx, (list) => list.filter((e) => e.id !== entry.id));
      if (done.ok) {
        result.removed++;
        ctx.log('warn', 'booking: removed an index entry that never got its booking record', { bookingId: entry.id, start: entry.start });
      }
      continue;
    }

    if (record.status === 'cancelled') {
      const done = await mutateBookingIndex(ctx, (list) => list.map((e) => (e.id === entry.id ? { ...e, status: 'cancelled' as const } : e)));
      if (done.ok) result.freed++;
      continue;
    }

    if (record.start !== entry.start || record.end !== entry.end) {
      // The index moved and the record did not follow. The index holds the time that is protected,
      // so the move is completed rather than undone.
      const signature = `moved:${entry.start}`;
      if (before[entry.id] !== signature) {
        suspects[entry.id] = signature;
        continue;
      }
      if (await completeInterruptedMove(ctx, entry)) result.moved++;
      continue;
    }

    if (record.google?.error && !(await cacheGet(ctx, `gcal-requeue-${record.id}`))) {
      await cacheSet(ctx, `gcal-requeue-${record.id}`, { at: nowMs }, REQUEUE_TTL_SEC);
      await queueCalendarRetry(ctx, record.id, 0);
      result.requeued++;
    }
  }

  await cacheSet(ctx, SUSPECTS_CACHE, suspects, SUSPECTS_TTL_SEC);
  return result;
}

async function completeInterruptedMove(ctx: Ctx, entry: BookingIndexEntry): Promise<boolean> {
  const still = (await getBookingIndex(ctx)).find((e) => e.id === entry.id);
  if (!still || still.status !== 'confirmed' || still.start !== entry.start || still.end !== entry.end) return false;
  const at = nowIso(ctx);
  let applied = false;
  const saved = await updateBooking(ctx, entry.id, (b) => {
    if (b.status !== 'confirmed' || (b.start === entry.start && b.end === entry.end)) {
      applied = false;
      return b;
    }
    applied = true;
    return {
      ...b,
      start: entry.start,
      end: entry.end,
      hostIds: [...entry.hostIds],
      rescheduledFromStart: b.start,
      rescheduleCount: (b.rescheduleCount ?? 0) + 1,
      attendance: {},
      timeline: [...(b.timeline ?? []), { at, type: 'rescheduled', detail: `Moved from ${b.start} (finished after an interruption)` }],
    };
  });
  if (!saved || !applied) return false;
  ctx.log('warn', 'booking: completed a move that was interrupted', { bookingId: entry.id, start: entry.start });
  await calendarStep(ctx, entry.id, 'push', CALENDAR_BUDGET_MS);
  const eventType = await getEventType(ctx, saved.eventTypeId);
  if (eventType) {
    const current = (await getBooking(ctx, entry.id)) ?? saved;
    await quietly(ctx, 'rescheduling the messages', entry.id, () => scheduleBookingJobs(ctx, current, eventType, 'rescheduled'));
  }
  return true;
}

// Registered as soon as this module is loaded, wherever that happens. Inside the import cycle
// jobs > sms > booking some loaders have not bound the function yet; the routes and the scheduled
// function call registerBookingJobHandlers() again once everything is in place.
if (typeof registerJobHandler === 'function') registerBookingJobHandlers();
