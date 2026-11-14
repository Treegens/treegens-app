import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src/lib/api';
import { ApiFailure } from '../../src/lib/api';

interface Seen {
  url: string;
  init: RequestInit;
}

let seen: Seen[] = [];
let next: () => Response = () => json({});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  seen = [];
  next = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return next();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  api.setUnauthorizedHandler(null);
});

const last = () => seen[seen.length - 1];
const body = () => JSON.parse(String(last().init.body));
const header = (name: string) => (last().init.headers as Record<string, string>)[name];

describe('request basics', () => {
  it('sends the CSRF header, same-origin credentials and JSON bodies', async () => {
    next = () => json({ booking: { id: 'b1' }, manageToken: 't' }, 201);
    const res = await api.createBooking({ slug: 'intro', start: '2026-11-17T11:30:00.000Z', durationMin: 30, name: 'A', email: 'a@b.co', timezone: 'UTC' });
    expect(res.manageToken).toBe('t');
    expect(last().url).toBe(`${api.API_BASE}/public/bookings`);
    expect(last().init.method).toBe('POST');
    expect(last().init.credentials).toBe('same-origin');
    expect(header('X-Requested-With')).toBe('meeting');
    expect(header('Content-Type')).toBe('application/json');
    expect(body().slug).toBe('intro');
  });

  it('does not send a body or content type on GET', async () => {
    await api.getPublicSite();
    expect(last().init.method).toBe('GET');
    expect(last().init.body).toBeUndefined();
    expect(header('Content-Type')).toBeUndefined();
    expect(header('X-Requested-With')).toBe('meeting');
  });

  it('turns error envelopes into ApiFailure', async () => {
    next = () => json({ error: { code: 'slot_taken', message: 'That time was just taken.' } }, 409);
    const err = await api.createBooking({ slug: 'x', start: 's', durationMin: 30, name: 'A', email: 'a@b.co', timezone: 'UTC' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ status: 409, code: 'slot_taken', message: 'That time was just taken.' });
    expect(api.isApiFailure(err, 'slot_taken')).toBe(true);
    expect(api.isApiFailure(err, 'other')).toBe(false);

    next = () => json({ error: { code: 'invalid', message: 'Check the form', fields: { email: 'Bad email' } } }, 422);
    const invalid = await api.login('x').catch((e) => e);
    expect(invalid.fields).toEqual({ email: 'Bad email' });
  });

  it('copes with non-JSON errors and network failures', async () => {
    next = () => new Response('<html>Bad gateway</html>', { status: 502 });
    const e1 = await api.getPublicSite().catch((e) => e);
    expect(e1).toMatchObject({ status: 502, code: 'http_error' });
    expect(e1.message).toMatch(/our side/);

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const e2 = await api.getPublicSite().catch((e) => e);
    expect(e2).toMatchObject({ status: 0, code: 'network' });
    expect(e2.isNetwork).toBe(true);
    expect(api.errorMessage(e2)).toMatch(/connection/);
    expect(api.errorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });

  it('passes aborts through untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('Aborted', 'AbortError'))));
    const e = await api.getPublicSite().catch((x) => x);
    expect(e).not.toBeInstanceOf(ApiFailure);
    expect(e.name).toBe('AbortError');
  });

  it('tells the shell when an admin call is unauthorized', async () => {
    const handler = vi.fn();
    api.setUnauthorizedHandler(handler);
    next = () => json({ error: { code: 'unauthorized', message: 'Sign in' } }, 401);
    await api.getBootstrap().catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await api.login('wrong').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles empty 204 answers', async () => {
    next = () => new Response(null, { status: 204 });
    await expect(api.deleteEventType('evt_1')).resolves.toBeUndefined();
    expect(last().init.method).toBe('DELETE');
    expect(last().url).toBe(`${api.API_BASE}/admin/event-types/evt_1`);
  });
});

