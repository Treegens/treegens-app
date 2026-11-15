/**
 * Data access. The only module that knows the KV key layout (spec §3.1).
 * Anything stored as "one blob holding a list" is changed through a compare-and-swap loop:
 * read with etag, compute the next list, write only if the etag still matches, retry otherwise.
 */
import { defaultOwnerHost, defaultSite, starterEventTypes } from '../../shared/defaults';
import type { Booking, BookingIndexEntry, CallRecord, EventType, Host, Job, Secrets, SiteSettings } from '../../shared/types';
import { open, randomId, randomToken, seal, sha256Hex } from './crypto';
import { API_PREFIX, type Ctx, type Env } from './ctx';
import { HttpError } from './http';
import { listKeyPages } from './store';

export const KEYS = {
  site: 'site',
  secrets: 'secrets',
  adminAuth: 'auth/admin',
  hosts: 'hosts',
  eventTypes: 'event-types',
  bookingIndex: 'index/bookings',
  bookingPrefix: 'bookings/',
  jobPrefix: 'jobs/',
  claimPrefix: 'claims/',
  callPrefix: 'calls/',
  assetPrefix: 'assets/',
  cachePrefix: 'cache/',
  rateLimitPrefix: 'rl/',
} as const;

/** How often a compare-and-swap is retried. Every round one contender wins, so this covers 16 simultaneous writers of one blob. */
const CAS_ATTEMPTS = 16;
const READ_CONCURRENCY = 16;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:@=+-]+(?:\/[A-Za-z0-9._:@=+-]+)*$/;

/** Ids arrive from URLs. Only this shape is ever turned into a storage key. */
export function isStorageId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function requireId(id: string, what: string): string {
  if (!isStorageId(id)) throw new Error(`Invalid ${what} id`);
  return id;
}

/** Free-form names (claims, cache entries) become a key segment as-is when harmless, hashed otherwise. */
function nameSegment(name: string): string {
  if (typeof name !== 'string' || name === '') throw new Error('A storage name must not be empty');
  return name.length <= 200 && NAME_PATTERN.test(name) ? name : `h_${sha256Hex(name)}`;
}

function busy(): HttpError {
  return new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
}

