/**
 * DEV ONLY. Seed data for the in-browser mock API (see mockApi.ts). Never imported by
 * production code: api.ts loads the mock through a dynamic import behind import.meta.env.DEV.
 */
import { DEFAULT_ASSISTANT, DEFAULT_CONSENT_TEXT, DEFAULT_THEME, defaultReminders, defaultSchedule, newEventType } from '../../shared/defaults';
import type { AdminHost, Booking, EventType, IntegrationsStatus, Question, SiteSettings, TimelineEntry } from '../../shared/types';
import { addDays, dayKey, weekdayOfKey, zonedToMs } from '../lib/tz';

export const OWNER_ZONE = 'Africa/Nairobi';
export const COHOST_ZONE = 'Europe/London';
export const OWNER_ID = 'host_owner';
export const COHOST_ID = 'host_alex';
/** manage token of every seeded booking, so manage pages can be opened by URL: /booking/bk_demo_upcoming?t=demo */
export const DEMO_TOKEN = 'demo';

export interface MockState {
  version: number;
  auth: { setupRequired: boolean; authenticated: boolean };
  site: SiteSettings;
  hosts: AdminHost[];
  eventTypes: EventType[];
  bookings: Booking[];
  tokens: Record<string, string>;
  integrations: IntegrationsStatus;
  /** uploaded images: id → data URL */
  assets: Record<string, string>;
  seq: number;
}

export const MOCK_STATE_VERSION = 5;

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A drawn avatar so the image path of <Avatar> is exercised without shipping a photo. */
export const OWNER_AVATAR = svgDataUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#1d5a3c'/><stop offset='1' stop-color='#0f3323'/></linearGradient></defs><rect width='96' height='96' fill='url(#g)'/><circle cx='48' cy='38' r='17' fill='#e9c9a0'/><path d='M14 96c2-22 16-33 34-33s32 11 34 33z' fill='#f2ede2'/><path d='M31 36c0-12 8-20 18-20s17 7 17 17c-6-1-11-4-14-9-4 6-11 10-21 12z' fill='#2b1d14'/></svg>`,
);

function ownerHost(): AdminHost {
  return {
    id: OWNER_ID,
    role: 'owner',
    name: 'Jimi Cohen',
    email: 'jimi@example.com',
    title: 'Founder',
    avatarAssetId: 'asset_owner_avatar',
    avatarUrl: OWNER_AVATAR,
    phone: '+254700000001',
    timezone: OWNER_ZONE,
    timezoneMode: 'device',
    schedules: [
      defaultSchedule(),
      {
        id: 'sch_mornings',
        name: 'Mornings only',
        weekly: {
          0: [],
          1: [{ start: '08:00', end: '12:00' }],
          2: [{ start: '08:00', end: '12:00' }],
          3: [{ start: '08:00', end: '12:00' }],
          4: [{ start: '08:00', end: '12:00' }],
          5: [{ start: '08:00', end: '11:00' }],
          6: [],
        },
        overrides: [],
      },
    ],
    defaultScheduleId: 'sch_default',
    google: { id: 'gacc_owner_main', email: 'jimi@example.com', status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: true },
    googleExtra: [{ id: 'gacc_owner_work', email: 'jimi@work.example.com', status: 'ok', busyCalendarIds: ['primary'], connectedAt: new Date().toISOString(), health: null }],
    icsFeeds: [],
    hasInviteLink: false,
    notify: { email: true, sms: false },
    calendarHealth: { ok: true, at: new Date().toISOString() },
  };
}

function coHost(): AdminHost {
  return {
    id: COHOST_ID,
    role: 'member',
    name: 'Alex Rivera',
    email: 'alex@example.com',
    title: 'Head of Partnerships',
    avatarAssetId: null,
    avatarUrl: null,
    timezone: COHOST_ZONE,
    timezoneMode: 'google',
    schedules: [defaultSchedule('sch_alex')],
    defaultScheduleId: 'sch_alex',
    google: { id: 'gacc_alex_main', email: 'alex@example.com', status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false },
    googleExtra: [],
    icsFeeds: [{ id: 'ics_1', label: 'Personal calendar' }],
    hasInviteLink: true,
    notify: { email: true, sms: false },
    calendarHealth: { ok: true, at: new Date().toISOString() },
  };
}

