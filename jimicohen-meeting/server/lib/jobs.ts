/**
 * The outbound job queue: confirmations, reminders, follow-ups and calendar sync retries.
 *
 * How a job is kept from running twice or getting lost:
 *   1. One attempt, one runner. Before running attempt N of a job a runner must win
 *      claim("job-<id>-<N>"). Overlapping cron runs therefore never run the same attempt twice.
 *   2. One attempt, one successor. Attempt N+1 (retry) is due a fixed backoff after attempt N was
 *      claimed, so everybody who moves the job on computes the same queue key, and it is written
 *      create-only. A job can never fork into two copies, and a write that failed can be repeated.
 *   3. One recipient, one delivery. After a message is accepted by a provider, a "sent" marker is
 *      stored for that job and recipient. A later attempt of the same job skips recipients that
 *      already have one, so a retry after a half-finished run does not send again.
 *   4. No job is stranded. If a runner dies while holding a claim, the job is still in the queue
 *      with its claim taken. Later runs note when they first saw that and, ten minutes on, move
 *      the job to its next attempt (phone calls are dropped instead: ringing someone twice is
 *      worse than not ringing).
 */
import { DateTime, IANAZone } from 'luxon';
import { bookUrlFor, brandLine, brandOfView, eventColorFor, isSiteView, viewFor } from '../../shared/brands';
import { DEFAULT_ASSISTANT } from '../../shared/defaults';
import type {
  AssistantSettings,
  Booking,
  EventType,
  Host,
  ISODateTime,
  Job,
  MessageKind,
  ReminderChannel,
  ReminderRule,
  SendResult,
  SiteSettings,
} from '../../shared/types';
import { hmacHex, randomId, sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { renderEmailHtml, renderEmailText, sendEmail, urlsIn, type EmailMessage } from './email';
import { buildBookingIcs, calendarLinks } from './ics';
import { reserveOutbound } from './outbound';
import { noConsentReason } from './twilio';
import {
  cacheGet,
  cacheSet,
  claim,
  deleteJob,
  getBooking,
  getBookingIndex,
  getBookings,
  getEventType,
  getSite,
  listEventTypes,
  listHosts,
  listJobs,
  putJob,
  readClaim,
  releaseClaim,
  updateBooking,
} from './repo';
import { sendSms } from './sms';
import { buildVars, defaultMessage, firstName, renderTemplate, type TemplateVars } from './templates';
import { isEmail } from './validate';
import { startReminderCall } from './voice';

// ───────────────────────── types ─────────────────────────

/** Stored jobs carry two fields beyond the shared `Job` shape. They are plain JSON, so storage keeps them. */
export interface StoredJob extends Job {
  /** host messages: the one host this job is for. Absent = every host assigned to the booking. */
  hostId?: string;
  /** rule-driven reminders: the booking start this job was planned for. A reschedule makes the job obsolete. */
  forStart?: ISODateTime;
}

/** What the runner already loaded for the job, so handlers need not read it again. */
export interface JobRunExtra {
  booking: Booking | null;
}

export type JobHandler = (ctx: Ctx, job: Job, extra?: JobRunExtra) => Promise<SendResult>;

/** A SendResult plus a short human note for the booking timeline ("to sam@example.com via resend"). */
export type DeliveryResult = SendResult & { detail?: string };

type Audience = 'invitee' | 'host';

const MAX_ATTEMPTS = 4;
const BACKOFF_MINUTES = [2, 10, 30];
const DEFAULT_BUDGET_MS = 20_000;
/** A run may overshoot its budget by this much while the last job finishes. */
const BUDGET_GRACE_MS = 5_000;
const JOB_TIMEOUT_MS = 20_000;
const MIN_JOB_TIMEOUT_MS = 2_000;
const ORPHAN_AFTER_MS = 10 * 60_000;
const LOST_MARKER_TTL_SEC = 86_400;
const SENT_MARKER_TTL_SEC = 3 * 86_400;
/** A reminder set to "0 minutes before" still has to leave before the meeting begins. */
const REMINDER_MIN_LEAD_MS = 2 * 60_000;
/** A reminder call moved later, to when calling hours open, must still ring at least this long before the start. */
const CALL_MIN_LEAD_MS = 30 * 60_000;
/**
 * A reminder call moved earlier, to the last calling hour before the rule's moment, must ring at least this
 * long after the booking was made or moved: a call straight after booking reminds nobody. Counted from the
 * booking, not from a later change to the rules or the calling hours, which the invitee knows nothing of.
 */
const CALL_MIN_GAP_MS = 60 * 60_000;
export const SMS_MAX_LENGTH = 300;

// ───────────────────────── handlers ─────────────────────────

// `var` on purpose: booking.ts registers its handler while it is being loaded, which (through the
// import cycle jobs > voice > booking > jobs) can happen before this module's own statements have
// run. A hoisted `var` is simply undefined at that point; `let`/`const` would throw.
// eslint-disable-next-line no-var
var registeredHandlers: Map<string, JobHandler> | undefined;

export function registerJobHandler(type: Job['type'], handler: JobHandler): void {
  registeredHandlers ??= new Map();
  registeredHandlers.set(type, handler);
}

function handlerFor(type: string): JobHandler | null {
  return registeredHandlers?.get(type) ?? (type === 'message' ? deliverMessage : null);
}

// ───────────────────────── small helpers ─────────────────────────

function keyFor(dueAt: string, id: string): string {
  return `jobs/${dueAt}_${id}`;
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

function messageKind(job: Job): MessageKind {
  return job.kind ?? 'reminder';
}

/** Start of the timeline entry type: "reminder_email", "host_new_sms", or the job type for non-message jobs. */
function timelineLabel(job: Job): string {
  return job.type === 'message' ? `${messageKind(job)}_${job.channel ?? 'email'}` : job.type;
}

async function addTimeline(ctx: Ctx, bookingId: string | undefined, type: string, detail?: string): Promise<void> {
  if (!bookingId) return;
  const entry = { at: ctx.now().toISOString(), type, ...(detail ? { detail: detail.slice(0, 400) } : {}) };
  try {
    await updateBooking(ctx, bookingId, (b) => ({ ...b, timeline: [...(b.timeline ?? []), entry] }));
  } catch (err) {
    ctx.log('warn', 'jobs: could not write a timeline entry', { bookingId, type, error: shortError(err) });
  }
}

const SKIP_REASONS: Record<string, string> = {
  no_consent: 'the invitee did not agree to this kind of reminder',
  opted_out_sms: 'the invitee asked for no more texts',
  opted_out_call: 'the invitee asked not to be called again',
  recipient_opted_out: 'this number asked for no more texts',
  opted_out: 'this number asked not to be called again',
  no_phone: 'there is no phone number',
  no_email: 'there is no email address',
  no_recipient: 'there was nobody to send it to',
  invalid_recipient: 'the address is not valid',
  email_not_configured: 'email sending is not set up yet',
  outside_call_window: 'it was outside calling hours',
  no_call_time: 'there is no time inside calling hours before the meeting',
  daily_limit: 'the daily limit of texts or calls was reached',
  host_notifications_off: 'the host has these notifications switched off',
  rule_disabled: 'this reminder was switched off or removed',
  unsupported_channel: 'this kind of message cannot be sent on this channel',
  host_missing: 'the host no longer exists',
};

function skipText(reason: string): string {
  return SKIP_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

// ───────────────────────── enqueue ─────────────────────────

/**
 * Queues a job. `opts.id` gives it a fixed id instead of a fresh one: a job queued again under the
 * same id after an unclear failure shares its attempt claims and "sent" markers with the first
 * copy, so at most one of them delivers.
 */
export async function enqueueJob(ctx: Ctx, j: Omit<StoredJob, 'key' | 'id' | 'attempt' | 'createdAt'>, opts?: { id?: string }): Promise<Job> {
  const dueMs = Date.parse(j.dueAt);
  if (!Number.isFinite(dueMs)) throw new Error('enqueueJob: dueAt is not a valid time');
  const dueAt = new Date(dueMs).toISOString();
  const id = opts?.id && /^job_[A-Za-z0-9_-]{1,76}$/.test(opts.id) ? opts.id : randomId('job');
  const job: StoredJob = { ...j, dueAt, id, key: keyFor(dueAt, id), attempt: 0, createdAt: ctx.now().toISOString() };
  await putJob(ctx, job);
  return job;
}

async function removeBookingJobs(ctx: Ctx, bookingId: string, match: (job: Job) => boolean): Promise<number> {
  const jobs = (await listJobs(ctx)).filter((j) => j.bookingId === bookingId && match(j));
  await Promise.all(jobs.map((j) => deleteJob(ctx, j.key)));
  return jobs.length;
}

function isRuleJob(job: Job): boolean {
  return job.type === 'message' && (job.kind === 'reminder' || job.kind === 'followup');
}

/** The reminders and follow-ups of the given bookings, grouped by booking, from one read of the queue. */
async function ruleJobsByBooking(ctx: Ctx, bookingIds: string[]): Promise<Map<string, Job[]>> {
  const wanted = new Set(bookingIds);
  const byBooking = new Map<string, Job[]>();
  for (const job of await listJobs(ctx)) {
    if (!job.bookingId || !wanted.has(job.bookingId) || !isRuleJob(job)) continue;
    byBooking.set(job.bookingId, [...(byBooking.get(job.bookingId) ?? []), job]);
  }
  return byBooking;
}

/** Deletes the jobs. True when every one of them is gone. */
async function deleteAllJobs(ctx: Ctx, jobs: Job[]): Promise<boolean> {
  const results = await Promise.allSettled(jobs.map((j) => deleteJob(ctx, j.key)));
  return results.every((r) => r.status === 'fulfilled');
}

/**
 * Removes the reminders and follow-ups of many bookings with one read of the queue. Returns the
 * bookings whose jobs were all removed; pass `remindersCleared` to scheduleBookingJobs for those only.
 */
export async function removeReminderJobs(ctx: Ctx, bookingIds: string[]): Promise<Set<string>> {
  const byBooking = await ruleJobsByBooking(ctx, bookingIds);
  const cleared = new Set<string>();
  for (const id of new Set(bookingIds)) if (await deleteAllJobs(ctx, byBooking.get(id) ?? [])) cleared.add(id);
  return cleared;
}

/**
 * Rebuilds the reminders of many bookings after their event type's rules changed, with one read of
 * the queue for all of them. Each booking's old reminders are removed just before its new ones are
 * queued, so a run that is cut off part-way leaves the bookings it did not reach with their old
 * reminders: one at the old time is better than none. Returns how many bookings failed.
 */
export async function replanBookingReminders(
  ctx: Ctx,
  bookings: Booking[],
  eventType: EventType,
  onError?: (bookingId: string, err: unknown) => void,
): Promise<number> {
  const byBooking = await ruleJobsByBooking(ctx, bookings.map((b) => b.id));
  let failed = 0;
  for (const booking of bookings) {
    try {
      // A booking whose old reminders could not all be removed gets the usual per-booking clean-up.
      const cleared = await deleteAllJobs(ctx, byBooking.get(booking.id) ?? []);
      await scheduleBookingJobs(ctx, booking, eventType, null, { remindersCleared: cleared });
    } catch (err) {
      failed++;
      onError?.(booking.id, err);
    }
  }
  return failed;
}

const MAX_REPLANNED_CALLS = 500;
const REPLAN_CALLS_BUDGET_MS = 8_000;

/**
 * After the calling hours changed: moves every reminder call still waiting in the queue to the time
 * the new hours give it, with one read of the queue.
 *   - A moved call keeps its job id, so it shares its attempt claim and "sent" marker with the old
 *     copy and can still ring only once.
 *   - The new copy is written before the old one is removed, so a run that is cut off part-way leaves
 *     every call it did not reach at its old time, and never a booking with no call.
 *   - Calls that are due already, being placed, or a retry are left to the runner. So is a call the new
 *     hours leave no time for: the check when it is placed skips it then, unless the hours change back.
 *   - Each call is read again just before it is moved, so one that left the queue meanwhile (planned
 *     again, cancelled, placed) is not brought back next to the call that replaced it.
 * Calls already placed are not touched, and nothing new is planned: a booking whose call found no time
 * keeps the note that says so.
 */
export async function replanReminderCalls(
  ctx: Ctx,
  hours: Partial<CallHours> | null | undefined,
  opts?: { budgetMs?: number; onError?: (jobId: string, err: unknown) => void },
): Promise<{ moved: number; failed: number; left: number }> {
  const startedMs = ctx.now().getTime();
  const budgetMs = typeof opts?.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : REPLAN_CALLS_BUDGET_MS;
  const calls = (await listJobs(ctx))
    .map((j) => j as StoredJob)
    .filter((j) => j.type === 'message' && j.channel === 'call' && messageKind(j) === 'reminder' && (j.audience ?? 'invitee') === 'invitee')
    .filter((j) => !!j.bookingId && !!j.ruleId && j.attempt === 0 && Date.parse(j.dueAt) > startedMs);
  const result = { moved: 0, failed: 0, left: 0 };
  if (calls.length === 0) return result;
  const todo = calls.slice(0, MAX_REPLANNED_CALLS);
  result.left += calls.length - todo.length;

  const [bookings, eventTypes] = await Promise.all([getBookings(ctx, [...new Set(todo.map((j) => j.bookingId as string))]), listEventTypes(ctx)]);
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const eventTypeById = new Map(eventTypes.map((e) => [e.id, e]));

  for (let i = 0; i < todo.length; i++) {
    const nowMs = ctx.now().getTime();
    if (nowMs - startedMs >= budgetMs) {
      result.left += todo.length - i;
      break;
    }
    const job = todo[i];
    try {
      const booking = bookingById.get(job.bookingId as string);
      const startMs = Date.parse(booking?.start ?? '');
      const rule = booking ? eventTypeById.get(booking.eventTypeId)?.reminders?.find((r) => r.id === job.ruleId) : undefined;
      // Whatever the runner will drop or skip anyway (cancelled, moved, rule gone) is left for it to do so.
      const current = !!booking && booking.status === 'confirmed' && (!job.forStart || Date.parse(job.forStart) === startMs);
      if (!current || !rule || rule.enabled !== true || rule.channel !== 'call') {
        result.left++;
        continue;
      }
      const oldMs = Date.parse(job.dueAt);
      const idealMs = ruleDueMs(rule, startMs, Date.parse(booking.end));
      const nextMs = planCallTime({ idealMs, startMs, nowMs, madeMs: lastChangeOf(booking).ms, timezone: booking.invitee.timezone, hours });
      // The rule's own moment has gone by (the old hours had moved the call later). Moving it would make
      // saving the settings ring people straight away, so a time the new hours still allow is kept.
      const keep = nextMs !== null && nextMs < nowMs && insideCallHours(oldMs, booking.invitee.timezone, hours);
      const dueMs = nextMs === null || keep ? null : Math.max(nextMs, nowMs);
      // Due by now: the runner may be placing it already.
      if (dueMs === null || dueMs === oldMs || !(oldMs > nowMs) || (await readClaim(ctx, claimName(job)))) {
        result.left++;
        continue;
      }
      // The queue was read when this run began. A call that has left it since (the booking was planned
      // again for changed rules, or cancelled, or the call was placed) must not come back as a copy: next
      // to the call planned in its place it would ring a second time.
      const queued = await ctx.kv.getJSON<StoredJob>(job.key);
      if (!queued || queued.id !== job.id || queued.attempt !== job.attempt) {
        result.left++;
        continue;
      }
      const dueAt = new Date(dueMs).toISOString();
      await putJob(ctx, { ...job, dueAt, key: keyFor(dueAt, job.id) }, { onlyIfNew: true });
      await deleteJob(ctx, job.key);
      result.moved++;
    } catch (err) {
      result.failed++;
      opts?.onError?.(job.id, err);
    }
  }
  return result;
}

function isInviteeCall(plan: PlannedJob): boolean {
  return plan.channel === 'call' && plan.audience === 'invitee' && !plan.immediate && typeof plan.ruleId === 'string' && plan.ruleId !== '';
}

/**
 * The id of a planned reminder call: the same for the same booking (and the same version of it), rule and
 * time, however often or from wherever it is planned. Two plans of the same call therefore write one job,
 * and copies that do exist share their attempt claims and "sent" marker, so the call rings once.
 */
export function reminderCallJobId(booking: Pick<Booking, 'id' | 'start' | 'rescheduleCount'>, ruleId: string, dueMs: number): string {
  return `job_${sha256Hex(`call-${booking.id}-${booking.rescheduleCount ?? 0}-${Date.parse(booking.start)}-${ruleId}-${dueMs}`).slice(0, 24)}`;
}

const MAX_CALL_PLANNING_BOOKINGS = 300;

/**
 * After the calling hours changed, the second half of the work (replanReminderCalls moves the calls that are
 * queued): plans the reminder call of upcoming bookings that have none because the old hours left no time
 * for it, when the new hours do. Only for a confirmed booking whose meeting type has a reminder call, whose
 * invitee gave a number and agreed to calls, that has no call of that rule in the queue (one read of it for
 * all bookings) and was never called. The call is planned exactly as a new booking's would be
 * (planBookingJobs), and everything that is checked when a call is placed still is (consent, opt-out, the
 * number's daily limit, "already called"). No timeline note: a newly planned call does not get one either.
 * Bounded like replanReminderCalls; what is left over keeps its "no time" note.
 */
export async function planMissedReminderCalls(
  ctx: Ctx,
  hours: Partial<CallHours> | null | undefined,
  opts?: { budgetMs?: number; onError?: (bookingId: string, err: unknown) => void },
): Promise<{ planned: number; failed: number; left: number }> {
  const startedMs = ctx.now().getTime();
  const budgetMs = typeof opts?.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : REPLAN_CALLS_BUDGET_MS;
  const result = { planned: 0, failed: 0, left: 0 };
  const [index, eventTypes, queue] = await Promise.all([getBookingIndex(ctx), listEventTypes(ctx), listJobs(ctx)]);
  const withCalls = new Map(
    eventTypes.filter((et) => (et.reminders ?? []).some((r) => r?.enabled === true && r.channel === 'call' && r.audience !== 'host' && r.trigger !== 'after_end')).map((et) => [et.id, et]),
  );
  if (withCalls.size === 0) return result;
  const queued = new Set(queue.filter((j) => j.type === 'message' && j.channel === 'call' && j.bookingId && j.ruleId).map((j) => `${j.bookingId}|${j.ruleId}`));
  const candidates = index
    .filter((e) => e.status === 'confirmed' && Date.parse(e.start) > startedMs && withCalls.has(e.eventTypeId))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const todo = candidates.slice(0, MAX_CALL_PLANNING_BOOKINGS);
  result.left += candidates.length - todo.length;
  const bookings = await getBookings(ctx, todo.map((e) => e.id));
  const callHours = { ...DEFAULT_ASSISTANT, ...(hours ?? {}) };

  for (let i = 0; i < bookings.length; i++) {
    const nowMs = ctx.now().getTime();
    if (nowMs - startedMs >= budgetMs) {
      result.left += bookings.length - i;
      break;
    }
    const booking = bookings[i];
    try {
      const eventType = withCalls.get(booking.eventTypeId);
      if (!eventType || booking.status !== 'confirmed' || !inviteeReachable(booking, 'call')) continue;
      // Called once already, or a try that may have rung (one cut off while it was placed, one Twilio did not
      // answer in time): never a second one from here. Only a call that was never tried is planned.
      if ((booking.timeline ?? []).some((t) => t.type === 'reminder_call_sent' || t.type === 'reminder_call_failed')) continue;
      const missing = planBookingJobs({ booking, eventType, hosts: [], nowMs, immediate: null, callHours }).filter(
        (plan) => isInviteeCall(plan) && !queued.has(`${booking.id}|${plan.ruleId}`),
      );
      for (const plan of missing) {
        const dueAt = new Date(plan.dueMs).toISOString();
        const id = reminderCallJobId(booking, plan.ruleId!, plan.dueMs);
        const job: StoredJob = {
          type: 'message',
          bookingId: booking.id,
          dueAt,
          channel: 'call',
          audience: 'invitee',
          kind: plan.kind,
          ruleId: plan.ruleId,
          forStart: booking.start,
          id,
          key: keyFor(dueAt, id),
          attempt: 0,
          createdAt: ctx.now().toISOString(),
        };
        // Create-only: a second pass for the same hours finds this one in place.
        if (await putJob(ctx, job, { onlyIfNew: true })) result.planned++;
        queued.add(`${booking.id}|${plan.ruleId}`);
      }
    } catch (err) {
      result.failed++;
      opts?.onError?.(booking.id, err);
    }
  }
  return result;
}

/** Removes every pending message for the booking except the ones that announce or follow a cancellation. */
export async function cancelBookingJobs(ctx: Ctx, bookingId: string): Promise<void> {
  await removeBookingJobs(ctx, bookingId, (j) => j.type === 'message' && j.kind !== 'cancelled' && j.kind !== 'host_alert');
}

// ───────────────────────── planning ─────────────────────────

function inviteeReachable(booking: Booking, channel: ReminderChannel): boolean {
  if (channel === 'email') return isEmail(booking.invitee.email);
  if (!booking.invitee.phone?.trim()) return false;
  return channel === 'sms' ? booking.consent?.sms === true : booking.consent?.call === true;
}

/** When a rule's message is due before any calling hours are taken into account. */
function ruleDueMs(rule: ReminderRule, startMs: number, endMs: number): number {
  const offsetMs = Math.max(0, Number(rule.offsetMinutes) || 0) * 60_000;
  return rule.trigger !== 'after_end' ? Math.min(startMs - offsetMs, startMs - REMINDER_MIN_LEAD_MS) : endMs + offsetMs;
}

/** Hosts get email unless they turned it off, texts only when they asked for them, and never an automated call. */
function hostReachable(host: Host, channel: ReminderChannel, kind: MessageKind): boolean {
  if (channel === 'email') return isEmail(host.email) && (host.notify?.email !== false || kind === 'host_alert');
  if (channel === 'sms') return !!host.phone?.trim() && host.notify?.sms === true;
  return false;
}

export interface PlannedJob {
  dueMs: number;
  channel: ReminderChannel;
  audience: Audience;
  kind: MessageKind;
  ruleId?: string;
  hostId?: string;
  /** part of the "send now" batch (confirmation, new booking, rescheduled) rather than a timed rule */
  immediate: boolean;
}

// ───────────────────────── calling hours ─────────────────────────

export type CallHours = Pick<AssistantSettings, 'callWindowStartHour' | 'callWindowEndHour'>;

function hourSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(24, Math.max(0, Math.floor(value))) : fallback;
}

function callHoursOf(a: Partial<CallHours> | null | undefined): { open: number; close: number } {
  return {
    open: hourSetting(a?.callWindowStartHour, DEFAULT_ASSISTANT.callWindowStartHour),
    close: hourSetting(a?.callWindowEndHour, DEFAULT_ASSISTANT.callWindowEndHour),
  };
}

function validZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz !== '' && tz.length <= 64 && IANAZone.isValidZone(tz);
}

/**
 * The same rule as withinCallWindow in voice.ts, which checks again when the call is placed: the
 * opening hour counts, the closing hour does not, a window may run past midnight (opening later
 * than closing), and an empty window or an unknown zone never allows a call.
 */
export function insideCallHours(ms: number, tz: string, hours?: Partial<CallHours> | null): boolean {
  if (!Number.isFinite(ms) || !validZone(tz)) return false;
  const { open, close } = callHoursOf(hours);
  if (open === close) return false;
  const local = DateTime.fromMillis(ms, { zone: tz });
  if (!local.isValid) return false;
  return open < close ? local.hour >= open && local.hour < close : local.hour >= open || local.hour < close;
}

/** `hour` o'clock on the local day that starts at `day`; 24 is the following midnight. */
function atLocalHour(day: DateTime, hour: number): DateTime {
  return hour >= 24 ? day.plus({ days: 1 }).startOf('day') : day.set({ hour, minute: 0, second: 0, millisecond: 0 });
}

/**
 * When a reminder call should ring, on the invitee's clock, or null for no call at all. Pure.
 *   1. the rule's own moment (`idealMs`) when that is inside calling hours
 *   2. otherwise the moment calling hours next open, when that still leaves 30 minutes before the start
 *      (a 9:00 meeting with a "2 hours before" call rings at 8:00, not at 7:00)
 *   3. otherwise the start of the last calling hour before the rule's moment, when that is still ahead
 *      and at least an hour after the booking was made or moved (an 8:15 meeting rings the evening before,
 *      but not a few minutes after it was booked that evening)
 * The call is placed only when the result is still inside calling hours at that moment, so a
 * daylight saving jump can never move it outside them.
 */
export function planCallTime(p: CallPlanInput): number | null {
  const { idealMs, startMs, nowMs, timezone: tz, hours } = p;
  if (!Number.isFinite(idealMs) || !Number.isFinite(startMs) || !validZone(tz)) return null;
  const { open, close } = callHoursOf(hours);
  if (open === close) return null;
  if (insideCallHours(idealMs, tz, hours)) return idealMs;

  const { openingMs, lastHourMs } = fallbackCallTimes(idealMs, tz, open, close);
  if (openingMs > nowMs && openingMs <= startMs - CALL_MIN_LEAD_MS && insideCallHours(openingMs, tz, hours)) return openingMs;
  if (lastHourMs > nowMs && lastHourMs >= (p.madeMs ?? nowMs) + CALL_MIN_GAP_MS && lastHourMs < startMs && insideCallHours(lastHourMs, tz, hours)) return lastHourMs;
  return null;
}

export interface CallPlanInput {
  /** the rule's own moment */
  idealMs: number;
  startMs: number;
  nowMs: number;
  /**
   * When the booking was made or last moved (see CALL_MIN_GAP_MS). Left out, it is `nowMs`: the plan is for
   * a booking or a move being made right now.
   */
  madeMs?: number;
  /** the invitee's zone */
  timezone: string;
  hours?: Partial<CallHours> | null;
}

/**
 * When the booking was made or last moved, and which of the two: what a reminder call must not follow too
 * closely. -Infinity when the record does not say.
 */
function lastChangeOf(b: Pick<Booking, 'createdAt' | 'timeline'>): { ms: number; kind: 'created' | 'rescheduled' } {
  let ms = Date.parse(b.createdAt ?? '');
  let kind: 'created' | 'rescheduled' = 'created';
  for (const t of b.timeline ?? []) {
    if (t?.type !== 'rescheduled') continue;
    const at = Date.parse(t.at);
    if (Number.isFinite(at) && !(at <= ms)) {
      ms = at;
      kind = 'rescheduled';
    }
  }
  return { ms: Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY, kind };
}

/** planCallTime's two fall-backs: when calling hours next open after `idealMs`, and the start of their last hour before it. */
function fallbackCallTimes(idealMs: number, tz: string, open: number, close: number): { openingMs: number; lastHourMs: number } {
  const day = DateTime.fromMillis(idealMs, { zone: tz }).startOf('day');
  let opening = atLocalHour(day, open);
  if (opening.toMillis() <= idealMs) opening = atLocalHour(day.plus({ days: 1 }), open);
  let closing = atLocalHour(day, close);
  if (closing.toMillis() > idealMs) closing = atLocalHour(day.minus({ days: 1 }), close);
  return { openingMs: opening.toMillis(), lastHourMs: closing.toMillis() - 3_600_000 };
}

/**
 * Why planCallTime found no time for a call, in facts the note on the booking can be built from. Pure.
 *   passed        planned earlier, the call would have rung at a moment that has already gone by
 *   rightAway     the last calling hour before the rule's moment has begun already, or begins less than an
 *                 hour after the booking was made or moved: a call then would come straight after it, which
 *                 reminds nobody
 *   afterChange   rightAway, because of a booking or a move made before this plan (`madeMs`): the note names that
 *   lastHalfHour  calling hours open before the meeting, but less than half an hour before it starts
 */
export function noCallTimeFacts(p: CallPlanInput): { passed: boolean; rightAway: boolean; afterChange: boolean; lastHalfHour: boolean } {
  const { idealMs, startMs, nowMs, timezone: tz, hours } = p;
  const none = { passed: false, rightAway: false, afterChange: false, lastHalfHour: false };
  if (!Number.isFinite(idealMs) || !Number.isFinite(startMs) || !Number.isFinite(nowMs) || !validZone(tz)) return none;
  const { open, close } = callHoursOf(hours);
  if (open === close) return none;
  const earlier = planCallTime({ ...p, nowMs: Number.NEGATIVE_INFINITY, madeMs: Number.NEGATIVE_INFINITY });
  const { openingMs, lastHourMs } = fallbackCallTimes(idealMs, tz, open, close);
  const madeMs = p.madeMs ?? nowMs;
  const lastHourSoon = lastHourMs > nowMs && lastHourMs < madeMs + CALL_MIN_GAP_MS && lastHourMs < startMs && insideCallHours(lastHourMs, tz, hours);
  return {
    passed: earlier !== null && earlier <= nowMs,
    rightAway: nowMs < startMs && (insideCallHours(nowMs, tz, hours) || lastHourSoon),
    afterChange: nowMs < startMs && lastHourSoon && madeMs < nowMs,
    lastHalfHour: openingMs > nowMs && openingMs < startMs && openingMs > startMs - CALL_MIN_LEAD_MS && insideCallHours(openingMs, tz, hours),
  };
}

/**
 * The note on the booking when a reminder call gets no time, or null for none. `change` is what the
 * booking is being planned for: new, moved, or neither (the rules or the calling hours changed).
 */
function noCallTimeNote(f: ReturnType<typeof noCallTimeFacts>, change: 'created' | 'rescheduled' | null): string | null {
  // Planned again after the call's moment had gone by: it rang then, or the timeline already says why not.
  if (change === null && f.passed) return null;
  const soon = !f.rightAway ? '' : change === 'created' ? 'right after booking' : change === 'rescheduled' ? 'right after the meeting was moved' : 'right after the change';
  if (soon && f.lastHalfHour) return `the only times inside calling hours before the meeting were ${soon} and in the half hour before it starts`;
  if (soon) return `the only time inside calling hours before the meeting was ${soon}`;
  if (f.lastHalfHour) return 'the only time inside calling hours before the meeting is in the half hour before it starts';
  return skipText('no_call_time');
}

/** Pure: which messages a booking needs, given its reminder rules and who can be reached how. */
export function planBookingJobs(p: {
  booking: Booking;
  eventType: EventType;
  /** hosts assigned to the booking */
  hosts: Host[];
  nowMs: number;
  immediate: 'created' | 'rescheduled' | null;
  /** calling hours (site.assistant); the defaults when left out */
  callHours?: Partial<CallHours> | null;
  /** told about each call rule that finds no time inside calling hours before the meeting, with the note for the booking */
  onNoCallTime?: (ruleId: string, note: string) => void;
  /** who made the change. An invitee who just moved the meeting on the page gets no text about it (the email carries the new calendar file). */
  by?: 'invitee' | 'host' | 'assistant' | 'system';
  /** with 'rescheduled': hosts the move handed the meeting to (a round robin whose host left). For them it is a new booking. */
  newHostIds?: string[];
}): PlannedJob[] {
  const { booking, hosts, nowMs } = p;
  const startMs = Date.parse(booking.start);
  const endMs = Date.parse(booking.end);
  const planned: PlannedJob[] = [];
  if (booking.status !== 'confirmed' || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return planned;

  for (const rule of p.eventType.reminders ?? []) {
    if (!rule || rule.enabled !== true) continue;
    const before = rule.trigger !== 'after_end';
    let dueMs = ruleDueMs(rule, startMs, endMs);
    if (!(dueMs > nowMs)) continue;
    if (rule.channel === 'call' && !before) continue; // a reminder call after the meeting makes no sense
    const kind: MessageKind = before ? 'reminder' : 'followup';
    if (rule.channel === 'call' && rule.audience !== 'host' && inviteeReachable(booking, 'call')) {
      // Calls only ring inside calling hours on the invitee's clock, so the time is chosen inside them now
      // rather than finding out at the last moment that the call cannot be made. A booking planned again (the
      // rules or the calling hours changed) counts the gap after booking from when it was made or moved.
      const made = p.immediate ? { ms: nowMs, kind: p.immediate } : lastChangeOf(booking);
      const call = { idealMs: dueMs, startMs, nowMs, madeMs: made.ms, timezone: booking.invitee.timezone, hours: p.callHours };
      const callMs = planCallTime(call);
      if (callMs === null) {
        const facts = noCallTimeFacts(call);
        const note = noCallTimeNote(facts, p.immediate ?? (facts.afterChange ? made.kind : null));
        if (note) p.onNoCallTime?.(rule.id, note);
        continue;
      }
      dueMs = callMs;
    }
    const base = { dueMs, channel: rule.channel, kind, ruleId: rule.id, immediate: false };
    if (rule.audience === 'host') {
      for (const host of hosts) if (hostReachable(host, rule.channel, kind)) planned.push({ ...base, audience: 'host', hostId: host.id });
    } else if (inviteeReachable(booking, rule.channel)) {
      planned.push({ ...base, audience: 'invitee' });
    }
  }

  if (p.immediate) {
    const inviteeKind: MessageKind = p.immediate === 'created' ? 'confirmation' : 'rescheduled';
    const hostKind: MessageKind = p.immediate === 'created' ? 'host_new' : 'rescheduled';
    for (const channel of ['email', 'sms'] as const) {
      const selfMadeMove = p.immediate === 'rescheduled' && channel === 'sms' && p.by === 'invitee';
      if (!selfMadeMove && inviteeReachable(booking, channel)) planned.push({ dueMs: nowMs, channel, audience: 'invitee', kind: inviteeKind, immediate: true });
      for (const host of hosts) {
        const kind: MessageKind = p.immediate === 'rescheduled' && p.newHostIds?.includes(host.id) ? 'host_new' : hostKind;
        if (hostReachable(host, channel, kind)) planned.push({ dueMs: nowMs, channel, audience: 'host', kind, hostId: host.id, immediate: true });
      }
    }
  }
  return planned;
}

/**
 * Replaces the booking's timed reminders with a fresh set and, with `immediate`, queues the
 * messages that go out right away. Safe to call again for the same event: reminders are rebuilt,
 * and each immediate message is queued at most once per booking, start time and reschedule count.
 */
export async function scheduleBookingJobs(
  ctx: Ctx,
  booking: Booking,
  eventType: EventType,
  immediate: 'created' | 'rescheduled' | null,
  opts?: {
    /** the caller already removed this booking's reminders (re-planning many bookings with one read of the queue) */
    remindersCleared?: boolean;
    /** who made the change (see planBookingJobs) */
    by?: 'invitee' | 'host' | 'assistant' | 'system';
    /** hosts a move handed the meeting to (see planBookingJobs) */
    newHostIds?: string[];
  },
): Promise<void> {
  // A booking scheduled for the very first time cannot have reminders yet, which saves reading the whole queue.
  const brandNew = !opts?.remindersCleared && immediate === 'created' && (await claim(ctx, `sched-created-${booking.id}`));
  if (!brandNew && !opts?.remindersCleared) await removeBookingJobs(ctx, booking.id, isRuleJob);
  if (booking.status !== 'confirmed') return;

  const [allHosts, site] = await Promise.all([listHosts(ctx), getSite(ctx)]);
  const byId = new Map(allHosts.map((h) => [h.id, h]));
  const hosts = booking.hostIds.map((id) => byId.get(id)).filter((h): h is Host => !!h);
  const noCallTime: { ruleId: string; note: string }[] = [];
  const planned = planBookingJobs({
    booking,
    eventType,
    hosts,
    nowMs: ctx.now().getTime(),
    immediate,
    callHours: { ...DEFAULT_ASSISTANT, ...(site.assistant ?? {}) },
    onNoCallTime: (ruleId, note) => noCallTime.push({ ruleId, note }),
    ...(opts?.by ? { by: opts.by } : {}),
    ...(opts?.newHostIds?.length ? { newHostIds: opts.newHostIds } : {}),
  });

  const results = await Promise.allSettled([
    ...planned.map(async (plan) => {
      if (!plan.immediate) {
        await enqueueJob(
          ctx,
          {
            type: 'message',
            bookingId: booking.id,
            dueAt: new Date(plan.dueMs).toISOString(),
            channel: plan.channel,
            audience: plan.audience,
            kind: plan.kind,
            ...(plan.ruleId ? { ruleId: plan.ruleId } : {}),
            ...(plan.hostId ? { hostId: plan.hostId } : {}),
            forStart: booking.start,
          },
          isInviteeCall(plan) ? { id: reminderCallJobId(booking, plan.ruleId!, plan.dueMs) } : undefined,
        );
        return;
      }
      const once = `sched-${booking.id}-${booking.rescheduleCount ?? 0}-${Date.parse(booking.start)}-${plan.kind}-${plan.channel}-${plan.audience}-${plan.hostId ?? 'invitee'}`;
      if (!(await claim(ctx, once))) return;
      try {
        // The id comes from the claim, so a copy queued again after an unclear failed write shares
        // its "sent" marker and attempt claims with the first one and the message goes out once.
        await enqueueJob(
          ctx,
          {
            type: 'message',
            bookingId: booking.id,
            dueAt: new Date(plan.dueMs).toISOString(),
            channel: plan.channel,
            audience: plan.audience,
            kind: plan.kind,
            ...(plan.hostId ? { hostId: plan.hostId } : {}),
          },
          { id: `job_${sha256Hex(once).slice(0, 20)}` },
        );
      } catch (err) {
        // Not queued: give the claim back so the next try (createBooking tries twice) can queue it.
        await releaseClaim(ctx, once).catch((releaseErr) =>
          ctx.log('error', 'jobs: could not release the claim of a message that was not queued', { bookingId: booking.id, error: shortError(releaseErr) }),
        );
        throw err;
      }
    }),
    ...noCallTime.map(async ({ ruleId, note }) => {
      // Once per rule and start time, however often the booking is planned again.
      if (await claim(ctx, `call-unplanned-${booking.id}-${Date.parse(booking.start)}-${ruleId}`)) {
        await addTimeline(ctx, booking.id, 'reminder_call_skipped', note);
      }
    }),
  ]);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
}

// ───────────────────────── running ─────────────────────────

/** done / failed: this run finished the attempt. waiting: still queued for a later run. gone: another run finished it meanwhile. */
type Outcome = 'done' | 'failed' | 'waiting' | 'gone';

function claimName(job: Job): string {
  return `job-${job.id}-${job.attempt}`;
}

/** Why a job should be thrown away without running, or null. `note` goes on the booking timeline. */
function dropReason(ctx: Ctx, job: StoredJob, booking: Booking | null): { reason: string; note?: string } | null {
  if (job.bookingId && !booking) return { reason: 'booking_missing' };
  if (job.type !== 'message') return null; // other handlers decide for themselves, e.g. calendar clean-up after a cancellation
  const kind = messageKind(job);
  if (!booking) return kind === 'host_alert' ? null : { reason: 'no_booking' };
  if (booking.status === 'cancelled' && kind !== 'cancelled' && kind !== 'host_alert') return { reason: 'booking_cancelled' };
  const now = ctx.now().getTime();
  const start = Date.parse(booking.start);
  const end = Date.parse(booking.end);
  if (job.forStart && Date.parse(job.forStart) !== start) return { reason: 'rescheduled' };
  if (kind === 'reminder' && now >= start) return { reason: 'stale', note: 'the meeting had already started' };
  if ((kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled' || kind === 'manage_link') && now >= end) {
    return { reason: 'stale', note: 'the meeting was already over' };
  }
  if (kind === 'followup' && job.audience !== 'host' && booking.attendance?.noShow === true) {
    return { reason: 'no_show', note: 'the invitee was marked as a no-show' };
  }
  return null;
}

/** After a failed attempt: queue the next one with backoff, or give up. Always removes the current attempt from the queue. */
async function retryOrGiveUp(ctx: Ctx, job: StoredJob, booking: Booking | null, error: string): Promise<Outcome> {
  const attemptsMade = job.attempt + 1;
  const delayMin = BACKOFF_MINUTES[Math.min(job.attempt, BACKOFF_MINUTES.length - 1)];
  const nowMs = ctx.now().getTime();
  // Counted from when this attempt was claimed, not from now: the runner itself and a later run that
  // recovers the attempt then arrive at the same queue key, and the create-only write keeps one copy.
  const claimedMs = Date.parse((await readClaim(ctx, claimName(job)))?.at ?? '');
  const nextDueMs = (Number.isFinite(claimedMs) && claimedMs <= nowMs ? claimedMs : nowMs) + delayMin * 60_000;
  let gaveUp = attemptsMade >= MAX_ATTEMPTS ? `gave up after ${attemptsMade} tries` : '';
  if (!gaveUp && job.type === 'message' && messageKind(job) === 'reminder' && booking && nextDueMs >= Date.parse(booking.start)) {
    gaveUp = 'not retried: the meeting starts before the next try';
  }

  if (gaveUp) {
    await deleteJob(ctx, job.key);
    ctx.log('error', 'jobs: giving up on a job', { id: job.id, type: job.type, kind: job.kind, channel: job.channel, bookingId: job.bookingId, error });
    await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_failed`, `${error} (${gaveUp})`);
    return 'failed';
  }

  const dueAt = new Date(nextDueMs).toISOString();
  const next: StoredJob = { ...job, attempt: job.attempt + 1, dueAt, key: keyFor(dueAt, job.id) };
  // Written before the current attempt leaves the queue: if this write throws, the attempt stays
  // queued and the interrupted-job recovery arrives here again with the same key.
  await putJob(ctx, next, { onlyIfNew: true });
  if (next.key !== job.key) await deleteJob(ctx, job.key);
  ctx.log('warn', 'jobs: attempt failed, will retry', { id: job.id, type: job.type, kind: job.kind, channel: job.channel, attempt: job.attempt, error });
  const waitMin = Math.ceil((nextDueMs - nowMs) / 60_000);
  const when = waitMin >= 1 ? `will try again in ${waitMin} min` : 'will try again shortly';
  if (job.type === 'message') await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_failed`, `${error} (${when})`);
  return 'failed';
}

/** Records the outcome of a finished attempt. The queue entry goes first so a crash right after cannot cause a repeat. */
async function settle(ctx: Ctx, job: StoredJob, booking: Booking | null, result: DeliveryResult): Promise<Outcome> {
  const isMessage = job.type === 'message';
  if (result.ok) {
    await deleteJob(ctx, job.key);
    if (isMessage) await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_sent`, result.detail ?? (result.provider ? `via ${result.provider}` : undefined));
    return 'done';
  }
  if (result.skipped) {
    await deleteJob(ctx, job.key);
    if (!isMessage) return 'done';
    if (result.skipped !== 'already_sent') {
      await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_skipped`, skipText(result.skipped));
    } else if (job.attempt > 0) {
      // A retry found the message already delivered: the earlier try was cut off before it could say so.
      await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_sent`, 'it had already gone out on an earlier try');
    }
    return 'done';
  }
  return retryOrGiveUp(ctx, job, booking, result.error || 'unknown error');
}

/** One claimed attempt from start to finish. Never rejects. */
async function execute(ctx: Ctx, job: StoredJob, handler: JobHandler): Promise<Outcome> {
  let booking: Booking | null = null;
  let result: DeliveryResult;
  try {
    booking = job.bookingId ? await getBooking(ctx, job.bookingId) : null;
    const drop = dropReason(ctx, job, booking);
    if (drop) {
      await deleteJob(ctx, job.key);
      if (drop.note) await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_skipped`, drop.note);
      return 'done';
    }
    result = await handler(ctx, job, { booking });
    if (!result || typeof result.ok !== 'boolean') result = { ok: false, provider: 'none', error: 'the handler returned nothing' };
  } catch (err) {
    result = { ok: false, provider: 'none', error: shortError(err) };
  }
  try {
    return await settle(ctx, job, booking, result);
  } catch (err) {
    // Storage failed after the attempt ran. The job stays queued with its claim taken; the
    // interrupted-job recovery picks it up, and the "sent" markers stop a second delivery.
    ctx.log('error', 'jobs: could not record the outcome of a job', { id: job.id, error: shortError(err) });
    return result.ok || result.skipped ? 'done' : 'failed';
  }
}

