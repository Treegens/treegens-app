/**
 * Many Google accounts per host, through the real modules: tokens and grants per account, busy time over
 * every account, where a booking's event is and what is written through which account, the background
 * stamp, removal, the scheduled health check, and older records.
 *
 * The rule of the design (13.1): a test that proves an account is read puts its busy time on an account
 * that is neither the main one nor the one connected last, next to a control time that must stay offered.
 */
import { describe, expect, it } from 'vitest';
import { MAX_GOOGLE_ACCOUNTS_PER_HOST } from '../../shared/defaults';
import type { Booking, GoogleAccount, Host } from '../../shared/types';
import type { Env } from '../../server/lib/ctx';
import { runScheduled } from '../../server/cron';
import { calendarEventIdFor, cancelBooking, createBooking, getManageView, getSlots, reconcileBookings, rescheduleBooking, syncBookingToCalendar } from '../../server/lib/booking';
import { getHostBusy, syncHostTimezone } from '../../server/lib/busy';
import { open } from '../../server/lib/crypto';
import { buildGoogleAuthUrl, completeGoogleAuth, getGoogleAccessToken, googleFreeBusy, linkMark, readGoogleState, removeGoogleAccount } from '../../server/lib/google';
import { accountIdFor, accountsOf, findAccount, mainOf } from '../../server/lib/googleAccounts';
import { removeHostGoogleAccount } from '../../server/lib/googleRemoval';
import { cacheGet, getBooking, getHost, getSite, listJobs, saveBooking, saveHost, updateBooking, updateHost } from '../../server/lib/repo';
import { defaultOwnerHost } from '../../shared/defaults';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';
import { addExtra, eventFor, fakeGoogle, googleAccount, setMain, type FakeGoogle } from '../helpers/google';

const OWNER = 'host_owner';
const ALEX = 'host_alex';
const NOW = '2026-11-16T09:00:00.000Z';
const HOUR = 3_600_000;
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const GOOGLE_ENV: Partial<Env> = { overrides: { googleClientId: CLIENT_ID, googleClientSecret: 'client-secret' } };

const A = 'jimi@gmail.example';
const B = 'jimi@work.example';
const C = 'jimi@eco.example';

/** Wednesday 18 November, UTC. */
const wed = (time: string): string => `2026-11-18T${time}:00.000Z`;
const WEDNESDAY = { slug: 'intro', durationMin: 15, fromMs: Date.parse('2026-11-18T00:00:00Z'), toMs: Date.parse('2026-11-19T00:00:00Z') };

async function setup(): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, env: GOOGLE_ENV });
  await getSite(ctx);
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com', googleExtra: [] }));
  await markSetUp(ctx);
  return ctx;
}

/** The owner with A as the main account and B, C as extras (C connected last). */
async function threeAccounts(ctx: TestCtx): Promise<Host> {
  await setMain(ctx, OWNER, { email: A });
  ctx.clock.advance(1000);
  await addExtra(ctx, OWNER, { email: B, connectedAt: ctx.now().toISOString() });
  ctx.clock.advance(1000);
  await addExtra(ctx, OWNER, { email: C, connectedAt: ctx.now().toISOString() });
  ctx.clock.set(NOW);
  return (await getHost(ctx, OWNER))!;
}

async function offered(ctx: TestCtx): Promise<string[]> {
  return (await getSlots(ctx, WEDNESDAY)).slots.map((s) => s.start);
}