function nowIso(ctx: Ctx): string {
  return ctx.now().toISOString();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ───────────────────────── site + bootstrap ─────────────────────────

/**
 * Creates the owner host, the starter event types and the site settings. Safe when several
 * first requests race: every write is create-only, and `site` goes last so it doubles as the
 * "bootstrap finished" marker (a crash half way is simply completed by the next call).
 */
async function bootstrap(ctx: Ctx): Promise<SiteSettings> {
  const now = nowIso(ctx);
  await ctx.kv.setJSON(KEYS.hosts, [defaultOwnerHost(now)], { onlyIfNew: true });
  await ctx.kv.setJSON(KEYS.eventTypes, starterEventTypes(now), { onlyIfNew: true });
  const site = defaultSite(now);
  const written = await ctx.kv.setJSON(KEYS.site, site, { onlyIfNew: true });
  if (written.modified) return site;
  const existing = await ctx.kv.getJSON<SiteSettings>(KEYS.site);
  if (!existing) throw new Error('Site settings vanished during bootstrap');
  return existing;
}

export async function getSite(ctx: Ctx): Promise<SiteSettings> {
  return (await ctx.kv.getJSON<SiteSettings>(KEYS.site)) ?? bootstrap(ctx);
}

export async function saveSite(ctx: Ctx, site: SiteSettings): Promise<SiteSettings> {
  const saved: SiteSettings = { ...site, updatedAt: nowIso(ctx) };
  await ctx.kv.setJSON(KEYS.site, saved);
  return saved;
}

// ───────────────────────── secrets ─────────────────────────

const SECRETS_PURPOSE = 'secrets';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Trims every value and drops groups that are completely empty. */
export function tidySecrets(input: Secrets | null | undefined): Secrets {
  const out: Secrets = {};
  const g = input?.google;
  if (g && (str(g.clientId) || str(g.clientSecret))) out.google = { clientId: str(g.clientId), clientSecret: str(g.clientSecret) };
  const t = input?.twilio;
  if (t && (str(t.accountSid) || str(t.authToken) || str(t.fromNumber) || str(t.messagingServiceSid))) {
    out.twilio = { accountSid: str(t.accountSid), authToken: str(t.authToken), fromNumber: str(t.fromNumber) };
    if (str(t.messagingServiceSid)) out.twilio.messagingServiceSid = str(t.messagingServiceSid);
  }
  if (str(input?.anthropic?.apiKey)) out.anthropic = { apiKey: str(input?.anthropic?.apiKey) };
  if (str(input?.resend?.apiKey)) out.resend = { apiKey: str(input?.resend?.apiKey) };
  return out;
}

/** Environment-level credentials win, field by field, over what was saved in the dashboard. */
export function applySecretOverrides(stored: Secrets, overrides: Env['overrides'] | undefined): Secrets {
  const o = overrides ?? {};
  return tidySecrets({
    google: {
      clientId: str(o.googleClientId) || stored.google?.clientId || '',
      clientSecret: str(o.googleClientSecret) || stored.google?.clientSecret || '',
    },
    twilio: {
      accountSid: str(o.twilioAccountSid) || stored.twilio?.accountSid || '',
      authToken: str(o.twilioAuthToken) || stored.twilio?.authToken || '',
      fromNumber: str(o.twilioFromNumber) || stored.twilio?.fromNumber || '',
      messagingServiceSid: stored.twilio?.messagingServiceSid,
    },
    anthropic: { apiKey: str(o.anthropicApiKey) || stored.anthropic?.apiKey || '' },
    resend: { apiKey: str(o.resendApiKey) || stored.resend?.apiKey || '' },
  });
}

/** What the dashboard saved, without environment overrides. Use this as the base when editing, so env values are never copied into storage. */
export async function getStoredSecrets(ctx: Ctx): Promise<Secrets> {
  const record = await ctx.kv.getJSON<{ sealed?: string }>(KEYS.secrets);
  if (!record || typeof record.sealed !== 'string') return {};
  const plain = open(ctx, SECRETS_PURPOSE, record.sealed);
  if (plain === null) {
    // Wrong or rotated MEETING_SECRET_KEY. Carry on without stored credentials so the owner can re-enter them.
    ctx.log('error', 'stored secrets could not be decrypted; treating them as empty');
    return {};
  }
  try {
    return tidySecrets(JSON.parse(plain) as Secrets);
  } catch {
    ctx.log('error', 'stored secrets are not valid JSON; treating them as empty');
    return {};
  }
}

export async function getSecrets(ctx: Ctx): Promise<Secrets> {
  return applySecretOverrides(await getStoredSecrets(ctx), ctx.env.overrides);
}

export async function saveSecrets(ctx: Ctx, next: Secrets): Promise<void> {
  await ctx.kv.setJSON(KEYS.secrets, { sealed: seal(ctx, SECRETS_PURPOSE, JSON.stringify(tidySecrets(next))) });
}

// ───────────────────────── list blobs (hosts, event types) ─────────────────────────

type ListStep<T, R> = { next: T[]; result: R } | { keep: R };

/**
 * Compare-and-swap on a bootstrapped list blob. `step` may run several times and must not have side effects.
 *
 * A swap that is refused always runs `step` again on the fresh list, also in the rare case where the
 * refusal is wrong (see the note on lost answers at updateBooking). So every `step` must be idempotent:
 * run a second time on top of its own write, it has to end in the same list. They all set or remove
 * entries by id (an added calendar feed is only added when its id is not there yet). Recognising the own
 * write by comparing lists would not be safe: two callers who make the same change at the same instant
 * write identical lists, and one of them would be told its change is in when it never was applied
 * (an increment would be lost).
 */
async function mutateList<T, R>(ctx: Ctx, key: string, step: (list: T[]) => ListStep<T, R>): Promise<R> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const found = await ctx.kv.getJSONWithEtag<T[]>(key);
    if (!found) {
      await bootstrap(ctx);
      continue;
    }
    const outcome = step(found.value);
    if ('keep' in outcome) return outcome.keep;
    const written = await ctx.kv.setJSON(key, outcome.next, { onlyIfMatch: found.etag });
    if (written.modified) return outcome.result;
    await Promise.resolve();
  }
  throw busy();
}

