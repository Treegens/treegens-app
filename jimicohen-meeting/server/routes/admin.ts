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
 *   POST   /admin/event-types-check             SharedHoursCheck (body: an event type, saved or not)
 *   GET    /admin/hosts                         { hosts }
 *   POST   /admin/hosts                         { host, inviteUrl }
 *   PUT    /admin/hosts/:id                     { host, timezone, timezoneChanged }
 *   DELETE /admin/hosts/:id
 *   POST   /admin/hosts/:id/invite              { host, inviteUrl }
 *   GET    /admin/hosts/:id/calendars           { calendars } of the main Google account
 *   POST   /admin/hosts/:id/google/disconnect   the main Google account goes
 *   GET    /admin/hosts/:id/google/:accountId/calendars   { calendars } of one account
 *   GET    /admin/hosts/:id/google/:accountId/removal     GoogleRemovalPreview
 *   DELETE /admin/hosts/:id/google/:accountId             GoogleAccountRemoved
 *   GET    /admin/bookings                      { bookings, total, counts }
 *   GET    /admin/bookings.csv                  text/csv
 *   GET    /admin/bookings/:id                  { booking }
 *   POST   /admin/bookings/:id/cancel           { booking }
 *   POST   /admin/bookings/:id/no-show          { booking }
 *   DELETE /admin/bookings/:id                  { ok } (cancelled or past bookings only; ?leaveCalendarEvent=1)
 *   GET    /admin/integrations                  IntegrationsStatus
 *   PUT    /admin/integrations                  IntegrationsStatus
 *   POST   /admin/integrations/test             { ok, detail }
 *   POST   /admin/assets                        { id, url }
 *   DELETE /admin/assets/:id
 *   PUT    /admin/brands/:id                    { brand, site } (the owner's changes to a built-in brand)
 *   PUT    /admin/short-links                   { shortLinks, eventType? } (what jimicohen.com/meet and /pod open)
 */
import { storedBrand } from '../../shared/brands';
import { newEventType } from '../../shared/defaults';
import { SHORT_LINK_NAMES, SHORT_LINKS, isShortName, shortLabelOf, shortLinkTarget, shortUrlOf } from '../../shared/shortLinks';
import type { AdminBootstrap, AssetUploadResponse, Booking, EventType, Host, HostInviteResponse, SiteSettings } from '../../shared/types';
import { cleanPurpose, MAX_ASSET_REQUEST_BYTES, parseImageDataUrl } from '../lib/admin/assets';
import { calendarBeingRemoved, eraseBooking, exportBookingsCsv, listAdminBookings } from '../lib/admin/bookings';
import { brandAssetIds, forgetBrandAsset, prepareBrandPatch } from '../lib/admin/brands';
import { buildEventType, freeSlug, MAX_TITLE_LENGTH, remindersChanged } from '../lib/admin/event-types';
import { applyHostUpdate, createCoHost, loadCalendars, rotateInvite } from '../lib/admin/hosts';
import { integrationsStatus, runIntegrationTest, updateIntegrations } from '../lib/admin/integrations';
import { buildOverview, checkSharedHours } from '../lib/admin/overview';
import { applySitePatch, reapplySitePatch } from '../lib/admin/site';
import { hostMap, ownerOf, toAdminBooking, toAdminHost, withCallTranscripts } from '../lib/admin/view';
import { rateLimit, requireAdmin } from '../lib/auth';
import { cancelBooking } from '../lib/booking';
import { isBuiltinAssetId } from '../lib/builtinAssets';
import { randomId } from '../lib/crypto';
import type { Ctx } from '../lib/ctx';
import { disconnectAllGoogle } from '../lib/google';
import { googleRemovalPreview, removeHostGoogleAccount, removeMainGoogleAccount } from '../lib/googleRemoval';
import { type Handler, HttpError, json, readJson, route, type Route } from '../lib/http';
import { planMissedReminderCalls, replanBookingReminders, replanReminderCalls } from '../lib/jobs';
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
  updateBooking,
  updateEventTypes,
  updateHost,
  updateSite,
} from '../lib/repo';
import { TEMPLATE_VARIABLES, joinNames } from '../lib/templates';
import { FieldErrors, cleanText, isPlainObject } from '../lib/validate';
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
  // Call transcripts come from the call records while they are kept; the booking stores only the outcome.
  const view = await withCallTranscripts(ctx, toAdminBooking(ctx, booking, hostMap(await listHosts(ctx))));
  if (await calendarBeingRemoved(ctx, booking).catch(() => false)) view.calendarRemoving = true;
  return json({ booking: view });
}