function request(start: string) {
  return { slug: 'intro', start, durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London', elapsedMs: 5200 };
}

const made = (g: FakeGoogle, kind: string, account?: string) => g.calls.filter((c) => c.kind === kind && (account === undefined || c.account === account));

async function addAlex(ctx: TestCtx): Promise<Host> {
  return saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com', googleExtra: [] });
}

// ───────────────────────── busy time ─────────────────────────

describe('busy time over every account', () => {
  it('a time blocked only by an extra account that is not the last one connected is not offered; its neighbour is', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    // Control first: without the event 10:00 is offered.
    const free = fakeGoogle(ctx);
    expect(await offered(ctx)).toContain(wed('10:00'));
    expect(made(free, 'freebusy').map((c) => c.account).sort()).toEqual([A, B, C].sort());
    for (const key of await ctx.kv.list('cache/busy-')) await ctx.kv.delete(key);
    fakeGoogle(ctx, { accounts: { [B]: { busy: [[wed('10:00'), wed('10:15')]] } } });
    const times = await offered(ctx);
    expect(times).not.toContain(wed('10:00'));
    expect(times).toContain(wed('12:00'));
  });

  it('is the union of the main account, two extras and a feed, read with one request per account, all at once', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = fakeGoogle(ctx, {
      gate,
      accounts: { [A]: { busy: [[wed('09:00'), wed('09:30')]] }, [B]: { busy: [[wed('10:00'), wed('10:30')]] }, [C]: { busy: [[wed('11:00'), wed('11:30')]] } },
    });
    const reading = getHostBusy(ctx, host, { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) }, { fresh: true });
    // Every account's request is out before any of them is answered.
    for (let i = 0; i < 50 && made(g, 'freebusy').length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(made(g, 'freebusy').map((c) => c.account).sort()).toEqual([A, C, B].sort());
    release();
    const result = await reading;
    expect(result.ok).toBe(true);
    expect(result.busy.map((b) => new Date(b.start).toISOString())).toEqual([wed('09:00'), wed('10:00'), wed('11:00')]);
    // Each with its own token.
    expect(made(g, 'token').map((c) => c.account).sort()).toEqual([A, B, C].sort());
  });

  it('costs one storage read per block whatever the number of accounts, and adding one re-reads that host once', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    let reads = 0;
    const kv = ctx.kv;
    ctx.kv = { ...kv, getJSON: (key: string) => (key.startsWith('cache/busy-') && reads++, kv.getJSON(key)) } as typeof kv;
    const g = fakeGoogle(ctx);
    const range = { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) };
    await getHostBusy(ctx, (await getHost(ctx, OWNER))!, range);
    const oneAccount = reads;
    for (const email of [B, C, 'jimi@more.example']) await addExtra(ctx, OWNER, { email });
    reads = 0;
    const before = made(g, 'freebusy').length;
    const four = (await getHost(ctx, OWNER))!;
    await getHostBusy(ctx, four, range);
    expect(reads).toBe(oneAccount);
    // The new setup was read once: four accounts, one request each.
    expect(made(g, 'freebusy').length - before).toBe(4);
    // Within the minute nothing is asked of Google again.
    await getHostBusy(ctx, four, range);
    expect(made(g, 'freebusy').length - before).toBe(4);
  });

  it('one failing account closes the host, names its address, and the cached failure still names it', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    const g = fakeGoogle(ctx, { accounts: { [B]: { fail: 500 } } });
    const range = { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) };
    const first = await getHostBusy(ctx, host, range);
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/^jimi@work\.example: Google /);
    const b = findAccount(host, { sub: `sub-${B}` })!.account.id;
    expect(first.problems?.map((p) => p.accountId)).toEqual([b]);
    const calls = g.calls.length;
    ctx.clock.advance(5000);
    const cached = await getHostBusy(ctx, (await getHost(ctx, OWNER))!, range);
    expect(g.calls.length).toBe(calls);
    expect(cached).toMatchObject({ ok: false, problems: [{ key: b, label: B, accountId: b }] });
    // The health of each account is stored with the host's, in the same write.
    const stored = (await getHost(ctx, OWNER))!;
    expect(stored.calendarHealth).toMatchObject({ ok: false, message: expect.stringContaining('jimi@work.example') });
    expect(findAccount(stored, { id: b })!.account.health).toMatchObject({ ok: false });
    expect(mainOf(stored)!.account.health).toMatchObject({ ok: true });
  });

  it('an extra that needs a reconnect fails without a request, and the times close', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addExtra(ctx, OWNER, { email: B, status: 'needs_reconnect' });
    await addExtra(ctx, OWNER, { email: C });
    const g = fakeGoogle(ctx);
    const result = await getHostBusy(ctx, (await getHost(ctx, OWNER))!, { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) }, { fresh: true });
    expect(result).toMatchObject({ ok: false, error: 'jimi@work.example: Google Calendar needs to be reconnected.' });
    expect(made(g, 'freebusy', B)).toEqual([]);
    expect(await offered(ctx)).toEqual([]);
  });

  it('says which account was still being read when a caller stops waiting', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    fakeGoogle(ctx, { accounts: { [C]: { fail: 'timeout' } } });
    const pending = new Set<string>();
    const reading = getHostBusy(ctx, host, { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) }, { fresh: true, pending });
    await new Promise((r) => setTimeout(r, 50));
    expect([...pending]).toEqual([C]);
    await reading;
    expect(pending.size).toBe(0);
  }, 15_000);

  it('the time zone follows the main account only', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    await updateHost(ctx, OWNER, (h) => ({ ...h, timezoneMode: 'google', timezone: 'UTC' }));
    const g = fakeGoogle(ctx, { accounts: { [A]: { zone: 'Europe/Berlin' }, [B]: { zone: 'Asia/Tokyo' } } });
    const after = await syncHostTimezone(ctx, (await getHost(ctx, OWNER))!);
    expect(after.timezone).toBe('Europe/Berlin');
    expect(made(g, 'timezone').map((c) => c.account)).toEqual([A]);
  });
});

// ───────────────────────── tokens and grants ─────────────────────────

describe('tokens and grants per account', () => {
  it('caches access tokens per account (the main one under its old name) and marks only the account whose grant ended', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    const g = fakeGoogle(ctx, { accounts: { [B]: { fail: 'invalid_grant' } } });
    const [main, b, c] = accountsOf(host);
    expect(await getGoogleAccessToken(ctx, main)).toBe(`access-${A}`);
    expect(await getGoogleAccessToken(ctx, c)).toBe(`access-${C}`);
    expect(await cacheGet(ctx, `gtok-${OWNER}`)).not.toBeNull();
    expect(await cacheGet(ctx, `gtok-${OWNER}-${c.account.id}`)).not.toBeNull();
    await expect(getGoogleAccessToken(ctx, b)).rejects.toMatchObject({ name: 'GoogleAuthError' });
    const stored = (await getHost(ctx, OWNER))!;
    expect(accountsOf(stored).map((a) => [a.account.email, a.account.status])).toEqual([
      [A, 'ok'],
      [B, 'needs_reconnect'],
      [C, 'ok'],
    ]);
    // The others keep working from their cache.
    const before = made(g, 'token').length;
    expect(await getGoogleAccessToken(ctx, mainOf(stored)!)).toBe(`access-${A}`);
    expect(made(g, 'token').length).toBe(before);
  });

  it('free/busy of one account uses its own token and calendars, and no calendars means primary (compat)', async () => {
    const ctx = await setup();
    const host = await addExtra(ctx, OWNER, { email: B, busyCalendarIds: [] });
    const g = fakeGoogle(ctx);
    await googleFreeBusy(ctx, accountsOf(host)[0], { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) });
    const [call] = made(g, 'freebusy');
    expect(call.account).toBe(B);
    expect(JSON.parse(call.body).items).toEqual([{ id: 'primary' }]);
  });

  it("learns an old main account's Google id after its first refresh with one userinfo call, and not again", async () => {
    const ctx = await setup();
    const old = { ...googleAccount(ctx, { email: A }), id: undefined, sub: undefined };
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: old }));
    const legacy = mainOf((await getHost(ctx, OWNER))!)!.account.id;
    const g = fakeGoogle(ctx);
    await getGoogleAccessToken(ctx, mainOf((await getHost(ctx, OWNER))!)!);
    const stored = (await getHost(ctx, OWNER))!;
    expect(stored.google).toMatchObject({ sub: `sub-${A}`, id: legacy });
    expect(made(g, 'userinfo')).toHaveLength(1);
    await getGoogleAccessToken(ctx, mainOf(stored)!, { force: true });
    expect(made(g, 'userinfo')).toHaveLength(1);
  });

  it('removing an extra drops it and its token, and keeps the grant when the same Google account is connected elsewhere', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    await addAlex(ctx);
    await addExtra(ctx, ALEX, { email: B });
    const g = fakeGoogle(ctx);
    const b = accountsOf(host)[1];
    await getGoogleAccessToken(ctx, b);
    const done = await removeGoogleAccount(ctx, OWNER, b.account.id);
    expect(done).toMatchObject({ main: false, revoked: false, removed: { email: B } });
    expect(accountsOf((await getHost(ctx, OWNER))!).map((a) => a.account.email)).toEqual([A, C]);
    expect(await cacheGet(ctx, `gtok-${OWNER}-${b.account.id}`)).toBeNull();
    expect(made(g, 'revoke')).toEqual([]);
    // Not shared: handed back to Google.
    const c = accountsOf((await getHost(ctx, OWNER))!)[1];
    expect(await removeGoogleAccount(ctx, OWNER, c.account.id)).toMatchObject({ revoked: true });
    expect(made(g, 'revoke').map((r) => r.account)).toEqual([C]);
  });
});

