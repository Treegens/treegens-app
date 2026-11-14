/**
 * Team members: adding a co-host with a private self-service link, rotating that link, and the
 * one update routine behind both PUT /admin/hosts/:id (the owner edits anyone) and
 * PUT /host/:id (a co-host edits themselves through their link).
 *
 * The private link carries a random token. Only its SHA-256 is stored (see hostFromToken in
 * auth.ts), so the link can be shown exactly once: when it is made.
 */
import { defaultSchedule } from '../../../shared/defaults';
import type { GoogleCalendarListItem, Host, IcsFeed, Schedule } from '../../../shared/types';
import { syncHostTimezone } from '../busy';
import { open, randomId, randomToken, seal, sha256Hex } from '../crypto';
import type { Ctx } from '../ctx';
import { GoogleAuthError, googleListCalendars } from '../google';
import { HttpError } from '../http';
import { assertSafeFeedUrl } from '../icsfeed';
import { listHosts, saveHost, updateHost } from '../repo';
import { normalizePhone } from '../twilio';
import { cleanLine, FieldErrors, isEmail, isPlainObject, isZone, requireObject } from '../validate';
import { type AssetRef, type Bag, given, readAssetId, readEnum, readText, verifyAssets } from './fields';
import { parseSchedules } from './schedules';

export const MAX_HOSTS = 25;
export const MAX_ICS_FEEDS = 5;
const MAX_CALENDARS = 50;
const ICS_URL_PURPOSE = 'ics-url';
const GENERIC_FEED_LABEL = 'Calendar feed';

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'That person is no longer on the team.');
}

// ───────────────────────── private links ─────────────────────────

export function inviteUrlFor(ctx: Ctx, hostId: string, token: string): string {
  return `${ctx.env.publicBaseUrl}/host/${encodeURIComponent(hostId)}?t=${encodeURIComponent(token)}`;
}

function newInvite(): { token: string; hash: string } {
  const token = randomToken(24);
  return { token, hash: sha256Hex(token) };
}

/** POST /admin/hosts: a new co-host. The link in the answer is the only time the token is visible. */
export async function createCoHost(ctx: Ctx, body: unknown): Promise<{ host: Host; inviteUrl: string }> {
  const b = requireObject(body);
  const errors = new FieldErrors();
  const hosts = await listHosts(ctx);

  const name = readText(b, 'name', 'name', 80, errors, { required: 'Please enter their name.' });
  if (name === undefined) errors.add('name', 'Please enter their name.');
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!isEmail(email)) errors.add('email', 'Please enter a full email address.');
  else if (hosts.some((h) => h.email.toLowerCase() === email.toLowerCase())) errors.add('email', 'Someone with this email is already on the team.');
  errors.throwIfAny();
  if (hosts.length >= MAX_HOSTS) throw new HttpError(409, 'too_many_hosts', `A team can have up to ${MAX_HOSTS} people.`);

  const owner = hosts.find((h) => h.role === 'owner');
  const now = ctx.now().toISOString();
  const invite = newInvite();
  const schedule = defaultSchedule();
  const host: Host = {
    id: randomId('host'),
    role: 'member',
    name: name ?? '',
    email,
    title: '',
    avatarAssetId: null,
    // A sensible start. It follows their own device from the first time they open their link.
    timezone: owner?.timezone ?? 'UTC',
    timezoneMode: 'device',
    schedules: [schedule],
    defaultScheduleId: schedule.id,
    google: null,
    icsFeeds: [],
    inviteTokenHash: invite.hash,
    notify: { email: true, sms: false },
    calendarHealth: null,
    createdAt: now,
    updatedAt: now,
  };
  const saved = await saveHost(ctx, host);
  return { host: saved, inviteUrl: inviteUrlFor(ctx, saved.id, invite.token) };
}

/** POST /admin/hosts/:id/invite: a fresh link. The old one stops working the moment this is saved. */
export async function rotateInvite(ctx: Ctx, hostId: string): Promise<{ host: Host; inviteUrl: string }> {
  const invite = newInvite();
  const saved = await updateHost(ctx, hostId, (h) => {
    if (h.role === 'owner') throw new HttpError(400, 'owner_uses_dashboard', 'The owner manages everything from the dashboard and does not need a private link.');
    return { ...h, inviteTokenHash: invite.hash };
  });
  if (!saved) throw notFound();
  return { host: saved, inviteUrl: inviteUrlFor(ctx, saved.id, invite.token) };
}

// ───────────────────────── calendar feeds ─────────────────────────

/**
 * What a feed is called on screen. The address itself is never shown again, so a feed without a
 * name of its own gets the host name of its address: enough to tell two feeds apart, and not a secret.
 */
function feedLabel(raw: unknown, url: URL): string {
  const label = cleanLine(raw, 60);
  const looksLikeAddress = /:\/\/|^webcals?:|\.ics(\?|$)/i.test(label);
  if (label === '' || looksLikeAddress || label.toLowerCase() === GENERIC_FEED_LABEL.toLowerCase()) return `${GENERIC_FEED_LABEL} (${url.hostname})`.slice(0, 80);
  return label;
}

