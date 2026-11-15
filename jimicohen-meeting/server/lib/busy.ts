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
import { accountsOf, findAccount, mainOf, writeAccount, type AccountRef } from './googleAccounts';
import { HttpError } from './http';
import { IcsFeedError, busyFromIcsText, downloadIcsFeed, mergeBusy } from './icsfeed';
import { KEYS, cacheGet, cacheSet, updateHost } from './repo';
import type { Interval } from './time';

/** One source of a host that could not be read: a Google account, or the calendar feeds together. */
export interface BusyProblem {
  /** the account id, or "feeds" */
  key: string;
  /** what to call it in messages: the account's address, or "calendar feeds" */
  label: string;
  message: string;
  accountId?: string;
}

export interface HostBusy {
  hostId: string;
  busy: Interval[];
  ok: boolean;
  /** every problem in one line, each naming its account */
  error?: string;
  /** one entry per source that could not be read (empty when ok) */
  problems?: BusyProblem[];
}

export interface BusyReadOptions {
  fresh?: boolean;
  /**
   * The sources still being read: a source adds its label when it starts and takes it out when it is done.
   * A caller that stops waiting can say which account was slow.
   */
  pending?: Set<string>;
}

/** The key of the calendar feeds of a host, as one source. */
export const FEEDS_SOURCE = 'feeds';

const ICS_URL_PURPOSE = 'ics-url';
const FEED_TEXT_PURPOSE = 'ics-feed-text';
const FEED_KEY_PURPOSE = 'ics-feed-cache';
const CACHE_TTL_SEC = 60;
/** Failures are remembered only briefly: long enough to spare a struggling provider, short enough to recover quickly. */
const FAILURE_CACHE_TTL_SEC = 15;
const MAX_ERROR_LENGTH = 400;
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
  /** one entry per source that failed: key, label, message. A cached failure still names the account. */
  p?: { k: string; l: string; m: string }[];
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

/**
 * Changes whenever the set of calendars behind a host changes (any account, its calendars, its grant, any
 * feed), so a stale cache entry is never served for a new setup. One fingerprint per host: a times list
 * costs one storage read per block and host, however many accounts the host has.
 */
function sourceFingerprint(host: Host): string {
  const accounts = accountsOf(host).map(({ account: a }) => [a.id, a.email, a.status, [...a.busyCalendarIds].sort(), sha256Hex(String(a.refreshTokenEnc ?? '')).slice(0, 8)]);
  const feeds = (host.icsFeeds ?? []).map((f) => [f.id, sha256Hex(f.urlEnc).slice(0, 8)]);
  return sha256Hex(JSON.stringify([accounts, feeds, host.timezone])).slice(0, 16);
}

function hasSources(host: Host): boolean {
  return accountsOf(host).length > 0 || (Array.isArray(host.icsFeeds) && host.icsFeeds.length > 0);
}

function sameHealth(a: { ok: boolean; message?: string } | null | undefined, ok: boolean, message?: string): boolean {
  return !!a && a.ok === ok && (a.message ?? '') === (message ?? '');
}

/**
 * Writes host.calendarHealth (the whole host) and each account's own health, in one write per host, and
 * only when something differs from what is stored. `accounts`: the verdict of each account that was read
 * (an account removed meanwhile is left alone).
 */