// ───────────────────────── connecting ─────────────────────────

describe('connecting another account', () => {
  async function signIn(ctx: TestCtx, intent: 'main' | 'extra' | 'reconnect' | 'replace', email: string, accountId?: string) {
    const url = await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin/integrations', intent, ...(accountId ? { accountId } : {}) });
    const state = new URL(url).searchParams.get('state')!;
    return completeGoogleAuth(ctx, new URLSearchParams({ state, code: `c:${email}` }));
  }

  it('adds a second account next to the first, which stays exactly as it was and stays the main one', async () => {
    const ctx = await setup();
    fakeGoogle(ctx);
    expect(await signIn(ctx, 'main', A)).toMatchObject({ ok: true, outcome: 'first' });
    const before = (await getHost(ctx, OWNER))!.google;
    expect(await signIn(ctx, 'extra', B)).toMatchObject({ ok: true, outcome: 'added', accountId: accountIdFor(OWNER, `sub-${B}`) });
    const host = (await getHost(ctx, OWNER))!;
    expect(host.google).toEqual(before);
    expect(host.googleExtra!.map((a) => a.email)).toEqual([B]);
    expect(open(ctx, 'google-refresh', host.googleExtra![0].refreshTokenEnc)).toBe(`refresh-${B}`);
  });

  it('a renamed Google account (same sub, new address) refreshes in place; a reused address (another sub) is added', async () => {
    const ctx = await setup();
    const g = fakeGoogle(ctx);
    await signIn(ctx, 'main', A);
    await signIn(ctx, 'extra', B);
    await updateHost(ctx, OWNER, (h) => ({ ...h, googleExtra: h.googleExtra!.map((a) => ({ ...a, busyCalendarIds: ['primary', 'team@group'] })) }));
    const firstConnected = (await getHost(ctx, OWNER))!.googleExtra![0].connectedAt;
    ctx.clock.advance(HOUR);
    g.accounts['jimi@renamed.example'] = { sub: `sub-${B}` };
    expect(await signIn(ctx, 'extra', 'jimi@renamed.example')).toMatchObject({ outcome: 'refreshed', accountId: accountIdFor(OWNER, `sub-${B}`) });
    let host = (await getHost(ctx, OWNER))!;
    expect(host.googleExtra).toHaveLength(1);
    expect(host.googleExtra![0]).toMatchObject({ email: 'jimi@renamed.example', busyCalendarIds: ['primary', 'team@group'], connectedAt: firstConnected, refreshedAt: ctx.now().toISOString() });
    g.accounts[C] = { sub: 'sub-a-different-person' };
    await signIn(ctx, 'extra', C);
    g.accounts[C] = { sub: 'sub-yet-another' };
    expect(await signIn(ctx, 'extra', C)).toMatchObject({ outcome: 'added' });
    host = (await getHost(ctx, OWNER))!;
    expect(host.googleExtra!.filter((a) => a.email === C)).toHaveLength(2);
  });

  it(`refuses a ${MAX_GOOGLE_ACCOUNTS_PER_HOST + 1}st account: nothing stored, and the fresh grant handed back unless held elsewhere`, async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    for (let i = 1; i < MAX_GOOGLE_ACCOUNTS_PER_HOST; i++) await addExtra(ctx, OWNER, { email: `n${i}@x.example` });
    const g = fakeGoogle(ctx);
    await expect(buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'extra' })).rejects.toMatchObject({ status: 409, code: 'too_many_google_accounts' });
    // A sign-in that got past the button (started before the last one was added) is refused at the end.
    const url = await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'main' });
    const before = JSON.stringify((await getHost(ctx, OWNER))!.googleExtra);
    const result = await completeGoogleAuth(ctx, new URLSearchParams({ state: new URL(url).searchParams.get('state')!, code: 'c:one-too-many@x.example' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`You have connected ${MAX_GOOGLE_ACCOUNTS_PER_HOST} Google accounts`);
    expect(JSON.stringify((await getHost(ctx, OWNER))!.googleExtra)).toBe(before);
    expect(made(g, 'revoke').map((c) => c.account)).toEqual(['one-too-many@x.example']);
    // Reconnecting one of them still works at the ceiling.
    const one = accountsOf((await getHost(ctx, OWNER))!)[3];
    expect(await signIn(ctx, 'reconnect', one.account.email, one.account.id)).toMatchObject({ ok: true, outcome: 'refreshed' });
  });

  it('builds the right Google address for each button, and carries the intent, the account and the link mark in the signed state', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    const b = accountsOf(host)[1].account;
    const add = new URL(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'extra', loginHint: A }));
    expect(add.searchParams.get('prompt')).toBe('consent select_account');
    expect(add.searchParams.get('login_hint')).toBeNull();
    const again = new URL(await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'reconnect', accountId: b.id, linkMark: linkMark(ctx, 'hash') }));
    expect(again.searchParams.get('prompt')).toBe('consent');
    expect(again.searchParams.get('login_hint')).toBe(B);
    expect(readGoogleState(ctx, again.searchParams.get('state')!)).toMatchObject({ intent: 'reconnect', aid: b.id, lt: linkMark(ctx, 'hash') });
    // A changed character inside the signed part. (The last character of the signature carries two padding bits
    // that decoding ignores, so changing it from "A" to "B" leaves the same signature: that tamper passed 1 run in 16.)
    const state = again.searchParams.get('state')!;
    const tampered = `${state.slice(0, 5)}${state[5] === 'A' ? 'B' : 'A'}${state.slice(6)}`;
    expect(readGoogleState(ctx, tampered)).toBeNull();
    await expect(buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'reconnect', accountId: 'gacc_gone' })).rejects.toMatchObject({ status: 404, code: 'google_account_not_found' });
  });
});

