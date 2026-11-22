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
 *   Never lose the work after a change. The save that commits a booking, a move or a cancellation also
 *   writes a `followUp` marker; it comes off once the calendar, the reminders and the notices are taken
 *   care of. Whatever still carries a marker after ten minutes is finished by reconcileBookings (and a
 *   repeated cancellation finishes its own at once). Each notice is claimed by name, so none goes twice.
 *
 *   Lost answers. The storage client re-sends a write whose answer got lost, and the copy then fails its
 *   own condition. The repo recognises its own writes (a rev on bookings, an owner mark on claims, the
 *   exact list on the index), and a retried booking request carries a key that makes it the same booking.
 *
 *   Fail closed on calendars. A host whose external calendar cannot be read is never treated as free.
 *
 *   Google is best effort. A slow or failing Google call never costs the booking: the problem is noted
 *   on booking.google.error and a gcal_sync job repeats the work.
 */
import { brandLine, brandOf, bookUrlFor, isBrandId, siteForBrand, viewFor, type Brand } from '../../shared/brands';
import { CALENDAR_PENDING, endedOnItsDay, testingEndedAdvice } from '../../shared/calendar';
import { smsOnlyConsentText } from '../../shared/defaults';
import { SHORT_LINKS, shortLinkTarget, shortNameFor, shortUrlOf } from '../../shared/shortLinks';
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
  ShortLinkResponse,
  ShortName,
  SiteSettings,
  SlotsResponse,
  Theme,
} from '../../shared/types';
import { getAdminAuth, rateLimit, rateLimitTake, type RateLimitHit } from './auth';
import { FEEDS_SOURCE, forgetHostBusy, getBusyForHosts, type BusyProblem } from './busy';
import { hmacHex, randomId, randomToken, safeEqual, sha256Hex } from './crypto';
import { BASE_PATH, type Ctx, type KV } from './ctx';
import { resolveEmailProvider } from './email';
import { GoogleApiError, GoogleAuthError, googleCreateEvent, googleDeleteEvent, googleGetEvent, googleGetEventLinks, googleUpdateEvent, type CalendarEventInput } from './google';
import { accountGone, accountsOf, holderCandidates, mainOf, type AccountRef } from './googleAccounts';
import { HttpError } from './http';
import { calendarEventIdFor, invitedByGoogle, settleInvite } from './invite';
import { calendarLinks } from './ics';
import { cancelBookingJobs, enqueueJob, registerJobHandler, runDueJobs, scheduleBookingJobs } from './jobs';
import {
  assetUrl,
  cacheGet,
  cacheSet,
  claim,
  createBookingRecord,
  deleteBooking,
  getBooking,
  getBookingIndex,
  getEventType,
  getSite,
  isStorageId,
  listEventTypes,
  listHosts,
  mutateBookingIndex,
  releaseClaim,
  updateBooking,
} from './repo';
import { checkSlot, computeSlots, pickRoundRobinHost, type HostAvailabilityInput, type SlotQuery, type SlotRejection } from './slots';
import { firstName, joinNames, linkCheckText, renderTemplate } from './templates';
import { DAY_MS, MINUTE_MS, formatInZone, isValidZone, type Interval } from './time';
import { normalizePhone, twilioFeatures } from './twilio';
import { FieldErrors, cleanLine, cleanText, isEmail, isHttpsUrl, isIsoInstant, isPlainObject, isZone } from './validate';

// ───────────────────────── limits ─────────────────────────

const HOUR_SEC = 3600;
const DAY_SEC = 24 * HOUR_SEC;
const BOOKINGS_PER_IP_PER_HOUR = 10;
const BOOKINGS_PER_EMAIL_PER_HOUR = 6;
/**
 * Bookings made a day with one email address (UTC day). Email addresses are not verified, so without it
 * a script that books and cancels again and again could have the site send a stranger a confirmation
 * and a cancellation every few minutes all day long. Counted only when a booking is really made.
 */
const BOOKINGS_PER_EMAIL_PER_DAY = 12;
/**
 * Bookings a day that may send texts or calls to one phone number. Phone numbers are not verified, so
 * this is what keeps a stranger's number from being texted again and again (book, cancel, book again).
 */
const TEXTED_BOOKINGS_PER_PHONE_PER_DAY = 3;
/** Upcoming meetings one email address may hold at the same time. */
const MAX_UPCOMING_PER_EMAIL = 5;
/**
 * Moves from the booking page. The lifetime cap lives on the booking itself (rate limit counters go
 * once their window is over); the hourly one keeps a single link from flooding inboxes and phones.
 */
const MAX_SELF_SERVICE_MOVES = 5;
const MOVES_PER_BOOKING_PER_HOUR = 3;
/** Work left over after a change (calendar, reminders, notices) is finished by reconcileBookings once it is this old. */
const FOLLOW_UP_GRACE_MS = 10 * 60_000;
/** No request runs longer than this (the platform cuts it off at about 25 s): older work is not in flight any more. */
const REQUEST_CEILING_MS = 30_000;
/** How many cancelled, still upcoming bookings one reconcile run looks at (calendar clean-up). */
const RECONCILE_CANCELLED_LIMIT = 100;
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
/** How long the list of available times waits for the hosts' calendars. A slower answer is cached in the background. */
export const CALENDAR_READ_BUDGET_MS = 6000;
/**
 * How long a new booking or a move waits for the calendars before failing closed. Longer than any reader
 * gives itself (a calendar feed 8 s, a Google free/busy request 3.5 s plus one retry), so a feed that is
 * slow but works can be booked, not only shown. The request stays far below the platform's 25 s ceiling.
 */
export const BOOKING_READ_BUDGET_MS = 8500;
/** A request aims to answer within this time, so the calendar write gets what the earlier steps left over. */
const REQUEST_BUDGET_MS = 9000;
const MIN_CALENDAR_BUDGET_MS = 1000;
const RETRY_AFTER_TIMEOUT_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 2 * MINUTE_MS;
const IMMEDIATE_JOBS_BUDGET_MS = 8000;

const GENERIC_REFUSAL = 'Could not complete the booking. Please try again.';
const BOOKING_NOT_FOUND = 'We could not find that booking. Check the link in your confirmation email.';
const CALENDAR_RECONNECT = 'Google Calendar needs to be reconnected.';
const MEET_PENDING = 'Google has not finished creating the Meet link yet. Trying again shortly.';
/** Tries a gcal_sync job gets (MAX_ATTEMPTS in jobs.ts). A Meet link still missing after the last one is reported to the owner. */
const GCAL_JOB_TRIES = 4;
/**
 * How long after a cancellation an event of it may still be created by a first calendar write that was in
 * flight when the cancellation came (a request runs 30 s at most, its background work a few minutes).
 */
const BLIND_DELETE_WINDOW_MS = 10 * MINUTE_MS;

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

// ───────────────────────── open for bookings ─────────────────────────

/** Stores already seen with their admin record. First-run setup cannot be undone, so a yes stays a yes. */
const SET_UP = new WeakSet<KV>();

/**
 * Whether first-run setup is done. Until the owner has set a password, nobody has chosen the hours, the
 * zone or where notices go, so the booking page lists nothing and takes no bookings. One small read per
 * request in production (each request opens its own store), none after the first yes on a long-lived one.
 */
async function siteIsOpen(ctx: Ctx): Promise<boolean> {
  if (SET_UP.has(ctx.kv)) return true;
  const admin = await getAdminAuth(ctx);
  if (admin) SET_UP.add(ctx.kv);
  return !!admin;
}

function notOpenYet(): HttpError {
  return new HttpError(503, 'not_open', 'This booking page is not taking bookings yet. Please check back soon.');
}

/**
 * Whether this site emails the invitee at all. In development and the browser tests nothing is set up and
 * mail goes to the mock outbox instead, unless email was switched off on purpose (as sendEmail does).
 * A failed read counts as yes: it must not turn a booking that went through into an error.
 */
async function emailGoesOut(ctx: Ctx, site: SiteSettings): Promise<boolean> {
  if (site.email?.provider === 'none') return false;
  if (ctx.env.mockProviders) return true;
  try {
    return (await resolveEmailProvider(ctx)) !== 'none';
  } catch (err) {
    ctx.log('warn', 'booking: could not tell whether email is set up', { error: shortError(err) });
    return true;
  }
}

/**
 * Whether a booking of this event gets a Google event (and with it a Meet link): an assigned host has a
 * working Google connection. A round robin can land on any of its hosts, so each of them needs one.
 */
function calendarReachable(et: EventType, assigned: Host[]): boolean {
  if (assigned.length === 0) return false;
  return et.kind === 'round_robin' ? assigned.every(usable) : assigned.some(usable);
}

/** Whether Google sends the invitee, and any guests, an invitation for a booking of this event. */
function invitationsReachInvitee(et: EventType, assigned: Host[]): boolean {
  return et.googleInvite !== false && calendarReachable(et, assigned);
}

/** Whether this event has a reminder call for the invitee. Only then is a call offered, and agreed to. */
function hasReminderCall(et: EventType): boolean {
  return (et.reminders ?? []).some((r) => r?.enabled === true && r.channel === 'call' && r.audience !== 'host' && r.trigger !== 'after_end');
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
function publicLocation(loc: LocationConfig, leadFirstName: string, meetLink: boolean): PublicEventType['locations'][number] {
  const custom = cleanLine(loc?.label, 80);
  switch (loc?.type) {
    case 'google_meet':
      // The link comes from Google: without a connected calendar there is none to promise.
      return meetLink ? { type: 'google_meet', label: custom || 'Google Meet', detail: 'You get the link when you book' } : { type: 'google_meet', label: custom || 'Google Meet' };
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

/**
 * `hosts` may be every host of the site: only the ones assigned to the event type are shown.
 * `brand`: the page is shown in a brand, whose look is all its own, so the event's colour is left out.
 * `site`: the stored settings, to name the short link that opens this event.
 */
export function toPublicEventType(ctx: Ctx, et: EventType, hosts: Host[], opts?: { brand?: Brand | null; site?: SiteSettings }): PublicEventType {
  const assigned = pickHosts(et.hostIds, hostsById(hosts));
  const lead = firstName(assigned[0]?.name ?? '');
  const invites = invitationsReachInvitee(et, assigned);
  // Guests hear about the meeting only through Google's invitation, so they are only offered when it goes out.
  const guests = et.allowGuests === true && invites;
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
    locations: locationsOf(et).map((l) => publicLocation(l, lead, calendarReachable(et, assigned))),
    questions: (et.questions ?? []).slice(0, MAX_QUESTIONS).map(publicQuestion),
    allowGuests: guests,
    maxGuests: guests ? Math.max(0, Math.min(MAX_GUESTS, Math.trunc(positive(et.maxGuests)))) : 0,
    phone: et.phone,
    minNoticeMinutes: positive(et.scheduling?.minNoticeMinutes),
    maxDaysAhead: positive(et.scheduling?.maxDaysAhead),
    themeOverride: et.themeOverride ? publicThemePart(et.themeOverride) : null,
    calendarInvite: invites,
    reminderChannels: { call: hasReminderCall(et) },
  };
  if (et.emoji) out.emoji = et.emoji;
  if (et.color) out.color = opts?.brand ? '' : et.color;
  const short = opts?.site ? shortNameFor(opts.site, et.id) : null;
  if (short) out.shortUrl = shortUrlOf(ctx.env.publicBaseUrl, short);
  return out;
}

type LoadedSite = { site: SiteSettings; hosts: Host[]; eventTypes: EventType[]; features: { sms: boolean; calls: boolean }; email: boolean; open: boolean };

/** The brand's logo for its pages: the one the owner uploaded, else the built-in one (a same-origin static file). */
function brandLogoUrl(ctx: Ctx, brand: Brand): string {
  return assetUrl(ctx, brand.theme.logoAssetId) ?? `${BASE_PATH}/${brand.art.logo}`;
}

/**
 * The public site. With a `brand`, as that brand shows it: its name instead of the owner's profile, its look
 * and logo, and no list of the owner's meetings (the page only links back to it in the owner's own look).
 * The consent wording, the assistant and everything else stay the site's.
 */
function buildPublicSite(ctx: Ctx, p: LoadedSite, brand: Brand | null = null): PublicSite {
  const { hosts } = p;
  const site: SiteSettings = brand ? siteForBrand(p.site, brand) : p.site;
  const consentText = site.booking?.consentText ?? '';
  const booking: PublicSite['booking'] = {
    reminderOptInDefault: site.booking?.reminderOptInDefault === true,
    consentText,
    consentTextSms: smsOnlyConsentText(consentText),
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
      logoUrl: brand ? brandLogoUrl(ctx, brand) : assetUrl(ctx, site.theme.logoAssetId),
      backgroundUrl: assetUrl(ctx, site.theme.background?.imageAssetId),
    },
    // Before first-run setup nothing is on offer (see siteIsOpen). A brand's page never lists the owner's meetings.
    eventTypes:
      p.open && !brand
        ? p.eventTypes.filter((et) => et.active === true && et.visibility === 'public').map((et) => toPublicEventType(ctx, et, hosts, { brand: brandOf(p.site, et), site: p.site }))
        : [],
    booking,
    assistantName: site.assistant?.name ?? '',
    features: { sms: p.features.sms === true, calls: p.features.calls === true, email: p.email },
    ownerTimezone: ownerZoneOf(ctx, site, hosts),
    brand: brand ? { id: brand.id, name: brand.name, iconUrl: assetUrl(ctx, brand.theme.logoAssetId) ?? `${BASE_PATH}/${brand.art.favicon}` } : null,
  };
}

/** Everything the public site is built from, read in one go. */
async function loadPublicSite(ctx: Ctx): Promise<LoadedSite> {
  const [site, open] = await Promise.all([getSite(ctx), siteIsOpen(ctx)]);
  const [hosts, eventTypes, features, email] = await Promise.all([listHosts(ctx), listEventTypes(ctx), twilioFeatures(ctx), emailGoesOut(ctx, site)]);
  return { site, hosts, eventTypes, features, email, open };
}

export async function toPublicSite(ctx: Ctx): Promise<PublicSite> {
  return buildPublicSite(ctx, await loadPublicSite(ctx));
}

/** The site plus one event type by its link. Unlisted event types resolve here; paused or unknown ones give null, and so does every one before first-run setup. */
export async function getPublicEvent(ctx: Ctx, slug: string): Promise<{ site: PublicSite; eventType: PublicEventType } | null> {
  const loaded = await loadPublicSite(ctx);
  if (!loaded.open) return null;
  const wanted = typeof slug === 'string' ? slug.toLowerCase() : '';
  const et = wanted === '' ? undefined : loaded.eventTypes.find((e) => e.slug.toLowerCase() === wanted);
  if (!et || et.active !== true) return null;
  const brand = brandOf(loaded.site, et);
  return { site: buildPublicSite(ctx, loaded, brand), eventType: toPublicEventType(ctx, et, loaded.hosts, { brand, site: loaded.site }) };
}

/**
 * What a short link opens right now (GET /public/short/:name). Read-only. An event that is paused shows its
 * closed page in its own brand; a link that opens nothing (never set, turned off, its event deleted) and every
 * link before first-run setup show the closed page in the link's own brand.
 */
export async function getShortLink(ctx: Ctx, name: ShortName): Promise<ShortLinkResponse> {
  const loaded = await loadPublicSite(ctx);
  const url = shortUrlOf(ctx.env.publicBaseUrl, name);
  const linkBrand = brandOf(loaded.site, { brandId: SHORT_LINKS[name].brandId });
  if (!loaded.open) return { name, url, state: 'closed', reason: 'not_open', site: buildPublicSite(ctx, loaded, linkBrand) };
  const id = shortLinkTarget(loaded.site, name);
  const et = id ? loaded.eventTypes.find((e) => e.id === id) : undefined;
  if (!et) return { name, url, state: 'closed', reason: 'unassigned', site: buildPublicSite(ctx, loaded, linkBrand) };
  const brand = brandOf(loaded.site, et);
  if (et.active !== true) return { name, url, state: 'closed', reason: 'paused', site: buildPublicSite(ctx, loaded, brand) };
  return { name, url, state: 'open', site: buildPublicSite(ctx, loaded, brand), eventType: toPublicEventType(ctx, et, loaded.hosts, { brand, site: loaded.site }) };
}

/**
 * "Booked through Eco Champions: https://jimicohen.com/pod" for a booking made under a brand, null for one
 * made in the owner's own look. `site` is the stored settings.
 */
export function brandLineFor(ctx: Ctx, site: SiteSettings, booking: Booking): string | null {
  if (!isBrandId(booking.brandId)) return null;
  return brandLine(viewFor(site, booking), bookUrlFor(ctx.env.publicBaseUrl, site, booking));
}

function selfServiceOpen(b: Booking, nowMs: number): boolean {
  return b.status === 'confirmed' && Date.parse(b.start) > nowMs;
}

/**
 * Whether Google has sent (or is about to send) the invitee an invitation for this booking: the booking is
 * one Google invites them to (invite.ts, recorded per booking, so a later change of the event type's setting
 * does not change the answer) and it has a Google event, or one that is still being written to a calendar
 * that works.
 */
function invitationSent(b: Booking, byId: Map<string, Host>, eventType: EventType | null, site: SiteSettings): boolean {
  // A detached booking's Google invitation can no longer be kept up to date: the page promises none.
  if (b.status !== 'confirmed' || b.google?.detached || !invitedByGoogle(b, eventType)) return false;
  if (b.google) return b.google.eventId !== '' || usable(byId.get(b.google.hostId));
  // Recorded for Google, its event not written yet (that write was cut off): housekeeping writes it while a host can take it.
  return chooseOrganizer(b, byId, site) !== null;
}

/**
 * Who cancelled, as the booking page names them: a name only when it is known. A cancellation by a host
 * that was not made through a host's link was made by the owner (the dashboard, or the booking page while
 * signed in). Through a host's link it could have been any host, so no name is given.
 */
function cancelledByName(b: Booking, site: SiteSettings, hosts: Host[]): string | null {
  if (b.cancellation?.by !== 'host' || b.cancellation.via === 'host_link') return null;
  const owner = hosts.find((h) => h.id === site.ownerHostId) ?? hosts.find((h) => h.role === 'owner') ?? null;
  return owner?.name.trim() || null;
}

/**
 * `rules: 'owner'`: the owner, signed in, opened the page from a host's link. The owner may cancel or move a
 * meeting that has already started; the invitee's deadline only holds for everyone else. Once the meeting is
 * over the page offers neither, as the dashboard does not: a cancellation then would only tell the invitee
 * that a meeting which took place was called off.
 */
function publicBookingOf(ctx: Ctx, b: Booking, hosts: Host[], eventType: EventType | null, email: boolean, site: SiteSettings, rules: 'invitee' | 'owner' = 'invitee'): PublicBooking {
  const byId = hostsById(hosts);
  const assigned = pickHosts(b.hostIds, byId);
  const nowMs = ctx.now().getTime();
  const open = rules === 'owner' ? b.status === 'confirmed' && Date.parse(b.end) > nowMs : selfServiceOpen(b, nowMs);
  const byName = cancelledByName(b, site, hosts);
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
    calendarLinks: calendarLinks({ booking: b, hosts: assigned, baseUrl: ctx.env.publicBaseUrl, manageToken: manageToken(ctx, b.id), brandLine: brandLineFor(ctx, site, b) }),
    cancellation: b.cancellation
      ? { at: b.cancellation.at, by: b.cancellation.by, ...(b.cancellation.reason ? { reason: b.cancellation.reason } : {}), ...(byName ? { byName } : {}) }
      : null,
    rescheduledFromStart: b.rescheduledFromStart ?? null,
    attendanceConfirmed: !!b.attendance?.confirmedAt,
    // What the page may promise: an email from us, an invitation from Google, both or neither.
    delivery: { email: email && isEmail(b.invitee.email), calendarInvite: invitationSent(b, byId, eventType, site) },
  };
  // Why the page cannot offer a move it would otherwise offer, so it can say so to whoever is looking.
  if (open && eventType && eventType.active !== true) out.rescheduleBlocked = 'paused';
  if (rules === 'owner') out.ownerView = true;
  const message = eventType?.confirmation?.message?.trim();
  if (message) out.confirmationMessage = message;
  const redirectUrl = eventType?.confirmation?.redirectUrl?.trim();
  if (redirectUrl && isHttpsUrl(redirectUrl)) out.redirectUrl = redirectUrl;
  return out;
}

