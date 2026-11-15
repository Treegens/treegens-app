import { describe, expect, it } from 'vitest';
import { newEventType } from '../../shared/defaults';
import type { Booking, BookingIndexEntry, CallRecord, Host, Job } from '../../shared/types';
import type { KV } from '../../server/lib/ctx';
import { HttpError } from '../../server/lib/http';
import {
  applySecretOverrides,
  assetUrl,
  cacheGet,
  cacheSet,
  claim,
  createBookingRecord,
  deleteAsset,
  deleteEventType,
  deleteHost,
  deleteJob,
  getAsset,
  getBooking,
  getBookingIndex,
  getBookings,
  getCall,
  getEventType,
  getEventTypeBySlug,
  getHost,
  getSecrets,
  getSite,
  getStoredSecrets,
  indexEntryOf,
  isStorageId,
  jobKey,
  listEventTypes,
  listHosts,
  listJobs,
  mutateBookingIndex,
  pruneEphemeral,
  putAsset,
  putJob,
  saveBooking,
  saveCall,
  saveEventType,
  saveHost,
  saveSecrets,
  saveSite,
  tidySecrets,
  updateBooking,
  updateHost,
} from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

function makeHost(id: string, patch: Partial<Host> = {}): Host {
  return {
    id,
    role: 'member',
    name: `Host ${id}`,
    email: `${id}@example.com`,
    timezone: 'Europe/London',
    timezoneMode: 'device',
    schedules: [],
    defaultScheduleId: 'sch_default',
    google: null,
    icsFeeds: [],
    inviteTokenHash: null,
    notify: { email: true, sms: false },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...patch,
  };
}

function makeBooking(id: string, patch: Partial<Booking> = {}): Booking {
  return {
    id,
    eventTypeId: 'evt_meeting',
    eventSlug: 'meeting',
    eventTitle: 'Meeting',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: '2026-11-20T10:00:00.000Z',
    end: '2026-11-20T10:30:00.000Z',
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London' },
    guests: [],
    answers: [],
    location: { type: 'google_meet', label: 'Google Meet' },
    consent: { sms: false, call: false, at: TEST_NOW, text: '' },
    attendance: {},
    rescheduleCount: 0,
    source: 'page',
    timeline: [{ at: TEST_NOW, type: 'created' }],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...patch,
  };
}

function makeJob(dueAt: string, id: string, patch: Partial<Job> = {}): Job {
  return { key: jobKey(dueAt, id), id, type: 'message', bookingId: 'bkg_1', dueAt, attempt: 0, createdAt: TEST_NOW, ...patch };
}

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** A KV whose named method can be intercepted. Everything else passes straight through. */
function wrapKV(inner: KV, overrides: Partial<KV>): KV {
  return {
    getJSON: (key) => inner.getJSON(key),
    getJSONWithEtag: (key) => inner.getJSONWithEtag(key),
    setJSON: (key, value, opts) => inner.setJSON(key, value, opts),
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
    getBlob: (key) => inner.getBlob(key),
    setBlob: (key, data, metadata) => inner.setBlob(key, data, metadata),
    ...overrides,
  };
}

describe('bootstrap', () => {
  it('creates site, owner host and starter event types on the first getSite', async () => {
    const ctx = makeTestCtx();
    expect(await ctx.kv.list('')).toEqual([]);

    const site = await getSite(ctx);
    expect(site.ownerHostId).toBe('host_owner');
    expect(site.updatedAt).toBe(TEST_NOW);
    expect(site.theme.preset).toBe('forest');

    const hosts = await listHosts(ctx);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: 'host_owner', role: 'owner', timezone: 'UTC', createdAt: TEST_NOW });

    const eventTypes = await listEventTypes(ctx);
    expect(eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect(eventTypes.every((e) => e.hostIds.includes(site.ownerHostId))).toBe(true);
    expect(await ctx.kv.list('')).toEqual(['event-types', 'hosts', 'site']);
  });

  it('does not run twice: later calls return what is stored', async () => {
    const ctx = makeTestCtx();
    await getSite(ctx);
    await saveHost(ctx, makeHost('host_alex'));
    await deleteEventType(ctx, 'evt_intro');

    ctx.clock.advance(86_400_000);
    const again = await getSite(ctx);
    expect(again.updatedAt).toBe(TEST_NOW);
    expect((await listHosts(ctx)).map((h) => h.id)).toEqual(['host_owner', 'host_alex']);
    expect((await listEventTypes(ctx)).map((e) => e.id)).toEqual(['evt_meeting']);
  });

  it('does not bring starter event types back after the owner deleted them all', async () => {
    const ctx = makeTestCtx();
    await getSite(ctx);
    await deleteEventType(ctx, 'evt_intro');
    await deleteEventType(ctx, 'evt_meeting');
    expect(await listEventTypes(ctx)).toEqual([]);
    await getSite(ctx);
    expect(await listEventTypes(ctx)).toEqual([]);
  });

  it('is safe under concurrent first calls', async () => {
    const ctx = makeTestCtx();
    const sites = await Promise.all(Array.from({ length: 12 }, () => getSite(ctx)));
    for (const site of sites) expect(site).toEqual(sites[0]);
    expect(await ctx.kv.getJSON('site')).toEqual(sites[0]);
    expect(await listHosts(ctx)).toHaveLength(1);
    expect(await listEventTypes(ctx)).toHaveLength(2);
  });

  it('gives every racer the stored site, even when they started at different times', async () => {
    const kv = memoryKV();
    const early = makeTestCtx({ kv, now: '2026-01-01T00:00:00.000Z' });
    const late = makeTestCtx({ kv, now: '2026-01-01T00:00:05.000Z' });
    const [a, b] = await Promise.all([getSite(early), getSite(late)]);
    expect(a).toEqual(b);
    expect(await kv.getJSON('site')).toEqual(a);
  });

  it('finishes a bootstrap that stopped half way', async () => {
    const ctx = makeTestCtx();
    // Simulates a crash after the hosts blob was written but before `site` was.
    await ctx.kv.setJSON('hosts', [makeHost('host_owner', { role: 'owner', name: 'Kept as written' })]);
    const site = await getSite(ctx);
    expect(site.ownerHostId).toBe('host_owner');
    expect((await listHosts(ctx))[0].name).toBe('Kept as written');
    expect(await listEventTypes(ctx)).toHaveLength(2);
  });

  it('bootstraps when a list is read or changed before the site', async () => {
    const a = makeTestCtx();
    expect((await listHosts(a)).map((h) => h.id)).toEqual(['host_owner']);
    expect(await a.kv.getJSON('site')).not.toBeNull();

    const b = makeTestCtx();
    expect(await listEventTypes(b)).toHaveLength(2);

    const c = makeTestCtx();
    await saveHost(c, makeHost('host_alex'));
    expect((await listHosts(c)).map((h) => h.id)).toEqual(['host_owner', 'host_alex']);
  });

  it('saveSite stamps updatedAt', async () => {
    const ctx = makeTestCtx();
    const site = await getSite(ctx);
    ctx.clock.advance(5000);
    const saved = await saveSite(ctx, { ...site, profile: { ...site.profile, headline: 'New headline' } });
    expect(saved.updatedAt).toBe('2026-11-16T09:00:05.000Z');
    expect((await getSite(ctx)).profile.headline).toBe('New headline');
  });
});

