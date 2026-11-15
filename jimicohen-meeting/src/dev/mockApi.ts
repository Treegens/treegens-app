/**
 * DEV ONLY in-browser stand-in for `/meeting/api`, used when the app runs with
 * `VITE_MOCK_API=1 npx vite`. api.ts reaches it through a dynamic import behind
 * `import.meta.env.DEV`, so none of this reaches a production bundle.
 *
 * What it gives you
 *  - A PublicSite with three listed event types: `/intro` (solo, 15 / 30 / 45 min),
 *    `/strategy` (collective, Jimi + Alex, own colour), `/consultation` (four locations, seven
 *    question types). Plus `/priority` (unlisted, round robin) and an inactive `/press`.
 *  - Slots computed from the mock hosts' schedules for any range: weekdays, pseudo-random
 *    (but stable) gaps, some fully booked days, nothing inside the minimum notice.
 *  - Bookings you can create, open, reschedule, cancel and confirm. State lives in memory and
 *    in sessionStorage, so it survives a reload of the tab.
 *  - Seeded bookings with fixed ids and the manage token `demo`:
 *      /booking/bk_demo_upcoming?t=demo   /booking/bk_demo_past?t=demo   /booking/bk_demo_cancelled?t=demo
 *  - A signed-in admin with bootstrap, overview, bookings list, hosts (owner + Alex), integrations.
 *  - Co-host self-service: /host/host_alex?t=demo
 *
 * Switches (add to any URL once; they stick for the tab)
 *    ?mock=reset                 start over with fresh seed data
 *    ?mock_auth=setup|login|ok   first-run screen / sign-in screen / signed in (default)
 *    ?mock_delay=0               response delay in ms (default about 250)
 *    ?mock_fail=site,slots       make endpoints fail: site, event, slots (calendar error), booking (503),
 *                                bootstrap, overview, bookings, save (every admin write)
 *    ?mock_empty=slots,bookings  empty results: no slots at all / no bookings / no event types (events)
 *
 * Error paths you can trigger from the UI
 *    booking name "conflict"      → 409 slot_taken
 *    booking name "unavailable"   → 503 calendar_unavailable
 *    booking name "invalid"       → 422 with field errors
 *    sign in with password "wrong" → 401; setup code must be "dev-setup-code"
 *    co-host email "taken@example.com" → 422 field error
 */
import { RESERVED_SLUGS, defaultSchedule, newEventType } from '../../shared/defaults';
import type {
  AdminBooking,
  AdminBookingsResponse,
  AdminBootstrap,
  AdminHost,
  AdminOverview,
  AssetUploadResponse,
  Booking,
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
  PublicEventType,
  PublicHost,
  PublicSite,
  Schedule,
  SlotsResponse,
  TimeRange,
} from '../../shared/types';
import { ApiFailure } from '../lib/apiError';
import { addDays, dayKey, isValidZone, weekdayOfKey, zonedToMs } from '../lib/tz';
import { COHOST_ID, DEMO_TOKEN, MOCK_STATE_VERSION, OWNER_ID, OWNER_ZONE, locationFor, seedState } from './fixtures';
import type { MockState } from './fixtures';

type Query = Record<string, string | number | boolean | null | undefined>;

// ───────────── state ─────────────

const STORE_KEY = 'mtg:mock:state';
const FLAGS_KEY = 'mtg:mock:flags';

interface Flags {
  delay: number | null;
  fail: string[];
  empty: string[];
}

function readSession<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota (large uploaded images) or blocked storage: the in-memory copy still works.
  }
}

let flags: Flags = readSession<Flags>(FLAGS_KEY) ?? { delay: null, fail: [], empty: [] };
let state: MockState = loadState();

function loadState(): MockState {
  const saved = readSession<MockState>(STORE_KEY);
  if (saved && saved.version === MOCK_STATE_VERSION && Array.isArray(saved.bookings)) return saved;
  return seedState();
}

function save(): void {
  writeSession(STORE_KEY, state);
}

