import { describe, expect, it, vi } from 'vitest';
import { defaultOwnerHost } from '../../shared/defaults';
import type { Booking, Host, Job } from '../../shared/types';
import { alertCalendarTrouble } from '../../server/lib/booking';
import type { Ctx, KV } from '../../server/lib/ctx';
import { deliverMessage, enqueueJob, runDueJobs, type StoredJob } from '../../server/lib/jobs';
import { CALLS_PER_DAY, CALLS_PER_NUMBER_PER_DAY, reserveOutbound, TEXTS_PER_DAY, TEXTS_PER_NUMBER_PER_DAY, type OutboundChannel } from '../../server/lib/outbound';
import { getBooking, getSite, listJobs, saveBooking } from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { blockNumber, TWILIO_TIMEOUT_MS, unblockNumber } from '../../server/lib/twilio';
import { startReminderCall } from '../../server/lib/voice';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

const DAY = 86_400_000;
const MINUTE = 60_000;

/** True when a text or call may go out (the place it took is kept). */
async function outboundAllowed(ctx: Ctx, channel: OutboundChannel, phone: string): Promise<boolean> {
  return (await reserveOutbound(ctx, channel, phone)) !== null;
}

/** A store whose next `failures` job writes throw, as if storage went down between the claim and the write. */
function failingJobWrites() {
  const kv = memoryKV();
  const state = { failures: 0 };
  const flaky: KV = {
    ...kv,
    setJSON: async (key, value, opts) => {
      if (key.startsWith('jobs/') && state.failures > 0) {
        state.failures--;
        throw new Error('storage is down');
      }
      return kv.setJSON(key, value, opts);
    },
  };
  return { kv: flaky, state };
}

async function alerts(ctx: ReturnType<typeof makeTestCtx>): Promise<Job[]> {
  return (await listJobs(ctx)).filter((j) => j.kind === 'host_alert');
}

describe('outboundAllowed', () => {
  it('allows a few texts and calls a day to one number, however it is written', async () => {
    const ctx = makeTestCtx();
    for (let i = 0; i < TEXTS_PER_NUMBER_PER_DAY; i++) expect(await outboundAllowed(ctx, 'sms', i % 2 ? '+1 415 555 2671' : '+14155552671')).toBe(true);
    expect(await outboundAllowed(ctx, 'sms', '+1 (415) 555-2671')).toBe(false);
    // calls have their own, smaller allowance
    for (let i = 0; i < CALLS_PER_NUMBER_PER_DAY; i++) expect(await outboundAllowed(ctx, 'call', '+14155552671')).toBe(true);
    expect(await outboundAllowed(ctx, 'call', '+14155552671')).toBe(false);
    // another number is not affected, and the next day starts afresh
    expect(await outboundAllowed(ctx, 'sms', '+14155552672')).toBe(true);
    ctx.clock.advance(DAY);
    expect(await outboundAllowed(ctx, 'sms', '+14155552671')).toBe(true);
    expect(await alerts(ctx)).toEqual([]);
  });

  it('stops at the site-wide ceiling and tells the owner once that day', async () => {
    const ctx = makeTestCtx();
    for (let i = 0; i < CALLS_PER_DAY; i++) expect(await outboundAllowed(ctx, 'call', `+1415555${String(1000 + i)}`)).toBe(true);
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(false);
    expect(await outboundAllowed(ctx, 'call', '+14155559998')).toBe(false);
    const queued = await alerts(ctx);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'message', bookingId: '', channel: 'email', audience: 'host', subject: 'Reminder calls are paused for today', dueAt: TEST_NOW });
    expect(queued[0].body).toContain(`Your booking page reached today's limit of ${CALLS_PER_DAY} reminder calls.`);
    expect(queued[0].body).not.toMatch(/\u2014/);

    ctx.clock.advance(DAY);
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(true);
  });

  it('keeps the text ceiling apart from the call ceiling', async () => {
    const ctx = makeTestCtx();
    for (let i = 0; i < TEXTS_PER_DAY; i++) await outboundAllowed(ctx, 'sms', `+1415555${String(1000 + i)}`);
    expect(await outboundAllowed(ctx, 'sms', '+14155559999')).toBe(false);
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(true);
    expect((await alerts(ctx)).map((j) => j.subject)).toEqual(['Texts to invitees are paused for today']);
  });

  it('tries the alert again on the next send when it could not be queued', async () => {
    const { kv, state } = failingJobWrites();
    const ctx = makeTestCtx({ kv });
    for (let i = 0; i < CALLS_PER_DAY; i++) await outboundAllowed(ctx, 'call', `+1415555${String(1000 + i)}`);
    state.failures = 1;
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(false);
    expect(await alerts(ctx)).toEqual([]);
    expect(ctx.logs.some((l) => l.level === 'error' && l.msg.includes('could not queue the alert'))).toBe(true);
    expect(await outboundAllowed(ctx, 'call', '+14155559998')).toBe(false);
    expect(await alerts(ctx)).toHaveLength(1);
  });
});