describe('secrets', () => {
  it('stores them sealed and reads them back', async () => {
    const ctx = makeTestCtx();
    expect(await getSecrets(ctx)).toEqual({});
    await saveSecrets(ctx, {
      google: { clientId: ' client-id ', clientSecret: 'client-secret-value' },
      twilio: { accountSid: 'AC123', authToken: 'twilio-token-value', fromNumber: '+15550001111' },
      resend: { apiKey: 're_secret_value' },
    });

    const raw = JSON.stringify(await ctx.kv.getJSON('secrets'));
    for (const plain of ['client-secret-value', 'twilio-token-value', 're_secret_value', 'AC123']) expect(raw).not.toContain(plain);
    expect(Object.keys((await ctx.kv.getJSON<object>('secrets'))!)).toEqual(['sealed']);

    expect(await getSecrets(ctx)).toEqual({
      google: { clientId: 'client-id', clientSecret: 'client-secret-value' },
      twilio: { accountSid: 'AC123', authToken: 'twilio-token-value', fromNumber: '+15550001111' },
      resend: { apiKey: 're_secret_value' },
    });
  });

  it('lets environment overrides win field by field without storing them', async () => {
    const kv = memoryKV();
    const plain = makeTestCtx({ kv });
    await saveSecrets(plain, { google: { clientId: 'stored-id', clientSecret: 'stored-secret' }, anthropic: { apiKey: 'stored-anthropic' } });

    const withEnv = makeTestCtx({ kv, env: { overrides: { googleClientSecret: 'env-secret', twilioAccountSid: 'ACenv', resendApiKey: 'env-resend' } } });
    expect(await getSecrets(withEnv)).toEqual({
      google: { clientId: 'stored-id', clientSecret: 'env-secret' },
      twilio: { accountSid: 'ACenv', authToken: '', fromNumber: '' },
      anthropic: { apiKey: 'stored-anthropic' },
      resend: { apiKey: 'env-resend' },
    });
    expect(await getStoredSecrets(withEnv)).toEqual({
      google: { clientId: 'stored-id', clientSecret: 'stored-secret' },
      anthropic: { apiKey: 'stored-anthropic' },
    });
  });

  it('treats undecryptable secrets as empty and says so in the log', async () => {
    const kv = memoryKV();
    await saveSecrets(makeTestCtx({ kv }), { resend: { apiKey: 're_x' } });
    const rotated = makeTestCtx({ kv, env: { secretKey: Buffer.alloc(32, 1).toString('base64') } });
    expect(await getSecrets(rotated)).toEqual({});
    expect(rotated.logs.some((l) => l.level === 'error' && /decrypt/.test(l.msg))).toBe(true);
  });

  it('tidySecrets and applySecretOverrides drop empty groups', () => {
    expect(tidySecrets({ google: { clientId: '', clientSecret: '  ' }, anthropic: { apiKey: '' } })).toEqual({});
    expect(tidySecrets(null)).toEqual({});
    expect(applySecretOverrides({}, {})).toEqual({});
    expect(applySecretOverrides({}, { anthropicApiKey: ' key ' })).toEqual({ anthropic: { apiKey: 'key' } });
    expect(
      applySecretOverrides({ twilio: { accountSid: 'AC1', authToken: 't', fromNumber: '+1', messagingServiceSid: 'MG1' } }, { twilioFromNumber: '+2' }),
    ).toEqual({ twilio: { accountSid: 'AC1', authToken: 't', fromNumber: '+2', messagingServiceSid: 'MG1' } });
  });
});

