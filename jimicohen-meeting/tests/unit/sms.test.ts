import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '../../shared/types';

// booking.ts and jobs.ts belong to other engineers: only their contract is used here.
vi.mock('../../server/lib/booking', () => ({
  confirmAttendance: vi.fn(async () => ({})),
  cancelBooking: vi.fn(async () => ({})),
  manageToken: vi.fn((_ctx: unknown, id: string) => `tok-${id}`),
}));
vi.mock('../../server/lib/jobs', () => ({
  enqueueJob: vi.fn(async (_ctx: unknown, job: Record<string, unknown>) => ({ ...job, id: 'job_1', key: 'jobs/x', attempt: 0, createdAt: '' })),
  runDueJobs: vi.fn(async () => ({ processed: 0, failed: 0, remaining: 0 })),
}));

import { confirmAttendance } from '../../server/lib/booking';
import { enqueueJob } from '../../server/lib/jobs';
import { getBooking, indexEntryOf, mutateBookingIndex, saveBooking, saveSecrets } from '../../server/lib/repo';
import { handleInboundSms, sendSms, SMS_BODY_LIMIT } from '../../server/lib/sms';
import { computeTwilioSignature, isNumberBlocked } from '../../server/lib/twilio';
import { makeTestCtx, TEST_NOW, type TestCtx } from '../helpers/ctx';

const confirm = vi.mocked(confirmAttendance);
const enqueue = vi.mocked(enqueueJob);

// Built at runtime so the fake id is not a literal that secret scanners flag.
const SID = 'AC' + '0123456789abcdef'.repeat(2);
const TOKEN = 'test-auth-token';
const PUBLIC_SMS_URL = 'https://jimicohen.com/meeting/api/twilio/sms';
const INTERNAL_SMS_URL = 'https://jimicohen-meeting.netlify.app/meeting/api/twilio/sms';

function makeBooking(id: string, patch: Partial<Booking> = {}): Booking {
  return {
    id,
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: '2026-11-17T20:30:00.000Z',
    end: '2026-11-17T21:00:00.000Z',
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', phone: '+14155552671', timezone: 'America/New_York' },
    guests: [],
    answers: [],
    location: { type: 'google_meet', label: 'Google Meet' },
    consent: { sms: true, call: true, at: TEST_NOW, text: 'ok' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...patch,
  };
}

async function store(ctx: TestCtx, booking: Booking): Promise<Booking> {
  const saved = await saveBooking(ctx, booking);
  await mutateBookingIndex(ctx, (entries) => [...entries.filter((e) => e.id !== saved.id), indexEntryOf(saved)]);
  return saved;
}

async function configured(opts: Parameters<typeof makeTestCtx>[0] = {}, twilio: Record<string, string> = {}): Promise<TestCtx> {
  const ctx = makeTestCtx(opts);
  await saveSecrets(ctx, { twilio: { accountSid: SID, authToken: TOKEN, fromNumber: '+15005550006', ...twilio } });
  return ctx;
}

function fakeTwilio(respond: (params: URLSearchParams) => Response = () => Response.json({ sid: 'SM0001' }, { status: 201 })) {
  const calls: { url: string; params: URLSearchParams }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const params = new URLSearchParams(String(init.body ?? ''));
    calls.push({ url: String(input), params });
    return respond(params);
  }) as typeof fetch;
  return { calls, impl };
}

function inbound(form: Record<string, string>, signature?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const sig = signature === undefined ? computeTwilioSignature(TOKEN, PUBLIC_SMS_URL, form) : signature;
  if (sig !== null) headers['x-twilio-signature'] = sig;
  return new Request(INTERNAL_SMS_URL, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
}

function messageOf(xml: string): string | null {
  const m = /<Message>([\s\S]*)<\/Message>/.exec(xml);
  return m ? m[1] : null;
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue({} as Booking);
  enqueue.mockClear();
});