const CONSULT_QUESTIONS: Question[] = [
  { id: 'q_company', label: 'Company or project', type: 'text', required: true, placeholder: 'Where do you work?' },
  { id: 'q_goal', label: 'What would you like to get out of this?', type: 'textarea', required: true, placeholder: 'A sentence or two is plenty' },
  { id: 'q_stage', label: 'Where are you right now?', type: 'select', required: false, options: ['Just exploring', 'Planning a project', 'Already underway', 'Something else'] },
  { id: 'q_heard', label: 'How did you hear about Jimi?', type: 'radio', required: false, options: ['A friend or colleague', 'A talk or podcast', 'Social media', 'Search'] },
  { id: 'q_topics', label: 'Topics to cover', type: 'checkbox', required: false, options: ['Partnerships', 'Funding', 'Field operations', 'Technology'] },
  { id: 'q_link', label: 'Link to anything useful', type: 'url', required: false, placeholder: 'https://' },
  { id: 'q_people', label: 'How many people will join from your side?', type: 'number', required: false, placeholder: '1' },
];

function seedEventTypes(nowIso: string): EventType[] {
  return [
    newEventType(nowIso, {
      id: 'evt_intro',
      slug: 'intro',
      title: 'Intro call',
      description: 'A quick hello to see how we can work together. Pick the length that suits you.',
      emoji: '👋',
      durations: [15, 30, 45],
      defaultDuration: 30,
      position: 0,
      scheduling: { minNoticeMinutes: 240, maxDaysAhead: 60, dateRange: null, bufferBeforeMin: 0, bufferAfterMin: 10, slotIncrementMin: 30, maxPerDay: null, scheduleIds: {}, restrictHours: null },
    }),
    newEventType(nowIso, {
      id: 'evt_strategy',
      slug: 'strategy',
      title: 'Strategy session',
      description: 'Work through a plan with both of us. You only see times when Jimi and Alex are both free.',
      emoji: '🧭',
      color: '#e0b04e',
      kind: 'collective',
      hostIds: [OWNER_ID, COHOST_ID],
      durations: [60],
      defaultDuration: 60,
      position: 1,
      questions: [
        { id: 'q_company', label: 'Company or project', type: 'text', required: true },
        { id: 'q_agenda', label: 'What should we prepare?', type: 'textarea', required: false },
      ],
      scheduling: { minNoticeMinutes: 720, maxDaysAhead: 45, dateRange: null, bufferBeforeMin: 10, bufferAfterMin: 10, slotIncrementMin: 30, maxPerDay: 2, scheduleIds: {}, restrictHours: null },
      confirmation: { message: 'We will send a short agenda the day before. Looking forward to it.', redirectUrl: '' },
    }),
    newEventType(nowIso, {
      id: 'evt_consult',
      slug: 'consultation',
      title: 'Consultation',
      description: 'A longer conversation about your project, online, by phone or over coffee in Nairobi.',
      emoji: '🌱',
      durations: [45],
      defaultDuration: 45,
      position: 2,
      locations: [
        { type: 'google_meet' },
        { type: 'phone_host_calls' },
        { type: 'in_person', value: 'Java House, Kimathi Street, Nairobi' },
        { type: 'ask_invitee', label: 'Somewhere else' },
      ],
      questions: CONSULT_QUESTIONS,
      allowGuests: true,
      maxGuests: 3,
      phone: 'optional',
      scheduling: { minNoticeMinutes: 1440, maxDaysAhead: 30, dateRange: null, bufferBeforeMin: 15, bufferAfterMin: 15, slotIncrementMin: 45, maxPerDay: 3, scheduleIds: {}, restrictHours: null },
    }),
    newEventType(nowIso, {
      id: 'evt_priority',
      slug: 'priority',
      title: 'Priority call',
      description: 'For partners with something urgent. Whoever is free first takes the call.',
      emoji: '⚡',
      kind: 'round_robin',
      hostIds: [OWNER_ID, COHOST_ID],
      durations: [20],
      defaultDuration: 20,
      visibility: 'unlisted',
      position: 3,
      locations: [{ type: 'phone_host_calls' }],
      phone: 'required',
      scheduling: { minNoticeMinutes: 60, maxDaysAhead: 14, dateRange: null, bufferBeforeMin: 0, bufferAfterMin: 5, slotIncrementMin: 20, maxPerDay: null, scheduleIds: {}, restrictHours: null },
    }),
    newEventType(nowIso, {
      id: 'evt_press',
      slug: 'press',
      title: 'Press interview',
      description: 'Interviews and podcast recordings.',
      emoji: '🎙️',
      durations: [30, 60],
      defaultDuration: 30,
      active: false,
      position: 4,
    }),
    // The meeting behind jimicohen.com/pod: joint, unlisted, in the Eco Champions look.
    newEventType(nowIso, {
      id: 'evt_eco_champions',
      slug: 'eco-champions',
      title: 'Eco Champions conversation',
      description: 'A conversation with the hosts of Eco Champions, the podcast interviewing the forces of nature on climate and sustainability.',
      emoji: '🌿',
      kind: 'collective',
      hostIds: [OWNER_ID, COHOST_ID],
      durations: [30, 60],
      defaultDuration: 30,
      visibility: 'unlisted',
      brandId: 'brand_eco_champions',
      position: 5,
    }),
  ];
}