// ───────────────────────── event types ─────────────────────────

/**
 * Saves, turning the store's "link already in use" conflict into the same field error the editor shows for it.
 * `setBrand`: the request chose the brand. Otherwise the stored brand is kept (a tab opened before brands never sends it).
 */
async function saveValidated(ctx: Ctx, eventType: EventType, opts?: { setBrand?: boolean }): Promise<EventType> {
  try {
    return await saveEventType(ctx, eventType, opts);
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
  const bookings = (await getBookings(ctx, ids)).filter((b) => b.status === 'confirmed');
  // One read of the queue for all of them, instead of one per booking. Each booking's old reminders go
  // only when its new ones are queued, so a run cut off part-way leaves the rest with their old ones.
  const failed = await replanBookingReminders(ctx, bookings, eventType, (bookingId, err) =>
    ctx.log('warn', 'event types: could not re-plan the reminders of a booking', { bookingId, error: err instanceof Error ? err.name : 'unknown' }),
  );
  ctx.log('info', 'event types: reminders re-planned', { eventTypeId: eventType.id, bookings: ids.length, failed });
}

/**
 * After the calling hours changed: moves the reminder calls already waiting in the queue inside the
 * new hours, as the Settings hint says, then plans the calls the old hours had left no time for when
 * the new ones do. Runs after the response and never fails the save.
 */
function replanCallsInBackground(ctx: Ctx, hours: SiteSettings['assistant']): void {
  const work = async (): Promise<void> => {
    const moved = await replanReminderCalls(ctx, hours, {
      onError: (jobId, err) => ctx.log('warn', 'settings: could not move a reminder call into the new calling hours', { jobId, error: err instanceof Error ? err.name : 'unknown' }),
    });
    ctx.log('info', 'settings: reminder calls re-planned for the new calling hours', moved);
    const planned = await planMissedReminderCalls(ctx, hours, {
      onError: (bookingId, err) => ctx.log('warn', 'settings: could not plan a reminder call in the new calling hours', { bookingId, error: err instanceof Error ? err.name : 'unknown' }),
    });
    ctx.log('info', 'settings: reminder calls planned that the old calling hours had no time for', planned);
  };
  ctx.waitUntil(work().catch((err) => ctx.log('error', 'settings: re-planning reminder calls failed', { error: err instanceof Error ? err.name : 'unknown' })));
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
  const usedBySite =
    site.profile.avatarAssetId === id || theme.coverAssetId === id || theme.logoAssetId === id || theme.background?.imageAssetId === id || brandAssetIds(site).includes(id);
  if (usedBySite) {
    await updateSite(ctx, (fresh) => {
      const next: SiteSettings = structuredClone(fresh);
      if (next.profile.avatarAssetId === id) next.profile.avatarAssetId = null;
      if (next.theme.coverAssetId === id) next.theme.coverAssetId = null;
      if (next.theme.logoAssetId === id) next.theme.logoAssetId = null;
      if (next.theme.background?.imageAssetId === id) next.theme.background.imageAssetId = null;
      // A brand's uploaded logo goes back to the built-in one.
      return forgetBrandAsset(next, id);
    });
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
      // null until the one-time setup has run; a link whose event was deleted opens nothing.
      shortLinks: site.shortLinks
        ? SHORT_LINK_NAMES.map((name) => {
            const id = shortLinkTarget(site, name);
            return { name, url: shortUrlOf(ctx.env.publicBaseUrl, name), eventTypeId: id && eventTypes.some((e) => e.id === id) ? id : null };
          })
        : null,
    };
    return json(bootstrap);
  }),

  admin('GET', '/admin/overview', async ({ ctx }) => json(await buildOverview(ctx))),

  admin('PUT', '/admin/site', async ({ ctx, req }) => {
    const body = await readJson(req);
    const current = await getSite(ctx);
    // Checked once against what was read (images included), then laid over the freshest settings in a
    // compare-and-swap, so a brand change or the short link setup saved at the same moment is kept.
    await applySitePatch(ctx, current, body);
    const site = await updateSite(ctx, (fresh) => reapplySitePatch(fresh, body));
    // The owner's photo on event pages is the profile photo: keep the two in step, while they are.
    const oldAvatar = current.profile.avatarAssetId ?? null;
    const avatar = site.profile.avatarAssetId ?? null;
    if (avatar !== oldAvatar) {
      await updateHost(ctx, site.ownerHostId, (h) => ((h.avatarAssetId ?? null) === oldAvatar ? { ...h, avatarAssetId: avatar } : h));
    }
    // The same goes for the name: event pages, emails and the assistant on the phone name the host, and for
    // the owner that is the name on the profile. Only while the two are the same: a profile that carries
    // another name (a brand, say) must never rename the person on every message.
    const name = site.profile.name.trim();
    const was = current.profile.name.trim();
    if (name !== '' && name !== was) {
      await updateHost(ctx, site.ownerHostId, (h) => (h.name.trim() === was ? { ...h, name } : h));
    }
    // Calls already planned move with the calling hours.
    const before = current.assistant;
    if (site.assistant.callWindowStartHour !== before?.callWindowStartHour || site.assistant.callWindowEndHour !== before?.callWindowEndHour) {
      replanCallsInBackground(ctx, site.assistant);
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
    const eventType = await saveValidated(ctx, next, { setBrand: isPlainObject(body) && 'brandId' in body });
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

  // For the editor and for "Create a joint meeting": do the hosts' working hours ever line up?
  // The body is the event type as it is on screen, saved or not. Nothing is stored.
  admin('POST', '/admin/event-types-check', async ({ ctx, req }) => {
    const draft = await readJson<Record<string, unknown>>(req);
    const [site, hosts, all] = await Promise.all([getSite(ctx), listHosts(ctx), listEventTypes(ctx)]);
    const saved = typeof draft.id === 'string' ? all.find((e) => e.id === draft.id) : undefined;
    const base = saved ?? newEventType(ctx.now().toISOString(), { id: 'evt_draft', slug: 'draft', title: 'This meeting', hostIds: [site.ownerHostId], position: 0 });
    // Only what decides when people can be booked: the rest of a draft may still be half typed.
    const relevant = Object.fromEntries(['kind', 'hostIds', 'durations', 'scheduling'].filter((key) => key in draft).map((key) => [key, draft[key]]));
    let eventType: EventType;
    try {
      eventType = await buildEventType(ctx, relevant, base, { hosts, others: [], creating: false });
    } catch (err) {
      // A draft that does not add up yet has nothing to check. Saving it says what is wrong.
      if (err instanceof HttpError && err.status === 422) return json({ ok: true });
      throw err;
    }
    const title = typeof draft.title === 'string' ? draft.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
    if (title !== '') eventType.title = title;
    return json(checkSharedHours({ eventType, hosts, owner: ownerOf(hosts, site), nowMs: ctx.now().getTime() }));
  }),

  // ── team

  admin('GET', '/admin/hosts', async ({ ctx }) => json({ hosts: (await listHosts(ctx)).map((h) => toAdminHost(ctx, h)) })),

  // With addToEventTypeIds the new co-host also joins those meetings (the Team dialog offers the /pod one).
  // The co-host exists either way: a meeting that could not be changed is reported in notAddedTo.
  admin('POST', '/admin/hosts', async ({ ctx, req }) => {
    const body = await readJson<Record<string, unknown>>(req);
    const addTo = readAddTo(isPlainObject(body) ? body.addToEventTypeIds : undefined);
    const created = await createCoHost(ctx, body);
    const answer: HostInviteResponse = { host: toAdminHost(ctx, created.host), inviteUrl: created.inviteUrl };
    if (addTo.length > 0) {
      try {
        const outcome = await updateEventTypes(ctx, (list) => addHostToEventTypes(list, created.host.id, addTo));
        answer.eventTypes = outcome.changed;
        answer.notAddedTo = outcome.notAdded;
      } catch (err) {
        ctx.log('warn', 'team: the new co-host could not be added to their meetings', { error: err instanceof Error ? err.message : 'unknown' });
        answer.eventTypes = [];
        answer.notAddedTo = addTo.map((id) => ({ id, message: 'The meeting could not be changed just now.' }));
      }
    }
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
    // Hands every Google grant back (best effort) before the record, and with it the stored tokens, goes.
    await disconnectAllGoogle(ctx, host.id);
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

  // The main account, for pages opened before accounts could be told apart: they show only that one.
  admin('POST', '/admin/hosts/:id/google/disconnect', async ({ ctx, params }) => {
    const host = await requireHost(ctx, params.id);
    return json({ ok: true, host: toAdminHost(ctx, await removeMainGoogleAccount(ctx, host)) });
  }),

  admin('GET', '/admin/hosts/:id/google/:accountId/calendars', async ({ ctx, params }) => {
    return json({ calendars: await loadCalendars(ctx, await requireHost(ctx, params.id), params.accountId) });
  }),

  admin('GET', '/admin/hosts/:id/google/:accountId/removal', async ({ ctx, params }) => {
    return json(await googleRemovalPreview(ctx, await requireHost(ctx, params.id), params.accountId, { self: false }));
  }),

  admin('DELETE', '/admin/hosts/:id/google/:accountId', async ({ ctx, params }) => {
    return json(await removeHostGoogleAccount(ctx, await requireHost(ctx, params.id), params.accountId, { self: false }));
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

  // Erases a cancelled or past booking for good (a request to delete someone's data). An upcoming
  // meeting is refused: cancel it first. Deleting one that is already gone answers ok as well.
  // ?leaveCalendarEvent=1: the owner knows a cancelled meeting's event stays on Google Calendar, and deletes anyway.
  admin('DELETE', '/admin/bookings/:id', async ({ ctx, params, url }) => {
    const leave = url.searchParams.get('leaveCalendarEvent');
    const result = await eraseBooking(ctx, params.id, { leaveCalendarEvent: leave === '1' || leave === 'true' });
    return json(result.calendarEventLeft ? { ok: true, calendarEventLeft: true } : { ok: true });
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
    if (!isStorageId(params.id) || isBuiltinAssetId(params.id)) throw missing('That image does not exist.');
    await forgetAsset(ctx, params.id);
    await deleteAsset(ctx, params.id);
    return json({ ok: true });
  }),

  // ── brands and short links

  // The owner's changes to a built-in brand: its look (a partial theme, as in PUT /admin/site), logo and sender name.
  admin('PUT', '/admin/brands/:id', async ({ ctx, req, params }) => {
    const body = await readJson(req);
    const apply = await prepareBrandPatch(ctx, await getSite(ctx), params.id, body);
    const site = await updateSite(ctx, apply);
    return json({ brand: storedBrand(site, params.id as never), site });
  }),

  // What a short link opens. With `brand: true` the event first gets the link's own look (Eco Champions for
  // /pod, the owner's own for /meet). The map is written last; when that fails the brand change stays.
  admin('PUT', '/admin/short-links', async ({ ctx, req }) => {
    const body = await readJson<Record<string, unknown>>(req);
    const b = isPlainObject(body) ? body : {};
    const errors = new FieldErrors();
    const labels = SHORT_LINK_NAMES.map((n) => shortLabelOf(ctx.env.publicBaseUrl, n));
    if (!isShortName(b.name)) errors.add('name', `Choose ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}.`);
    const id = b.eventTypeId;
    if (!(id === null || (typeof id === 'string' && id !== ''))) errors.add('eventTypeId', 'That meeting no longer exists. Choose another.');
    if (b.brand !== undefined && typeof b.brand !== 'boolean') errors.add('brand', 'Expected true or false.');
    errors.throwIfAny('Please check the highlighted fields.');
    const name = b.name as (typeof SHORT_LINK_NAMES)[number];
    let eventType: EventType | undefined;
    if (typeof id === 'string') {
      const found = await getEventType(ctx, id);
      if (!found) throw new HttpError(422, 'invalid', 'That meeting no longer exists. Choose another.', { eventTypeId: 'That meeting no longer exists. Choose another.' });
      eventType = found;
      const wanted = SHORT_LINKS[name].brandId;
      if (b.brand === true && (found.brandId ?? null) !== wanted) {
        eventType = await updateEventTypes(ctx, (list) => {
          const target = list.find((e) => e.id === id);
          if (!target) return { keep: found };
          if ((target.brandId ?? null) === wanted) return { keep: target };
          const next = { ...target, brandId: wanted };
          return { next: list.map((e) => (e.id === id ? next : e)), result: next };
        });
      }
    }
    let site: SiteSettings;
    try {
      site = await updateSite(ctx, (fresh) => ({ ...fresh, shortLinks: { ...(fresh.shortLinks ?? {}), [name]: id as string | null } }));
    } catch (err) {
      ctx.log('warn', 'short links: the link could not be saved', { error: err instanceof Error ? err.message : 'unknown' });
      throw new HttpError(503, 'busy', 'The link could not be saved just now. Please try again in a moment.');
    }
    return json(eventType ? { shortLinks: site.shortLinks, eventType } : { shortLinks: site.shortLinks });
  }),
];

const MAX_ADD_TO = 20;

/** addToEventTypeIds of POST /admin/hosts: absent or a list of at most 20 ids (422 otherwise). */
function readAddTo(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ADD_TO || value.some((id) => typeof id !== 'string' || id === '')) {
    throw new HttpError(422, 'invalid', 'Choose meetings from the list.', { addToEventTypeIds: 'Choose meetings from the list.' });
  }
  return [...new Set(value as string[])];
}

const MAX_HOSTS_PER_EVENT = 20;

/**
 * A new co-host joins the listed event types: added to the hosts, a one-host meeting becomes a joint one, a
 * round robin stays one. Pure and idempotent, for updateEventTypes.
 */
export function addHostToEventTypes(
  list: EventType[],
  hostId: string,
  ids: string[],
): { next: EventType[]; result: { changed: EventType[]; notAdded: { id: string; message: string }[] } } | { keep: { changed: EventType[]; notAdded: { id: string; message: string }[] } } {
  const changed: EventType[] = [];
  const notAdded: { id: string; message: string }[] = [];
  const next = [...list];
  for (const id of ids) {
    const at = next.findIndex((e) => e.id === id);
    if (at === -1) {
      notAdded.push({ id, message: 'That meeting no longer exists.' });
      continue;
    }
    const et = next[at];
    if (et.hostIds.includes(hostId)) {
      changed.push(et);
      continue;
    }
    if (et.hostIds.length >= MAX_HOSTS_PER_EVENT) {
      notAdded.push({ id, message: 'That meeting already has 20 hosts.' });
      continue;
    }
    const joined: EventType = { ...et, hostIds: [...et.hostIds, hostId], kind: et.kind === 'solo' ? 'collective' : et.kind };
    next[at] = joined;
    changed.push(joined);
  }
  const touched = next.some((e, i) => e !== list[i]);
  return touched ? { next, result: { changed, notAdded } } : { keep: { changed, notAdded } };
}