async function readList<T>(ctx: Ctx, key: string): Promise<T[]> {
  const list = await ctx.kv.getJSON<T[]>(key);
  if (list) return list;
  await bootstrap(ctx);
  return (await ctx.kv.getJSON<T[]>(key)) ?? [];
}

// ───────────────────────── hosts ─────────────────────────

export async function listHosts(ctx: Ctx): Promise<Host[]> {
  return readList<Host>(ctx, KEYS.hosts);
}

export async function getHost(ctx: Ctx, id: string): Promise<Host | null> {
  return (await listHosts(ctx)).find((h) => h.id === id) ?? null;
}

/** Upsert. Replaces the whole host record: prefer `updateHost` when changing a few fields of an existing host. */
export async function saveHost(ctx: Ctx, host: Host): Promise<Host> {
  requireId(host.id, 'host');
  return mutateList<Host, Host>(ctx, KEYS.hosts, (list) => {
    const saved: Host = { ...host, updatedAt: nowIso(ctx) };
    const exists = list.some((h) => h.id === host.id);
    return { next: exists ? list.map((h) => (h.id === host.id ? saved : h)) : [...list, saved], result: saved };
  });
}

/** Read-modify-write of one host on the freshest copy. `fn` may run more than once. Returns null when the host does not exist. */
export async function updateHost(ctx: Ctx, id: string, fn: (h: Host) => Host): Promise<Host | null> {
  return mutateList<Host, Host | null>(ctx, KEYS.hosts, (list) => {
    const current = list.find((h) => h.id === id);
    if (!current) return { keep: null };
    const saved: Host = { ...fn(structuredClone(current)), id: current.id, createdAt: current.createdAt, updatedAt: nowIso(ctx) };
    return { next: list.map((h) => (h.id === id ? saved : h)), result: saved };
  });
}

export async function deleteHost(ctx: Ctx, id: string): Promise<void> {
  await mutateList<Host, null>(ctx, KEYS.hosts, (list) => {
    const target = list.find((h) => h.id === id);
    if (!target) return { keep: null };
    if (target.role === 'owner') throw new HttpError(400, 'owner_required', 'The owner cannot be removed.');
    return { next: list.filter((h) => h.id !== id), result: null };
  });
}

// ───────────────────────── event types ─────────────────────────

function byPosition(a: EventType, b: EventType): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export async function listEventTypes(ctx: Ctx): Promise<EventType[]> {
  return (await readList<EventType>(ctx, KEYS.eventTypes)).sort(byPosition);
}

export async function getEventType(ctx: Ctx, id: string): Promise<EventType | null> {
  return (await listEventTypes(ctx)).find((e) => e.id === id) ?? null;
}

export async function getEventTypeBySlug(ctx: Ctx, slug: string): Promise<EventType | null> {
  if (typeof slug !== 'string' || slug === '') return null;
  const wanted = slug.toLowerCase();
  return (await listEventTypes(ctx)).find((e) => e.slug.toLowerCase() === wanted) ?? null;
}

/** Upsert; sets updatedAt. Refuses (409) a slug another event type already uses, checked inside the swap so two saves cannot race past it. */
export async function saveEventType(ctx: Ctx, et: EventType): Promise<EventType> {
  requireId(et.id, 'event type');
  return mutateList<EventType, EventType>(ctx, KEYS.eventTypes, (list) => {
    const slug = et.slug.toLowerCase();
    if (list.some((e) => e.id !== et.id && e.slug.toLowerCase() === slug)) {
      throw new HttpError(409, 'slug_taken', 'Another event type already uses that link.', { slug: 'This link is already in use.' });
    }
    const saved: EventType = { ...et, updatedAt: nowIso(ctx) };
    const exists = list.some((e) => e.id === et.id);
    return { next: exists ? list.map((e) => (e.id === et.id ? saved : e)) : [...list, saved], result: saved };
  });
}