/** The booking as its invitee may see it. Only ever hand this to someone who holds the manage token. */
export async function toPublicBooking(ctx: Ctx, b: Booking, opts?: { owner?: boolean }): Promise<PublicBooking> {
  const site = await getSite(ctx);
  const [hosts, eventType, email] = await Promise.all([listHosts(ctx), getEventType(ctx, b.eventTypeId), emailGoesOut(ctx, site)]);
  return publicBookingOf(ctx, b, hosts, eventType, email, site, opts?.owner ? 'owner' : 'invitee');
}

/**
 * Everything the manage page needs, or null when the booking does not exist. The caller checks the token,
 * and `owner` (the signed-in owner opened the page from a host's link, see publicBookingOf).
 */
export async function getManageView(
  ctx: Ctx,
  bookingId: string,
  opts?: { owner?: boolean },
): Promise<{ booking: PublicBooking; site: PublicSite; eventType: PublicEventType | null } | null> {
  const record = await getBooking(ctx, bookingId);
  if (!record) return null;
  const loaded = await loadPublicSite(ctx);
  const eventType = loaded.eventTypes.find((e) => e.id === record.eventTypeId) ?? null;
  // The look the booking was made in, whatever its event type carries now.
  const brand = brandOf(loaded.site, record);
  return {
    booking: publicBookingOf(ctx, record, loaded.hosts, eventType, loaded.email, loaded.site, opts?.owner ? 'owner' : 'invitee'),
    // A booking exists, so setup was done (a store restored by hand without its admin record still shows it).
    site: buildPublicSite(ctx, { ...loaded, open: true }, brand),
    eventType: eventType ? toPublicEventType(ctx, eventType, loaded.hosts, { brand, site: loaded.site }) : null,
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
  /** each source of the host that could not be read, naming its account */
  problems?: BusyProblem[];
}

interface ExternalBusy {
  /** hosts whose calendars could be read. A host that is missing here is never offered. */
  inputs: HostAvailabilityInput[];
  failed: CalendarFailure[];
  /** true when the event cannot be offered at all because of calendar trouble */
  blocked: boolean;
  /** true when the calendars did not answer within the budget (blocked is then true as well) */
  timedOut?: boolean;
  /** with timedOut: the hosts whose calendars had not answered */
  slow?: Host[];
  /** with timedOut: per host id, the sources still being read (an address, or "calendar feeds") */
  slowSources?: Record<string, string[]>;
}

/**
 * External busy time for the hosts of an event. A host whose calendar cannot be read is left out, which
 * the slot engine reads as "never free". For solo and collective events that closes every time (each host
 * is required); a round robin carries on with the hosts that can be read.
 */
async function loadExternalBusy(ctx: Ctx, kind: EventKind, hosts: Host[], range: Interval, fresh: boolean, budgetMs: number = CALENDAR_READ_BUDGET_MS): Promise<ExternalBusy> {
  // One read per host (the same work getBusyForHosts does), so a timeout can say whose calendar was slow,
  // and which of their accounts.
  const answered = hosts.map(() => false);
  const pending = hosts.map(() => new Set<string>());
  const reading = Promise.all(
    hosts.map((host, i) =>
      getBusyForHosts(ctx, [host], range, fresh ? { fresh: true, pending: pending[i] } : { pending: pending[i] }).then((found) => {
        answered[i] = true;
        return found[0];
      }),
    ),
  );
  const results = await withinBudget(reading, budgetMs);
  if (results === TIMED_OUT) {
    // Slow is not the same as broken, so nobody is alerted here. But without an answer nothing can be offered.
    const slow = hosts.filter((_, i) => !answered[i]);
    const slowSources: Record<string, string[]> = {};
    hosts.forEach((host, i) => {
      if (!answered[i]) slowSources[host.id] = [...pending[i]];
    });
    ctx.log('warn', 'booking: the calendars did not answer in time', { hosts: hosts.map((h) => h.id), slow: slow.map((h) => h.id) });
    ctx.waitUntil(reading);
    return { inputs: [], failed: [], blocked: true, timedOut: true, slow, slowSources };
  }
  const inputs: HostAvailabilityInput[] = [];
  const failed: CalendarFailure[] = [];
  hosts.forEach((host, i) => {
    const result = results[i];
    if (result && result.ok) inputs.push({ host, busy: result.busy });
    else failed.push({ host, error: result?.error ?? 'Calendar could not be read.', ...(result?.problems?.length ? { problems: result.problems } : {}) });
  });
  const blocked = failed.length > 0 && (kind === 'round_robin' ? inputs.length === 0 : true);
  return { inputs, failed, blocked };
}

function bufferPadMs(et: EventType): number {
  return Math.max(positive(et.scheduling?.bufferBeforeMin), positive(et.scheduling?.bufferAfterMin)) * MINUTE_MS;
}

interface TroubleLine {
  host: Host;
  /** the source: an account id, "feeds", or "host" when the read failed as a whole */
  key: string;
  /** the account's address, when it is one */
  address: string;
  message: string;
}

function troubleLines(failures: CalendarFailure[]): TroubleLine[] {
  const out: TroubleLine[] = [];
  for (const f of failures) {
    const problems = (f.problems ?? []).filter((p) => p && typeof p.key === 'string' && p.key !== '');
    if (problems.length === 0) {
      out.push({ host: f.host, key: 'host', address: '', message: f.error });
      continue;
    }
    for (const p of problems) out.push({ host: f.host, key: p.key, address: p.accountId ? p.label : '', message: p.message });
  }
  return out;
}

/**
 * Tells the owner that a calendar cannot be read: one email per broken account (or the feeds of a host) per
 * day, however many bookings or health checks run into it. Every line names the account.
 */
export async function alertCalendarTrouble(ctx: Ctx, failures: CalendarFailure[], during?: { eventTitle?: string }): Promise<number> {
  const day = nowIso(ctx).slice(0, 10);
  const claimName = (line: TroubleLine): string => `alert-calendar-${line.host.id}-${line.key}-${day}`;
  const fresh: TroubleLine[] = [];
  for (const line of troubleLines(failures)) {
    if (await claim(ctx, claimName(line))) fresh.push(line);
  }
  if (fresh.length === 0) return 0;

  const hostName = (h: Host, capital = false): string => h.name.trim() || (capital ? 'A host' : 'a host');
  const hosts = [...new Map(fresh.map((l) => [l.host.id, l.host])).values()];
  const names = joinNames(hosts.map((h) => hostName(h)));
  const subjectNames = joinNames(
    hosts.map((h) => {
      const addresses = [...new Set(fresh.filter((l) => l.host.id === h.id && l.address).map((l) => l.address))];
      return addresses.length > 0 ? `${hostName(h)} (${addresses.join(', ')})` : hostName(h);
    }),
  );
  const seen = fresh.map((l) => (l.address ? `${hostName(l.host, true)}, ${l.address}: ${l.message}` : `${hostName(l.host, true)}: ${l.message}`)).join('\n');
  // An account Google ended on the day it named: say why, or a reconnect without publishing lasts 7 more days.
  const site = await getSite(ctx).catch(() => null);
  const owner = site ? ownerOf(site, await listHosts(ctx).catch(() => [] as Host[])) : null;
  const zone = owner && isValidZone(owner.timezone) ? owner.timezone : 'UTC';
  const nowMs = ctx.now().getTime();
  const why = fresh
    .map((l) => ({ l, ref: accountsOf(l.host).find((a) => a.account.id === l.key) }))
    .filter((x) => x.ref && endedOnItsDay(x.ref.account, nowMs))
    .map(({ l, ref }) => {
      const day = formatInZone(Date.parse(ref!.account.refreshExpiresAt!), zone, 'date');
      const mine = !!owner && l.host.id === owner.id;
      return `${ref!.account.email}: ${testingEndedAdvice(day, mine ? {} : { first: firstName(l.host.name) || 'them' })}`;
    });
  const first = during?.eventTitle
    ? `Someone just tried to book "${during.eventTitle}", but the calendar of ${names} could not be read. To avoid a double booking the request was turned away.`
    : `The calendar of ${names} could not be read during a routine check.`;
  const body = [
    'Hi {{host_first_name}},',
    literal(first),
    literal(`Until the calendar can be read again, times that depend on it are not offered on your booking page.\n\nWhat we saw:\n${seen}`),
    ...why.map(literal),
    'Open your dashboard to reconnect the calendar. You get this email at most once a day for each calendar.',
  ].join('\n\n');
  try {
    await enqueueJob(ctx, {
      type: 'message',
      kind: 'host_alert',
      bookingId: '',
      channel: 'email',
      audience: 'host',
      subject: literal(`A calendar needs attention: ${subjectNames}`),
      body,
      dueAt: nowIso(ctx),
    });
  } catch (err) {
    // Nothing was queued: give the day's claims back so the next failed read can still raise the alert.
    await Promise.all(fresh.map((l) => releaseClaim(ctx, claimName(l)).catch(() => undefined)));
    throw err;
  }
  return fresh.length;
}

/**
 * A booking or a move was turned away because calendars were too slow to answer. Once is noise and stays in
 * the log. The second time in a day for the same account the owner is told (alertCalendarTrouble keeps that
 * to one email a day), so a calendar that is always too slow does not keep visitors out in silence.
 */
async function reportSlowCalendars(ctx: Ctx, slow: Host[], during: { eventTitle: string; bookingId?: string }, sources?: Record<string, string[]>): Promise<void> {
  ctx.log('error', 'booking: turned away because the calendars did not answer in time', { bookingId: during.bookingId, hosts: slow.map((h) => h.id) });
  const day = nowIso(ctx).slice(0, 10);
  const repeated: CalendarFailure[] = [];
  const message = 'The calendar took too long to answer, more than once today.';
  for (const host of slow) {
    const labels = sources?.[host.id] ?? [];
    const accounts = accountsOf(host);
    const keys: BusyProblem[] =
      labels.length > 0
        ? labels.map((label) => {
            const ref = accounts.find((a) => a.account.email === label);
            return ref ? { key: ref.account.id, label, message, accountId: ref.account.id } : { key: FEEDS_SOURCE, label, message };
          })
        : [{ key: 'host', label: '', message }];
    const problems: BusyProblem[] = [];
    for (const p of keys) if (!(await claim(ctx, `calendar-slow-${host.id}-${p.key}-${day}`))) problems.push(p);
    if (problems.length === 0) continue;
    const named = problems.filter((p) => p.key !== 'host');
    repeated.push({ host, error: message, ...(named.length > 0 ? { problems: named } : {}) });
  }
  if (repeated.length > 0) await alertCalendarTrouble(ctx, repeated, { eventTitle: during.eventTitle });
}

function calendarUnavailable(what: 'book' | 'move' = 'book'): HttpError {
  return new HttpError(
    503,
    'calendar_unavailable',
    what === 'move'
      ? 'We could not check the calendar just now, so your meeting was not moved. Please try again in a minute.'
      : 'We could not check the calendar just now, so nothing was booked. Please try again in a minute.',
  );
}

/** Reasons that depend on a host's hours or calendar, as opposed to the time alone (too soon, off the grid). */
const HOST_REASONS = new Set<SlotRejection>(['outside_hours', 'busy', 'daily_limit']);

/**
 * A round robin carries on without a host whose calendar could not be read. When the time is then not free
 * for the others, it may well be free for that host: nobody knows, so the visitor is asked to try again in a
 * minute rather than told the time was taken.
 */
function unknownBecauseUnread(external: ExternalBusy, reason: SlotRejection): boolean {
  return external.failed.length > 0 && HOST_REASONS.has(reason);
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
  const [s, open] = await Promise.all([loadScheduling(ctx), siteIsOpen(ctx)]);
  if (!open) throw notOpenYet();
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

/**
 * Top-level domains that phones and mail apps turn into links by themselves, and that spam likes. Short on
 * purpose: a test for any "word.word" would turn away names like J.R.R. Tolkien or J.Smith.
 */
const LINK_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'app', 'xyz', 'ru', 'cn', 'top', 'info', 'link', 'biz', 'online', 'site', 'shop', 'store', 'club',
  'live', 'vip', 'icu', 'click', 'support', 'help', 'page', 'dev', 'me', 'ly', 'cc', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ws', 'su',
  'zip', 'mov', 'uk', 'us', 'eu', 'de', 'fr', 'nl', 'ai', 'gg', 'tv', 'ink', 'work', 'win', 'bid', 'loan', 'sbs', 'cfd', 'rest', 'bond',
];
/** A host name on one of those domains: two letters or more, a dot, the domain, and nothing glued after it. */
const DOMAIN_TOKEN = new RegExp(`(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]*[\\p{L}\\p{N}](?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${LINK_TLDS.join('|')})(?![\\p{L}\\p{N}-])`, 'iu');
/** "something.something/": the start of a web address with a path, whatever its domain. */
const ADDRESS_WITH_PATH = /[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+\//u;

/**
 * Whether visitor text carries a link. The name and the place a visitor types end up in emails and texts
 * sent to whatever address and number they typed, so neither may smuggle a link in (mail apps and phones
 * link bare addresses themselves). A name has no use for slashes or an @ either; a street address can.
 */
function carriesLink(raw: string, kind: 'name' | 'place'): boolean {
  // Wide and ideographic full stops count as dots: browsers read them as dots in addresses.
  const text = linkCheckText(raw);
  if (/:\/\/|www\./i.test(text) || DOMAIN_TOKEN.test(text)) return true;
  if (kind === 'name') return /[/\\@]/.test(text);
  return ADDRESS_WITH_PATH.test(text);
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

/** `reachable`: Google's invitation will reach guests (see invitationsReachInvitee). Nothing else tells them, so without it none are taken. */
function readGuests(raw: unknown, eventType: EventType, inviteeEmail: string, reachable: boolean, errors: FieldErrors): string[] {
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
  const allowed = eventType.allowGuests === true && reachable ? Math.max(0, Math.min(MAX_GUESTS, Math.trunc(positive(eventType.maxGuests)))) : 0;
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

/**
 * Every field of a booking request, cleaned. Throws one 422 that lists all problems by field.
 * `allow.guests`: whether guests can be told about the meeting at all (see readGuests).
 */
function readBookingInput(raw: Record<string, unknown>, eventType: EventType, leadFirstName: string, allow: { guests: boolean }): BookingInput {
  const errors = new FieldErrors();

  const nameRaw = typeof raw.name === 'string' ? raw.name : '';
  const name = cleanLine(nameRaw, MAX_NAME + 1);
  if (name === '') errors.add('name', 'Please enter your name.');
  else if (name.length < 2) errors.add('name', 'Please enter your full name.');
  else if (name.length > MAX_NAME) errors.add('name', `Please keep your name under ${MAX_NAME} characters.`);
  else if (carriesLink(name, 'name')) errors.add('name', 'Please enter your name, without links.');

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
      else if (carriesLink(locationText, 'place')) errors.add('locationText', 'Please give an address or a phone number, without links.');
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

  const guests = readGuests(raw.guests, eventType, email, allow.guests, errors);
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

/** The form's request key when it has a usable shape (at least 128 bits written out), otherwise null. */
function readRequestKey(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(raw) ? raw : null;
}

/**
 * The booking id that belongs to a request: the form's key, the meeting type and the time. A retry of the
 * same request therefore lands on the same id, which the booking index never holds twice; the same form
 * sent for another time is another booking (and its own retry is recognised in turn). Keyed with the site
 * secret, so the id says nothing about the key.
 */
function bookingIdForKey(ctx: Ctx, key: string, eventTypeId: string, startMs: number): string {
  return `bkg_${hmacHex(ctx, 'booking-request', `${key}|${eventTypeId}|${startMs}`).slice(0, 26)}`;
}

/** Whether a stored booking is the one this request asked for: same meeting, same person, same time. */
function sameRequest(b: Booking, eventType: EventType, input: BookingInput): boolean {
  return b.eventTypeId === eventType.id && b.invitee.email.toLowerCase() === input.email.toLowerCase() && Date.parse(b.start) === input.startMs;
}

function upcomingForEmail(entries: BookingIndexEntry[], email: string, nowMs: number): number {
  const wanted = email.toLowerCase();
  return entries.filter((e) => e.status === 'confirmed' && Date.parse(e.end) > nowMs && (e.inviteeEmail ?? '').toLowerCase() === wanted).length;
}

function tooManyUpcoming(): HttpError {
  return new HttpError(
    409,
    'booking_limit',
    `This email address already has ${MAX_UPCOMING_PER_EMAIL} upcoming meetings booked. Please cancel one you no longer need before booking another.`,
  );
}

/**
 * Texts and calls go to numbers nobody has verified, so one number can only be given on a few bookings a
 * day. The place is taken before the booking is made and given back when it is not made after all.
 */
async function limitTextedBookings(ctx: Ctx, phone: string): Promise<RateLimitHit> {
  try {
    return await rateLimitTake(ctx, 'book-phone', phone, TEXTED_BOOKINGS_PER_PHONE_PER_DAY, DAY_SEC);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 429) throw err;
    throw new HttpError(
      429,
      'phone_limit',
      'This phone number already has several bookings with text or call reminders today. Untick the text and call reminders to book without them, or try again tomorrow.',
    );
  }
}

/**
 * The inbox an address delivers to, which is what the limits per email address count: lower case, without
 * a "+tag" (ada+1@example.com lands in ada@example.com), and for Gmail without dots and with googlemail.com
 * read as gmail.com. Otherwise a script could book under endless spellings of one stranger's address and
 * fill that one inbox all the same.
 */
function mailboxOf(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '') || local;
  return `${local}@${domain}`;
}

/**
 * Takes this booking's place among the day's bookings for its email address. The caller gives it back
 * when the booking is not made after all, so a time that was taken or a refused request does not count.
 */
async function takeDailyBooking(ctx: Ctx, email: string, hostFirstName: string): Promise<RateLimitHit> {
  try {
    return await rateLimitTake(ctx, 'book-email-day', mailboxOf(email), BOOKINGS_PER_EMAIL_PER_DAY, DAY_SEC);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 429) throw err;
    throw new HttpError(
      429,
      'email_limit',
      `This email address has made a lot of bookings today, so the page cannot take another one. Please get in touch with ${hostFirstName || 'the host'} directly to find a time.`,
    );
  }
}

/** The booking this request already made, when its first try went through and only the answer was lost. */
function alreadyBooked(ctx: Ctx, booking: Booking): { booking: Booking; manageToken: string } {
  ctx.log('info', 'booking: a repeated request got the booking its first try made', { bookingId: booking.id });
  return { booking, manageToken: manageToken(ctx, booking.id) };
}

/**
 * alreadyBooked for the record a retry found. When the try that saved it was cut off before its follow-up
 * (the record still carries the 'created' marker, and that try is surely over), the follow-up is done now,
 * so the visitor is not shown a booking that nobody was told about.
 */
async function handBack(ctx: Ctx, booking: Booking, eventType: EventType, startedMs: number, opts?: BookingActionOptions): Promise<{ booking: Booking; manageToken: string }> {
  const marker = booking.followUp;
  if (booking.status !== 'confirmed' || marker?.kind !== 'created' || !(Date.parse(marker.at) <= ctx.now().getTime() - REQUEST_CEILING_MS)) return alreadyBooked(ctx, booking);
  const followed = await followUpBooking(ctx, booking.id, marker, eventType, { calendarMode: 'reconcile', calendarBudgetMs: calendarBudget(ctx, startedMs, opts), fallback: booking, note: true });
  runImmediateJobs(ctx, booking.id, followed.pending);
  return alreadyBooked(ctx, (await getBooking(ctx, booking.id).catch(() => null)) ?? followed.booking);
}

/**
 * An index entry of this very request (its id comes from the form's key, the meeting and the time) whose
 * booking record was never written, from a try that is surely over: it failed after taking the time. A
 * retry takes such an entry over instead of being asked to wait for a first try that no longer runs.
 */
function leftoverOfThisRequest(entry: BookingIndexEntry, eventType: EventType, input: BookingInput, nowMs: number): boolean {
  return (
    entry.status === 'confirmed' &&
    entry.eventTypeId === eventType.id &&
    Date.parse(entry.start) === input.startMs &&
    (entry.inviteeEmail ?? '').toLowerCase() === input.email.toLowerCase() &&
    typeof entry.takenAt === 'number' &&
    entry.takenAt <= nowMs - REQUEST_CEILING_MS
  );
}

function stillSaving(): HttpError {
  // Not "check your email": on a site that sends none, or for a first try that never finished, none comes.
  // Trying again is safe and shows the booking once it is saved.
  return new HttpError(409, 'in_progress', 'Your booking is still being saved. Please wait a moment, then try again to see it.');
}

// ───────────────────────── create ─────────────────────────

export interface BookingActionOptions {
  /** how long to wait for Google to take the event before answering (default: up to 7 s). The work then finishes in the background. */
  calendarBudgetMs?: number;
  /** how long to wait for the hosts' calendars to report their busy time (default 8.5 s, BOOKING_READ_BUDGET_MS). After that the request fails closed. */
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

  const [s, open] = await Promise.all([loadScheduling(ctx), siteIsOpen(ctx)]);
  // Nothing is set up yet: no hours chosen, nobody to tell. The page lists nothing, and a direct request gets this.
  if (!open) throw notOpenYet();
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  const eventType = slug === '' ? undefined : s.eventTypes.find((e) => e.slug.toLowerCase() === slug);
  if (!eventType || eventType.active !== true) throw new HttpError(404, 'not_found', 'This meeting type is no longer available.');

  const eventHosts = pickHosts(eventType.hostIds, s.byId);
  const input = readBookingInput(raw, eventType, firstName(eventHosts[0]?.name ?? ''), { guests: invitationsReachInvitee(eventType, eventHosts) });

  // A retry of a request that did go through (only its answer got lost) gets that booking back. The key is
  // what makes it the same request: an email address and a time alone would hand the manage link to anyone
  // who knows them.
  const requestKey = readRequestKey(raw.requestKey);
  const keyedId = requestKey ? bookingIdForKey(ctx, requestKey, eventType.id, input.startMs) : null;
  const earlier = keyedId ? await getBooking(ctx, keyedId) : null;
  // A record of this request that is not in the index holds no time: an earlier try wrote it, then failed
  // and gave the time back. It is a booking only once the time is taken again, below. (Its follow-up never
  // ran, so it still carries the 'created' marker: nobody was told of it, it has no calendar event.)
  let orphan: Booking | null = null;
  if (earlier && sameRequest(earlier, eventType, input)) {
    const unlisted = earlier.status === 'confirmed' && earlier.followUp?.kind === 'created' && !(await getBookingIndex(ctx)).some((e) => e.id === earlier.id);
    if (!unlisted) return handBack(ctx, earlier, eventType, startedMs, opts);
    orphan = earlier;
  }
  // That id already holds somebody else's booking (a key that was not random after all): a new id then.
  const id = keyedId && (!earlier || orphan) ? keyedId : randomId('bkg');

  await rateLimit(ctx, 'book-email', mailboxOf(input.email), BOOKINGS_PER_EMAIL_PER_HOUR, HOUR_SEC);

  const nowMs = ctx.now().getTime();
  const startMs = input.startMs;
  const endMs = startMs + input.durationMin * MINUTE_MS;
  if (eventHosts.length === 0) throw slotTaken('outside_hours');

  // Step 2: what the hosts' own calendars say right now. Unknown is never read as free.
  const pad = Math.max(DAY_MS, bufferPadMs(eventType));
  const external = await loadExternalBusy(ctx, eventType.kind, eventHosts, { start: startMs - pad, end: endMs + pad }, true, opts?.calendarReadBudgetMs ?? BOOKING_READ_BUDGET_MS);
  if (external.failed.length > 0) {
    await quietly(ctx, 'the calendar alert', '', () => alertCalendarTrouble(ctx, external.failed, { eventTitle: eventType.title }));
  }
  if (external.timedOut) await quietly(ctx, 'the slow calendar note', '', () => reportSlowCalendars(ctx, external.slow ?? [], { eventTitle: eventType.title }, external.slowSources));
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
  const own = query.index.find((e) => e.id === id);
  // Another retry of this request has just taken the time again for its record.
  if (own && orphan) return alreadyBooked(ctx, orphan);
  // Its first try took the time a moment ago and is still saving the record. Or it took the time and then
  // failed before the record was written: once that try is surely over, this one takes the entry over.
  const leftover = own && leftoverOfThisRequest(own, eventType, input, nowMs) ? own : null;
  if (own && !leftover) throw stillSaving();
  const others = leftover ? query.index.filter((e) => e.id !== id) : query.index;
  // What is left of this request when the time turns out to be gone: an entry or a record that holds nothing.
  const letGo = async (): Promise<void> => {
    if (leftover) {
      await quietly(ctx, 'releasing the time of a booking that was never saved', id, () =>
        mutateBookingIndex(ctx, (entries) => (entries.some((e) => e.id === id && e.req === leftover.req) ? entries.filter((e) => !(e.id === id && e.req === leftover.req)) : { abort: 'gone' })),
      );
    }
    if (orphan) await quietly(ctx, 'removing a booking record that lost its time', id, () => deleteBooking(ctx, id));
  };
  const first = checkSlot({ ...query, index: others }, startMs);
  if (!first.ok) {
    // The page offered this time from a calendar answer that can be a minute old. It is wrong now: drop it,
    // so the list the visitor goes back to (and anyone else's) is built from the calendars as they are.
    if (first.reason === 'busy') await forgetHostBusy(ctx, eventHosts.map((h) => h.id));
    if (unknownBecauseUnread(external, first.reason)) throw calendarUnavailable();
    await letGo();
    throw slotTaken(first.reason);
  }
  if (upcomingForEmail(others, input.email, nowMs) >= MAX_UPCOMING_PER_EMAIL) throw tooManyUpcoming();

  // Everything the record needs is read before the time is taken, so nothing sits between the two writes below.
  const features = await twilioFeatures(ctx).catch(() => ({ sms: false, calls: false }));
  const sms = input.wantsSms && features.sms;
  // A call is only agreed to on a meeting that has one: the form does not offer it otherwise.
  const call = input.wantsCall && features.calls && hasReminderCall(eventType);
  // The day's bookings for this email address. Its place is taken now, so requests sent together cannot
  // pass the limit, and given back on every way out below that does not end in a new booking.
  const daily = await takeDailyBooking(ctx, input.email, firstName(eventHosts[0]?.name ?? ''));
  let phonePlace: RateLimitHit | null = null;
  // Every way out below that does not end in a new booking gives both places back.
  const refundAll = async (): Promise<void> => {
    await daily.refund();
    await phonePlace?.refund();
  };
  const notMade = async (err: unknown): Promise<never> => {
    await refundAll();
    throw err;
  };
  // Counted only for a request that is about to take a free time: a visitor who was unlucky with a time
  // keeps their allowance, and only bookings that really text or call a number use it up.
  if (input.phone && (sms || call)) phonePlace = await limitTextedBookings(ctx, input.phone).catch(notMade);

  // Step 4: take it. The check runs again inside the swap, on the index as it is at that instant.
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  // A retry of this form uses the same id, so the entry also carries a mark of this very request.
  const mark = randomToken(16).slice(0, 12);
  let assigned: string[] = [];
  const taken = await mutateBookingIndex(ctx, (entries) => {
    const present = entries.find((e) => e.id === id);
    if (present) {
      // Our own write: it went through, but its answer was lost and the index changed again since.
      if (present.req === mark) {
        assigned = [...present.hostIds];
        return { abort: 'ours' };
      }
      // The same request, a moment earlier (a double submit, a retry racing its first try). Unless it is
      // the leftover this request takes over: then the time is checked again without it.
      if (!(leftover && present.req === leftover.req && present.takenAt === leftover.takenAt)) return { abort: 'duplicate' };
    }
    const rest = present ? entries.filter((e) => e.id !== id) : entries;
    if (upcomingForEmail(rest, input.email, nowMs) >= MAX_UPCOMING_PER_EMAIL) return { abort: 'booking_limit' };
    const again = checkSlot({ ...query, index: rest }, startMs);
    if (!again.ok) return { abort: again.reason };
    if (orphan) {
      // The record already names its hosts: the time is only this request's again when they are free.
      if (!orphan.hostIds.every((h) => again.hostIds.includes(h))) return { abort: 'busy' };
      assigned = [...orphan.hostIds];
    } else {
      assigned = eventType.kind === 'round_robin' ? [pickRoundRobinHost(again.hostIds, rest, nowMs)] : [...again.hostIds];
    }
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
      req: mark,
      takenAt: nowMs,
    };
    return [...rest, entry];
  }).catch(async (err: unknown) => {
    // The swap failed on the read that checks a refused write: the write may have gone through. Look once more.
    const mine = (await getBookingIndex(ctx).catch(() => [] as BookingIndexEntry[])).find((e) => e.id === id && e.req === mark);
    if (!mine) return notMade(err);
    assigned = [...mine.hostIds];
    return { ok: false as const, reason: 'ours' };
  });
  if (!taken.ok && taken.reason !== 'ours') {
    // Not made by this request: its places among the day's bookings go back (an earlier try that did make it counted itself).
    await refundAll();
    if (taken.reason === 'contention') throw new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
    if (taken.reason === 'booking_limit') throw tooManyUpcoming();
    if (taken.reason === 'duplicate') {
      const twin = await getBooking(ctx, id);
      if (twin && sameRequest(twin, eventType, input)) return alreadyBooked(ctx, twin);
      throw stillSaving();
    }
    await letGo();
    throw slotTaken(taken.reason as SlotRejection);
  }

  // Step 5: the booking itself.
  const assignedHosts = pickHosts(assigned, s.byId);
  const consentHost = eventHosts[0] ?? ownerOf(s.site, s.hosts);
  // The words the visitor saw under the switches: texts alone get the wording without the call. The wording
  // is the site's for every brand; only {{site_name}} reads as the page did (the brand's name on its pages).
  const siteConsent = s.site.booking?.consentText ?? '';
  const shown = viewFor(s.site, eventType);
  const consentText =
    sms || call
      ? renderTemplate(call ? siteConsent : smsOnlyConsentText(siteConsent), {
          host_first_name: firstName(consentHost?.name ?? s.site.profile.name),
          host_name: consentHost?.name ?? s.site.profile.name,
          assistant_name: s.site.assistant?.name ?? '',
          site_name: shown.profile.name,
          event_name: eventType.title,
        }).trim()
      : '';
  const at = nowIso(ctx);
  const invitee: Booking['invitee'] = { name: input.name, email: input.email, timezone: input.timezone };
  if (input.phone) invitee.phone = input.phone;
  if (input.locale) invitee.locale = input.locale;
  // A record that got its time back keeps its own marker: the follow-up below is the one it never had.
  const marker = orphan?.followUp ?? newFollowUp(ctx, 'created');
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
    followUp: marker,
    source: input.source,
    timeline: [{ at, type: 'created', detail: input.source === 'embed' ? 'Booked through an embedded page' : 'Booked from the booking page' }],
    createdAt: at,
    updatedAt: at,
  };
  if (input.utm) record.utm = input.utm;
  // The look it is booked in. Every page and message about it keeps that look, whatever happens to the event later.
  if (isBrandId(eventType.brandId)) record.brandId = eventType.brandId;

  let written: { created: boolean; booking: Booking };
  if (orphan) {
    written = { created: true, booking: orphan };
  } else {
    try {
      // Create-only: two tries of the same request (same key, same id) that both got through the index
      // write one record between them, and the second hands back the first one's booking.
      written = await createBookingRecord(ctx, record);
    } catch (err) {
      // The write may have gone through with only its answer lost (and the read that checks for that failed
      // too). A record that is on file keeps its time. Only one that is surely not there gives the time back,
      // and when even that cannot be told the entry stays: reconcileBookings removes one that never gets a
      // record, and finishes the follow-up of one that has it.
      const onFile = await getBooking(ctx, id).catch(() => undefined);
      if (onFile && sameRequest(onFile, eventType, input) && onFile.followUp?.id === marker.id) {
        written = { created: true, booking: onFile };
      } else if (onFile && sameRequest(onFile, eventType, input)) {
        written = { created: false, booking: onFile };
      } else {
        if (onFile === null) {
          await quietly(ctx, 'releasing the time of a booking that could not be saved', id, () =>
            mutateBookingIndex(ctx, (entries) => (entries.some((e) => e.id === id && e.req === mark) ? entries.filter((e) => !(e.id === id && e.req === mark)) : { abort: 'gone' })),
          );
        }
        return notMade(err);
      }
    }
  }
  if (!written.created) {
    await refundAll();
    if (sameRequest(written.booking, eventType, input)) return alreadyBooked(ctx, written.booking);
    throw stillSaving();
  }

  // Steps 6 and 7: the calendar, then the confirmation and the reminders. From here on nothing may fail the
  // request: the booking exists. What does not get done now is finished later (the record says so).
  const followed = await followUpBooking(ctx, id, marker, eventType, { calendarMode: 'reconcile', calendarBudgetMs: calendarBudget(ctx, startedMs, opts), fallback: record, note: true });
  runImmediateJobs(ctx, id, followed.pending);

  return { booking: (await getBooking(ctx, id).catch(() => null)) ?? followed.booking, manageToken: manageToken(ctx, id) };
}