// ───────────────────────── bookings ─────────────────────────

let invitees = 0;
async function booked(ctx: TestCtx, start: string): Promise<Booking> {
  // A new invitee each time, from a new address: one person may only hold a few upcoming meetings.
  invitees++;
  (ctx as { ip: string | null }).ip = `203.0.113.${invitees % 250}`;
  const { booking } = await createBooking(ctx, { ...request(start), email: `invitee${invitees}@example.com` });
  await ctx.settle();
  return (await getBooking(ctx, booking.id))!;
}

describe('where a booking goes, and what is written through which account', () => {
  it('writes new meetings into the main account and records it; nothing goes to the other accounts', async () => {
    const ctx = await setup();
    const host = await threeAccounts(ctx);
    const g = fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    expect(booking.google).toMatchObject({ hostId: OWNER, accountId: mainOf(host)!.account.id, accountEmail: A, eventId: calendarEventIdFor(booking.id) });
    expect(made(g, 'event_insert').map((c) => c.account)).toEqual([A]);
  });

  it('an extra account that needs a reconnect closes the host: the booking is refused, with one alert per account and day naming it', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addExtra(ctx, OWNER, { email: B, status: 'needs_reconnect' });
    fakeGoogle(ctx);
    await expect(createBooking(ctx, request(wed('12:00')))).rejects.toMatchObject({ status: 503, code: 'calendar_unavailable' });
    await expect(createBooking(ctx, request(wed('12:30')))).rejects.toMatchObject({ status: 503 });
    const alerts = (await listJobs(ctx)).filter((j) => j.kind === 'host_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('A calendar needs attention: Jimi Cohen (jimi@work.example)');
    expect(alerts[0].body).toContain('Jimi Cohen, jimi@work.example: Google Calendar needs to be reconnected.');
  });

  it('a joint meeting is closed by the co-host\'s extra account, and invites the co-host\'s main address (compat)', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addAlex(ctx);
    await setMain(ctx, ALEX, { email: 'alex@gmail.example' });
    await addExtra(ctx, ALEX, { email: 'alex@work.example' });
    const { saveEventType } = await import('../../server/lib/repo');
    const { newEventType } = await import('../../shared/defaults');
    const joint = newEventType(NOW, { id: 'evt_joint', slug: 'joint', title: 'Joint call', hostIds: [OWNER, ALEX] });
    await saveEventType(ctx, { ...joint, kind: 'collective', durations: [15], defaultDuration: 15 });
    await updateHost(ctx, ALEX, (h) => ({ ...h, schedules: (h.schedules.length ? h.schedules : []).map((s) => ({ ...s, weekly: { 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }], 3: [{ start: '09:00', end: '17:00' }], 4: [{ start: '09:00', end: '17:00' }], 5: [{ start: '09:00', end: '17:00' }], 6: [] } })) }));
    const g = fakeGoogle(ctx, { accounts: { 'alex@work.example': { busy: [[wed('11:00'), wed('11:15')]] } } });
    const times = (await getSlots(ctx, { ...WEDNESDAY, slug: 'joint' })).slots.map((s) => s.start);
    expect(times).not.toContain(wed('11:00'));
    expect(times).toContain(wed('12:00'));
    expect(times).toContain(wed('10:00'));
    const { booking } = await createBooking(ctx, { ...request(wed('12:00')), slug: 'joint' });
    await ctx.settle();
    const insert = made(g, 'event_insert');
    expect(insert.map((c) => c.account)).toEqual([A]);
    expect(JSON.parse(insert[0].body).attendees.map((a: { email: string }) => a.email)).toContain('alex@gmail.example');
    expect((await getBooking(ctx, booking.id))!.google?.accountEmail).toBe(A);
  });

  it('a round robin carries on without a host whose extra account fails', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addAlex(ctx);
    await setMain(ctx, ALEX, { email: 'alex@gmail.example' });
    await addExtra(ctx, ALEX, { email: 'alex@work.example' });
    const { saveEventType } = await import('../../server/lib/repo');
    const { newEventType } = await import('../../shared/defaults');
    await saveEventType(ctx, { ...newEventType(NOW, { id: 'evt_rr', slug: 'rr', title: 'Either of us', hostIds: [OWNER, ALEX] }), kind: 'round_robin', durations: [15], defaultDuration: 15 });
    fakeGoogle(ctx, { accounts: { 'alex@work.example': { fail: 500 } } });
    const times = (await getSlots(ctx, { ...WEDNESDAY, slug: 'rr' })).slots.map((s) => s.start);
    expect(times).toContain(wed('12:00'));
    const { booking } = await createBooking(ctx, { ...request(wed('12:00')), slug: 'rr' });
    expect(booking.hostIds).toEqual([OWNER]);
  });
});