describe('hosts', () => {
  it('saveHost inserts, then replaces, and stamps updatedAt', async () => {
    const ctx = makeTestCtx();
    ctx.clock.advance(1000);
    const created = await saveHost(ctx, makeHost('host_alex'));
    expect(created.updatedAt).toBe('2026-11-16T09:00:01.000Z');
    expect(await getHost(ctx, 'host_alex')).toEqual(created);

    ctx.clock.advance(1000);
    const renamed = await saveHost(ctx, { ...created, name: 'Alex R.' });
    expect(renamed.updatedAt).toBe('2026-11-16T09:00:02.000Z');
    const hosts = await listHosts(ctx);
    expect(hosts.map((h) => h.id)).toEqual(['host_owner', 'host_alex']);
    expect(hosts[1].name).toBe('Alex R.');
    expect(await getHost(ctx, 'host_nobody')).toBeNull();
  });

  it('updateHost changes the fresh copy and cannot move the id or createdAt', async () => {
    const ctx = makeTestCtx();
    await saveHost(ctx, makeHost('host_alex'));
    ctx.clock.advance(3000);
    const updated = await updateHost(ctx, 'host_alex', (h) => ({ ...h, id: 'host_evil', createdAt: 'never', timezone: 'Africa/Nairobi' }));
    expect(updated).toMatchObject({ id: 'host_alex', createdAt: TEST_NOW, timezone: 'Africa/Nairobi', updatedAt: '2026-11-16T09:00:03.000Z' });
    expect((await getHost(ctx, 'host_alex'))?.timezone).toBe('Africa/Nairobi');
    expect(await updateHost(ctx, 'host_nobody', (h) => h)).toBeNull();
  });

  it('keeps every change when many hosts are updated at once', async () => {
    const ctx = makeTestCtx();
    const ids = Array.from({ length: 10 }, (_, i) => `host_${i}`);
    for (const id of ids) await saveHost(ctx, makeHost(id));

    await Promise.all(ids.map((id, i) => updateHost(ctx, id, (h) => ({ ...h, title: `title ${i}` }))));
    const hosts = await listHosts(ctx);
    expect(hosts).toHaveLength(11);
    for (const [i, id] of ids.entries()) expect(hosts.find((h) => h.id === id)?.title).toBe(`title ${i}`);
  });

  it('keeps every increment when one host is updated by racing writers', async () => {
    const ctx = makeTestCtx();
    await saveHost(ctx, makeHost('host_alex', { title: '0' }));
    await Promise.all(Array.from({ length: 12 }, () => updateHost(ctx, 'host_alex', (h) => ({ ...h, title: String(Number(h.title) + 1) }))));
    expect((await getHost(ctx, 'host_alex'))?.title).toBe('12');
  });

  it('keeps concurrent inserts of different hosts', async () => {
    const ctx = makeTestCtx();
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveHost(ctx, makeHost(`host_new${i}`))));
    expect(await listHosts(ctx)).toHaveLength(9);
  });

  it('deletes members but never the owner', async () => {
    const ctx = makeTestCtx();
    await saveHost(ctx, makeHost('host_alex'));
    await deleteHost(ctx, 'host_alex');
    await deleteHost(ctx, 'host_alex');
    expect((await listHosts(ctx)).map((h) => h.id)).toEqual(['host_owner']);

    await expect(deleteHost(ctx, 'host_owner')).rejects.toMatchObject({ status: 400, code: 'owner_required' });
    expect(await listHosts(ctx)).toHaveLength(1);
  });

  it('rejects ids that could not be a storage key', async () => {
    const ctx = makeTestCtx();
    await expect(saveHost(ctx, makeHost('bad/id'))).rejects.toThrow();
    expect(isStorageId('host_owner')).toBe(true);
    for (const bad of ['', 'a/b', '../x', 'a b', 'x'.repeat(81), null, 42]) expect(isStorageId(bad)).toBe(false);
  });
});

describe('event types', () => {
  it('lists by position and finds by id and slug', async () => {
    const ctx = makeTestCtx();
    await saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_first', slug: 'first', title: 'First', position: -1 }));
    await saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_last', slug: 'last', title: 'Last', position: 9 }));
    expect((await listEventTypes(ctx)).map((e) => e.id)).toEqual(['evt_first', 'evt_intro', 'evt_meeting', 'evt_last']);
    expect((await getEventType(ctx, 'evt_last'))?.title).toBe('Last');
    expect(await getEventType(ctx, 'evt_none')).toBeNull();
    expect((await getEventTypeBySlug(ctx, 'intro'))?.id).toBe('evt_intro');
    expect((await getEventTypeBySlug(ctx, 'INTRO'))?.id).toBe('evt_intro');
    expect(await getEventTypeBySlug(ctx, 'nope')).toBeNull();
    expect(await getEventTypeBySlug(ctx, '')).toBeNull();
  });

  it('saveEventType upserts and stamps updatedAt', async () => {
    const ctx = makeTestCtx();
    const intro = (await getEventType(ctx, 'evt_intro'))!;
    ctx.clock.advance(2000);
    const saved = await saveEventType(ctx, { ...intro, title: 'Quick hello', slug: 'hello' });
    expect(saved.updatedAt).toBe('2026-11-16T09:00:02.000Z');
    expect(await listEventTypes(ctx)).toHaveLength(2);
    expect((await getEventTypeBySlug(ctx, 'hello'))?.title).toBe('Quick hello');
    expect(await getEventTypeBySlug(ctx, 'intro')).toBeNull();
  });

  it('refuses a slug that another event type uses', async () => {
    const ctx = makeTestCtx();
    await getSite(ctx);
    const clash = saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_copy', slug: 'Intro', title: 'Copy' }));
    await expect(clash).rejects.toBeInstanceOf(HttpError);
    await expect(clash).rejects.toMatchObject({ status: 409, code: 'slug_taken', fields: { slug: expect.any(String) } });
    expect(await listEventTypes(ctx)).toHaveLength(2);
  });

  it('lets only one of two racing creations keep a slug', async () => {
    const ctx = makeTestCtx();
    await getSite(ctx);
    const results = await Promise.allSettled([
      saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_a', slug: 'coffee', title: 'A' })),
      saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_b', slug: 'coffee', title: 'B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await listEventTypes(ctx)).filter((e) => e.slug === 'coffee')).toHaveLength(1);
  });

  it('deleteEventType removes one and ignores unknown ids', async () => {
    const ctx = makeTestCtx();
    await deleteEventType(ctx, 'evt_intro');
    await deleteEventType(ctx, 'evt_unknown');
    expect((await listEventTypes(ctx)).map((e) => e.id)).toEqual(['evt_meeting']);
  });
});