function seedSite(nowIso: string): SiteSettings {
  return {
    ownerHostId: OWNER_ID,
    profile: {
      name: 'Jimi Cohen',
      headline: 'Book time with Jimi',
      welcome: 'Pick a meeting type and choose a time that works for you. Times show in your own time zone.',
      avatarAssetId: 'asset_owner_avatar',
      links: [
        { label: 'Website', url: 'https://jimicohen.com' },
        { label: 'LinkedIn', url: 'https://www.linkedin.com' },
      ],
    },
    theme: structuredClone(DEFAULT_THEME),
    assistant: { ...DEFAULT_ASSISTANT },
    booking: { reminderOptInDefault: true, consentText: DEFAULT_CONSENT_TEXT, privacyUrl: 'https://jimicohen.com/privacy' },
    email: { provider: 'auto', fromName: 'Jimi Cohen', fromEmail: '', replyTo: 'jimi@example.com' },
    shortLinks: { meet: 'evt_intro', pod: 'evt_eco_champions' },
    updatedAt: nowIso,
  };
}

function seedIntegrations(origin: string): IntegrationsStatus {
  return {
    baseUrl: `${origin}/meeting`,
    google: {
      configured: true,
      clientIdMasked: '1234…apps.googleusercontent.com',
      redirectUri: `${origin}/meeting/api/google/callback`,
      ownerConnected: true,
      ownerEmail: 'jimi@example.com',
    },
    twilio: { configured: true, accountSidMasked: 'AC12…9f3a', fromNumber: '+15550100123' },
    anthropic: { configured: false, model: DEFAULT_ASSISTANT.model },
    email: { setting: 'auto', resolved: 'gmail', resendConfigured: false, gmailAvailable: true, fromEmail: '' },
  };
}

interface SeedBooking {
  id: string;
  /** whole days from today (owner zone); negative = past */
  dayOffset: number;
  time: string;
  eventId: string;
  name: string;
  email: string;
  zone: string;
  phone?: string;
  status?: 'confirmed' | 'cancelled';
  confirmedVia?: 'call' | 'sms' | 'link';
  noShow?: boolean;
  location?: 'meet' | 'phone' | 'in_person';
  cancelBy?: 'invitee' | 'host' | 'assistant';
  cancelReason?: string;
  rescheduled?: boolean;
  guests?: string[];
}