describe('the account that holds a booking\'s event', () => {
  /** A booking made before events recorded their account: its event is wherever `where` says. */
  async function unstamped(ctx: TestCtx, start: string): Promise<Booking> {
    const g = fakeGoogle(ctx);
    const booking = await booked(ctx, start);
    const event = g.accounts[A].events![booking.google!.eventId];
    const { accountId: _a, accountEmail: _e, ...google } = booking.google!;
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google }));
    return { ...(await getBooking(ctx, booking.id))!, __event: event } as Booking & { __event: unknown };
  }

  it('the background stamp records the account whose copy carries our booking id', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const booking = await unstamped(ctx, wed('12:00'));
    const g = fakeGoogle(ctx, { accounts: { [A]: { events: { [booking.google!.eventId]: eventFor(booking.id, wed('12:00'), wed('12:15')) } } } });
    const result = await reconcileBookings(ctx);
    expect(result.stamped).toBe(1);
    expect((await getBooking(ctx, booking.id))!.google).toMatchObject({ accountEmail: A, accountId: mainOf((await getHost(ctx, OWNER))!)!.account.id });
    // Read, never written.
    expect(g.calls.filter((c) => c.kind === 'event_patch' || c.kind === 'event_insert' || c.kind === 'event_delete')).toEqual([]);
  });

  it('an event in no account, every account answering, is detached with a line on the timeline', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const booking = await unstamped(ctx, wed('12:00'));
    fakeGoogle(ctx);
    expect((await reconcileBookings(ctx)).detached).toBe(1);
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.google?.detached).toBe(true);
    expect(after.timeline.at(-1)).toMatchObject({ type: 'calendar_not_found', detail: expect.stringContaining('could not be found in any connected Google account') });
  });

  it('an account that cannot be asked leaves the booking for a later run', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const booking = await unstamped(ctx, wed('12:00'));
    fakeGoogle(ctx, { accounts: { [B]: { fail: 500 } } });
    const result = await reconcileBookings(ctx);
    expect(result.stamped ?? 0).toBe(0);
    expect(result.detached ?? 0).toBe(0);
    expect((await getBooking(ctx, booking.id))!.google).not.toHaveProperty('accountId');
    expect((await getBooking(ctx, booking.id))!.google?.detached).toBeUndefined();
  });

  it('stamps at most 10 a run', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    const events: Record<string, ReturnType<typeof eventFor>> = {};
    for (let i = 0; i < 12; i++) {
      const start = new Date(Date.parse(wed('09:00')) + i * 30 * 60_000).toISOString();
      const b = await unstamped(ctx, start);
      events[b.google!.eventId] = eventFor(b.id, start, start);
    }
    fakeGoogle(ctx, { accounts: { [A]: { events } } });
    expect((await reconcileBookings(ctx)).stamped).toBe(10);
  });

  it('an attendee\'s copy, or an event of another booking, is not the event: the move then writes nowhere', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const booking = await unstamped(ctx, wed('12:00'));
    const id = booking.google!.eventId;
    const g = fakeGoogle(ctx, {
      accounts: {
        // Their copy as an attendee has no private properties of ours; the other one belongs to another booking.
        [A]: { events: { [id]: { calendarId: 'primary', status: 'confirmed', body: { start: { dateTime: wed('12:00') } } } } },
        [B]: { events: { [id]: eventFor('bkg_someone_else', wed('12:00'), wed('12:15')) } },
      },
    });
    await rescheduleBooking(ctx, booking.id, { startIso: wed('13:00'), by: 'invitee' });
    await ctx.settle();
    expect(g.calls.filter((c) => c.kind === 'event_patch' || c.kind === 'event_insert')).toEqual([]);
    expect((await getBooking(ctx, booking.id))!.google?.detached).toBe(true);
  });

  it('a timeout on one candidate fails the sync with a retry instead of guessing', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const booking = await unstamped(ctx, wed('12:00'));
    // Only reading its events fails: its busy time is fine, so the move itself goes through.
    const g = fakeGoogle(ctx, { accounts: { [C]: { fail: 500, failKinds: ['event_get'] } } });
    await rescheduleBooking(ctx, booking.id, { startIso: wed('13:00'), by: 'invitee' });
    await ctx.settle();
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.google?.detached).toBeUndefined();
    expect(after.google?.error).toMatch(/Google request failed \(500/);
    expect(g.calls.filter((c) => c.kind === 'event_patch' || c.kind === 'event_insert')).toEqual([]);
    expect((await listJobs(ctx)).some((j) => j.type === 'gcal_sync' && j.bookingId === booking.id)).toBe(true);
  });

  it('a trusted holder whose event was deleted gets it back in the same account; an id that names no account creates nothing anywhere', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    let g = fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    delete g.accounts[A].events![booking.google!.eventId];
    await rescheduleBooking(ctx, booking.id, { startIso: wed('13:00'), by: 'invitee' });
    await ctx.settle();
    expect(made(g, 'event_insert').map((c) => c.account)).toEqual([A, A]);

    const other = await booked(ctx, wed('14:00'));
    await updateBooking(ctx, other.id, (b) => ({ ...b, google: { ...b.google!, accountId: 'gacc_replaced_meanwhile' } }));
    g = fakeGoogle(ctx);
    await rescheduleBooking(ctx, other.id, { startIso: wed('15:00'), by: 'invitee' });
    await ctx.settle();
    expect(made(g, 'event_insert')).toEqual([]);
    expect((await getBooking(ctx, other.id))!.google?.detached).toBe(true);
  });

  it('after "Use a different Google account", moving a booking made before it sends no second Google invitation', async () => {
    const ctx = await setup();
    fakeGoogle(ctx);
    const url = await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'main' });
    await completeGoogleAuth(ctx, new URLSearchParams({ state: new URL(url).searchParams.get('state')!, code: `c:${A}` }));
    const booking = await booked(ctx, wed('12:00'));
    // The replace, then what the callback route does with the old main's bookings.
    const g = fakeGoogle(ctx);
    const switched = await buildGoogleAuthUrl(ctx, { hostId: OWNER, returnTo: '/meeting/admin', intent: 'replace' });
    const result = await completeGoogleAuth(ctx, new URLSearchParams({ state: new URL(switched).searchParams.get('state')!, code: 'c:jimi@new.example' }));
    expect(result).toMatchObject({ outcome: 'replaced', dropped: { email: A } });
    const { detachEventsOfAccount } = await import('../../server/lib/booking');
    expect(await detachEventsOfAccount(ctx, OWNER, result.dropped!, { includeUnstamped: true, why: 'replaced' })).toBe(1);
    await rescheduleBooking(ctx, booking.id, { startIso: wed('13:00'), by: 'invitee' });
    await ctx.settle();
    expect(g.calls.filter((c) => c.kind.startsWith('event_'))).toEqual([]);
  });

  it('a detached booking: moving and cancelling it make no Google calls at all', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { ...b.google!, detached: true } }));
    const g = fakeGoogle(ctx);
    await rescheduleBooking(ctx, booking.id, { startIso: wed('13:00'), by: 'invitee' });
    await cancelBooking(ctx, booking.id, { by: 'invitee' });
    await ctx.settle();
    expect(g.calls.filter((c) => c.kind.startsWith('event_'))).toEqual([]);
  });

  it('removing the main account detaches its upcoming bookings and keeps the other accounts blocking', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    fakeGoogle(ctx, { accounts: { [B]: { busy: [[wed('10:00'), wed('10:15')]] } } });
    const booking = await booked(ctx, wed('12:00'));
    const main = mainOf((await getHost(ctx, OWNER))!)!;
    const removed = await removeHostGoogleAccount(ctx, (await getHost(ctx, OWNER))!, main.account.id, { self: false });
    expect(removed).toMatchObject({ removed: { email: A, main: true }, effects: { detached: 1 } });
    expect(removed.host.google).toBeNull();
    expect(removed.host.googleExtra!.map((a) => a.email)).toEqual([B, C]);
    expect((await getBooking(ctx, booking.id))!.google).toMatchObject({ detached: true, accountEmail: A });
    expect(await offered(ctx)).not.toContain(wed('10:00'));
  });
});

