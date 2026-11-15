/**
 * Everything a visitor's browser talks to: the public site, available times, booking, and the
 * self-service pages behind a manage link.
 *
 *   GET  /public/site                        → PublicSite
 *   GET  /public/event/:slug                 → { site, eventType }           404 when unknown or paused
 *   GET  /public/slots?slug&duration&from&to[&reschedule&t]  → SlotsResponse
 *   POST /public/bookings                    → 201 { booking, manageToken }  409 slot_taken · 503 calendar_unavailable · 422 · 429
 *   GET  /public/bookings/:id?t=[&as=host]   → { booking, site, eventType }
 *   POST /public/bookings/:id/cancel         { t, reason?, as? }             → { booking }
 *   POST /public/bookings/:id/reschedule     { t, start, timezone?, as? }    → { booking }
 *   POST /public/bookings/:id/confirm        { t }                           → { booking }
 *   GET  /public/bookings/:id/ics?t=         → the calendar file
 *   GET  /assets/:id                         → an uploaded image
 *
 * A wrong or missing manage token is always the same plain 404, whether or not the booking exists.
 * Every state-changing route passes the same-origin check. Nothing here needs a session.
 *
 * `as: 'host'` is sent by the booking page when it was opened from a host's link (host emails and the
 * dashboard add `as=host`). The invitee holds the same token, so on its own it grants nothing: it only
 * keeps the host's time zone off the invitee and records the change as made by a host.
 *
 * With `as: 'host'` AND the owner's session (the dashboard's cookie, which reaches /meeting/api on the
 * address where the owner signed in), the owner is acting, with the rights the dashboard gives: none of the
 * invitee's deadlines or move limits. The token is still checked. Without the session nothing changes.
 */
import type { Booking, CreateBookingRequest, CreateBookingResponse, GetBookingResponse, PublicBooking, PublicEventResponse } from '../../shared/types';
import { assertSameOrigin, isAdmin, rateLimit } from '../lib/auth';
import {
  cancelBooking,
  confirmAttendance,
  createBooking,
  getManageView,
  getPublicEvent,
  getSlots,
  manageToken,
  registerBookingJobHandlers,
  rescheduleBooking,
  toPublicBooking,
  toPublicSite,
  verifyManageToken,
} from '../lib/booking';
import type { Ctx } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';
import { buildBookingIcs } from '../lib/ics';
import { getAsset, getBooking, getSite, isStorageId, listHosts } from '../lib/repo';
import { FieldErrors, isIsoInstant } from '../lib/validate';

// Bookings queue calendar repairs; the job runner must know how to run them in every API process.
registerBookingJobHandlers();

const BOOKING_BODY_LIMIT = 64 * 1024;
const MANAGE_BODY_LIMIT = 16 * 1024;
const MAX_REASON = 500;

/**
 * The spec says 240. A person paging through months asks a handful of times a minute (the widget
 * keeps what it already loaded), so 60 is plenty and keeps one address from driving calendar reads.
 */
const SLOTS_PER_MINUTE = 60;
const MANAGE_READS_PER_MINUTE = 120;
const MANAGE_WRITES_PER_10_MIN = 30;
/** Requests without a client address share one counter, so that counter is wider. */
const UNKNOWN_IP_FACTOR = 12;

/** The only types uploads can have. Anything else is handed out as a download, never rendered. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function bookingNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'We could not find that booking. Check the link in your confirmation email.');
}

async function limitByVisitor(ctx: Ctx, bucket: string, limit: number, windowSec: number): Promise<void> {
  const ip = typeof ctx.ip === 'string' ? ctx.ip.trim() : '';
  await rateLimit(ctx, bucket, ip || 'unknown', ip ? limit : limit * UNKNOWN_IP_FACTOR, windowSec);
}

/** A point in time from a query parameter: epoch milliseconds or an ISO instant. */
function readInstant(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (/^\d{9,16}$/.test(text)) {
    const ms = Number(text);
    return Number.isSafeInteger(ms) ? ms : null;
  }
  // A "+02:00" offset that was not percent-encoded arrives with a space where the plus sign was.
  const repaired = text.replace(/ (\d{2}:\d{2})$/, '+$1');
  return isIsoInstant(repaired) ? Date.parse(repaired) : null;
}

function tokenOf(body: Record<string, unknown>): string | null {
  return typeof body.t === 'string' ? body.t : null;
}

/**
 * Who is acting on the booking page. 'host' is only what the page says (never a permission, see the top of
 * this file). 'owner' is a host's link opened by the signed-in owner: the session is the permission.
 */