export async function deleteEventType(ctx: Ctx, id: string): Promise<void> {
  await mutateList<EventType, null>(ctx, KEYS.eventTypes, (list) =>
    list.some((e) => e.id === id) ? { next: list.filter((e) => e.id !== id), result: null } : { keep: null },
  );
}

// ───────────────────────── bookings ─────────────────────────

function bookingKey(id: string): string {
  return `${KEYS.bookingPrefix}${id}`;
}

export async function getBooking(ctx: Ctx, id: string): Promise<Booking | null> {
  if (!isStorageId(id)) return null;
  return ctx.kv.getJSON<Booking>(bookingKey(id));
}

/** Loads several bookings at once; ids that do not exist are left out. Order follows `ids`. */
export async function getBookings(ctx: Ctx, ids: string[]): Promise<Booking[]> {
  const found = await mapLimit(ids, READ_CONCURRENCY, (id) => getBooking(ctx, id));
  return found.filter((b): b is Booking => b !== null);
}

/** Sets updatedAt and writes the booking. Does NOT touch the index. */
export async function saveBooking(ctx: Ctx, b: Booking): Promise<Booking> {
  requireId(b.id, 'booking');
  const saved: Booking = { ...b, updatedAt: nowIso(ctx) };
  await ctx.kv.setJSON(bookingKey(b.id), saved);
  return saved;
}

/** Removes a booking record. Does NOT touch the index, the jobs or the call records (admin/bookings eraseBooking does it all). */
export async function deleteBooking(ctx: Ctx, id: string): Promise<void> {
  await ctx.kv.delete(bookingKey(requireId(id, 'booking')));
}

/**
 * Writes a new booking record, create-only. `created: false` hands back the record that was already on
 * file under that id (a repeated request that saved first). A write whose answer got lost is still
 * recognised as this call's own, by its `rev`.
 */
export async function createBookingRecord(ctx: Ctx, b: Booking): Promise<{ created: boolean; booking: Booking }> {
  requireId(b.id, 'booking');
  const saved: Booking = { ...b, updatedAt: nowIso(ctx), rev: randomToken(16) };
  const written = await ctx.kv.setJSON(bookingKey(b.id), saved, { onlyIfNew: true });
  if (written.modified) return { created: true, booking: saved };
  const stored = await ctx.kv.getJSON<Booking>(bookingKey(b.id));
  if (!stored) throw new Error('A booking record was refused as existing, but none is stored');
  return stored.rev === saved.rev ? { created: true, booking: saved } : { created: false, booking: stored };
}

/**
 * Read-modify-write on the freshest copy. `fn` may run more than once. Returns null when the booking does not exist.
 *
 * A conditional write can come back as "not modified" although it went through: the storage client
 * re-sends a request whose answer got lost on the way back, and the second copy then fails its own
 * condition. Running `fn` again on top of its own write is the bug that follows (a cancellation that
 * finds the booking "already cancelled" and skips its follow-up work, a move counted twice). So every
 * write carries a fresh `rev`, and a refused swap first looks whether the record on file has it.
 */
export async function updateBooking(ctx: Ctx, id: string, fn: (b: Booking) => Booking): Promise<Booking | null> {
  if (!isStorageId(id)) return null;
  const key = bookingKey(id);
  let found = await ctx.kv.getJSONWithEtag<Booking>(key);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    if (!found) return null;
    const saved: Booking = { ...fn(found.value), id: found.value.id, createdAt: found.value.createdAt, updatedAt: nowIso(ctx), rev: randomToken(16) };
    const written = await ctx.kv.setJSON(key, saved, { onlyIfMatch: found.etag });
    if (written.modified) return saved;
    // The read for the next round doubles as the check for a write that landed after all.
    found = await ctx.kv.getJSONWithEtag<Booking>(key);
    if (found && found.value.rev === saved.rev) return saved;
    await Promise.resolve();
  }
  throw busy();
}