// ───────────────────────── scheduled run, older data ─────────────────────────

describe('the scheduled run', () => {
  it('reads extra accounts, alerts once a day per failing account, and stamps inside the booking check', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    await addAlex(ctx);
    await setMain(ctx, ALEX, { email: 'alex@gmail.example' });
    await addExtra(ctx, ALEX, { email: 'alex@work.example' });
    const g = fakeGoogle(ctx, { accounts: { [C]: { fail: 500 }, 'alex@work.example': { fail: 'invalid_grant' } } });
    const summary = await runScheduled(ctx, { stepWaitMs: 5000 });
    const housekeeping = summary.housekeeping as Record<string, unknown>;
    expect(housekeeping.calendars).toEqual({ checked: 2, broken: 2, alerted: 2 });
    expect(made(g, 'freebusy').map((c) => c.account).sort()).toEqual([A, B, 'alex@gmail.example'].sort());
    const subjects = (await listJobs(ctx)).filter((j) => j.kind === 'host_alert').map((j) => j.subject);
    expect(subjects).toEqual(['A calendar needs attention: Alex Kim (alex@work.example) and Jimi Cohen (jimi@eco.example)']);
    ctx.clock.advance(31 * 60_000);
    expect(((await runScheduled(ctx, { stepWaitMs: 5000 })).housekeeping as Record<string, unknown>).calendars).toMatchObject({ alerted: 0 });
  });
});

describe('the scheduled run, more', () => {
  it('reads at most 8 hosts at a time', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    for (let i = 0; i < 10; i++) {
      const id = `host_m${i}`;
      await saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id, role: 'member', name: `M ${i}`, email: `m${i}@example.com`, googleExtra: [] });
      await setMain(ctx, id, { email: `m${i}@cal.example` });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = fakeGoogle(ctx, { gate });
    const run = runScheduled(ctx, { stepWaitMs: 10_000 });
    for (let i = 0; i < 100 && made(g, 'freebusy').length < 8; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    expect(made(g, 'freebusy')).toHaveLength(8);
    release();
    const summary = await run;
    expect((summary.housekeeping as Record<string, unknown>).calendars).toEqual({ checked: 11, broken: 0, alerted: 0 });
    expect(made(g, 'freebusy')).toHaveLength(11);
  });

  it('stamps an unstamped booking in its booking check', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    const g = fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    await updateBooking(ctx, booking.id, (b) => {
      const { accountId: _a, accountEmail: _e, ...google } = b.google!;
      return { ...b, google };
    });
    fakeGoogle(ctx, { accounts: { [A]: { events: g.accounts[A].events } } });
    const summary = await runScheduled(ctx, { stepWaitMs: 5000 });
    expect((summary.housekeeping as Record<string, unknown>).bookings).toMatchObject({ stamped: 1 });
    expect((await getBooking(ctx, booking.id))!.google?.accountEmail).toBe(A);
  });
});

describe('older records', () => {
  it('an older deploy writing the main account the way it always did keeps the other accounts', async () => {
    const ctx = await setup();
    await threeAccounts(ctx);
    const connection = { email: 'jimi@other.example', refreshTokenEnc: 'v1.x', scopes: [], busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false, status: 'ok' as const, connectedAt: NOW };
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: connection }));
    const host = (await getHost(ctx, OWNER))!;
    expect(host.googleExtra!.map((a: GoogleAccount) => a.email)).toEqual([B, C]);
    expect(mainOf(host)!.account.id).toMatch(/^gacc_/);
  });

  it('a host stored in the shape of before (no googleExtra, no id, no sub) reads as one main account', async () => {
    const ctx = await setup();
    const { googleExtra: _gone, ...old } = (await getHost(ctx, OWNER))!;
    await saveHost(ctx, { ...old, google: { ...googleAccount(ctx, { email: A }), id: undefined, sub: undefined } } as Host);
    const host = (await getHost(ctx, OWNER))!;
    expect(accountsOf(host).map((a) => [a.main, a.account.email])).toEqual([[true, A]]);
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    expect(booking.google).toMatchObject({ accountEmail: A });
  });
});

