import { describe, expect, it } from 'vitest';
import type { Booking, CreateBookingRequest } from '../../shared/types';
import { handle } from '../../server/api';
import { createBooking } from '../../server/lib/booking';
import type { Env } from '../../server/lib/ctx';
import { getBooking, getSite, listJobs, updateHost } from '../../server/lib/repo';
import { computeTwilioSignature } from '../../server/lib/twilio';
import { startReminderCall } from '../../server/lib/voice';
import { routes } from '../../server/routes/webhooks';
import { apiRequest, makeTestCtx, type TestCtx } from '../helpers/ctx';

// ───────────────────────── fixtures ─────────────────────────

// Built at runtime so the fake id is not a literal that secret scanners flag.
const SID = 'AC' + '0123456789abcdef'.repeat(2);
const TOKEN = 'test-auth-token';
const CALL_SID = 'CA' + 'fedcba9876543210'.repeat(2);
/** What Twilio signs: the public address. What the function sees: the app's own host behind the proxy. */
const PUBLIC_API = 'https://jimicohen.com/meeting/api';
const INTERNAL_API = 'https://jimicohen-meeting.netlify.app/meeting/api';
/** Monday 09:00 UTC, which is inside calling hours for an invitee in London. */
const NOW = '2026-11-16T09:00:00.000Z';
const PHONE = '+14155552671';

const TWILIO_ENV: Partial<Env> = { overrides: { twilioAccountSid: SID, twilioAuthToken: TOKEN, twilioFromNumber: '+15005550006' } };

interface Sent {
  url: string;
  params: URLSearchParams;
}

