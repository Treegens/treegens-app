import { describe, expect, it } from 'vitest';
import { defaultOwnerHost } from '../../shared/defaults';
import type { Host, Job } from '../../shared/types';
import { alertCalendarTrouble } from '../../server/lib/booking';
import type { KV } from '../../server/lib/ctx';
import { CALLS_PER_DAY, CALLS_PER_NUMBER_PER_DAY, outboundAllowed, TEXTS_PER_DAY, TEXTS_PER_NUMBER_PER_DAY } from '../../server/lib/outbound';
import { listJobs } from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

const DAY = 86_400_000;

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