describe('the Google stand-in', () => {
  it('keeps the tokens of two accounts apart, ends a whole grant on revoke, and keeps a sub across a rename', async () => {
    const { createMockFetch } = await import('../../server/lib/mocks');
    const { memoryKV } = await import('../../server/lib/store');
    const { moveMockAccount, reuseMockAddress, ensureMockAccount } = await import('../../server/routes/dev');
    const kv = memoryKV();
    const mock = createMockFetch({ kv, now: () => new Date(NOW) });
    const post = (url: string, form: Record<string, string>) => mock(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    const consent = async (email: string) => (await (await post('https://oauth2.googleapis.com/token', { grant_type: 'authorization_code', code: `mock:${email}:UTC`, client_id: 'c', client_secret: 's', redirect_uri: 'https://x/api/google/callback' })).json()) as { refresh_token: string };
    const refresh = async (token: string) => (await post('https://oauth2.googleapis.com/token', { grant_type: 'refresh_token', refresh_token: token, client_id: 'c', client_secret: 's' })).status;
    const a1 = (await consent('a@x.example')).refresh_token;
    const a2 = (await consent('a@x.example')).refresh_token;
    const b1 = (await consent('b@x.example')).refresh_token;
    await post('https://oauth2.googleapis.com/revoke', { token: a1 });
    expect(await refresh(a2)).toBe(400);
    expect(await refresh(b1)).toBe(200);
    // A new consent works again.
    expect(await refresh((await consent('a@x.example')).refresh_token)).toBe(200);
    const sub = (await ensureMockAccount(kv, 'b@x.example')).sub;
    await moveMockAccount(kv, 'b@x.example', 'b2@x.example');
    expect((await ensureMockAccount(kv, 'b2@x.example')).sub).toBe(sub);
    expect(await refresh(b1)).toBe(200);
    const reused = await reuseMockAddress(kv, 'b2@x.example');
    expect(reused.sub).not.toBe(sub);
    // The old account still works under its hidden address.
    expect(await refresh(b1)).toBe(200);
  });
});

// ───────────────────────── sites that must look at every account (verify round) ─────────────────────────

describe('every account, where only the main one used to count', () => {
  it('the health check reads a host whose only Google accounts are other accounts (its main one was removed)', async () => {
    const ctx = await setup();
    await addExtra(ctx, OWNER, { email: B });
    const g = fakeGoogle(ctx, { accounts: { [B]: { fail: 500 } } });
    const summary = await runScheduled(ctx, { stepWaitMs: 5000 });
    expect((summary.housekeeping as Record<string, unknown>).calendars).toEqual({ checked: 1, broken: 1, alerted: 1 });
    // Only B was asked (its token request fails, so no free/busy request follows).
    expect([...new Set(g.calls.map((c) => c.account).filter(Boolean))]).toEqual([B]);
  });

  it("an extra account's ticked calendars are the ones read, not only its primary one", async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    const host = await addExtra(ctx, OWNER, { email: B, busyCalendarIds: ['primary', 'family@group'] });
    const g = fakeGoogle(ctx);
    await getHostBusy(ctx, host, { start: Date.parse(wed('00:00')), end: Date.parse(wed('23:59')) }, { fresh: true });
    const asB = made(g, 'freebusy', B).map((c) => (JSON.parse(c.body).items as { id: string }[]).map((i) => i.id).sort());
    expect(asB).toEqual([['family@group', 'primary']]);
  });

  it('the manage page of a detached booking no longer promises a Google invitation', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(true);
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { ...b.google!, detached: true } }));
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(false);
  });

  it('taking an event off the calendar of a host who left the meeting reads first: the account that replaced theirs is never written to', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addAlex(ctx);
    await setMain(ctx, ALEX, { email: 'alex@gmail.example' });
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    // The owner's main account was replaced meanwhile (by an older deploy, say): the event is not in the new one.
    await setMain(ctx, OWNER, { email: 'jimi@new.example' });
    await updateBooking(ctx, booking.id, (b) => ({ ...b, hostIds: [ALEX] }));
    const g = fakeGoogle(ctx);
    await syncBookingToCalendar(ctx, booking.id);
    expect(g.calls.filter((c) => c.account === 'jimi@new.example' && c.kind !== 'event_get' && c.kind !== 'token')).toEqual([]);
    expect(made(g, 'event_get', 'jimi@new.example')).toHaveLength(1);
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.timeline.some((t) => t.type === 'calendar_event_left')).toBe(true);
    // The meeting goes onto the calendar of the host who has it now.
    expect(made(g, 'event_insert').map((c) => c.account)).toEqual(['alex@gmail.example']);
  });

  it('an old main account and another entry of the same Google account become one after the first refresh, calendars united', async () => {
    const ctx = await setup();
    // The main account as code before this stored it: no id, no sub.
    await setMain(ctx, OWNER, { email: A, id: undefined, sub: undefined, busyCalendarIds: ['primary'] });
    // The same Google account, connected again as another account (an older deploy cannot tell them apart).
    await addExtra(ctx, OWNER, { email: A, busyCalendarIds: ['family@group'] });
    const g = fakeGoogle(ctx);
    await getGoogleAccessToken(ctx, mainOf((await getHost(ctx, OWNER))!)!);
    const after = (await getHost(ctx, OWNER))!;
    expect(after.google).toMatchObject({ email: A, sub: `sub-${A}` });
    expect(after.googleExtra).toEqual([]);
    expect([...after.google!.busyCalendarIds].sort()).toEqual(['family@group', 'primary']);
    // The grant is the main account's: nothing was revoked.
    expect(made(g, 'revoke')).toEqual([]);
  });

  it('the stamp leaves alone a booking that was stamped while it was looking, and does not count it', async () => {
    const ctx = await setup();
    const host = await setMain(ctx, OWNER, { email: A });
    const main = mainOf(host)!.account;
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    await updateBooking(ctx, booking.id, (b) => {
      const { accountId: _a, accountEmail: _e, ...google } = b.google!;
      return { ...b, google };
    });
    // The event is not found, but a sync elsewhere finds it and stamps the booking while the stamp reads.
    fakeGoogle(ctx);
    const fetchGoogle = ctx.fetch;
    ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/events/') && (init?.method ?? 'GET') === 'GET') {
        await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { ...b.google!, accountId: main.id, accountEmail: main.email } }));
      }
      return fetchGoogle(input, init);
    }) as typeof fetch;
    const result = await reconcileBookings(ctx);
    expect(result.detached ?? 0).toBe(0);
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.google?.detached).toBeUndefined();
    expect(after.google?.accountId).toBe(main.id);
  });
});

