/**
 * createBooking: the daily limit on bookings made with one email address. Email addresses are not
 * verified, so a script that books and cancels could otherwise have the site send a stranger a
 * confirmation and a cancellation every few minutes all day.
 */
import { describe, expect, it } from 'vitest';
import type { CreateBookingRequest } from '../../shared/types';
import { cancelBooking, createBooking } from '../../server/lib/booking';
import type { KV } from '../../server/lib/ctx';
import { HttpError } from '../../server/lib/http';
import { getBookingIndex, getSite, updateHost } from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';

/** Monday 09:00 UTC. The owner works Monday to Friday, 09:00 to 17:00 UTC. */
const NOW = '2026-11-16T09:00:00.000Z';
const WED_14 = '2026-11-18T14:00:00.000Z';
const HOUR = 3_600_000;
const PER_DAY = 12;
/** The hourly limit per email address that stays in place next to the daily one. */
const PER_HOUR = 6;

async function setup(kv?: KV): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, kv });
  await getSite(ctx);
  await updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com' }));
  await markSetUp(ctx);
  return ctx;
}

function request(over: Partial<CreateBookingRequest> = {}): CreateBookingRequest {
  return { slug: 'intro', start: WED_14, durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London', elapsedMs: 5200, ...over };
}

async function failure(work: Promise<unknown>): Promise<HttpError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('Expected the request to be refused, but it went through');
}

/** A new visitor each time (the per-address limit is not what is tested here), at the shared clock. */
function visitor(ctx: TestCtx, n: number): TestCtx {
  return makeTestCtx({ kv: ctx.kv, now: ctx.now(), ip: `198.51.100.${n}` });
}

/**
 * Books and cancels again, the loop the limit is there for. Every sixth attempt waits an hour, so the
 * hourly limit per address never gets in the way.
 */
function booker(ctx: TestCtx) {
  let attempts = 0;
  return {
    async attempt(over: Partial<CreateBookingRequest> = {}): Promise<ReturnType<typeof createBooking>> {
      if (attempts > 0 && attempts % PER_HOUR === 0) ctx.clock.advance(HOUR);
      attempts++;
      return createBooking(visitor(ctx, attempts), request(over));
    },
    async bookAndCancel(over: Partial<CreateBookingRequest> = {}): Promise<void> {
      const { booking } = await this.attempt(over);
      expect(booking.status).toBe('confirmed');
      await cancelBooking(ctx, booking.id, { by: 'invitee' });
      await ctx.settle();
    },
  };
}

describe('createBooking: bookings a day for one email address', () => {
  it('refuses the thirteenth booking of the day with a friendly message, and leaves other addresses alone', async () => {
    const ctx = await setup();
    const ada = booker(ctx);
    for (let i = 0; i < PER_DAY; i++) await ada.bookAndCancel({ email: i % 2 ? 'ADA@Example.com' : 'ada@example.com' });

    const refused = await failure(ada.attempt());
    expect(refused).toMatchObject({ status: 429, code: 'email_limit' });
    expect(refused.message).toBe(
      'This email address has made a lot of bookings today, so the page cannot take another one. Please get in touch with Jimi directly to find a time.',
    );
    expect(refused.message).not.toMatch(/\u2014/);
    // Nothing was booked for it.
    expect((await getBookingIndex(ctx)).filter((e) => e.status === 'confirmed')).toEqual([]);

    // Somebody else books as usual.
    expect((await createBooking(visitor(ctx, 200), request({ email: 'grace@example.com', name: 'Grace Hopper' }))).booking.status).toBe('confirmed');
    // The next day (UTC) starts afresh.
    ctx.clock.set('2026-11-17T00:00:01.000Z');
    expect((await createBooking(visitor(ctx, 201), request({ start: '2026-11-18T15:00:00.000Z' }))).booking.status).toBe('confirmed');
  });

  it('counts every spelling of an address that lands in the same inbox together', async () => {
    const ctx = await setup();
    const ada = booker(ctx);
    // ada+1@example.com, ada+2@example.com and so on are all delivered to ada@example.com.
    for (let i = 0; i < PER_DAY; i++) await ada.bookAndCancel({ email: `ada+${i + 1}@example.com` });
    expect(await failure(ada.attempt({ email: 'ada+13@example.com' }))).toMatchObject({ status: 429, code: 'email_limit' });
    expect(await failure(ada.attempt())).toMatchObject({ status: 429, code: 'email_limit' });
    // Addresses that only look alike are someone else.
    expect((await createBooking(visitor(ctx, 200), request({ email: 'ada-lovelace@example.com' }))).booking.status).toBe('confirmed');

    // Gmail ignores dots and reads googlemail.com as gmail.com: the hourly limit counts those spellings together too.
    const spellings = ['grace@gmail.com', 'g.race@gmail.com', 'GRACE+x@gmail.com', 'gr.ace@googlemail.com', 'grace+y@googlemail.com', 'g.r.a.c.e@gmail.com'];
    for (const [i, email] of spellings.entries()) {
      expect((await failure(createBooking(visitor(ctx, 210 + i), request({ email, start: '2026-11-21T14:00:00.000Z' })))).status).toBe(409);
    }
    expect(await failure(createBooking(visitor(ctx, 220), request({ email: 'grace@gmail.com' })))).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('keeps the hourly limit of six attempts as well', async () => {
    const ctx = await setup();
    for (let i = 0; i < PER_HOUR; i++) {
      // A Saturday: refused as a time, but still an attempt in the hour.
      expect((await failure(createBooking(visitor(ctx, i + 1), request({ start: '2026-11-21T14:00:00.000Z' })))).status).toBe(409);
    }
    expect(await failure(createBooking(visitor(ctx, 50), request()))).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('does not count a time that was taken, even when someone else took it at the very last moment', async () => {
    // Someone else books the same time between this request's check and its write to the index.
    const inner = memoryKV();
    let sneakIn: (() => Promise<unknown>) | null = null;
    const kv: KV = {
      ...inner,
      async getJSONWithEtag<T>(key: string) {
        if (key === 'index/bookings' && sneakIn) {
          const other = sneakIn;
          sneakIn = null;
          await other();
        }
        return inner.getJSONWithEtag<T>(key);
      },
    };
    const ctx = await setup(kv);
    const ada = booker(ctx);

    // A time that is plainly taken is refused before anything is counted.
    const grace = await createBooking(visitor(ctx, 100), request({ email: 'grace@example.com', name: 'Grace Hopper', start: '2026-11-18T10:00:00.000Z' }));
    for (let i = 0; i < 3; i++) expect(await failure(ada.attempt({ start: '2026-11-18T10:00:00.000Z' }))).toMatchObject({ status: 409, code: 'slot_taken' });
    await cancelBooking(ctx, grace.booking.id, { by: 'invitee' });

    // Lost races: the time was free when checked and gone when it was taken.
    for (let i = 0; i < 3; i++) {
      const start = `2026-11-19T1${i}:00:00.000Z`;
      sneakIn = () => createBooking(visitor(ctx, 110 + i), request({ email: `rival${i}@example.com`, name: 'Rival', start }));
      expect(await failure(ada.attempt({ start }))).toMatchObject({ status: 409, code: 'slot_taken' });
      expect(sneakIn).toBeNull();
    }

    // None of those six counted: all twelve of the day's bookings are still there.
    for (let i = 0; i < PER_DAY; i++) await ada.bookAndCancel();
    expect(await failure(ada.attempt())).toMatchObject({ status: 429, code: 'email_limit' });
  });
});