export async function getBookingIndex(ctx: Ctx): Promise<BookingIndexEntry[]> {
  return (await ctx.kv.getJSON<BookingIndexEntry[]>(KEYS.bookingIndex)) ?? [];
}

/**
 * Compare-and-swap on the booking index: the one place where "is this slot still free" and
 * "take it" happen atomically. `fn` gets the fresh list and returns the next one, or
 * `{ abort }` to stop without writing. It may run several times, so it must be free of side effects.
 * `reason` is the abort reason, or "contention" when every retry lost the race.
 */
export async function mutateBookingIndex(
  ctx: Ctx,
  fn: (entries: BookingIndexEntry[]) => BookingIndexEntry[] | { abort: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let found = await ctx.kv.getJSONWithEtag<BookingIndexEntry[]>(KEYS.bookingIndex);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const outcome = fn(found ? found.value : []);
    if (!Array.isArray(outcome)) return { ok: false, reason: outcome.abort };
    const written = await ctx.kv.setJSON(KEYS.bookingIndex, outcome, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    if (written.modified) return { ok: true };
    // Refused. If the index now reads exactly as we wrote it, the write went through and only its answer
    // was lost (see updateBooking). Running `fn` again would find our own entry in the way and report the
    // time as taken. Comparing whole lists is exact for a new booking (its id exists nowhere else). For
    // the other index changes (free a time, move an entry) an identical list written by somebody else
    // means the wanted state is in place, and their callers cope with a twin: see rescheduleBooking.
    found = await ctx.kv.getJSONWithEtag<BookingIndexEntry[]>(KEYS.bookingIndex);
    if (found && JSON.stringify(found.value) === JSON.stringify(outcome)) return { ok: true };
    await Promise.resolve();
  }
  return { ok: false, reason: 'contention' };
}

export function indexEntryOf(b: Booking): BookingIndexEntry {
  return {
    id: b.id,
    start: b.start,
    end: b.end,
    hostIds: [...b.hostIds],
    eventTypeId: b.eventTypeId,
    status: b.status,
    inviteeName: b.invitee.name,
    inviteeEmail: b.invitee.email,
    eventTitle: b.eventTitle,
  };
}

// ───────────────────────── jobs ─────────────────────────

/** `jobs/<dueAtISO>_<jobId>`: listing the prefix returns jobs in due order. */
export function jobKey(dueAt: string, jobId: string): string {
  return `${KEYS.jobPrefix}${dueAt}_${jobId}`;
}

function requireJobKey(key: string): string {
  if (typeof key !== 'string' || !key.startsWith(KEYS.jobPrefix) || key.length === KEYS.jobPrefix.length) throw new Error('Invalid job key');
  return key;
}

/** Due time encoded in a job key (epoch ms), or null when the key does not follow the layout. */
function dueMsOfJobKey(key: string): number | null {
  const rest = key.slice(KEYS.jobPrefix.length);
  const cut = rest.indexOf('_');
  const ms = Date.parse(cut === -1 ? rest : rest.slice(0, cut));
  return Number.isFinite(ms) ? ms : null;
}

/** With `onlyIfNew`, an existing entry under the same key is left alone; the answer says whether this call wrote it. */
export async function putJob(ctx: Ctx, job: Job, opts?: { onlyIfNew?: boolean }): Promise<boolean> {
  const written = await ctx.kv.setJSON(requireJobKey(job.key), job, opts?.onlyIfNew ? { onlyIfNew: true } : undefined);
  return written.modified;
}

/**
 * All jobs in ascending dueAt order. With `dueBy`, jobs whose key says they are due later are
 * skipped without being read, which keeps the frequent "what is due now" scan cheap.
 */
export async function listJobs(ctx: Ctx, opts?: { dueBy?: Date }): Promise<Job[]> {
  let keys = await ctx.kv.list(KEYS.jobPrefix);
  if (opts?.dueBy) {
    const limit = opts.dueBy.getTime();
    keys = keys.filter((k) => {
      const due = dueMsOfJobKey(k);
      return due === null || due <= limit;
    });
  }
  const jobs = await mapLimit(keys, READ_CONCURRENCY, (k) => ctx.kv.getJSON<Job>(k));
  return jobs
    .filter((j): j is Job => j !== null) // deleted between list and read
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.key.localeCompare(b.key));
}