describe('bookings', () => {
  it('saves and loads a booking without touching the index', async () => {
    const ctx = makeTestCtx();
    ctx.clock.advance(1000);
    const saved = await saveBooking(ctx, makeBooking('bkg_1'));
    expect(saved.updatedAt).toBe('2026-11-16T09:00:01.000Z');
    expect(await getBooking(ctx, 'bkg_1')).toEqual(saved);
    expect(await getBookingIndex(ctx)).toEqual([]);
    expect(await ctx.kv.list('')).toEqual(['bookings/bkg_1']);
  });

  it('returns null for unknown and for malformed ids', async () => {
    const ctx = makeTestCtx();
    await saveBooking(ctx, makeBooking('bkg_1'));
    for (const id of ['bkg_2', '', '../site', 'bkg_1/../../site', 'a b', 'x'.repeat(200)]) {
      expect(await getBooking(ctx, id)).toBeNull();
      expect(await updateBooking(ctx, id, (b) => b)).toBeNull();
    }
    await expect(saveBooking(ctx, makeBooking('bad/id'))).rejects.toThrow();
  });

  it('getBookings loads many and skips missing ones', async () => {
    const ctx = makeTestCtx();
    for (const id of ['bkg_a', 'bkg_b', 'bkg_c']) await saveBooking(ctx, makeBooking(id));
    expect((await getBookings(ctx, ['bkg_c', 'bkg_missing', 'bkg_a'])).map((b) => b.id)).toEqual(['bkg_c', 'bkg_a']);
    expect(await getBookings(ctx, [])).toEqual([]);
  });

  it('updateBooking applies the change to the stored booking', async () => {
    const ctx = makeTestCtx();
    await saveBooking(ctx, makeBooking('bkg_1'));
    ctx.clock.advance(60_000);
    const updated = await updateBooking(ctx, 'bkg_1', (b) => ({ ...b, id: 'bkg_other', status: 'cancelled' }));
    expect(updated).toMatchObject({ id: 'bkg_1', status: 'cancelled', updatedAt: '2026-11-16T09:01:00.000Z', createdAt: TEST_NOW });
    expect((await getBooking(ctx, 'bkg_1'))?.status).toBe('cancelled');
  });

  it('keeps every timeline entry when writers race on one booking', async () => {
    const ctx = makeTestCtx();
    await saveBooking(ctx, makeBooking('bkg_1', { timeline: [] }));
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateBooking(ctx, 'bkg_1', (b) => ({ ...b, timeline: [...b.timeline, { at: TEST_NOW, type: `event_${i}` }] })),
      ),
    );
    const timeline = (await getBooking(ctx, 'bkg_1'))!.timeline.map((t) => t.type).sort();
    expect(timeline).toEqual(Array.from({ length: 12 }, (_, i) => `event_${i}`).sort());
  });

  it('createBookingRecord writes once, hands back a record already on file, and knows its own write when the answer was lost', async () => {
    const inner = memoryKV();
    let lose = false;
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => {
        const result = await inner.setJSON(key, value, opts);
        if (lose && opts?.onlyIfNew && key.startsWith('bookings/') && result.modified) {
          lose = false;
          return { modified: false };
        }
        return result;
      },
    });
    const ctx = makeTestCtx({ kv });
    lose = true;
    const mine = await createBookingRecord(ctx, makeBooking('bkg_1'));
    expect(mine.created).toBe(true);
    expect((await getBooking(ctx, 'bkg_1'))?.rev).toBe(mine.booking.rev);
    // A second request for the same id finds the first one's record and gets it back, unchanged.
    const twin = await createBookingRecord(ctx, makeBooking('bkg_1', { invitee: { name: 'Someone Else', email: 'else@example.com', timezone: 'UTC' } }));
    expect(twin).toEqual({ created: false, booking: mine.booking });
  });

  it('updateBooking recognises its own write when the answer was lost, and does not apply the change twice', async () => {
    const inner = memoryKV();
    let lose = false;
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => {
        const result = await inner.setJSON(key, value, opts);
        if (lose && opts?.onlyIfMatch && key === 'bookings/bkg_1' && result.modified) {
          lose = false;
          return { modified: false };
        }
        return result;
      },
    });
    const ctx = makeTestCtx({ kv });
    await saveBooking(ctx, makeBooking('bkg_1', { timeline: [] }));
    lose = true;
    let runs = 0;
    const saved = await updateBooking(ctx, 'bkg_1', (b) => {
      runs++;
      return { ...b, rescheduleCount: b.rescheduleCount + 1, timeline: [...b.timeline, { at: TEST_NOW, type: 'rescheduled' }] };
    });
    expect(runs).toBe(1);
    expect(saved).toMatchObject({ rescheduleCount: 1 });
    const stored = await getBooking(ctx, 'bkg_1');
    expect(stored).toMatchObject({ rescheduleCount: 1, rev: saved!.rev });
    expect(stored!.timeline.map((t) => t.type)).toEqual(['rescheduled']);
  });

  it('updateBooking still runs the change again when somebody else really wrote in between', async () => {
    const inner = memoryKV();
    let intrude = false;
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => {
        if (intrude && opts?.onlyIfMatch && key === 'bookings/bkg_1') {
          intrude = false;
          const current = (await inner.getJSON<Booking>(key))!;
          await inner.setJSON(key, { ...current, timeline: [...current.timeline, { at: TEST_NOW, type: 'other_writer' }], rev: 'theirs' });
        }
        return inner.setJSON(key, value, opts);
      },
    });
    const ctx = makeTestCtx({ kv });
    await saveBooking(ctx, makeBooking('bkg_1', { timeline: [] }));
    intrude = true;
    let runs = 0;
    await updateBooking(ctx, 'bkg_1', (b) => {
      runs++;
      return { ...b, timeline: [...b.timeline, { at: TEST_NOW, type: 'mine' }] };
    });
    expect(runs).toBe(2);
    expect((await getBooking(ctx, 'bkg_1'))!.timeline.map((t) => t.type)).toEqual(['other_writer', 'mine']);
  });

  it('indexEntryOf copies the fields the index needs', () => {
    const booking = makeBooking('bkg_1', { hostIds: ['host_owner', 'host_alex'], status: 'cancelled' });
    const entry = indexEntryOf(booking);
    expect(entry).toEqual({
      id: 'bkg_1',
      start: '2026-11-20T10:00:00.000Z',
      end: '2026-11-20T10:30:00.000Z',
      hostIds: ['host_owner', 'host_alex'],
      eventTypeId: 'evt_meeting',
      status: 'cancelled',
      inviteeName: 'Ada Lovelace',
      inviteeEmail: 'ada@example.com',
      eventTitle: 'Meeting',
    } satisfies BookingIndexEntry);
    entry.hostIds.push('x');
    expect(booking.hostIds).toEqual(['host_owner', 'host_alex']);
  });
});