describe('reserveOutbound', () => {
  it('gives the place back when the send did not go out, for the number and for the site', async () => {
    const ctx = makeTestCtx();
    for (let i = 0; i < 10; i++) {
      const pass = await reserveOutbound(ctx, 'sms', '+14155552671');
      expect(pass).not.toBeNull();
      await pass!.release();
      await pass!.release(); // a second release gives nothing more back
    }
    for (let i = 0; i < TEXTS_PER_NUMBER_PER_DAY; i++) expect(await outboundAllowed(ctx, 'sms', '+14155552671')).toBe(true);
    expect(await outboundAllowed(ctx, 'sms', '+14155552671')).toBe(false);
    // The site's count holds only the six that were kept.
    for (let i = 0; i < TEXTS_PER_DAY - TEXTS_PER_NUMBER_PER_DAY; i++) expect(await outboundAllowed(ctx, 'sms', `+1415555${String(1000 + i)}`)).toBe(true);
    expect(await outboundAllowed(ctx, 'sms', '+14155559999')).toBe(false);
  });

  it('does not charge a number for a call the site-wide ceiling stopped', async () => {
    const ctx = makeTestCtx();
    const passes = [];
    for (let i = 0; i < CALLS_PER_DAY; i++) passes.push(await reserveOutbound(ctx, 'call', `+1415555${String(1000 + i)}`));
    for (let i = 0; i < 5; i++) expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(false);
    // Two of the day's calls did not go out after all: the number that was turned away five times still gets its two.
    await passes[0]!.release();
    await passes[1]!.release();
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(true);
    expect(await outboundAllowed(ctx, 'call', '+14155559999')).toBe(true);
  });
});

describe('a counter that is busy is not a reached limit', () => {
  /** A store on which the next `refusals` conditional writes of the site's text counter are turned down, as when other sends win every race. */
  function contestedSiteCounter(refusals: number) {
    const inner = memoryKV();
    const state = { refusals };
    const kv: KV = {
      ...inner,
      setJSON: async (key, value, opts) => {
        if (key.startsWith('rl/out-sms-all/') && state.refusals > 0 && (opts?.onlyIfMatch || opts?.onlyIfNew)) {
          state.refusals--;
          return { modified: false };
        }
        return inner.setJSON(key, value, opts);
      },
    };
    return { kv, state };
  }

  it('gives every one of many texts sent at the same moment its place, with no alert', async () => {
    const ctx = makeTestCtx();
    const passes = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveOutbound(ctx, 'sms', `+1415555${String(1000 + i)}`)));
    expect(passes.every((p) => p !== null)).toBe(true);
    expect(await alerts(ctx)).toEqual([]);
  });

  it('fails a send whose counter lost every race, so it is tried again, instead of skipping it as the daily limit', async () => {
    const { kv } = contestedSiteCounter(8);
    const ctx = makeTestCtx({ kv });
    await expect(reserveOutbound(ctx, 'sms', '+14155552671')).rejects.toMatchObject({ status: 503, code: 'busy' });
    expect(await alerts(ctx)).toEqual([]);
    expect(ctx.logs.some((l) => l.msg.includes('daily limit for the whole site'))).toBe(false);
    // The number was not charged for it: all six of its texts are still there.
    for (let i = 0; i < TEXTS_PER_NUMBER_PER_DAY; i++) expect(await outboundAllowed(ctx, 'sms', '+14155552671')).toBe(true);
  });

  it('still counts a send that lost a few races', async () => {
    const { kv } = contestedSiteCounter(5);
    const ctx = makeTestCtx({ kv });
    expect(await reserveOutbound(ctx, 'sms', '+14155552671')).not.toBeNull();
  });
});

// ───────────────────────── only what really goes out counts ─────────────────────────