export async function deleteJob(ctx: Ctx, key: string): Promise<void> {
  await ctx.kv.delete(requireJobKey(key));
}

// ───────────────────────── claims (idempotency locks) ─────────────────────────

interface ClaimRecord {
  at: string;
  /** random mark of the caller that wrote it, so that caller can tell its own write from somebody else's */
  owner?: string;
  /** what the winner left for everyone who comes later (claimValue) */
  value?: string;
}

function claimKey(name: string): string {
  return `${KEYS.claimPrefix}${nameSegment(name)}`;
}

/**
 * Writes the claim create-only and says whose it is. A "not written" answer is checked against what is
 * stored: when the storage client re-sent a write whose answer was lost, the claim on file carries our
 * own mark and is ours, although the write came back as refused.
 */
async function takeClaim(ctx: Ctx, name: string, value?: string): Promise<{ mine: boolean; stored: ClaimRecord | null }> {
  const key = claimKey(name);
  const record: ClaimRecord = { at: nowIso(ctx), owner: randomToken(16), ...(value !== undefined ? { value } : {}) };
  const written = await ctx.kv.setJSON(key, record, { onlyIfNew: true });
  if (written.modified) return { mine: true, stored: record };
  const stored = await ctx.kv.getJSON<ClaimRecord>(key);
  return { mine: !!stored && stored.owner === record.owner, stored };
}

/** True exactly once per name, however many callers race. */
export async function claim(ctx: Ctx, name: string): Promise<boolean> {
  return (await takeClaim(ctx, name)).mine;
}

/**
 * A claim that leaves something behind for the callers who lose it. The first caller's `value` is stored;
 * everyone gets back whether the claim is theirs and the value that is on file (with the time it was written).
 */
export async function claimValue(ctx: Ctx, name: string, value: string): Promise<{ mine: boolean; value: string | null; at: string | null }> {
  const taken = await takeClaim(ctx, name, value);
  return { mine: taken.mine, value: taken.stored?.value ?? null, at: taken.stored?.at ?? null };
}

/** What a claim holds, or null when nobody has taken it. */
export async function readClaim(ctx: Ctx, name: string): Promise<{ at: string; value: string | null } | null> {
  const stored = await ctx.kv.getJSON<ClaimRecord>(claimKey(name));
  return stored ? { at: typeof stored.at === 'string' ? stored.at : '', value: stored.value ?? null } : null;
}

/** Takes a claim over whoever holds it: for a holder that is known to be gone. */
export async function replaceClaimValue(ctx: Ctx, name: string, value: string): Promise<void> {
  await ctx.kv.setJSON(claimKey(name), { at: nowIso(ctx), owner: randomToken(16), value } satisfies ClaimRecord);
}

/**
 * Gives a claim back, so the next caller can take it. For a winner whose guarded work failed
 * before anything happened (the write it was guarding threw), never for work that may have run.
 */
export async function releaseClaim(ctx: Ctx, name: string): Promise<void> {
  await ctx.kv.delete(claimKey(name));
}

// ───────────────────────── calls ─────────────────────────

export async function getCall(ctx: Ctx, id: string): Promise<CallRecord | null> {
  if (!isStorageId(id)) return null;
  return ctx.kv.getJSON<CallRecord>(`${KEYS.callPrefix}${id}`);
}

export async function saveCall(ctx: Ctx, c: CallRecord): Promise<void> {
  requireId(c.id, 'call');
  await ctx.kv.setJSON(`${KEYS.callPrefix}${c.id}`, { ...c, updatedAt: nowIso(ctx) });
}

/**
 * Removes every call record (transcript included) about one booking. Calls are filed by their own id,
 * so this reads them all; there are only the last 90 days of them (cron prunes older ones).
 * Returns how many were removed.
 */