const SEED_BOOKINGS: SeedBooking[] = [
  { id: 'bk_demo_upcoming', dayOffset: 2, time: '10:00', eventId: 'evt_intro', name: 'Amina Wanjiru', email: 'amina@example.org', zone: 'Africa/Nairobi', phone: '+254711000111', confirmedVia: 'call' },
  { id: 'bk_up_2', dayOffset: 1, time: '14:30', eventId: 'evt_intro', name: 'Daniel Okoth', email: 'daniel@example.com', zone: 'Africa/Kampala' },
  { id: 'bk_up_3', dayOffset: 3, time: '15:00', eventId: 'evt_strategy', name: 'Sofia Marin', email: 'sofia@example.com', zone: 'Europe/Madrid', phone: '+34600111222', guests: ['pablo@example.com'] },
  { id: 'bk_up_4', dayOffset: 4, time: '11:15', eventId: 'evt_consult', name: 'Priya Nair', email: 'priya@example.in', zone: 'Asia/Kolkata', location: 'phone', phone: '+919800011122', confirmedVia: 'sms' },
  { id: 'bk_up_5', dayOffset: 6, time: '09:30', eventId: 'evt_intro', name: 'Lukas Brandt', email: 'lukas@example.de', zone: 'Europe/Berlin', rescheduled: true },
  { id: 'bk_up_6', dayOffset: 8, time: '13:00', eventId: 'evt_strategy', name: 'Hannah Levi', email: 'hannah@example.com', zone: 'Asia/Jerusalem' },
  { id: 'bk_up_7', dayOffset: 9, time: '16:00', eventId: 'evt_consult', name: 'Grace Mwangi', email: 'grace@example.co.ke', zone: 'Africa/Nairobi', location: 'in_person', phone: '+254722000333' },
  { id: 'bk_up_8', dayOffset: 11, time: '10:30', eventId: 'evt_intro', name: 'Kenji Sato', email: 'kenji@example.jp', zone: 'Asia/Tokyo' },
  { id: 'bk_up_9', dayOffset: 13, time: '12:00', eventId: 'evt_priority', name: 'Noah Fischer', email: 'noah@example.com', zone: 'America/New_York', location: 'phone', phone: '+12125550144' },
  { id: 'bk_demo_past', dayOffset: -3, time: '11:00', eventId: 'evt_intro', name: 'Elena Petrova', email: 'elena@example.com', zone: 'Europe/Sofia', confirmedVia: 'link' },
  { id: 'bk_past_2', dayOffset: -5, time: '15:30', eventId: 'evt_consult', name: 'Samuel Otieno', email: 'samuel@example.co.ke', zone: 'Africa/Nairobi', location: 'in_person', phone: '+254733000444', confirmedVia: 'call' },
  { id: 'bk_past_3', dayOffset: -8, time: '09:00', eventId: 'evt_intro', name: 'Maya Goldberg', email: 'maya@example.com', zone: 'America/Los_Angeles', noShow: true },
  { id: 'bk_past_4', dayOffset: -12, time: '14:00', eventId: 'evt_strategy', name: 'Omar Haddad', email: 'omar@example.ae', zone: 'Asia/Dubai', phone: '+971500001234' },
  { id: 'bk_past_5', dayOffset: -19, time: '10:00', eventId: 'evt_intro', name: 'Chloe Martin', email: 'chloe@example.fr', zone: 'Europe/Paris' },
  { id: 'bk_demo_cancelled', dayOffset: 5, time: '12:30', eventId: 'evt_intro', name: 'Tomás Herrera', email: 'tomas@example.mx', zone: 'America/Mexico_City', status: 'cancelled', cancelBy: 'invitee', cancelReason: 'Travelling that week, will rebook when I am back.' },
  { id: 'bk_can_2', dayOffset: -6, time: '13:30', eventId: 'evt_consult', name: 'Ingrid Solberg', email: 'ingrid@example.no', zone: 'Europe/Oslo', status: 'cancelled', cancelBy: 'assistant', cancelReason: 'Asked to cancel during the reminder call.', phone: '+4790011223' },
  { id: 'bk_can_3', dayOffset: 7, time: '16:30', eventId: 'evt_intro', name: 'Ben Carter', email: 'ben@example.com', zone: 'Europe/London', status: 'cancelled', cancelBy: 'host', cancelReason: 'Out of office that afternoon.' },
];