describe('detached bookings and re-checked stamps (verify round)', () => {
  it('a cancelled detached booking says its event was left in an account that is gone, and deleting it writes nothing to Google', async () => {
    const ctx = await setup();
    const host = await setMain(ctx, OWNER, { email: A });
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    // Made before bookings recorded their account, then its main account was removed (and later another one
    // connected): detached, with no account id. The booking stays detached for good.
    void host;
    await updateBooking(ctx, booking.id, (b) => {
      const { accountId: _a, ...google } = b.google!;
      return { ...b, google: { ...google, accountEmail: A, detached: true } };
    });
    await cancelBooking(ctx, booking.id, { by: 'invitee' });
    await ctx.settle();
    const { calendarEventLeft } = await import('../../shared/calendar');
    const cancelled = (await getBooking(ctx, booking.id))!;
    expect(calendarEventLeft(cancelled)).toBe(`The event was in ${A}, which is no longer connected. Change or delete it in Google Calendar.`);
    const g = fakeGoogle(ctx);
    const { eraseBooking } = await import('../../server/lib/admin/bookings');
    await expect(eraseBooking(ctx, booking.id)).rejects.toMatchObject({ code: 'calendar_event_left' });
    expect(g.calls.filter((c) => c.kind.startsWith('event_'))).toEqual([]);
    expect((await eraseBooking(ctx, booking.id, { leaveCalendarEvent: true })).calendarEventLeft).toBe(true);
    expect(g.calls.filter((c) => c.kind.startsWith('event_'))).toEqual([]);
  });

  describe('deleting a cancelled booking that names no account, whose event was left on a calendar', () => {
    /** Cancelled, its event still on a calendar (the last try failed), and no account on the record. */
    async function leftUnstamped(ctx: TestCtx): Promise<Booking> {
      await setMain(ctx, OWNER, { email: A });
      await addExtra(ctx, OWNER, { email: B });
      fakeGoogle(ctx);
      const booking = await booked(ctx, wed('12:00'));
      await updateBooking(ctx, booking.id, (b) => {
        const { accountId: _a, accountEmail: _e, ...google } = b.google!;
        return { ...b, status: 'cancelled', cancellation: { at: NOW, by: 'invitee' }, google: { ...google, error: 'Google request failed (500)' } };
      });
      return (await getBooking(ctx, booking.id))!;
    }

    it('takes the event off through the extra account a read finds it in, and never through the main one', async () => {
      const ctx = await setup();
      const booking = await leftUnstamped(ctx);
      const g = fakeGoogle(ctx, { accounts: { [B]: { events: { [booking.google!.eventId]: eventFor(booking.id, wed('12:00'), wed('12:15')) } } } });
      const { eraseBooking } = await import('../../server/lib/admin/bookings');
      const result = await eraseBooking(ctx, booking.id);
      expect(result).toMatchObject({ found: true });
      expect(result.calendarEventLeft).toBeUndefined();
      expect(made(g, 'event_delete').map((c) => c.account)).toEqual([B]);
      expect(g.accounts[B].events![booking.google!.eventId].status).toBe('cancelled');
      // A was only read.
      expect(g.calls.filter((c) => c.account === A && c.kind !== 'event_get' && c.kind !== 'token')).toEqual([]);
      expect(await getBooking(ctx, booking.id)).toBeNull();
    });

    it('when no account holds it, deletes nothing anywhere and is refused with calendar_event_left, as before', async () => {
      const ctx = await setup();
      const booking = await leftUnstamped(ctx);
      const g = fakeGoogle(ctx);
      const { eraseBooking } = await import('../../server/lib/admin/bookings');
      await expect(eraseBooking(ctx, booking.id)).rejects.toMatchObject({ status: 409, code: 'calendar_event_left' });
      expect(made(g, 'event_delete')).toEqual([]);
      // Both were asked, read only.
      expect(made(g, 'event_get').map((c) => c.account).sort()).toEqual([A, B].sort());
      expect(await getBooking(ctx, booking.id)).not.toBeNull();
      // The owner can still let the event stay and delete the booking.
      expect((await eraseBooking(ctx, booking.id, { leaveCalendarEvent: true })).calendarEventLeft).toBe(true);
      expect(made(g, 'event_delete')).toEqual([]);
    });

    it('a booking that names its account is still deleted there without a read, as before', async () => {
      const ctx = await setup();
      await setMain(ctx, OWNER, { email: A });
      await addExtra(ctx, OWNER, { email: B });
      let g = fakeGoogle(ctx);
      const booking = await booked(ctx, wed('12:00'));
      await updateBooking(ctx, booking.id, (b) => ({ ...b, status: 'cancelled', cancellation: { at: NOW, by: 'invitee' }, google: { ...b.google!, error: 'Google request failed (500)' } }));
      const event = g.accounts[A].events![booking.google!.eventId];
      g = fakeGoogle(ctx, { accounts: { [A]: { events: { [booking.google!.eventId]: event } } } });
      const { eraseBooking } = await import('../../server/lib/admin/bookings');
      expect((await eraseBooking(ctx, booking.id)).found).toBe(true);
      expect(made(g, 'event_delete').map((c) => c.account)).toEqual([A]);
      expect(made(g, 'event_get')).toEqual([]);
    });
  });

  it('an unstamped booking whose host has a main account that needs a reconnect is not detached: the event may well be there', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    await addExtra(ctx, OWNER, { email: B });
    fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    await updateBooking(ctx, booking.id, (b) => {
      const { accountId: _a, accountEmail: _e, ...google } = b.google!;
      return { ...b, google };
    });
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: { ...h.google!, status: 'needs_reconnect' } }));
    // B answers that it does not have the event; A cannot be asked.
    const g = fakeGoogle(ctx);
    const result = await reconcileBookings(ctx);
    expect(result.detached ?? 0).toBe(0);
    expect((await getBooking(ctx, booking.id))!.google?.detached).toBeUndefined();
    expect(made(g, 'event_get').map((c) => c.account)).toEqual([B]);
  });

  it('a booking stamped with an account the host no longer has (an older deploy connected the main one again) is checked and stamped again', async () => {
    const ctx = await setup();
    const host = await setMain(ctx, OWNER, { email: A });
    const g = fakeGoogle(ctx);
    const booking = await booked(ctx, wed('12:00'));
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { ...b.google!, accountId: 'gacc_before_the_rollback' } }));
    fakeGoogle(ctx, { accounts: { [A]: { events: g.accounts[A].events } } });
    expect((await reconcileBookings(ctx)).stamped).toBe(1);
    expect((await getBooking(ctx, booking.id))!.google?.accountId).toBe(mainOf(host)!.account.id);
  });
});
