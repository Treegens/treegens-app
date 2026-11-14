/**
 * The outbound job queue: confirmations, reminders, follow-ups and calendar sync retries.
 *
 * How a job is kept from running twice or getting lost:
 *   1. One attempt, one runner. Before running attempt N of a job a runner must win
 *      claim("job-<id>-<N>"). Overlapping cron runs therefore never run the same attempt twice.
 *   2. One attempt, one successor. Moving on to attempt N+1 (retry) is guarded by
 *      claim("job-<id>-<N>-next"), so a job can never fork into two copies.
 *   3. One recipient, one delivery. After a message is accepted by a provider, a "sent" marker is
 *      stored for that job and recipient. A later attempt of the same job skips recipients that
 *      already have one, so a retry after a half-finished run does not send again.
 *   4. No job is stranded. If a runner dies while holding a claim, the job is still in the queue
 *      with its claim taken. Later runs note when they first saw that and, ten minutes on, move
 *      the job to its next attempt (phone calls are dropped instead: ringing someone twice is
 *      worse than not ringing).
 */
import type {
  Booking,
  EventType,
  Host,
  ISODateTime,
  Job,
  MessageKind,
  ReminderChannel,
  SendResult,
  SiteSettings,
} from '../../shared/types';
import { hmacHex, randomId } from './crypto';
import type { Ctx } from './ctx';
import { renderEmailHtml, renderEmailText, sendEmail, type EmailMessage } from './email';
import { buildBookingIcs, calendarLinks } from './ics';
import { cacheGet, cacheSet, claim, deleteJob, getBooking, getEventType, getSite, listHosts, listJobs, putJob, updateBooking } from './repo';
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
  no_phone: 'there is no phone number',
  no_email: 'there is no email address',
  no_recipient: 'there was nobody to send it to',
  invalid_recipient: 'the address is not valid',
  email_not_configured: 'email sending is not set up yet',
  outside_call_window: 'it was outside calling hours',
  host_notifications_off: 'the host has these notifications switched off',
  rule_disabled: 'this reminder was switched off',
  unsupported_channel: 'this kind of message cannot be sent on this channel',
  host_missing: 'the host no longer exists',
};