describe('daily limits count the texts and calls that really go out', () => {
  const PHONE = '+14155552671';
  /** 10 AM in New York, inside calling hours. */
  const NOW = '2026-11-16T15:00:00.000Z';
  const TWILIO = { twilioAccountSid: 'AC' + '0'.repeat(32), twilioAuthToken: 'twilio-token', twilioFromNumber: '+15005550006' };

  function invitation(id: string): Booking {
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
      invitee: { name: 'Sam Rivera', email: 'sam@example.com', phone: PHONE, timezone: 'America/New_York' },
      guests: [],
      answers: [],
      location: { type: 'google_meet', label: 'Google Meet' },
      consent: { sms: true, call: true, at: NOW, text: 'ok' },
      google: null,
      attendance: {},
      cancellation: null,
      rescheduleCount: 0,
      source: 'page',
      timeline: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  /** Twilio answers with `reply` (a healthy 201 unless a test says otherwise) and every request is kept. */
  async function world(opts: { twilio?: boolean } = {}) {
    const requests: string[] = [];
    const state = { reply: (_path: string): Response | Promise<Response> | null => null };
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.twilio.com/')) throw new Error(`Unexpected network call in a test: ${url}`);
      const path = url.slice(url.lastIndexOf('/'));
      requests.push(path);
      const sid = (path === '/Calls.json' ? 'CA' : 'SM') + '0123456789abcdef'.repeat(2);
      return state.reply(path) ?? Response.json({ sid, status: 'queued' }, { status: 201 });
    }) as typeof fetch;
    const ctx = makeTestCtx({ now: NOW, fetch: fetchImpl, env: { overrides: opts.twilio === false ? {} : { ...TWILIO } } });
    await getSite(ctx);
    await saveBooking(ctx, invitation('bkg_sam1'));
    return { ctx, requests, state };
  }

  const textJob = (n: number): StoredJob => ({
    key: `jobs/x_job_text${n}`,
    id: `job_text${n}`,
    type: 'message',
    bookingId: 'bkg_sam1',
    dueAt: NOW,
    attempt: 0,
    createdAt: NOW,
    channel: 'sms',
    audience: 'invitee',
    kind: 'reminder',
  });

  const failure = (): Response => Response.json({ code: 20500, message: 'Internal Server Error' }, { status: 500 });

  it('a text whose counter was too busy fails, to be tried again, and goes out on the retry', async () => {
    const { ctx, requests } = await world();
    const inner = ctx.kv;
    let refusals = 8;
    ctx.kv = {
      ...inner,
      setJSON: async (key, value, opts) => {
        if (key.startsWith('rl/out-sms-all/') && refusals > 0 && (opts?.onlyIfMatch || opts?.onlyIfNew)) {
          refusals--;
          return { modified: false };
        }
        return inner.setJSON(key, value, opts);
      },
    };
    const first = await deliverMessage(ctx, textJob(1));
    expect(first.ok).toBe(false);
    expect(first.skipped).toBeUndefined();
    expect(first.error).toMatch(/busy/);
    expect(requests).toEqual([]);
    expect(await alerts(ctx)).toEqual([]);
    expect(await deliverMessage(ctx, textJob(1))).toMatchObject({ ok: true });
    expect(requests).toEqual(['/Messages.json']);
  });

  it('a text skipped because Twilio is not set up or the number opted out does not count', async () => {
    const { ctx, requests } = await world({ twilio: false });
    for (let n = 0; n < 8; n++) expect(await deliverMessage(ctx, textJob(n))).toMatchObject({ ok: false, skipped: 'sms_not_configured' });

    ctx.env.overrides = { ...TWILIO };
    await blockNumber(ctx, PHONE, ['sms']);
    for (let n = 10; n < 18; n++) expect(await deliverMessage(ctx, textJob(n))).toMatchObject({ ok: false, skipped: 'recipient_opted_out' });
    expect(requests).toEqual([]);

    // Sixteen skipped texts later the number still has its six for the day, and the seventh is held back.
    await unblockNumber(ctx, PHONE, ['sms']);
    for (let n = 20; n < 20 + TEXTS_PER_NUMBER_PER_DAY; n++) expect(await deliverMessage(ctx, textJob(n))).toMatchObject({ ok: true });
    expect(await deliverMessage(ctx, textJob(30))).toMatchObject({ ok: false, provider: 'none', skipped: 'daily_limit' });
    expect(requests).toHaveLength(TEXTS_PER_NUMBER_PER_DAY);
  });

  it('a reminder that fails three times and then goes out counts once', async () => {
    const { ctx, requests, state } = await world();
    let failures = 3;
    state.reply = (path) => (path === '/Messages.json' && failures-- > 0 ? failure() : null);
    await enqueueJob(ctx, { type: 'message', bookingId: 'bkg_sam1', dueAt: NOW, channel: 'sms', audience: 'invitee', kind: 'reminder' });
    for (const waitMin of [0, 2, 10, 30]) {
      ctx.clock.advance(waitMin * MINUTE);
      await runDueJobs(ctx);
    }
    expect(requests).toEqual(['/Messages.json', '/Messages.json', '/Messages.json', '/Messages.json']);
    expect(await listJobs(ctx)).toEqual([]);
    expect((await getBooking(ctx, 'bkg_sam1'))?.timeline.map((t) => t.type)).toContain('reminder_sms_sent');

    // Four tries, one text: five more go out today, and the one after that is held back.
    for (let n = 0; n < TEXTS_PER_NUMBER_PER_DAY - 1; n++) expect(await deliverMessage(ctx, textJob(n))).toMatchObject({ ok: true });
    expect(await deliverMessage(ctx, textJob(9))).toMatchObject({ ok: false, skipped: 'daily_limit' });
  });

  it('a text Twilio may have taken without saying so in time stays counted', async () => {
    const { ctx, state } = await world();
    let reached: () => void = () => undefined;
    const atTwilio = new Promise<void>((resolve) => {
      reached = resolve;
    });
    state.reply = () => {
      reached();
      return new Promise<Response>(() => undefined); // never answers
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sending = deliverMessage(ctx, textJob(0));
      await atTwilio;
      await vi.advanceTimersByTimeAsync(TWILIO_TIMEOUT_MS + 1);
      expect(await sending).toMatchObject({ ok: true, detail: expect.stringContaining('may not have arrived') });
    } finally {
      vi.useRealTimers();
    }
    state.reply = () => null;
    for (let n = 1; n < TEXTS_PER_NUMBER_PER_DAY; n++) expect(await deliverMessage(ctx, textJob(n))).toMatchObject({ ok: true });
    expect(await deliverMessage(ctx, textJob(9))).toMatchObject({ ok: false, skipped: 'daily_limit' });
  });

  it('a reminder call Twilio refused does not count, so the number still gets its two calls', async () => {
    const { ctx, requests, state } = await world();
    let failures = 1;
    state.reply = (path) => (path === '/Calls.json' && failures-- > 0 ? failure() : null);
    const first = invitation('bkg_sam1');
    expect(await startReminderCall(ctx, { booking: first, purpose: 'reminder' })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await startReminderCall(ctx, { booking: first, purpose: 'reminder' })).toMatchObject({ ok: true });
    const second = await saveBooking(ctx, invitation('bkg_sam2'));
    expect(await startReminderCall(ctx, { booking: second, purpose: 'reminder' })).toMatchObject({ ok: true });
    const third = await saveBooking(ctx, invitation('bkg_sam3'));
    expect(await startReminderCall(ctx, { booking: third, purpose: 'reminder' })).toEqual({ ok: false, provider: 'none', skipped: 'daily_limit' });
    expect(requests).toEqual(['/Calls.json', '/Calls.json', '/Calls.json']);
    expect(CALLS_PER_NUMBER_PER_DAY).toBe(2);
  });
});

describe('alertCalendarTrouble', () => {
  const owner: Host = { ...defaultOwnerHost(TEST_NOW, 'America/New_York'), email: 'jimi@example.com' };

  it('gives the day\'s claim back when the alert could not be queued, so the next failure still alerts', async () => {
    const { kv, state } = failingJobWrites();
    const ctx = makeTestCtx({ kv });
    state.failures = 1;
    await expect(alertCalendarTrouble(ctx, [{ host: owner, error: 'Google Calendar needs to be reconnected.' }])).rejects.toThrow('storage is down');
    expect(await alerts(ctx)).toEqual([]);
    expect(await alertCalendarTrouble(ctx, [{ host: owner, error: 'Google Calendar needs to be reconnected.' }])).toBe(1);
    expect(await alerts(ctx)).toHaveLength(1);
    // and once it is queued, that is it for the day
    expect(await alertCalendarTrouble(ctx, [{ host: owner, error: 'Google Calendar needs to be reconnected.' }])).toBe(0);
  });
});
