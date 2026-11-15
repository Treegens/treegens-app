/**
 * Text messages: sending through Twilio and answering texts people send back.
 * sendSms never throws: every outcome is a SendResult, and `skipped` (instead of `error`)
 * means that trying again cannot help.
 */
import type { Booking, SendResult } from '../../shared/types';
import { isRateLimitBusy, rateLimit } from './auth';
import { confirmAttendance, manageToken } from './booking';
import type { Ctx } from './ctx';
import { HttpError, readForm } from './http';
import { enqueueJob } from './jobs';
import { claim, getBooking, getBookingIndex, isStorageId, releaseClaim, updateBooking } from './repo';
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
  type TwilioAccount,
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

const MESSAGE_KIND = /^[a-z_]{1,32}$/;

/**
 * Where Twilio reports what became of a text (POST /twilio/sms/status). A 201 from Twilio only means
 * "queued": the carrier's verdict comes later. Twilio has to reach the address, so outside local
 * development it needs a public https one. `b` and `k` say which booking and which kind of message it was.
 */
function statusCallbackUrl(ctx: Ctx, account: TwilioAccount, p: { bookingId?: string; kind?: string }): string | null {
  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  if (account.provider !== 'mock' && !/^https:\/\//i.test(base)) return null;
  const query = new URLSearchParams();
  if (p.bookingId && isStorageId(p.bookingId)) query.set('b', p.bookingId);
  if (p.kind && MESSAGE_KIND.test(p.kind)) query.set('k', p.kind);
  const q = query.toString();
  return `${base}/api/twilio/sms/status${q ? `?${q}` : ''}`;
}

/**
 * `bookingId` and `kind` (for example "reminder") tie Twilio's later delivery report to the booking's
 * timeline. A text Twilio took but did not answer for in time comes back with `uncertain`: it may have
 * gone out, so the caller decides whether a second copy is worse than none.
 */
export async function sendSms(ctx: Ctx, p: { to: string; body: string; bookingId?: string; kind?: string }): Promise<SendResult> {
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
    const callback = statusCallbackUrl(ctx, account, p);
    if (callback) params.StatusCallback = callback;

    const sent = await twilioRequestAs(ctx, account, 'POST', '/Messages.json', params);
    return { ok: true, provider, ...(typeof sent?.sid === 'string' ? { id: sent.sid } : {}) };
  } catch (err) {
    if (err instanceof TwilioError) {
      // Sent, but no answer came back in time: Twilio may well have taken it.
      if (err.timedOut) return { ok: false, provider, error: err.message, uncertain: true };
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
    // A counter too busy to count this reply errs on the side of silence, like a reached limit.
    if ((err instanceof HttpError && err.status === 429) || isRateLimitBusy(err)) return false;
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

// ───────────────────────── delivery reports ─────────────────────────

/** What Twilio's delivery error codes mean, in words the owner can act on. */
const DELIVERY_ERRORS: Record<number, string> = {
  30002: 'the Twilio account is suspended',
  30003: 'the phone was switched off or out of reach',
  30004: 'the recipient or their carrier blocked it',
  30005: 'the number does not exist or is no longer in use',
  30006: 'the number is a landline or cannot receive texts',
  30007: "the recipient's carrier filtered it as spam",
  30008: 'the carrier did not say why',
  30032: 'the toll-free number it was sent from is not verified yet',
  30034: 'the number it was sent from is not registered for texting US numbers (A2P 10DLC)',
};

/** Codes about the sending account or number, not one recipient: every text fails the same way until the owner acts. */
const OWNER_FIXES: Record<number, string> = {
  30002: 'Sign in to the Twilio console and check your account.',
  30007: 'Carriers are filtering your texts. Check the wording of your text reminders, and register your number for A2P 10DLC if you text US numbers.',
  30032: 'Verify your toll-free number in the Twilio console. Until then, carriers do not deliver its texts.',
  30034: 'US carriers block texts from numbers that are not registered for A2P 10DLC. Register your number in the Twilio console, or send through a messaging service that is registered. Until then, texts to US numbers are not delivered.',
};

const TWILIO_MESSAGE_SID = /^(SM|MM)[0-9A-Za-z]{4,64}$/;

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** At most one alert a day about texts not getting through, however many fail. */
async function alertOwnerAboutDelivery(ctx: Ctx, code: number, reason: string): Promise<void> {
  const name = `alert-sms-undelivered-${ctx.now().toISOString().slice(0, 10)}`;
  if (!(await claim(ctx, name))) return;
  try {
    await enqueueJob(ctx, {
      type: 'message',
      kind: 'host_alert',
      bookingId: '',
      channel: 'email',
      audience: 'host',
      subject: 'Texts from your booking page are not being delivered',
      body: [
        'Hi {{host_first_name}},',
        `A text from your booking page was not delivered: ${reason}. Twilio error ${code}.`,
        OWNER_FIXES[code] ?? '',
        'You get this message at most once a day.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      dueAt: ctx.now().toISOString(),
    });
  } catch (err) {
    // Nothing was queued: give the claim back so the next report tries again.
    await releaseClaim(ctx, name).catch(() => undefined);
    throw err;
  }
}

/**
 * Twilio's report on a text it took earlier (the StatusCallback set by sendSms). It reports every step
 * (queued, sent, delivered, ...); only `undelivered` and `failed` need anything from us: a timeline note
 * on the booking, and an alert to the owner when the cause is on their side. A dashboard test text has
 * no booking, so it only alerts. Answers 204, or 403 without a valid signature.
 */
export async function handleSmsStatus(ctx: Ctx, req: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch (err) {
    return webhookRefusal(err instanceof HttpError && err.status === 413 ? 413 : 400);
  }
  if (!(await verifyTwilioRequest(ctx, req, form))) return webhookRefusal(403);

  const status = (form.get('MessageStatus') ?? form.get('SmsStatus') ?? '').trim().toLowerCase();
  if (status !== 'undelivered' && status !== 'failed') return noContent();

  let bookingId = '';
  let kind = '';
  try {
    const query = new URL(req.url).searchParams;
    bookingId = query.get('b') ?? '';
    kind = query.get('k') ?? '';
  } catch {
    // no query: a text that belongs to no booking
  }
  const rawCode = Number(form.get('ErrorCode'));
  const code = Number.isInteger(rawCode) && rawCode > 0 && rawCode < 1_000_000 ? rawCode : null;
  const reason = (code !== null ? DELIVERY_ERRORS[code] : undefined) ?? 'the carrier did not deliver it';
  const sid = form.get('MessageSid') ?? form.get('SmsSid') ?? '';
  ctx.log('warn', 'sms: a text was not delivered', { status, code, bookingId: isStorageId(bookingId) ? bookingId : undefined });

  // Twilio can send the same report more than once: one note per message.
  const once = TWILIO_MESSAGE_SID.test(sid) ? `sms-undelivered-${sid}` : null;
  try {
    if (once && !(await claim(ctx, once))) return noContent();
    if (isStorageId(bookingId)) {
      const to = normalizePhone(form.get('To') ?? '');
      const label = MESSAGE_KIND.test(kind) ? `${kind}_sms_undelivered` : 'sms_undelivered';
      const detail = `${to ? `Not delivered to ${to}` : 'Not delivered'}: ${reason}.${code !== null ? ` Twilio error ${code}.` : ''}`;
      const at = ctx.now().toISOString();
      await updateBooking(ctx, bookingId, (b) => ({ ...b, timeline: [...(b.timeline ?? []), { at, type: label, detail }] }));
    }
  } catch (err) {
    ctx.log('error', 'sms: could not record a delivery report', { error: err instanceof Error ? err.message : String(err) });
    // Nothing was noted: a repeat of this report may try again.
    if (once) await releaseClaim(ctx, once).catch(() => undefined);
    return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  if (code !== null && OWNER_FIXES[code]) {
    try {
      await alertOwnerAboutDelivery(ctx, code, reason);
    } catch (err) {
      ctx.log('error', 'sms: could not queue the alert about texts not being delivered', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return noContent();
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
    // START comes from the number itself, so it lifts an earlier stop, calls included (the call flow
    // promises exactly that). YES is also what people answer a reminder with ("I am coming"). Carriers
    // read it as "resume texts", so it lifts the text block only: someone who told the assistant on a
    // call never to ring again is not phoned again because they confirmed a meeting by text.
    if (OPT_IN_WORDS.has(word)) await unblockNumber(ctx, from, ['sms', 'call']);
    else if (word === 'yes') await unblockNumber(ctx, from, ['sms']);
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