/** Someone else holds the claim for this attempt. Leave it alone, unless it has plainly been abandoned. */
async function recoverIfAbandoned(ctx: Ctx, job: StoredJob): Promise<Outcome> {
  // The usual case with overlapping runs: the other run has finished and the job has left the queue.
  if (!(await ctx.kv.getJSON<Job>(job.key))) return 'gone';
  const marker = `job-lost-${job.id}-${job.attempt}`;
  const now = ctx.now().getTime();
  const seen = await cacheGet<{ at: number }>(ctx, marker);
  if (!seen || typeof seen.at !== 'number') {
    await cacheSet(ctx, marker, { at: now }, LOST_MARKER_TTL_SEC);
    return 'waiting';
  }
  if (now - seen.at < ORPHAN_AFTER_MS) return 'waiting';

  if (await readClaim(ctx, claimName({ ...job, attempt: job.attempt + 1 }))) {
    // The next attempt already ran: this one was moved on and only its removal from the queue was lost.
    await deleteJob(ctx, job.key);
    return 'gone';
  }
  ctx.log('warn', 'jobs: recovering a job whose run never finished', { id: job.id, type: job.type, kind: job.kind, channel: job.channel, attempt: job.attempt });
  const booking = job.bookingId ? await getBooking(ctx, job.bookingId) : null;
  if (job.type === 'message' && job.channel === 'call') {
    await deleteJob(ctx, job.key);
    await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_failed`, 'interrupted before it finished (not retried, so nobody is called twice)');
    return 'failed';
  }
  return retryOrGiveUp(ctx, job, booking, 'interrupted before it finished');
}

const TIMED_OUT = Symbol('timed out');

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(ctx: Ctx, job: StoredJob, timeoutMs: number): Promise<Outcome> {
  const handler = handlerFor(job.type);
  if (!handler) {
    ctx.log('warn', 'jobs: no handler is registered for this job type', { id: job.id, type: job.type });
    return 'waiting';
  }
  if (!(await claim(ctx, claimName(job)))) return recoverIfAbandoned(ctx, job);

  const work = execute(ctx, job, handler);
  const outcome = await withTimeout(work, timeoutMs);
  if (outcome !== TIMED_OUT) return outcome;
  // Do not wait for it and do not retry it here: it may still go through. If it finishes it records
  // its own outcome; if it never does, the abandoned-job recovery deals with it.
  ctx.log('error', 'jobs: a job did not finish in time', { id: job.id, type: job.type, kind: job.kind, channel: job.channel, timeoutMs });
  ctx.waitUntil(work);
  return 'failed';
}

/**
 * Runs everything that is due, oldest first, until the time budget is spent.
 *   processed  jobs this run brought to an outcome (sent, skipped, dropped, failed)
 *   failed     of those, the ones that failed (they are retried later unless out of tries)
 *   remaining  due jobs left in the queue for a later run
 */
export async function runDueJobs(
  ctx: Ctx,
  opts?: {
    budgetMs?: number;
    onlyBookingId?: string;
    /** longest a single job may hold up the run (default 20 s, never past the budget plus a short grace) */
    jobTimeoutMs?: number;
  },
): Promise<{ processed: number; failed: number; remaining: number }> {
  const budgetMs = typeof opts?.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : DEFAULT_BUDGET_MS;
  const jobTimeoutMs = typeof opts?.jobTimeoutMs === 'number' && opts.jobTimeoutMs > 0 ? opts.jobTimeoutMs : null;
  const startedMs = ctx.now().getTime();
  const due = (await listJobs(ctx, { dueBy: ctx.now() })).filter(
    (j) => Date.parse(j.dueAt) <= startedMs && (!opts?.onlyBookingId || j.bookingId === opts.onlyBookingId),
  );

  let processed = 0;
  let failed = 0;
  let remaining = 0;
  for (let i = 0; i < due.length; i++) {
    const elapsed = ctx.now().getTime() - startedMs;
    if (elapsed >= budgetMs) {
      remaining += due.length - i;
      break;
    }
    const timeoutMs = jobTimeoutMs ?? Math.max(MIN_JOB_TIMEOUT_MS, Math.min(JOB_TIMEOUT_MS, budgetMs + BUDGET_GRACE_MS - elapsed));
    let outcome: Outcome;
    try {
      outcome = await runOne(ctx, due[i] as StoredJob, timeoutMs);
    } catch (err) {
      // Nothing was claimed or nothing ran (storage trouble): the job is untouched and the next run tries again.
      ctx.log('error', 'jobs: could not start a job', { id: due[i].id, error: shortError(err) });
      remaining++;
      failed++;
      continue;
    }
    if (outcome === 'gone') continue;
    if (outcome === 'waiting') remaining++;
    else processed++;
    if (outcome === 'failed') failed++;
  }
  return { processed, failed, remaining };
}

// ───────────────────────── message composition ─────────────────────────

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 3));
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.5 ? cut.slice(0, atWord) : cut).replace(/[\s.,;:!?-]+$/, '')}...`;
}

/**
 * A text message of at most `max` characters: the wording first, then the links.
 * A link is never cut. When space runs out the wording is shortened (down to a readable minimum)
 * and after that links are dropped from the end of the list, so list the important one first.
 */
export function composeSms(prose: string, links: { label: string; url: string }[], opts?: { tail?: string; max?: number }): string {
  const max = opts?.max ?? SMS_MAX_LENGTH;
  const text = oneLine(prose);
  const extras = links.filter((l) => l.url && !text.includes(l.url)).map((l) => ` ${l.label} ${l.url}`);
  const tail = opts?.tail ? ` ${opts.tail}` : '';
  const full = text + extras.join('') + tail;
  if (full.length <= max) return full;

  const floor = Math.min(text.length, 90);
  for (let keep = extras.length; keep > 0; keep--) {
    const suffix = extras.slice(0, keep).join('');
    const room = max - suffix.length;
    if (room >= text.length) return text + suffix;
    if (room >= floor) return clip(text, room) + suffix;
  }
  return clip(text, max);
}

interface MessageParts {
  booking: Booking;
  eventType: EventType | null;
  /** every host; the assigned ones are picked out where needed */
  hosts: Host[];
  site: SiteSettings;
  kind: MessageKind;
  audience: Audience;
  recipientHost?: Host | null;
  subjectTemplate?: string;
  bodyTemplate?: string;
}

function manageTokenFor(ctx: Ctx, bookingId: string): string {
  return hmacHex(ctx, 'manage', bookingId);
}

function assignedTo(booking: Booking, hosts: Host[]): Host[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return booking.hostIds.map((id) => byId.get(id)).filter((h): h is Host => !!h);
}

/**
 * True when Google Calendar sends the invitee the real invitation for this booking: it already did,
 * or it is about to (`booking.google` is set as soon as a host with working Google organises the
 * event, also while a failed or slow write is still being retried). Our own email must then not
 * carry a second invitation with a different UID, which would leave the invitee with two entries.
 */
function googleSendsInvite(booking: Booking, eventType: EventType | null): boolean {
  // A detached booking's event is in an account that is gone: Google will not tell the invitee about changes.
  return eventType?.googleInvite !== false && !!booking.google && !booking.google.detached;
}

/** The invitee got a Google invitation earlier that can no longer be changed (the booking is detached). */
function staleGoogleInvite(booking: Booking, eventType: EventType | null): boolean {
  return eventType?.googleInvite !== false && !!booking.google?.detached && !!booking.google.eventId;
}

const STALE_INVITE_MOVED =
  'You may still see this meeting at its old time in your calendar, from the earlier Google Calendar invitation. That invitation could not be updated, so please delete it and use the attached calendar file for the new time.';
const STALE_INVITE_CANCELLED = 'If this meeting is still in your calendar from the earlier Google Calendar invitation, please delete it there. That invitation could not be cancelled for you.';

function emailDetails(p: MessageParts, vars: TemplateVars): { label: string; value: string }[] {
  const { booking, kind, audience } = p;
  const rows: { label: string; value: string }[] = [];
  if (audience === 'invitee' && kind === 'followup') return rows; // a thank-you, not another set of logistics
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) rows.push({ label, value: value.trim() });
  };
  add('When', `${vars.date}\n${vars.time} to ${vars.end_time} (${vars.timezone})`);
  if (kind === 'rescheduled') add('Previously', vars.previous_datetime);
  add('Where', vars.location);
  if (kind !== 'cancelled' && kind !== 'followup') add('Link', vars.join_url);

  const assigned = assignedTo(booking, p.hosts);
  if (audience === 'invitee') {
    add('With', assigned.map((h) => h.name).join(', ') || vars.host_names);
    add('Guests', vars.guests);
    return rows;
  }
  add('Invitee', booking.invitee.name);
  add('Email', booking.invitee.email);
  add('Phone', booking.invitee.phone);
  if (vars.invitee_local_time !== vars.time || vars.invitee_timezone !== vars.timezone) {
    add('Their time', `${vars.invitee_local_time} (${vars.invitee_timezone})`);
  }
  add('Guests', vars.guests);
  const others = assigned.filter((h) => h.id !== p.recipientHost?.id).map((h) => h.name);
  if (assigned.length > 1) add('Also hosting', others.join(', '));
  for (const answer of booking.answers ?? []) add(answer.label, answer.value);
  if (kind === 'reminder' && booking.attendance?.confirmedAt) add('Attendance', 'Confirmed by the invitee');
  return rows;
}

