/**
 * External busy time per host: Google Calendar free/busy plus any ICS feeds, merged.
 * Our own bookings are NOT part of this (the slot engine adds them from the booking index).
 * A source that cannot be read makes the result `ok: false`: callers must then treat the
 * host's availability as unknown, never as free.
 *
 * What visitors ask for (GET /public/slots) must never decide how often the calendars are asked.
 * So a cached read covers fixed blocks of time, the same for everyone: BUCKET_DAYS long, counted
 * from 1 January 1970 (UTC). Each block is remembered per host for a minute and the answer is cut
 * out of the blocks that cover the range. However a visitor varies the dates, a host costs at most
 * one Google free/busy read per block a minute, and the number of cache entries per host is
 * bounded by the booking horizon divided by BUCKET_DAYS. On top of that every downloaded feed is
 * kept for a minute whatever range it is read for, so a feed's server sees one request a minute.
 * A `fresh` read (a booking being made or moved) asks the calendars for exactly its range.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { IANAZone } from 'luxon';
import type { Host } from '../../shared/types';
import { hmacHex, open, seal, sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { GoogleApiError, GoogleAuthError, googleFreeBusy, googleGetTimezone } from './google';
import { HttpError } from './http';
import { IcsFeedError, busyFromIcsText, downloadIcsFeed, mergeBusy } from './icsfeed';
import { KEYS, cacheGet, cacheSet, updateHost } from './repo';
import type { Interval } from './time';

export interface HostBusy {
  hostId: string;
  busy: Interval[];
  ok: boolean;
  error?: string;
}

const ICS_URL_PURPOSE = 'ics-url';
const FEED_TEXT_PURPOSE = 'ics-feed-text';
const FEED_KEY_PURPOSE = 'ics-feed-cache';
const CACHE_TTL_SEC = 60;
/** Failures are remembered only briefly: long enough to spare a struggling provider, short enough to recover quickly. */
const FAILURE_CACHE_TTL_SEC = 15;
const MAX_ERROR_LENGTH = 200;
const DAY_MS = 86_400_000;
/** Length of the fixed blocks external busy time is read and cached in. A 62 day range touches at most four. */
export const BUCKET_DAYS = 31;
const BUCKET_MS = BUCKET_DAYS * DAY_MS;
/** A downloaded feed larger than this once compressed and sealed is not kept (it is read again next time). */
const MAX_CACHED_FEED_CHARS = 4_000_000;

interface CachedBusy {
  /** [start, end] pairs */
  b: [number, number][];
  ok: boolean;
  e?: string;
}

/** A downloaded feed (sealed, gzip, base64) and when it was downloaded, or why it could not be. */
interface CachedFeed {
  t?: string;
  at?: number;
  e?: string;
}

