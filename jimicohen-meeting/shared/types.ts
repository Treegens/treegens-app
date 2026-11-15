/**
 * Shared data model + API contract. Source of truth for server and client.
 * All instants are UTC ISO-8601 strings. All wall-clock values (HH:MM, YYYY-MM-DD)
 * are interpreted in an explicitly named IANA zone.
 */

export type ISODateTime = string; // "2026-11-17T12:00:00.000Z"
export type IanaZone = string; // "Africa/Nairobi"
export type HHMM = string; // "09:00". "24:00" is allowed as a range end.
export type LocalDate = string; // "2026-11-17"
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

// ───────────────────────────── Theme / design ─────────────────────────────

export interface ThemeColors {
  primary: string; // brand colour, buttons, selected states
  accent: string; // secondary highlight
  background: string; // page background base
  surface: string; // card background
  text: string;
  muted: string; // secondary text
  border: string;
}

export interface ThemeBackground {
  type: 'solid' | 'gradient' | 'mesh' | 'pattern' | 'image';
  gradientFrom?: string;
  gradientTo?: string;
  gradientAngle?: number; // degrees
  pattern?: 'dots' | 'grid' | 'topo' | 'leaves' | 'waves' | 'none';
  imageAssetId?: string | null;
  overlayOpacity?: number; // 0..1 dark/light scrim over image
  blur?: number; // px
}

export interface Theme {
  preset: string; // preset key or "custom"
  scheme: 'fixed' | 'auto'; // auto = use darkColors when the visitor prefers dark
  colors: ThemeColors;
  darkColors?: ThemeColors | null;
  background: ThemeBackground;
  fontHeading: string; // key in FONT_CATALOG
  fontBody: string;
  fontScale: number; // 0.9 .. 1.15
  radius: number; // px, 0..28
  buttonStyle: 'solid' | 'outline' | 'soft' | 'gradient';
  buttonShape: 'rounded' | 'pill' | 'square';
  cardStyle: 'flat' | 'bordered' | 'elevated' | 'glass';
  shadow: 0 | 1 | 2 | 3;
  layout: 'split' | 'stacked' | 'centered';
  calendarStyle: 'grid' | 'minimal' | 'bubbles';
  slotStyle: 'list' | 'grid' | 'chips';
  density: 'comfortable' | 'compact';
  avatarShape: 'circle' | 'rounded' | 'square';
  showAvatar: boolean;
  coverAssetId?: string | null;
  coverHeight: number; // px, 0 = no cover
  logoAssetId?: string | null;
  timeFormat: 'auto' | '12h' | '24h';
  weekStart: 'auto' | 'sunday' | 'monday';
  animations: 'none' | 'subtle' | 'lively';
  confetti: boolean;
  texts: {
    ctaLabel: string; // "Confirm booking"
    pickTimeLabel: string; // "Pick a time"
    confirmationTitle: string; // "You're booked"
    confirmationBody: string; // supports {{variables}}
    footerNote: string;
  };
  customCss: string;
  hideBranding: boolean;
}

// ───────────────────────────── Availability ─────────────────────────────

export interface TimeRange {
  start: HHMM;
  end: HHMM;
}

export type WeeklyHours = Record<Weekday, TimeRange[]>;

export interface DateOverride {
  date: LocalDate; // in the host's time zone
  ranges: TimeRange[]; // empty = unavailable all day
}

export interface Schedule {
  id: string;
  name: string;
  weekly: WeeklyHours;
  overrides: DateOverride[];
}

// ───────────────────────────── Hosts ─────────────────────────────

export interface HostGoogle {
  email: string;
  refreshTokenEnc: string; // sealed with purpose "google-refresh"
  scopes: string[];
  busyCalendarIds: string[]; // calendars checked for conflicts
  writeCalendarId: string; // calendar events are written to ("primary" by default)
  gmailSend: boolean; // gmail.send scope granted
  status: 'ok' | 'needs_reconnect';
  connectedAt: ISODateTime;
}

export interface IcsFeed {
  id: string;
  label: string;
  urlEnc: string; // sealed with purpose "ics-url"
}