export async function deleteCallsOfBooking(ctx: Ctx, bookingId: string): Promise<number> {
  const keys = await ctx.kv.list(KEYS.callPrefix);
  const found = await mapLimit(keys, READ_CONCURRENCY, async (key) => ((await ctx.kv.getJSON<Partial<CallRecord>>(key))?.bookingId === bookingId ? key : null));
  const mine = found.filter((key): key is string => key !== null);
  await mapLimit(mine, READ_CONCURRENCY, (key) => ctx.kv.delete(key));
  return mine.length;
}

// ───────────────────────── assets ─────────────────────────

export async function putAsset(ctx: Ctx, data: Uint8Array, contentType: string, purpose: string): Promise<string> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('putAsset: no data');
  const id = randomId('ast');
  await ctx.kv.setBlob(`${KEYS.assetPrefix}${id}`, data, { contentType, purpose, createdAt: nowIso(ctx) });
  return id;
}

export async function getAsset(ctx: Ctx, id: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  if (!isStorageId(id)) return null;
  const found = await ctx.kv.getBlob(`${KEYS.assetPrefix}${id}`);
  if (!found) return null;
  return { data: found.data, contentType: found.metadata.contentType || 'application/octet-stream' };
}

export async function deleteAsset(ctx: Ctx, id: string): Promise<void> {
  if (!isStorageId(id)) return;
  await ctx.kv.delete(`${KEYS.assetPrefix}${id}`);
}

/** Relative, same-origin URL (the CSP only allows images from 'self'). */
export function assetUrl(ctx: Ctx, id: string | null | undefined): string | null {
  return isStorageId(id) ? `${API_PREFIX}/assets/${id}` : null;
}

// ───────────────────────── cache ─────────────────────────

interface CacheRecord {
  value: unknown;
  /** expiry, epoch ms */
  exp: number;
}

export async function cacheGet<T>(ctx: Ctx, name: string): Promise<T | null> {
  const record = await ctx.kv.getJSON<CacheRecord>(`${KEYS.cachePrefix}${nameSegment(name)}`);
  if (!record || typeof record.exp !== 'number' || record.exp <= ctx.now().getTime()) return null;
  return (record.value ?? null) as T | null;
}

export async function cacheSet(ctx: Ctx, name: string, value: unknown, ttlSec: number): Promise<void> {
  const record: CacheRecord = { value, exp: ctx.now().getTime() + Math.max(0, Math.round(ttlSec * 1000)) };
  await ctx.kv.setJSON(`${KEYS.cachePrefix}${nameSegment(name)}`, record);
}

// ───────────────────────── housekeeping ─────────────────────────

/** How many keys one prefix may lose per run (each prefix has its own allowance). */
export const PRUNE_LIMIT_PER_PREFIX = 1000;
/** How long one pruning run may take, measured with ctx.now(). The rest waits for the next run. */
export const PRUNE_BUDGET_MS = 5_000;
/**
 * A rate limit counter goes this long after its window ended. Nothing reads a window that is over;
 * the minute covers servers whose clocks are a little apart and a request that began just before the end.
 */
export const RATE_LIMIT_PRUNE_GRACE_MS = 60_000;

/** The prefixes pruneEphemeral looks after, in the order it sweeps them. */
export type EphemeralPrefix = typeof KEYS.claimPrefix | typeof KEYS.cachePrefix | typeof KEYS.rateLimitPrefix;
export const EPHEMERAL_PREFIXES: readonly EphemeralPrefix[] = [KEYS.claimPrefix, KEYS.cachePrefix, KEYS.rateLimitPrefix];

/** `<windowStartMs>-<windowSec>`, the last part of a rate limit key (auth.ts rateLimitKey). */
const RATE_LIMIT_WINDOW = /^(\d{1,15})-(\d{1,9})$/;
/** `<windowStartMs>` alone: a key written before the window's length was part of it. */
const LEGACY_RATE_LIMIT_WINDOW = /^\d{1,15}$/;

