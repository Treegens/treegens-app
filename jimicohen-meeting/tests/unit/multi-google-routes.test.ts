/**
 * Many Google accounts per host, through the routes: the dashboard and the co-host page list every
 * account (and never a secret), change the calendars of one, preview and remove one; the OAuth routes add,
 * refresh and reconnect accounts, announce every change, refuse a replaced link, and stop at the ceiling.
 */
import { describe, expect, it } from 'vitest';
import { MAX_GOOGLE_ACCOUNTS_PER_HOST, defaultOwnerHost } from '../../shared/defaults';
import type { AdminBootstrap, AdminHost, AdminOverview, GoogleAccountRemoved, GoogleRemovalPreview, Host, HostSelfResponse } from '../../shared/types';
import { handle } from '../../server/api';
import { sessionSetCookie } from '../../server/lib/auth';
import { randomToken, sha256Hex } from '../../server/lib/crypto';
import type { Env } from '../../server/lib/ctx';
import { accountIdFor, accountsOf, mainOf } from '../../server/lib/googleAccounts';
import * as repo from '../../server/lib/repo';
import { TEST_BASE_URL, apiRequest, cookiePair, makeTestCtx, type TestCtx } from '../helpers/ctx';
import { addExtra, fakeGoogle, setMain } from '../helpers/google';

const OWNER = 'host_owner';
const ALEX = 'host_alex';
const NOW = '2026-11-16T09:00:00.000Z';
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const GOOGLE_ENV: Partial<Env> = { overrides: { googleClientId: CLIENT_ID, googleClientSecret: 'client-secret' } };
const A = 'jimi@gmail.example';
const B = 'jimi@work.example';

interface World {
  ctx: TestCtx;
  cookie: string;
  alexToken: string;
}

async function world(): Promise<World> {
  const ctx = makeTestCtx({ now: NOW, env: GOOGLE_ENV });
  await repo.getSite(ctx);
  await repo.updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com', googleExtra: [] }));
  await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used', passwordVersion: 1, setupUsedAt: NOW });
  const alexToken = randomToken(24);
  await repo.saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com', googleExtra: [], inviteTokenHash: sha256Hex(alexToken) });
  return { ctx, cookie: cookiePair(sessionSetCookie(ctx, 1)), alexToken };
}

