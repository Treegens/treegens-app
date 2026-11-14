/**
 * Everything the dashboard talks to. Every route here goes through `admin()`, which calls
 * requireAdmin: 401 without a valid session, and for anything but GET/HEAD the same-origin
 * check as well (requireAdmin runs assertSameOrigin itself, so it happens exactly once).
 *
 *   GET    /admin/bootstrap                     AdminBootstrap
 *   GET    /admin/overview                      AdminOverview
 *   PUT    /admin/site                          { site }
 *   POST   /admin/event-types                   { eventType }
 *   PUT    /admin/event-types/:id               { eventType }
 *   DELETE /admin/event-types/:id
 *   POST   /admin/event-types/:id/duplicate     { eventType }
 *   PUT    /admin/event-types-order             { ids }
 *   GET    /admin/hosts                         { hosts }
 *   POST   /admin/hosts                         { host, inviteUrl }
 *   PUT    /admin/hosts/:id                     { host, timezone, timezoneChanged }
 *   DELETE /admin/hosts/:id
 *   POST   /admin/hosts/:id/invite              { host, inviteUrl }
 *   GET    /admin/hosts/:id/calendars           { calendars }
 *   POST   /admin/hosts/:id/google/disconnect
 *   GET    /admin/bookings                      { bookings, total, counts }
 *   GET    /admin/bookings.csv                  text/csv
 *   GET    /admin/bookings/:id                  { booking }
 *   POST   /admin/bookings/:id/cancel           { booking }
 *   POST   /admin/bookings/:id/no-show          { booking }
 *   GET    /admin/integrations                  IntegrationsStatus
 *   PUT    /admin/integrations                  IntegrationsStatus
 *   POST   /admin/integrations/test             { ok, detail }
 *   POST   /admin/assets                        { id, url }
 *   DELETE /admin/assets/:id
 */
import { newEventType } from '../../shared/defaults';
import type { AdminBootstrap, AssetUploadResponse, Booking, EventType, Host, HostInviteResponse, SiteSettings } from '../../shared/types';
import { cleanPurpose, MAX_ASSET_REQUEST_BYTES, parseImageDataUrl } from '../lib/admin/assets';
import { exportBookingsCsv, listAdminBookings } from '../lib/admin/bookings';
import { buildEventType, freeSlug, MAX_TITLE_LENGTH, remindersChanged } from '../lib/admin/event-types';
import { applyHostUpdate, createCoHost, loadCalendars, rotateInvite } from '../lib/admin/hosts';
import { integrationsStatus, runIntegrationTest, updateIntegrations } from '../lib/admin/integrations';
import { buildOverview } from '../lib/admin/overview';
import { applySitePatch } from '../lib/admin/site';
import { hostMap, ownerOf, toAdminBooking, toAdminHost } from '../lib/admin/view';
import { rateLimit, requireAdmin } from '../lib/auth';
import { cancelBooking } from '../lib/booking';
import { randomId } from '../lib/crypto';
import type { Ctx } from '../lib/ctx';
import { disconnectGoogle } from '../lib/google';
import { type Handler, HttpError, json, readJson, route, type Route } from '../lib/http';
import { scheduleBookingJobs } from '../lib/jobs';
import {
  assetUrl,
  deleteAsset,
  deleteEventType,
  deleteHost,
  getBooking,
  getBookingIndex,
  getBookings,
  getEventType,
  getHost,
  getSite,
  isStorageId,
  listEventTypes,
  listHosts,
  putAsset,
  saveEventType,
  saveSite,
  updateBooking,
  updateHost,
} from '../lib/repo';
import { TEMPLATE_VARIABLES, joinNames } from '../lib/templates';
import { cleanText, isPlainObject } from '../lib/validate';
import { VOICE_OPTIONS } from '../lib/voice';

const MAX_REPLANNED_BOOKINGS = 200;

/** A dashboard route: signed in, and same-origin for anything that changes data. */
function admin(method: string, pattern: string, handler: Handler): Route {
  return route(method, pattern, async (rc) => {
    await requireAdmin(rc.ctx, rc.req);
    return handler(rc);
  });
}

function missing(what: string): HttpError {
  return new HttpError(404, 'not_found', what);
}

