import { DateTime, Settings } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  ZoneClock,
  addDays,
  formatInZone,
  intersectIntervals,
  isValidZone,
  localDateOf,
  mergeIntervals,
  parseHHMM,
  subtractIntervals,
  wallDate,
  wallDayStart,
  weekdayOf,
  zonedToUtcMs,
  type Interval,
} from '../../server/lib/time';

const HOUR = 3_600_000;
const MIN = 60_000;

/** Instant from an ISO string that always carries its own offset, so expectations never depend on a zone database. */
const T = (iso: string): number => {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(iso)) throw new Error(`test instant needs an explicit offset: ${iso}`);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test instant: ${iso}`);
  return ms;
};
const iso = (ms: number): string => new Date(ms).toISOString();

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

afterEach(() => {
  Settings.now = () => Date.now();
});

describe('isValidZone', () => {
  it('accepts named IANA zones', () => {
    for (const tz of ['UTC', 'Africa/Nairobi', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) {
      expect(isValidZone(tz), tz).toBe(true);
    }
  });

  it('rejects offsets, junk and non-strings', () => {
    for (const tz of ['', '+03:00', 'UTC+3', 'Mars/Phobos', 'local', 'system', 'Z', 'America/New York', ' UTC', 'x'.repeat(65)]) {
      expect(isValidZone(tz), JSON.stringify(tz)).toBe(false);
    }
    for (const bad of [null, undefined, 3, {}, []]) expect(isValidZone(bad as unknown as string)).toBe(false);
  });

  it('keeps answering correctly after remembering thousands of names', () => {
    for (let i = 0; i < 2500; i++) expect(isValidZone(`Nowhere/Place_${i}`)).toBe(false);
    expect(isValidZone('Africa/Nairobi')).toBe(true);
    expect(isValidZone('Nowhere/Place_1')).toBe(false);
    expect(isValidZone('Africa/Nairobi')).toBe(true);
  });
});

describe('zonedToUtcMs', () => {
  it('converts ordinary wall times', () => {
    expect(zonedToUtcMs('2026-11-17', '09:00', 'America/New_York')).toBe(T('2026-11-17T09:00:00-05:00'));
    expect(zonedToUtcMs('2026-07-14', '09:00', 'America/New_York')).toBe(T('2026-07-14T09:00:00-04:00'));
    expect(zonedToUtcMs('2026-11-17', '15:30', 'Africa/Nairobi')).toBe(T('2026-11-17T15:30:00+03:00'));
    expect(zonedToUtcMs('2026-11-17', '00:00', 'UTC')).toBe(T('2026-11-17T00:00:00Z'));
    expect(zonedToUtcMs('2026-11-17', '23:59', 'Pacific/Kiritimati')).toBe(T('2026-11-17T23:59:00+14:00'));
    expect(zonedToUtcMs('2026-11-17', '00:00', 'Etc/GMT+12')).toBe(T('2026-11-17T00:00:00-12:00'));
  });

  it('handles half-hour and 45 minute offset zones', () => {
    expect(zonedToUtcMs('2026-11-17', '09:00', 'Asia/Kolkata')).toBe(T('2026-11-17T03:30:00Z'));
    expect(zonedToUtcMs('2026-11-17', '09:00', 'Asia/Kathmandu')).toBe(T('2026-11-17T03:15:00Z'));
    expect(zonedToUtcMs('2026-11-17', '09:00', 'America/St_Johns')).toBe(T('2026-11-17T12:30:00Z'));
    expect(zonedToUtcMs('2026-11-17', '00:00', 'Pacific/Chatham')).toBe(T('2026-11-16T10:15:00Z'));
  });

  it('treats 24:00 as the next local midnight, across month and year ends', () => {
    expect(zonedToUtcMs('2026-11-17', '24:00', 'America/New_York')).toBe(zonedToUtcMs('2026-11-18', '00:00', 'America/New_York'));
    expect(zonedToUtcMs('2026-11-30', '24:00', 'Africa/Nairobi')).toBe(T('2026-12-01T00:00:00+03:00'));
    expect(zonedToUtcMs('2026-12-31', '24:00', 'Europe/London')).toBe(T('2027-01-01T00:00:00Z'));
    expect(zonedToUtcMs('2028-02-28', '24:00', 'UTC')).toBe(T('2028-02-29T00:00:00Z'));
  });

  it('accepts a single digit hour', () => {
    expect(zonedToUtcMs('2026-11-17', '9:05', 'UTC')).toBe(T('2026-11-17T09:05:00Z'));
  });

  describe('America/New_York spring forward (2026-03-08, 02:00 becomes 03:00)', () => {
    const tz = 'America/New_York';
    it('keeps times before the jump on standard time', () => {
      expect(zonedToUtcMs('2026-03-08', '00:00', tz)).toBe(T('2026-03-08T05:00:00Z'));
      expect(zonedToUtcMs('2026-03-08', '01:59', tz)).toBe(T('2026-03-08T06:59:00Z'));
    });
    it('moves every skipped wall time forward to the first valid instant', () => {
      for (const time of ['02:00', '02:01', '02:30', '02:59']) {
        expect(iso(zonedToUtcMs('2026-03-08', time, tz)), time).toBe('2026-03-08T07:00:00.000Z');
      }
    });
    it('uses daylight time from 03:00 on', () => {
      expect(zonedToUtcMs('2026-03-08', '03:00', tz)).toBe(T('2026-03-08T07:00:00Z'));
      expect(zonedToUtcMs('2026-03-08', '03:01', tz)).toBe(T('2026-03-08T07:01:00Z'));
      expect(zonedToUtcMs('2026-03-08', '09:00', tz)).toBe(T('2026-03-08T09:00:00-04:00'));
      expect(zonedToUtcMs('2026-03-08', '24:00', tz)).toBe(T('2026-03-09T00:00:00-04:00'));
    });
    it('makes the day 23 hours long', () => {
      expect(zonedToUtcMs('2026-03-08', '24:00', tz) - zonedToUtcMs('2026-03-08', '00:00', tz)).toBe(23 * HOUR);
    });
  });

  describe('America/New_York fall back (2026-11-01, 02:00 becomes 01:00)', () => {
    const tz = 'America/New_York';
    it('takes the first occurrence of a repeated wall time', () => {
      expect(zonedToUtcMs('2026-11-01', '00:59', tz)).toBe(T('2026-11-01T00:59:00-04:00'));
      expect(zonedToUtcMs('2026-11-01', '01:00', tz)).toBe(T('2026-11-01T01:00:00-04:00'));
      expect(zonedToUtcMs('2026-11-01', '01:30', tz)).toBe(T('2026-11-01T01:30:00-04:00'));
      expect(zonedToUtcMs('2026-11-01', '01:59', tz)).toBe(T('2026-11-01T01:59:00-04:00'));
    });
    it('uses standard time once the wall time is unique again', () => {
      expect(zonedToUtcMs('2026-11-01', '02:00', tz)).toBe(T('2026-11-01T02:00:00-05:00'));
      expect(zonedToUtcMs('2026-11-01', '09:00', tz)).toBe(T('2026-11-01T09:00:00-05:00'));
    });
    it('makes the day 25 hours long', () => {
      expect(zonedToUtcMs('2026-11-01', '24:00', tz) - zonedToUtcMs('2026-11-01', '00:00', tz)).toBe(25 * HOUR);
    });
    it('gives the same answer whatever season the code runs in', () => {
      // luxon's own local-time constructors pick the occurrence from the offset in force "now".
      const repeated = new Set<string>();
      const skipped = new Set<string>();
      for (const now of ['2026-07-01T12:00:00Z', '2026-12-25T12:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
        Settings.now = () => T(now);
        repeated.add(iso(zonedToUtcMs('2026-11-01', '01:30', tz)));
        skipped.add(iso(zonedToUtcMs('2026-03-08', '02:30', tz)));
      }
      expect([...repeated]).toEqual(['2026-11-01T05:30:00.000Z']);
      expect([...skipped]).toEqual(['2026-03-08T07:00:00.000Z']);
    });
  });

  describe('Europe/London', () => {
    const tz = 'Europe/London';
    it('spring forward (2026-03-29, 01:00 becomes 02:00)', () => {
      expect(zonedToUtcMs('2026-03-29', '00:59', tz)).toBe(T('2026-03-29T00:59:00Z'));
      for (const time of ['01:00', '01:15', '01:59']) expect(iso(zonedToUtcMs('2026-03-29', time, tz)), time).toBe('2026-03-29T01:00:00.000Z');
      expect(zonedToUtcMs('2026-03-29', '02:00', tz)).toBe(T('2026-03-29T02:00:00+01:00'));
      expect(zonedToUtcMs('2026-03-29', '09:00', tz)).toBe(T('2026-03-29T08:00:00Z'));
      expect(zonedToUtcMs('2026-03-29', '24:00', tz) - zonedToUtcMs('2026-03-29', '00:00', tz)).toBe(23 * HOUR);
    });
    it('fall back (2026-10-25, 02:00 becomes 01:00)', () => {
      expect(zonedToUtcMs('2026-10-25', '00:30', tz)).toBe(T('2026-10-24T23:30:00Z'));
      expect(zonedToUtcMs('2026-10-25', '01:00', tz)).toBe(T('2026-10-25T00:00:00Z'));
      expect(zonedToUtcMs('2026-10-25', '01:30', tz)).toBe(T('2026-10-25T00:30:00Z'));
      expect(zonedToUtcMs('2026-10-25', '02:00', tz)).toBe(T('2026-10-25T02:00:00Z'));
      expect(zonedToUtcMs('2026-10-25', '24:00', tz) - zonedToUtcMs('2026-10-25', '00:00', tz)).toBe(25 * HOUR);
    });
  });

  it('handles clock changes at midnight, half-hour shifts and a skipped calendar day', () => {
    // Chile: 24:00 on Sep 5 becomes 01:00 on Sep 6, so Sep 6 has no midnight.
    expect(zonedToUtcMs('2026-09-06', '00:00', 'America/Santiago')).toBe(T('2026-09-06T04:00:00Z'));
    expect(zonedToUtcMs('2026-09-05', '24:00', 'America/Santiago')).toBe(T('2026-09-06T04:00:00Z'));
    expect(zonedToUtcMs('2026-09-06', '00:30', 'America/Santiago')).toBe(T('2026-09-06T04:00:00Z'));
    expect(zonedToUtcMs('2026-09-06', '01:00', 'America/Santiago')).toBe(T('2026-09-06T04:00:00Z'));
    // Cuba: 01:00 becomes 00:00, so 00:30 happens twice on Nov 1.
    expect(zonedToUtcMs('2026-11-01', '00:30', 'America/Havana')).toBe(T('2026-11-01T04:30:00Z'));
    expect(zonedToUtcMs('2026-11-01', '01:00', 'America/Havana')).toBe(T('2026-11-01T06:00:00Z'));
    // Lord Howe Island shifts by 30 minutes.
    expect(zonedToUtcMs('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe(T('2026-10-03T15:30:00Z'));
    expect(zonedToUtcMs('2026-10-04', '02:30', 'Australia/Lord_Howe')).toBe(T('2026-10-03T15:30:00Z'));
    expect(zonedToUtcMs('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBe(T('2026-04-04T14:45:00Z'));
    // Samoa skipped 2011-12-30 entirely: every time that day lands on the instant the date line moved.
    expect(zonedToUtcMs('2011-12-30', '12:00', 'Pacific/Apia')).toBe(T('2011-12-30T10:00:00Z'));
    expect(zonedToUtcMs('2011-12-31', '00:00', 'Pacific/Apia')).toBe(T('2011-12-30T10:00:00Z'));
  });

  it('rejects malformed input', () => {
    expect(() => zonedToUtcMs('2026-02-30', '09:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-13-01', '09:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-1-1', '09:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('tomorrow', '09:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', '24:01', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', '25:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', '12:60', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', 'noon', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', '09:00', 'Mars/Phobos')).toThrow(RangeError);
    expect(() => zonedToUtcMs('2026-11-17', '09:00', '+03:00')).toThrow(RangeError);
  });

  /**
   * Independent oracle: walk real instants one minute at a time and read the wall clock luxon reports
   * for each. The instant a wall time denotes is the first one whose wall clock has reached it, which
   * is "first occurrence" for repeated times and "the jump" for skipped ones.
   */
  function wallTable(tz: string, date: string): { t: number; wall: number }[] {
    const dayWall = wallDayStart(date);
    const rows: { t: number; wall: number }[] = [];
    for (let t = dayWall - 16 * HOUR; t <= dayWall + 44 * HOUR; t += MIN) {
      const dt = DateTime.fromMillis(t, { zone: tz });
      rows.push({ t, wall: Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute) });
    }
    return rows;
  }

  it('matches a minute-by-minute scan of the wall clock on and around clock-change days', () => {
    const days: [string, string[]][] = [
      ['America/New_York', ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']],
      ['Europe/London', ['2026-03-28', '2026-03-29', '2026-10-25', '2026-10-26']],
      ['America/Los_Angeles', ['2026-03-08', '2026-11-01']],
      ['Australia/Lord_Howe', ['2026-04-05', '2026-10-04']],
      ['Pacific/Auckland', ['2026-04-05', '2026-09-27']],
      ['America/Santiago', ['2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06']],
      ['America/Havana', ['2026-03-08', '2026-10-31', '2026-11-01']],
      ['Africa/Cairo', ['2026-04-23', '2026-04-24', '2026-10-29', '2026-10-30']],
      ['America/St_Johns', ['2026-03-08', '2026-11-01']],
      ['Asia/Kathmandu', ['2026-11-17']],
      ['Africa/Nairobi', ['2026-11-17']],
    ];
    let checked = 0;
    const mismatches: string[] = [];
    for (const [tz, dates] of days) {
      for (const date of dates) {
        const table = wallTable(tz, date);
        const dayWall = wallDayStart(date);
        let row = 0;
        for (let minutes = 0; minutes <= 1440; minutes += 15) {
          const target = dayWall + minutes * MIN;
          while (table[row].wall < target) row++;
          const time = minutes === 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          const actual = zonedToUtcMs(date, time, tz);
          if (actual !== table[row].t) mismatches.push(`${tz} ${date} ${time}: got ${iso(actual)}, scan says ${iso(table[row].t)}`);
          checked++;
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(3000);
  });

  it('agrees with luxon wherever the wall time is unambiguous', () => {
    const rand = prng(20261114);
    const zones = ['America/New_York', 'Europe/London', 'Africa/Nairobi', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Tokyo',
      'Pacific/Auckland', 'America/Sao_Paulo', 'Australia/Adelaide', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'];
    let compared = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const tz = zones[Math.floor(rand() * zones.length)];
      const day = DateTime.fromObject({ year: 2025 + Math.floor(rand() * 4), month: 1 + Math.floor(rand() * 12), day: 1 + Math.floor(rand() * 28) }, { zone: 'utc' });
      const hour = Math.floor(rand() * 24);
      const minute = Math.floor(rand() * 60);
      const dt = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone: tz });
      // Skip anything within a few hours of a clock change: those cases have their own tests above.
      if (dt.minus({ hours: 4 }).offset !== dt.plus({ hours: 4 }).offset) continue;
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const actual = zonedToUtcMs(day.toISODate()!, time, tz);
      if (actual !== dt.toMillis()) mismatches.push(`${tz} ${day.toISODate()} ${time}: got ${iso(actual)}, luxon says ${dt.toUTC().toISO()}`);
      compared++;
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(3500);
  });
});

describe('ZoneClock', () => {
  const cover = { start: T('2026-01-01T00:00:00Z'), end: T('2027-01-01T00:00:00Z') };

  it('finds the exact instants of clock changes', () => {
    const ny = new ZoneClock('America/New_York', cover).segmentsIn(cover);
    expect(ny.map((s) => [iso(s.start), iso(s.end), s.offsetMs / HOUR])).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-03-08T07:00:00.000Z', -5],
      ['2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z', -4],
      ['2026-11-01T06:00:00.000Z', '2027-01-01T00:00:00.000Z', -5],
    ]);
    const london = new ZoneClock('Europe/London', cover).segmentsIn(cover);
    expect(london.map((s) => [iso(s.start), s.offsetMs / HOUR])).toEqual([
      ['2026-01-01T00:00:00.000Z', 0],
      ['2026-03-29T01:00:00.000Z', 1],
      ['2026-10-25T01:00:00.000Z', 0],
    ]);
    expect(new ZoneClock('Africa/Nairobi', cover).segmentsIn(cover)).toEqual([{ start: cover.start, end: cover.end, offsetMs: 3 * HOUR }]);
  });

  it('switches offset exactly at the instant of a clock change', () => {
    const clock = new ZoneClock('America/New_York', cover);
    const spring = T('2026-03-08T07:00:00Z');
    expect(clock.offsetAt(spring - 1)).toBe(-5 * HOUR);
    expect(clock.offsetAt(spring)).toBe(-4 * HOUR);
    expect(clock.wallOf(spring - 1)).toBe(wallDayStart('2026-03-08') + 2 * HOUR - 1);
    expect(clock.wallOf(spring)).toBe(wallDayStart('2026-03-08') + 3 * HOUR);
    const fall = T('2026-11-01T06:00:00Z');
    expect(clock.offsetAt(fall - 1)).toBe(-4 * HOUR);
    expect(clock.offsetAt(fall)).toBe(-5 * HOUR);
    expect(clock.wallOf(fall - 1)).toBe(wallDayStart('2026-11-01') + 2 * HOUR - 1);
    expect(clock.wallOf(fall)).toBe(wallDayStart('2026-11-01') + 1 * HOUR);
    // Outside the cover the answer comes straight from the zone data and must match.
    expect(clock.offsetAt(T('2025-03-09T07:00:00Z') - 1)).toBe(-5 * HOUR);
    expect(clock.offsetAt(T('2025-03-09T07:00:00Z'))).toBe(-4 * HOUR);
    expect(clock.offsetAt(cover.start)).toBe(-5 * HOUR);
    expect(clock.offsetAt(cover.end)).toBe(-5 * HOUR);
  });

  it('does not trust its cover near the edges, where half of a repeated hour may be cut off', () => {
    // This cover starts inside the second pass through 01:00 to 02:00, so it never sees the first pass.
    const clock = new ZoneClock('America/New_York', { start: T('2026-11-01T06:15:00Z'), end: T('2026-11-20T00:00:00Z') });
    expect(clock.wallToUtc(wallDayStart('2026-11-01') + 90 * MIN)).toBe(T('2026-11-01T05:30:00Z'));
    expect(clock.wallToUtc(wallDayStart('2026-11-01') + 90 * MIN)).toBe(zonedToUtcMs('2026-11-01', '01:30', 'America/New_York'));
    // And this one ends just before a jump it would need to know about.
    const early = new ZoneClock('America/New_York', { start: T('2026-02-20T00:00:00Z'), end: T('2026-03-08T06:50:00Z') });
    expect(early.wallToUtc(wallDayStart('2026-03-08') + 150 * MIN)).toBe(T('2026-03-08T07:00:00Z'));
    expect(early.wallToUtc(wallDayStart('2026-03-08') + 9 * 60 * MIN)).toBe(T('2026-03-08T13:00:00Z'));
  });

  it('clips segments to the requested range and can serve ranges outside its cover', () => {
    const clock = new ZoneClock('America/New_York', cover);
    const inside = { start: T('2026-03-08T06:00:00Z'), end: T('2026-03-08T08:00:00Z') };
    expect(clock.segmentsIn(inside)).toEqual([
      { start: inside.start, end: T('2026-03-08T07:00:00Z'), offsetMs: -5 * HOUR },
      { start: T('2026-03-08T07:00:00Z'), end: inside.end, offsetMs: -4 * HOUR },
    ]);
    const outside = { start: T('2025-03-09T06:00:00Z'), end: T('2025-03-09T08:00:00Z') };
    expect(clock.segmentsIn(outside)).toEqual([
      { start: outside.start, end: T('2025-03-09T07:00:00Z'), offsetMs: -5 * HOUR },
      { start: T('2025-03-09T07:00:00Z'), end: outside.end, offsetMs: -4 * HOUR },
    ]);
    expect(clock.segmentsIn({ start: 5, end: 5 })).toEqual([]);
  });

  it('gives the same offsets and conversions as the one-off functions, inside and outside its cover', () => {
    const rand = prng(77);
    const mismatches: string[] = [];
    const clockTime = (minutes: number) =>
      minutes === 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    for (const tz of ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Kathmandu']) {
      const small = new ZoneClock(tz, { start: T('2026-03-01T00:00:00Z'), end: T('2026-04-10T00:00:00Z') });
      for (let i = 0; i < 400; i++) {
        // From a month before the cover to nine months after it, on a 5 minute lattice.
        const ms = T('2026-02-01T00:00:00Z') + Math.floor(rand() * 330 * 288) * 5 * MIN;
        if (small.offsetAt(ms) !== DateTime.fromMillis(ms, { zone: tz }).offset * MIN) mismatches.push(`${tz} offset at ${iso(ms)}`);
        const date = wallDate(ms);
        const time = clockTime(Math.floor((ms - wallDayStart(date)) / MIN));
        if (small.wallToUtc(ms) !== zonedToUtcMs(date, time, tz)) mismatches.push(`${tz} ${date} ${time}`);
      }
      // Every quarter hour of the clock-change days themselves.
      for (const date of ['2026-03-08', '2026-03-29', '2026-04-04', '2026-04-05']) {
        for (let minutes = 0; minutes <= 1440; minutes += 15) {
          const time = clockTime(minutes);
          if (small.wallToUtc(wallDayStart(date) + minutes * MIN) !== zonedToUtcMs(date, time, tz)) mismatches.push(`${tz} ${date} ${time}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('stays correct over a cover longer than its per-zone memory', () => {
    // Fifteen years is more days than the cache holds, so it is emptied part-way through.
    // (Past years on purpose: their clock changes are settled history.)
    const long = { start: T('2010-01-01T00:00:00Z'), end: T('2025-01-01T00:00:00Z') };
    const segments = new ZoneClock('America/New_York', long).segmentsIn(long);
    expect(segments).toHaveLength(31);
    expect(segments[0].start).toBe(long.start);
    expect(segments[30].end).toBe(long.end);
    segments.forEach((segment, i) => {
      expect(segment.offsetMs).toBe((i % 2 === 0 ? -5 : -4) * HOUR);
      if (i > 0) expect(segment.start).toBe(segments[i - 1].end);
      // Every change is exactly what luxon reports on either side of it.
      if (i > 0) {
        expect(DateTime.fromMillis(segment.start - 1, { zone: 'America/New_York' }).offset * MIN).toBe(segments[i - 1].offsetMs);
        expect(DateTime.fromMillis(segment.start, { zone: 'America/New_York' }).offset * MIN).toBe(segment.offsetMs);
      }
    });
    const clock = new ZoneClock('America/New_York', long);
    expect(clock.wallToUtc(wallDayStart('2015-03-08') + 150 * MIN)).toBe(T('2015-03-08T07:00:00Z'));
    expect(clock.wallToUtc(wallDayStart('2021-11-07') + 90 * MIN)).toBe(T('2021-11-07T05:30:00Z'));
    expect(zonedToUtcMs('2012-11-04', '01:30', 'America/New_York')).toBe(T('2012-11-04T05:30:00Z'));
  });

  it('rejects unknown zones and unusable covers', () => {
    expect(() => new ZoneClock('Nope/Nowhere', cover)).toThrow(RangeError);
    expect(() => new ZoneClock('UTC', { start: 0, end: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new ZoneClock('UTC', { start: 10, end: 0 })).toThrow(RangeError);
  });
});