describe('routes', () => {
  it('builds the slots query with ISO instants', async () => {
    next = () => json({ slots: [], durationMin: 30, hostTimezone: 'UTC' });
    await api.getSlots({ slug: 'intro', durationMin: 30, from: Date.UTC(2026, 10, 1), to: new Date(Date.UTC(2026, 11, 1)) });
    const url = new URL(last().url, 'http://x');
    expect(url.pathname).toBe(`${api.API_BASE}/public/slots`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ slug: 'intro', duration: '30', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' });

    await api.getSlots({ slug: 'intro', durationMin: 30, from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', rescheduleBookingId: 'bk_1', token: 'tok' });
    const q = new URL(last().url, 'http://x').searchParams;
    expect(q.get('reschedule')).toBe('bk_1');
    expect(q.get('t')).toBe('tok');
  });

  it('covers the public booking lifecycle', async () => {
    next = () => json({ booking: { id: 'bk 1', status: 'cancelled' } });
    await api.getBooking('bk 1', 'to/k');
    expect(last().url).toBe(`${api.API_BASE}/public/bookings/bk%201?t=to%2Fk`);
    const cancelled = await api.cancelBooking('bk 1', 'tok', 'Plans changed');
    expect(cancelled.status).toBe('cancelled');
    expect(last().url).toBe(`${api.API_BASE}/public/bookings/bk%201/cancel`);
    expect(body()).toEqual({ t: 'tok', reason: 'Plans changed' });
    await api.rescheduleBooking('b', 'tok', '2026-11-18T08:00:00.000Z', 'Europe/Paris');
    expect(body()).toEqual({ t: 'tok', start: '2026-11-18T08:00:00.000Z', timezone: 'Europe/Paris' });
    await api.confirmBooking('b', 'tok');
    expect(last().url).toBe(`${api.API_BASE}/public/bookings/b/confirm`);
    expect(body()).toEqual({ t: 'tok' });
    await api.getPublicEvent('intro call');
    expect(last().url).toBe(`${api.API_BASE}/public/event/intro%20call`);
  });

  it('accepts wrapped and bare entities', async () => {
    next = () => json({ site: { ownerHostId: 'h' } });
    expect((await api.saveSite({ profile: { headline: 'Hi' } })).ownerHostId).toBe('h');
    expect(last().init.method).toBe('PUT');
    next = () => json({ ownerHostId: 'bare' });
    expect((await api.saveSite({})).ownerHostId).toBe('bare');
    next = () => json({ hosts: [{ id: 'h1' }] });
    expect(await api.listHosts()).toHaveLength(1);
    next = () => json([{ id: 'h1' }, { id: 'h2' }]);
    expect(await api.listHosts()).toHaveLength(2);
    next = () => json({ calendars: [{ id: 'primary' }] });
    expect((await api.getHostCalendars('h1'))[0].id).toBe('primary');
    next = () => json({ eventType: { id: 'e1' } });
    expect((await api.duplicateEventType('e0')).id).toBe('e1');
    expect(last().url).toBe(`${api.API_BASE}/admin/event-types/e0/duplicate`);
  });

  it('hits the documented admin and auth paths', async () => {
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => api.getAuthState(), 'GET', '/auth/state'],
      [() => api.setup({ code: 'c', password: 'p'.repeat(10), deviceTimezone: 'UTC' }), 'POST', '/auth/setup'],
      [() => api.login('pw'), 'POST', '/auth/login'],
      [() => api.logout(), 'POST', '/auth/logout'],
      [() => api.changePassword('a', 'b'), 'POST', '/auth/password'],
      [() => api.getBootstrap(), 'GET', '/admin/bootstrap'],
      [() => api.getOverview(), 'GET', '/admin/overview'],
      [() => api.createEventType({ title: 'T' }), 'POST', '/admin/event-types'],
      [() => api.updateEventType('e1', { title: 'T' }), 'PUT', '/admin/event-types/e1'],
      [() => api.reorderEventTypes(['a', 'b']), 'PUT', '/admin/event-types-order'],
      [() => api.createHost({ name: 'N', email: 'n@e.co' }), 'POST', '/admin/hosts'],
      [() => api.updateHost('h1', { deviceTimezone: 'UTC' }), 'PUT', '/admin/hosts/h1'],
      [() => api.deleteHost('h1'), 'DELETE', '/admin/hosts/h1'],
      [() => api.regenerateInvite('h1'), 'POST', '/admin/hosts/h1/invite'],
      [() => api.disconnectGoogle('h1'), 'POST', '/admin/hosts/h1/google/disconnect'],
      [() => api.getAdminBooking('b1'), 'GET', '/admin/bookings/b1'],
      [() => api.adminCancelBooking('b1', 'r'), 'POST', '/admin/bookings/b1/cancel'],
      [() => api.setNoShow('b1', true), 'POST', '/admin/bookings/b1/no-show'],
      [() => api.getIntegrations(), 'GET', '/admin/integrations'],
      [() => api.saveIntegrations({ resend: { apiKey: 'k' } }), 'PUT', '/admin/integrations'],
      [() => api.testIntegration({ channel: 'email' }), 'POST', '/admin/integrations/test'],
      [() => api.uploadAsset('data:image/png;base64,AA', 'logo'), 'POST', '/admin/assets'],
      [() => api.deleteAsset('a1'), 'DELETE', '/admin/assets/a1'],
    ];
    for (const [call, method, path] of calls) {
      await call();
      expect(`${last().init.method} ${last().url}`).toBe(`${method} ${api.API_BASE}${path}`);
    }
    await api.listBookings({ scope: 'past', q: 'amina', limit: 20, offset: 40 });
    expect(last().url).toBe(`${api.API_BASE}/admin/bookings?scope=past&q=amina&limit=20&offset=40`);
    await api.getHostSelf('h1', 'tok');
    expect(last().url).toBe(`${api.API_BASE}/host/h1?t=tok`);
    await api.updateHostSelf('h1', 'tok', { name: 'N' });
    expect(`${last().init.method} ${last().url}`).toBe(`PUT ${api.API_BASE}/host/h1?t=tok`);
    await api.getHostSelfCalendars('h1', 'tok');
    expect(last().url).toBe(`${api.API_BASE}/host/h1/calendars?t=tok`);
  });

  it('builds plain URLs for links and redirects', () => {
    expect(api.bookingsCsvUrl()).toBe(`${api.API_BASE}/admin/bookings.csv`);
    expect(api.bookingsCsvUrl({ scope: 'cancelled', q: 'a b' })).toBe(`${api.API_BASE}/admin/bookings.csv?scope=cancelled&q=a+b`);
    expect(api.bookingIcsUrl('b1', 't k')).toBe(`${api.API_BASE}/public/bookings/b1/ics?t=t%20k`);
    expect(api.assetUrl('a1')).toBe(`${api.API_BASE}/assets/a1`);
    expect(api.assetUrl(null)).toBeNull();
    const url = new URL(api.googleConnectUrl({ hostId: 'h1', returnTo: '/meeting/admin/integrations', gmail: true, token: 'tok' }), 'http://x');
    expect(url.pathname).toBe(`${api.API_BASE}/google/connect`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ host: 'h1', gmail: '1', return: '/meeting/admin/integrations', t: 'tok' });
    expect(new URL(api.googleConnectUrl({ hostId: 'h1', returnTo: '/meeting/admin' }), 'http://x').searchParams.get('gmail')).toBe('0');
  });

  it('checks picked images before uploading', async () => {
    const big = { type: 'image/png', size: 4 * 1024 * 1024 } as File;
    await expect(api.uploadImageFile(big, 'logo')).rejects.toMatchObject({ status: 413 });
    const pdf = { type: 'application/pdf', size: 10 } as File;
    await expect(api.uploadImageFile(pdf, 'logo')).rejects.toMatchObject({ status: 422 });
    expect(seen).toHaveLength(0);
  });
});