function call(w: World, method: string, path: string, body?: unknown, opts: { cookie?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
  return handle(apiRequest(method, path, { body, cookie: opts.cookie === null ? undefined : (opts.cookie ?? w.cookie), origin: opts.origin, headers: opts.headers }), w.ctx);
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const link = (w: World, path: string): string => `/host/${ALEX}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(w.alexToken)}`;

/** Starts a connection from one of the app's pages, and returns the state and the browser's cookie. */
async function begin(w: World, query: Record<string, string>, asCoHost = false): Promise<{ state: string; cookie: string }> {
  const params = new URLSearchParams({ host: OWNER, ...query });
  if (asCoHost) params.set('t', w.alexToken);
  const res = await handle(apiRequest('GET', `/google/connect?${params.toString()}`, { cookie: asCoHost ? undefined : w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
  expect(res.status, await res.clone().text()).toBe(302);
  const location = new URL(res.headers.get('location')!);
  return { state: location.searchParams.get('state')!, cookie: cookiePair(res.headers.get('set-cookie')!) };
}

async function finish(w: World, started: { state: string; cookie: string }, email: string): Promise<URL> {
  const res = await handle(apiRequest('GET', `/google/callback?${new URLSearchParams({ state: started.state, code: `c:${email}` }).toString()}`, { cookie: started.cookie }), w.ctx);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

async function notices(w: World): Promise<{ hostId?: string; subject?: string; body?: string }[]> {
  return (await repo.listJobs(w.ctx)).filter((j) => j.kind === 'host_alert') as { hostId?: string; subject?: string; body?: string }[];
}

// ───────────────────────── the screens' routes ─────────────────────────

describe('accounts on the dashboard and the co-host page', () => {
  it('lists every account of every host, and never a token, a sealed value or Google\'s account id', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    await addExtra(w.ctx, OWNER, { email: B });
    await addExtra(w.ctx, ALEX, { email: 'alex@work.example' }, );
    const stored = (await repo.getHost(w.ctx, OWNER))!;
    const b = await ok<AdminBootstrap>(call(w, 'GET', '/admin/bootstrap'));
    const owner = b.hosts.find((h) => h.id === OWNER)!;
    expect(owner.google).toMatchObject({ id: mainOf(stored)!.account.id, email: A });
    expect(owner.googleExtra).toEqual([{ id: stored.googleExtra![0].id, email: B, status: 'ok', busyCalendarIds: ['primary'], connectedAt: NOW, health: null }]);
    const self = await ok<HostSelfResponse>(call(w, 'GET', link(w, ''), undefined, { cookie: null }));
    expect(self.host.googleExtra!.map((a) => a.email)).toEqual(['alex@work.example']);
    for (const text of [JSON.stringify(b), JSON.stringify(self), await (await call(w, 'GET', '/admin/hosts')).text()]) {
      for (const secret of ['refreshTokenEnc', stored.googleExtra![0].refreshTokenEnc, `sub-${B}`, '"sub"', 'scopes']) expect(text.includes(secret), secret).toBe(false);
    }
  });

  it('changes the calendars of one account, main or extra, and refuses an empty choice or an unknown account', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const host = await addExtra(w.ctx, OWNER, { email: B });
    const [main, extra] = accountsOf(host);
    const saved = await ok<{ host: AdminHost }>(call(w, 'PUT', `/admin/hosts/${OWNER}`, { googleCalendars: { accountId: extra.account.id, busyCalendarIds: ['primary', 'team@group'] } }));
    expect(saved.host.googleExtra![0].busyCalendarIds).toEqual(['primary', 'team@group']);
    expect(saved.host.google!.busyCalendarIds).toEqual(['primary']);
    await ok(call(w, 'PUT', `/admin/hosts/${OWNER}`, { googleCalendars: { accountId: main.account.id, busyCalendarIds: ['primary', 'family@group'] } }));
    expect((await repo.getHost(w.ctx, OWNER))!.google!.busyCalendarIds).toEqual(['primary', 'family@group']);
    const empty = await call(w, 'PUT', `/admin/hosts/${OWNER}`, { googleCalendars: { accountId: extra.account.id, busyCalendarIds: [] } });
    expect(empty.status).toBe(422);
    expect((await empty.json()).error.fields).toMatchObject({ 'googleCalendars.busyCalendarIds': 'Tick at least one calendar of this account, or remove the account.' });
    const unknown = await call(w, 'PUT', `/admin/hosts/${OWNER}`, { googleCalendars: { accountId: 'gacc_nobody', busyCalendarIds: ['primary'] } });
    expect((await unknown.json()).error.fields).toHaveProperty(['googleCalendars.accountId']);
    // compat: the fields of old still change the main account, [] included (a tab opened before the deploy).
    await ok(call(w, 'PUT', `/admin/hosts/${OWNER}`, { busyCalendarIds: [], writeCalendarId: 'family@group' }));
    expect((await repo.getHost(w.ctx, OWNER))!.google).toMatchObject({ busyCalendarIds: [], writeCalendarId: 'family@group' });
  });

  it('lists, previews and removes one account, and an account of another host is not found on either page', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const host = await addExtra(w.ctx, OWNER, { email: B });
    const alex = await addExtra(w.ctx, ALEX, { email: 'alex@work.example' });
    const extra = accountsOf(host)[1].account;
    const alexExtra = accountsOf(alex)[0].account;
    const g = fakeGoogle(w.ctx);

    const cals = await ok<{ calendars: { id: string }[] }>(call(w, 'GET', `/admin/hosts/${OWNER}/google/${extra.id}/calendars`));
    expect(cals.calendars.map((c) => c.id)).toEqual([B]);
    expect(g.calls.filter((c) => c.kind === 'calendar_list').map((c) => c.account)).toEqual([B]);
    const own = await ok<{ calendars: { id: string }[] }>(call(w, 'GET', link(w, `/google/${alexExtra.id}/calendars`), undefined, { cookie: null }));
    expect(own.calendars.map((c) => c.id)).toEqual(['alex@work.example']);

    for (const path of [`/google/${extra.id}/calendars`, `/google/${extra.id}/removal`]) {
      expect((await call(w, 'GET', link(w, path), undefined, { cookie: null })).status).toBe(404);
    }
    expect((await call(w, 'DELETE', link(w, `/google/${extra.id}`), undefined, { cookie: null })).status).toBe(404);
    expect((await call(w, 'GET', `/admin/hosts/${ALEX}/google/${extra.id}/removal`)).status).toBe(404);

    const preview = await ok<GoogleRemovalPreview>(call(w, 'GET', `/admin/hosts/${OWNER}/google/${extra.id}/removal`));
    expect(preview).toEqual({ main: false, email: B, upcomingEvents: 0 });
    const mainPreview = await ok<GoogleRemovalPreview>(call(w, 'GET', `/admin/hosts/${OWNER}/google/${mainOf(host)!.account.id}/removal`));
    expect(mainPreview).toMatchObject({ main: true, email: A, upcomingEvents: 0, extrasKeepBlocking: 1 });

    const removed = await ok<GoogleAccountRemoved>(call(w, 'DELETE', `/admin/hosts/${OWNER}/google/${extra.id}`));
    expect(removed).toMatchObject({ ok: true, removed: { id: extra.id, email: B, main: false }, effects: { detached: 0 } });
    expect(removed.host.googleExtra).toEqual([]);
    expect(g.calls.filter((c) => c.kind === 'revoke').map((c) => c.account)).toEqual([B]);

    // The co-host removes their own, from their link, and only from this app's pages.
    expect((await call(w, 'DELETE', link(w, `/google/${alexExtra.id}`), undefined, { cookie: null, origin: 'https://evil.example' })).status).toBe(403);
    const mine = await ok<GoogleAccountRemoved>(call(w, 'DELETE', link(w, `/google/${alexExtra.id}`), undefined, { cookie: null }));
    expect(mine.removed.email).toBe('alex@work.example');
    expect(mine.host.googleExtra).toEqual([]);
  });

  it('warns once per host, naming the account, when only an extra account needs a reconnect', async () => {
    const w = await world();
    await repo.saveSecrets(w.ctx, { google: { clientId: CLIENT_ID, clientSecret: 'client-secret' } });
    await setMain(w.ctx, OWNER, { email: A });
    await addExtra(w.ctx, OWNER, { email: B, status: 'needs_reconnect' });
    await setMain(w.ctx, ALEX, { email: 'alex@gmail.example' });
    await addExtra(w.ctx, ALEX, { email: 'alex@work.example', status: 'needs_reconnect' });
    const o = await ok<AdminOverview>(call(w, 'GET', '/admin/overview'));
    const mine = o.warnings.filter((x) => x.key === 'google_reconnect_host_owner');
    expect(mine).toHaveLength(1);
    // An extra account receives no meetings and sends no email: only the times are said to stop.
    expect(mine[0].message).toBe('Your Google account jimi@work.example needs to be reconnected. Until then, no times are offered for meetings with you.');
    expect(o.warnings.find((x) => x.key === `google_reconnect_${ALEX}`)!.message).toBe(
      "Alex's Google account alex@work.example needs to be reconnected. Until then, times that include Alex are not offered. Ask Alex to open their private link and reconnect it.",
    );
    expect(o.checklist.find((c) => c.key === 'google')!.done).toBe(true);
  });

  it('checks one account, or every account with a line for each', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const host = await addExtra(w.ctx, OWNER, { email: B });
    await addExtra(w.ctx, OWNER, { email: 'jimi@old.example', status: 'needs_reconnect' });
    fakeGoogle(w.ctx, { accounts: { [A]: { busy: [['2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z']] } } });
    const all = await ok<{ ok: boolean; detail: string }>(call(w, 'POST', '/admin/integrations/test', { channel: 'google' }));
    expect(all).toEqual({ ok: false, detail: 'jimi@gmail.example: 1 busy block in the next 7 days. jimi@work.example: 0 busy blocks. jimi@old.example needs to be reconnected.' });
    const one = await ok<{ ok: boolean; detail: string }>(call(w, 'POST', '/admin/integrations/test', { channel: 'google', accountId: accountsOf(host)[1].account.id }));
    expect(one).toEqual({ ok: true, detail: 'jimi@work.example: 0 busy blocks in the next 7 days.' });
  });
});

// ───────────────────────── connecting ─────────────────────────

describe('the OAuth routes with many accounts', () => {
  it('the owner adds an account from the dashboard: added, named by id in the return, and no notice to themselves', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await finish(w, await begin(w, {}), A);
    const back = await finish(w, await begin(w, { add: '1' }), B);
    expect(back.searchParams.get('google')).toBe('connected');
    expect(back.searchParams.get('gresult')).toBe('added');
    expect(back.searchParams.get('gaccount')).toBe(accountIdFor(OWNER, `sub-${B}`));
    expect(back.href).not.toContain('jimi%40');
    const host = (await repo.getHost(w.ctx, OWNER))!;
    expect(host.google!.email).toBe(A);
    expect(host.googleExtra!.map((a) => a.email)).toEqual([B]);
    expect(await notices(w)).toEqual([]);
  });

  it('adding asks Google for its account chooser and sends no hint', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const res = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&add=1`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
    const google = new URL(res.headers.get('location')!);
    expect(google.searchParams.get('prompt')).toBe('consent select_account');
    expect(google.searchParams.get('login_hint')).toBeNull();
  });

  it('a co-host adding an account from their link: the co-host and the owner are both told, naming the address', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await finish(w, await begin(w, { host: ALEX }, true), 'alex@gmail.example');
    const back = await finish(w, await begin(w, { host: ALEX, add: '1' }, true), 'alex@work.example');
    expect(back.pathname).toBe('/meeting/host/host_alex');
    expect(back.searchParams.get('gresult')).toBe('added');
    expect((await repo.getHost(w.ctx, ALEX))!.googleExtra!.map((a) => a.email)).toEqual(['alex@work.example']);
    const sent = await notices(w);
    const toAlex = sent.filter((j) => j.hostId === ALEX);
    const toOwner = sent.filter((j) => j.hostId === OWNER);
    expect(toAlex.map((j) => j.subject)).toEqual(['A Google account was connected to your booking page', 'A Google account was connected to your booking page']);
    const aboutWork = toAlex.find((j) => j.body?.includes('alex@work.example'))!;
    expect(aboutWork.body).toContain('alex@work.example was connected on 16 November');
    expect(aboutWork.body).toContain('from your private link');
    expect(toOwner.map((j) => j.subject)).toEqual(['Alex connected another Google account', 'Alex connected another Google account']);
    expect(toOwner.some((j) => j.body?.includes('Alex connected alex@work.example on'))).toBe(true);
    for (const j of sent) expect(`${j.subject} ${j.body}`).not.toContain('—');
  });

  it('the owner adding an account for a co-host is allowed (compat), and the co-host is told', async () => {
    const w = await world();
    await setMain(w.ctx, ALEX, { email: 'alex@gmail.example' });
    fakeGoogle(w.ctx);
    const back = await finish(w, await begin(w, { host: ALEX, add: '1', return: '/meeting/admin/team' }), 'alex@work.example');
    expect(back.searchParams.get('gresult')).toBe('added');
    const sent = await notices(w);
    expect(sent.map((j) => j.hostId)).toEqual([ALEX]);
    expect(sent[0].body).toContain('Jimi connected alex@work.example to your booking page.');
  });

  it('a link replaced while the person was at Google finishes nothing, before any code is exchanged', async () => {
    const w = await world();
    const g = fakeGoogle(w.ctx);
    const started = await begin(w, { host: ALEX, add: '1' }, true);
    await ok(call(w, 'POST', `/admin/hosts/${ALEX}/invite`, {}));
    const back = await finish(w, started, 'alex@work.example');
    expect(back.searchParams.get('google')).toBe('error');
    expect(back.searchParams.get('reason')).toBe('This private link was replaced while you were at Google. Open the new link and connect again.');
    expect(g.calls.filter((c) => c.kind === 'token')).toEqual([]);
    expect(accountsOf((await repo.getHost(w.ctx, ALEX))!)).toEqual([]);
  });

  it('reconnecting one account and picking another at Google: that one is connected, the first is left as it was, and the page is told', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const host = await addExtra(w.ctx, OWNER, { email: B, status: 'needs_reconnect' });
    const b = accountsOf(host)[1].account;
    fakeGoogle(w.ctx);
    const res = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&account=${b.id}`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
    expect(new URL(res.headers.get('location')!).searchParams.get('login_hint')).toBe(B);
    const back = await finish(w, { state: new URL(res.headers.get('location')!).searchParams.get('state')!, cookie: cookiePair(res.headers.get('set-cookie')!) }, 'someone@else.example');
    expect(back.searchParams.get('gnote')).toBe('other_account');
    expect(back.searchParams.get('gwanted')).toBe(b.id);
    expect(back.searchParams.get('gaccount')).toBe(accountIdFor(OWNER, 'sub-someone@else.example'));
    const after = (await repo.getHost(w.ctx, OWNER))!;
    expect(accountsOf(after).find((a) => a.account.id === b.id)!.account.status).toBe('needs_reconnect');
  });

  it(`stops at ${MAX_GOOGLE_ACCOUNTS_PER_HOST} accounts: 409, and on the page when the browser navigated there`, async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    for (let i = 1; i < MAX_GOOGLE_ACCOUNTS_PER_HOST; i++) await addExtra(w.ctx, OWNER, { email: `n${i}@x.example` });
    const json = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&add=1`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
    expect(json.status).toBe(409);
    expect((await json.json()).error.code).toBe('too_many_google_accounts');
    const page = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&add=1`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' } }), w.ctx);
    const back = new URL(page.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(`${TEST_BASE_URL}/admin/integrations`);
    expect(back.searchParams.get('reason')).toBe(`You have connected ${MAX_GOOGLE_ACCOUNTS_PER_HOST} Google accounts, the most one person can connect here. Remove one to add another.`);
  });

  it('"Use a different Google account" replaces the main one (compat), detaches its upcoming bookings and tells a co-host', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await finish(w, await begin(w, { host: ALEX }, true), 'alex@gmail.example');
    const alex = (await repo.getHost(w.ctx, ALEX))!;
    const old = mainOf(alex)!.account;
    await repo.saveBooking(w.ctx, {
      id: 'bkg_before',
      hostIds: [ALEX],
      status: 'confirmed',
      start: '2026-11-18T12:00:00.000Z',
      end: '2026-11-18T12:30:00.000Z',
      google: { hostId: ALEX, accountId: old.id, accountEmail: old.email, calendarId: 'primary', eventId: 'mtgbefore' },
      timeline: [],
    } as never);
    await repo.mutateBookingIndex(w.ctx, (list) => [...list, { id: 'bkg_before', start: '2026-11-18T12:00:00.000Z', end: '2026-11-18T12:30:00.000Z', hostIds: [ALEX], eventTypeId: 'evt_intro', status: 'confirmed', inviteeName: 'Ada', inviteeEmail: 'ada@example.com', eventTitle: 'Intro' }]);
    const back = await finish(w, await begin(w, { host: ALEX, switch: '1' }, true), 'alex@right.example');
    expect(back.searchParams.get('gresult')).toBe('replaced');
    expect((await repo.getHost(w.ctx, ALEX))!.google!.email).toBe('alex@right.example');
    expect((await repo.getBooking(w.ctx, 'bkg_before'))!.google).toMatchObject({ detached: true, accountEmail: 'alex@gmail.example' });
    const told = (await notices(w)).filter((j) => j.subject === 'Your new meetings go to another Google account');
    expect(told[0].body).toContain('alex@right.example is now where your new meetings are added. It replaced alex@gmail.example.');
  });

  it('the plain Connect button with a main account in place adds another account and replaces nothing', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await finish(w, await begin(w, {}), A);
    await repo.updateHost(w.ctx, OWNER, (h) => ({ ...h, timezoneMode: 'device', email: '' }));
    const back = await finish(w, await begin(w, {}), B);
    expect(back.searchParams.get('gresult')).toBe('added');
    expect(back.searchParams.get('gnote')).toBe('other_account');
    const host = (await repo.getHost(w.ctx, OWNER))!;
    expect(host.google!.email).toBe(A);
    expect(host.googleExtra!.map((a) => a.email)).toEqual([B]);
    // Another account never moves the zone or takes over the address.
    expect(host.timezoneMode).toBe('device');
    expect(host.email).toBe('');
  });

  it('compat: the first account of a host still switches a device zone to Google and gives an owner without an address that one', async () => {
    const w = await world();
    await repo.updateHost(w.ctx, OWNER, (h) => ({ ...h, email: '' }));
    fakeGoogle(w.ctx, { accounts: { [A]: { zone: 'Europe/Berlin' } } });
    const back = await finish(w, await begin(w, {}), A);
    expect(back.searchParams.get('gresult')).toBe('first');
    expect((await repo.getHost(w.ctx, OWNER))!).toMatchObject({ timezoneMode: 'google', timezone: 'Europe/Berlin', email: A });
  });
});