/** Moves a day offset onto a weekday so seeded meetings never land on a weekend. */
function weekdayKey(todayKey: string, offset: number): string {
  let key = addDays(todayKey, offset);
  const step = offset >= 0 ? 1 : -1;
  while (weekdayOfKey(key) === 0 || weekdayOfKey(key) === 6) key = addDays(key, step);
  return key;
}

export function locationFor(et: EventType, index: number, hostFirstName: string, inviteeText?: string): Booking['location'] {
  const loc = et.locations[index] ?? et.locations[0] ?? { type: 'google_meet' as const };
  switch (loc.type) {
    case 'google_meet':
      return { type: 'google_meet', label: loc.label ?? 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij' };
    case 'phone_host_calls':
      return { type: 'phone_host_calls', label: loc.label ?? 'Phone call', value: `${hostFirstName} will call you` };
    case 'phone_invitee_calls':
      return { type: 'phone_invitee_calls', label: loc.label ?? 'Phone call', value: loc.value };
    case 'in_person':
      return { type: 'in_person', label: loc.label ?? 'In person', value: loc.value };
    case 'custom_link':
      return { type: 'custom_link', label: loc.label ?? 'Video call', value: loc.value, joinUrl: loc.value };
    default:
      return { type: 'ask_invitee', label: loc.label ?? 'Your choice', value: inviteeText ?? '' };
  }
}

function seedBookings(now: number, eventTypes: EventType[]): Booking[] {
  const today = dayKey(now, OWNER_ZONE);
  return SEED_BOOKINGS.map((s, i): Booking => {
    const et = eventTypes.find((e) => e.id === s.eventId) ?? eventTypes[0];
    const key = weekdayKey(today, s.dayOffset);
    const startMs = zonedToMs(key, s.time, OWNER_ZONE);
    const duration = et.defaultDuration;
    const createdMs = Math.min(now - 3600_000, startMs) - (3 + (i % 5)) * 86400_000;
    const status = s.status ?? 'confirmed';
    const locIndex = s.location === 'phone' ? Math.max(0, et.locations.findIndex((l) => l.type === 'phone_host_calls')) : s.location === 'in_person' ? Math.max(0, et.locations.findIndex((l) => l.type === 'in_person')) : 0;
    const timeline: TimelineEntry[] = [
      { at: new Date(createdMs).toISOString(), type: 'created', detail: 'Booked from the public page' },
      { at: new Date(createdMs + 4000).toISOString(), type: 'confirmation_email_sent', detail: s.email },
      { at: new Date(createdMs + 6000).toISOString(), type: 'calendar_event_created', detail: 'Added to Google Calendar' },
    ];
    if (s.rescheduled) timeline.push({ at: new Date(createdMs + 86400_000).toISOString(), type: 'rescheduled', detail: 'Moved by the invitee' });
    if (startMs - 86400_000 < now) timeline.push({ at: new Date(startMs - 86400_000).toISOString(), type: 'reminder_email_sent', detail: '24 hours before' });
    if (s.confirmedVia === 'call') {
      timeline.push({ at: new Date(Math.min(now - 600_000, startMs - 7200_000)).toISOString(), type: 'call_completed', detail: 'Ava: "Are you still able to make it?" Caller: "Yes, see you then."' });
      timeline.push({ at: new Date(Math.min(now - 590_000, startMs - 7190_000)).toISOString(), type: 'attendance_confirmed', detail: 'Confirmed on the reminder call' });
    } else if (s.confirmedVia === 'sms') {
      timeline.push({ at: new Date(Math.min(now - 900_000, startMs - 3600_000)).toISOString(), type: 'attendance_confirmed', detail: 'Replied C to the reminder text' });
    } else if (s.confirmedVia === 'link') {
      timeline.push({ at: new Date(startMs - 5400_000).toISOString(), type: 'attendance_confirmed', detail: 'Confirmed from the reminder email' });
    }
    const cancelAt = status === 'cancelled' ? new Date(Math.min(now - 7200_000, startMs - 86400_000)).toISOString() : null;
    if (cancelAt) timeline.push({ at: cancelAt, type: 'cancelled', detail: s.cancelReason });
    if (s.noShow) timeline.push({ at: new Date(startMs + 1800_000).toISOString(), type: 'marked_no_show' });
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return {
      id: s.id,
      eventTypeId: et.id,
      eventSlug: et.slug,
      eventTitle: et.title,
      kind: et.kind,
      hostIds: et.kind === 'round_robin' ? [et.hostIds[0]] : et.hostIds.slice(),
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + duration * 60000).toISOString(),
      durationMin: duration,
      status,
      invitee: { name: s.name, email: s.email, phone: s.phone, timezone: s.zone, locale: 'en-US' },
      guests: s.guests ?? [],
      answers:
        et.id === 'evt_consult'
          ? [
              { questionId: 'q_company', label: 'Company or project', value: 'Greenbelt Collective' },
              { questionId: 'q_goal', label: 'What would you like to get out of this?', value: 'Advice on scaling a community tree nursery programme across three counties.' },
              { questionId: 'q_topics', label: 'Topics to cover', value: 'Partnerships, Field operations' },
            ]
          : et.id === 'evt_strategy'
            ? [{ questionId: 'q_company', label: 'Company or project', value: 'Northwind Foundation' }]
            : [{ questionId: 'q_topic', label: 'What would you like to talk about?', value: 'A possible partnership for next season.' }],
      location: locationFor(et, locIndex, 'Jimi'),
      consent: { sms: !!s.phone, call: !!s.phone, at: new Date(createdMs).toISOString(), text: s.phone ? DEFAULT_CONSENT_TEXT.replace('{{host_first_name}}', 'Jimi') : '' },
      google: { hostId: OWNER_ID, calendarId: 'primary', eventId: `gcal_${s.id}`, htmlLink: 'https://calendar.google.com/calendar/u/0/r', meetUrl: 'https://meet.google.com/abc-defg-hij', syncedAt: new Date(createdMs + 6000).toISOString() },
      attendance: { confirmedAt: s.confirmedVia ? new Date(startMs - 7190_000).toISOString() : undefined, confirmedVia: s.confirmedVia, noShow: s.noShow },
      cancellation: cancelAt ? { at: cancelAt, by: s.cancelBy ?? 'invitee', reason: s.cancelReason } : null,
      rescheduledFromStart: s.rescheduled ? new Date(startMs - 2 * 86400_000).toISOString() : null,
      rescheduleCount: s.rescheduled ? 1 : 0,
      source: 'page',
      utm: i % 4 === 0 ? { utm_source: 'newsletter' } : undefined,
      timeline,
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(createdMs + 6000).toISOString(),
    };
  });
}

export function seedState(now: number = Date.now()): MockState {
  const nowIso = new Date(now).toISOString();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
  const eventTypes = seedEventTypes(nowIso);
  const bookings = seedBookings(now, eventTypes);
  const tokens: Record<string, string> = {};
  for (const b of bookings) tokens[b.id] = DEMO_TOKEN;
  return {
    version: MOCK_STATE_VERSION,
    auth: { setupRequired: false, authenticated: true },
    site: seedSite(nowIso),
    hosts: [ownerHost(), coHost()],
    eventTypes,
    bookings,
    tokens,
    integrations: seedIntegrations(origin),
    assets: { asset_owner_avatar: OWNER_AVATAR },
    seq: 100,
  };
}

/** Reminder defaults, re-exported so the mock can build new event types the way the server does. */
export { defaultReminders };