describe('booking index compare-and-swap', () => {
  const slot = { start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:30:00.000Z' };

  /** The pattern createBooking uses: take the slot only if nothing in the fresh index overlaps it. */
  function takeSlot(entry: BookingIndexEntry) {
    return (entries: BookingIndexEntry[]) =>
      entries.some((e) => e.status === 'confirmed' && overlaps(e, entry)) ? { abort: 'slot_taken' } : [...entries, entry];
  }

  it('creates the index on first use and appends afterwards', async () => {
    const ctx = makeTestCtx();
    expect(await mutateBookingIndex(ctx, (entries) => [...entries, indexEntryOf(makeBooking('bkg_1'))])).toEqual({ ok: true });
    expect(await mutateBookingIndex(ctx, (entries) => [...entries, indexEntryOf(makeBooking('bkg_2'))])).toEqual({ ok: true });
    expect((await getBookingIndex(ctx)).map((e) => e.id)).toEqual(['bkg_1', 'bkg_2']);
  });

  it('abort stops without writing and reports the reason', async () => {
    const ctx = makeTestCtx();
    await mutateBookingIndex(ctx, () => [indexEntryOf(makeBooking('bkg_1'))]);
    const before = await ctx.kv.getJSONWithEtag('index/bookings');
    expect(await mutateBookingIndex(ctx, () => ({ abort: 'slot_taken' }))).toEqual({ ok: false, reason: 'slot_taken' });
    expect(await ctx.kv.getJSONWithEtag('index/bookings')).toEqual(before);
  });

  it('lets exactly one of many simultaneous bookings take the same slot', async () => {
    const ctx = makeTestCtx();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => mutateBookingIndex(ctx, takeSlot(indexEntryOf(makeBooking(`bkg_${i}`, slot))))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'slot_taken')).toBe(true);
    const index = await getBookingIndex(ctx);
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(`bkg_${results.findIndex((r) => r.ok)}`);
  });

  it('keeps all of many simultaneous bookings for different slots', async () => {
    const ctx = makeTestCtx();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const hour = String(8 + i).padStart(2, '0');
        const booking = makeBooking(`bkg_${i}`, { start: `2026-11-20T${hour}:00:00.000Z`, end: `2026-11-20T${hour}:30:00.000Z` });
        return mutateBookingIndex(ctx, takeSlot(indexEntryOf(booking)));
      }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await getBookingIndex(ctx)).map((e) => e.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `bkg_${i}`).sort());
  });

  it('re-runs the callback on the fresh index when another writer got in between read and write', async () => {
    const inner = memoryKV();
    let intruded = false;
    const kv = wrapKV(inner, {
      // Lets a competing booking land right after our read, before our write.
      getJSONWithEtag: async <T>(key: string) => {
        const found = await inner.getJSONWithEtag<T>(key);
        if (key === 'index/bookings' && !intruded) {
          intruded = true;
          await inner.setJSON(key, [indexEntryOf(makeBooking('bkg_rival', slot))]);
        }
        return found;
      },
    });
    const ctx = makeTestCtx({ kv });

    const seen: string[][] = [];
    const result = await mutateBookingIndex(ctx, (entries) => {
      seen.push(entries.map((e) => e.id));
      return takeSlot(indexEntryOf(makeBooking('bkg_mine', slot)))(entries);
    });

    expect(seen).toEqual([[], ['bkg_rival']]);
    expect(result).toEqual({ ok: false, reason: 'slot_taken' });
    expect((await getBookingIndex(ctx)).map((e) => e.id)).toEqual(['bkg_rival']);
  });

  it('writes on the retry when the competing change does not conflict', async () => {
    const inner = memoryKV();
    await inner.setJSON('index/bookings', []);
    let intruded = false;
    const kv = wrapKV(inner, {
      getJSONWithEtag: async <T>(key: string) => {
        const found = await inner.getJSONWithEtag<T>(key);
        if (key === 'index/bookings' && !intruded) {
          intruded = true;
          const other = makeBooking('bkg_rival', { start: '2026-11-21T10:00:00.000Z', end: '2026-11-21T10:30:00.000Z' });
          await inner.setJSON(key, [indexEntryOf(other)]);
        }
        return found;
      },
    });
    const ctx = makeTestCtx({ kv });
    let runs = 0;
    const result = await mutateBookingIndex(ctx, (entries) => {
      runs++;
      return takeSlot(indexEntryOf(makeBooking('bkg_mine', slot)))(entries);
    });
    expect(result).toEqual({ ok: true });
    expect(runs).toBe(2);
    expect((await getBookingIndex(ctx)).map((e) => e.id)).toEqual(['bkg_rival', 'bkg_mine']);
  });

  it('gives up with "contention" after bounded retries instead of looping forever', async () => {
    const inner = memoryKV();
    let writes = 0;
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => {
        if (key === 'index/bookings') {
          writes++;
          return { modified: false };
        }
        return inner.setJSON(key, value, opts);
      },
    });
    const ctx = makeTestCtx({ kv });
    let runs = 0;
    const result = await mutateBookingIndex(ctx, (entries) => {
      runs++;
      return [...entries, indexEntryOf(makeBooking('bkg_1'))];
    });
    expect(result).toEqual({ ok: false, reason: 'contention' });
    expect(runs).toBe(writes);
    expect(runs).toBeGreaterThanOrEqual(8);
    expect(runs).toBeLessThanOrEqual(64);
    expect(await getBookingIndex(ctx)).toEqual([]);
  });

  it('takes a new booking whose write landed although its answer was lost, instead of finding its own entry in the way', async () => {
    const inner = memoryKV();
    await inner.setJSON('index/bookings', []);
    let lose = true;
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => {
        const result = await inner.setJSON(key, value, opts);
        if (lose && key === 'index/bookings' && result.modified) {
          lose = false;
          return { modified: false };
        }
        return result;
      },
    });
    const ctx = makeTestCtx({ kv });
    let runs = 0;
    const result = await mutateBookingIndex(ctx, (entries) => {
      runs++;
      return takeSlot(indexEntryOf(makeBooking('bkg_mine', slot)))(entries);
    });
    expect(result).toEqual({ ok: true });
    expect(runs).toBe(1);
    expect((await getBookingIndex(ctx)).map((e) => e.id)).toEqual(['bkg_mine']);
  });

  it('adds a calendar feed once when the store re-runs the host change on top of its own write', async () => {
    const inner = memoryKV();
    let lose = false;
    const kv = wrapKV(inner, {
      // The host list write is applied, but its answer is lost: the list step then runs again on the fresh list.
      setJSON: async (key, value, opts) => {
        const result = await inner.setJSON(key, value, opts);
        if (lose && key === 'hosts' && opts?.onlyIfMatch && result.modified) {
          lose = false;
          return { modified: false };
        }
        return result;
      },
    });
    const ctx = makeTestCtx({ kv });
    await getSite(ctx);
    await saveHost(ctx, makeHost('host_alex'));
    lose = true;
    const { applyHostUpdate } = await import('../../server/lib/admin/hosts');
    const host = (await getHost(ctx, 'host_alex'))!;
    await applyHostUpdate(ctx, host, { addIcsFeed: { label: 'Work', url: 'https://calendar.example.com/private-abc123/basic.ics' } }, { self: false });
    expect(lose).toBe(false);
    expect((await getHost(ctx, 'host_alex'))!.icsFeeds).toHaveLength(1);
  });

  it('list blobs answer 503 "busy" when a swap can never succeed', async () => {
    const inner = memoryKV();
    const kv = wrapKV(inner, {
      setJSON: async (key, value, opts) => (opts?.onlyIfMatch ? { modified: false } : inner.setJSON(key, value, opts)),
    });
    const ctx = makeTestCtx({ kv });
    await expect(saveHost(ctx, makeHost('host_alex'))).rejects.toMatchObject({ status: 503, code: 'busy' });
  });
});