async function setup(env: Partial<Env> = TWILIO_ENV): Promise<{ ctx: TestCtx; twilio: Sent[] }> {
  const twilio: Sent[] = [];
  const ctx = makeTestCtx({
    now: NOW,
    env,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.twilio.com/')) throw new Error(`Unexpected network call in a test: ${url}`);
      twilio.push({ url, params: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
      const sid = url.includes('/Calls') ? CALL_SID : 'SM' + '0'.repeat(32);
      return new Response(JSON.stringify({ sid, status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await getSite(ctx);
  await updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com' }));
  return { ctx, twilio };
}

async function book(ctx: TestCtx, over: Partial<CreateBookingRequest> = {}): Promise<Booking> {
  const { booking } = await createBooking(ctx, {
    slug: 'intro',
    start: '2026-11-18T14:00:00.000Z',
    durationMin: 15,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: PHONE,
    consent: { sms: true, call: true },
    timezone: 'Europe/London',
    elapsedMs: 5200,
    ...over,
  });
  await ctx.settle();
  return booking;
}

/**
 * A form post exactly as Twilio sends it: no Origin, no Referer, no X-Requested-With, a signature
 * over the PUBLIC address, delivered to the internal host.
 */
function twilioPost(path: string, form: Record<string, string>, signature?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TwilioProxy/1.1' };
  const sig = signature === undefined ? computeTwilioSignature(TOKEN, `${PUBLIC_API}${path}`, form) : signature;
  if (sig !== null) headers['x-twilio-signature'] = sig;
  return new Request(`${INTERNAL_API}${path}`, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const spoken = (xml: string): string => [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => unescapeXml(m[1])).join(' ');
const texted = (xml: string): string => unescapeXml(/<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1] ?? '');

// ───────────────────────── tests ─────────────────────────

describe('webhook route table', () => {
  it('holds exactly the two Twilio entry points', () => {
    expect(routes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['POST /twilio/voice/:step', 'POST /twilio/sms']);
  });

  it('answers 404 for an unknown call step and 405 for anything but POST', async () => {
    const { ctx } = await setup();
    const unknown = await handle(twilioPost('/twilio/voice/bogus?c=call_x', { CallSid: CALL_SID }), ctx);
    expect(unknown.status).toBe(404);
    for (const path of ['/twilio/voice/start', '/twilio/sms']) {
      const res = await handle(apiRequest('GET', path), ctx);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('POST /twilio/sms', () => {
  it('reaches the handler without any CSRF header and answers with TwiML', async () => {
    const { ctx } = await setup();
    const req = twilioPost('/twilio/sms', { From: '+14155550123', To: '+15005550006', Body: 'hello', AccountSid: SID });
    expect(req.headers.get('origin')).toBeNull();
    expect(req.headers.get('x-requested-with')).toBeNull();

    const res = await handle(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toBe('req_test');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(texted(xml)).toContain('We could not find an upcoming meeting for this number');
  });

  it('confirms the sender\'s next meeting when they answer C', async () => {
    const { ctx } = await setup();
    const booking = await book(ctx);
    const res = await handle(twilioPost('/twilio/sms', { From: PHONE, To: '+15005550006', Body: ' c ', AccountSid: SID }), ctx);
    expect(res.status).toBe(200);
    expect(texted(await res.text())).toMatch(/^Thanks Ada, you are confirmed for Intro call/);
    const stored = (await getBooking(ctx, booking.id))!;
    expect(stored.attendance).toEqual({ confirmedAt: NOW, confirmedVia: 'sms' });
    expect(stored.timeline.at(-1)).toMatchObject({ type: 'attendance_confirmed', detail: 'Confirmed by text message' });
  });

  it('refuses a request whose signature is missing, forged, made for another address or does not cover the body', async () => {
    const { ctx } = await setup();
    const booking = await book(ctx);
    const form = { From: PHONE, To: '+15005550006', Body: 'C', AccountSid: SID };
    const forgeries: (string | null)[] = [
      null,
      '',
      'mock',
      'bm90LWEtc2lnbmF0dXJl',
      computeTwilioSignature('another-token', `${PUBLIC_API}/twilio/sms`, form),
      computeTwilioSignature(TOKEN, 'https://evil.example/meeting/api/twilio/sms', form),
      computeTwilioSignature(TOKEN, `${PUBLIC_API}/twilio/voice/start`, form),
      computeTwilioSignature(TOKEN, `${PUBLIC_API}/twilio/sms`, { ...form, Body: 'something else' }),
    ];
    for (const signature of forgeries) {
      const res = await handle(twilioPost('/twilio/sms', form, signature), ctx);
      expect(res.status, String(signature)).toBe(403);
      expect(await res.text()).toBe('Forbidden');
    }
    expect((await getBooking(ctx, booking.id))?.attendance).toEqual({});
  });

  it('refuses everything when Twilio is not configured, and bodies that are not forms', async () => {
    const { ctx } = await setup({});
    const form = { From: PHONE, Body: 'C' };
    expect((await handle(twilioPost('/twilio/sms', form), ctx)).status).toBe(403);

    const configured = (await setup()).ctx;
    const json = new Request(`${INTERNAL_API}/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': 'x' }, body: '{}' });
    expect((await handle(json, configured)).status).toBe(400);
  });

  it('accepts the literal mock signature only next to mocked providers', async () => {
    const dev = (await setup({ ...TWILIO_ENV, mockProviders: true })).ctx;
    const res = await handle(twilioPost('/twilio/sms', { From: '+14155550123', Body: 'hi' }, 'mock'), dev);
    expect(res.status).toBe(200);
  });
});

describe('POST /twilio/voice/:step', () => {
  async function ringing(): Promise<{ ctx: TestCtx; booking: Booking; callId: string }> {
    const { ctx, twilio } = await setup();
    const booking = await book(ctx);
    const placed = await startReminderCall(ctx, { booking, purpose: 'reminder' });
    expect(placed).toMatchObject({ ok: true });
    const call = twilio.find((s) => s.url.includes('/Calls'))!;
    // Twilio is handed public webhook addresses, never the internal host.
    expect(call.params.get('Url')).toMatch(new RegExp(`^${PUBLIC_API.replace(/[.]/g, '\\.')}/twilio/voice/start\\?c=`));
    const callId = new URL(call.params.get('Url')!).searchParams.get('c')!;
    return { ctx, booking, callId };
  }

  it('walks a reminder call through the real handlers: greeting, "yes", confirmation, wrap-up', async () => {
    const { ctx, booking, callId } = await ringing();
    const base = { CallSid: CALL_SID, AccountSid: SID };

    const start = await handle(twilioPost(`/twilio/voice/start?c=${callId}`, { ...base, CallStatus: 'in-progress' }), ctx);
    expect(start.status).toBe(200);
    expect(start.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    const greeting = await start.text();
    expect(greeting).toContain('<Gather ');
    expect(greeting).toContain(`action="${PUBLIC_API}/twilio/voice/turn?c=${callId}`);
    expect(spoken(greeting)).toMatch(/^Hi Ada, this is Ava, an AI assistant calling for Jimi/);

    const turn = await handle(twilioPost(`/twilio/voice/turn?c=${callId}`, { ...base, Digits: '1' }), ctx);
    expect(turn.status).toBe(200);
    expect(spoken(await turn.text())).toMatch(/\S/);
    const confirmed = (await getBooking(ctx, booking.id))!;
    expect(confirmed.attendance).toEqual({ confirmedAt: NOW, confirmedVia: 'call' });

    const status = await handle(twilioPost(`/twilio/voice/status?c=${callId}`, { ...base, CallStatus: 'completed', CallDuration: '21' }), ctx);
    expect([200, 204]).toContain(status.status);
    await ctx.settle();
    const types = (await getBooking(ctx, booking.id))!.timeline.map((t) => t.type);
    expect(types).toContain('attendance_confirmed');
    expect(types.some((t) => t.startsWith('call_'))).toBe(true);
  });

  it('lets the assistant cancel only after the caller confirmed, through the real booking code', async () => {
    const { ctx, booking, callId } = await ringing();
    const base = { CallSid: CALL_SID, AccountSid: SID };
    await handle(twilioPost(`/twilio/voice/start?c=${callId}`, base), ctx);

    await handle(twilioPost(`/twilio/voice/turn?c=${callId}`, { ...base, Digits: '3' }), ctx);
    expect((await getBooking(ctx, booking.id))?.status).toBe('confirmed');

    await handle(twilioPost(`/twilio/voice/turn?c=${callId}`, { ...base, SpeechResult: 'yes, please cancel it' }), ctx);
    await ctx.settle();
    const cancelled = (await getBooking(ctx, booking.id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation?.by).toBe('assistant');
    // The reminders are gone; what is left, if anything, announces the cancellation.
    expect((await listJobs(ctx)).filter((j) => j.kind === 'reminder')).toEqual([]);
  });

  it('refuses every step without a valid signature and leaves the booking alone', async () => {
    const { ctx, booking, callId } = await ringing();
    const form = { CallSid: CALL_SID, AccountSid: SID, Digits: '3' };
    for (const step of ['start', 'turn', 'status', 'amd']) {
      const path = `/twilio/voice/${step}?c=${callId}`;
      const forgeries: (string | null)[] = [
        null,
        'mock',
        computeTwilioSignature('another-token', `${PUBLIC_API}${path}`, form),
        // Signed for another call.
        computeTwilioSignature(TOKEN, `${PUBLIC_API}/twilio/voice/${step}?c=call_someoneelse`, form),
        // Signed for the internal host instead of the public address.
        computeTwilioSignature(TOKEN, `${INTERNAL_API}${path}`, form),
      ];
      for (const signature of forgeries) {
        const res = await handle(twilioPost(path, form, signature), ctx);
        expect(res.status, `${step} ${String(signature)}`).toBe(403);
      }
    }
    expect((await getBooking(ctx, booking.id))).toMatchObject({ status: 'confirmed', attendance: {} });
  });

  it('answers a signed request for an unknown call politely', async () => {
    const { ctx } = await setup();
    const res = await handle(twilioPost('/twilio/voice/start?c=call_doesnotexist', { CallSid: CALL_SID, AccountSid: SID }), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Hangup/>');
  });
});

describe('browser-facing routes keep their own check', () => {
  it('does not let a signed Twilio form post reach a booking route', async () => {
    const { ctx } = await setup();
    const booking = await book(ctx);
    const form = { t: 'anything', CallSid: CALL_SID };
    for (const path of ['/public/bookings', `/public/bookings/${booking.id}/cancel`, `/public/bookings/${booking.id}/confirm`]) {
      const res = await handle(twilioPost(path, form), ctx);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error.code).toBe('csrf');
    }
    expect((await getBooking(ctx, booking.id))?.status).toBe('confirmed');
  });
});
