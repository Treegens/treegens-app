/**
 * Daily ceilings on what the site sends to invitees by phone: texts (jobs.ts deliverMessage) and
 * reminder calls (voice.ts placeCall). Anyone can book with any number, so without a ceiling a
 * stream of bookings could text or ring one stranger all day, or run up the owner's Twilio bill.
 *
 * Two limits, both counted per UTC day:
 *   per number   a handful of texts and calls to any one number
 *   site-wide    a ceiling for all invitee texts or calls together; reaching it alerts the owner once that day
 *
 * Not counted: texts to hosts (their own notifications and alerts), the dashboard's test text or
 * call, and replies to texts people send in. Those go to numbers the owner chose.
 */
import { rateLimit } from './auth';
import type { Ctx } from './ctx';
import { HttpError } from './http';
import { enqueueJob } from './jobs';
import { claim, releaseClaim } from './repo';

export type OutboundChannel = 'sms' | 'call';

/** One booking sends a confirmation and a reminder text; a reschedule or a cancellation adds one each. */
export const TEXTS_PER_NUMBER_PER_DAY = 6;
export const CALLS_PER_NUMBER_PER_DAY = 2;
/** Far above what a busy day of real bookings needs. */
export const TEXTS_PER_DAY = 150;
export const CALLS_PER_DAY = 40;

/** Rate-limit windows are kept to one day: housekeeping removes older counters after two. */
const DAY_SEC = 86_400;

/** The limiter key for a number: digits only, so "+1 202 555 0143" and "+12025550143" count together. */
function numberId(phone: string): string {
  const digits = String(phone ?? '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : String(phone ?? '').trim() || 'unknown';
}

/** True when the hit was counted, false when the limit was already reached. Storage trouble is thrown. */
async function countHit(ctx: Ctx, bucket: string, id: string, limit: number): Promise<boolean> {
  try {
    await rateLimit(ctx, bucket, id, limit, DAY_SEC);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}

function alertWording(channel: OutboundChannel, ceiling: number): { subject: string; body: string } {
  const what = channel === 'sms' ? `${ceiling} texts to invitees` : `${ceiling} reminder calls`;
  const paused = channel === 'sms' ? 'Texts to invitees are paused until midnight UTC' : 'Reminder calls are paused until midnight UTC';
  return {
    subject: channel === 'sms' ? 'Texts to invitees are paused for today' : 'Reminder calls are paused for today',
    body: [
      'Hi {{host_first_name}},',
      `Your booking page reached today's limit of ${what}. ${paused}. Emails still go out as usual.`,
      'A sudden rush like this can mean someone is making bookings with other people\'s numbers to send texts or calls at your cost. Open your dashboard and look over today\'s bookings.',
      'You get this message at most once a day.',
    ].join('\n\n'),
  };
}

/** One alert per channel per day, however many sends run into the ceiling. */
async function alertOwnerOnce(ctx: Ctx, channel: OutboundChannel, ceiling: number): Promise<void> {
  const name = `alert-outbound-${channel}-${ctx.now().toISOString().slice(0, 10)}`;
  if (!(await claim(ctx, name))) return;
  const wording = alertWording(channel, ceiling);
  try {
    await enqueueJob(ctx, {
      type: 'message',
      kind: 'host_alert',
      bookingId: '',
      channel: 'email',
      audience: 'host',
      subject: wording.subject,
      body: wording.body,
      dueAt: ctx.now().toISOString(),
    });
  } catch (err) {
    // Nothing was queued: give the claim back so the next send that hits the ceiling tries again.
    await releaseClaim(ctx, name).catch(() => undefined);
    throw err;
  }
}

/**
 * Counts one text or reminder call to `phone` against today's limits. False means it must not go
 * out today; the caller reports it as skipped ('daily_limit'), never as a failure to retry.
 * The number's own limit is checked first, so a flood aimed at one number does not use up the
 * site's allowance for everybody else.
 */
export async function outboundAllowed(ctx: Ctx, channel: OutboundChannel, phone: string): Promise<boolean> {
  const perNumber = channel === 'sms' ? TEXTS_PER_NUMBER_PER_DAY : CALLS_PER_NUMBER_PER_DAY;
  if (!(await countHit(ctx, `out-${channel}`, numberId(phone), perNumber))) {
    ctx.log('warn', 'outbound: the daily limit for one number was reached', { channel });
    return false;
  }
  const ceiling = channel === 'sms' ? TEXTS_PER_DAY : CALLS_PER_DAY;
  if (await countHit(ctx, `out-${channel}-all`, 'site', ceiling)) return true;
  ctx.log('warn', 'outbound: the daily limit for the whole site was reached', { channel, ceiling });
  try {
    await alertOwnerOnce(ctx, channel, ceiling);
  } catch (err) {
    ctx.log('error', 'outbound: could not queue the alert about the daily limit', { channel, error: err instanceof Error ? err.message : String(err) });
  }
  return false;
}