function emailActions(p: MessageParts, vars: TemplateVars): { label: string; url: string; primary?: boolean }[] {
  const { kind, audience, booking } = p;
  const join = vars.join_url ? [{ label: 'Join the meeting', url: vars.join_url, primary: true }] : [];
  if (audience === 'host') {
    if (kind === 'cancelled' || kind === 'followup') return [];
    return [...join, { label: 'View or change booking', url: vars.manage_url, primary: kind === 'manage_link' && join.length === 0 }];
  }
  switch (kind) {
    case 'cancelled':
      return [{ label: 'Book a new time', url: vars.book_url, primary: true }];
    case 'followup':
      return [{ label: 'Book another time', url: vars.book_url, primary: true }];
    case 'manage_link':
      return [
        { label: 'Reschedule', url: vars.reschedule_url, primary: true },
        { label: 'Cancel', url: vars.cancel_url },
      ];
    case 'reminder': {
      const confirm = !join.length && !booking.attendance?.confirmedAt ? [{ label: "I'll be there", url: vars.confirm_url, primary: true }] : [];
      return [...join, ...confirm, { label: 'Reschedule', url: vars.reschedule_url }, { label: 'Cancel', url: vars.cancel_url }];
    }
    default:
      return [...join, { label: 'Reschedule', url: vars.reschedule_url }, { label: 'Cancel', url: vars.cancel_url }];
  }
}