describe('jobs', () => {
  it('lists jobs in due order whatever the insertion order', async () => {
    const ctx = makeTestCtx();
    const jobs = [
      makeJob('2026-11-20T09:45:00.000Z', 'job_c'),
      makeJob('2026-11-19T10:00:00.000Z', 'job_a'),
      makeJob('2026-11-20T09:00:00.000Z', 'job_b'),
      makeJob('2026-11-20T09:00:00.000Z', 'job_a2'),
    ];
    for (const job of jobs) await putJob(ctx, job);
    expect((await listJobs(ctx)).map((j) => j.id)).toEqual(['job_a', 'job_a2', 'job_b', 'job_c']);
    expect((await listJobs(ctx))[0]).toEqual(jobs[1]);
  });

  it('with dueBy, returns only due jobs and does not even read the others', async () => {
    const inner = memoryKV();
    const read: string[] = [];
    const kv = wrapKV(inner, {
      getJSON: async <T>(key: string) => {
        read.push(key);
        return inner.getJSON<T>(key);
      },
    });
    const ctx = makeTestCtx({ kv, now: '2026-11-20T09:00:00.000Z' });
    await putJob(ctx, makeJob('2026-11-20T08:00:00.000Z', 'job_past'));
    await putJob(ctx, makeJob('2026-11-20T09:00:00.000Z', 'job_now'));
    await putJob(ctx, makeJob('2026-11-20T09:00:00.001Z', 'job_soon'));
    await putJob(ctx, makeJob('2026-12-24T09:00:00.000Z', 'job_later'));

    const due = await listJobs(ctx, { dueBy: ctx.now() });
    expect(due.map((j) => j.id)).toEqual(['job_past', 'job_now']);
    expect(read).toEqual([jobKey('2026-11-20T08:00:00.000Z', 'job_past'), jobKey('2026-11-20T09:00:00.000Z', 'job_now')]);
  });

  it('deleteJob removes a job; a job deleted mid-listing is skipped', async () => {
    const inner = memoryKV();
    const ctx = makeTestCtx({ kv: inner });
    const a = makeJob('2026-11-20T08:00:00.000Z', 'job_a');
    const b = makeJob('2026-11-20T09:00:00.000Z', 'job_b');
    await putJob(ctx, a);
    await putJob(ctx, b);
    await deleteJob(ctx, a.key);
    expect((await listJobs(ctx)).map((j) => j.id)).toEqual(['job_b']);

    const vanishing = makeTestCtx({
      kv: wrapKV(inner, {
        list: async (prefix) => [...(await inner.list(prefix)), 'jobs/2026-11-20T10:00:00.000Z_job_gone'],
      }),
    });
    expect((await listJobs(vanishing)).map((j) => j.id)).toEqual(['job_b']);
  });

  it('refuses keys outside the jobs prefix', async () => {
    const ctx = makeTestCtx();
    await expect(putJob(ctx, makeJob('2026-11-20T08:00:00.000Z', 'job_a', { key: 'site' }))).rejects.toThrow();
    await expect(deleteJob(ctx, 'site')).rejects.toThrow();
    await expect(deleteJob(ctx, 'jobs/')).rejects.toThrow();
  });
});