function isCachedBusy(v: unknown): v is CachedBusy {
  return !!v && typeof v === 'object' && Array.isArray((v as CachedBusy).b) && typeof (v as CachedBusy).ok === 'boolean';
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

function clip(list: Interval[], range: Interval): Interval[] {
  const out: Interval[] = [];
  for (const iv of list) {
    const start = Math.max(iv.start, range.start);
    const end = Math.min(iv.end, range.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

function logStorage(ctx: Ctx, what: string, hostId: string, err: unknown): void {
  ctx.log('warn', `busy: could not ${what}`, { hostId, error: err instanceof Error ? err.name : 'unknown' });
}

// ───────────────────────── downloaded feeds, kept for a minute ─────────────────────────

/** Per host and feed address; the address itself never appears in a key. Under busy-<host>- so forgetHostBusy drops it too. */
function feedCacheName(ctx: Ctx, hostId: string, url: string): string {
  return `busy-${hostId}-feed-${hmacHex(ctx, FEED_KEY_PURPOSE, url).slice(0, 24)}`;
}

/** A feed's text is private (event names, guests): it is kept compressed and sealed. */
function packFeed(ctx: Ctx, text: string): string | null {
  const packed = seal(ctx, FEED_TEXT_PURPOSE, gzipSync(Buffer.from(text, 'utf8')).toString('base64'));
  return packed.length <= MAX_CACHED_FEED_CHARS ? packed : null;
}

function unpackFeed(ctx: Ctx, packed: string): string | null {
  try {
    const inner = open(ctx, FEED_TEXT_PURPOSE, packed);
    return inner === null ? null : gunzipSync(Buffer.from(inner, 'base64')).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The text of a feed and how many seconds old it is: the copy downloaded in the last minute (or
 * the failure of the last 15 seconds), unless `fresh`. A new download replaces the kept copy.
 */
async function feedText(ctx: Ctx, hostId: string, url: string, fresh: boolean): Promise<{ text: string; ageSec: number }> {
  const name = feedCacheName(ctx, hostId, url);
  if (!fresh) {
    // A storage hiccup here only costs a download.
    const kept = await cacheGet<CachedFeed>(ctx, name).catch(() => null);
    if (kept && typeof kept.e === 'string') throw new IcsFeedError(kept.e);
    const text = kept && typeof kept.t === 'string' ? unpackFeed(ctx, kept.t) : null;
    if (text !== null) {
      const ageSec = typeof kept?.at === 'number' ? Math.round((ctx.now().getTime() - kept.at) / 1000) : CACHE_TTL_SEC;
      return { text, ageSec: Math.min(CACHE_TTL_SEC, Math.max(0, ageSec)) };
    }
  }
  let text: string;
  try {
    text = await downloadIcsFeed(ctx, url);
  } catch (err) {
    // Only failures of the feed itself are worth remembering; a refused address never reaches the network.
    if (err instanceof IcsFeedError) await cacheSet(ctx, name, { e: err.message } satisfies CachedFeed, FAILURE_CACHE_TTL_SEC).catch((e: unknown) => logStorage(ctx, 'remember a feed failure', hostId, e));
    throw err;
  }
  try {
    const packed = packFeed(ctx, text);
    if (packed !== null) await cacheSet(ctx, name, { t: packed, at: ctx.now().getTime() } satisfies CachedFeed, CACHE_TTL_SEC);
  } catch (err) {
    logStorage(ctx, 'keep the downloaded feed', hostId, err);
  }
  return { text, ageSec: 0 };
}

// ───────────────────────── reading the calendars ─────────────────────────

/** Every source of one host over `range`. `ageSec`: the age of the oldest kept feed copy that went into it. */
async function loadSources(ctx: Ctx, host: Host, range: Interval, fresh: boolean): Promise<{ result: HostBusy; ageSec: number }> {
  const problems: string[] = [];
  const tasks: Promise<Interval[]>[] = [];
  let ageSec = 0;

  if (host.google) {
    tasks.push(
      googleFreeBusy(ctx, host, range).catch((err: unknown) => {
        problems.push(googleProblem(err));
        return [];
      }),
    );
  }
  const hostZone = IANAZone.isValidZone(host.timezone) ? host.timezone : 'UTC';
  for (const feed of host.icsFeeds ?? []) {
    const url = open(ctx, ICS_URL_PURPOSE, feed.urlEnc);
    if (url === null) {
      problems.push(`${label(feed.label)} needs to be added again.`);
      continue;
    }
    tasks.push(
      feedText(ctx, host.id, url, fresh)
        .then((got) => {
          ageSec = Math.max(ageSec, got.ageSec);
          return busyFromIcsText(ctx, got.text, range, { timezone: hostZone });
        })
        .catch((err: unknown) => {
          problems.push(feedProblem(feed.label, err));
          return [];
        }),
    );
  }

  const busy = mergeBusy((await Promise.all(tasks)).flat());
  if (problems.length === 0) return { result: { hostId: host.id, busy, ok: true }, ageSec };
  return { result: { hostId: host.id, busy, ok: false, error: problems.join(' ').slice(0, MAX_ERROR_LENGTH) }, ageSec };
}

/** Above this many blocks (about two years) a range is read straight from the calendars, without the cache. */
const MAX_CACHED_BUCKETS = 24;

/** A cached read: the fixed blocks that cover `range`, from the cache where it has them, the rest read in one go. */
async function readBuckets(ctx: Ctx, host: Host, range: Interval): Promise<HostBusy> {
  const first = Math.floor(range.start / BUCKET_MS);
  const last = Math.floor((range.end - 1) / BUCKET_MS);
  if (last - first + 1 > MAX_CACHED_BUCKETS) {
    const { result } = await loadSources(ctx, host, range, false);
    await recordHealth(ctx, host, result.ok, result.error);
    return result;
  }

  const fingerprint = sourceFingerprint(host);
  const blocks: { index: number; name: string; part: CachedBusy | null }[] = [];
  for (let index = first; index <= last; index++) blocks.push({ index, name: `busy-${host.id}-b${index}-${fingerprint}`, part: null });
  const stored = await Promise.all(blocks.map((b) => cacheGet<CachedBusy>(ctx, b.name)));
  blocks.forEach((b, k) => {
    b.part = isCachedBusy(stored[k]) ? stored[k] : null;
  });

  const missing = blocks.filter((b) => b.part === null);
  if (missing.length > 0) {
    const span: Interval = { start: missing[0].index * BUCKET_MS, end: (missing[missing.length - 1].index + 1) * BUCKET_MS };
    const { result, ageSec } = await loadSources(ctx, host, span, false);
    // A block built from a kept feed copy expires with that copy, so no answer is ever older than a minute.
    const ttl = result.ok ? Math.max(FAILURE_CACHE_TTL_SEC, CACHE_TTL_SEC - ageSec) : FAILURE_CACHE_TTL_SEC;
    await Promise.all(
      missing.map(async (b) => {
        const record: CachedBusy = { b: clip(result.busy, { start: b.index * BUCKET_MS, end: (b.index + 1) * BUCKET_MS }).map((iv) => [iv.start, iv.end]), ok: result.ok };
        if (result.error) record.e = result.error;
        b.part = record;
        try {
          await cacheSet(ctx, b.name, record, ttl);
        } catch (err) {
          logStorage(ctx, 'cache the result', host.id, err);
        }
      }),
    );
    await recordHealth(ctx, host, result.ok, result.error);
  }

  const failed = blocks.find((b) => b.part && !b.part.ok)?.part;
  const busy = clip(mergeBusy(blocks.flatMap((b) => (b.part?.b ?? []).map(([start, end]) => ({ start, end })))), range);
  const answer: HostBusy = { hostId: host.id, busy, ok: !failed };
  if (failed) answer.error = failed.e ?? 'Calendar could not be read.';
  return answer;
}

/**
 * Busy intervals of one host inside `range`, from every connected calendar. Never throws.
 * Cached: read in fixed blocks (BUCKET_DAYS) per host and calendar setup, each kept for a minute.
 * `fresh`: asked of the calendars for exactly this range, past the cache (a downloaded feed it
 * reads replaces the kept copy, the cached blocks are left alone).
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
    if (!opts?.fresh) return await readBuckets(ctx, host, range);

    const { result } = await loadSources(ctx, host, range, true);
    await recordHealth(ctx, host, result.ok, result.error);
    return result;
  } catch (err) {
    ctx.log('error', 'busy: unexpected failure', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    return { hostId: host.id, busy: [], ok: false, error: 'Calendar could not be read.' };
  }
}

/**
 * Forgets what is remembered about these hosts' calendars (every cached block and every kept
 * feed), so the next question goes to the calendars themselves. For the moment a time that was
 * offered turns out to be taken on a host's own calendar: the list it came from is out of date,
 * and offering it again would only earn the next visitor (or the same one) the same refusal.
 * Never throws.
 */
export async function forgetHostBusy(ctx: Ctx, hostIds: string[]): Promise<void> {
  try {
    for (const id of new Set(hostIds)) {
      if (typeof id !== 'string' || id === '') continue;
      const keys = await ctx.kv.list(`${KEYS.cachePrefix}busy-${id}-`);
      await Promise.all(keys.map((key) => ctx.kv.delete(key)));
    }
  } catch (err) {
    ctx.log('warn', 'busy: could not drop the remembered busy time', { error: err instanceof Error ? err.name : 'unknown' });
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
