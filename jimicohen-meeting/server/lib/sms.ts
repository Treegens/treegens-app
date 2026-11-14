/**
 * Text messages: sending through Twilio and answering texts people send back.
 * sendSms never throws: every outcome is a SendResult, and `skipped` (instead of `error`)
 * means that trying again cannot help.
 */
import type { Booking, SendResult } from '../../shared/types';
import { rateLimit } from './auth';
import { confirmAttendance, manageToken } from './booking';
import type { Ctx } from './ctx';
import { HttpError, readForm } from './http';
import { enqueueJob } from './jobs';
import { getBooking, getBookingIndex, updateBooking } from './repo';
import { formatInZone } from './time';
import {
  blockNumber,
  getTwilioAccount,
  isNumberBlocked,
  isRestrictedNumber,
  normalizePhone,
  TwilioError,
  twilioRequestAs,
  twimlResponse,
  unblockNumber,
  verifyTwilioRequest,
  webhookRefusal,
  xmlEscape,
} from './twilio';

/** Twilio refuses longer bodies outright. */
export const SMS_BODY_LIMIT = 1600;

// Twilio error codes that describe the recipient, not a passing problem. Retrying cannot fix them.
const PERMANENT_SMS_ERRORS: Record<number, string> = {
  21211: 'invalid_phone',
  21408: 'region_not_enabled',
  21608: 'number_not_verified',
  21610: 'recipient_opted_out',
  21612: 'unreachable_number',
  21614: 'not_a_mobile_number',
};

function cleanBody(body: unknown): string {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim()
    .slice(0, SMS_BODY_LIMIT);
}

export async function sendSms(ctx: Ctx, p: { to: string; body: string }): Promise<SendResult> {
  let provider = 'none';
  try {
    const account = await getTwilioAccount(ctx);
    if (!account || (!account.fromNumber && !account.messagingServiceSid)) return { ok: false, provider: 'none', skipped: 'sms_not_configured' };
    provider = account.provider;
    const to = normalizePhone(p.to);
    if (!to) return { ok: false, provider: 'none', skipped: 'invalid_phone' };
    if (isRestrictedNumber(to)) return { ok: false, provider: 'none', skipped: 'unsupported_number' };
    const body = cleanBody(p.body);
    if (!body) return { ok: false, provider: 'none', skipped: 'empty_message' };
    if (await isNumberBlocked(ctx, to, 'sms')) return { ok: false, provider: 'none', skipped: 'recipient_opted_out' };

    const params: Record<string, string> = { To: to, Body: body };
    if (account.messagingServiceSid) params.MessagingServiceSid = account.messagingServiceSid;
    else params.From = account.fromNumber;

    const sent = await twilioRequestAs(ctx, account, 'POST', '/Messages.json', params);
    return { ok: true, provider, ...(typeof sent?.sid === 'string' ? { id: sent.sid } : {}) };
  } catch (err) {
    if (err instanceof TwilioError) {
      const permanent = err.code !== null ? PERMANENT_SMS_ERRORS[err.code] : undefined;
      if (permanent) return { ok: false, provider, skipped: permanent, error: err.message };
      return { ok: false, provider, error: err.message };
    }
    return { ok: false, provider, error: (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300) };
  }
}

// ───────────────────────── inbound texts ─────────────────────────

// Carriers and Twilio act on these words themselves (they stop or resume delivery and send their
// own notice), so we must not add a reply of our own.
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out']);
const OPT_IN_WORDS = new Set(['start', 'unstop']);
const CARRIER_HANDLED_WORDS = new Set(['start', 'unstop', 'help', 'info']);
const CONFIRM_WORDS = new Set(['c', 'y', 'yes', 'confirm', 'confirmed']);

/** How many of the sender's upcoming bookings are looked at. */
const MAX_BOOKINGS_SCANNED = 200;
// Every reply is a text we pay for. Nobody needs more than a few an hour, and numbers we do not
// know share one small allowance so that a flood of texts cannot run up a bill.
const REPLIES_PER_SENDER_PER_HOUR = 10;
const REPLIES_TO_STRANGERS_PER_HOUR = 60;

