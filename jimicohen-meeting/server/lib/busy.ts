/**
 * External busy time per host: Google Calendar free/busy plus any ICS feeds, merged.
 * Our own bookings are NOT part of this (the slot engine adds them from the booking index).
 * A source that cannot be read makes the result `ok: false`: callers must then treat the
 * host's availability as unknown, never as free.
 */
import { IANAZone } from 'luxon';
import type { Host } from '../../shared/types';
import { open, sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { GoogleApiError, GoogleAuthError, googleFreeBusy, googleGetTimezone } from './google';
import { HttpError } from './http';
import { IcsFeedError, fetchIcsBusy, mergeBusy } from './icsfeed';
import { cacheGet, cacheSet, updateHost } from './repo';
import type { Interval } from './time';

export interface HostBusy {
  hostId: string;
  busy: Interval[];
  ok: boolean;
  error?: string;
}

const ICS_URL_PURPOSE = 'ics-url';
const CACHE_TTL_SEC = 60;
/** Failures are remembered only briefly: long enough to spare a struggling provider, short enough to recover quickly. */
const FAILURE_CACHE_TTL_SEC = 15;
const MAX_ERROR_LENGTH = 200;

interface CachedBusy {
  /** [start, end] pairs */
  b: [number, number][];
  ok: boolean;
  e?: string;
}

function label(text: string): string {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u001F\u007F"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return clean === '' ? 'Calendar feed' : `Calendar feed "${clean}"`;
}

function googleProblem(err: unknown): string {
  // Both classes only carry messages written in google.ts: no tokens, no response bodies.
  if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return err.message;
  return 'Google Calendar could not be read.';
}

function feedProblem(name: string, err: unknown): string {
  // Only messages written by us are passed on; anything else might quote the feed address.
  if (err instanceof IcsFeedError || err instanceof HttpError) return `${label(name)}: ${err.message}`;
  return `${label(name)} could not be read.`;
}

/** Changes whenever the set of calendars behind a host changes, so a stale cache entry is never served for a new setup. */
function sourceFingerprint(host: Host): string {
  const google = host.google ? [host.google.email, host.google.status, [...host.google.busyCalendarIds].sort(), sha256Hex(host.google.refreshTokenEnc).slice(0, 8)] : null;
  const feeds = (host.icsFeeds ?? []).map((f) => [f.id, sha256Hex(f.urlEnc).slice(0, 8)]);
  return sha256Hex(JSON.stringify([google, feeds, host.timezone])).slice(0, 16);
}

function hasSources(host: Host): boolean {
  return !!host.google || (Array.isArray(host.icsFeeds) && host.icsFeeds.length > 0);
}

/** Writes host.calendarHealth, but only when the verdict (or its message) differs from what is stored. */
async function recordHealth(ctx: Ctx, host: Host, ok: boolean, message?: string): Promise<void> {
  const current = host.calendarHealth ?? null;
  if (current && current.ok === ok && (current.message ?? '') === (message ?? '')) return;
  try {
    const at = ctx.now().toISOString();
    await updateHost(ctx, host.id, (h) => ({ ...h, calendarHealth: message ? { ok, message, at } : { ok, at } }));
  } catch (err) {
    ctx.log('warn', 'busy: could not save the calendar health', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
  }
}

async function clearHealth(ctx: Ctx, host: Host): Promise<void> {
  if (!host.calendarHealth || host.calendarHealth.ok) return;
  try {
    await updateHost(ctx, host.id, (h) => ({ ...h, calendarHealth: null }));
  } catch (err) {
    ctx.log('warn', 'busy: could not clear the calendar health', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
  }
}

async function loadSources(ctx: Ctx, host: Host, range: Interval): Promise<HostBusy> {
  const problems: string[] = [];
  const tasks: Promise<Interval[]>[] = [];

  if (host.google) {
    tasks.push(
      googleFreeBusy(ctx, host, range).catch((err: unknown) => {
        problems.push(googleProblem(err));
        return [];
      }),
    );
  }
  const allDayZone = IANAZone.isValidZone(host.timezone) ? host.timezone : 'UTC';
  for (const feed of host.icsFeeds ?? []) {
    const url = open(ctx, ICS_URL_PURPOSE, feed.urlEnc);
    if (url === null) {
      problems.push(`${label(feed.label)} needs to be added again.`);
      continue;
    }
    tasks.push(
      fetchIcsBusy(ctx, url, range, { timezone: allDayZone }).catch((err: unknown) => {
        problems.push(feedProblem(feed.label, err));
        return [];
      }),
    );
  }

  const busy = mergeBusy((await Promise.all(tasks)).flat());
  if (problems.length === 0) return { hostId: host.id, busy, ok: true };
  return { hostId: host.id, busy, ok: false, error: problems.join(' ').slice(0, MAX_ERROR_LENGTH) };
}

/**
 * Busy intervals of one host inside `range`, from every connected calendar.
 * Cached for a minute per host, range and calendar setup; `fresh` bypasses the cache (and refills it).
 * Never throws.
 */
export async function getHostBusy(ctx: Ctx, host: Host, range: Interval, opts?: { fresh?: boolean }): Promise<HostBusy> {
  try {
    if (!hasSources(host)) {
      await clearHealth(ctx, host);
      return { hostId: host.id, busy: [], ok: true };
    }
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
      return { hostId: host.id, busy: [], ok: true };
    }

    const cacheName = `busy-${host.id}-${range.start}-${range.end}-${sourceFingerprint(host)}`;
    if (!opts?.fresh) {
      const cached = await cacheGet<CachedBusy>(ctx, cacheName);
      if (cached && Array.isArray(cached.b) && typeof cached.ok === 'boolean') {
        const hit: HostBusy = { hostId: host.id, busy: cached.b.map(([start, end]) => ({ start, end })), ok: cached.ok };
        if (!cached.ok) hit.error = cached.e ?? 'Calendar could not be read.';
        return hit;
      }
    }

    const result = await loadSources(ctx, host, range);
    const record: CachedBusy = { b: result.busy.map((iv) => [iv.start, iv.end]), ok: result.ok };
    if (result.error) record.e = result.error;
    try {
      await cacheSet(ctx, cacheName, record, result.ok ? CACHE_TTL_SEC : FAILURE_CACHE_TTL_SEC);
    } catch (err) {
      ctx.log('warn', 'busy: could not cache the result', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    }
    await recordHealth(ctx, host, result.ok, result.error);
    return result;
  } catch (err) {
    ctx.log('error', 'busy: unexpected failure', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    return { hostId: host.id, busy: [], ok: false, error: 'Calendar could not be read.' };
  }
}

/** One entry per host, in the order given. */
export async function getBusyForHosts(ctx: Ctx, hosts: Host[], range: Interval, opts?: { fresh?: boolean }): Promise<HostBusy[]> {
  return Promise.all(hosts.map((host) => getHostBusy(ctx, host, range, opts)));
}

/**
 * For hosts who follow their Google Calendar zone: reads the zone from Google and saves it when
 * it changed. Returns the host as it is now. A failed lookup leaves everything as it was.
 */
export async function syncHostTimezone(ctx: Ctx, host: Host): Promise<Host> {
  if (host.timezoneMode !== 'google' || !host.google || host.google.status !== 'ok') return host;
  try {
    const zone = await googleGetTimezone(ctx, host);
    if (!zone || zone === host.timezone || !IANAZone.isValidZone(zone)) return host;
    const saved = await updateHost(ctx, host.id, (h) => (h.timezoneMode === 'google' ? { ...h, timezone: zone } : h));
    return saved ?? host;
  } catch (err) {
    ctx.log('warn', 'busy: could not read the Google Calendar time zone', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    return host;
  }
}