function applyUrlSwitches(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  let touchedFlags = false;
  if (params.get('mock') === 'reset') {
    state = seedState();
    flags = { delay: null, fail: [], empty: [] };
    touchedFlags = true;
    save();
  }
  const auth = params.get('mock_auth');
  if (auth === 'setup') state.auth = { setupRequired: true, authenticated: false };
  else if (auth === 'login') state.auth = { setupRequired: false, authenticated: false };
  else if (auth === 'ok') state.auth = { setupRequired: false, authenticated: true };
  if (auth) save();
  if (params.has('mock_delay')) {
    const n = Number(params.get('mock_delay'));
    flags.delay = Number.isFinite(n) ? Math.max(0, n) : null;
    touchedFlags = true;
  }
  if (params.has('mock_fail')) {
    flags.fail = (params.get('mock_fail') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    touchedFlags = true;
  }
  if (params.has('mock_empty')) {
    flags.empty = (params.get('mock_empty') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    touchedFlags = true;
  }
  if (touchedFlags) writeSession(FLAGS_KEY, flags);

  // Return leg of the fake Google OAuth redirect (see googleConnectUrl in api.ts).
  const googleHost = params.get('mock_google_host');
  if (googleHost && params.get('google') === 'connected') {
    const host = state.hosts.find((h) => h.id === googleHost);
    if (host) {
      host.google = {
        email: host.email || 'you@example.com',
        status: 'ok',
        busyCalendarIds: ['primary'],
        writeCalendarId: 'primary',
        gmailSend: params.get('mock_google_gmail') === '1' || !!host.google?.gmailSend,
      };
      host.calendarHealth = { ok: true, at: new Date().toISOString() };
      if (host.timezoneMode === 'device') host.timezoneMode = 'google';
      if (host.id === state.site.ownerHostId) {
        state.integrations.google.ownerConnected = true;
        state.integrations.google.ownerEmail = host.google.email;
        refreshEmailStatus();
      }
      save();
    }
  }
}

applyUrlSwitches();

declare global {
  interface Window {
    /** dev console handle: __mock.state, __mock.reset(), __mock.flags */
    __mock?: { state: MockState; flags: Flags; reset: () => void };
  }
}

if (typeof window !== 'undefined') {
  window.__mock = {
    get state() {
      return state;
    },
    get flags() {
      return flags;
    },
    reset() {
      state = seedState();
      save();
    },
  };
}

// ───────────── helpers ─────────────

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function fail(status: number, code: string, message: string, fields?: Record<string, string>): never {
  throw new ApiFailure(status, code, message, fields);
}

function nextId(prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function origin(): string {
  return window.location.origin;
}

function basePath(): string {
  return import.meta.env.BASE_URL.replace(/\/+$/, '');
}

function assetUrlOf(id: string | null | undefined): string | null {
  if (!id) return null;
  return state.assets[id] ?? null;
}

function publicHost(h: AdminHost): PublicHost {
  return { id: h.id, name: h.name, title: h.title || undefined, avatarUrl: h.avatarUrl };
}

function hostsOf(ids: string[]): AdminHost[] {
  return ids.map((id) => state.hosts.find((h) => h.id === id)).filter((h): h is AdminHost => !!h);
}

const LOCATION_LABELS: Record<string, string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call',
  phone_invitee_calls: 'Phone call',
  in_person: 'In person',
  custom_link: 'Video call',
  ask_invitee: 'Your choice',
};

function publicEventType(et: EventType): PublicEventType {
  const hosts = hostsOf(et.hostIds);
  const lead = firstName(hosts[0]?.name ?? 'The host');
  return {
    id: et.id,
    slug: et.slug,
    title: et.title,
    description: et.description,
    emoji: et.emoji || undefined,
    color: et.color || undefined,
    coverUrl: assetUrlOf(et.coverAssetId),
    kind: et.kind,
    hosts: hosts.map(publicHost),
    durations: et.durations.slice(),
    defaultDuration: et.defaultDuration,
    locations: et.locations.map((l) => ({
      type: l.type,
      label: l.label || LOCATION_LABELS[l.type] || 'Meeting',
      detail:
        l.type === 'google_meet'
          ? 'You get the link when you book'
          : l.type === 'phone_host_calls'
            ? `${lead} calls you`
            : l.type === 'phone_invitee_calls'
              ? `You call ${l.value ?? lead}`
              : l.type === 'ask_invitee'
                ? 'Tell us where suits you'
                : l.value,
    })),
    questions: clone(et.questions),
    allowGuests: et.allowGuests,
    maxGuests: et.maxGuests,
    phone: et.phone,
    minNoticeMinutes: et.scheduling.minNoticeMinutes,
    maxDaysAhead: et.scheduling.maxDaysAhead,
    themeOverride: et.themeOverride ?? null,
  };
}

function publicSite(): PublicSite {
  const { site } = state;
  const listed = flags.empty.includes('events') ? [] : state.eventTypes.filter((e) => e.active && e.visibility === 'public');
  return {
    profile: {
      name: site.profile.name,
      headline: site.profile.headline,
      welcome: site.profile.welcome,
      avatarUrl: assetUrlOf(site.profile.avatarAssetId),
      links: clone(site.profile.links),
    },
    theme: clone(site.theme),
    themeAssets: {
      coverUrl: assetUrlOf(site.theme.coverAssetId),
      logoUrl: assetUrlOf(site.theme.logoAssetId),
      backgroundUrl: assetUrlOf(site.theme.background.imageAssetId),
    },
    eventTypes: listed.sort((a, b) => a.position - b.position).map(publicEventType),
    booking: clone(site.booking),
    assistantName: site.assistant.name,
    features: { sms: state.integrations.twilio.configured, calls: state.integrations.twilio.configured },
    ownerTimezone: owner().timezone,
  };
}

function owner(): AdminHost {
  return state.hosts.find((h) => h.id === state.site.ownerHostId) ?? state.hosts[0];
}

// ───────────── availability ─────────────

type Interval = [number, number];

function merge(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end > start) out.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

function scheduleFor(host: AdminHost, et: EventType): Schedule {
  const wanted = et.scheduling.scheduleIds[host.id] ?? host.defaultScheduleId;
  return host.schedules.find((s) => s.id === wanted) ?? host.schedules[0] ?? defaultSchedule();
}

function hostWindows(host: AdminHost, et: EventType, from: number, to: number): Interval[] {
  const schedule = scheduleFor(host, et);
  const out: Interval[] = [];
  let key = addDays(dayKey(from, host.timezone), -1);
  const last = addDays(dayKey(to, host.timezone), 1);
  for (let guard = 0; guard < 80 && key <= last; guard++, key = addDays(key, 1)) {
    const override = schedule.overrides.find((o) => o.date === key);
    const ranges: TimeRange[] = override ? override.ranges : schedule.weekly[weekdayOfKey(key)] ?? [];
    for (const r of ranges) {
      const start = zonedToMs(key, r.start, host.timezone);
      const end = r.end === '24:00' ? zonedToMs(addDays(key, 1), '00:00', host.timezone) : zonedToMs(key, r.end, host.timezone);
      if (end > start) out.push([start, end]);
    }
  }
  return merge(out);
}

/** Deterministic stand-in for "busy on an external calendar". */
function externallyBusy(host: AdminHost, startMs: number): boolean {
  const key = dayKey(startMs, host.timezone);
  if (hash(`${host.id}|${key}|full`) % 9 === 0) return true;
  const halfHour = Math.floor(startMs / 1800000);
  return hash(`${host.id}|${halfHour}`) % 100 < 27;
}

function generateSlots(et: EventType, durationMin: number, fromMs: number, toMs: number, ignoreBookingId?: string): { start: number; hostIds: string[] }[] {
  const now = Date.now();
  const hosts = hostsOf(et.hostIds);
  if (!hosts.length) return [];
  const sched = et.scheduling;
  const earliest = now + sched.minNoticeMinutes * 60000;
  const latest = now + sched.maxDaysAhead * 86400000;
  const from = Math.max(fromMs, earliest - 86400000);
  const to = Math.min(toMs, latest, fromMs + 62 * 86400000);
  if (to <= from) return [];

  const windows = new Map(hosts.map((h) => [h.id, hostWindows(h, et, from, to)]));
  const confirmed = state.bookings.filter((b) => b.status === 'confirmed' && b.id !== ignoreBookingId);
  const busyOf = (hostId: string): Interval[] => confirmed.filter((b) => b.hostIds.includes(hostId)).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
  const booked = new Map(hosts.map((h) => [h.id, busyOf(h.id)]));

  const dur = durationMin * 60000;
  const step = Math.max(5, sched.slotIncrementMin) * 60000;
  const before = sched.bufferBeforeMin * 60000;
  const after = sched.bufferAfterMin * 60000;
  const ownerZone = owner().timezone;

  const freeFor = (host: AdminHost, s: number): boolean => {
    const inside = (windows.get(host.id) ?? []).some(([a, b]) => s >= a && s + dur <= b);
    if (!inside) return false;
    if ((booked.get(host.id) ?? []).some(([a, b]) => s - before < b && s + dur + after > a)) return false;
    if (externallyBusy(host, s)) return false;
    if (sched.maxPerDay) {
      const key = dayKey(s, host.timezone);
      const count = confirmed.filter((b) => b.eventTypeId === et.id && b.hostIds.includes(host.id) && dayKey(b.start, host.timezone) === key).length;
      if (count >= sched.maxPerDay) return false;
    }
    return true;
  };

  const out: { start: number; hostIds: string[] }[] = [];
  let key = dayKey(from, ownerZone);
  const lastKey = dayKey(to, ownerZone);
  for (let guard = 0; guard < 70 && key <= lastKey; guard++, key = addDays(key, 1)) {
    const midnight = zonedToMs(key, '00:00', ownerZone);
    const nextMidnight = zonedToMs(addDays(key, 1), '00:00', ownerZone);
    for (let s = midnight; s < nextMidnight; s += step) {
      if (s < from || s >= to || s < earliest || s >= latest) continue;
      const free = hosts.filter((h) => freeFor(h, s));
      if (et.kind === 'round_robin' ? free.length > 0 : free.length === hosts.length) {
        out.push({ start: s, hostIds: free.map((h) => h.id) });
      }
    }
  }
  return out;
}

// ───────────── bookings ─────────────

function icsDataUrl(b: Booking): string {
  const fmt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//meeting//mock//EN',
    'BEGIN:VEVENT',
    `UID:${b.id}@mock`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(b.start)}`,
    `DTEND:${fmt(b.end)}`,
    `SUMMARY:${b.eventTitle}`,
    `LOCATION:${b.location.joinUrl ?? b.location.value ?? b.location.label}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}

function publicBooking(b: Booking): PublicBooking {
  const et = state.eventTypes.find((e) => e.id === b.eventTypeId);
  const hosts = hostsOf(b.hostIds).map(publicHost);
  const upcoming = b.status === 'confirmed' && Date.parse(b.start) > Date.now();
  const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const title = `${b.eventTitle} with ${hosts.map((h) => h.name).join(' and ')}`;
  const where = b.location.joinUrl ?? b.location.value ?? b.location.label;
  return {
    id: b.id,
    status: b.status,
    eventTitle: b.eventTitle,
    eventSlug: b.eventSlug,
    start: b.start,
    end: b.end,
    durationMin: b.durationMin,
    hosts,
    invitee: { name: b.invitee.name, email: b.invitee.email, phone: b.invitee.phone, timezone: b.invitee.timezone },
    guests: b.guests.slice(),
    location: clone(b.location),
    confirmationMessage: et?.confirmation.message || undefined,
    redirectUrl: et?.confirmation.redirectUrl || undefined,
    canReschedule: upcoming,
    canCancel: upcoming,
    calendarLinks: {
      google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${compact(b.start)}/${compact(b.end)}&location=${encodeURIComponent(where)}`,
      outlook: `https://outlook.live.com/calendar/0/action/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(title)}&startdt=${encodeURIComponent(b.start)}&enddt=${encodeURIComponent(b.end)}&location=${encodeURIComponent(where)}`,
      office365: `https://outlook.office.com/calendar/0/action/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(title)}&startdt=${encodeURIComponent(b.start)}&enddt=${encodeURIComponent(b.end)}&location=${encodeURIComponent(where)}`,
      ics: icsDataUrl(b),
    },
    cancellation: b.cancellation ? { at: b.cancellation.at, by: b.cancellation.by, reason: b.cancellation.reason } : null,
    rescheduledFromStart: b.rescheduledFromStart ?? null,
    attendanceConfirmed: !!b.attendance.confirmedAt,
  };
}

function adminBooking(b: Booking): AdminBooking {
  return {
    ...clone(b),
    hosts: hostsOf(b.hostIds).map(publicHost),
    manageUrl: `${origin()}${basePath()}/booking/${b.id}?t=${encodeURIComponent(state.tokens[b.id] ?? DEMO_TOKEN)}`,
  };
}

function findBooking(id: string, token: unknown): Booking {
  const b = state.bookings.find((x) => x.id === id);
  if (!b || typeof token !== 'string' || !token || state.tokens[id] !== token) fail(404, 'not_found', 'We could not find that booking. Check the link in your confirmation email.');
  return b;
}

function slotStillFree(et: EventType, durationMin: number, startMs: number, ignoreBookingId?: string): string[] | null {
  const around = generateSlots(et, durationMin, startMs - 3600000, startMs + 3600000, ignoreBookingId);
  return around.find((s) => s.start === startMs)?.hostIds ?? null;
}

function createBooking(req: CreateBookingRequest): CreateBookingResponse {
  const name = String(req.name ?? '').trim();
  const email = String(req.email ?? '').trim();
  const generic = 'Could not complete the booking. Please try again.';
  if (req.website) fail(422, 'invalid', generic);
  if (typeof req.elapsedMs === 'number' && req.elapsedMs < 1500) fail(422, 'invalid', generic);

  const et = state.eventTypes.find((e) => e.slug === req.slug && e.active);
  if (!et) fail(404, 'not_found', 'This meeting type is no longer available.');

  const fields: Record<string, string> = {};
  if (!name) fields.name = 'Please enter your name.';
  if (!EMAIL.test(email)) fields.email = 'Please enter a valid email address.';
  if (!isValidZone(req.timezone)) fields.timezone = 'We could not read your time zone.';
  const phone = String(req.phone ?? '').replace(/[^\d+]/g, '');
  const loc = et.locations[req.locationIndex ?? 0] ?? et.locations[0];
  const phoneNeeded = et.phone === 'required' || loc?.type === 'phone_host_calls';
  if (phoneNeeded && !phone) fields.phone = 'A phone number is needed for this meeting.';
  else if (phone && (!/^\+?\d{7,15}$/.test(phone) || et.phone === 'hidden')) fields.phone = 'Please enter a valid phone number, including the country code.';
  if (loc?.type === 'ask_invitee' && !String(req.locationText ?? '').trim()) fields.locationText = 'Please tell us where you would like to meet.';
  const guests = (req.guests ?? []).map((g) => g.trim()).filter(Boolean);
  if (guests.length > (et.allowGuests ? et.maxGuests : 0)) fields.guests = `You can add up to ${et.maxGuests} guests.`;
  else if (guests.some((g) => !EMAIL.test(g))) fields.guests = 'One of the guest emails does not look right.';
  for (const q of et.questions) {
    const v = req.answers?.[q.id];
    const empty = v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);
    if (q.required && empty) fields[`answers.${q.id}`] = 'Please answer this question.';
  }
  if (!et.durations.includes(req.durationMin)) fields.durationMin = 'Please choose one of the offered lengths.';
  if (name.toLowerCase() === 'invalid') {
    fields.name = 'Please enter your full name.';
    fields.email = fields.email ?? 'This email address cannot receive invitations.';
  }
  if (Object.keys(fields).length) fail(422, 'invalid', 'Please check the highlighted fields.', fields);

  if (name.toLowerCase() === 'unavailable' || flags.fail.includes('booking')) {
    fail(503, 'calendar_unavailable', 'We could not check the calendar just now. Please try again in a minute.');
  }
  const startMs = Date.parse(req.start);
  const freeHosts = Number.isFinite(startMs) ? slotStillFree(et, req.durationMin, startMs) : null;
  if (name.toLowerCase() === 'conflict' || !freeHosts) {
    fail(409, 'slot_taken', 'That time was just taken. Please pick another one.');
  }

  const now = new Date().toISOString();
  const id = nextId('bk');
  const hostIds = et.kind === 'round_robin' ? [freeHosts[0]] : et.hostIds.slice();
  const lead = hostsOf(hostIds)[0] ?? owner();
  const consent = { sms: !!phone && !!req.consent?.sms, call: !!phone && !!req.consent?.call };
  const booking: Booking = {
    id,
    eventTypeId: et.id,
    eventSlug: et.slug,
    eventTitle: et.title,
    kind: et.kind,
    hostIds,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + req.durationMin * 60000).toISOString(),
    durationMin: req.durationMin,
    status: 'confirmed',
    invitee: { name, email, phone: phone || undefined, timezone: req.timezone, locale: req.locale },
    guests,
    answers: et.questions
      .map((q) => {
        const v = req.answers?.[q.id];
        const value = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : '') : String(v ?? '');
        return { questionId: q.id, label: q.label, value };
      })
      .filter((a) => a.value !== ''),
    location: locationFor(et, req.locationIndex ?? 0, firstName(lead.name), req.locationText),
    consent: {
      ...consent,
      at: now,
      text: consent.sms || consent.call ? state.site.booking.consentText.replace('{{host_first_name}}', firstName(owner().name)) : '',
    },
    google: owner().google ? { hostId: owner().id, calendarId: 'primary', eventId: `gcal_${id}`, htmlLink: 'https://calendar.google.com/calendar/u/0/r', meetUrl: 'https://meet.google.com/abc-defg-hij', syncedAt: now } : null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: req.source ?? 'page',
    utm: req.utm,
    timeline: [
      { at: now, type: 'created', detail: 'Booked from the public page' },
      { at: now, type: 'confirmation_email_sent', detail: email },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const manageToken = `tok${hash(id + now).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  state.bookings.push(booking);
  state.tokens[id] = manageToken;
  save();
  return { booking: publicBooking(booking), manageToken };
}

function cancel(b: Booking, by: 'invitee' | 'host', reason: unknown): void {
  if (b.status === 'cancelled') return;
  const now = new Date().toISOString();
  b.status = 'cancelled';
  b.cancellation = { at: now, by, reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : undefined };
  b.timeline.push({ at: now, type: 'cancelled', detail: b.cancellation.reason });
  b.updatedAt = now;
  save();
}

// ───────────── admin helpers ─────────────

function requireAdmin(): void {
  if (!state.auth.authenticated) fail(401, 'unauthorized', 'Please sign in to continue.');
}

function mask(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail ? '••••' : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function refreshEmailStatus(): void {
  const integ = state.integrations;
  const setting = state.site.email.provider;
  const ownerHost = owner();
  integ.email.setting = setting;
  integ.email.fromEmail = state.site.email.fromEmail;
  integ.email.gmailAvailable = !!ownerHost.google?.gmailSend;
  const resendReady = integ.email.resendConfigured && !!state.site.email.fromEmail;
  integ.email.resolved =
    setting === 'none'
      ? 'none'
      : setting === 'resend'
        ? resendReady
          ? 'resend'
          : 'none'
        : setting === 'gmail'
          ? integ.email.gmailAvailable
            ? 'gmail'
            : 'none'
          : resendReady
            ? 'resend'
            : integ.email.gmailAvailable
              ? 'gmail'
              : 'none';
}

function deepMerge<T>(target: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function validateEventType(et: EventType): void {
  const fields: Record<string, string> = {};
  if (!et.title.trim()) fields.title = 'Give this event type a name.';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(et.slug)) fields.slug = 'Use lowercase letters, numbers and dashes.';
  else if (RESERVED_SLUGS.includes(et.slug)) fields.slug = 'That link is reserved. Please choose another.';
  else if (state.eventTypes.some((e) => e.slug === et.slug && e.id !== et.id)) fields.slug = 'Another event type already uses this link.';
  if (!et.durations.length || et.durations.some((d) => d < 5 || d > 480)) fields.durations = 'Durations must be between 5 minutes and 8 hours.';
  if (et.hostIds.some((id) => !state.hosts.some((h) => h.id === id)) || !et.hostIds.length) fields.hostIds = 'Choose at least one host.';
  else if (et.kind !== 'solo' && et.hostIds.length < 2) fields.hostIds = 'Choose at least two hosts for this kind of meeting.';
  if (et.confirmation.redirectUrl && !/^https:\/\//.test(et.confirmation.redirectUrl)) fields['confirmation.redirectUrl'] = 'The redirect link must start with https://';
  if (Object.keys(fields).length) fail(422, 'invalid', 'Please check the highlighted fields.', fields);
}

function overview(): AdminOverview {
  const now = Date.now();
  const all = flags.empty.includes('bookings') ? [] : state.bookings;
  const upcoming = all.filter((b) => b.status === 'confirmed' && Date.parse(b.start) > now).sort((a, b) => a.start.localeCompare(b.start));
  const monthAgo = now - 30 * 86400000;
  const integ = state.integrations;
  const reconnect = state.hosts.filter((h) => h.google?.status === 'needs_reconnect');
  const warnings: AdminOverview['warnings'] = [];
  if (integ.twilio.configured && !integ.anthropic.configured) {
    warnings.push({ key: 'assistant_scripted', message: 'Reminder calls use a simple scripted assistant until you add an Anthropic key.', href: '/admin/integrations' });
  }
  for (const h of reconnect) warnings.push({ key: `reconnect_${h.id}`, message: `${h.name}'s Google Calendar needs to be reconnected.`, href: '/admin/team' });
  for (const h of state.hosts.filter((x) => !x.google && x.icsFeeds.length === 0)) {
    warnings.push({ key: `no_calendar_${h.id}`, message: `${h.name} has no calendar connected, so their busy times are not checked.`, href: '/admin/team' });
  }
  return {
    upcoming: upcoming.slice(0, 8).map(adminBooking),
    stats: {
      upcomingCount: upcoming.length,
      last30Count: all.filter((b) => Date.parse(b.createdAt) > monthAgo).length,
      cancelledLast30: all.filter((b) => b.status === 'cancelled' && b.cancellation && Date.parse(b.cancellation.at) > monthAgo).length,
      confirmedByAssistant: all.filter((b) => b.attendance.confirmedVia === 'call').length,
    },
    checklist: [
      { key: 'google', label: 'Connect your Google Calendar', done: integ.google.ownerConnected, href: '/admin/integrations' },
      { key: 'availability', label: 'Set your weekly hours', done: true, href: '/admin/availability' },
      { key: 'event', label: 'Create your first event type', done: state.eventTypes.length > 0, href: '/admin/event-types' },
      { key: 'email', label: 'Choose how emails are sent', done: integ.email.resolved !== 'none', href: '/admin/integrations' },
      { key: 'sms', label: 'Add Twilio for texts and reminder calls', done: integ.twilio.configured, href: '/admin/integrations' },
      { key: 'assistant', label: 'Add an Anthropic key for the voice assistant', done: integ.anthropic.configured, href: '/admin/integrations' },
      { key: 'design', label: 'Make the booking page yours', done: state.site.theme.preset !== 'forest' || !!state.site.theme.logoAssetId, href: '/admin/design' },
    ],
    warnings,
    publicUrl: `${origin()}${basePath()}`,
  };
}