async function addTimeline(ctx: Ctx, bookingId: string, type: string, detail?: string): Promise<void> {
  const entry = { at: nowIso(ctx), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) };
  await updateBooking(ctx, bookingId, (b) => ({ ...b, timeline: [...(b.timeline ?? []), entry] }));
}

// ───────────────────────── follow-up work ─────────────────────────
//
// A change is committed in one save (the record says created, moved or cancelled). What has to happen
// after it (the calendar, the reminders, the notices) can be cut off by a storage error or the end of the
// request. So the same save writes a `followUp` marker, the marker comes off once that work is done, and
// reconcileBookings (or a repeated cancellation) finishes whatever still carries one. Every step can run
// twice: the calendar sync adopts or re-applies its own event, and each message is guarded by a claim.

type FollowUp = NonNullable<Booking['followUp']>;

function newFollowUp(ctx: Ctx, kind: FollowUp['kind'], by?: FollowUp['by'], newHostIds?: string[]): FollowUp {
  return { kind, id: randomId('fu'), at: nowIso(ctx), ...(by ? { by } : {}), ...(newHostIds?.length ? { newHostIds: [...newHostIds] } : {}) };
}

/** Hosts a move hands the meeting to: on the booking now, not before. */
function joinedHosts(before: string[], after: string[]): string[] {
  return after.filter((id) => !before.includes(id));
}

