import type {
  AssistantSettings,
  EventType,
  Host,
  ReminderRule,
  Schedule,
  SiteSettings,
  Theme,
  WeeklyHours,
} from './types';

/** Default look: matches jimicohen.com (deep forest, cream ink, leaf green, Fraunces + Inter). */
export const DEFAULT_THEME: Theme = {
  preset: 'forest',
  scheme: 'fixed',
  colors: {
    primary: '#5ede8e',
    accent: '#e0b04e',
    background: '#0b1d14',
    surface: '#122d1f',
    text: '#f2ede2',
    muted: '#a8a493',
    border: '#2a4636',
  },
  darkColors: null,
  background: { type: 'mesh', gradientFrom: '#0b1d14', gradientTo: '#143524', gradientAngle: 160, pattern: 'none', overlayOpacity: 0.4, blur: 0 },
  fontHeading: 'fraunces',
  fontBody: 'inter',
  fontScale: 1,
  radius: 18,
  buttonStyle: 'solid',
  buttonShape: 'pill',
  cardStyle: 'glass',
  shadow: 2,
  layout: 'split',
  calendarStyle: 'bubbles',
  slotStyle: 'list',
  density: 'comfortable',
  avatarShape: 'circle',
  showAvatar: true,
  coverAssetId: null,
  coverHeight: 0,
  logoAssetId: null,
  timeFormat: 'auto',
  weekStart: 'auto',
  animations: 'subtle',
  confetti: true,
  texts: {
    ctaLabel: 'Confirm booking',
    pickTimeLabel: 'Pick a time',
    confirmationTitle: "You're booked",
    confirmationBody: 'A calendar invitation is on its way to {{invitee_email}}.',
    footerNote: '',
  },
  customCss: '',
  hideBranding: false,
};

export const WEEKDAY_HOURS: WeeklyHours = {
  0: [],
  1: [{ start: '09:00', end: '17:00' }],
  2: [{ start: '09:00', end: '17:00' }],
  3: [{ start: '09:00', end: '17:00' }],
  4: [{ start: '09:00', end: '17:00' }],
  5: [{ start: '09:00', end: '17:00' }],
  6: [],
};

export function defaultSchedule(id = 'sch_default'): Schedule {
  return { id, name: 'Working hours', weekly: structuredClone(WEEKDAY_HOURS), overrides: [] };
}

export const DEFAULT_ASSISTANT: AssistantSettings = {
  name: 'Ava',
  voice: 'Polly.Joanna-Neural',
  language: 'en-US',
  persona: 'Warm, brief and professional. Sounds like a capable executive assistant.',
  model: 'claude-opus-5-5',
  callWindowStartHour: 8,
  callWindowEndHour: 21,
};

export const DEFAULT_CONSENT_TEXT =
  "By adding your number you agree to receive reminder texts and an automated reminder call from {{host_first_name}}'s AI assistant about this meeting. Message and data rates may apply.";

export function defaultReminders(): ReminderRule[] {
  return [
    { id: 'rem_email_24h', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 1440 },
    { id: 'rem_call_2h', enabled: true, channel: 'call', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 },
    { id: 'rem_email_1h', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 },
    { id: 'rem_sms_15m', enabled: true, channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 15 },
  ];
}

export function defaultOwnerHost(nowIso: string, timezone = 'UTC'): Host {
  return {
    id: 'host_owner',
    role: 'owner',
    name: 'Jimi Cohen',
    email: '',
    title: '',
    avatarAssetId: null,
    timezone,
    timezoneMode: 'device',
    schedules: [defaultSchedule()],
    defaultScheduleId: 'sch_default',
    google: null,
    icsFeeds: [],
    inviteTokenHash: null,
    notify: { email: true, sms: false },
    calendarHealth: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function defaultSite(nowIso: string): SiteSettings {
  return {
    ownerHostId: 'host_owner',
    profile: {
      name: 'Jimi Cohen',
      headline: 'Book time with Jimi',
      welcome: 'Pick a meeting type below and choose a time that works. Times show in your own time zone.',
      avatarAssetId: null,
      links: [],
    },
    theme: structuredClone(DEFAULT_THEME),
    assistant: { ...DEFAULT_ASSISTANT },
    booking: { reminderOptInDefault: true, consentText: DEFAULT_CONSENT_TEXT, privacyUrl: '' },
    email: { provider: 'auto', fromName: 'Jimi Cohen', fromEmail: '', replyTo: '' },
    updatedAt: nowIso,
  };
}

export function newEventType(nowIso: string, partial: Partial<EventType> & Pick<EventType, 'id' | 'slug' | 'title'>): EventType {
  return {
    description: '',
    emoji: '',
    color: '',
    coverAssetId: null,
    kind: 'solo',
    hostIds: ['host_owner'],
    durations: [30],
    defaultDuration: 30,
    locations: [{ type: 'google_meet' }],
    visibility: 'public',
    active: true,
    scheduling: {
      minNoticeMinutes: 240,
      maxDaysAhead: 60,
      dateRange: null,
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      slotIncrementMin: 30,
      maxPerDay: null,
      scheduleIds: {},
      restrictHours: null,
    },
    questions: [{ id: 'q_topic', label: 'What would you like to talk about?', type: 'textarea', required: false }],
    allowGuests: true,
    maxGuests: 5,
    phone: 'optional',
    reminders: defaultReminders(),
    confirmation: { message: '', redirectUrl: '' },
    googleInvite: true,
    themeOverride: null,
    position: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...partial,
  };
}

export function starterEventTypes(nowIso: string): EventType[] {
  return [
    newEventType(nowIso, {
      id: 'evt_intro',
      slug: 'intro',
      title: 'Intro call',
      description: 'A quick hello to see how we can work together.',
      emoji: '👋',
      durations: [15],
      defaultDuration: 15,
      position: 0,
      scheduling: {
        minNoticeMinutes: 240,
        maxDaysAhead: 45,
        dateRange: null,
        bufferBeforeMin: 0,
        bufferAfterMin: 5,
        slotIncrementMin: 15,
        maxPerDay: null,
        scheduleIds: {},
        restrictHours: null,
      },
    }),
    newEventType(nowIso, {
      id: 'evt_meeting',
      slug: 'meeting',
      title: 'Meeting',
      description: 'Partnerships, speaking, press or a deeper conversation.',
      emoji: '🌱',
      durations: [30, 45, 60],
      defaultDuration: 30,
      position: 1,
    }),
  ];
}

/** Slugs that collide with app routes and may not be used for event types. */
export const RESERVED_SLUGS = ['admin', 'api', 'assets', 'booking', 'host', 'embed', 'embed.js', 'favicon.svg', 'index.html'];