function bootstrap(): AdminBootstrap {
  return {
    site: clone(state.site),
    hosts: clone(state.hosts),
    eventTypes: clone(state.eventTypes).sort((a, b) => a.position - b.position),
    integrations: clone(state.integrations),
    publicUrl: `${origin()}${basePath()}`,
  };
}

function applyHostUpdate(host: AdminHost, u: HostUpdate, self: boolean): void {
  const fields: Record<string, string> = {};
  if (u.name !== undefined && !u.name.trim()) fields.name = 'Please enter a name.';
  if (u.email !== undefined && !self && !EMAIL.test(u.email)) fields.email = 'Please enter a valid email address.';
  if (u.timezone !== undefined && !isValidZone(u.timezone)) fields.timezone = 'Unknown time zone.';
  if (u.addIcsFeed && !/^(https|webcal):\/\//.test(u.addIcsFeed.url)) fields['addIcsFeed.url'] = 'The calendar link must start with https://';
  if (Object.keys(fields).length) fail(422, 'invalid', 'Please check the highlighted fields.', fields);

  if (u.name !== undefined) host.name = u.name.trim();
  if (u.email !== undefined && !self) host.email = u.email.trim();
  if (u.title !== undefined) host.title = u.title;
  if (u.avatarAssetId !== undefined) {
    host.avatarAssetId = u.avatarAssetId;
    host.avatarUrl = assetUrlOf(u.avatarAssetId);
  }
  if (u.phone !== undefined) host.phone = u.phone || undefined;
  if (u.timezoneMode !== undefined) host.timezoneMode = u.timezoneMode;
  if (u.timezone !== undefined) host.timezone = u.timezone;
  if (u.deviceTimezone && isValidZone(u.deviceTimezone) && host.timezoneMode === 'device') host.timezone = u.deviceTimezone;
  if (u.schedules !== undefined) host.schedules = clone(u.schedules);
  if (u.defaultScheduleId !== undefined) host.defaultScheduleId = u.defaultScheduleId;
  if (u.notify !== undefined) host.notify = { ...u.notify };
  if (host.google) {
    if (u.busyCalendarIds !== undefined) host.google.busyCalendarIds = u.busyCalendarIds.slice();
    if (u.writeCalendarId !== undefined) host.google.writeCalendarId = u.writeCalendarId;
  }
  if (u.addIcsFeed) host.icsFeeds = [...host.icsFeeds, { id: nextId('ics'), label: u.addIcsFeed.label.trim() || 'Calendar feed' }];
  if (u.removeIcsFeedId) host.icsFeeds = host.icsFeeds.filter((f) => f.id !== u.removeIcsFeedId);
}

function calendarsOf(host: AdminHost): GoogleCalendarListItem[] {
  if (!host.google) fail(409, 'google_not_connected', 'Connect Google Calendar first.');
  return [
    { id: 'primary', summary: host.google.email, primary: true, accessRole: 'owner', backgroundColor: '#2f6b57' },
    { id: 'family@group.calendar.google.com', summary: 'Family', primary: false, accessRole: 'owner', backgroundColor: '#b7791f' },
    { id: 'travel@group.calendar.google.com', summary: 'Travel', primary: false, accessRole: 'writer', backgroundColor: '#3b6fd4' },
    { id: 'en.ke#holiday@group.v.calendar.google.com', summary: 'Holidays in Kenya', primary: false, accessRole: 'reader', backgroundColor: '#8a8f98' },
  ];
}

function hostByToken(id: string, token: unknown): AdminHost {
  const host = state.hosts.find((h) => h.id === id);
  if (!host || token !== DEMO_TOKEN) fail(404, 'not_found', 'This link is not valid any more. Ask for a new one.');
  return host;
}

// ───────────── router ─────────────

interface Call {
  params: string[];
  query: Query;
  body: Record<string, unknown>;
}

type Handler = (call: Call) => unknown;

const routes: { method: string; pattern: RegExp; failKey?: string; write?: boolean; handler: Handler }[] = [];

function on(method: string, path: string, handler: Handler, opts: { failKey?: string; write?: boolean } = {}): void {
  const pattern = new RegExp(`^${path.replace(/[.]/g, '\\.').replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
  routes.push({ method, pattern, handler, ...opts });
}

// public
on('GET', '/public/site', () => publicSite(), { failKey: 'site' });

on(
  'GET',
  '/public/event/:slug',
  ({ params }): PublicEventResponse => {
    const et = state.eventTypes.find((e) => e.slug === params[0] && e.active);
    if (!et) fail(404, 'not_found', 'This meeting type does not exist or is no longer offered.');
    return { site: publicSite(), eventType: publicEventType(et) };
  },
  { failKey: 'event' },
);

on('GET', '/public/slots', ({ query }): SlotsResponse => {
  const et = state.eventTypes.find((e) => e.slug === query.slug);
  if (!et) fail(404, 'not_found', 'This meeting type does not exist.');
  const durationMin = Number(query.duration) || et.defaultDuration;
  const base = { durationMin, hostTimezone: owner().timezone };
  if (!et.active) return { ...base, slots: [], unavailableReason: 'inactive' };
  if (flags.fail.includes('slots')) return { ...base, slots: [], unavailableReason: 'calendar_error' };
  if (flags.empty.includes('slots')) return { ...base, slots: [] };
  if (!et.durations.includes(durationMin)) fail(422, 'invalid', 'That meeting length is not offered.', { duration: 'Not offered' });
  const from = Date.parse(String(query.from));
  const to = Date.parse(String(query.to));
  if (!Number.isFinite(from) || !Number.isFinite(to)) fail(422, 'invalid', 'A valid date range is needed.');
  const ignore = typeof query.reschedule === 'string' && state.tokens[query.reschedule] === query.t ? query.reschedule : undefined;
  return { ...base, slots: generateSlots(et, durationMin, from, to, ignore).map((s) => ({ start: new Date(s.start).toISOString() })) };
});

on('POST', '/public/bookings', ({ body }) => createBooking(body as unknown as CreateBookingRequest));

on('GET', '/public/bookings/:id', ({ params, query }): GetBookingResponse => {
  const b = findBooking(params[0], query.t);
  const et = state.eventTypes.find((e) => e.id === b.eventTypeId);
  return { booking: publicBooking(b), site: publicSite(), eventType: et ? publicEventType(et) : null };
});

on('POST', '/public/bookings/:id/cancel', ({ params, body }) => {
  const b = findBooking(params[0], body.t);
  if (b.status === 'confirmed' && Date.parse(b.start) <= Date.now()) fail(409, 'too_late', 'This meeting has already started, so it can no longer be cancelled here.');
  cancel(b, 'invitee', body.reason);
  return { booking: publicBooking(b) };
});

on('POST', '/public/bookings/:id/reschedule', ({ params, body }) => {
  const b = findBooking(params[0], body.t);
  if (b.status !== 'confirmed') fail(409, 'cancelled', 'This booking was cancelled. Please book a new time.');
  if (Date.parse(b.start) <= Date.now()) fail(409, 'too_late', 'This meeting has already started, so it can no longer be moved.');
  const et = state.eventTypes.find((e) => e.id === b.eventTypeId);
  const startMs = Date.parse(String(body.start));
  if (!et || !Number.isFinite(startMs) || b.invitee.name.toLowerCase() === 'conflict' || !slotStillFree(et, b.durationMin, startMs, b.id)) {
    fail(409, 'slot_taken', 'That time was just taken. Please pick another one.');
  }
  const now = new Date().toISOString();
  b.rescheduledFromStart = b.start;
  b.start = new Date(startMs).toISOString();
  b.end = new Date(startMs + b.durationMin * 60000).toISOString();
  b.rescheduleCount += 1;
  b.attendance = {};
  if (typeof body.timezone === 'string' && isValidZone(body.timezone)) b.invitee.timezone = body.timezone;
  b.timeline.push({ at: now, type: 'rescheduled', detail: 'Moved by the invitee' });
  b.updatedAt = now;
  save();
  return { booking: publicBooking(b) };
});

on('POST', '/public/bookings/:id/confirm', ({ params, body }) => {
  const b = findBooking(params[0], body.t);
  if (b.status !== 'confirmed') fail(409, 'cancelled', 'This booking was cancelled.');
  if (!b.attendance.confirmedAt) {
    const now = new Date().toISOString();
    b.attendance = { ...b.attendance, confirmedAt: now, confirmedVia: 'link' };
    b.timeline.push({ at: now, type: 'attendance_confirmed', detail: 'Confirmed from the manage page' });
    save();
  }
  return { booking: publicBooking(b) };
});

// auth
on('GET', '/auth/state', () => ({ ...state.auth }));

on('POST', '/auth/setup', ({ body }) => {
  if (!state.auth.setupRequired) fail(409, 'already_set_up', 'This site is already set up. Please sign in.');
  const fields: Record<string, string> = {};
  if (body.code !== 'dev-setup-code') fields.code = 'That setup code is not right.';
  if (String(body.password ?? '').length < 10) fields.password = 'Use at least 10 characters.';
  if (Object.keys(fields).length) fail(422, 'invalid', 'Please check the highlighted fields.', fields);
  const o = owner();
  if (typeof body.deviceTimezone === 'string' && isValidZone(body.deviceTimezone)) o.timezone = body.deviceTimezone;
  state.auth = { setupRequired: false, authenticated: true };
  save();
  return { ok: true };
});

on('POST', '/auth/login', ({ body }) => {
  if (state.auth.setupRequired) fail(409, 'setup_required', 'Finish the first-time setup before signing in.');
  if (!body.password || body.password === 'wrong') fail(401, 'invalid_credentials', 'That password is not right.');
  state.auth.authenticated = true;
  save();
  return { ok: true };
});

on('POST', '/auth/logout', () => {
  state.auth.authenticated = false;
  save();
  return { ok: true };
});

on('POST', '/auth/password', ({ body }) => {
  requireAdmin();
  if (body.current === 'wrong') fail(422, 'invalid', 'Your current password is not right.', { current: 'That is not your current password.' });
  if (String(body.next ?? '').length < 10) fail(422, 'invalid', 'Use at least 10 characters.', { next: 'Use at least 10 characters.' });
  return { ok: true };
});

// admin
on('GET', '/admin/bootstrap', () => (requireAdmin(), bootstrap()), { failKey: 'bootstrap' });
on('GET', '/admin/overview', () => (requireAdmin(), overview()), { failKey: 'overview' });

on(
  'PUT',
  '/admin/site',
  ({ body }) => {
    requireAdmin();
    state.site = { ...deepMerge(state.site, body), ownerHostId: state.site.ownerHostId, updatedAt: new Date().toISOString() };
    if (state.site.theme.customCss.length > 20000) fail(422, 'invalid', 'Custom CSS is limited to 20 kB.', { 'theme.customCss': 'Too long' });
    const o = owner();
    o.avatarAssetId = state.site.profile.avatarAssetId ?? null;
    o.avatarUrl = assetUrlOf(o.avatarAssetId);
    state.integrations.anthropic.model = state.site.assistant.model;
    refreshEmailStatus();
    save();
    return { site: clone(state.site) };
  },
  { write: true },
);

on(
  'POST',
  '/admin/event-types',
  ({ body }) => {
    requireAdmin();
    const now = new Date().toISOString();
    const input = body as Partial<EventType>;
    const title = String(input.title ?? 'New event type').trim();
    const baseSlug = String(input.slug ?? title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
    let slug = baseSlug;
    for (let n = 2; !input.slug && (state.eventTypes.some((e) => e.slug === slug) || RESERVED_SLUGS.includes(slug)); n++) slug = `${baseSlug}-${n}`;
    const et = newEventType(now, { ...input, id: nextId('evt'), slug, title, position: state.eventTypes.length });
    validateEventType(et);
    state.eventTypes.push(et);
    save();
    return { eventType: clone(et) };
  },
  { write: true },
);

on(
  'PUT',
  '/admin/event-types/:id',
  ({ params, body }) => {
    requireAdmin();
    const i = state.eventTypes.findIndex((e) => e.id === params[0]);
    if (i < 0) fail(404, 'not_found', 'That event type no longer exists.');
    const current = state.eventTypes[i];
    const patch = body as Partial<EventType>;
    const next: EventType = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      scheduling: { ...current.scheduling, ...(patch.scheduling ?? {}) },
      confirmation: { ...current.confirmation, ...(patch.confirmation ?? {}) },
    };
    next.durations = next.durations.slice().sort((a, b) => a - b);
    if (!next.durations.includes(next.defaultDuration)) next.defaultDuration = next.durations[0];
    validateEventType(next);
    state.eventTypes[i] = next;
    save();
    return { eventType: clone(next) };
  },
  { write: true },
);

on(
  'DELETE',
  '/admin/event-types/:id',
  ({ params }) => {
    requireAdmin();
    state.eventTypes = state.eventTypes.filter((e) => e.id !== params[0]);
    state.eventTypes.forEach((e, i) => (e.position = i));
    save();
    return { ok: true };
  },
  { write: true },
);

on(
  'POST',
  '/admin/event-types/:id/duplicate',
  ({ params }) => {
    requireAdmin();
    const source = state.eventTypes.find((e) => e.id === params[0]);
    if (!source) fail(404, 'not_found', 'That event type no longer exists.');
    const now = new Date().toISOString();
    let slug = `${source.slug}-copy`;
    for (let n = 2; state.eventTypes.some((e) => e.slug === slug); n++) slug = `${source.slug}-copy-${n}`;
    const copy: EventType = { ...clone(source), id: nextId('evt'), slug, title: `${source.title} (copy)`, position: state.eventTypes.length, createdAt: now, updatedAt: now };
    state.eventTypes.push(copy);
    save();
    return { eventType: clone(copy) };
  },
  { write: true },
);

on(
  'PUT',
  '/admin/event-types-order',
  ({ body }) => {
    requireAdmin();
    const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
    const rank = (id: string) => {
      const i = ids.indexOf(id);
      return i < 0 ? ids.length + 1 : i;
    };
    state.eventTypes.sort((a, b) => rank(a.id) - rank(b.id) || a.position - b.position);
    state.eventTypes.forEach((e, i) => (e.position = i));
    save();
    return { eventTypes: clone(state.eventTypes) };
  },
  { write: true },
);

// The real server runs the slot engine for this. The demo data's hosts always share some hours.
on('POST', '/admin/event-types-check', () => (requireAdmin(), { ok: true }));

on('GET', '/admin/hosts', () => (requireAdmin(), { hosts: clone(state.hosts) }));

on(
  'POST',
  '/admin/hosts',
  ({ body }): HostInviteResponse => {
    requireAdmin();
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();
    const fields: Record<string, string> = {};
    if (!name) fields.name = 'Please enter a name.';
    if (!EMAIL.test(email)) fields.email = 'Please enter a valid email address.';
    else if (email === 'taken@example.com' || state.hosts.some((h) => h.email.toLowerCase() === email.toLowerCase())) fields.email = 'Someone with this email is already on the team.';
    if (Object.keys(fields).length) fail(422, 'invalid', 'Please check the highlighted fields.', fields);
    const id = nextId('host');
    const host: AdminHost = {
      id,
      role: 'member',
      name,
      email,
      title: '',
      avatarAssetId: null,
      avatarUrl: null,
      timezone: owner().timezone,
      timezoneMode: 'device',
      schedules: [defaultSchedule(`sch_${id}`)],
      defaultScheduleId: `sch_${id}`,
      google: null,
      icsFeeds: [],
      hasInviteLink: true,
      notify: { email: true, sms: false },
      calendarHealth: null,
    };
    state.hosts.push(host);
    save();
    return { host: clone(host), inviteUrl: `${origin()}${basePath()}/host/${id}?t=${DEMO_TOKEN}` };
  },
  { write: true },
);

on(
  'PUT',
  '/admin/hosts/:id',
  ({ params, body }) => {
    requireAdmin();
    const host = state.hosts.find((h) => h.id === params[0]);
    if (!host) fail(404, 'not_found', 'That person is no longer on the team.');
    applyHostUpdate(host, body as HostUpdate, false);
    save();
    return { host: clone(host) };
  },
  // The shell sends { deviceTimezone } on every load: that must keep working under ?mock_fail=save.
  {},
);

on(
  'DELETE',
  '/admin/hosts/:id',
  ({ params }) => {
    requireAdmin();
    const host = state.hosts.find((h) => h.id === params[0]);
    if (!host) return { ok: true };
    if (host.role === 'owner') fail(409, 'owner', 'The owner cannot be removed.');
    const used = state.eventTypes.filter((e) => e.hostIds.includes(host.id));
    if (used.length) fail(409, 'host_in_use', `${host.name} still hosts ${used.map((e) => `"${e.title}"`).join(', ')}. Remove them from those event types first.`);
    state.hosts = state.hosts.filter((h) => h.id !== host.id);
    save();
    return { ok: true };
  },
  { write: true },
);

on(
  'POST',
  '/admin/hosts/:id/invite',
  ({ params }) => {
    requireAdmin();
    const host = state.hosts.find((h) => h.id === params[0]);
    if (!host) fail(404, 'not_found', 'That person is no longer on the team.');
    host.hasInviteLink = true;
    save();
    return { host: clone(host), inviteUrl: `${origin()}${basePath()}/host/${host.id}?t=${DEMO_TOKEN}` };
  },
  { write: true },
);

on('GET', '/admin/hosts/:id/calendars', ({ params }) => {
  requireAdmin();
  const host = state.hosts.find((h) => h.id === params[0]);
  if (!host) fail(404, 'not_found', 'That person is no longer on the team.');
  return { calendars: calendarsOf(host) };
});

on(
  'POST',
  '/admin/hosts/:id/google/disconnect',
  ({ params }) => {
    requireAdmin();
    const host = state.hosts.find((h) => h.id === params[0]);
    if (!host) fail(404, 'not_found', 'That person is no longer on the team.');
    host.google = null;
    host.calendarHealth = null;
    if (host.timezoneMode === 'google') host.timezoneMode = 'device';
    if (host.id === state.site.ownerHostId) {
      state.integrations.google.ownerConnected = false;
      state.integrations.google.ownerEmail = undefined;
      refreshEmailStatus();
    }
    save();
    return { host: clone(host) };
  },
  { write: true },
);

on(
  'GET',
  '/admin/bookings',
  ({ query }): AdminBookingsResponse => {
    requireAdmin();
    const now = Date.now();
    const scope = String(query.scope ?? 'upcoming');
    const q = String(query.q ?? '').trim().toLowerCase();
    let list = flags.empty.includes('bookings') ? [] : state.bookings.slice();
    if (scope === 'cancelled') list = list.filter((b) => b.status === 'cancelled').sort((a, b) => b.start.localeCompare(a.start));
    else if (scope === 'past') list = list.filter((b) => b.status === 'confirmed' && Date.parse(b.end) <= now).sort((a, b) => b.start.localeCompare(a.start));
    else list = list.filter((b) => b.status === 'confirmed' && Date.parse(b.end) > now).sort((a, b) => a.start.localeCompare(b.start));
    if (q) list = list.filter((b) => `${b.invitee.name} ${b.invitee.email} ${b.eventTitle}`.toLowerCase().includes(q));
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    return { bookings: list.slice(offset, offset + limit).map(adminBooking), total: list.length };
  },
  { failKey: 'bookings' },
);

on('GET', '/admin/bookings/:id', ({ params }) => {
  requireAdmin();
  const b = state.bookings.find((x) => x.id === params[0]);
  if (!b) fail(404, 'not_found', 'That booking no longer exists.');
  return { booking: adminBooking(b) };
});

on(
  'POST',
  '/admin/bookings/:id/cancel',
  ({ params, body }) => {
    requireAdmin();
    const b = state.bookings.find((x) => x.id === params[0]);
    if (!b) fail(404, 'not_found', 'That booking no longer exists.');
    cancel(b, 'host', body.reason);
    return { booking: adminBooking(b) };
  },
  { write: true },
);

on(
  'POST',
  '/admin/bookings/:id/no-show',
  ({ params, body }) => {
    requireAdmin();
    const b = state.bookings.find((x) => x.id === params[0]);
    if (!b) fail(404, 'not_found', 'That booking no longer exists.');
    const now = new Date().toISOString();
    b.attendance = { ...b.attendance, noShow: !!body.noShow };
    b.timeline.push({ at: now, type: body.noShow ? 'marked_no_show' : 'no_show_cleared' });
    b.updatedAt = now;
    save();
    return { booking: adminBooking(b) };
  },
  { write: true },
);

on(
  'DELETE',
  '/admin/bookings/:id',
  ({ params }) => {
    requireAdmin();
    const b = state.bookings.find((x) => x.id === params[0]);
    if (!b) return { ok: true };
    if (b.status === 'confirmed' && Date.parse(b.end) > Date.now()) fail(409, 'upcoming', 'This meeting has not happened yet. Cancel it first, then you can delete it.');
    state.bookings = state.bookings.filter((x) => x.id !== b.id);
    save();
    return { ok: true };
  },
  { write: true },
);

on('GET', '/admin/integrations',(): IntegrationsStatus => (requireAdmin(), clone(state.integrations)));

on(
  'PUT',
  '/admin/integrations',
  ({ body }) => {
    requireAdmin();
    const u = body as IntegrationsUpdate;
    const integ = state.integrations;
    if (u.google) {
      if (u.google.clientId !== undefined) {
        integ.google.clientIdMasked = u.google.clientId ? mask(u.google.clientId, 4, 27) : undefined;
        integ.google.configured = !!u.google.clientId;
      }
      if (u.google.clientSecret === '') integ.google.configured = false;
    }
    if (u.twilio) {
      if (u.twilio.accountSid !== undefined) integ.twilio.accountSidMasked = u.twilio.accountSid ? mask(u.twilio.accountSid) : undefined;
      if (u.twilio.fromNumber !== undefined) integ.twilio.fromNumber = u.twilio.fromNumber || undefined;
      if (u.twilio.messagingServiceSid !== undefined) integ.twilio.messagingServiceSid = u.twilio.messagingServiceSid || undefined;
      const cleared = u.twilio.accountSid === '' || u.twilio.authToken === '';
      integ.twilio.configured = !cleared && !!integ.twilio.accountSidMasked && !!(integ.twilio.fromNumber || integ.twilio.messagingServiceSid);
    }
    if (u.anthropic && u.anthropic.apiKey !== undefined) integ.anthropic.configured = !!u.anthropic.apiKey;
    if (u.resend && u.resend.apiKey !== undefined) integ.email.resendConfigured = !!u.resend.apiKey;
    refreshEmailStatus();
    save();
    return clone(integ);
  },
  { write: true },
);

on('POST', '/admin/integrations/test', ({ body }): IntegrationTestResponse => {
  requireAdmin();
  const req = body as unknown as IntegrationTestRequest;
  const integ = state.integrations;
  switch (req.channel) {
    case 'email':
      if (integ.email.resolved === 'none') return { ok: false, detail: 'No email provider is set up yet.' };
      return { ok: true, detail: `Test email sent to ${req.to || owner().email} through ${integ.email.resolved === 'gmail' ? 'Gmail' : 'Resend'}.` };
    case 'sms':
      if (!integ.twilio.configured) return { ok: false, detail: 'Twilio is not set up yet.' };
      if (!req.to) return { ok: false, detail: 'Enter a phone number to send the test text to.' };
      return { ok: true, detail: `Test text sent to ${req.to}.` };
    case 'call':
      if (!integ.twilio.configured) return { ok: false, detail: 'Twilio is not set up yet.' };
      if (!req.to) return { ok: false, detail: 'Enter a phone number for the test call.' };
      return { ok: true, detail: `Calling ${req.to} now. ${state.site.assistant.name} will introduce herself.` };
    case 'google':
      if (!integ.google.ownerConnected) return { ok: false, detail: 'Google Calendar is not connected.' };
      return { ok: true, detail: `Read 14 busy blocks from ${integ.google.ownerEmail ?? 'your calendar'} for the next 7 days.` };
    default:
      if (!integ.anthropic.configured) return { ok: false, detail: 'No Anthropic key has been added.' };
      return { ok: true, detail: `${integ.anthropic.model} answered in 0.8 seconds.` };
  }
});

on(
  'POST',
  '/admin/assets',
  ({ body }): AssetUploadResponse => {
    requireAdmin();
    const dataUrl = String(body.dataUrl ?? '');
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) fail(422, 'invalid', 'Please upload a PNG, JPEG, WebP or GIF image.');
    if (dataUrl.length * 0.75 > 3 * 1024 * 1024) fail(413, 'too_large', 'That image is larger than 3 MB.');
    const id = nextId('asset');
    state.assets[id] = dataUrl;
    save();
    return { id, url: dataUrl };
  },
  { write: true },
);

on(
  'DELETE',
  '/admin/assets/:id',
  ({ params }) => {
    requireAdmin();
    delete state.assets[params[0]];
    save();
    return { ok: true };
  },
  { write: true },
);

// co-host self-service
on('GET', '/host/:id', ({ params, query }): HostSelfResponse => {
  const host = hostByToken(params[0], query.t);
  return {
    host: clone(host),
    siteName: state.site.profile.name,
    theme: clone(state.site.theme),
    googleConfigured: state.integrations.google.configured,
    calendars: host.google ? calendarsOf(host) : null,
  };
});

on('PUT', '/host/:id', ({ params, query, body }) => {
  const host = hostByToken(params[0], query.t);
  applyHostUpdate(host, body as HostUpdate, true);
  save();
  return { host: clone(host) };
});

on('GET', '/host/:id/calendars', ({ params, query }) => ({ calendars: calendarsOf(hostByToken(params[0], query.t)) }));

on(
  'POST',
  '/host/:id/google/disconnect',
  ({ params, query }) => {
    const host = hostByToken(params[0], query.t);
    host.google = null;
    host.calendarHealth = null;
    if (host.timezoneMode === 'google') host.timezoneMode = 'device';
    save();
    return { ok: true, host: clone(host) };
  },
  { write: true },
);

// ───────────── entry point ─────────────

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/** Answers one API call from memory. Same contract as the real backend: resolves with JSON, rejects with ApiFailure. */
export async function mockRequest<T>(method: string, path: string, query: Query, body: unknown, signal?: AbortSignal): Promise<T> {
  const delay = flags.delay ?? (method === 'GET' ? (path === '/public/slots' ? 380 : 220) : 480);
  if (delay > 0) await wait(delay, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    if (route.failKey && route.failKey !== 'slots' && flags.fail.includes(route.failKey)) {
      fail(500, 'server_error', 'Something went wrong on our side. Please try again in a moment.');
    }
    if (route.write && flags.fail.includes('save')) fail(500, 'server_error', 'Your changes could not be saved. Please try again.');
    const params = match.slice(1).map((p) => decodeURIComponent(p));
    const result = route.handler({ params, query, body: (body && typeof body === 'object' ? body : {}) as Record<string, unknown> });
    if (import.meta.env.DEV) console.debug(`[mock api] ${method} ${path}`, { query, body, result });
    return clone(result) as T;
  }
  return fail(404, 'not_found', `No mock for ${method} ${path}`);
}

export { COHOST_ID, OWNER_ID };