/** Takes the marker off once its work is done. A newer marker (a later change) stays. */
async function clearFollowUp(ctx: Ctx, bookingId: string, marker: FollowUp): Promise<void> {
  await updateBooking(ctx, bookingId, (b) => {
    if (b.followUp?.id !== marker.id) return b;
    const { followUp: _done, ...rest } = b;
    return rest;
  });
}

function followUpIsStale(marker: FollowUp | undefined, nowMs: number): marker is FollowUp {
  const at = Date.parse(marker?.at ?? '');
  return !!marker && Number.isFinite(at) && at <= nowMs - FOLLOW_UP_GRACE_MS;
}

/** Reminders and the messages that go out right away. One more try after a storage hiccup. */
async function scheduleMessages(ctx: Ctx, booking: Booking, eventType: EventType, kind: 'created' | 'rescheduled', by?: FollowUp['by'], newHostIds?: string[]): Promise<boolean> {
  const options = by || newHostIds?.length ? { ...(by ? { by } : {}), ...(newHostIds?.length ? { newHostIds } : {}) } : undefined;
  if (await quietly(ctx, 'scheduling the messages', booking.id, () => scheduleBookingJobs(ctx, booking, eventType, kind, options))) return true;
  return quietly(ctx, 'scheduling the messages again', booking.id, () => scheduleBookingJobs(ctx, booking, eventType, kind, options));
}

/**
 * The work after a booking was made or moved: the calendar, then the reminders and the messages that go
 * out right away. With `note`, a failure to queue the messages is written on the timeline.
 */
async function followUpBooking(
  ctx: Ctx,
  bookingId: string,
  marker: FollowUp,
  eventType: EventType | null,
  p: { calendarMode: SyncMode; calendarBudgetMs: number; fallback: Booking; note: boolean },
): Promise<{ pending?: Promise<unknown>; booking: Booking; done: boolean }> {
  const calendar = await calendarStep(ctx, bookingId, p.calendarMode, p.calendarBudgetMs);
  const current = (await getBooking(ctx, bookingId).catch(() => null)) ?? p.fallback;
  // The event type is gone: there are no rules to plan reminders from, and nothing more can be done.
  if (eventType && current.status === 'confirmed') {
    const kind = marker.kind === 'created' ? 'created' : 'rescheduled';
    if (!(await scheduleMessages(ctx, current, eventType, kind, marker.by, marker.newHostIds))) {
      if (p.note) {
        const detail = kind === 'created' ? 'The confirmation and reminders could not be queued yet. They are tried again shortly.' : 'The messages about the new time could not be queued yet. They are tried again shortly.';
        await quietly(ctx, 'the timeline note', bookingId, () => addTimeline(ctx, bookingId, 'messages_not_scheduled', detail));
      }
      return { ...calendar, booking: current, done: false };
    }
  }
  await quietly(ctx, 'clearing the follow-up marker', bookingId, () => clearFollowUp(ctx, bookingId, marker));
  return { ...calendar, booking: current, done: true };
}

/**
 * The work after a cancellation: give the time back, take the event out of Google Calendar, drop the
 * reminders, tell people. Everything is read from the record, so a later run does exactly what the first
 * one would have done. Returns whether all of it is done.
 */
async function followUpCancellation(ctx: Ctx, booking: Booking, marker: FollowUp, p: { calendarMode: SyncMode; calendarBudgetMs: number }): Promise<boolean> {
  const id = booking.id;
  const freed = await quietly(ctx, 'freeing the time of a cancelled booking', id, async () => {
    const done = await mutateBookingIndex(ctx, (entries) =>
      entries.some((e) => e.id === id && e.status !== 'cancelled') ? entries.map((e) => (e.id === id ? { ...e, status: 'cancelled' as const } : e)) : { abort: 'already_free' },
    );
    if (!done.ok && done.reason !== 'already_free') throw new Error(`index update failed (${done.reason})`);
  });
  if (booking.google) await calendarStep(ctx, id, p.calendarMode, p.calendarBudgetMs);
  const unplanned = await quietly(ctx, 'removing the reminders of a cancelled booking', id, () => cancelBookingJobs(ctx, id));
  const told = await quietly(ctx, 'queueing the cancellation messages', id, () => queueCancelledMessages(ctx, booking));
  if (!(freed && unplanned && told)) return false;
  await quietly(ctx, 'clearing the follow-up marker', id, () => clearFollowUp(ctx, id, marker));
  return true;
}

// ───────────────────────── cancel ─────────────────────────

const CANCELLED_BY: Record<'invitee' | 'host' | 'assistant' | 'host_link' | 'owner_page', string> = {
  invitee: 'Cancelled by the invitee',
  host: 'Cancelled by the host',
  assistant: 'Cancelled by the invitee on the reminder call, after confirming twice',
  host_link: 'Cancelled by a host, from the booking page',
  owner_page: 'Cancelled by the owner, from the booking page',
};

/**
 * Cancels a booking. Calling it again changes nothing and sends nothing, except that work the first call
 * did not get to (it was cut off) is finished then. The invitee can cancel until the meeting starts and the
 * assistant (acting for the invitee on a call) until it ends; a host always can. Whoever calls this has
 * already checked the manage token or the admin session.
 *
 * `actor: 'host'` comes from the booking page opened through a host's link. The invitee holds the same
 * link, so it grants nothing: the invitee's deadline still applies. It only decides how the cancellation is
 * recorded and announced (by a host, and the invitee is told by text as well).
 *
 * `by: 'host', actor: 'owner'`: the same page, with the owner signed in to the dashboard in that browser
 * (the route checked the session). That is the owner acting, exactly as in the dashboard: no deadline, and
 * the owner is not sent a notice of their own cancellation. Only the timeline says where it was done.
 */