export interface Host {
  id: string;
  role: 'owner' | 'member';
  name: string;
  email: string;
  title?: string;
  avatarAssetId?: string | null;
  phone?: string; // E.164, for host SMS notifications
  timezone: IanaZone;
  /** google = follow Google Calendar's zone, device = follow the browser the host last used, fixed = never change automatically */
  timezoneMode: 'google' | 'device' | 'fixed';
  schedules: Schedule[];
  defaultScheduleId: string;
  google?: HostGoogle | null;
  icsFeeds: IcsFeed[];
  inviteTokenHash?: string | null; // sha256 of the member self-service token
  notify: { email: boolean; sms: boolean };
  calendarHealth?: { ok: boolean; message?: string; at: ISODateTime } | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ───────────────────────────── Event types ─────────────────────────────

export type EventKind = 'solo' | 'collective' | 'round_robin';

export type LocationType =
  | 'google_meet'
  | 'phone_host_calls' // host calls the invitee (phone required)
  | 'phone_invitee_calls' // invitee calls the number in value
  | 'in_person' // value = address
  | 'custom_link' // value = url (Zoom room etc.)
  | 'ask_invitee'; // invitee types the location

export interface LocationConfig {
  type: LocationType;
  value?: string;
  label?: string; // optional display label override
}

export type QuestionType = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'url' | 'number';

export interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export type ReminderChannel = 'email' | 'sms' | 'call';

export interface ReminderRule {
  id: string;
  enabled: boolean;
  channel: ReminderChannel;
  audience: 'invitee' | 'host';
  trigger: 'before_start' | 'after_end';
  offsetMinutes: number; // >= 0
  subject?: string; // email only; template
  body?: string; // template; empty = built-in default for the channel
}

export interface EventScheduling {
  minNoticeMinutes: number;
  maxDaysAhead: number; // rolling window
  dateRange?: { start: LocalDate; end: LocalDate } | null; // optional hard window (owner tz)
  bufferBeforeMin: number;
  bufferAfterMin: number;
  slotIncrementMin: number; // 5..120
  maxPerDay?: number | null; // per assigned host, per host-local day, for this event type
  /** Which schedule each host uses for this event. Missing = host.defaultScheduleId */
  scheduleIds: Record<string, string>;
  /** Optional extra restriction in the owner's zone; intersected with every host's hours */
  restrictHours?: WeeklyHours | null;
}

export interface EventType {
  id: string;
  slug: string;
  title: string;
  description: string;
  emoji?: string;
  color?: string; // overrides theme primary on this event
  coverAssetId?: string | null;
  kind: EventKind;
  hostIds: string[]; // solo = 1, collective/round_robin >= 2
  durations: number[]; // minutes, ascending
  defaultDuration: number;
  locations: LocationConfig[]; // >1 = invitee chooses
  visibility: 'public' | 'unlisted';
  active: boolean;
  scheduling: EventScheduling;
  questions: Question[];
  allowGuests: boolean;
  maxGuests: number;
  phone: 'hidden' | 'optional' | 'required';
  reminders: ReminderRule[];
  confirmation: { message?: string; redirectUrl?: string };
  /** Add the invitee as an attendee on the Google Calendar event (Google emails them the invite) */
  googleInvite: boolean;
  themeOverride?: Partial<Theme> | null;
  position: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ───────────────────────────── Bookings ─────────────────────────────

export interface BookingLocation {
  type: LocationType;
  label: string; // "Google Meet", "Phone call", ...
  value?: string; // address / phone / link / invitee text
  joinUrl?: string; // meet or custom link
}

export interface TimelineEntry {
  at: ISODateTime;
  type: string; // "created", "reminder_email_sent", "call_completed", ...
  detail?: string;
}

export interface Booking {
  id: string;
  eventTypeId: string;
  eventSlug: string;
  eventTitle: string;
  kind: EventKind;
  hostIds: string[]; // assigned hosts
  start: ISODateTime;
  end: ISODateTime;
  durationMin: number;
  status: 'confirmed' | 'cancelled';
  invitee: { name: string; email: string; phone?: string; timezone: IanaZone; locale?: string };
  guests: string[];
  answers: { questionId: string; label: string; value: string }[];
  location: BookingLocation;
  consent: { sms: boolean; call: boolean; at: ISODateTime; text: string };
  google?: {
    hostId: string;
    calendarId: string;
    eventId: string;
    htmlLink?: string;
    meetUrl?: string;
    syncedAt?: ISODateTime;
    error?: string;
  } | null;
  attendance: { confirmedAt?: ISODateTime; confirmedVia?: 'call' | 'sms' | 'link'; noShow?: boolean };
  cancellation?: { at: ISODateTime; by: 'invitee' | 'host' | 'assistant'; reason?: string } | null;
  rescheduledFromStart?: ISODateTime | null;
  rescheduleCount: number;
  source: 'page' | 'embed' | 'admin';
  utm?: Record<string, string>;
  timeline: TimelineEntry[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Compact entry kept in the single CAS-protected booking index */
export interface BookingIndexEntry {
  id: string;
  start: ISODateTime;
  end: ISODateTime;
  hostIds: string[];
  eventTypeId: string;
  status: 'confirmed' | 'cancelled';
  inviteeName: string;
  inviteeEmail: string;
  eventTitle: string;
}

// ───────────────────────────── Jobs (outbound messages + sync) ─────────────────────────────

export type MessageKind =
  | 'confirmation' // invitee, right after booking
  | 'host_new' // host, right after booking
  | 'rescheduled'
  | 'cancelled'
  | 'reminder'
  | 'followup'
  | 'manage_link' // sent when the assistant promises a reschedule/cancel link
  | 'host_alert'; // operational alert to the owner

export interface Job {
  key: string; // storage key: jobs/<dueAt>_<id>
  id: string;
  type: 'message' | 'gcal_sync';
  bookingId: string;
  dueAt: ISODateTime;
  channel?: ReminderChannel;
  audience?: 'invitee' | 'host';
  kind?: MessageKind;
  ruleId?: string;
  subject?: string;
  body?: string;
  attempt: number;
  createdAt: ISODateTime;
}

export interface SendResult {
  ok: boolean;
  provider: string; // "resend" | "gmail" | "twilio" | "mock" | "none"
  id?: string;
  error?: string;
  skipped?: string; // reason when deliberately not sent (no consent, outside call window, not configured)
}

// ───────────────────────────── Voice calls ─────────────────────────────

export interface CallRecord {
  id: string; // our id, passed in webhook URLs
  bookingId: string;
  twilioSid?: string;
  to: string;
  status: 'queued' | 'in_progress' | 'completed' | 'voicemail' | 'no_answer' | 'failed';
  turns: { role: 'assistant' | 'caller'; text: string; at: ISODateTime }[];
  pendingCancel: boolean;
  outcome?: 'confirmed' | 'reschedule_requested' | 'cancelled' | 'no_decision' | 'voicemail';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ───────────────────────────── Site settings + secrets ─────────────────────────────

export interface AssistantSettings {
  name: string; // "Ava"
  voice: string; // Twilio <Say> voice, e.g. "Google.en-US-Chirp3-HD-Aoede"
  language: string; // "en-US"
  persona: string; // extra guidance for tone
  model: string; // Claude model id
  callWindowStartHour: number; // invitee-local, inclusive
  callWindowEndHour: number; // invitee-local, exclusive
}

export interface SiteSettings {
  ownerHostId: string;
  profile: {
    name: string;
    headline: string;
    welcome: string;
    avatarAssetId?: string | null;
    links: { label: string; url: string }[];
  };
  theme: Theme;
  assistant: AssistantSettings;
  booking: {
    reminderOptInDefault: boolean; // SMS/call toggles start on when a phone is entered
    consentText: string;
    privacyUrl?: string;
  };
  email: {
    provider: 'auto' | 'resend' | 'gmail' | 'none';
    fromName: string;
    fromEmail: string; // used with Resend; Gmail always sends as the connected account
    replyTo: string;
  };
  updatedAt: ISODateTime;
}

export interface Secrets {
  google?: { clientId: string; clientSecret: string };
  twilio?: { accountSid: string; authToken: string; fromNumber: string; messagingServiceSid?: string };
  anthropic?: { apiKey: string };
  resend?: { apiKey: string };
}

// ═════════════════════════════ API contract ═════════════════════════════
// Every route lives under `${BASE}/api`. JSON in, JSON out. Errors: { error: { code, message, fields? } }.

export interface ApiError {
  error: { code: string; message: string; fields?: Record<string, string> };
}

// ───────── public ─────────

export interface PublicHost {
  id: string;
  name: string;
  title?: string;
  avatarUrl: string | null;
}

export interface PublicEventType {
  id: string;
  slug: string;
  title: string;
  description: string;
  emoji?: string;
  color?: string;
  coverUrl: string | null;
  kind: EventKind;
  hosts: PublicHost[];
  durations: number[];
  defaultDuration: number;
  locations: { type: LocationType; label: string; detail?: string }[];
  questions: Question[];
  allowGuests: boolean;
  maxGuests: number;
  phone: 'hidden' | 'optional' | 'required';
  minNoticeMinutes: number;
  maxDaysAhead: number;
  themeOverride?: Partial<Theme> | null;
}

export interface PublicSite {
  profile: { name: string; headline: string; welcome: string; avatarUrl: string | null; links: { label: string; url: string }[] };
  theme: Theme;
  /** resolved asset URLs for theme images */
  themeAssets: { coverUrl: string | null; logoUrl: string | null; backgroundUrl: string | null };
  eventTypes: PublicEventType[]; // public + active only
  booking: { reminderOptInDefault: boolean; consentText: string; privacyUrl?: string };
  assistantName: string;
  features: { sms: boolean; calls: boolean };
  ownerTimezone: IanaZone;
}

/** GET /public/event/:slug */
export interface PublicEventResponse {
  site: PublicSite;
  eventType: PublicEventType;
}

/** GET /public/slots?slug=&duration=&from=&to=[&reschedule=<bookingId>&t=<token>] */
export interface SlotsResponse {
  slots: { start: ISODateTime }[]; // ascending
  durationMin: number;
  hostTimezone: IanaZone;
  /** set when availability could not be computed (calendar connection problem) */
  unavailableReason?: 'calendar_error' | 'inactive';
}

export interface CreateBookingRequest {
  slug: string;
  start: ISODateTime;
  durationMin: number;
  name: string;
  email: string;
  phone?: string;
  timezone: IanaZone;
  locale?: string;
  guests?: string[];
  answers?: Record<string, string | string[] | boolean>; // by question id
  locationIndex?: number; // index into eventType.locations
  locationText?: string; // for ask_invitee
  consent?: { sms: boolean; call: boolean };
  source?: 'page' | 'embed';
  utm?: Record<string, string>;
  /** honeypot — must be empty */
  website?: string;
  /** ms the form was open; bots submit instantly */
  elapsedMs?: number;
}

export interface PublicBooking {
  id: string;
  status: 'confirmed' | 'cancelled';
  eventTitle: string;
  eventSlug: string;
  start: ISODateTime;
  end: ISODateTime;
  durationMin: number;
  hosts: PublicHost[];
  invitee: { name: string; email: string; phone?: string; timezone: IanaZone };
  guests: string[];
  location: BookingLocation;
  confirmationMessage?: string;
  redirectUrl?: string;
  canReschedule: boolean;
  canCancel: boolean;
  calendarLinks: { google: string; outlook: string; ics: string };
  cancellation?: { at: ISODateTime; by: string; reason?: string } | null;
  rescheduledFromStart?: ISODateTime | null;
  attendanceConfirmed: boolean;
}

/** POST /public/bookings → 201 */
export interface CreateBookingResponse {
  booking: PublicBooking;
  manageToken: string;
}

/** GET /public/bookings/:id?t= */
export interface GetBookingResponse {
  booking: PublicBooking;
  site: PublicSite;
  eventType: PublicEventType | null;
}

/** POST /public/bookings/:id/cancel */
export interface CancelBookingRequest {
  t: string;
  reason?: string;
}

/** POST /public/bookings/:id/reschedule */
export interface RescheduleBookingRequest {
  t: string;
  start: ISODateTime;
  timezone?: IanaZone;
}

// ───────── auth ─────────

/** GET /auth/state */
export interface AuthState {
  setupRequired: boolean;
  authenticated: boolean;
}
/** POST /auth/setup { code, password, deviceTimezone } · POST /auth/login { password } · POST /auth/logout · POST /auth/password { current, next } */

// ───────── admin ─────────

export interface AdminHost {
  id: string;
  role: 'owner' | 'member';
  name: string;
  email: string;
  title?: string;
  avatarAssetId?: string | null;
  avatarUrl: string | null;
  phone?: string;
  timezone: IanaZone;
  timezoneMode: 'google' | 'device' | 'fixed';
  schedules: Schedule[];
  defaultScheduleId: string;
  google: {
    email: string;
    status: 'ok' | 'needs_reconnect';
    busyCalendarIds: string[];
    writeCalendarId: string;
    gmailSend: boolean;
  } | null;
  icsFeeds: { id: string; label: string }[];
  hasInviteLink: boolean;
  notify: { email: boolean; sms: boolean };
  calendarHealth?: { ok: boolean; message?: string; at: ISODateTime } | null;
}

/** PUT /admin/hosts/:id and PUT /host/:id accept this (all optional) */
export interface HostUpdate {
  name?: string;
  email?: string;
  title?: string;
  avatarAssetId?: string | null;
  phone?: string;
  timezone?: IanaZone;
  timezoneMode?: 'google' | 'device' | 'fixed';
  /** the browser's zone; applied when timezoneMode = device */
  deviceTimezone?: IanaZone;
  schedules?: Schedule[];
  defaultScheduleId?: string;
  busyCalendarIds?: string[];
  writeCalendarId?: string;
  notify?: { email: boolean; sms: boolean };
  addIcsFeed?: { label: string; url: string };
  removeIcsFeedId?: string;
}

/** PUT /admin/hosts/:id and PUT /host/:id answer with this */
export interface HostUpdateResponse {
  host: AdminHost;
  /** the host's zone after the update */
  timezone: IanaZone;
  /** true when this update moved the host to another zone (a new device, a new Google Calendar zone) */
  timezoneChanged: boolean;
}

export interface GoogleCalendarListItem {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  backgroundColor?: string;
}

export interface IntegrationsStatus {
  baseUrl: string;
  google: { configured: boolean; clientIdMasked?: string; redirectUri: string; ownerConnected: boolean; ownerEmail?: string };
  twilio: { configured: boolean; accountSidMasked?: string; fromNumber?: string; messagingServiceSid?: string };
  anthropic: { configured: boolean; model: string };
  email: {
    setting: 'auto' | 'resend' | 'gmail' | 'none';
    resolved: 'resend' | 'gmail' | 'none';
    resendConfigured: boolean;
    gmailAvailable: boolean;
    fromEmail: string;
  };
  /**
   * Which credentials are set in the deployment's environment. Those win over anything saved in
   * the dashboard, so the dashboard shows them as fixed instead of offering Replace and Remove.
   */
  environment?: {
    google: { clientId: boolean; clientSecret: boolean };
    twilio: { accountSid: boolean; authToken: boolean; fromNumber: boolean };
    anthropic: { apiKey: boolean };
    resend: { apiKey: boolean };
  };
}

/** PUT /admin/integrations — only provided keys change; empty string clears a secret */
export interface IntegrationsUpdate {
  google?: { clientId?: string; clientSecret?: string };
  twilio?: { accountSid?: string; authToken?: string; fromNumber?: string; messagingServiceSid?: string };
  anthropic?: { apiKey?: string };
  resend?: { apiKey?: string };
}

/** POST /admin/integrations/test */
export interface IntegrationTestRequest {
  channel: 'email' | 'sms' | 'call' | 'google' | 'anthropic';
  to?: string; // email address or phone
}
export interface IntegrationTestResponse {
  ok: boolean;
  detail: string;
}

export interface AdminBooking extends Booking {
  hosts: PublicHost[];
  manageUrl: string; // manage link the host can open or forward
}

/** GET /admin/bookings?scope=upcoming|past|cancelled&q=&limit=&offset= */
export interface AdminBookingsResponse {
  bookings: AdminBooking[];
  total: number;
  /** how many bookings each tab holds, whatever is being searched for */
  counts?: { upcoming: number; past: number; cancelled: number };
}

export interface AdminOverview {
  upcoming: AdminBooking[]; // next 8
  stats: { upcomingCount: number; last30Count: number; cancelledLast30: number; confirmedByAssistant: number };
  checklist: { key: string; label: string; done: boolean; href: string }[];
  warnings: { key: string; message: string; href?: string }[];
  publicUrl: string;
}

/** GET /admin/bootstrap — everything the dashboard needs on load */
export interface AdminBootstrap {
  site: SiteSettings;
  hosts: AdminHost[];
  eventTypes: EventType[];
  integrations: IntegrationsStatus;
  publicUrl: string;
  /** base URL to use in embed snippets (script src and iframe src); falls back to publicUrl */
  embedBaseUrl?: string;
  /** voices offered for the AI assistant */
  voiceOptions?: { id: string; label: string }[];
  /** template variables available in reminder wording */
  templateVariables?: { key: string; description: string }[];
}

/** POST /admin/hosts → { host: AdminHost, inviteUrl } · POST /admin/hosts/:id/invite → { inviteUrl } */
export interface HostInviteResponse {
  host: AdminHost;
  inviteUrl: string;
}

/** POST /admin/assets (body: { dataUrl, purpose }) → { id, url } */
export interface AssetUploadResponse {
  id: string;
  url: string;
}

/** GET /host/:id?t= — member self-service */
export interface HostSelfResponse {
  host: AdminHost;
  siteName: string;
  theme: Theme;
  googleConfigured: boolean;
  calendars: GoogleCalendarListItem[] | null;
}