function skipText(reason: string): string {
  return SKIP_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

// ───────────────────────── enqueue ─────────────────────────

export async function enqueueJob(ctx: Ctx, j: Omit<StoredJob, 'key' | 'id' | 'attempt' | 'createdAt'>): Promise<Job> {
  const dueMs = Date.parse(j.dueAt);
  if (!Number.isFinite(dueMs)) throw new Error('enqueueJob: dueAt is not a valid time');
  const dueAt = new Date(dueMs).toISOString();
  const id = randomId('job');
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

/** Pure: which messages a booking needs, given its reminder rules and who can be reached how. */
export function planBookingJobs(p: {
  booking: Booking;
  eventType: EventType;
  /** hosts assigned to the booking */
  hosts: Host[];
  nowMs: number;
  immediate: 'created' | 'rescheduled' | null;
}): PlannedJob[] {
  const { booking, hosts, nowMs } = p;
  const startMs = Date.parse(booking.start);
  const endMs = Date.parse(booking.end);
  const planned: PlannedJob[] = [];
  if (booking.status !== 'confirmed' || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return planned;

  for (const rule of p.eventType.reminders ?? []) {
    if (!rule || rule.enabled !== true) continue;
    const offsetMs = Math.max(0, Number(rule.offsetMinutes) || 0) * 60_000;
    const before = rule.trigger !== 'after_end';
    const dueMs = before ? Math.min(startMs - offsetMs, startMs - REMINDER_MIN_LEAD_MS) : endMs + offsetMs;
    if (!(dueMs > nowMs)) continue;
    if (rule.channel === 'call' && !before) continue; // a reminder call after the meeting makes no sense
    const kind: MessageKind = before ? 'reminder' : 'followup';
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
      if (inviteeReachable(booking, channel)) planned.push({ dueMs: nowMs, channel, audience: 'invitee', kind: inviteeKind, immediate: true });
      for (const host of hosts) {
        if (hostReachable(host, channel, hostKind)) planned.push({ dueMs: nowMs, channel, audience: 'host', kind: hostKind, hostId: host.id, immediate: true });
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
export async function scheduleBookingJobs(ctx: Ctx, booking: Booking, eventType: EventType, immediate: 'created' | 'rescheduled' | null): Promise<void> {
  // A booking scheduled for the very first time cannot have reminders yet, which saves reading the whole queue.
  const brandNew = immediate === 'created' && (await claim(ctx, `sched-created-${booking.id}`));
  if (!brandNew) await removeBookingJobs(ctx, booking.id, isRuleJob);
  if (booking.status !== 'confirmed') return;

  const byId = new Map((await listHosts(ctx)).map((h) => [h.id, h]));
  const hosts = booking.hostIds.map((id) => byId.get(id)).filter((h): h is Host => !!h);
  const planned = planBookingJobs({ booking, eventType, hosts, nowMs: ctx.now().getTime(), immediate });

  const results = await Promise.allSettled(
    planned.map(async (plan) => {
      if (plan.immediate) {
        const once = `sched-${booking.id}-${booking.rescheduleCount ?? 0}-${Date.parse(booking.start)}-${plan.kind}-${plan.channel}-${plan.audience}-${plan.hostId ?? 'invitee'}`;
        if (!(await claim(ctx, once))) return;
      }
      await enqueueJob(ctx, {
        type: 'message',
        bookingId: booking.id,
        dueAt: new Date(plan.dueMs).toISOString(),
        channel: plan.channel,
        audience: plan.audience,
        kind: plan.kind,
        ...(plan.ruleId ? { ruleId: plan.ruleId } : {}),
        ...(plan.hostId ? { hostId: plan.hostId } : {}),
        ...(plan.immediate ? {} : { forStart: booking.start }),
      });
    }),
  );
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
  const nextDueMs = ctx.now().getTime() + delayMin * 60_000;
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
  if (await claim(ctx, `${claimName(job)}-next`)) await putJob(ctx, next);
  if (next.key !== job.key) await deleteJob(ctx, job.key);
  ctx.log('warn', 'jobs: attempt failed, will retry', { id: job.id, type: job.type, kind: job.kind, channel: job.channel, attempt: job.attempt, error });
  if (job.type === 'message') await addTimeline(ctx, booking?.id, `${timelineLabel(job)}_failed`, `${error} (will try again in ${delayMin} min)`);
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

/** True when Google Calendar already emailed the invitee a real invitation for this booking. */
function googleInviteWentOut(booking: Booking, eventType: EventType | null): boolean {
  return !!booking.google?.eventId && eventType?.googleInvite !== false;
}

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
  const paragraphs = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const heading = oneLine(renderTemplate(wording.heading, vars));
  const details = emailDetails(p, vars);
  const actions = emailActions(p, vars);
  const token = manageTokenFor(ctx, booking.id);
  const assigned = assignedTo(booking, p.hosts);

  let links: { label: string; url: string }[] = [];
  let linksLabel = '';
  if (audience === 'invitee' && (kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled')) {
    const cal = calendarLinks({ booking, hosts: assigned, baseUrl: base, manageToken: token });
    linksLabel = 'Add to your calendar:';
    links = [
      { label: 'Google', url: cal.google },
      { label: 'Outlook', url: cal.outlook },
      { label: 'Apple or other', url: cal.ics },
    ];
  } else if (audience === 'invitee' && kind === 'reminder' && vars.join_url && !booking.attendance?.confirmedAt) {
    links = [{ label: `Let ${vars.host_first_name} know you're coming`, url: vars.confirm_url }];
  }

  const footer =
    audience === 'invitee'
      ? `You are getting this email because a meeting was booked with ${site.profile.name} using this address.`
      : `Sent by the ${site.profile.name} booking page.`;
  const content = { heading, paragraphs, details, actions, links, linksLabel, footer };
  // Plain text keeps to the one short calendar link: the Google and Outlook ones are a wall of characters there.
  const textLinks = linksLabel ? links.filter((l) => l.label === 'Apple or other').map((l) => ({ label: 'Calendar file', url: l.url })) : links;
  const avatarId = site.profile.avatarAssetId;
  const html = renderEmailHtml({
    ...content,
    site,
    preheader: clip(paragraphs[1] ?? paragraphs[0] ?? heading, 140),
    avatarUrl: avatarId && /^[A-Za-z0-9_-]{1,80}$/.test(avatarId) ? `${base}/api/assets/${avatarId}` : null,
    accentColor: eventType?.color || null,
  });

  const message: EmailMessage = { to: p.to, toName: p.toName, subject, text: renderEmailText({ ...content, links: textLinks }), html };
  // Hosts can answer the notification to reach the invitee directly.
  if (audience === 'host' && isEmail(booking.invitee.email)) message.replyTo = booking.invitee.email;

  const withCalendarFile = kind === 'confirmation' || kind === 'host_new' || kind === 'rescheduled' || kind === 'cancelled';
  if (withCalendarFile) {
    const invited = googleInviteWentOut(booking, eventType);
    let method: 'REQUEST' | 'CANCEL' | 'PUBLISH' | null;
    if (audience === 'invitee') method = kind === 'cancelled' ? (invited ? null : 'CANCEL') : invited ? 'PUBLISH' : 'REQUEST';
    else method = booking.google?.eventId ? null : kind === 'cancelled' ? 'CANCEL' : 'PUBLISH'; // hosts with Google already have the event
    if (method) {
      message.ics = {
        filename: method === 'CANCEL' ? 'cancelled.ics' : 'invite.ics',
        method,
        content: buildBookingIcs({ booking, hosts: assigned, site, method, baseUrl: base, manageUrl: vars.manage_url }),
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
  return composeSms(prose, links, { tail });
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
  if (!owner || !isEmail(owner.email)) return { ok: false, provider: 'none', skipped: 'no_email' };
  const recipient: Recipient = { key: owner.id, name: owner.name, email: owner.email, phone: owner.phone ?? '', host: owner };
  if (await cacheGet(ctx, sentMarker(job, recipient))) return { ok: false, provider: 'none', skipped: 'already_sent' };

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
    actions: [{ label: 'Open your dashboard', url: vars.admin_url, primary: true }],
    footer: `Sent by the ${site.profile.name} booking page.`,
  };
  const result = await sendEmail(ctx, {
    to: owner.email,
    toName: owner.name,
    subject,
    text: renderEmailText(content),
    html: renderEmailHtml({ ...content, site, preheader: clip(paragraphs[1] ?? paragraphs[0] ?? '', 140) }),
    idempotencyKey: `${job.id}-${owner.id}`,
  });
  if (result.ok) await markSent(ctx, job, recipient);
  return { ...result, detail: `to ${owner.email}${result.provider !== 'none' ? ` via ${result.provider}` : ''}` };
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

  const [site, hosts] = await Promise.all([getSite(ctx), listHosts(ctx)]);
  if (!stored.bookingId) {
    if (kind !== 'host_alert') return { ok: false, provider: 'none', skipped: 'no_booking' };
    return deliverSiteAlert(ctx, stored, site, hosts);
  }
  const booking = extra?.booking ?? (await getBooking(ctx, stored.bookingId));
  if (!booking) return { ok: false, provider: 'none', skipped: 'booking_missing' };
  const eventType = await getEventType(ctx, booking.eventTypeId);

  const rule = stored.ruleId ? eventType?.reminders?.find((r) => r.id === stored.ruleId) : undefined;
  if (rule && rule.enabled === false) return { ok: false, provider: 'none', skipped: 'rule_disabled' };
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
      return { ok: false, provider: 'none', skipped: recipient.phone ? 'no_consent' : 'no_phone' };
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
      result = await sendSms(ctx, { to: recipient.phone, body: composeBookingSms(ctx, parts(recipient)) });
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