function prepareFeed(ctx: Ctx, host: Host, value: unknown, errors: FieldErrors): IcsFeed | null {
  if (!isPlainObject(value)) {
    errors.add('addIcsFeed.url', 'Paste the address of the calendar feed.');
    return null;
  }
  if ((host.icsFeeds ?? []).length >= MAX_ICS_FEEDS) {
    errors.add('addIcsFeed.url', `You can link up to ${MAX_ICS_FEEDS} calendar feeds. Remove one first.`);
    return null;
  }
  let url: URL;
  try {
    url = assertSafeFeedUrl(typeof value.url === 'string' ? value.url : '');
  } catch (err) {
    errors.add('addIcsFeed.url', err instanceof HttpError ? err.message : 'That does not look like a calendar address.');
    return null;
  }
  const href = url.href;
  if ((host.icsFeeds ?? []).some((feed) => open(ctx, ICS_URL_PURPOSE, feed.urlEnc) === href)) {
    errors.add('addIcsFeed.url', 'That calendar is already linked.');
    return null;
  }
  return { id: randomId('ics'), label: feedLabel(value.label, url), urlEnc: seal(ctx, ICS_URL_PURPOSE, href) };
}

// ───────────────────────── updates ─────────────────────────

function readCalendarIds(value: unknown, errors: FieldErrors): string[] | null {
  const ok = Array.isArray(value) && value.length <= MAX_CALENDARS && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001F\u007F]/.test(id));
  if (!ok) {
    errors.add('busyCalendarIds', 'The calendar choice is not readable. Reload the page and try again.');
    return null;
  }
  return [...new Set(value as string[])];
}

export interface HostUpdateResult {
  host: Host;
  /** true when this update moved the host to another time zone */
  timezoneChanged: boolean;
}

/**
 * Applies a HostUpdate. With `self` (the co-host's own link) the email address, the role and
 * the picture cannot be changed: only the owner decides who is on the team and how they are
 * contacted. Throws HttpError(422) with every invalid field.
 */