describe('claim', () => {
  it('is true exactly once per name', async () => {
    const ctx = makeTestCtx();
    expect(await claim(ctx, 'job-job_1-0')).toBe(true);
    expect(await claim(ctx, 'job-job_1-0')).toBe(false);
    expect(await claim(ctx, 'job-job_1-1')).toBe(true);
    expect(await ctx.kv.getJSON('claims/job-job_1-0')).toEqual({ at: TEST_NOW, owner: expect.stringMatching(/^[A-Za-z0-9_-]{16,}$/) });
  });

  it('is still ours when the storage client re-sent the write and the copy was refused', async () => {
    const inner = memoryKV();
    let lose = true;
    const kv = wrapKV(inner, {
      // The first create-only write is applied, but its answer is lost: the client's re-send then fails its own condition.
      setJSON: async (key, value, opts) => {
        const result = await inner.setJSON(key, value, opts);
        if (lose && key.startsWith('claims/') && result.modified) {
          lose = false;
          return { modified: false };
        }
        return result;
      },
    });
    const ctx = makeTestCtx({ kv });
    expect(await claim(ctx, 'sched-bkg_1-confirmation')).toBe(true);
    expect(await claim(ctx, 'sched-bkg_1-confirmation')).toBe(false);
  });

  it('lets exactly one of many racing callers win', async () => {
    const ctx = makeTestCtx();
    const results = await Promise.all(Array.from({ length: 20 }, () => claim(ctx, 'gstate-nonce')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('accepts any name, hashing the ones that are not key-safe', async () => {
    const ctx = makeTestCtx();
    const odd = 'alert host=owner day 2026-11-16 ünï \n?';
    expect(await claim(ctx, odd)).toBe(true);
    expect(await claim(ctx, odd)).toBe(false);
    expect(await claim(ctx, `${odd}!`)).toBe(true);
    const keys = await ctx.kv.list('claims/');
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^claims\/h_[0-9a-f]{64}$/);
    await expect(claim(ctx, '')).rejects.toThrow();
  });
});

describe('calls', () => {
  it('round-trips a call record', async () => {
    const ctx = makeTestCtx();
    const call: CallRecord = {
      id: 'call_1',
      bookingId: 'bkg_1',
      to: '+15550001111',
      status: 'queued',
      turns: [{ role: 'assistant', text: 'Hi Ada', at: TEST_NOW }],
      pendingCancel: false,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    };
    ctx.clock.advance(500);
    await saveCall(ctx, call);
    expect(await getCall(ctx, 'call_1')).toEqual({ ...call, updatedAt: '2026-11-16T09:00:00.500Z' });
    expect(await getCall(ctx, 'call_2')).toBeNull();
    expect(await getCall(ctx, '../site')).toBeNull();
  });
});

describe('assets', () => {
  it('stores, serves and deletes binary assets', async () => {
    const ctx = makeTestCtx();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
    const id = await putAsset(ctx, png, 'image/png', 'avatar');
    expect(id).toMatch(/^ast_[a-z2-7]{16}$/);

    const found = await getAsset(ctx, id);
    expect(found?.contentType).toBe('image/png');
    expect([...found!.data]).toEqual([...png]);
    expect((await ctx.kv.getBlob(`assets/${id}`))?.metadata).toMatchObject({ contentType: 'image/png', purpose: 'avatar' });

    await deleteAsset(ctx, id);
    expect(await getAsset(ctx, id)).toBeNull();
  });

  it('handles unknown and malformed ids quietly', async () => {
    const ctx = makeTestCtx();
    expect(await getAsset(ctx, 'ast_missing')).toBeNull();
    expect(await getAsset(ctx, '../site')).toBeNull();
    await deleteAsset(ctx, '../site');
    await expect(putAsset(ctx, new Uint8Array(0), 'image/png', 'avatar')).rejects.toThrow();
  });

  it('assetUrl is a same-origin path under the API prefix, or null', () => {
    const ctx = makeTestCtx();
    expect(assetUrl(ctx, 'ast_abc')).toBe('/meeting/api/assets/ast_abc');
    expect(assetUrl(ctx, null)).toBeNull();
    expect(assetUrl(ctx, undefined)).toBeNull();
    expect(assetUrl(ctx, '')).toBeNull();
    expect(assetUrl(ctx, 'https://evil.example/x.png')).toBeNull();
  });
});

describe('cache', () => {
  it('returns the value until the ttl has passed', async () => {
    const ctx = makeTestCtx();
    expect(await cacheGet(ctx, 'busy-host_owner')).toBeNull();
    await cacheSet(ctx, 'busy-host_owner', { busy: [[1, 2]] }, 60);
    expect(await cacheGet(ctx, 'busy-host_owner')).toEqual({ busy: [[1, 2]] });
    ctx.clock.advance(59_999);
    expect(await cacheGet(ctx, 'busy-host_owner')).toEqual({ busy: [[1, 2]] });
    ctx.clock.advance(1);
    expect(await cacheGet(ctx, 'busy-host_owner')).toBeNull();
  });

  it('keeps names apart, including ones that need hashing', async () => {
    const ctx = makeTestCtx();
    await cacheSet(ctx, 'gtok-host_owner', 'a', 60);
    await cacheSet(ctx, 'busy host_owner 2026-11-16T00:00/2026-11-17T00:00', 'b', 60);
    expect(await cacheGet(ctx, 'gtok-host_owner')).toBe('a');
    expect(await cacheGet(ctx, 'busy host_owner 2026-11-16T00:00/2026-11-17T00:00')).toBe('b');
    expect(await ctx.kv.getJSON('cache/gtok-host_owner')).toEqual({ value: 'a', exp: ctx.now().getTime() + 60_000 });
  });
});

describe('pruneEphemeral', () => {
  it('removes old claims, old rate-limit windows and long-expired cache entries, and nothing else', async () => {
    const ctx = makeTestCtx();
    const dayMs = 86_400_000;
    const now = ctx.now().getTime();

    await claim(ctx, 'old-claim');
    await cacheSet(ctx, 'old-cache', 1, 60);
    await ctx.kv.setJSON(`rl/login/${'a'.repeat(64)}/${now}`, { n: 3 });
    await saveBooking(ctx, makeBooking('bkg_keep'));

    ctx.clock.advance(3 * dayMs);
    await claim(ctx, 'fresh-claim');
    await cacheSet(ctx, 'fresh-cache', 1, 60);
    await cacheSet(ctx, 'long-lived-cache', 1, 30 * 86_400);
    await ctx.kv.setJSON(`rl/login/${'b'.repeat(64)}/${ctx.now().getTime()}`, { n: 1 });

    const removed = await pruneEphemeral(ctx, 2 * dayMs);
    expect(removed).toBe(3);
    expect(await ctx.kv.list('')).toEqual([
      'bookings/bkg_keep',
      'cache/fresh-cache',
      'cache/long-lived-cache',
      'claims/fresh-claim',
      `rl/login/${'b'.repeat(64)}/${ctx.now().getTime()}`,
    ]);
  });

  it('stops at the deletion limit', async () => {
    const ctx = makeTestCtx();
    for (let i = 0; i < 10; i++) await claim(ctx, `claim-${i}`);
    ctx.clock.advance(10 * 86_400_000);
    expect(await pruneEphemeral(ctx, 86_400_000, 4)).toBe(4);
    expect(await ctx.kv.list('claims/')).toHaveLength(6);
    expect(await pruneEphemeral(ctx, 86_400_000)).toBe(6);
  });

  it('removes a cache entry as soon as it has expired, without the two day wait', async () => {
    const ctx = makeTestCtx();
    await cacheSet(ctx, 'expired-a-minute-ago', 1, 60);
    await cacheSet(ctx, 'expires-now', 1, 120);
    await cacheSet(ctx, 'still-good', 1, 600);
    ctx.clock.advance(2 * 60_000);
    expect(await pruneEphemeral(ctx, 2 * 86_400_000)).toBe(2);
    expect(await ctx.kv.list('cache/')).toEqual(['cache/still-good']);
  });

  it('gives every prefix its own allowance, so a rate limit backlog cannot starve claims and cache', async () => {
    const ctx = makeTestCtx();
    const old = ctx.now().getTime();
    for (let i = 0; i < 30; i++) await ctx.kv.setJSON(`rl/slots/${i.toString(16).padStart(64, '0')}/${old}`, { n: 1 });
    for (let i = 0; i < 3; i++) await claim(ctx, `old-claim-${i}`);
    await cacheSet(ctx, 'old-cache-1', 1, 60);
    await cacheSet(ctx, 'old-cache-2', 1, 60);
    ctx.clock.advance(3 * 86_400_000);
    // Before: one shared limit of 10, used up by rl/ alone, and claims/ and cache/ never looked at.
    expect(await pruneEphemeral(ctx, 2 * 86_400_000, 10)).toBe(15);
    expect(await ctx.kv.list('claims/')).toEqual([]);
    expect(await ctx.kv.list('cache/')).toEqual([]);
    expect(await ctx.kv.list('rl/')).toHaveLength(20);
  });

  it('deletes in parallel', async () => {
    const inner = memoryKV();
    let inFlight = 0;
    let most = 0;
    const kv: KV = {
      ...inner,
      async delete(key) {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await inner.delete(key);
        inFlight--;
      },
    };
    const ctx = makeTestCtx({ kv });
    for (let i = 0; i < 40; i++) await kv.setJSON(`rl/slots/${'c'.repeat(63)}${i % 10}/${ctx.now().getTime() - 3 * 86_400_000 - i}`, { n: 1 });
    expect(await pruneEphemeral(ctx, 2 * 86_400_000)).toBe(40);
    expect(most).toBeGreaterThan(1);
  });

  it('stops when its time is used up, and a slow prefix cannot take the time of the others', async () => {
    const inner = memoryKV();
    const slow = async <T>(work: () => Promise<T>): Promise<T> => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return work();
    };
    const kv: KV = { ...inner, getJSON: (key) => slow(() => inner.getJSON(key)), delete: (key) => slow(() => inner.delete(key)) };
    const ctx = makeTestCtx({ kv });
    const old = ctx.now().getTime();
    for (let i = 0; i < 400; i++) await inner.setJSON(`claims/old-${i}`, { at: new Date(old).toISOString() });
    for (let i = 0; i < 5; i++) await inner.setJSON(`cache/old-${i}`, { value: 1, exp: old });
    for (let i = 0; i < 5; i++) await inner.setJSON(`rl/login/${'d'.repeat(63)}${i}/${old}`, { n: 1 });
    // Real time from here on, starting three days later.
    const realStart = Date.now();
    const base = old + 3 * 86_400_000;
    ctx.now = () => new Date(base + (Date.now() - realStart));

    const removed = await pruneEphemeral(ctx, 2 * 86_400_000, 1000, 1500);
    const elapsed = Date.now() - realStart;
    // 400 claims need 800 slow calls (more than their third of the time); the others still got theirs.
    expect(await inner.list('cache/')).toEqual([]);
    expect(await inner.list('rl/')).toEqual([]);
    const claimsLeft = (await inner.list('claims/')).length;
    expect(claimsLeft).toBeGreaterThan(0);
    expect(removed).toBe(400 - claimsLeft + 10);
    expect(elapsed).toBeLessThan(1500 + 500);
    // The next run carries on where this one stopped.
    expect(await pruneEphemeral(ctx, 2 * 86_400_000, 1000, 60_000)).toBe(claimsLeft);
  });

  it('a prefix that cannot be read does not stop the others, and the failure is reported', async () => {
    const inner = memoryKV();
    const kv: KV = {
      ...inner,
      async list(prefix) {
        if (prefix === 'claims/') throw new Error('cannot list claims/');
        return inner.list(prefix);
      },
    };
    const ctx = makeTestCtx({ kv });
    await cacheSet(ctx, 'old-cache', 1, 60);
    await kv.setJSON(`rl/login/${'e'.repeat(64)}/${ctx.now().getTime()}`, { n: 1 });
    ctx.clock.advance(3 * 86_400_000);
    await expect(pruneEphemeral(ctx, 2 * 86_400_000)).rejects.toThrow('cannot list claims/');
    expect(await inner.list('cache/')).toEqual([]);
    expect(await inner.list('rl/')).toEqual([]);
  });
});