describe('sendSms', () => {
  it('sends To, Body and From through Messages.json', async () => {
    const net = fakeTwilio();
    const ctx = await configured({ fetch: net.impl });
    const result = await sendSms(ctx, { to: '+1 (415) 555-2671', body: '  Reminder: Intro call at 3:30 PM.  ' });
    expect(result).toEqual({ ok: true, provider: 'twilio', id: 'SM0001' });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(Object.fromEntries(net.calls[0].params)).toEqual({ To: '+14155552671', Body: 'Reminder: Intro call at 3:30 PM.', From: '+15005550006' });
  });

  it('uses the messaging service instead of From when one is set', async () => {
    const net = fakeTwilio();
    const ctx = await configured({ fetch: net.impl }, { messagingServiceSid: 'MG0123456789abcdef0123456789abcdef' });
    await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(net.calls[0].params.get('MessagingServiceSid')).toBe('MG0123456789abcdef0123456789abcdef');
    expect(net.calls[0].params.has('From')).toBe(false);
  });

  it('skips without a network call when texting is not set up, the number is unusable or the text is empty', async () => {
    const net = fakeTwilio();
    expect(await sendSms(makeTestCtx({ fetch: net.impl }), { to: '+14155552671', body: 'Hi' })).toEqual({ ok: false, provider: 'none', skipped: 'sms_not_configured' });
    const ctx = await configured({ fetch: net.impl });
    expect(await sendSms(ctx, { to: 'not a number', body: 'Hi' })).toMatchObject({ ok: false, skipped: 'invalid_phone' });
    expect(await sendSms(ctx, { to: '+19005551234', body: 'Hi' })).toMatchObject({ ok: false, skipped: 'unsupported_number' });
    expect(await sendSms(ctx, { to: '+14155552671', body: ' \n ' })).toMatchObject({ ok: false, skipped: 'empty_message' });
    expect(net.calls).toHaveLength(0);
  });

  it('clips an oversized body and removes control characters', async () => {
    const net = fakeTwilio();
    const ctx = await configured({ fetch: net.impl });
    await sendSms(ctx, { to: '+14155552671', body: `a\u0000b\u0007c ${'x'.repeat(3000)}` });
    const body = net.calls[0].params.get('Body') ?? '';
    expect(body.length).toBe(SMS_BODY_LIMIT);
    expect(body.startsWith('a b c x')).toBe(true);
  });

  it('reports a passing Twilio problem as an error, so the job is retried', async () => {
    const net = fakeTwilio(() => Response.json({ code: 20429, message: 'Too many requests' }, { status: 429 }));
    const ctx = await configured({ fetch: net.impl });
    const result = await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toContain('Too many requests');
    expect(result.provider).toBe('twilio');
  });

  it('reports a problem with the recipient as skipped, so the job is not retried', async () => {
    const net = fakeTwilio(() => Response.json({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }, { status: 400 }));
    const ctx = await configured({ fetch: net.impl });
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toMatchObject({ ok: false, provider: 'twilio', skipped: 'recipient_opted_out' });
  });

  it('never throws, whatever the network does', async () => {
    const impl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const ctx = await configured({ fetch: impl });
    const result = await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not reach Twilio/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('goes to the mock provider in mock mode without any credentials', async () => {
    const net = fakeTwilio();
    const ctx = makeTestCtx({ fetch: net.impl, env: { mockProviders: true } });
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toEqual({ ok: true, provider: 'mock', id: 'SM0001' });
    expect(net.calls[0].params.get('From')).toBe('+15005550006');
  });
});

describe('handleInboundSms', () => {
  it('answers 403 without a valid signature and does nothing', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_1'));
    for (const req of [inbound({ From: '+14155552671', Body: 'C' }, null), inbound({ From: '+14155552671', Body: 'C' }, 'forged')]) {
      const res = await handleInboundSms(ctx, req);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('<Message>');
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a form', async () => {
    const ctx = await configured();
    const req = new Request(INTERNAL_SMS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await handleInboundSms(ctx, req)).status).toBe(400);
  });

  it.each(['C', 'c', ' Yes ', 'CONFIRM', 'Confirm!', 'y'])('confirms the next meeting on "%s"', async (word) => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_later', { start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T15:30:00.000Z' }));
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: word }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(ctx, 'bk_next', 'sms');
    // 20:30 UTC is 3:30 PM in New York, the invitee's zone.
    expect(messageOf(await res.text())).toBe('Thanks Sam, you are confirmed for Intro call on Tue, Nov 17, 3:30 PM. See you then.');
  });

  it('answers anything else with the link to manage the booking', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'can we do thursday instead?' }));
    const text = messageOf(await res.text()) ?? '';
    expect(text).toContain('https://jimicohen.com/meeting/booking/bk_next?t=tok-bk_next');
    expect(text).toContain('Intro call on Tue, Nov 17, 3:30 PM');
    expect(text).toContain('Reply C to confirm you are coming.');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('matches the sender by phone number only, and ignores cancelled and past bookings', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_other', { invitee: { name: 'Ana', email: 'ana@example.com', phone: '+254712345678', timezone: 'Africa/Nairobi' } }));
    await store(ctx, makeBooking('bk_cancelled', { status: 'cancelled' }));
    await store(ctx, makeBooking('bk_past', { start: '2026-11-10T15:00:00.000Z', end: '2026-11-10T15:30:00.000Z' }));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'C' }));
    const text = messageOf(await res.text()) ?? '';
    expect(text).toContain('could not find an upcoming meeting');
    expect(text).toContain('https://jimicohen.com/meeting');
    expect(text).not.toContain('?t=');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not offer to confirm a meeting that has already started', async () => {
    const ctx = await configured({ now: '2026-11-17T20:40:00.000Z' });
    await store(ctx, makeBooking('bk_now'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'C' }));
    expect(confirm).not.toHaveBeenCalled();
    const text = messageOf(await res.text()) ?? '';
    expect(text).toContain('booking/bk_now?t=tok-bk_now');
    expect(text).not.toContain('Reply C');
  });

  it('falls back to the link when the confirmation cannot be saved', async () => {
    confirm.mockRejectedValueOnce(new Error('storage is down'));
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'YES' }));
    expect(res.status).toBe(200);
    expect(messageOf(await res.text())).toContain('booking/bk_next?t=tok-bk_next');
  });

  it('escapes everything that goes into the reply', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next', { eventTitle: 'Q&A <live> "now"', invitee: { name: '<Sam> & Co', email: 'sam@example.com', phone: '+14155552671', timezone: 'America/New_York' } }));
    const xml = await (await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'hello' }))).text();
    expect(xml).toContain('Q&amp;A &lt;live&gt; &quot;now&quot;');
    expect(xml).toContain('Hi &lt;Sam&gt;,');
    expect(xml).toContain('?t=tok-bk_next');
    expect(xml.match(/<Message>/g)).toHaveLength(1);
    expect(xml).not.toMatch(/<live>|<Sam>/);
  });

  it.each(['STOP', 'stop', 'Unsubscribe', 'QUIT', 'STOPALL'])('treats "%s" as an opt out: no reply, reminders off', async (word) => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: word }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const after = await getBooking(ctx, 'bk_next');
    expect(after?.consent.sms).toBe(false);
    expect(after?.consent.call).toBe(false);
    expect(after?.timeline.at(-1)?.type).toBe('sms_opt_out');
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('emails the manage link on "CANCEL", because texts to that number are blocked from then on', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'Cancel' }));
    expect(await res.text()).not.toContain('<Message>');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toMatchObject({ type: 'message', bookingId: 'bk_next', channel: 'email', audience: 'invitee', kind: 'manage_link', dueAt: TEST_NOW });
    const after = await getBooking(ctx, 'bk_next');
    expect(after?.status).toBe('confirmed');
    // Only texts are switched off: they asked about the meeting, not to be left alone.
    expect(after?.consent).toMatchObject({ sms: false, call: true });
    expect(await isNumberBlocked(ctx, '+14155552671', 'sms')).toBe(true);
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(false);
  });

  it('remembers a STOP for the number itself, and lifts it on START', async () => {
    const net = fakeTwilio();
    const ctx = await configured({ fetch: net.impl });
    await store(ctx, makeBooking('bk_next'));
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Reminder' })).toMatchObject({ ok: true });

    await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'STOP' }));
    // A later booking with the same number gets no texts either.
    expect(await sendSms(ctx, { to: '+1 415 555 2671', body: 'Reminder' })).toEqual({ ok: false, provider: 'none', skipped: 'recipient_opted_out' });
    expect(await sendSms(ctx, { to: '+254712345678', body: 'Reminder' })).toMatchObject({ ok: true });
    expect(net.calls).toHaveLength(2);

    await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'START' }));
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Reminder' })).toMatchObject({ ok: true });
  });

  it('leaves HELP and START to the carrier', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    for (const word of ['HELP', 'start']) {
      const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: word }));
      expect(await res.text()).not.toContain('<Message>');
    }
    expect((await getBooking(ctx, 'bk_next'))?.consent.sms).toBe(true);
  });

  it('stays silent when the sender is not a phone number that can be answered', async () => {
    const ctx = await configured();
    for (const from of ['anonymous', 'ACME', '', '72345']) {
      const res = await handleInboundSms(ctx, inbound({ From: from, Body: 'C' }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('stops answering a number that keeps texting, and starts again in the next hour', async () => {
    const ctx = await configured();
    await store(ctx, makeBooking('bk_next'));
    const ask = async () => messageOf(await (await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'what is my link' }))).text());
    for (let i = 0; i < 10; i++) expect(await ask(), `reply ${i + 1}`).toContain('booking/bk_next');
    expect(await ask()).toBeNull();
    // An opt out is still honoured while replies are held back.
    await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'STOP' }));
    expect((await getBooking(ctx, 'bk_next'))?.consent.sms).toBe(false);
    ctx.clock.advance(3600_000);
    expect(await ask()).toContain('booking/bk_next');
  });

  it('shares one small allowance between all numbers it does not know', async () => {
    const ctx = await configured();
    let replies = 0;
    for (let i = 0; i < 70; i++) {
      const from = `+1415555${String(2000 + i)}`;
      const res = await handleInboundSms(ctx, inbound({ From: from, Body: 'hello' }));
      if ((await res.text()).includes('<Message>')) replies++;
    }
    expect(replies).toBe(60);
    // Someone with a booking is still answered.
    await store(ctx, makeBooking('bk_next'));
    const known = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'hello' }));
    expect(messageOf(await known.text())).toContain('booking/bk_next');
  });

  it('accepts the mock signature in mock mode', async () => {
    const ctx = makeTestCtx({ env: { mockProviders: true } });
    await store(ctx, makeBooking('bk_next'));
    const res = await handleInboundSms(ctx, inbound({ From: '+14155552671', Body: 'C' }, 'mock'));
    expect(res.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(ctx, 'bk_next', 'sms');
  });
});