async function requireHost(ctx: Ctx, id: string): Promise<Host> {
  const host = await getHost(ctx, id);
  if (!host) throw missing('That person is no longer on the team.');
  return host;
}

async function requireBooking(ctx: Ctx, id: string): Promise<Booking> {
  const booking = await getBooking(ctx, id);
  if (!booking) throw missing('That booking no longer exists.');
  return booking;
}

async function adminBookingResponse(ctx: Ctx, booking: Booking): Promise<Response> {
  return json({ booking: toAdminBooking(ctx, booking, hostMap(await listHosts(ctx))) });
}

// ───────────────────────── event types ─────────────────────────

/** Saves, turning the store's "link already in use" conflict into the same field error the editor shows for it. */
async function saveValidated(ctx: Ctx, eventType: EventType): Promise<EventType> {
  try {
    return await saveEventType(ctx, eventType);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'slug_taken') {
      throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { slug: 'Another event type already uses this link.' });
    }
    throw err;
  }
}

function nextPosition(all: EventType[]): number {
  return all.reduce((max, e) => Math.max(max, Number.isFinite(e.position) ? e.position : 0), -1) + 1;
}

/** Bookings of an event type that are confirmed and not over yet, soonest first. */
async function upcomingBookingIds(ctx: Ctx, eventTypeId: string): Promise<string[]> {
  const nowMs = ctx.now().getTime();
  return (await getBookingIndex(ctx))
    .filter((entry) => entry.eventTypeId === eventTypeId && entry.status === 'confirmed' && Date.parse(entry.end) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((entry) => entry.id);
}

/**
 * After the reminder rules of an event type changed: rebuild the pending reminders of its
 * upcoming bookings. Runs after the response, never fails the save, and is bounded.
 */
async function replanReminders(ctx: Ctx, eventType: EventType): Promise<void> {
  const ids = (await upcomingBookingIds(ctx, eventType.id)).slice(0, MAX_REPLANNED_BOOKINGS);
  let failed = 0;
  for (const booking of await getBookings(ctx, ids)) {
    if (booking.status !== 'confirmed') continue;
    try {
      await scheduleBookingJobs(ctx, booking, eventType, null);
    } catch (err) {
      failed++;
      ctx.log('warn', 'event types: could not re-plan the reminders of a booking', { bookingId: booking.id, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  ctx.log('info', 'event types: reminders re-planned', { eventTypeId: eventType.id, bookings: ids.length, failed });
}

function replanInBackground(ctx: Ctx, eventType: EventType): void {
  ctx.waitUntil(
    replanReminders(ctx, eventType).catch((err) => {
      ctx.log('error', 'event types: re-planning reminders failed', { eventTypeId: eventType.id, error: err instanceof Error ? err.name : 'unknown' });
    }),
  );
}

// ───────────────────────── assets ─────────────────────────

/** Removes every setting that points at an image, so nothing is left showing a broken picture. */
async function forgetAsset(ctx: Ctx, id: string): Promise<void> {
  const site = await getSite(ctx);
  const theme = site.theme;
  const usedBySite = site.profile.avatarAssetId === id || theme.coverAssetId === id || theme.logoAssetId === id || theme.background?.imageAssetId === id;
  if (usedBySite) {
    const next: SiteSettings = structuredClone(site);
    if (next.profile.avatarAssetId === id) next.profile.avatarAssetId = null;
    if (next.theme.coverAssetId === id) next.theme.coverAssetId = null;
    if (next.theme.logoAssetId === id) next.theme.logoAssetId = null;
    if (next.theme.background?.imageAssetId === id) next.theme.background.imageAssetId = null;
    await saveSite(ctx, next);
  }
  for (const host of await listHosts(ctx)) {
    if (host.avatarAssetId === id) await updateHost(ctx, host.id, (h) => (h.avatarAssetId === id ? { ...h, avatarAssetId: null } : h));
  }
  for (const eventType of await listEventTypes(ctx)) {
    const override = eventType.themeOverride ?? null;
    const usedByOverride = !!override && (override.coverAssetId === id || override.logoAssetId === id || override.background?.imageAssetId === id);
    if (eventType.coverAssetId !== id && !usedByOverride) continue;
    const next: EventType = structuredClone(eventType);
    if (next.coverAssetId === id) next.coverAssetId = null;
    if (next.themeOverride) {
      if (next.themeOverride.coverAssetId === id) next.themeOverride.coverAssetId = null;
      if (next.themeOverride.logoAssetId === id) next.themeOverride.logoAssetId = null;
      if (next.themeOverride.background?.imageAssetId === id) next.themeOverride.background.imageAssetId = null;
    }
    await saveEventType(ctx, next);
  }
}

// ───────────────────────── routes ─────────────────────────

export const routes: Route[] = [
  admin('GET', '/admin/bootstrap', async ({ ctx }) => {
    const [site, hosts, eventTypes] = await Promise.all([getSite(ctx), listHosts(ctx), listEventTypes(ctx)]);
    const owner = ownerOf(hosts, site);
    const bootstrap: AdminBootstrap = {
      site,
      // The owner first, then the team in the order they joined.
      hosts: [...hosts].sort((a, b) => Number(b.id === owner?.id) - Number(a.id === owner?.id)).map((h) => toAdminHost(ctx, h)),
      eventTypes,
      integrations: await integrationsStatus(ctx, { site, hosts }),
      publicUrl: ctx.env.publicBaseUrl,
      embedBaseUrl: ctx.env.embedBaseUrl ?? ctx.env.publicBaseUrl,
      voiceOptions: VOICE_OPTIONS,
      templateVariables: TEMPLATE_VARIABLES,
    };
    return json(bootstrap);
  }),

  admin('GET', '/admin/overview', async ({ ctx }) => json(await buildOverview(ctx))),

  admin('PUT', '/admin/site', async ({ ctx, req }) => {
    const current = await getSite(ctx);
    const next = await applySitePatch(ctx, current, await readJson(req));
    const site = await saveSite(ctx, next);
    // The owner's photo on event pages is the profile photo: keep the two in step.
    const avatar = site.profile.avatarAssetId ?? null;
    if (avatar !== (current.profile.avatarAssetId ?? null)) {
      await updateHost(ctx, site.ownerHostId, (h) => ((h.avatarAssetId ?? null) === avatar ? h : { ...h, avatarAssetId: avatar }));
    }
    return json({ site });
  }),

  // ── event types

  admin('POST', '/admin/event-types', async ({ ctx, req }) => {
    const body = await readJson(req);
    const [site, hosts, all] = await Promise.all([getSite(ctx), listHosts(ctx), listEventTypes(ctx)]);
    const now = ctx.now().toISOString();
    const base = newEventType(now, { id: randomId('evt'), slug: '', title: '', hostIds: [site.ownerHostId], position: nextPosition(all) });
    const eventType = await saveValidated(ctx, await buildEventType(ctx, body, base, { hosts, others: all, creating: true }));
    return json({ eventType }, 201);
  }),

  admin('PUT', '/admin/event-types/:id', async ({ ctx, req, params }) => {
    const body = await readJson(req);
    const [hosts, all] = await Promise.all([listHosts(ctx), listEventTypes(ctx)]);
    const current = all.find((e) => e.id === params.id);
    if (!current) throw missing('That event type no longer exists.');
    const next = await buildEventType(ctx, body, current, { hosts, others: all.filter((e) => e.id !== current.id), creating: false });
    const eventType = await saveValidated(ctx, next);
    if (remindersChanged(current.reminders, eventType.reminders)) replanInBackground(ctx, eventType);
    return json({ eventType });
  }),

  admin('DELETE', '/admin/event-types/:id', async ({ ctx, params }) => {
    const current = await getEventType(ctx, params.id);
    if (!current) return json({ ok: true });
    const upcoming = await upcomingBookingIds(ctx, current.id);
    if (upcoming.length > 0) {
      const count = upcoming.length === 1 ? '1 upcoming booking' : `${upcoming.length} upcoming bookings`;
      throw new HttpError(
        409,
        'has_upcoming_bookings',
        `"${current.title}" still has ${count}. Switch it off instead, so nobody new can book it, and delete it once those meetings have happened.`,
      );
    }
    await deleteEventType(ctx, current.id);
    return json({ ok: true });
  }),

  admin('POST', '/admin/event-types/:id/duplicate', async ({ ctx, params }) => {
    const all = await listEventTypes(ctx);
    const source = all.find((e) => e.id === params.id);
    if (!source) throw missing('That event type no longer exists.');
    const now = ctx.now().toISOString();
    const taken = new Set(all.map((e) => e.slug.toLowerCase()));
    const copy: EventType = {
      ...structuredClone(source),
      id: randomId('evt'),
      title: Array.from(`Copy of ${source.title}`).slice(0, MAX_TITLE_LENGTH).join('').trim(),
      slug: freeSlug(`${source.slug}-copy`, taken),
      position: nextPosition(all),
      createdAt: now,
      updatedAt: now,
    };
    return json({ eventType: await saveValidated(ctx, copy) }, 201);
  }),

  admin('PUT', '/admin/event-types-order', async ({ ctx, req }) => {
    const body = await readJson<{ ids?: unknown }>(req);
    if (!Array.isArray(body.ids) || body.ids.length > 1000 || body.ids.some((id) => typeof id !== 'string')) {
      throw new HttpError(422, 'invalid', 'The new order is not readable. Reload the page and try again.', { ids: 'Expected a list of event type ids.' });
    }
    const wanted = body.ids as string[];
    const all = await listEventTypes(ctx);
    const rank = (e: EventType): number => {
      const i = wanted.indexOf(e.id);
      return i === -1 ? wanted.length : i;
    };
    // Ids we were not told about keep their current order, after the ones we were.
    const ordered = [...all].sort((a, b) => rank(a) - rank(b) || a.position - b.position);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].position !== i) await saveEventType(ctx, { ...ordered[i], position: i });
    }
    return json({ ok: true, eventTypes: await listEventTypes(ctx) });
  }),

  // ── team

  admin('GET', '/admin/hosts', async ({ ctx }) => json({ hosts: (await listHosts(ctx)).map((h) => toAdminHost(ctx, h)) })),

  admin('POST', '/admin/hosts', async ({ ctx, req }) => {
    const created = await createCoHost(ctx, await readJson(req));
    const answer: HostInviteResponse = { host: toAdminHost(ctx, created.host), inviteUrl: created.inviteUrl };
    return json(answer, 201);
  }),

  admin('PUT', '/admin/hosts/:id', async ({ ctx, req, params }) => {
    const host = await requireHost(ctx, params.id);
    const result = await applyHostUpdate(ctx, host, await readJson(req), { self: false });
    return json({ host: toAdminHost(ctx, result.host), timezone: result.host.timezone, timezoneChanged: result.timezoneChanged });
  }),

  admin('DELETE', '/admin/hosts/:id', async ({ ctx, params }) => {
    const host = await getHost(ctx, params.id);
    if (!host) return json({ ok: true });
    if (host.role === 'owner') throw new HttpError(400, 'owner_required', 'The owner cannot be removed.');
    const used = (await listEventTypes(ctx)).filter((e) => e.hostIds.includes(host.id));
    if (used.length > 0) {
      const titles = joinNames(used.map((e) => `"${e.title}"`));
      throw new HttpError(409, 'host_in_use', `${host.name} still hosts ${titles}. Remove them from ${used.length === 1 ? 'that event type' : 'those event types'} first.`);
    }
    // Hands the Google grant back (best effort) before the record, and with it the stored token, goes.
    if (host.google) await disconnectGoogle(ctx, host.id);
    await deleteHost(ctx, host.id);
    return json({ ok: true });
  }),

  admin('POST', '/admin/hosts/:id/invite', async ({ ctx, params }) => {
    const rotated = await rotateInvite(ctx, params.id);
    const answer: HostInviteResponse = { host: toAdminHost(ctx, rotated.host), inviteUrl: rotated.inviteUrl };
    return json(answer);
  }),

  admin('GET', '/admin/hosts/:id/calendars', async ({ ctx, params }) => {
    return json({ calendars: await loadCalendars(ctx, await requireHost(ctx, params.id)) });
  }),

  admin('POST', '/admin/hosts/:id/google/disconnect', async ({ ctx, params }) => {
    const host = await requireHost(ctx, params.id);
    await disconnectGoogle(ctx, host.id);
    // Nothing to follow any more: fall back to the device the person uses.
    const after = await updateHost(ctx, host.id, (h) => (h.timezoneMode === 'google' ? { ...h, timezoneMode: 'device' } : h));
    return json({ ok: true, host: toAdminHost(ctx, after ?? { ...host, google: null, calendarHealth: null }) });
  }),

  // ── bookings

  admin('GET', '/admin/bookings', async ({ ctx, url }) => json(await listAdminBookings(ctx, url.searchParams))),

  admin('GET', '/admin/bookings.csv', async ({ ctx, url }) => {
    const { filename, body } = await exportBookingsCsv(ctx, url.searchParams);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),

  admin('GET', '/admin/bookings/:id', async ({ ctx, params }) => adminBookingResponse(ctx, await requireBooking(ctx, params.id))),

  admin('POST', '/admin/bookings/:id/cancel', async ({ ctx, req, params }) => {
    const body = await readJson<{ reason?: unknown }>(req);
    await requireBooking(ctx, params.id);
    const reason = cleanText(body.reason, 500);
    const cancelled = await cancelBooking(ctx, params.id, reason ? { by: 'host', reason } : { by: 'host' });
    return adminBookingResponse(ctx, cancelled);
  }),

  admin('POST', '/admin/bookings/:id/no-show', async ({ ctx, req, params }) => {
    const body = await readJson<{ noShow?: unknown }>(req);
    if (typeof body.noShow !== 'boolean') throw new HttpError(422, 'invalid', 'Say whether this was a no-show.', { noShow: 'Expected true or false.' });
    const noShow = body.noShow;
    const booking = await requireBooking(ctx, params.id);
    if (booking.status !== 'confirmed') throw new HttpError(409, 'cancelled', 'This meeting was cancelled, so it cannot be marked as a no-show.');
    if (Date.parse(booking.start) > ctx.now().getTime()) throw new HttpError(409, 'not_started', 'This meeting has not started yet.');
    const at = ctx.now().toISOString();
    const updated = await updateBooking(ctx, booking.id, (b) => {
      if ((b.attendance?.noShow === true) === noShow) return b;
      return {
        ...b,
        attendance: { ...(b.attendance ?? {}), noShow },
        timeline: [...(b.timeline ?? []), { at, type: noShow ? 'marked_no_show' : 'no_show_cleared' }],
      };
    });
    return adminBookingResponse(ctx, updated ?? booking);
  }),

  // ── integrations

  admin('GET', '/admin/integrations', async ({ ctx }) => json(await integrationsStatus(ctx))),

  admin('PUT', '/admin/integrations', async ({ ctx, req }) => json(await updateIntegrations(ctx, await readJson(req)))),

  admin('POST', '/admin/integrations/test', async ({ ctx, req }) => {
    const body = await readJson(req);
    try {
      // Every test costs something somewhere (an email, a text, a call, tokens).
      await rateLimit(ctx, 'integration-test', 'dashboard', 20, 3600);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throw new HttpError(429, 'rate_limited', 'That is a lot of tests in one hour. Please wait a little before trying again.', undefined, err.headers);
      }
      throw err;
    }
    return json(await runIntegrationTest(ctx, isPlainObject(body) ? body : {}));
  }),

  // ── images

  admin('POST', '/admin/assets', async ({ ctx, req }) => {
    const body = await readJson<{ dataUrl?: unknown; purpose?: unknown }>(req, MAX_ASSET_REQUEST_BYTES);
    const image = parseImageDataUrl(body.dataUrl);
    await rateLimit(ctx, 'asset-upload', 'dashboard', 120, 3600);
    const id = await putAsset(ctx, image.data, image.contentType, cleanPurpose(body.purpose));
    const answer: AssetUploadResponse = { id, url: assetUrl(ctx, id) ?? '' };
    return json(answer, 201);
  }),

  admin('DELETE', '/admin/assets/:id', async ({ ctx, params }) => {
    if (!isStorageId(params.id)) throw missing('That image does not exist.');
    await forgetAsset(ctx, params.id);
    await deleteAsset(ctx, params.id);
    return json({ ok: true });
  }),
];