export async function cancelBooking(
  ctx: Ctx,
  bookingId: string,
  p: { by: 'invitee' | 'host' | 'assistant'; reason?: string; actor?: 'invitee' | 'host' | 'owner' },
  opts?: BookingActionOptions,
): Promise<Booking> {
  registerBookingJobHandlers();
  const nowMs = ctx.now().getTime();
  const existing = await getBooking(ctx, bookingId);
  if (!existing) throw notFound();
  if (existing.status === 'cancelled') {
    // Work the first request left behind is finished now, unless that request may still be running.
    const marker = existing.followUp;
    if (marker?.kind !== 'cancelled' || !(Date.parse(marker.at) <= nowMs - REQUEST_CEILING_MS)) return existing;
    await followUpCancellation(ctx, existing, marker, { calendarMode: 'push', calendarBudgetMs: calendarBudget(ctx, nowMs, opts) });
    runImmediateJobs(ctx, bookingId);
    return (await getBooking(ctx, bookingId).catch(() => null)) ?? existing;
  }

  const by = p.by === 'host' || p.by === 'assistant' ? p.by : 'invitee';
  const viaHostLink = by === 'invitee' && p.actor === 'host';
  const recordedBy = viaHostLink ? 'host' : by;
  const timelineText = CANCELLED_BY[viaHostLink ? 'host_link' : by === 'host' && p.actor === 'owner' ? 'owner_page' : by];
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
  const marker = newFollowUp(ctx, 'cancelled', recordedBy);
  let changed = false;
  const saved = await updateBooking(ctx, bookingId, (b) => {
    if (b.status === 'cancelled') {
      // Already cancelled: by somebody else, or by this very request (its save went through, its answer was
      // lost and something else wrote to the record meanwhile). Its own marker tells the two apart.
      changed = b.followUp?.id === marker.id;
      return b;
    }
    changed = true;
    const cancellation: NonNullable<Booking['cancellation']> = { at, by: recordedBy };
    if (reason) cancellation.reason = reason;
    if (viaHostLink) cancellation.via = 'host_link';
    return {
      ...b,
      status: 'cancelled',
      cancellation,
      // Until Google has been told, the booking says so. A request cut off before that is then still
      // repaired: reconcileBookings requeues the calendar work of every booking that carries a problem.
      google: b.google ? { ...b.google, error: CALENDAR_PENDING } : b.google,
      followUp: marker,
      timeline: [...(b.timeline ?? []), { at, type: 'cancelled', detail: reason ? `${timelineText}: ${reason}`.slice(0, 400) : timelineText }],
    };
  });
  if (!saved) throw notFound();
  // Someone else cancelled it a moment ago: they do the follow-up work, once (or reconcileBookings does).
  if (!changed) return saved;

  // The record says cancelled. Only now is the time given back.
  await followUpCancellation(ctx, saved, marker, { calendarMode: 'push', calendarBudgetMs: calendarBudget(ctx, nowMs, opts) });
  runImmediateJobs(ctx, bookingId);

  return (await getBooking(ctx, bookingId).catch(() => null)) ?? saved;
}

/**
 * Queues the cancellation notices. Each one is claimed by name before it is queued (and the claim is given
 * back when the write fails), so a second run after an interruption sends nothing twice.
 */
async function queueCancelledMessages(ctx: Ctx, booking: Booking): Promise<void> {
  const by = booking.cancellation?.by ?? 'invitee';
  const fromDashboard = by === 'host' && booking.cancellation?.via !== 'host_link';
  const site = await getSite(ctx);
  const assigned = pickHosts(booking.hostIds, hostsById(await listHosts(ctx)));
  const base = { type: 'message' as const, kind: 'cancelled' as const, bookingId: booking.id, dueAt: nowIso(ctx) };
  const work: Promise<unknown>[] = [];
  const queue = (target: { channel: 'email' | 'sms'; audience: 'invitee' | 'host'; hostId?: string }): void => {
    work.push(
      (async () => {
        const once = `sched-${booking.id}-cancelled-${target.channel}-${target.audience}-${target.hostId ?? 'invitee'}`;
        if (!(await claim(ctx, once))) return;
        try {
          // The id comes from the claim, so a copy queued again after an unclear failed write is the same job.
          await enqueueJob(ctx, { ...base, ...target }, { id: `job_${sha256Hex(once).slice(0, 20)}` });
        } catch (err) {
          await releaseClaim(ctx, once).catch(() => undefined);
          throw err;
        }
      })(),
    );
  };

  if (isEmail(booking.invitee.email)) queue({ channel: 'email', audience: 'invitee' });
  // Someone who cancelled on the page a second ago does not need a text about it as well.
  if (by !== 'invitee' && booking.invitee.phone && booking.consent?.sms === true) queue({ channel: 'sms', audience: 'invitee' });

  for (const host of assigned) {
    // The dashboard belongs to the owner: when a host cancels there, the owner already knows. A cancellation
    // through a host's link may have been made by any host (or by the invitee, who holds the same link).
    if (fromDashboard && host.id === site.ownerHostId) continue;
    if (isEmail(host.email) && host.notify?.email !== false) queue({ channel: 'email', audience: 'host', hostId: host.id });
    if (host.phone?.trim() && host.notify?.sms === true) queue({ channel: 'sms', audience: 'host', hostId: host.id });
  }
  const failed = (await Promise.allSettled(work)).find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
}

// ───────────────────────── reschedule ─────────────────────────

/**
 * Moves a booking to a new start time, keeping its length and its hosts. The same checks as a new
 * booking apply, except that the booking's own time counts as free. The invitee can move a meeting
 * until it starts, a limited number of times. Whoever calls this has already checked the manage token
 * or the admin session.
 *
 * `actor: 'host'` comes from the booking page opened through a host's link. The invitee holds the same
 * link, so it grants nothing (the invitee's deadline and limits still apply). It only keeps the host's
 * own time zone off the invitee, words the timeline, and has the invitee told by text as well.
 *
 * `by: 'host'` is the owner (the route checked the session; `actor: 'owner'` says it was done on the booking
 * page). None of the invitee's limits apply: no deadline, no cap on moves, no hourly limit. The new time
 * itself still has to pass the same checks as any booking (hours, notice, calendars, other bookings). The
 * owner is not sent a "moved" notice of their own move; co-hosts and the invitee are told as always.
 */