/** Counts one reply against the allowance. False means: stay silent. */
async function mayReply(ctx: Ctx, from: string, known: boolean): Promise<boolean> {
  try {
    await rateLimit(ctx, 'sms-in', from, REPLIES_PER_SENDER_PER_HOUR, 3600);
    if (!known) await rateLimit(ctx, 'sms-in-unknown', 'all', REPLIES_TO_STRANGERS_PER_HOUR, 3600);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}

function keyword(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** One line of plain text: no line breaks, no control characters, clipped. */
function plain(text: unknown, max: number): string {
  const line = String(text ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Three plain dots: a real ellipsis character would push the whole text into the costlier UCS-2 encoding.
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

/** Confirmed bookings of this phone number that have not ended yet, soonest first. */
async function upcomingBookingsFor(ctx: Ctx, phone: string): Promise<Booking[]> {
  const now = ctx.now().getTime();
  const entries = (await getBookingIndex(ctx))
    .filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_BOOKINGS_SCANNED);
  const found: Booking[] = [];
  for (let i = 0; i < entries.length; i += 10) {
    const batch = await Promise.all(entries.slice(i, i + 10).map((e) => getBooking(ctx, e.id)));
    for (const booking of batch) {
      if (!booking || booking.status !== 'confirmed' || !booking.invitee.phone) continue;
      if (normalizePhone(booking.invitee.phone) === phone) found.push(booking);
    }
  }
  return found;
}

function manageUrl(ctx: Ctx, bookingId: string): string {
  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/booking/${encodeURIComponent(bookingId)}?t=${encodeURIComponent(manageToken(ctx, bookingId))}`;
}

function whenFor(booking: Booking): string {
  return formatInZone(Date.parse(booking.start), booking.invitee.timezone, 'short', booking.invitee.locale);
}

function manageReply(ctx: Ctx, booking: Booking, confirmHint: boolean): string {
  const name = plain(firstName(booking.invitee.name), 40);
  const hello = name ? `Hi ${name}, here` : 'Here';
  const hint = confirmHint ? ' Reply C to confirm you are coming.' : '';
  return `${hello} is your link to view, reschedule or cancel ${plain(booking.eventTitle, 60)} on ${whenFor(booking)}: ${manageUrl(ctx, booking.id)}${hint}`;
}

/**
 * The sender asked for no more messages. A stop word ends every kind of automated reminder to
 * that number, calls included. "CANCEL" is the exception: carriers treat it as a stop word for
 * texts, but the sender most likely meant the meeting, so only texts are switched off.
 */
async function recordOptOut(ctx: Ctx, phone: string, bookings: Booking[], everything: boolean): Promise<void> {
  await blockNumber(ctx, phone, everything ? ['sms', 'call'] : ['sms']);
  const at = ctx.now().toISOString();
  const detail = everything ? 'Replied with a stop word. Reminder texts and calls are switched off.' : 'Replied CANCEL, which carriers treat as a stop word. Reminder texts are switched off.';
  for (const booking of bookings) {
    if (!booking.consent?.sms && !(everything && booking.consent?.call)) continue;
    await updateBooking(ctx, booking.id, (b) => ({
      ...b,
      consent: { ...b.consent, sms: false, call: everything ? false : b.consent.call },
      timeline: [...(b.timeline ?? []), { at, type: 'sms_opt_out', detail }],
    }));
  }
}

function message(text: string): Response {
  return twimlResponse(`<Message>${xmlEscape(text)}</Message>`);
}

/**
 * Twilio's webhook for a text sent to our number. "C", "YES" or "CONFIRM" confirms the sender's
 * next meeting, anything else gets the link to manage it. Always answers with TwiML.
 */
export async function handleInboundSms(ctx: Ctx, req: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch (err) {
    return webhookRefusal(err instanceof HttpError && err.status === 413 ? 413 : 400);
  }
  if (!(await verifyTwilioRequest(ctx, req, form))) return webhookRefusal(403);

  const from = normalizePhone(form.get('From') ?? '');
  const word = keyword(form.get('Body') ?? '');
  const bookingPage = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  // No usable sender (a short code, an alphanumeric id): there is nobody to answer.
  if (!from) return twimlResponse('');

  try {
    const bookings = await upcomingBookingsFor(ctx, from);

    if (OPT_OUT_WORDS.has(word)) {
      await recordOptOut(ctx, from, bookings, word !== 'cancel');
      const next = bookings[0];
      // "CANCEL" may have been about the meeting. Texts to this number are now blocked, so the link goes by email.
      if (word === 'cancel' && next) {
        await enqueueJob(ctx, {
          type: 'message',
          bookingId: next.id,
          dueAt: ctx.now().toISOString(),
          channel: 'email',
          audience: 'invitee',
          kind: 'manage_link',
        });
      }
      return twimlResponse('');
    }
    // START (and YES, which carriers also read as "resume") comes from the number itself, so it lifts an earlier stop.
    if (OPT_IN_WORDS.has(word) || word === 'yes') await unblockNumber(ctx, from, ['sms', 'call']);
    if (CARRIER_HANDLED_WORDS.has(word)) return twimlResponse('');

    const next = bookings[0];
    if (!(await mayReply(ctx, from, !!next))) return twimlResponse('');
    if (!next) return message(`We could not find an upcoming meeting for this number. You can book a time here: ${bookingPage}`);

    if (CONFIRM_WORDS.has(word)) {
      if (Date.parse(next.start) <= ctx.now().getTime()) return message(manageReply(ctx, next, false));
      try {
        await confirmAttendance(ctx, next.id, 'sms');
      } catch (err) {
        ctx.log('warn', 'sms: could not record a confirmation', { bookingId: next.id, error: err instanceof Error ? err.message : String(err) });
        return message(manageReply(ctx, next, false));
      }
      const name = plain(firstName(next.invitee.name), 40);
      return message(`Thanks${name ? ` ${name}` : ''}, you are confirmed for ${plain(next.eventTitle, 60)} on ${whenFor(next)}. See you then.`);
    }

    return message(manageReply(ctx, next, !next.attendance?.confirmedAt && Date.parse(next.start) > ctx.now().getTime()));
  } catch (err) {
    ctx.log('error', 'sms: inbound message failed', { error: err instanceof Error ? err.message : String(err) });
    return message(`Sorry, something went wrong on our side. You can manage your booking from the link in your confirmation email, or book here: ${bookingPage}`);
  }
}