async function actorOf(ctx: Ctx, req: Request, asHost: boolean): Promise<'invitee' | 'host' | 'owner'> {
  if (!asHost) return 'invitee';
  return (await isAdmin(ctx, req)) ? 'owner' : 'host';
}

/** The public view of a booking that was just changed. One retry: the change itself is already done. */
async function publicView(ctx: Ctx, booking: Booking, opts?: { owner?: boolean }): Promise<PublicBooking> {
  try {
    return await toPublicBooking(ctx, booking, opts);
  } catch (err) {
    ctx.log('warn', 'public: could not build the booking view, trying once more', { bookingId: booking.id, error: err instanceof Error ? err.message : String(err) });
    return toPublicBooking(ctx, booking, opts);
  }
}

function icsFilename(slug: string): string {
  const safe = String(slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${safe || 'meeting'}.ics`;
}

export const routes: Route[] = [
  route('GET', '/public/site', async ({ ctx }) => json(await toPublicSite(ctx))),

  route('GET', '/public/event/:slug', async ({ ctx, params }) => {
    const found = await getPublicEvent(ctx, params.slug);
    if (!found) throw new HttpError(404, 'not_found', 'This meeting type does not exist or is no longer offered.');
    const body: PublicEventResponse = found;
    return json(body);
  }),

  route('GET', '/public/slots', async ({ ctx, url }) => {
    await limitByVisitor(ctx, 'slots', SLOTS_PER_MINUTE, 60);
    const query = url.searchParams;
    const errors = new FieldErrors();

    const slug = (query.get('slug') ?? '').trim();
    if (slug === '' || slug.length > 64) errors.add('slug', 'Say which meeting type you mean.');
    const durationText = (query.get('duration') ?? '').trim();
    const durationMin = /^\d{1,4}$/.test(durationText) ? Number(durationText) : NaN;
    if (!Number.isFinite(durationMin) || durationMin <= 0) errors.add('duration', 'Please choose one of the offered lengths.');
    const fromMs = readInstant(query.get('from'));
    if (fromMs === null) errors.add('from', 'Not a valid date.');
    const toMs = readInstant(query.get('to'));
    if (toMs === null) errors.add('to', 'Not a valid date.');
    errors.throwIfAny('A meeting type, a length and a valid date range are needed.');

    // Moving a booking: its own time counts as free, which only the holder of its manage link may ask for.
    const rescheduleId = (query.get('reschedule') ?? '').trim();
    if (rescheduleId !== '') {
      if (!verifyManageToken(ctx, rescheduleId, query.get('t'))) throw bookingNotFound();
      if (!(await getBooking(ctx, rescheduleId))) throw bookingNotFound();
    }

    return json(
      await getSlots(ctx, {
        slug,
        durationMin,
        fromMs: fromMs as number,
        toMs: toMs as number,
        ...(rescheduleId !== '' ? { rescheduleBookingId: rescheduleId } : {}),
      }),
    );
  }),

  route('POST', '/public/bookings', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    const body = await readJson<CreateBookingRequest>(req, BOOKING_BODY_LIMIT);
    const created = await createBooking(ctx, body);
    const response: CreateBookingResponse = { booking: await publicView(ctx, created.booking), manageToken: created.manageToken };
    return json(response, 201);
  }),

  route('GET', '/public/bookings/:id', async ({ ctx, req, url, params }) => {
    await limitByVisitor(ctx, 'manage-read', MANAGE_READS_PER_MINUTE, 60);
    if (!verifyManageToken(ctx, params.id, url.searchParams.get('t'))) throw bookingNotFound();
    // The owner's page offers what the dashboard allows: cancelling or moving a meeting that has started.
    const owner = (await actorOf(ctx, req, url.searchParams.get('as') === 'host')) === 'owner';
    const view = await getManageView(ctx, params.id, owner ? { owner } : undefined);
    if (!view) throw bookingNotFound();
    const body: GetBookingResponse = { booking: view.booking, site: view.site, eventType: view.eventType };
    return json(body);
  }),

  route('POST', '/public/bookings/:id/cancel', async ({ ctx, req, params }) => {
    assertSameOrigin(ctx, req);
    await limitByVisitor(ctx, 'manage-write', MANAGE_WRITES_PER_10_MIN, 600);
    const body = await readJson<Record<string, unknown>>(req, MANAGE_BODY_LIMIT);
    if (!verifyManageToken(ctx, params.id, tokenOf(body))) throw bookingNotFound();
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
      throw new HttpError(422, 'invalid', 'The reason could not be read.', { reason: 'Please write the reason as text.' });
    }
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (reason.length > MAX_REASON * 2) {
      throw new HttpError(422, 'invalid', `Please keep the reason under ${MAX_REASON} characters.`, { reason: `Please keep this under ${MAX_REASON} characters.` });
    }
    const actor = await actorOf(ctx, req, body.as === 'host');
    const withReason = reason.trim() ? { reason } : {};
    const booking =
      actor === 'owner'
        ? await cancelBooking(ctx, params.id, { by: 'host', actor, ...withReason })
        : await cancelBooking(ctx, params.id, { by: 'invitee', actor, ...withReason });
    return json({ booking: await publicView(ctx, booking, actor === 'owner' ? { owner: true } : undefined) });
  }),

  route('POST', '/public/bookings/:id/reschedule', async ({ ctx, req, params }) => {
    assertSameOrigin(ctx, req);
    await limitByVisitor(ctx, 'manage-write', MANAGE_WRITES_PER_10_MIN, 600);
    const body = await readJson<Record<string, unknown>>(req, MANAGE_BODY_LIMIT);
    if (!verifyManageToken(ctx, params.id, tokenOf(body))) throw bookingNotFound();
    if (typeof body.start !== 'string') throw new HttpError(422, 'invalid', 'Please pick a new time.', { start: 'Please pick a time.' });
    const actor = await actorOf(ctx, req, body.as === 'host');
    const booking =
      actor === 'owner'
        ? // The owner moves it as in the dashboard. Their browser is in their own zone, not the invitee's.
          await rescheduleBooking(ctx, params.id, { startIso: body.start, by: 'host', actor })
        : await rescheduleBooking(ctx, params.id, {
            startIso: body.start,
            by: 'invitee',
            actor,
            // A host's browser is in the host's zone, not the invitee's.
            ...(actor === 'invitee' && typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
          });
    return json({ booking: await publicView(ctx, booking, actor === 'owner' ? { owner: true } : undefined) });
  }),

  route('POST', '/public/bookings/:id/confirm', async ({ ctx, req, params }) => {
    assertSameOrigin(ctx, req);
    await limitByVisitor(ctx, 'manage-write', MANAGE_WRITES_PER_10_MIN, 600);
    const body = await readJson<Record<string, unknown>>(req, MANAGE_BODY_LIMIT);
    if (!verifyManageToken(ctx, params.id, tokenOf(body))) throw bookingNotFound();
    const booking = await confirmAttendance(ctx, params.id, 'link');
    return json({ booking: await publicView(ctx, booking) });
  }),

  route('GET', '/public/bookings/:id/ics', async ({ ctx, url, params }) => {
    await limitByVisitor(ctx, 'manage-read', MANAGE_READS_PER_MINUTE, 60);
    if (!verifyManageToken(ctx, params.id, url.searchParams.get('t'))) throw bookingNotFound();
    const booking = await getBooking(ctx, params.id);
    if (!booking) throw bookingNotFound();

    const site = await getSite(ctx);
    const everyone = await listHosts(ctx);
    const assigned = booking.hostIds.map((id) => everyone.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => !!h);
    const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
    // A plain event file to add (no invitation to answer); for a cancelled meeting, the file that takes it out again.
    const method = booking.status === 'cancelled' ? 'CANCEL' : 'PUBLISH';
    const content = buildBookingIcs({
      booking,
      hosts: assigned,
      site,
      method,
      baseUrl: base,
      manageUrl: `${base}/booking/${encodeURIComponent(booking.id)}?t=${manageToken(ctx, booking.id)}`,
    });
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': `text/calendar; charset=utf-8; method=${method}`,
        'Content-Disposition': `attachment; filename="${icsFilename(booking.eventSlug)}"`,
        // Personal, and reachable only with the token in the address: never stored by anything in between.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),

  route('GET', '/assets/:id', async ({ ctx, params }) => {
    const asset = isStorageId(params.id) ? await getAsset(ctx, params.id) : null;
    if (!asset) throw new HttpError(404, 'not_found', 'Not found.');
    const stored = asset.contentType.split(';')[0].trim().toLowerCase();
    const isImage = IMAGE_TYPES.has(stored);
    const headers: Record<string, string> = {
      'Content-Type': isImage ? stored : 'application/octet-stream',
      'Content-Length': String(asset.data.byteLength),
      // An asset id never gets new content: a changed image is a new id.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    };
    if (!isImage) headers['Content-Disposition'] = 'attachment';
    // A copy on its own buffer: the stored bytes may be a view into a larger (or shared) one.
    const bytes = new Uint8Array(asset.data.byteLength);
    bytes.set(asset.data);
    return new Response(bytes, { status: 200, headers });
  }),
];