// ───────────────────────── verify round ─────────────────────────

describe('every account counts on Home, on Team and when a co-host goes', () => {
  it('deleting a co-host hands back every Google grant of theirs that nothing else holds', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    await setMain(w.ctx, ALEX, { email: 'alex@gmail.example' });
    await addExtra(w.ctx, ALEX, { email: 'alex@work.example' });
    // The owner's own Google account, connected on Alex's record too: its grant is the owner's as well.
    await addExtra(w.ctx, ALEX, { email: A });
    const g = fakeGoogle(w.ctx);
    await ok(call(w, 'DELETE', `/admin/hosts/${ALEX}`));
    expect(await repo.getHost(w.ctx, ALEX)).toBeNull();
    expect(g.calls.filter((c) => c.kind === 'revoke').map((c) => c.account).sort()).toEqual(['alex@gmail.example', 'alex@work.example']);
  });

  it('adding an account never asks for Gmail, even when the page asks; the main account still can', async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const scopeOf = async (query: string): Promise<string> => {
      const res = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&${query}`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
      expect(res.status).toBe(302);
      return new URL(res.headers.get('location')!).searchParams.get('scope')!;
    };
    expect(await scopeOf('add=1&gmail=1')).not.toContain('gmail');
    expect(await scopeOf('gmail=1')).toContain('https://www.googleapis.com/auth/gmail.send');
  });

  it("reconnecting the owner's main account asks for Gmail again by itself when it sends the emails; another account's reconnect never does", async () => {
    const w = await world();
    const host = await setMain(w.ctx, OWNER, { email: A, gmailSend: true });
    const withExtra = await addExtra(w.ctx, OWNER, { email: B });
    const scopeOf = async (accountId: string): Promise<string> => {
      const res = await handle(apiRequest('GET', `/google/connect?host=${OWNER}&account=${accountId}`, { cookie: w.cookie, headers: { 'sec-fetch-site': 'same-origin' } }), w.ctx);
      expect(res.status).toBe(302);
      return new URL(res.headers.get('location')!).searchParams.get('scope')!;
    };
    expect(await scopeOf(mainOf(host)!.account.id)).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(await scopeOf(accountsOf(withExtra)[1].account.id)).not.toContain('gmail');
  });

  it("a sign-in from a co-host's page started by the previous deploy (no link mark) finishes only while the co-host still has a link", async () => {
    const w = await world();
    const g = fakeGoogle(w.ctx);
    const { buildGoogleAuthUrl, readGoogleState } = await import('../../server/lib/google');
    const url = await buildGoogleAuthUrl(w.ctx, { hostId: ALEX, returnTo: `/meeting/host/${ALEX}?t=${encodeURIComponent(w.alexToken)}`, intent: 'extra' });
    const state = new URL(url).searchParams.get('state')!;
    expect(readGoogleState(w.ctx, state)?.lt).toBeUndefined();
    await repo.updateHost(w.ctx, ALEX, (h) => ({ ...h, inviteTokenHash: null }));
    const back = await finish(w, { state, cookie: `mtg_gstate=${readGoogleState(w.ctx, state)!.nonce}` }, 'alex@work.example');
    expect(back.searchParams.get('reason')).toBe('This private link was replaced while you were at Google. Open the new link and connect again.');
    expect(g.calls.filter((c) => c.kind === 'token')).toEqual([]);
  });

  it("a work account whose Google admin does not allow the app is said plainly, and nothing is stored", async () => {
    const w = await world();
    await setMain(w.ctx, OWNER, { email: A });
    const g = fakeGoogle(w.ctx);
    const started = await begin(w, { add: '1' });
    const res = await handle(apiRequest('GET', `/google/callback?${new URLSearchParams({ state: started.state, error: 'admin_policy_enforced' })}`, { cookie: started.cookie }), w.ctx);
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('google')).toBe('error');
    expect(back.searchParams.get('reason')).toBe("Your organisation's Google admin does not allow this app for that account. Ask them to allow it, or connect another account.");
    expect(g.calls.filter((c) => c.kind === 'token')).toEqual([]);
    expect((await repo.getHost(w.ctx, OWNER))!.googleExtra).toEqual([]);
  });

  it('Home: other accounts alone are a calendar, and an end date on one of them is named', async () => {
    const w = await world();
    await addExtra(w.ctx, OWNER, { email: B });
    let o = await ok<AdminOverview>(call(w, 'GET', '/admin/overview'));
    expect(o.warnings.map((x) => x.key)).not.toContain('google_not_connected');
    await setMain(w.ctx, OWNER, { email: A });
    await addExtra(w.ctx, OWNER, { email: 'jimi@testing.example', refreshExpiresAt: '2026-11-20T09:00:00.000Z' });
    o = await ok<AdminOverview>(call(w, 'GET', '/admin/overview'));
    const ending = o.warnings.filter((x) => x.key === 'google_expiry_host_owner');
    expect(ending).toHaveLength(1);
    expect(ending[0].message).toContain('for jimi@testing.example ends on');
    expect(ending[0].message).not.toContain(A);
  });

  it('Home: with the Google keys gone, every account of everyone is counted, a co-host with only other accounts included', async () => {
    const ctx = makeTestCtx({ now: NOW });
    await repo.getSite(ctx);
    await repo.updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com', googleExtra: [] }));
    await repo.saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com', googleExtra: [] });
    await setMain(ctx, OWNER, { email: A });
    await addExtra(ctx, OWNER, { email: B });
    await addExtra(ctx, OWNER, { email: 'jimi@eco.example' });
    await addExtra(ctx, ALEX, { email: 'alex@work.example' });
    await addExtra(ctx, ALEX, { email: 'alex@old.example' });
    const { buildOverview } = await import('../../server/lib/admin/overview');
    const o = await buildOverview(ctx);
    expect(o.warnings.find((x) => x.key === 'google_keys_missing')?.message).toBe(
      "The Google keys were removed, so your 3 Google accounts and Alex's 2 cannot be read and no times are offered for meetings with you. Add the same client ID and client secret again under Integrations.",
    );
  });

  it('a co-host adding the same account again on the same day, after removing it, is announced once', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await finish(w, await begin(w, { host: ALEX }, true), 'alex@gmail.example');
    await finish(w, await begin(w, { host: ALEX, add: '1' }, true), 'alex@work.example');
    const work = accountsOf((await repo.getHost(w.ctx, ALEX))!).find((a) => a.account.email === 'alex@work.example')!.account;
    await ok(call(w, 'DELETE', link(w, `/google/${work.id}`), undefined, { cookie: null }));
    await finish(w, await begin(w, { host: ALEX, add: '1' }, true), 'alex@work.example');
    const aboutWork = (await notices(w)).filter((j) => j.body?.includes('alex@work.example'));
    expect(aboutWork.map((j) => j.hostId).sort()).toEqual([ALEX, OWNER].sort());
  });
});

describe('grants and warnings across the accounts of one host (verify round)', () => {
  it('removing another entry of the same Google account as the main one keeps the grant: the main account still uses it', async () => {
    const w = await world();
    // The main account as stored before Google's account id was kept, and the same account again as another one.
    await setMain(w.ctx, OWNER, { email: A, id: undefined, sub: undefined });
    const host = await addExtra(w.ctx, OWNER, { email: A, busyCalendarIds: ['family@group'] });
    const extra = accountsOf(host).find((a) => !a.main)!.account;
    const g = fakeGoogle(w.ctx);
    await ok(call(w, 'DELETE', `/admin/hosts/${OWNER}/google/${extra.id}`));
    expect(g.calls.filter((c) => c.kind === 'revoke')).toEqual([]);
    expect((await repo.getHost(w.ctx, OWNER))!.google?.email).toBe(A);
  });

  it('without email, a meeting whose host has only other accounts, one of them broken, is not said to reach nobody (its times are closed)', async () => {
    const w = await world();
    const host = await addExtra(w.ctx, OWNER, { email: B, status: 'needs_reconnect' });
    let o = await ok<AdminOverview>(call(w, 'GET', '/admin/overview'));
    expect(o.warnings.map((x) => x.key)).not.toContain('bookings_reach_nobody');
    expect(o.warnings.map((x) => x.key)).toContain('google_reconnect_host_owner');
    // Control: once it can be read, people can book, and nobody hears about it.
    await repo.updateHost(w.ctx, OWNER, (h) => ({ ...h, googleExtra: (h.googleExtra ?? []).map((a) => (a.id === accountsOf(host)[0].account.id ? { ...a, status: 'ok' as const } : a)) }));
    o = await ok<AdminOverview>(call(w, 'GET', '/admin/overview'));
    expect(o.warnings.map((x) => x.key)).toContain('bookings_reach_nobody');
  });
});

void (null as unknown as Host);