export async function applyHostUpdate(ctx: Ctx, host: Host, body: unknown, opts: { self: boolean }): Promise<HostUpdateResult> {
  const u: Bag = requireObject(body);
  const errors = new FieldErrors();
  const refs: AssetRef[] = [];

  const name = readText(u, 'name', 'name', 80, errors, { required: 'Please enter a name.' });
  const title = readText(u, 'title', 'title', 80, errors);

  let email: string | undefined;
  if (!opts.self && given(u, 'email')) {
    const value = typeof u.email === 'string' ? u.email.trim() : '';
    if (!isEmail(value)) errors.add('email', 'Please enter a full email address.');
    else if (value.toLowerCase() !== host.email.toLowerCase() && (await listHosts(ctx)).some((h) => h.id !== host.id && h.email.toLowerCase() === value.toLowerCase())) {
      errors.add('email', 'Someone with this email is already on the team.');
    } else email = value;
  }

  let avatar: string | null | undefined;
  if (opts.self) {
    if (given(u, 'avatarAssetId') && (u.avatarAssetId === null || u.avatarAssetId === '')) avatar = null;
  } else {
    avatar = readAssetId(u, 'avatarAssetId', 'avatarAssetId', host.avatarAssetId, refs, errors);
  }

  /** undefined = untouched, null = removed */
  let phone: string | null | undefined;
  if (given(u, 'phone')) {
    const raw = typeof u.phone === 'string' ? u.phone.trim() : null;
    if (raw === '') phone = null;
    else {
      const normalized = raw === null ? null : normalizePhone(raw);
      if (normalized) phone = normalized;
      else errors.add('phone', 'Use the international format, for example +14155550123.');
    }
  }

  const mode = readEnum(u, 'timezoneMode', 'timezoneMode', ['google', 'device', 'fixed'] as const, errors);
  if (mode === 'google' && !host.google) errors.add('timezoneMode', 'Connect Google Calendar first to follow its time zone.');
  let zone: string | undefined;
  if (given(u, 'timezone')) {
    if (isZone(u.timezone)) zone = u.timezone as string;
    else errors.add('timezone', 'That time zone is not known. Please choose one from the list.');
  }
  // Sent automatically by the page on every visit. A value we cannot use is simply not applied.
  const deviceZone = isZone(u.deviceTimezone) ? (u.deviceTimezone as string) : undefined;

  let schedules: Schedule[] | undefined;
  if (given(u, 'schedules')) schedules = parseSchedules(u.schedules, errors) ?? undefined;
  let defaultScheduleId: string | undefined;
  if (given(u, 'defaultScheduleId')) {
    const pool = schedules ?? (given(u, 'schedules') ? [] : host.schedules);
    if (typeof u.defaultScheduleId === 'string' && pool.some((s) => s.id === u.defaultScheduleId)) defaultScheduleId = u.defaultScheduleId;
    else if (!errors.has()) errors.add('defaultScheduleId', 'Choose which schedule is the default.');
  }

  let notify: Host['notify'] | undefined;
  if (given(u, 'notify')) {
    const n = u.notify;
    const usable = isPlainObject(n) && (n.email === undefined || typeof n.email === 'boolean') && (n.sms === undefined || typeof n.sms === 'boolean');
    if (!usable) errors.add('notify', 'The notification choice is not readable.');
    else notify = { email: typeof n.email === 'boolean' ? n.email : host.notify?.email !== false, sms: typeof n.sms === 'boolean' ? n.sms : host.notify?.sms === true };
  }

  let busyCalendarIds: string[] | undefined;
  let writeCalendarId: string | undefined;
  if (given(u, 'busyCalendarIds') || given(u, 'writeCalendarId')) {
    if (!host.google) errors.add(given(u, 'busyCalendarIds') ? 'busyCalendarIds' : 'writeCalendarId', 'Connect Google Calendar first.');
    else {
      if (given(u, 'busyCalendarIds')) busyCalendarIds = readCalendarIds(u.busyCalendarIds, errors) ?? undefined;
      if (given(u, 'writeCalendarId')) {
        const id = u.writeCalendarId;
        if (typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001F\u007F]/.test(id)) writeCalendarId = id;
        else errors.add('writeCalendarId', 'Choose the calendar new meetings are added to.');
      }
    }
  }

  const newFeed = given(u, 'addIcsFeed') ? prepareFeed(ctx, host, u.addIcsFeed, errors) : null;
  const removeFeedId = typeof u.removeIcsFeedId === 'string' && u.removeIcsFeedId !== '' ? u.removeIcsFeedId : undefined;

  await verifyAssets(ctx, refs, errors);
  errors.throwIfAny();

  // Pure: the store may run it again on a fresher copy when two saves meet.
  const apply = (h: Host): Host => {
    const next: Host = { ...h };
    if (name !== undefined) next.name = name;
    if (title !== undefined) next.title = title;
    if (email !== undefined) next.email = email;
    if (avatar !== undefined) next.avatarAssetId = avatar;
    if (phone === null) delete next.phone;
    else if (phone !== undefined) next.phone = phone;
    if (mode !== undefined) next.timezoneMode = mode;
    if (zone !== undefined) next.timezone = zone;
    if (next.timezoneMode === 'device' && deviceZone !== undefined) next.timezone = deviceZone;
    if (schedules !== undefined) next.schedules = schedules;
    if (defaultScheduleId !== undefined) next.defaultScheduleId = defaultScheduleId;
    if (!next.schedules.some((s) => s.id === next.defaultScheduleId) && next.schedules.length > 0) next.defaultScheduleId = next.schedules[0].id;
    if (notify !== undefined) next.notify = notify;
    let sourcesChanged = false;
    if (h.google && (busyCalendarIds !== undefined || writeCalendarId !== undefined)) {
      next.google = { ...h.google, ...(busyCalendarIds !== undefined ? { busyCalendarIds } : {}), ...(writeCalendarId !== undefined ? { writeCalendarId } : {}) };
      sourcesChanged = busyCalendarIds !== undefined;
    }
    if (newFeed && (h.icsFeeds ?? []).length < MAX_ICS_FEEDS) {
      next.icsFeeds = [...(h.icsFeeds ?? []), newFeed];
      sourcesChanged = true;
    }
    if (removeFeedId !== undefined && (next.icsFeeds ?? []).some((f) => f.id === removeFeedId)) {
      next.icsFeeds = (next.icsFeeds ?? []).filter((f) => f.id !== removeFeedId);
      sourcesChanged = true;
    }
    // A verdict about calendars that are no longer the ones in use would only mislead. The next availability check writes a new one.
    if (sourcesChanged) next.calendarHealth = null;
    return next;
  };

  // The dashboard reports the device's zone on every load. Most of the time nothing changes: skip the write then.
  let saved: Host = host;
  if (JSON.stringify(apply(structuredClone(host))) !== JSON.stringify(host)) {
    const written = await updateHost(ctx, host.id, apply);
    if (!written) throw notFound();
    saved = written;
  }
  // Just switched to "follow Google Calendar": read the zone now, so the answer already shows it.
  if (mode === 'google' && saved.timezoneMode === 'google') saved = await syncHostTimezone(ctx, saved);
  return { host: saved, timezoneChanged: saved.timezone !== host.timezone };
}

// ───────────────────────── Google calendars ─────────────────────────

/** The host's Google calendars, or an HttpError that says what to do. */
export async function loadCalendars(ctx: Ctx, host: Host): Promise<GoogleCalendarListItem[]> {
  if (!host.google) throw new HttpError(409, 'google_not_connected', 'Connect Google Calendar first.');
  if (host.google.status === 'needs_reconnect') throw new HttpError(409, 'google_needs_reconnect', 'Google Calendar needs to be reconnected before the calendars can be listed.');
  try {
    return await googleListCalendars(ctx, host);
  } catch (err) {
    if (err instanceof GoogleAuthError) throw new HttpError(409, 'google_needs_reconnect', err.message);
    ctx.log('warn', 'hosts: could not list Google calendars', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    throw new HttpError(502, 'google_unavailable', 'Google Calendar could not be reached just now. Please try again in a moment.');
  }
}