/** Builds the complete email (subject, both bodies, calendar file) for one recipient of a booking message. */
export function composeBookingEmail(ctx: Ctx, p: MessageParts & { to: string; toName?: string }): EmailMessage {
  const { booking, eventType, site, kind, audience } = p;
  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  const vars: TemplateVars = buildVars(ctx, { booking, eventType, hosts: p.hosts, site, audience, recipientHost: p.recipientHost });
  if (audience === 'host') {
    // The host reads their own zone everywhere else; this one line tells them what the clock says for the invitee.
    vars.invitee_local_time = buildVars(ctx, { booking, eventType, hosts: p.hosts, site, audience: 'invitee' }).time;
  }
  const wording = defaultMessage(kind, 'email', audience);
  const subject = oneLine(renderTemplate(p.subjectTemplate?.trim() || wording.subject, vars)) || oneLine(renderTemplate(wording.subject, vars));
  const body = tidy(renderTemplate(p.bodyTemplate?.trim() || wording.body, vars)) || tidy(renderTemplate(wording.body, vars));
  // Only addresses we wrote become links: our own pages, the meeting link, links in the owner's wording
  // and in a place the owner set. A web address inside something a visitor typed (their name, an
  // answer, a place they suggested) stays plain text, so our mail never turns it into a link.
  const ownPlace = booking.location && booking.location.type !== 'ask_invitee' && booking.location.type !== 'phone_host_calls';
  const linkUrls = [
    vars.join_url,
    vars.manage_url,
    vars.reschedule_url,
    vars.cancel_url,
    vars.confirm_url,
    vars.book_url,
    vars.admin_url,
    ...urlsIn(p.bodyTemplate ?? ''),
    ...urlsIn(wording.body),
    ...(ownPlace ? urlsIn(`${booking.location.label ?? ''} ${booking.location.value ?? ''}`) : []),
  ].filter(Boolean);
  const paragraphs = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  // Said after the body, whatever the owner's own wording: the earlier Google invitation will not change by itself.
  if (audience === 'invitee' && staleGoogleInvite(booking, eventType)) {
    if (kind === 'rescheduled') paragraphs.push(STALE_INVITE_MOVED);
    else if (kind === 'cancelled') paragraphs.push(STALE_INVITE_CANCELLED);
  }
  const heading = oneLine(renderTemplate(wording.heading, vars));
  const details = emailDetails(p, vars);
  const actions = emailActions(p, vars);
  const token = manageTokenFor(ctx, booking.id);
  const assigned = assignedTo(booking, p.hosts);

  let links: { label: string; url: string }[] = [];
  let linksLabel = '';
  if (audience === 'invitee' && (kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled')) {
    const cal = calendarLinks({ booking, hosts: assigned, baseUrl: base, manageToken: token, brandLine: brandLine(site, bookUrlFor(base, site, booking)) });
    linksLabel = 'Add to your calendar:';
    links = [
      { label: 'Google', url: cal.google },
      { label: 'Outlook.com', url: cal.outlook },
      { label: 'Office 365', url: cal.office365 },
      { label: 'Apple or other', url: cal.ics },
    ];
  } else if (audience === 'invitee' && kind === 'reminder' && vars.join_url && !booking.attendance?.confirmedAt) {
    links = [{ label: `Let ${vars.host_first_name} know you're coming`, url: vars.confirm_url }];
  }

  const footer =
    audience === 'invitee'
      ? `You are getting this email because a meeting was booked with ${site.profile.name} using this address.`
      : `Sent by the ${site.profile.name} booking page.`;
  const content = { heading, paragraphs, details, actions, links, linksLabel, footer, linkUrls };
  // Plain text keeps to the one short calendar link: the Google and Outlook ones are a wall of characters there.
  const textLinks = linksLabel ? links.filter((l) => l.label === 'Apple or other').map((l) => ({ label: 'Calendar file', url: l.url })) : links;
  // A brand shows its logo (the upload, else the built-in one, served by the asset route) in a rounded square,
  // never the owner's photo, and its own green on the buttons whatever colour the event has.
  const brand = brandOfView(site);
  const avatarId = brand ? brand.theme.logoAssetId || brand.art.emailLogoAssetId : site.profile.avatarAssetId;
  const html = renderEmailHtml({
    ...content,
    site,
    preheader: clip(paragraphs[1] ?? paragraphs[0] ?? heading, 140),
    avatarUrl: avatarId && /^[A-Za-z0-9_-]{1,80}$/.test(avatarId) ? `${base}/api/assets/${avatarId}` : null,
    avatarShape: brand ? 'rounded' : 'circle',
    accentColor: eventColorFor(eventType, brand) || null,
  });

  const message: EmailMessage = { to: p.to, toName: p.toName, subject, text: renderEmailText({ ...content, links: textLinks }), html };
  // The brand's sender name; the address and the reply-to stay the site's (sendEmail reads those itself).
  if (brand) message.fromName = site.email.fromName;
  // Hosts can answer the notification to reach the invitee directly.
  if (audience === 'host' && isEmail(booking.invitee.email)) message.replyTo = booking.invitee.email;

  const withCalendarFile = kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled' || kind === 'cancelled';
  if (withCalendarFile) {
    const invited = googleSendsInvite(booking, eventType);
    let method: 'REQUEST' | 'CANCEL' | 'PUBLISH' | null;
    if (audience === 'invitee') method = kind === 'cancelled' ? (invited ? null : 'CANCEL') : invited ? 'PUBLISH' : 'REQUEST';
    // Hosts with Google already have the event, unless it is in an account that is gone (detached).
    else method = booking.google?.eventId && !booking.google.detached ? null : kind === 'cancelled' ? 'CANCEL' : 'PUBLISH';
    if (method) {
      message.ics = {
        filename: method === 'CANCEL' ? 'cancelled.ics' : 'invite.ics',
        method,
        content: buildBookingIcs({ booking, hosts: assigned, site, method, baseUrl: base, manageUrl: vars.manage_url, brandLine: brandLine(site, bookUrlFor(base, site, booking)) }),
      };
    }
  }
  return message;
}

/** The wording plus the links for one text message. */
export function composeBookingSms(ctx: Ctx, p: MessageParts): string {
  const { booking, kind, audience } = p;
  const vars = buildVars(ctx, { booking, eventType: p.eventType, hosts: p.hosts, site: p.site, audience, recipientHost: p.recipientHost });
  const wording = defaultMessage(kind, 'sms', audience);
  const prose = oneLine(renderTemplate(p.bodyTemplate?.trim() || wording.body, vars)) || oneLine(renderTemplate(wording.body, vars));

  const join = vars.join_url ? [{ label: 'Join:', url: vars.join_url }] : [];
  const manage = [{ label: audience === 'invitee' ? 'Change or cancel:' : 'Manage:', url: vars.manage_url }];
  let links: { label: string; url: string }[] = [];
  if (kind === 'reminder') {
    // Close to the start the way in matters most; further out, the way to change plans does.
    const soon = audience === 'host' || Date.parse(booking.start) - ctx.now().getTime() <= 2 * 3_600_000;
    links = soon ? [...join, ...manage] : [...manage, ...join];
  } else if (audience === 'invitee' && (kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled')) {
    links = manage; // the join link follows in the reminder, when it is needed
  }
  const tail = audience === 'invitee' && (kind === 'confirmation' || kind === 'host_new') ? 'Reply STOP to opt out.' : undefined;
  return composeSms(brandedText(p.site, prose), links, { tail });
}

/** A text about a meeting under a brand names the brand: "Eco Champions: " in front, unless the text already says it. */
export function brandedText(site: SiteSettings, prose: string): string {
  if (!isSiteView(site)) return prose;
  const name = site.profile.name.trim();
  return name && !prose.toLowerCase().includes(name.toLowerCase()) ? `${name}: ${prose}` : prose;
}

// ───────────────────────── delivery ─────────────────────────

interface Recipient {
  /** stable id for the "already sent" marker */
  key: string;
  name: string;
  email: string;
  phone: string;
  host: Host | null;
}

function sentMarker(job: Job, recipient: Recipient): string {
  return `sent-${job.id}-${recipient.key}`;
}

/** The message is out. Failing to note that must not turn the delivery into a failure (which would be retried). */
async function markSent(ctx: Ctx, job: Job, recipient: Recipient): Promise<void> {
  try {
    await cacheSet(ctx, sentMarker(job, recipient), { at: ctx.now().getTime() }, SENT_MARKER_TTL_SEC);
  } catch (err) {
    ctx.log('warn', 'jobs: could not store the sent marker', { id: job.id, error: shortError(err) });
  }
}

async function deliverSiteAlert(ctx: Ctx, job: StoredJob, site: SiteSettings, hosts: Host[]): Promise<DeliveryResult> {
  if ((job.channel ?? 'email') !== 'email') return { ok: false, provider: 'none', skipped: 'unsupported_channel' };
  const owner = hosts.find((h) => h.id === (job.hostId ?? site.ownerHostId)) ?? hosts.find((h) => h.role === 'owner') ?? null;
  const phone = owner?.phone?.trim() ?? '';
  if (!owner || (!isEmail(owner.email) && !phone)) return { ok: false, provider: 'none', skipped: 'no_email' };
  const recipient: Recipient = { key: owner.id, name: owner.name, email: owner.email, phone, host: owner };
  const byText: Recipient = { ...recipient, key: `${owner.id}-sms` };
  if ((await cacheGet(ctx, sentMarker(job, recipient))) || (await cacheGet(ctx, sentMarker(job, byText)))) {
    return { ok: false, provider: 'none', skipped: 'already_sent' };
  }

  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  const vars: TemplateVars = {
    host_name: owner.name,
    host_first_name: firstName(owner.name) || 'there',
    site_name: site.profile.name,
    assistant_name: site.assistant.name,
    admin_url: `${base}/admin`,
  };
  const wording = defaultMessage('host_alert', 'email', 'host');
  const subject = oneLine(renderTemplate(job.subject?.trim() || wording.subject, vars));
  const paragraphs = tidy(renderTemplate(job.body?.trim() || wording.body, vars))
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const content = {
    heading: oneLine(renderTemplate(wording.heading, vars)),
    paragraphs,
    // A co-host (a notice about their Google accounts) has no dashboard: their page is behind their private link.
    actions: owner.role === 'owner' ? [{ label: 'Open your dashboard', url: vars.admin_url, primary: true }] : [],
    footer: `Sent by the ${site.profile.name} booking page.`,
  };
  let emailed: DeliveryResult = { ok: false, provider: 'none', skipped: 'no_email' };
  if (isEmail(owner.email)) {
    // Resend whenever it is set up, whatever email is set to: an alert is often about the very thing
    // that stopped Gmail (the owner's Google connection), and must not depend on it.
    const result = await sendEmail(
      ctx,
      {
        to: owner.email,
        toName: owner.name,
        subject,
        text: renderEmailText(content),
        html: renderEmailHtml({ ...content, site, preheader: clip(paragraphs[1] ?? paragraphs[0] ?? '', 140) }),
        idempotencyKey: `${job.id}-${owner.id}`,
      },
      { preferResend: true },
    );
    emailed = { ...result, detail: `to ${owner.email}${result.provider !== 'none' ? ` via ${result.provider}` : ''}` };
    if (result.ok) {
      await markSent(ctx, job, recipient);
      return emailed;
    }
  }

  // The email could not go out. The owner still has to hear about it: text them when Twilio works
  // and they gave a number (their own texts are not subject to the invitee limits).
  if (phone) {
    const prose = `${site.profile.name}: ${subject.replace(/[.!?]+$/, '')}. We could not email you about it, so this is a text instead.`;
    // A co-host has no dashboard (a notice about their Google accounts): no link they cannot open.
    const texted = await sendSms(ctx, { to: phone, body: composeSms(prose, owner.role === 'owner' ? [{ label: 'Open your dashboard:', url: vars.admin_url }] : []) });
    if (texted.ok) {
      await markSent(ctx, job, byText);
      return { ...texted, detail: `to ${phone} by text, because the email could not be sent` };
    }
    ctx.log('warn', 'jobs: an alert could not be sent by email or by text', { id: job.id, sms: texted.skipped ?? texted.error ?? 'failed' });
    // Email cannot work at all but the text failed for a passing reason: that is the one worth retrying.
    if (emailed.skipped && !texted.skipped) return { ...texted, detail: `to ${phone} by text` };
  }
  return emailed;
}

function combine(results: DeliveryResult[]): DeliveryResult {
  if (results.length === 1) return results[0];
  const detail = results
    .map((r) => r.detail)
    .filter(Boolean)
    .join('; ');
  const failed = results.filter((r) => !r.ok && !r.skipped);
  if (failed.length > 0) {
    return { ok: false, provider: failed[0].provider, error: failed.map((r) => r.error || 'unknown error').join('; '), detail };
  }
  const sent = results.find((r) => r.ok);
  if (sent) return { ok: true, provider: sent.provider, id: sent.id, detail };
  return { ok: false, provider: results[0]?.provider ?? 'none', skipped: results[0]?.skipped ?? 'no_recipient', detail };
}

/**
 * The built-in handler for `message` jobs: works out who the message is for, writes it from the
 * reminder rule's wording, the job's own wording or the built-in text, and sends it on the job's
 * channel. Returns `skipped` when sending makes no sense (no consent, no number, switched off).
 */
export async function deliverMessage(ctx: Ctx, job: Job, extra?: JobRunExtra): Promise<DeliveryResult> {
  const stored = job as StoredJob;
  const channel: ReminderChannel = stored.channel ?? 'email';
  const audience: Audience = stored.audience ?? 'invitee';
  const kind = messageKind(stored);

  const [storedSite, hosts] = await Promise.all([getSite(ctx), listHosts(ctx)]);
  if (!stored.bookingId) {
    if (kind !== 'host_alert') return { ok: false, provider: 'none', skipped: 'no_booking' };
    // Alerts about the site itself are the owner's: never in a brand.
    return deliverSiteAlert(ctx, stored, storedSite, hosts);
  }
  const booking = extra?.booking ?? (await getBooking(ctx, stored.bookingId));
  if (!booking) return { ok: false, provider: 'none', skipped: 'booking_missing' };
  const eventType = await getEventType(ctx, booking.eventTypeId);
  // Everything about the booking (emails, texts, the calendar file) is in the brand it was booked under.
  const site = viewFor(storedSite, booking);

  const rule = stored.ruleId ? eventType?.reminders?.find((r) => r.id === stored.ruleId) : undefined;
  // A reminder from a rule that was switched off or removed is not sent. (When the event type itself
  // is gone there is nothing to check against, and the reminder still goes out.)
  if (stored.ruleId && eventType && (!rule || rule.enabled !== true)) return { ok: false, provider: 'none', skipped: 'rule_disabled' };
  const ruleFits = !!rule && rule.channel === channel && rule.audience === audience;
  const subjectTemplate = (ruleFits && rule?.subject?.trim()) || stored.subject?.trim() || undefined;
  const bodyTemplate = (ruleFits && rule?.body?.trim()) || stored.body?.trim() || undefined;

  let recipients: Recipient[];
  if (audience === 'invitee') {
    recipients = [{ key: 'invitee', name: booking.invitee.name, email: booking.invitee.email, phone: booking.invitee.phone ?? '', host: null }];
  } else {
    const assigned = assignedTo(booking, hosts);
    const owner = hosts.find((h) => h.id === site.ownerHostId) ?? null;
    const targets = stored.hostId ? hosts.filter((h) => h.id === stored.hostId) : assigned.length > 0 ? assigned : owner ? [owner] : [];
    if (targets.length === 0) return { ok: false, provider: 'none', skipped: stored.hostId ? 'host_missing' : 'no_recipient' };
    recipients = targets.map((h) => ({ key: h.id, name: h.name, email: h.email, phone: h.phone ?? '', host: h }));
  }

  const parts = (recipient: Recipient): MessageParts => ({
    booking,
    eventType,
    hosts,
    site,
    kind,
    audience,
    recipientHost: recipient.host,
    subjectTemplate,
    bodyTemplate,
  });

  const sendTo = async (recipient: Recipient): Promise<DeliveryResult> => {
    const reachable = recipient.host ? hostReachable(recipient.host, channel, kind) : inviteeReachable(booking, channel);
    if (!reachable) {
      if (channel === 'email') return { ok: false, provider: 'none', skipped: isEmail(recipient.email) ? 'host_notifications_off' : 'no_email' };
      if (recipient.host) return { ok: false, provider: 'none', skipped: channel === 'call' ? 'unsupported_channel' : recipient.phone ? 'host_notifications_off' : 'no_phone' };
      return { ok: false, provider: 'none', skipped: recipient.phone ? noConsentReason(booking, channel) : 'no_phone' };
    }
    if (channel === 'call' && kind !== 'reminder') return { ok: false, provider: 'none', skipped: 'unsupported_channel' };
    if (await cacheGet(ctx, sentMarker(stored, recipient))) return { ok: false, provider: 'none', skipped: 'already_sent' };

    let result: SendResult;
    let address: string;
    if (channel === 'email') {
      address = recipient.email;
      const message = composeBookingEmail(ctx, { ...parts(recipient), to: recipient.email, toName: recipient.name });
      result = await sendEmail(ctx, { ...message, idempotencyKey: `${stored.id}-${recipient.key}` });
    } else if (channel === 'sms') {
      address = recipient.phone;
      const body = composeBookingSms(ctx, parts(recipient));
      // Texts to invitees go to whatever number was typed on the booking page, so they have a daily
      // ceiling. Hosts' own texts do not: they chose the number. A text that does not go out after all
      // (Twilio not set up, the number opted out, Twilio refused or failed it) gives its place back, so
      // only texts that really leave are counted, and a retry counts once, when it goes through.
      const pass = recipient.host ? null : await reserveOutbound(ctx, 'sms', recipient.phone);
      if (!recipient.host && !pass) return { ok: false, provider: 'none', skipped: 'daily_limit', detail: `to ${address}` };
      result = await sendSms(ctx, { to: recipient.phone, body, bookingId: booking.id, kind });
      if (pass && !result.ok && !result.uncertain) await pass.release();
      if (result.uncertain && kind === 'reminder') {
        // Twilio got the request but did not answer in time, so the text may well be on the phone.
        // A second reminder is worse than a missing one: it counts as sent and is not tried again.
        // (A confirmation or notice is worth the risk of a second copy, so those are retried.)
        await markSent(ctx, stored, recipient);
        return {
          ok: true,
          provider: result.provider,
          detail: `to ${address} via ${result.provider}. Twilio did not confirm it in time, so it may not have arrived. It is not sent again, so nobody gets it twice.`,
        };
      }
    } else {
      address = recipient.phone;
      result = await startReminderCall(ctx, { booking, purpose: 'reminder' });
    }
    if (result.ok) await markSent(ctx, stored, recipient);
    const via = result.provider && result.provider !== 'none' ? ` via ${result.provider}` : '';
    return { ...result, detail: `to ${address}${via}` };
  };

  const results: DeliveryResult[] = [];
  for (const recipient of recipients) {
    try {
      results.push(await sendTo(recipient));
    } catch (err) {
      results.push({ ok: false, provider: 'none', error: shortError(err), detail: `to ${recipient.name}` });
    }
  }
  return combine(results);
}