async function recordHealth(ctx: Ctx, host: Host, ok: boolean, message?: string, accounts?: Map<string, { ok: boolean; message?: string }>): Promise<void> {
  const accountChanged = [...(accounts ?? new Map()).entries()].some(([id, verdict]) => {
    const ref = findAccount(host, { id });
    return !!ref && !sameHealth(ref.account.health, verdict.ok, verdict.message);
  });
  if (sameHealth(host.calendarHealth, ok, message) && !accountChanged) return;
  try {
    const at = ctx.now().toISOString();
    await updateHost(ctx, host.id, (h) => {
      let next: Host = { ...h, calendarHealth: message ? { ok, message, at } : { ok, at } };
      for (const [id, verdict] of accounts ?? new Map<string, { ok: boolean; message?: string }>()) {
        const ref = findAccount(next, { id });
        if (!ref || sameHealth(ref.account.health, verdict.ok, verdict.message)) continue;
        // Only the field changes; everything else of the stored entry stays as it was.
        if (ref.main && next.google) next = { ...next, google: { ...next.google, ...(next.google.id ? {} : { id }), health: verdict.message ? { ok: verdict.ok, message: verdict.message, at } : { ok: verdict.ok, at } } };
        else next = writeAccount(next, id, (a) => ({ ...a, health: verdict.message ? { ok: verdict.ok, message: verdict.message, at } : { ok: verdict.ok, at } }));
      }
      return next;
    });
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

interface LoadedSources {
  result: HostBusy;
  /** the age of the oldest kept feed copy that went into it */
  ageSec: number;
  /** the verdict of each Google account that was read */
  accounts: Map<string, { ok: boolean; message?: string }>;
}

/** One line naming every problem: "jimi@work.example: Google Calendar needs to be reconnected." */
function problemLine(problems: BusyProblem[]): string {
  return problems
    .map((p) => (p.accountId ? `${p.label}: ${p.message}` : p.message))
    .join(' ')
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * Every source of one host over `range`, all at once: each Google account with its own token and
 * calendars, and the calendar feeds. The wait is the slowest source, not the sum.
 */
async function loadSources(ctx: Ctx, host: Host, range: Interval, fresh: boolean, pending?: Set<string>): Promise<LoadedSources> {
  const problems: BusyProblem[] = [];
  const accounts = new Map<string, { ok: boolean; message?: string }>();
  const tasks: Promise<Interval[]>[] = [];
  let ageSec = 0;

  const track = <T>(label: string, work: () => Promise<T>): Promise<T> => {
    pending?.add(label);
    return work().finally(() => pending?.delete(label));
  };

  for (const ref of accountsOf(host)) {
    const { id, email } = ref.account;
    tasks.push(
      track(email, () => googleFreeBusy(ctx, ref, range)).then(
        (busy) => {
          accounts.set(id, { ok: true });
          return busy;
        },
        (err: unknown) => {
          const message = googleProblem(err);
          problems.push({ key: id, label: email, message, accountId: id });
          accounts.set(id, { ok: false, message });
          return [];
        },
      ),
    );
  }

  const hostZone = IANAZone.isValidZone(host.timezone) ? host.timezone : 'UTC';
  const feedProblems: string[] = [];
  const feedTasks: Promise<Interval[]>[] = [];
  for (const feed of host.icsFeeds ?? []) {
    const url = open(ctx, ICS_URL_PURPOSE, feed.urlEnc);
    if (url === null) {
      feedProblems.push(`${label(feed.label)} needs to be added again.`);
      continue;
    }
    feedTasks.push(
      feedText(ctx, host.id, url, fresh)
        .then((got) => {
          ageSec = Math.max(ageSec, got.ageSec);
          return busyFromIcsText(ctx, got.text, range, { timezone: hostZone });
        })
        .catch((err: unknown) => {
          feedProblems.push(feedProblem(feed.label, err));
          return [];
        }),
    );
  }
  if (feedTasks.length > 0) {
    tasks.push(
      track('calendar feeds', async () => {
        const all = (await Promise.all(feedTasks)).flat();
        return all;
      }),
    );
  }

  const busy = mergeBusy((await Promise.all(tasks)).flat());
  if (feedProblems.length > 0) problems.push({ key: FEEDS_SOURCE, label: 'calendar feeds', message: feedProblems.join(' ') });
  if (problems.length === 0) return { result: { hostId: host.id, busy, ok: true }, ageSec, accounts };
  return { result: { hostId: host.id, busy, ok: false, error: problemLine(problems), problems }, ageSec, accounts };
}

/** Above this many blocks (about two years) a range is read straight from the calendars, without the cache. */
const MAX_CACHED_BUCKETS = 24;

/** A cached read: the fixed blocks that cover `range`, from the cache where it has them, the rest read in one go. */
async function readBuckets(ctx: Ctx, host: Host, range: Interval, pending?: Set<string>): Promise<HostBusy> {
  const first = Math.floor(range.start / BUCKET_MS);
  const last = Math.floor((range.end - 1) / BUCKET_MS);
  if (last - first + 1 > MAX_CACHED_BUCKETS) {
    const { result, accounts } = await loadSources(ctx, host, range, false, pending);
    await recordHealth(ctx, host, result.ok, result.error, accounts);
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
    const { result, ageSec, accounts } = await loadSources(ctx, host, span, false, pending);
    // A block built from a kept feed copy expires with that copy, so no answer is ever older than a minute.
    const ttl = result.ok ? Math.max(FAILURE_CACHE_TTL_SEC, CACHE_TTL_SEC - ageSec) : FAILURE_CACHE_TTL_SEC;
    await Promise.all(
      missing.map(async (b) => {
        const record: CachedBusy = { b: clip(result.busy, { start: b.index * BUCKET_MS, end: (b.index + 1) * BUCKET_MS }).map((iv) => [iv.start, iv.end]), ok: result.ok };
        if (result.error) record.e = result.error;
        if (result.problems?.length) record.p = result.problems.map((p) => ({ k: p.key, l: p.label, m: p.message }));
        b.part = record;
        try {
          await cacheSet(ctx, b.name, record, ttl);
        } catch (err) {
          logStorage(ctx, 'cache the result', host.id, err);
        }
      }),
    );
    await recordHealth(ctx, host, result.ok, result.error, accounts);
  }

  const failed = blocks.find((b) => b.part && !b.part.ok)?.part;
  const busy = clip(mergeBusy(blocks.flatMap((b) => (b.part?.b ?? []).map(([start, end]) => ({ start, end })))), range);
  const answer: HostBusy = { hostId: host.id, busy, ok: !failed };
  if (failed) {
    answer.error = failed.e ?? 'Calendar could not be read.';
    const ids = new Set(accountsOf(host).map((a) => a.account.id));
    answer.problems = (Array.isArray(failed.p) ? failed.p : [])
      .filter((p) => p && typeof p.k === 'string' && typeof p.m === 'string')
      .map((p) => ({ key: p.k, label: typeof p.l === 'string' ? p.l : '', message: p.m, ...(ids.has(p.k) ? { accountId: p.k } : {}) }));
  }
  return answer;
}

/**
 * Busy intervals of one host inside `range`, from every connected calendar. Never throws.
 * Cached: read in fixed blocks (BUCKET_DAYS) per host and calendar setup, each kept for a minute.
 * `fresh`: asked of the calendars for exactly this range, past the cache (a downloaded feed it
 * reads replaces the kept copy, the cached blocks are left alone).
 */
export async function getHostBusy(ctx: Ctx, host: Host, range: Interval, opts?: BusyReadOptions): Promise<HostBusy> {
  try {
    if (!hasSources(host)) {
      await clearHealth(ctx, host);
      return { hostId: host.id, busy: [], ok: true };
    }
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
      return { hostId: host.id, busy: [], ok: true };
    }
    if (!opts?.fresh) return await readBuckets(ctx, host, range, opts?.pending);

    const { result, accounts } = await loadSources(ctx, host, range, true, opts.pending);
    await recordHealth(ctx, host, result.ok, result.error, accounts);
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
export async function getBusyForHosts(ctx: Ctx, hosts: Host[], range: Interval, opts?: BusyReadOptions): Promise<HostBusy[]> {
  return Promise.all(hosts.map((host) => getHostBusy(ctx, host, range, opts)));
}

/**
 * For hosts who follow their Google Calendar zone: reads the zone from Google and saves it when
 * it changed. Returns the host as it is now. A failed lookup leaves everything as it was.
 */
export async function syncHostTimezone(ctx: Ctx, host: Host): Promise<Host> {
  // The zone follows the main account only: another account never moves the hours a host offers.
  const main: AccountRef | null = mainOf(host);
  if (host.timezoneMode !== 'google' || !main || main.account.status !== 'ok') return host;
  try {
    const zone = await googleGetTimezone(ctx, main);
    if (!zone || zone === host.timezone || !IANAZone.isValidZone(zone)) return host;
    const saved = await updateHost(ctx, host.id, (h) => (h.timezoneMode === 'google' ? { ...h, timezone: zone } : h));
    return saved ?? host;
  } catch (err) {
    ctx.log('warn', 'busy: could not read the Google Calendar time zone', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    return host;
  }
}