/**
 * Deletes short-lived keys that are past use: claims older than `maxAgeMs`, cache entries that have
 * expired (an expired entry is never read again), and rate limit counters whose window is over
 * (a minute after its end; a counter in the older layout without the window's length, once it is
 * older than `maxAgeMs`). Returns how many keys were removed. `prefixes` picks which of the three
 * are swept (all of them by default).
 *
 * Bounded twice, so a scheduled run stays inside its time: every prefix may remove at most `limit`
 * keys, and the whole run stops after `budgetMs`. Each prefix has its own slice of that time (time a
 * prefix does not use passes on to the next), so a backlog in one cannot starve the others. Keys are
 * listed a page at a time and the listing stops with the work, so a long backlog costs only the pages
 * that are looked at. Checks and deletes run in parallel. A prefix that fails does not stop the
 * others; the first failure is thrown once all of them had their turn.
 */
export async function pruneEphemeral(
  ctx: Ctx,
  maxAgeMs: number,
  limit = PRUNE_LIMIT_PER_PREFIX,
  budgetMs = PRUNE_BUDGET_MS,
  prefixes: readonly EphemeralPrefix[] = EPHEMERAL_PREFIXES,
): Promise<number> {
  const startMs = ctx.now().getTime();
  const cutoff = startMs - maxAgeMs;
  const cap = Math.max(0, Math.floor(limit));
  const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : PRUNE_BUDGET_MS;

  const sweep = async (prefix: string, until: number, isStale: (key: string) => Promise<boolean>): Promise<number> => {
    const outOfTime = (): boolean => ctx.now().getTime() >= until;
    let taken = 0;
    let removed = 0;
    let failed: { error: unknown } | null = null;
    const done = (): boolean => !!failed || taken >= cap || outOfTime();
    if (done()) return 0;
    for await (const keys of listKeyPages(ctx.kv, prefix)) {
      await mapLimit(keys, READ_CONCURRENCY, async (key) => {
        if (done()) return;
        try {
          if (!(await isStale(key))) return;
          // Checked again: the read may have used up the time, or another worker the allowance.
          if (done()) return;
          taken++;
          await ctx.kv.delete(key);
          removed++;
        } catch (error) {
          // The storage is in trouble: stop this prefix, report it once the others had their turn.
          failed ??= { error };
        }
      });
      // No next page once the allowance or the time is used up.
      if (done()) break;
    }
    if (failed) throw (failed as { error: unknown }).error;
    return removed;
  };

  const checks: Record<EphemeralPrefix, (key: string) => Promise<boolean>> = {
    [KEYS.claimPrefix]: async (key) => {
      const record = await ctx.kv.getJSON<{ at?: string }>(key);
      const at = Date.parse(record?.at ?? '');
      return Number.isFinite(at) && at < cutoff;
    },
    [KEYS.cachePrefix]: async (key) => {
      const record = await ctx.kv.getJSON<CacheRecord>(key);
      // cacheGet treats an entry as gone from the moment it expires.
      return !!record && typeof record.exp === 'number' && record.exp <= ctx.now().getTime();
    },
    // The window is in the key, so no read is needed. Last, because the biggest backlog builds up
    // here and it then gets the time the others left over.
    [KEYS.rateLimitPrefix]: async (key) => {
      const span = key.slice(key.lastIndexOf('/') + 1);
      const match = RATE_LIMIT_WINDOW.exec(span);
      if (match) return Number(match[1]) + Number(match[2]) * 1000 + RATE_LIMIT_PRUNE_GRACE_MS <= ctx.now().getTime();
      return LEGACY_RATE_LIMIT_WINDOW.test(span) && Number(span) < cutoff;
    },
  };
  const sweeps = EPHEMERAL_PREFIXES.filter((prefix) => prefixes.includes(prefix));

  let removed = 0;
  let failure: unknown = null;
  for (let i = 0; i < sweeps.length; i++) {
    const prefix = sweeps[i];
    const until = startMs + (budget * (i + 1)) / sweeps.length;
    try {
      removed += await sweep(prefix, until, checks[prefix]);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return removed;
}