export async function rescheduleBooking(
  ctx: Ctx,
  bookingId: string,
  p: { startIso: string; by: 'invitee' | 'host'; timezone?: IanaZone; actor?: 'invitee' | 'host' | 'owner' },
  opts?: BookingActionOptions,
): Promise<Booking> {
  registerBookingJobHandlers();
  const booking = await getBooking(ctx, bookingId);
  if (!booking) throw notFound();
  if (booking.status !== 'confirmed') throw new HttpError(410, 'cancelled', 'This booking was cancelled, so it cannot be moved. Please book a new time.');

  const nowMs = ctx.now().getTime();
  const by = p.by === 'host' ? 'host' : 'invitee';
  const actor = by === 'host' || p.actor === 'host' ? 'host' : 'invitee';
  if (by === 'invitee' && !(Date.parse(booking.start) > nowMs)) {
    throw new HttpError(410, 'too_late', 'This meeting has already started, so it can no longer be moved.');
  }
  if (by === 'invitee' && movesOnThePage(booking) >= MAX_SELF_SERVICE_MOVES) {
    throw new HttpError(
      409,
      'move_limit',
      actor === 'host'
        ? `This meeting has been moved ${MAX_SELF_SERVICE_MOVES} times already, so it cannot be moved again from this link. The owner can still move it here while signed in to the dashboard in this browser. Or cancel it and ask the invitee to book a new time.`
        : `This meeting has been moved ${MAX_SELF_SERVICE_MOVES} times already, so it cannot be moved again from this page. Please get in touch with your host to change it.`,
    );
  }
  if (!isIsoInstant(p.startIso)) throw new HttpError(422, 'invalid', 'Please pick a new time.', { start: 'Please pick a time.' });
  const startMs = Date.parse(p.startIso);
  const endMs = startMs + booking.durationMin * MINUTE_MS;
  if (startMs === Date.parse(booking.start)) {
    // Its own code: a retry of a move whose answer was lost lands here, and the page then shows the move as made.
    throw new HttpError(422, 'same_time', 'That is the time you already have. Pick a different one to move your meeting.', { start: 'This is your current time.' });
  }

  const s = await loadScheduling(ctx);
  const eventType = s.eventTypes.find((e) => e.id === booking.eventTypeId) ?? null;
  if (!eventType || eventType.active !== true) {
    throw new HttpError(410, 'not_available', 'This meeting type is not taking bookings right now, so the meeting cannot be moved here. Please get in touch with your host.');
  }
  const plan = planFor(eventType, booking, s.byId);
  if (plan.hosts.length === 0) throw slotTaken('outside_hours');

  const pad = Math.max(DAY_MS, bufferPadMs(eventType));
  const external = await loadExternalBusy(ctx, plan.eventType.kind, plan.hosts, { start: startMs - pad, end: endMs + pad }, true, opts?.calendarReadBudgetMs ?? BOOKING_READ_BUDGET_MS);
  if (external.failed.length > 0) {
    await quietly(ctx, 'the calendar alert', bookingId, () => alertCalendarTrouble(ctx, external.failed, { eventTitle: eventType.title }));
  }
  if (external.timedOut) await quietly(ctx, 'the slow calendar note', bookingId, () => reportSlowCalendars(ctx, external.slow ?? [], { eventTitle: eventType.title, bookingId }, external.slowSources));
  if (external.blocked) throw calendarUnavailable('move');

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
  if (!first.ok) {
    // As in createBooking: the list this time came from is out of date.
    if (first.reason === 'busy') await forgetHostBusy(ctx, plan.hosts.map((h) => h.id));
    if (unknownBecauseUnread(external, first.reason)) throw calendarUnavailable('move');
    throw slotTaken(first.reason);
  }

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const seen = query.index.find((e) => e.id === booking.id) ?? null;
  // The record was read before the index. When they disagree, another move of this booking is in flight
  // (or waits for reconcileBookings to finish it): step aside now, before this request changes anything.
  // Two requests that both read before either swapped are kept apart by the check inside the swap.
  if (seen && seen.status === 'confirmed' && (seen.start !== booking.start || seen.end !== booking.end)) throw changedElsewhere();

  if (by === 'invitee') {
    // Counted here, once the new time has been found free: a visitor who picked a time that turned out to be
    // taken does not lose a move. Every move sends emails (and changes the Google event for every guest).
    try {
      await rateLimit(ctx, 'move-booking', booking.id, MOVES_PER_BOOKING_PER_HOUR, HOUR_SEC);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 429) throw err;
      throw new HttpError(429, 'move_limit', 'This meeting has been moved a few times in the last hour. Please wait an hour before moving it again.', undefined, err.headers);
    }
  }
  let assigned: string[] = [];

  // The index is the commit point. It only moves an entry that is still where this request found it,
  // so two moves of the same booking, or a move racing a cancellation, cannot both go through.
  const moved = await mutateBookingIndex(ctx, (entries) => {
    const mine = entries.find((e) => e.id === booking.id) ?? null;
    if (mine && mine.status !== 'confirmed') return { abort: 'cancelled' };
    // The entry already holds this very move, from where this request found it: its own write, whose answer
    // was lost while somebody else wrote to the index, or a twin request asking for the same move. The move
    // is in place; the record below follows it (and a twin is not counted twice there).
    if (mine && seen && mine.start === startIso && mine.end === endIso && seen.start === booking.start && seen.end === booking.end) {
      assigned = [...mine.hostIds];
      return { abort: 'in_place' };
    }
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
  if (!moved.ok && moved.reason !== 'in_place') {
    if (moved.reason === 'contention') throw new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
    if (moved.reason === 'cancelled') throw new HttpError(410, 'cancelled', 'This booking was cancelled, so it cannot be moved. Please book a new time.');
    if (moved.reason === 'changed') throw changedElsewhere();
    throw slotTaken(moved.reason as SlotRejection);
  }

  const at = nowIso(ctx);
  // Only the invitee's own device says where the invitee is. A host moving the meeting is somewhere else.
  const timezone = actor === 'invitee' && typeof p.timezone === 'string' && isZone(p.timezone.trim()) ? p.timezone.trim() : null;
  const who = by === 'host' ? (p.actor === 'owner' ? 'by the owner, from the booking page' : 'by the host') : actor === 'host' ? 'by a host, from the booking page' : 'by the invitee';
  const movedFrom = `Moved from ${formatInZone(Date.parse(booking.start), s.ownerTimezone, 'full')} ${who}`;
  // A round robin booking whose host has left goes to a colleague: for them it is a new booking. The owner's own
  // move is marked as theirs, so they are not sent a notice of it (a host's link could be any host's).
  const marker = newFollowUp(ctx, 'rescheduled', by === 'host' ? 'owner' : actor, joinedHosts(booking.hostIds, assigned));
  let applied = false;
  let twin = false;
  let saved: Booking | null = null;
  try {
    saved = await updateBooking(ctx, bookingId, (b) => {
      if (b.status !== 'confirmed') {
        applied = false;
        return b;
      }
      applied = true;
      // Our own write, run again because its answer was lost while something else wrote to the record: the
      // move is ours, and so is its follow-up.
      if (b.followUp?.id === marker.id) {
        twin = false;
        return b;
      }
      // A second request that asked for the very same move at the same moment, and was let through by the
      // index because the list it wanted was already in place: the move is done, it is not counted twice.
      twin = b.start === startIso && b.end === endIso && b.rescheduledFromStart === booking.start;
      if (twin) return b;
      const pageMoves = movesOnThePage(b);
      return {
        ...b,
        start: startIso,
        end: endIso,
        hostIds: [...assigned],
        invitee: timezone ? { ...b.invitee, timezone } : b.invitee,
        rescheduledFromStart: b.start,
        // Every move, for the calendar files (SEQUENCE). The moves made on the booking page are counted
        // apart: the owner's own moves do not use up the ones the page allows.
        rescheduleCount: (b.rescheduleCount ?? 0) + 1,
        inviteeMoves: by === 'invitee' ? pageMoves + 1 : pageMoves,
        attendance: {},
        followUp: marker,
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
  // The request that made the move does the follow-up work (or reconcileBookings does).
  if (twin) return saved;

  const followed = await followUpBooking(ctx, bookingId, marker, eventType, { calendarMode: 'push', calendarBudgetMs: calendarBudget(ctx, nowMs, opts), fallback: saved, note: true });
  runImmediateJobs(ctx, bookingId, followed.pending);
  return (await getBooking(ctx, bookingId).catch(() => null)) ?? followed.booking;
}

/**
 * Moves made on the booking page (by the invitee, or through a host's link, which the invitee holds as
 * well), which the cap of MAX_SELF_SERVICE_MOVES counts. A booking saved before they were counted apart
 * reads as all of its moves, which is the safe side.
 */
function movesOnThePage(b: Booking): number {
  const n = Number.isFinite(b.inviteeMoves) ? (b.inviteeMoves as number) : (b.rescheduleCount ?? 0);
  return Math.max(0, Math.trunc(n));
}

function changedElsewhere(): HttpError {
  return new HttpError(409, 'changed', 'This booking was just changed somewhere else. Please wait a few minutes, then reload the page to see where it stands.');
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

/** Id of the Google event of a booking (invite.ts). */
export { calendarEventIdFor };

/** Whether the host's main account (where new meetings go) works. */
function usable(host: Host | null | undefined): host is Host {
  return mainOf(host)?.account.status === 'ok';
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

/** The booking in the dashboard. Only the signed-in owner can open it; from the calendar it is one click to the answers. */
function dashboardLink(ctx: Ctx, bookingId: string): string {
  return `${ctx.env.publicBaseUrl.replace(/\/+$/, '')}/admin/bookings?b=${encodeURIComponent(bookingId)}`;
}

/**
 * Where, in words the owner chose: the join link, the owner's address or number, or only the kind of place.
 * A host calling the invitee carries the invitee's number, and a place the invitee named is their own text.
 */
function neutralWhere(location: BookingLocation): string {
  if (location.joinUrl) return location.joinUrl;
  if (location.type === 'phone_host_calls' || location.type === 'ask_invitee') return (location.label ?? '').trim();
  return whereLine(location);
}

/**
 * The event's description. Google emails it to every attendee, from the organiser's own account.
 *
 * `outsiders`: the invitee and any guests are on the event (Google invites them, invite.ts). Their addresses
 * are whatever the visitor typed, so nothing long the visitor wrote may ride along. With guests the
 * description holds facts nobody but the owner wrote (the meeting, the hosts, where): no answers, no phone
 * number, no manage link. Without guests it says who booked, the phone number and the manage link, which go
 * to the invitee's own address; the answers stay in the host emails and the dashboard. Google mails the
 * description to them, so the dashboard link (only the owner can open it) stays out while they are on the
 * event: the owner reaches the booking from the host email and the dashboard. When only the hosts are on
 * the event, it carries everything, the dashboard link too, and its manage link is a host's link
 * (`as=host`): whoever opens it from the calendar is a host, whose browser's zone must not become the
 * invitee's. While the invitee is on the event the plain link stays, since on a site that sends no email it
 * may be their only copy.
 */
/** The brand line first, then the description (escaped: Google renders the description as HTML). */
function withBrandLine(line: string | null, description: string): string {
  return line ? `${escapeForCalendar(line)}\n\n${description}` : description;
}

/**
 * Said in Google's invitation to an invitee whose booking page told them to add the meeting by hand (no email
 * could carry an invitation and no Google event existed then): the copy they made that way can go.
 */
export const HAND_ADDED_NOTE = 'If you added this meeting to your calendar yourself from the booking page, you can delete that copy now. This invitation keeps itself up to date.';

function calendarDescription(ctx: Ctx, booking: Booking, assigned: Host[], outsiders: boolean, handAdded = false): string {
  const dashboard = `Booking details in the dashboard: ${dashboardLink(ctx, booking.id)}`;
  const note = outsiders && handAdded ? ['', HAND_ADDED_NOTE] : [];
  if (outsiders && booking.guests.length > 0) {
    const hosts = joinNames(assigned.map((h) => h.name.trim()).filter(Boolean));
    const lines = [escapeForCalendar(hosts ? `${booking.eventTitle} with ${hosts}` : booking.eventTitle)];
    const where = booking.location.type === 'google_meet' && !booking.location.joinUrl ? '' : neutralWhere(booking.location);
    if (where) lines.push(`Where: ${escapeForCalendar(where)}`);
    lines.push(...note);
    return lines.join('\n');
  }
  const lines = [`Booked by ${escapeForCalendar(booking.invitee.name)} (${escapeForCalendar(booking.invitee.email)})`];
  if (booking.invitee.phone) lines.push(`Phone: ${escapeForCalendar(booking.invitee.phone)}`);
  if (booking.guests.length > 0) lines.push(`Guests: ${escapeForCalendar(booking.guests.join(', '))}`);
  if (booking.location.type !== 'google_meet') lines.push(`Where: ${escapeForCalendar(whereLine(booking.location))}`);
  // Answers are free text of any length. Google mails the description to the invitee's address too, which
  // the visitor chose, so the answers only go in when nobody but the hosts is on the event. The hosts read
  // them in their own email and in the dashboard.
  const answers = outsiders ? [] : booking.answers.filter((a) => a.value.trim() !== '');
  if (answers.length > 0) {
    lines.push('');
    for (const a of answers) {
      const label = a.label.trim();
      lines.push(`${escapeForCalendar(label)}${/[?!.:]$/.test(label) ? '' : ':'} ${escapeForCalendar(a.value.trim())}`);
    }
  }
  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  const asHost = outsiders ? '' : '&as=host';
  lines.push('', `Reschedule or cancel: ${base}/booking/${encodeURIComponent(booking.id)}?t=${manageToken(ctx, booking.id)}${asHost}`);
  if (!outsiders) lines.push(dashboard);
  lines.push(...note);
  return lines.join('\n');
}

/**
 * `site`: the stored settings. A booking made under a brand gets its brand line on top of the description.
 * `opts.invitee`: whether the invitee and guests go on the event, so that Google invites them (invite.ts).
 * Without it the event type's setting says, as it did before the booking kept its own record.
 * `opts.handAdded`: the invitee's booking page told them to add the meeting by hand (HAND_ADDED_NOTE).
 */
export function calendarEventInput(
  ctx: Ctx,
  booking: Booking,
  eventType: EventType | null,
  organizer: Host,
  assigned: Host[],
  site?: SiteSettings,
  opts?: { invitee?: boolean; handAdded?: boolean },
): CalendarEventInput {
  // With guests Google writes to addresses the visitor chose: nothing they typed goes into what it sends (see calendarDescription).
  const withGuests = booking.guests.length > 0;
  const outsiders = opts?.invitee ?? eventType?.googleInvite !== false;
  const attendees: CalendarEventInput['attendees'] = [];
  for (const host of assigned) {
    if (host.id === organizer.id) continue;
    const email = host.google?.email || host.email;
    if (isEmail(email)) attendees.push({ email, name: host.name, accepted: true });
  }
  // The invitee and guests are only put on the event (and emailed by Google) when Google is the one inviting them.
  if (outsiders) {
    attendees.push(withGuests ? { email: booking.invitee.email, accepted: true } : { email: booking.invitee.email, name: booking.invitee.name, accepted: true });
    for (const guest of booking.guests) attendees.push({ email: guest });
  }
  const people = joinNames(withGuests ? assigned.map((h) => h.name) : [booking.invitee.name, ...assigned.map((h) => h.name)]);
  const input: CalendarEventInput = {
    summary: people ? `${booking.eventTitle}: ${people}` : booking.eventTitle,
    description: withBrandLine(site ? brandLineFor(ctx, site, booking) : null, calendarDescription(ctx, booking, assigned, outsiders, opts?.handAdded === true)),
    startIso: booking.start,
    endIso: booking.end,
    timezone: isValidZone(organizer.timezone) ? organizer.timezone : 'UTC',
    attendees,
    createMeet: booking.location.type === 'google_meet',
    bookingId: booking.id,
    notifyAttendees: true,
  };
  if (booking.location.type !== 'google_meet') input.location = withGuests ? neutralWhere(booking.location) : whereLine(booking.location);
  return input;
}

function describeGoogleError(err: unknown): { message: string; retry: boolean } {
  // Both error classes only carry wording written in google.ts: no tokens, no response bodies.
  if (err instanceof GoogleAuthError) return { message: err.message || CALENDAR_RECONNECT, retry: false };
  if (err instanceof GoogleApiError) return { message: err.message, retry: true };
  return { message: 'Google Calendar could not be updated.', retry: true };
}

/**
 * Writes a calendar problem onto the booking. The timeline gets one line per distinct problem, not one per
 * retry. A first write that failed records the account it was made through, so a retry stays on it.
 */
async function noteCalendarError(ctx: Ctx, bookingId: string, organizer: AccountRef | null, message: string, type = 'calendar_sync_failed'): Promise<void> {
  const at = nowIso(ctx);
  await updateBooking(ctx, bookingId, (b) => {
    const current = b.google ?? null;
    if (!current && !organizer) return b;
    const google: NonNullable<Booking['google']> = {
      hostId: current?.hostId ?? organizer!.host.id,
      calendarId: current?.calendarId ?? (organizer!.account.writeCalendarId || 'primary'),
      eventId: current?.eventId ?? '',
      ...(!current && organizer ? { accountId: organizer.account.id, accountEmail: organizer.account.email } : {}),
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

async function failSync(ctx: Ctx, bookingId: string, organizer: AccountRef | null, err: unknown): Promise<SyncOutcome> {
  const { message, retry } = describeGoogleError(err);
  ctx.log('warn', 'booking: Google Calendar could not be updated', { bookingId, hostId: organizer?.host.id, accountId: organizer?.account.id, error: message });
  await noteCalendarError(ctx, bookingId, organizer, message);
  return { status: 'failed', error: message, retry };
}

/** "jimi@gmail.example needs to be reconnected." */
function reconnectError(ref: AccountRef): GoogleAuthError {
  return new GoogleAuthError(`${ref.account.email} needs to be reconnected.`);
}

/** Where a booking's event is, after looking. */
export type Holder =
  /** this account holds it: by its stored id, or because a read just found our booking in it */
  | { kind: 'found'; ref: AccountRef; checked: boolean }
  /** every account of the host answered and none has it */
  | { kind: 'none' }
  /** an account that may have it needs reconnecting */
  | { kind: 'reconnect'; ref: AccountRef }
  /** an account that may have it could not be asked (a timeout, an error): try again later */
  | { kind: 'unreachable'; ref: AccountRef; err: unknown };

/**
 * Finds the account holding a booking's event (see googleAccounts.holderCandidates). An account named by
 * the booking is trusted. Any other is read first, with a GET that tells nobody, and only counts when the
 * event it returns carries our booking id. Nothing is ever written through a guessed account. Also used by
 * the dashboard's delete (admin/bookings.ts), for one more try at an event that was left behind.
 */
export async function findHolder(ctx: Ctx, booking: Booking, g: NonNullable<Booking['google']>, host: Host | null): Promise<Holder> {
  const { trusted, candidates } = holderCandidates(host, g);
  if (trusted) return trusted.account.status === 'ok' ? { kind: 'found', ref: trusted, checked: false } : { kind: 'reconnect', ref: trusted };
  const eventId = g.eventId || calendarEventIdFor(booking.id);
  const answers = await Promise.all(
    candidates.map(async (ref) => {
      try {
        const got = await googleGetEvent(ctx, ref, g.calendarId || 'primary', eventId);
        return { ref, hit: got.status === 200 && got.bookingId === booking.id, err: null as unknown };
      } catch (err) {
        return { ref, hit: false, err };
      }
    }),
  );
  const hit = answers.find((a) => a.hit);
  if (hit) return { kind: 'found', ref: hit.ref, checked: true };
  const failed = answers.find((a) => a.err !== null);
  if (failed) {
    if (failed.err instanceof GoogleAuthError) return { kind: 'reconnect', ref: failed.ref };
    return { kind: 'unreachable', ref: failed.ref, err: failed.err };
  }
  // An account that cannot be asked right now may be the one: wait for it instead of giving up on the event.
  const waiting = host ? accountsOf(host).find((a) => a.account.status !== 'ok') : undefined;
  if (waiting) return { kind: 'reconnect', ref: waiting };
  return { kind: 'none' };
}

/** The booking stamped with the account a read found its event in. */
function stampedWith(google: NonNullable<Booking['google']>, ref: AccountRef): NonNullable<Booking['google']> {
  return { ...google, accountId: ref.account.id, accountEmail: ref.account.email };
}

/**
 * Nothing is written to Google for this booking any more: its event is in no account we can reach. The
 * invitee's next emails carry our own calendar file and say why (jobs.ts).
 */
async function detachBooking(ctx: Ctx, bookingId: string, type: string, detail: string, still?: (b: Booking) => boolean): Promise<Booking | null> {
  const at = nowIso(ctx);
  return updateBooking(ctx, bookingId, (b) =>
    b.google && !b.google.detached && (!still || still(b))
      ? { ...b, google: { ...withoutError(b.google), detached: true }, timeline: [...(b.timeline ?? []), { at, type, detail }] }
      : b,
  );
}

function gonePlace(g: NonNullable<Booking['google']>): string {
  return g.accountEmail ? `The event is in ${g.accountEmail}, which is no longer connected` : 'Google Calendar is no longer connected';
}

/** Whether the booking moved on (cancelled, moved) while Google was being told about an older state. */
function movedOn(saved: Booking | null, synced: Booking): boolean {
  return !!saved && (saved.status !== synced.status || saved.start !== synced.start || saved.end !== synced.end);
}

/**
 * The event of a booking sits on the calendar of a host who no longer has the meeting (a round robin booking
 * whose host has left went to a colleague when it was moved). It comes off that calendar, through the account
 * that holds it, with notice to the attendees, and the booking forgets it, so the caller writes it to a host
 * who has the meeting now. A calendar that cannot be reached any more is noted on the timeline. Returns a
 * failure only when trying again can help.
 */
async function leaveCalendarOf(ctx: Ctx, booking: Booking, g: NonNullable<Booking['google']>, holder: Host | null, at: string): Promise<SyncOutcome | null> {
  const name = holder?.name.trim() || 'a host';
  const where = g.accountEmail ? `${name} (${g.accountEmail})` : name;
  let entry: { at: string; type: string; detail: string } = {
    at,
    type: 'calendar_event_left',
    detail: holder && accountsOf(holder).length > 0 ? `The event could not be taken off the calendar of ${where}, which needs to be reconnected.` : 'The event could not be taken off the calendar of a host who is no longer connected.',
  };
  const found = g.detached ? ({ kind: 'none' } as Holder) : await findHolder(ctx, booking, g, holder);
  if (found.kind === 'unreachable') return failSync(ctx, booking.id, found.ref, found.err);
  if (found.kind === 'found') {
    try {
      await googleDeleteEvent(ctx, found.ref, g.calendarId || found.ref.account.writeCalendarId || 'primary', g.eventId || calendarEventIdFor(booking.id), true);
      entry = { at, type: 'calendar_event_removed', detail: `Taken off the Google Calendar of ${name}, who no longer hosts this meeting` };
    } catch (err) {
      // Waiting for a reconnect would keep the meeting off the new host's calendar for good: carry on without it.
      if (!(err instanceof GoogleAuthError)) return failSync(ctx, booking.id, found.ref, err);
    }
  }
  await updateBooking(ctx, booking.id, (b) => (b.google?.hostId === g.hostId ? { ...b, google: null, timeline: [...(b.timeline ?? []), entry] } : b));
  return null;
}

async function syncOnce(ctx: Ctx, bookingId: string, mode: SyncMode): Promise<SyncOutcome & { again?: boolean }> {
  const booking = await getBooking(ctx, bookingId);
  if (!booking) return { status: 'skipped' };
  const site = await getSite(ctx);
  const [hosts, eventType] = await Promise.all([listHosts(ctx), getEventType(ctx, booking.eventTypeId)]);
  const byId = hostsById(hosts);
  let g = booking.google ?? null;
  let known = g ? (byId.get(g.hostId) ?? null) : null;
  const at = nowIso(ctx);

  // ── a detached booking: its event is in no account we can reach, so nothing more goes to Google ──
  if (g?.detached) {
    if (g.error) await updateBooking(ctx, bookingId, (b) => (b.google ? { ...b, google: withoutError(b.google) } : b));
    return { status: 'skipped' };
  }

  // ── a confirmed booking whose event is with a host who no longer has it: off that calendar, onto the right one ──
  if (booking.status === 'confirmed' && g && !booking.hostIds.includes(g.hostId)) {
    const stuck = await leaveCalendarOf(ctx, booking, g, known, at);
    if (stuck) return stuck;
    g = null;
    known = null;
  }

  // ── a cancelled booking: its event has to go, through the account that holds it ──
  if (booking.status === 'cancelled') {
    if (!g) return { status: 'skipped' };
    if (mode === 'reconcile' && !g.error) return { status: 'unchanged' };
    const holder = await findHolder(ctx, booking, g, known);
    if (holder.kind === 'none') {
      // Nothing can reach that calendar any more. The invitee's cancellation email carries our own CANCEL file.
      await detachBooking(ctx, bookingId, 'calendar_event_left', `${gonePlace(g)}, so the event was not removed.`);
      return { status: 'skipped' };
    }
    if (holder.kind === 'reconnect') return failSync(ctx, bookingId, holder.ref, reconnectError(holder.ref));
    if (holder.kind === 'unreachable') return failSync(ctx, bookingId, holder.ref, holder.err);
    try {
      await googleDeleteEvent(ctx, holder.ref, g.calendarId || holder.ref.account.writeCalendarId || 'primary', g.eventId || calendarEventIdFor(booking.id), true);
    } catch (err) {
      return failSync(ctx, bookingId, holder.ref, err);
    }
    // Without a stored id the first write may still be on its way to Google (the cancellation came while it
    // was in flight), and an event it makes after this delete would stay on every calendar. Until that write
    // is surely over, the booking keeps its "not done yet" mark and the delete is tried again shortly. An
    // instance that stops in between leaves the mark behind, so the retry job (and reconcileBookings) still
    // finds the booking.
    const blind = !g.eventId;
    const recheck = blind && Date.parse(booking.cancellation?.at ?? '') > ctx.now().getTime() - BLIND_DELETE_WINDOW_MS;
    // A second look writes no second line on the timeline.
    const noted = blind && (booking.timeline ?? []).some((t) => t.type === 'calendar_event_removed');
    const saved = await updateBooking(ctx, bookingId, (b) => {
      if (!b.google) return b;
      // The late write was saved meanwhile: its event is the one to delete, and the next round does that.
      if (blind && b.google.eventId) return b;
      const google = { ...withoutError(holder.checked ? stampedWith(b.google, holder.ref) : b.google), syncedAt: at };
      return { ...b, google: recheck ? { ...google, error: CALENDAR_PENDING } : google, timeline: noted ? b.timeline : [...(b.timeline ?? []), { at, type: 'calendar_event_removed' }] };
    });
    if (blind && saved?.google?.eventId) return { status: 'synced', again: true };
    if (recheck) await quietly(ctx, 'queueing a second look at the removed event', bookingId, () => queueCalendarRetry(ctx, bookingId, RETRY_AFTER_FAILURE_MS));
    return { status: 'synced' };
  }

  // ── a confirmed booking that already has an event: keep its time right ──
  let recreateIn: AccountRef | null = null;
  if (g?.eventId) {
    if (mode === 'reconcile' && !g.error) return { status: 'unchanged' };
    const holder = await findHolder(ctx, booking, g, known);
    if (holder.kind === 'none') {
      // Never created anywhere else: a second invitation would reach every attendee. Emails carry the change.
      await detachBooking(ctx, bookingId, 'calendar_not_updated', `${gonePlace(g)}, so it was not changed. Change it in Google Calendar.`);
      return { status: 'skipped' };
    }
    if (holder.kind === 'reconnect') return failSync(ctx, bookingId, holder.ref, reconnectError(holder.ref));
    if (holder.kind === 'unreachable') return failSync(ctx, bookingId, holder.ref, holder.err);
    const ref = holder.ref;
    const linkMissing = booking.location.type === 'google_meet' && !booking.location.joinUrl;
    // Only the Meet link is outstanding: read it and change nothing, since every change emails each attendee.
    const onlyTheLink = mode === 'reconcile' && g.error === MEET_PENDING;
    // Google already holds this very time: we wrote it, nothing went wrong since, and the booking has not moved.
    // That is the case when the work after a move is finished again because its messages could not be queued
    // the first time. Changing the event again would email every attendee a second "updated" notice for nothing.
    // A booking that carries a problem is repaired the usual way, by writing the event again.
    const timeInPlace = !g.error && g.syncedStart === booking.start && g.syncedEnd === booking.end;
    const patch = !onlyTheLink && !timeInPlace;
    let gone = false;
    if (patch) {
      try {
        await googleUpdateEvent(ctx, ref, g.calendarId, g.eventId, {
          startIso: booking.start,
          endIso: booking.end,
          timezone: isValidZone(ref.host.timezone) ? ref.host.timezone : 'UTC',
          notifyAttendees: true,
        });
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) gone = true;
        else return failSync(ctx, bookingId, ref, err);
      }
    }
    let meetUrl: string | undefined;
    if (!gone && linkMissing) {
      try {
        meetUrl = (await googleGetEventLinks(ctx, ref, g.calendarId, g.eventId)).meetUrl;
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) gone = true;
        else return failSync(ctx, bookingId, ref, err);
      }
    }
    if (!gone) {
      // Nothing to change, nothing to fetch and nothing to clear: the event is in order as it is.
      if (!patch && !linkMissing && !g.error && !holder.checked) return { status: 'unchanged' };
      const stillMissing = linkMissing && !meetUrl;
      const pushed = { start: booking.start, end: booking.end };
      const saved = await updateBooking(ctx, bookingId, (b) => {
        if (!b.google) return b;
        const timeline = [...(b.timeline ?? [])];
        if (patch) timeline.push({ at, type: 'calendar_updated' });
        if (meetUrl) timeline.push({ at, type: 'meet_link_added', detail: 'Google finished creating the Meet link.' });
        return {
          ...b,
          google: {
            ...withoutError(holder.checked ? stampedWith(b.google, ref) : b.google),
            syncedAt: at,
            ...(patch ? { syncedStart: pushed.start, syncedEnd: pushed.end } : {}),
            ...(meetUrl ? { meetUrl } : {}),
            ...(stillMissing ? { error: MEET_PENDING } : {}),
          },
          location: b.location.type === 'google_meet' && meetUrl ? { ...b.location, joinUrl: meetUrl } : b.location,
          timeline,
        };
      });
      // Still no link: the retry job asks again (and tells the owner when it gives up, see gcalSyncJob).
      if (stillMissing) return { status: 'failed', error: MEET_PENDING, retry: true, again: movedOn(saved, booking) };
      return { status: patch || meetUrl ? 'synced' : 'unchanged', again: movedOn(saved, booking) };
    }
    // Someone deleted the event in Google. The account is proven to hold it (by its stored id, or the read
    // just now found it there), so it is created again below in that account, under the same id.
    recreateIn = ref;
  }

  // ── a confirmed booking without an event: create it ──
  let organizer: AccountRef | null = null;
  if (recreateIn) {
    organizer = recreateIn;
  } else if (g && known) {
    // An earlier attempt may have gone through without us hearing about it: stay on that account while it is there.
    const { trusted } = holderCandidates(known, g);
    const stay = trusted ?? (g.accountId ? null : mainOf(known));
    if (stay) {
      if (stay.account.status !== 'ok') return failSync(ctx, bookingId, stay, reconnectError(stay));
      organizer = stay;
    } else {
      // The account of the first attempt was removed meanwhile. That attempt may have reached Google.
      ctx.log('warn', 'booking: the account of an unfinished first calendar write is gone, choosing another', { bookingId, accountId: g.accountId });
    }
  }
  if (!organizer) {
    const host = chooseOrganizer(booking, byId, site);
    organizer = host ? mainOf(host) : null;
  }
  if (!organizer) {
    if (g?.error) await updateBooking(ctx, bookingId, (b) => (b.google ? { ...b, google: b.google.eventId ? withoutError(b.google) : null } : b));
    return { status: 'skipped' };
  }

  // Who invites the invitee is settled now at the latest, just before Google could. An invitee who already got
  // our own invitation (our email went out first) stays off the event: the hosts' calendars get it, and the
  // invitee keeps the one copy our files keep up to date (invite.ts).
  const decided = await settleInvite(ctx, bookingId, () => (eventType?.googleInvite !== false ? 'google' : 'file'));
  if (!decided) return { status: 'skipped' };
  const invitee = decided.inviteVia === 'google';
  // Decided only now, with no earlier attempt on the booking, after a confirmation that could not be emailed:
  // a booking made before Google was connected, written now. Its page told them to add the meeting by hand
  // (with no Google there it promised no invitation), so Google's invitation says that copy can go.
  const handAdded =
    invitee && !booking.inviteVia && !decided.google && (decided.timeline ?? []).some((t) => t.type === 'confirmation_email_skipped');
  const input = calendarEventInput(ctx, decided, eventType, organizer.host, pickHosts(booking.hostIds, byId), site, { invitee, handAdded });
  let created: Awaited<ReturnType<typeof googleCreateEvent>>;
  try {
    created = await googleCreateEvent(ctx, organizer, input, recreateIn && g?.calendarId ? { calendarId: g.calendarId } : undefined);
    // An event adopted from an earlier attempt still carries that attempt's time. One just made has the time
    // already: changing it again would send every attendee an "updated" notice right after the invitation.
    if (created.adopted && (booking.rescheduleCount ?? 0) > 0) {
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

  const organizerId = organizer.host.id;
  const organizerName = organizer.host.name;
  const account = { accountId: organizer.account.id, accountEmail: organizer.account.email };
  // Google creates Meet links asynchronously. One it has not finished yet is read again by the retry job.
  const linkPending = input.createMeet && !created.meetUrl;
  const saved = await updateBooking(ctx, bookingId, (b) => {
    const google: NonNullable<Booking['google']> = {
      hostId: organizerId,
      ...account,
      calendarId: created.calendarId,
      eventId: created.eventId,
      syncedAt: at,
      syncedStart: input.startIso,
      syncedEnd: input.endIso,
    };
    if (created.htmlLink) google.htmlLink = created.htmlLink;
    if (created.meetUrl) google.meetUrl = created.meetUrl;
    if (linkPending) google.error = MEET_PENDING;
    const timeline = [...(b.timeline ?? []), { at, type: 'calendar_synced', detail: `Added to the Google Calendar of ${organizerName}` }];
    if (linkPending && b.google?.error !== MEET_PENDING) timeline.push({ at, type: 'meet_link_pending', detail: MEET_PENDING });
    return {
      ...b,
      google,
      location: b.location.type === 'google_meet' && created.meetUrl ? { ...b.location, joinUrl: created.meetUrl } : b.location,
      timeline,
    };
  });
  // The event is there, so this counts as synced; the link alone is fetched by a job of its own.
  if (linkPending) await quietly(ctx, 'queueing the Meet link check', bookingId, () => queueCalendarRetry(ctx, bookingId, RETRY_AFTER_FAILURE_MS));
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
    // We changed a calendar ourselves (an event added, moved or removed), so what is remembered of the hosts'
    // busy time describes a calendar that no longer exists. Without this a cancelled or moved meeting keeps
    // its old time closed for up to a minute, although the booking page says it is free again.
    if (result.status === 'synced') {
      const booking = await getBooking(ctx, bookingId).catch(() => null);
      if (booking) await forgetHostBusy(ctx, booking.google?.hostId ? [...booking.hostIds, booking.google.hostId] : booking.hostIds);
    }
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
  let organizer: AccountRef | null = null;
  if (!booking.google) {
    const site = await getSite(ctx);
    organizer = mainOf(chooseOrganizer(booking, hostsById(await listHosts(ctx)), site));
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

/**
 * Google never finished the Meet link of a booking: the owner is told, once per booking, so the invitee is
 * not left without a way in. The checks go on (reconcileBookings) and the link is added once Google has it.
 */
async function alertMeetLinkMissing(ctx: Ctx, bookingId: string): Promise<void> {
  const booking = await getBooking(ctx, bookingId);
  if (!booking || booking.status !== 'confirmed' || booking.location.joinUrl) return;
  const once = `alert-meet-${bookingId}`;
  if (!(await claim(ctx, once))) return;
  const site = await getSite(ctx);
  const owner = ownerOf(site, await listHosts(ctx));
  const when = formatInZone(Date.parse(booking.start), owner && isValidZone(owner.timezone) ? owner.timezone : 'UTC', 'full');
  const body = [
    'Hi {{host_first_name}},',
    literal(`Google did not finish creating the Meet link for "${booking.eventTitle}" with ${booking.invitee.name} on ${when}. Until it does, the booking page, the emails and the reminders have no link to give.`),
    'Open the event in Google Calendar and add a Meet link, or send the invitee a link yourself. We keep checking, and the link is added to the booking as soon as Google has one.',
  ].join('\n\n');
  try {
    await enqueueJob(ctx, {
      type: 'message',
      kind: 'host_alert',
      bookingId: '',
      channel: 'email',
      audience: 'host',
      subject: literal(`No Meet link yet: ${booking.eventTitle} with ${booking.invitee.name}`),
      body,
      dueAt: nowIso(ctx),
    });
  } catch (err) {
    await releaseClaim(ctx, once).catch(() => undefined);
    throw err;
  }
}

async function gcalSyncJob(ctx: Ctx, job: { bookingId: string; attempt?: number }): Promise<SendResult> {
  const outcome = await syncCalendar(ctx, job.bookingId, 'reconcile');
  if (outcome.status === 'synced' || outcome.status === 'unchanged') return { ok: true, provider: 'google' };
  if (outcome.status === 'skipped') return { ok: false, provider: 'google', skipped: 'nothing_to_sync' };
  // Waiting for a person to reconnect: the periodic check queues a new attempt, so this one can go.
  if (outcome.retry === false) return { ok: false, provider: 'google', skipped: 'needs_reconnect' };
  if (outcome.error === MEET_PENDING && (job.attempt ?? 0) + 1 >= GCAL_JOB_TRIES) {
    await quietly(ctx, 'the missing Meet link alert', job.bookingId, () => alertMeetLinkMissing(ctx, job.bookingId));
  }
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
  /** follow-up work (calendar, reminders, notices) finished for a change whose request was cut off; only present when there was some */
  finished?: number;
  /** bookings made before events recorded their Google account, now stamped with it; only present when there were some */
  stamped?: number;
  /** bookings whose event was found in no connected Google account; only present when there were some */
  detached?: number;
}

async function readRecords(ctx: Ctx, entries: BookingIndexEntry[]): Promise<(Booking | null)[]> {
  const records = new Array<Booking | null>(entries.length);
  let cursor = 0;
  const reader = async (): Promise<void> => {
    while (cursor < entries.length) {
      const i = cursor++;
      records[i] = await getBooking(ctx, entries[i].id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILE_READS, entries.length) }, reader));
  return records;
}

/**
 * A confirmed booking still ahead that has no Google event, while one of its hosts can now take it: it was made
 * before Google was connected, or while that connection was down. Its event is written now (calendarEventInput
 * leaves out an invitee who already got our own invitation, see invite.ts). A booking whose own follow-up is
 * still running is left to it.
 */
function waitsForCalendar(record: Booking, byId: Map<string, Host>, site: SiteSettings, nowMs: number): boolean {
  return record.status === 'confirmed' && !record.google && !record.followUp && Date.parse(record.start) > nowMs && chooseOrganizer(record, byId, site) !== null;
}

/**
 * Queues the calendar work again for a booking that still carries a problem, or (`missing`) that has no event
 * yet although it could have one, at most every two hours.
 */
async function requeueCalendarRepair(ctx: Ctx, record: Booking, nowMs: number, missing = false): Promise<boolean> {
  if ((!record.google?.error && !missing) || (await cacheGet(ctx, `gcal-requeue-${record.id}`))) return false;
  await cacheSet(ctx, `gcal-requeue-${record.id}`, { at: nowMs }, REQUEUE_TTL_SEC);
  await queueCalendarRetry(ctx, record.id, 0);
  return true;
}

/** At most this many bookings are looked up per housekeeping run to learn which Google account holds their event. */
const STAMP_PER_RUN = 10;
const STAMP_CONCURRENCY = 3;
/** Upcoming records read when an account goes; any more are found by the stamp of later runs. */
const ACCOUNT_BOOKINGS_READ_LIMIT = 200;
const EVENT_NOT_FOUND = 'The calendar event could not be found in any connected Google account. Changes to this meeting will not reach Google Calendar.';

/**
 * Bookings made before events recorded their account (or by an older deploy, or whose account went): each
 * is read through the host's accounts, the main one first, and stamped with the one whose copy of the event
 * carries our booking id. Found in none, with every account answering: detached. An account that could not
 * be asked leaves the booking for a later run.
 */
async function stampBookings(ctx: Ctx, records: (Booking | null)[]): Promise<{ stamped: number; detached: number }> {
  const out = { stamped: 0, detached: 0 };
  const hosts = hostsById(await listHosts(ctx));
  const picked = records
    .filter((r): r is Booking => !!r && r.status === 'confirmed' && !!r.google?.eventId && !r.google.detached && accountGone(hosts.get(r.google.hostId), r.google))
    .slice(0, STAMP_PER_RUN);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < picked.length) {
      const booking = picked[next++];
      const g = booking.google!;
      const host = hosts.get(g.hostId) ?? null;
      try {
        const holder = await findHolder(ctx, booking, g, host);
        if (holder.kind === 'found') {
          const saved = await updateBooking(ctx, booking.id, (b) =>
            b.google && !b.google.detached && b.google.eventId === g.eventId && accountGone(host, b.google) ? { ...b, google: stampedWith(b.google, holder.ref) } : b,
          );
          if (saved?.google?.accountId === holder.ref.account.id) out.stamped++;
        } else if (holder.kind === 'none') {
          // Only the booking as it was looked at: one that a sync stamped, moved to another host or cancelled
          // meanwhile is left alone (the records were read at the start of the run).
          const still = (b: Booking): boolean => b.status === 'confirmed' && b.google?.hostId === g.hostId && b.google.eventId === g.eventId && accountGone(host, b.google);
          const saved = await detachBooking(ctx, booking.id, 'calendar_not_found', EVENT_NOT_FOUND, still);
          if (saved?.google?.detached && saved.timeline.at(-1)?.type === 'calendar_not_found') out.detached++;
        }
      } catch (err) {
        ctx.log('warn', 'booking: could not look up the account of a calendar event', { bookingId: booking.id, error: shortError(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAMP_CONCURRENCY, picked.length) }, worker));
  return out;
}

function eventInAccount(b: Booking, hostId: string, accountId: string, includeUnstamped: boolean): boolean {
  const g = b.google;
  if (!g || g.detached || b.status !== 'confirmed' || g.hostId !== hostId || !g.eventId) return false;
  return g.accountId === accountId || (includeUnstamped && !g.accountId);
}

async function upcomingOfHost(ctx: Ctx, hostId: string): Promise<{ records: Booking[]; atLeast: boolean }> {
  const nowMs = ctx.now().getTime();
  const entries = (await getBookingIndex(ctx))
    .filter((e) => e.status === 'confirmed' && Date.parse(e.end) > nowMs && Array.isArray(e.hostIds) && e.hostIds.includes(hostId))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const records = await readRecords(ctx, entries.slice(0, ACCOUNT_BOOKINGS_READ_LIMIT));
  return { records: records.filter((r): r is Booking => !!r), atLeast: entries.length > ACCOUNT_BOOKINGS_READ_LIMIT };
}

/**
 * How many upcoming confirmed bookings have their event in this account. `includeUnstamped`: also those of
 * the host whose account is not recorded yet (they were written into the main account).
 */
export async function countEventsInAccount(ctx: Ctx, hostId: string, accountId: string, opts: { includeUnstamped: boolean }): Promise<{ count: number; atLeast: boolean }> {
  const { records, atLeast } = await upcomingOfHost(ctx, hostId);
  return { count: records.filter((b) => eventInAccount(b, hostId, accountId, opts.includeUnstamped)).length, atLeast };
}

/**
 * The host's main account takes new meetings now (just connected, or chosen): their upcoming bookings that
 * have no Google event yet get one, through the retry job, at once. Returns how many were queued.
 */
export async function queueCalendarBackfill(ctx: Ctx, hostId: string): Promise<number> {
  registerBookingJobHandlers();
  const [{ records }, hosts, site] = await Promise.all([upcomingOfHost(ctx, hostId), listHosts(ctx), getSite(ctx)]);
  const byId = hostsById(hosts);
  const nowMs = ctx.now().getTime();
  let queued = 0;
  for (const record of records) {
    if (waitsForCalendar(record, byId, site, nowMs) && (await requeueCalendarRepair(ctx, record, nowMs, true))) queued++;
  }
  if (queued > 0) ctx.log('info', 'booking: earlier bookings queued for the calendar that was just connected', { hostId, queued });
  return queued;
}

/**
 * The account that holds these bookings' events is going (removed, or replaced by "Use a different Google
 * account"): they are detached, so nothing is written into another account and the invitee's next emails
 * carry our own calendar file and say why. Returns how many.
 */
export async function detachEventsOfAccount(ctx: Ctx, hostId: string, account: { id: string; email: string }, opts: { includeUnstamped: boolean; why: 'removed' | 'replaced' }): Promise<number> {
  const { records } = await upcomingOfHost(ctx, hostId);
  const detail =
    opts.why === 'replaced'
      ? `The calendar event is in ${account.email}, which was replaced by another Google account. Changes to this meeting will not reach Google Calendar.`
      : `The calendar event is in ${account.email}, which was removed. Changes to this meeting will not reach Google Calendar.`;
  let detached = 0;
  for (const record of records) {
    if (!eventInAccount(record, hostId, account.id, opts.includeUnstamped)) continue;
    const saved = await updateBooking(ctx, record.id, (b) =>
      eventInAccount(b, hostId, account.id, opts.includeUnstamped)
        ? { ...b, google: { ...withoutError(b.google!), accountEmail: b.google!.accountEmail ?? account.email, detached: true }, timeline: [...(b.timeline ?? []), { at: nowIso(ctx), type: 'calendar_detached', detail }] }
        : b,
    ).catch(() => null);
    if (saved?.google?.detached) detached++;
  }
  return detached;
}

/**
 * Heals what an interrupted request can leave behind (see the top of this file). It only ever acts in
 * the safe direction, and it only removes or moves something it has seen in the same odd state on two
 * runs, so a request that is still in flight is never disturbed. Follow-up work a request left behind
 * (its marker is on the record) is finished once the marker is ten minutes old.
 *
 * Cancelled meetings that are still ahead get their own, smaller pass: their calendar event has to go,
 * and a reconnect-needed or failing Google may have stopped that the first time.
 */
export async function reconcileBookings(ctx: Ctx, opts?: { limit?: number }): Promise<ReconcileResult> {
  registerBookingJobHandlers();
  const result: ReconcileResult = { checked: 0, removed: 0, freed: 0, moved: 0, requeued: 0 };
  const nowMs = ctx.now().getTime();
  const limit = Math.max(1, opts?.limit ?? 300);
  const index = await getBookingIndex(ctx);
  const ahead = (status: BookingIndexEntry['status']) =>
    index.filter((e) => e.status === status && Date.parse(e.end) > nowMs).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const entries = ahead('confirmed').slice(0, limit);
  const records = await readRecords(ctx, entries);
  let finished = 0;

  const before = (await cacheGet<Record<string, string>>(ctx, SUSPECTS_CACHE)) ?? {};
  const suspects: Record<string, string> = {};
  // Who can take a calendar event now: read once, and only when a booking without one is there to ask about.
  let organizers: { byId: Map<string, Host>; site: SiteSettings } | null = null;
  const canTake = async (record: Booking): Promise<boolean> => {
    if (record.status !== 'confirmed' || record.google || record.followUp || !(Date.parse(record.start) > nowMs)) return false;
    organizers ??= { byId: hostsById(await listHosts(ctx)), site: await getSite(ctx) };
    return waitsForCalendar(record, organizers.byId, organizers.site, nowMs);
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const record = records[i];
    result.checked++;

    if (!record) {
      // Created in the index, never saved: the visitor saw an error and holds nothing. The entry itself is
      // what was seen on two runs, not just its id: a retry of the same request (same id) may take the time
      // over for its record, and its new entry is a different one, still in flight.
      const missing = entry.req || entry.takenAt !== undefined ? `missing:${entry.req ?? ''}:${entry.takenAt ?? ''}` : 'missing';
      if (before[entry.id] !== missing) {
        suspects[entry.id] = missing;
        continue;
      }
      if (await getBooking(ctx, entry.id)) continue;
      // Only the entry as it was seen: a retry of the same request may have just taken it over for its record.
      const done = await mutateBookingIndex(ctx, (list) =>
        list.some((e) => e.id === entry.id && e.req === entry.req && e.takenAt === entry.takenAt) ? list.filter((e) => e.id !== entry.id) : { abort: 'changed' },
      );
      if (done.ok) {
        result.removed++;
        ctx.log('warn', 'booking: removed an index entry that never got its booking record', { bookingId: entry.id, start: entry.start });
      }
      continue;
    }

    if (record.status === 'cancelled') {
      if (record.followUp?.kind === 'cancelled' && followUpIsStale(record.followUp, nowMs)) {
        // The cancellation was cut off before its follow-up: give the time back and do the rest of it too.
        if (await finishFollowUp(ctx, record)) {
          finished++;
          result.freed++;
        }
        continue;
      }
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

    if (followUpIsStale(record.followUp, nowMs)) {
      if (await finishFollowUp(ctx, record)) finished++;
      continue;
    }

    if (await requeueCalendarRepair(ctx, record, nowMs, await canTake(record))) result.requeued++;
  }

  // Cancelled meetings still ahead: finish what a cut-off cancellation left, and keep removing the event.
  const cancelled = ahead('cancelled').slice(0, RECONCILE_CANCELLED_LIMIT);
  const cancelledRecords = await readRecords(ctx, cancelled);
  for (const record of cancelledRecords) {
    if (!record || record.status !== 'cancelled') continue;
    if (record.followUp?.kind === 'cancelled' && followUpIsStale(record.followUp, nowMs)) {
      if (await finishFollowUp(ctx, record)) finished++;
      continue;
    }
    if (await requeueCalendarRepair(ctx, record, nowMs)) result.requeued++;
  }

  await cacheSet(ctx, SUSPECTS_CACHE, suspects, SUSPECTS_TTL_SEC);
  if (finished > 0) result.finished = finished;

  // Which Google account holds the event of bookings that do not say yet. No storage reads of its own:
  // it works on the records read above.
  const stamp = await stampBookings(ctx, records);
  if (stamp.stamped > 0) result.stamped = stamp.stamped;
  if (stamp.detached > 0) result.detached = stamp.detached;
  return result;
}

async function completeInterruptedMove(ctx: Ctx, entry: BookingIndexEntry): Promise<boolean> {
  const still = (await getBookingIndex(ctx)).find((e) => e.id === entry.id);
  if (!still || still.status !== 'confirmed' || still.start !== entry.start || still.end !== entry.end) return false;
  const at = nowIso(ctx);
  // Who made the move is not known any more, so everybody is told the usual way.
  const base = newFollowUp(ctx, 'rescheduled');
  let marker = base;
  let applied = false;
  const saved = await updateBooking(ctx, entry.id, (b) => {
    if (b.status !== 'confirmed' || (b.start === entry.start && b.end === entry.end)) {
      applied = false;
      return b;
    }
    applied = true;
    const joined = joinedHosts(b.hostIds, entry.hostIds);
    marker = joined.length ? { ...base, newHostIds: joined } : base;
    return {
      ...b,
      start: entry.start,
      end: entry.end,
      hostIds: [...entry.hostIds],
      rescheduledFromStart: b.start,
      rescheduleCount: (b.rescheduleCount ?? 0) + 1,
      // Who moved it is not known: counted as a move made on the booking page, which is the safe side.
      inviteeMoves: movesOnThePage(b) + 1,
      attendance: {},
      followUp: marker,
      timeline: [...(b.timeline ?? []), { at, type: 'rescheduled', detail: `Moved from ${b.start} (finished after an interruption)` }],
    };
  });
  if (!saved || !applied) return false;
  ctx.log('warn', 'booking: completed a move that was interrupted', { bookingId: entry.id, start: entry.start });
  const eventType = await getEventType(ctx, saved.eventTypeId);
  const followed = await followUpBooking(ctx, entry.id, marker, eventType, { calendarMode: 'push', calendarBudgetMs: CALENDAR_BUDGET_MS, fallback: saved, note: true });
  runImmediateJobs(ctx, entry.id, followed.pending);
  return true;
}

/** Finishes the work a request left behind on a booking that still carries a follow-up marker. */
async function finishFollowUp(ctx: Ctx, booking: Booking): Promise<boolean> {
  const marker = booking.followUp;
  if (!marker) return false;
  ctx.log('warn', 'booking: finishing the work after a change that was cut off', { bookingId: booking.id, kind: marker.kind, since: marker.at });
  if (marker.kind === 'cancelled') {
    if (booking.status !== 'cancelled') return false;
    // 'push': the event is removed again whatever the record says (Google answers "already gone" quietly).
    const done = await followUpCancellation(ctx, booking, marker, { calendarMode: 'push', calendarBudgetMs: CALENDAR_BUDGET_MS });
    runImmediateJobs(ctx, booking.id);
    return done;
  }
  if (booking.status !== 'confirmed') return false;
  const eventType = await getEventType(ctx, booking.eventTypeId);
  // A new booking may still need its event; a move has to be told to Google again (the first try may never have run).
  const followed = await followUpBooking(ctx, booking.id, marker, eventType, {
    calendarMode: marker.kind === 'created' ? 'reconcile' : 'push',
    calendarBudgetMs: CALENDAR_BUDGET_MS,
    fallback: booking,
    note: false,
  });
  runImmediateJobs(ctx, booking.id, followed.pending);
  return followed.done;
}

// Registered as soon as this module is loaded, wherever that happens. Inside the import cycle
// jobs > sms > booking some loaders have not bound the function yet; the routes and the scheduled
// function call registerBookingJobHandlers() again once everything is in place.
if (typeof registerJobHandler === 'function') registerBookingJobHandlers();