describe('localDateOf', () => {
  it('reads the calendar date in the zone', () => {
    const ms = T('2026-11-17T21:30:00Z');
    expect(localDateOf(ms, 'UTC')).toBe('2026-11-17');
    expect(localDateOf(ms, 'Africa/Nairobi')).toBe('2026-11-18');
    expect(localDateOf(ms, 'America/Los_Angeles')).toBe('2026-11-17');
    expect(localDateOf(T('2026-11-17T07:59:59.999Z'), 'America/Los_Angeles')).toBe('2026-11-16');
    expect(localDateOf(T('2026-11-17T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-17');
    expect(localDateOf(T('2026-11-17T10:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-18');
    expect(localDateOf(T('2026-11-17T11:59:00Z'), 'Etc/GMT+12')).toBe('2026-11-16');
    expect(localDateOf(T('2026-11-17T18:15:00Z'), 'Asia/Kathmandu')).toBe('2026-11-18');
    expect(localDateOf(T('2026-11-17T18:14:59Z'), 'Asia/Kathmandu')).toBe('2026-11-17');
  });

  it('is right on both sides of a clock change', () => {
    expect(localDateOf(T('2026-03-08T04:59:59Z'), 'America/New_York')).toBe('2026-03-07');
    expect(localDateOf(T('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDateOf(T('2026-03-09T03:59:59Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDateOf(T('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
    expect(localDateOf(T('2026-11-02T04:59:59Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDateOf(T('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
  });

  it('agrees with luxon for arbitrary instants and inverts zonedToUtcMs', () => {
    const rand = prng(5);
    const zones = ['America/New_York', 'Europe/London', 'Africa/Nairobi', 'Asia/Kathmandu', 'Pacific/Auckland', 'America/Santiago', 'Pacific/Apia'];
    const mismatches: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const tz = zones[Math.floor(rand() * zones.length)];
      const ms = T('2025-01-01T00:00:00Z') + Math.floor(rand() * 4 * 365 * DAY_MS);
      const date = localDateOf(ms, tz);
      if (date !== DateTime.fromMillis(ms, { zone: tz }).toISODate()) mismatches.push(`${tz} ${iso(ms)}: ${date}`);
      if (!(zonedToUtcMs(date, '00:00', tz) <= ms && ms < zonedToUtcMs(date, '24:00', tz))) mismatches.push(`${tz} ${iso(ms)} is outside ${date}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('rejects bad input', () => {
    expect(() => localDateOf(Number.NaN, 'UTC')).toThrow(RangeError);
    expect(() => localDateOf(0, 'Not/AZone')).toThrow(RangeError);
    // Past the end of what a Date can represent.
    expect(() => localDateOf(9e15, 'America/New_York')).toThrow(RangeError);
    expect(() => new ZoneClock('America/New_York', { start: 8.6399e15, end: 8.65e15 })).toThrow(RangeError);
  });
});

describe('addDays, weekdayOf and the wall helpers', () => {
  it('adds calendar days across month, year and leap boundaries', () => {
    expect(addDays('2026-11-17', 0)).toBe('2026-11-17');
    expect(addDays('2026-11-17', 1)).toBe('2026-11-18');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2026-11-17', 365)).toBe('2027-11-17');
  });

  it('rejects bad dates and fractional day counts', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('nope', 1)).toThrow(RangeError);
    expect(() => addDays('2026-11-17', 0.5)).toThrow(RangeError);
    expect(() => addDays('2026-11-17', Number.NaN)).toThrow(RangeError);
  });

  it('knows the weekday of a date, Sunday being 0', () => {
    expect(weekdayOf('2026-11-15')).toBe(0);
    expect(weekdayOf('2026-11-16')).toBe(1);
    expect(weekdayOf('2026-11-17')).toBe(2);
    expect(weekdayOf('2026-11-21')).toBe(6);
    expect(weekdayOf('2026-03-08')).toBe(0);
    expect(weekdayOf('2028-02-29')).toBe(2);
    expect(() => weekdayOf('2026-00-10')).toThrow(RangeError);
  });

  it('parses times of day', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('9:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('24:00')).toBe(1440);
    for (const bad of ['24:01', '25:00', '12:60', '12', '12:5', '', 'ab:cd', '12:00:00', null, undefined, 900]) expect(parseHHMM(bad), String(bad)).toBeNull();
  });

  it('round-trips dates through wall ms', () => {
    expect(wallDate(wallDayStart('2026-11-17'))).toBe('2026-11-17');
    expect(wallDate(wallDayStart('2026-11-17') + DAY_MS - 1)).toBe('2026-11-17');
    expect(wallDate(wallDayStart('2026-11-17') - 1)).toBe('2026-11-16');
  });
});

describe('interval algebra', () => {
  const iv = (start: number, end: number): Interval => ({ start, end });

  it('merges overlapping, nested and touching intervals', () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(mergeIntervals([iv(5, 8), iv(1, 3), iv(2, 4)])).toEqual([iv(1, 4), iv(5, 8)]);
    expect(mergeIntervals([iv(1, 10), iv(2, 3), iv(4, 5)])).toEqual([iv(1, 10)]);
    expect(mergeIntervals([iv(1, 2), iv(2, 3)])).toEqual([iv(1, 3)]);
    expect(mergeIntervals([iv(1, 2), iv(3, 4)])).toEqual([iv(1, 2), iv(3, 4)]);
    expect(mergeIntervals([iv(1, 2), iv(1, 2), iv(1, 2)])).toEqual([iv(1, 2)]);
  });

  it('drops empty, backwards and NaN intervals and leaves its input alone', () => {
    const input = [iv(9, 12), iv(4, 4), iv(8, 2), iv(Number.NaN, 5), iv(1, Number.NaN), iv(1, 3)];
    const snapshot = JSON.stringify(input);
    expect(mergeIntervals(input)).toEqual([iv(1, 3), iv(9, 12)]);
    expect(JSON.stringify(input)).toBe(snapshot);
    const out = mergeIntervals([iv(1, 3)]);
    out[0].end = 99;
    expect(mergeIntervals([iv(1, 3)])).toEqual([iv(1, 3)]);
  });

  it('subtracts', () => {
    expect(subtractIntervals([iv(0, 10)], [])).toEqual([iv(0, 10)]);
    expect(subtractIntervals([], [iv(0, 10)])).toEqual([]);
    expect(subtractIntervals([iv(0, 10)], [iv(3, 5)])).toEqual([iv(0, 3), iv(5, 10)]);
    expect(subtractIntervals([iv(0, 10)], [iv(0, 10)])).toEqual([]);
    expect(subtractIntervals([iv(0, 10)], [iv(-5, 15)])).toEqual([]);
    expect(subtractIntervals([iv(0, 10)], [iv(-5, 3), iv(8, 20)])).toEqual([iv(3, 8)]);
    expect(subtractIntervals([iv(0, 10), iv(20, 30)], [iv(5, 25)])).toEqual([iv(0, 5), iv(25, 30)]);
    expect(subtractIntervals([iv(0, 10), iv(20, 30), iv(40, 50)], [iv(8, 22), iv(22, 45)])).toEqual([iv(0, 8), iv(45, 50)]);
    expect(subtractIntervals([iv(20, 30), iv(0, 10)], [iv(2, 3), iv(1, 2), iv(25, 26)])).toEqual([iv(0, 1), iv(3, 10), iv(20, 25), iv(26, 30)]);
  });

  it('treats touching as not overlapping (half-open intervals)', () => {
    expect(subtractIntervals([iv(0, 10)], [iv(10, 20), iv(-5, 0)])).toEqual([iv(0, 10)]);
    expect(intersectIntervals([iv(0, 10)], [iv(10, 20)])).toEqual([]);
    expect(intersectIntervals([iv(0, 10)], [iv(9, 20)])).toEqual([iv(9, 10)]);
  });

  it('intersects', () => {
    expect(intersectIntervals([], [iv(0, 1)])).toEqual([]);
    expect(intersectIntervals([iv(0, 10)], [iv(3, 5)])).toEqual([iv(3, 5)]);
    expect(intersectIntervals([iv(0, 10), iv(20, 30)], [iv(5, 25)])).toEqual([iv(5, 10), iv(20, 25)]);
    expect(intersectIntervals([iv(0, 5), iv(5, 10)], [iv(3, 7)])).toEqual([iv(3, 7)]);
    expect(intersectIntervals([iv(0, 2), iv(4, 6), iv(8, 10)], [iv(1, 9)])).toEqual([iv(1, 2), iv(4, 6), iv(8, 9)]);
    expect(intersectIntervals([iv(8, 10), iv(0, 2)], [iv(9, 12), iv(1, 3)])).toEqual([iv(1, 2), iv(9, 10)]);
  });

  it('matches point-by-point set operations on random inputs', () => {
    const rand = prng(424242);
    const SIZE = 48;
    const randomList = (): Interval[] => {
      const list: Interval[] = [];
      const n = Math.floor(rand() * 7);
      for (let i = 0; i < n; i++) {
        const start = Math.floor(rand() * SIZE);
        list.push(iv(start, start + Math.floor(rand() * 12) - 1));
      }
      return list;
    };
    const covers = (list: Interval[], x: number) => list.some((i) => i.start <= x && x < i.end);
    // Sorted, non-empty, and never touching: touching pieces would have been joined.
    const assertNormal = (list: Interval[]) => {
      for (let i = 0; i < list.length; i++) {
        expect(list[i].end).toBeGreaterThan(list[i].start);
        if (i > 0) expect(list[i].start).toBeGreaterThan(list[i - 1].end);
      }
    };
    const mismatches: string[] = [];
    for (let round = 0; round < 1500; round++) {
      const a = randomList();
      const b = randomList();
      const merged = mergeIntervals(a);
      const minus = subtractIntervals(a, b);
      const both = intersectIntervals(a, b);
      assertNormal(merged);
      assertNormal(minus);
      assertNormal(both);
      for (let x = -2; x < SIZE + 14; x++) {
        const inA = covers(a, x);
        const inB = covers(b, x);
        if (covers(merged, x) !== inA || covers(minus, x) !== (inA && !inB) || covers(both, x) !== (inA && inB)) {
          mismatches.push(`x=${x} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('formatInZone', () => {
  const ms = T('2026-11-17T20:30:00Z');

  it('formats each style in the given zone (en-US by default)', () => {
    expect(formatInZone(ms, 'America/New_York', 'date')).toBe('Tuesday, November 17, 2026');
    expect(formatInZone(ms, 'America/New_York', 'time')).toBe('3:30 PM');
    expect(formatInZone(ms, 'America/New_York', 'spoken')).toBe('Tuesday, November 17th at 3:30 PM');
    expect(formatInZone(ms, 'America/New_York', 'full')).toMatch(/^Tuesday, November 17, 2026(,| at) 3:30 PM EST$/);
    expect(formatInZone(ms, 'America/New_York', 'short')).toMatch(/^Tue, Nov 17(,| at) 3:30 PM$/);
  });

  it('shows the same instant on the right day and clock for each audience', () => {
    expect(formatInZone(ms, 'Africa/Nairobi', 'date')).toBe('Tuesday, November 17, 2026');
    expect(formatInZone(ms, 'Africa/Nairobi', 'time')).toBe('11:30 PM');
    expect(formatInZone(ms, 'Asia/Tokyo', 'date')).toBe('Wednesday, November 18, 2026');
    expect(formatInZone(ms, 'Asia/Tokyo', 'time')).toBe('5:30 AM');
    expect(formatInZone(ms, 'America/Los_Angeles', 'spoken')).toBe('Tuesday, November 17th at 12:30 PM');
    expect(formatInZone(ms, 'Asia/Kathmandu', 'spoken')).toBe('Wednesday, November 18th at 2:15 AM');
    expect(formatInZone(ms, 'Asia/Kolkata', 'time')).toBe('2:00 AM');
  });

  it('names the zone in the full style, following daylight time', () => {
    expect(formatInZone(T('2026-07-14T19:30:00Z'), 'America/New_York', 'full')).toMatch(/3:30 PM EDT$/);
    expect(formatInZone(T('2026-12-14T20:30:00Z'), 'America/New_York', 'full')).toMatch(/3:30 PM EST$/);
    expect(formatInZone(ms, 'UTC', 'full')).toMatch(/8:30 PM UTC$/);
  });

  it('speaks ordinals correctly', () => {
    const day = (d: number) => formatInZone(Date.UTC(2026, 9, d, 15, 0), 'UTC', 'spoken');
    expect(day(1)).toBe('Thursday, October 1st at 3:00 PM');
    expect(day(2)).toBe('Friday, October 2nd at 3:00 PM');
    expect(day(3)).toBe('Saturday, October 3rd at 3:00 PM');
    expect(day(4)).toBe('Sunday, October 4th at 3:00 PM');
    expect(day(11)).toContain('October 11th');
    expect(day(12)).toContain('October 12th');
    expect(day(13)).toContain('October 13th');
    expect(day(21)).toContain('October 21st');
    expect(day(22)).toContain('October 22nd');
    expect(day(23)).toContain('October 23rd');
    expect(day(24)).toContain('October 24th');
    expect(day(30)).toContain('October 30th');
    expect(day(31)).toContain('October 31st');
  });

  it('says midnight and noon the 12 hour way', () => {
    expect(formatInZone(T('2026-11-17T00:00:00Z'), 'UTC', 'spoken')).toBe('Tuesday, November 17th at 12:00 AM');
    expect(formatInZone(T('2026-11-17T12:00:00Z'), 'UTC', 'spoken')).toBe('Tuesday, November 17th at 12:00 PM');
    expect(formatInZone(T('2026-11-17T00:05:00Z'), 'UTC', 'time')).toBe('12:05 AM');
  });

  it('never emits no-break or narrow spaces', () => {
    for (const style of ['full', 'date', 'time', 'short', 'spoken'] as const) {
      for (const locale of [undefined, 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-MX', 'pt-BR']) {
        const text = formatInZone(ms, 'America/New_York', style, locale);
        expect(text, `${style} ${locale}`).not.toMatch(/[\u00a0\u2007\u2009\u202f]/);
        expect(text.length).toBeGreaterThan(3);
        expect(text).not.toContain('\u2014');
      }
    }
  });

  it('follows the locale, with a 12 hour clock for spoken English everywhere', () => {
    expect(formatInZone(ms, 'Europe/Berlin', 'time', 'de-DE')).toBe('21:30');
    expect(formatInZone(ms, 'Europe/Berlin', 'date', 'de-DE')).toBe('Dienstag, 17. November 2026');
    expect(formatInZone(ms, 'Europe/Berlin', 'spoken', 'de-DE')).toContain('Dienstag');
    expect(formatInZone(ms, 'Europe/Berlin', 'spoken', 'de-DE')).toContain('21:30');
    expect(formatInZone(ms, 'Europe/London', 'time', 'en-GB')).toBe('20:30');
    expect(formatInZone(ms, 'Europe/London', 'spoken', 'en-GB')).toBe('Tuesday, November 17th at 8:30 PM');
  });

  it('falls back to en-US for unusable locales and to UTC for unknown zones', () => {
    expect(formatInZone(ms, 'America/New_York', 'time', 'not a locale!')).toBe('3:30 PM');
    expect(formatInZone(ms, 'America/New_York', 'time', '')).toBe('3:30 PM');
    expect(formatInZone(ms, 'America/New_York', 'time', 'en_US')).toBe('3:30 PM');
    expect(formatInZone(ms, 'America/New_York', 'time', 'de_DE')).toBe('15:30');
    expect(formatInZone(ms, 'Nope/Nowhere', 'time')).toBe('8:30 PM');
    expect(formatInZone(ms, '', 'date')).toBe('Tuesday, November 17, 2026');
  });

  it('refuses to format a time that is not a time', () => {
    expect(() => formatInZone(Number.NaN, 'UTC', 'full')).toThrow(RangeError);
    expect(() => formatInZone(Number.POSITIVE_INFINITY, 'UTC', 'full')).toThrow(RangeError);
    expect(() => formatInZone(ms, 'UTC', 'fancy' as unknown as 'full')).toThrow(RangeError);
  });
});
