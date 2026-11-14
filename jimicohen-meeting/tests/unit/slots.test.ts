import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  checkSlot,
  computeSlots,
  pickRoundRobinHost,
  scheduleWindows,
  type HostAvailabilityInput,
  type Slot,
  type SlotQuery,
  type SlotRejection,
} from '../../server/lib/slots';
import { zonedToUtcMs, type Interval } from '../../server/lib/time';
import { defaultOwnerHost, newEventType } from '../../shared/defaults';
import type { BookingIndexEntry, DateOverride, EventScheduling, EventType, Host, TimeRange, Weekday, WeeklyHours } from '../../shared/types';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CREATED = '2026-01-01T00:00:00.000Z';

const NY = 'America/New_York';
const LON = 'Europe/London';
const NBO = 'Africa/Nairobi';
const LA = 'America/Los_Angeles';
const IST = 'Asia/Kolkata';
const KTM = 'Asia/Kathmandu';
const AKL = 'Pacific/Auckland';

/** Instant from an ISO string that always carries its own offset, so expectations never lean on the code under test. */
const T = (iso: string): number => {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(iso)) throw new Error(`test instant needs an explicit offset: ${iso}`);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test instant: ${iso}`);
  return ms;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const span = (start: string, end: string): Interval => ({ start: T(start), end: T(end) });

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

type Ranges = [string, string][];
const toRanges = (ranges: Ranges): TimeRange[] => ranges.map(([start, end]) => ({ start, end }));

function weekly(days: Partial<Record<Weekday, Ranges>>): WeeklyHours {
  const out: WeeklyHours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const [day, ranges] of Object.entries(days)) out[Number(day) as Weekday] = toRanges(ranges as Ranges);
  return out;
}
const everyDay = (...ranges: Ranges): WeeklyHours => weekly({ 0: ranges, 1: ranges, 2: ranges, 3: ranges, 4: ranges, 5: ranges, 6: ranges });
const NINE_TO_FIVE = everyDay(['09:00', '17:00']);
const override = (date: string, ...ranges: Ranges): DateOverride => ({ date, ranges: toRanges(ranges) });

function makeHost(id: string, timezone: string, hours: WeeklyHours = NINE_TO_FIVE, overrides: DateOverride[] = []): Host {
  return {
    ...defaultOwnerHost(CREATED, timezone),
    id,
    role: 'member',
    name: id,
    email: `${id}@example.com`,
    schedules: [{ id: 'sch_default', name: 'Working hours', weekly: hours, overrides }],
    defaultScheduleId: 'sch_default',
  };
}

type EventOverrides = Omit<Partial<EventType>, 'scheduling'> & { scheduling?: Partial<EventScheduling> };

/** 30 minute meeting on a 30 minute grid with no notice, buffers or caps unless a test says otherwise. */
function makeEvent(over: EventOverrides = {}): EventType {
  const { scheduling, ...rest } = over;
  const base = newEventType(CREATED, { id: 'evt', slug: 'evt', title: 'Event' });
  return {
    ...base,
    hostIds: ['jimi'],
    durations: [30],
    defaultDuration: 30,
    ...rest,
    scheduling: {
      ...base.scheduling,
      minNoticeMinutes: 0,
      maxDaysAhead: 365,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      slotIncrementMin: 30,
      ...scheduling,
    },
  };
}

interface QueryInput {
  hosts: (Host | HostAvailabilityInput)[];
  range: Interval;
  eventType?: EventType;
  event?: EventOverrides;
  durationMin?: number;
  ownerTimezone?: string;
  nowMs?: number;
  index?: BookingIndexEntry[];
  ignoreBookingId?: string;
  ownBookingBuffers?: SlotQuery['ownBookingBuffers'];
}

function makeQuery(input: QueryInput): SlotQuery {
  const hosts = input.hosts.map((h): HostAvailabilityInput => ('host' in h ? h : { host: h, busy: [] }));
  const hostIds = hosts.map((h) => h.host.id);
  const eventType = input.eventType ?? makeEvent({ hostIds, kind: hostIds.length > 1 ? 'collective' : 'solo', ...input.event });
  return {
    eventType,
    durationMin: input.durationMin ?? eventType.durations[0],
    hosts,
    ownerTimezone: input.ownerTimezone ?? hosts[0]?.host.timezone ?? NY,
    range: input.range,
    nowMs: input.nowMs ?? T('2026-01-01T00:00:00Z'),
    index: input.index ?? [],
    ...(input.ignoreBookingId !== undefined ? { ignoreBookingId: input.ignoreBookingId } : {}),
    ...(input.ownBookingBuffers ? { ownBookingBuffers: input.ownBookingBuffers } : {}),
  };
}

function booked(id: string, start: string, end: string, hostIds: string[], over: Partial<BookingIndexEntry> = {}): BookingIndexEntry {
  return {
    id,
    start: iso(T(start)),
    end: iso(T(end)),
    hostIds,
    eventTypeId: 'evt',
    status: 'confirmed',
    inviteeName: 'Sam Invitee',
    inviteeEmail: 'sam@example.com',
    eventTitle: 'Event',
    ...over,
  };
}

/** Slot starts as "2026-11-17T14:00Z". */
const zulu = (slots: Slot[]): string[] => slots.map((s) => `${iso(s.startMs).slice(0, 16)}Z`);
/** Slot starts as wall-clock text in a zone, e.g. "09:30". */
const wall = (slots: Slot[], tz: string, format = 'HH:mm'): string[] => slots.map((s) => DateTime.fromMillis(s.startMs, { zone: tz }).toFormat(format));
/** "09:00", "09:30", ... up to and including `to`. */
function clockTimes(from: string, to: string, stepMin: number): string[] {
  const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const out: string[] = [];
  for (let m = minutes(from); m <= minutes(to); m += stepMin) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}
const without = (list: string[], ...remove: string[]): string[] => list.filter((x) => !remove.includes(x));

/** Tuesday 2026-11-17 as a whole day in New York (EST). 09:00 there is 14:00Z. */
const NY_TUESDAY = span('2026-11-17T00:00:00-05:00', '2026-11-18T00:00:00-05:00');
const NY_WORKDAY = clockTimes('09:00', '16:30', 30);

// ─────────────────────────────────────────────────────────────────────────────
// scheduleWindows
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleWindows', () => {
  const schedule = (hours: WeeklyHours, overrides: DateOverride[] = []) => ({ id: 's', name: 'S', weekly: hours, overrides });
  const show = (list: Interval[]) => list.map((w) => `${iso(w.start).slice(0, 16)}Z..${iso(w.end).slice(0, 16)}Z`);

  it('turns weekly hours into instants in the host zone', () => {
    const hours = weekly({ 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] });
    const week = span('2026-11-16T00:00:00-05:00', '2026-11-23T00:00:00-05:00');
    expect(show(scheduleWindows(schedule(hours), NY, week))).toEqual([
      '2026-11-16T14:00Z..2026-11-16T22:00Z',
      '2026-11-17T14:00Z..2026-11-17T22:00Z',
      '2026-11-18T14:00Z..2026-11-18T22:00Z',
      '2026-11-19T14:00Z..2026-11-19T22:00Z',
      '2026-11-20T14:00Z..2026-11-20T22:00Z',
    ]);
    const utcMonday = span('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z');
    expect(show(scheduleWindows(schedule(hours), NBO, utcMonday))).toEqual(['2026-11-16T06:00Z..2026-11-16T14:00Z']);
    expect(show(scheduleWindows(schedule(hours), KTM, utcMonday))).toEqual(['2026-11-16T03:15Z..2026-11-16T11:15Z']);
    expect(show(scheduleWindows(schedule(hours), IST, utcMonday))).toEqual(['2026-11-16T03:30Z..2026-11-16T11:30Z']);
  });

  it('reads 24:00 as the next midnight and joins hours that continue past it', () => {
    const hours = weekly({ 2: [['22:00', '24:00']], 3: [['00:00', '02:00']] });
    const range = span('2026-11-17T00:00:00+03:00', '2026-11-19T00:00:00+03:00');
    expect(show(scheduleWindows(schedule(hours), NBO, range))).toEqual(['2026-11-17T19:00Z..2026-11-17T23:00Z']);
    expect(show(scheduleWindows(schedule(everyDay(['00:00', '24:00'])), NBO, range))).toEqual(['2026-11-16T21:00Z..2026-11-18T21:00Z']);
  });

  it('joins overlapping, touching and unsorted ranges within a day', () => {
    const hours = everyDay(['13:00', '15:00'], ['09:00', '11:00'], ['10:30', '12:00'], ['12:00', '13:00']);
    expect(show(scheduleWindows(schedule(hours), NY, NY_TUESDAY))).toEqual(['2026-11-17T14:00Z..2026-11-17T20:00Z']);
  });

  it('ignores ranges that end at or before their start, and ranges it cannot read', () => {
    const hours = everyDay(['17:00', '09:00'], ['09:00', '09:00'], ['13:00', '14:00']);
    hours[2].push({ start: 'bad', end: '10:00' }, { start: '10:00', end: '25:00' }, { start: '24:00', end: '24:00' }, null as unknown as TimeRange);
    expect(show(scheduleWindows(schedule(hours), NY, NY_TUESDAY))).toEqual(['2026-11-17T18:00Z..2026-11-17T19:00Z']);
  });

  it('lets a date override replace that date, including turning it into a day off', () => {
    const hours = weekly({ 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] });
    const overrides = [
      override('2026-11-17'),
      override('2026-11-18', ['10:00', '12:00'], ['14:00', '15:00']),
      override('2026-11-21', ['09:00', '11:00']),
    ];
    const week = span('2026-11-16T00:00:00-05:00', '2026-11-23T00:00:00-05:00');
    expect(show(scheduleWindows(schedule(hours, overrides), NY, week))).toEqual([
      '2026-11-16T14:00Z..2026-11-16T22:00Z',
      '2026-11-18T15:00Z..2026-11-18T17:00Z',
      '2026-11-18T19:00Z..2026-11-18T20:00Z',
      '2026-11-19T14:00Z..2026-11-19T22:00Z',
      '2026-11-20T14:00Z..2026-11-20T22:00Z',
      '2026-11-21T14:00Z..2026-11-21T16:00Z',
    ]);
  });

  it('applies an override to the host-local date, not the UTC date', () => {
    // Auckland is UTC+13 in November: local Wednesday the 18th runs from Tuesday 11:00Z.
    const range = span('2026-11-17T00:00:00Z', '2026-11-19T00:00:00Z');
    expect(show(scheduleWindows(schedule(NINE_TO_FIVE, [override('2026-11-18')]), AKL, range))).toEqual([
      '2026-11-17T00:00Z..2026-11-17T04:00Z',
      '2026-11-18T20:00Z..2026-11-19T00:00Z',
    ]);
    expect(show(scheduleWindows(schedule(NINE_TO_FIVE), AKL, range))).toEqual([
      '2026-11-17T00:00Z..2026-11-17T04:00Z',
      '2026-11-17T20:00Z..2026-11-18T04:00Z',
      '2026-11-18T20:00Z..2026-11-19T00:00Z',
    ]);
  });

  it('uses the last override when a date is listed twice', () => {
    const overrides = [override('2026-11-17', ['09:00', '10:00']), override('2026-11-17', ['11:00', '12:00'])];
    expect(show(scheduleWindows(schedule(NINE_TO_FIVE, overrides), NY, NY_TUESDAY))).toEqual(['2026-11-17T16:00Z..2026-11-17T17:00Z']);
  });

  it('covers windows that cross midnight UTC', () => {
    const afternoons = weekly({ 2: [['13:00', '21:00']], 3: [['13:00', '21:00']] });
    const utcWednesday = span('2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z');
    // Tuesday afternoon in Los Angeles ends at 05:00Z on Wednesday; Wednesday afternoon starts at 21:00Z.
    expect(show(scheduleWindows(schedule(afternoons), LA, utcWednesday))).toEqual([
      '2026-11-18T00:00Z..2026-11-18T05:00Z',
      '2026-11-18T21:00Z..2026-11-19T00:00Z',
    ]);
    const wide = span('2026-11-17T00:00:00Z', '2026-11-20T00:00:00Z');
    expect(show(scheduleWindows(schedule(afternoons), LA, wide))).toEqual([
      '2026-11-17T21:00Z..2026-11-18T05:00Z',
      '2026-11-18T21:00Z..2026-11-19T05:00Z',
    ]);
    expect(show(scheduleWindows(schedule(weekly({ 3: [['09:00', '17:00']] })), AKL, wide))).toEqual(['2026-11-17T20:00Z..2026-11-18T04:00Z']);
  });

  it('clips to the range', () => {
    const s = schedule(NINE_TO_FIVE);
    expect(show(scheduleWindows(s, NY, span('2026-11-17T15:00:00Z', '2026-11-17T16:00:00Z')))).toEqual(['2026-11-17T15:00Z..2026-11-17T16:00Z']);
    expect(show(scheduleWindows(s, NY, span('2026-11-17T13:00:00Z', '2026-11-17T14:30:00Z')))).toEqual(['2026-11-17T14:00Z..2026-11-17T14:30Z']);
    expect(show(scheduleWindows(s, NY, span('2026-11-17T21:30:00Z', '2026-11-18T03:00:00Z')))).toEqual(['2026-11-17T21:30Z..2026-11-17T22:00Z']);
    expect(scheduleWindows(s, NY, span('2026-11-17T10:00:00Z', '2026-11-17T14:00:00Z'))).toEqual([]);
    expect(scheduleWindows(s, NY, span('2026-11-17T22:00:00Z', '2026-11-18T02:00:00Z'))).toEqual([]);
    expect(scheduleWindows(s, NY, { start: T('2026-11-17T15:00:00Z'), end: T('2026-11-17T15:00:00Z') })).toEqual([]);
    expect(scheduleWindows(s, NY, { start: T('2026-11-18T00:00:00Z'), end: T('2026-11-17T00:00:00Z') })).toEqual([]);
  });

  describe('clock changes', () => {
    const sunday = (...ranges: Ranges) => schedule(weekly({ 0: ranges }));
    const nySpring = span('2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z');
    const nyFall = span('2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z');
    const lonSpring = span('2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z');
    const lonFall = span('2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z');

    it('New York spring forward: skipped wall times move to the jump', () => {
      expect(show(scheduleWindows(sunday(['01:00', '04:00']), NY, nySpring))).toEqual(['2026-03-08T06:00Z..2026-03-08T08:00Z']);
      expect(show(scheduleWindows(sunday(['02:30', '03:30']), NY, nySpring))).toEqual(['2026-03-08T07:00Z..2026-03-08T07:30Z']);
      expect(scheduleWindows(sunday(['02:00', '02:45']), NY, nySpring)).toEqual([]);
      expect(scheduleWindows(sunday(['02:00', '03:00']), NY, nySpring)).toEqual([]);
      expect(show(scheduleWindows(sunday(['09:00', '17:00']), NY, nySpring))).toEqual(['2026-03-08T13:00Z..2026-03-08T21:00Z']);
      const wholeDay = scheduleWindows(sunday(['00:00', '24:00']), NY, nySpring);
      expect(show(wholeDay)).toEqual(['2026-03-08T05:00Z..2026-03-09T04:00Z']);
      expect(wholeDay[0].end - wholeDay[0].start).toBe(23 * HOUR);
    });

    it('New York fall back: repeated wall times mean their first occurrence', () => {
      expect(show(scheduleWindows(sunday(['01:00', '02:00']), NY, nyFall))).toEqual(['2026-11-01T05:00Z..2026-11-01T07:00Z']);
      expect(show(scheduleWindows(sunday(['01:30', '01:45']), NY, nyFall))).toEqual(['2026-11-01T05:30Z..2026-11-01T05:45Z']);
      expect(show(scheduleWindows(sunday(['00:30', '01:30']), NY, nyFall))).toEqual(['2026-11-01T04:30Z..2026-11-01T05:30Z']);
      expect(show(scheduleWindows(sunday(['09:00', '17:00']), NY, nyFall))).toEqual(['2026-11-01T14:00Z..2026-11-01T22:00Z']);
      const wholeDay = scheduleWindows(sunday(['00:00', '24:00']), NY, nyFall);
      expect(show(wholeDay)).toEqual(['2026-11-01T04:00Z..2026-11-02T05:00Z']);
      expect(wholeDay[0].end - wholeDay[0].start).toBe(25 * HOUR);
    });

    it('London spring forward and fall back', () => {
      expect(show(scheduleWindows(sunday(['00:30', '02:30']), LON, lonSpring))).toEqual(['2026-03-29T00:30Z..2026-03-29T01:30Z']);
      expect(scheduleWindows(sunday(['01:00', '02:00']), LON, lonSpring)).toEqual([]);
      expect(show(scheduleWindows(sunday(['09:00', '17:00']), LON, lonSpring))).toEqual(['2026-03-29T08:00Z..2026-03-29T16:00Z']);
      expect(show(scheduleWindows(sunday(['01:00', '02:00']), LON, lonFall))).toEqual(['2026-10-25T00:00Z..2026-10-25T02:00Z']);
      expect(show(scheduleWindows(sunday(['09:00', '17:00']), LON, lonFall))).toEqual(['2026-10-25T09:00Z..2026-10-25T17:00Z']);
      expect(show(scheduleWindows(schedule(weekly({ 6: [['09:00', '17:00']] })), LON, span('2026-10-23T12:00:00Z', '2026-10-26T12:00:00Z')))).toEqual(['2026-10-24T08:00Z..2026-10-24T16:00Z']);
    });

    it('date overrides on clock-change days follow the same rules', () => {
      const spring = schedule(NINE_TO_FIVE, [override('2026-03-08', ['01:30', '03:30'])]);
      expect(show(scheduleWindows(spring, NY, span('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z')))).toEqual(['2026-03-08T06:30Z..2026-03-08T07:30Z']);
      const fall = schedule(NINE_TO_FIVE, [override('2026-11-01', ['00:00', '03:00'])]);
      expect(show(scheduleWindows(fall, NY, span('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z')))).toEqual(['2026-11-01T04:00Z..2026-11-01T08:00Z']);
      const dayOff = schedule(NINE_TO_FIVE, [override('2026-03-29')]);
      expect(show(scheduleWindows(dayOff, LON, lonSpring))).toEqual(['2026-03-28T12:00Z..2026-03-28T17:00Z', '2026-03-30T08:00Z..2026-03-30T12:00Z']);
    });
  });

  it('rejects unknown zones and unbounded ranges', () => {
    expect(() => scheduleWindows(schedule(NINE_TO_FIVE), 'Nope/Nowhere', NY_TUESDAY)).toThrow(RangeError);
    expect(() => scheduleWindows(schedule(NINE_TO_FIVE), NY, { start: 0, end: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => scheduleWindows(schedule(NINE_TO_FIVE), NY, { start: Number.NaN, end: 5 })).toThrow(RangeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSlots
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSlots basics', () => {
  const jimi = makeHost('jimi', NY);

  it('offers every grid time whose meeting fits in the working window', () => {
    const slots = computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY }));
    expect(wall(slots, NY)).toEqual(NY_WORKDAY);
    expect(slots).toHaveLength(16);
    expect(slots[0]).toEqual({ startMs: T('2026-11-17T14:00:00Z'), endMs: T('2026-11-17T14:30:00Z'), hostIds: ['jimi'] });
    expect(slots[15]).toEqual({ startMs: T('2026-11-17T21:30:00Z'), endMs: T('2026-11-17T22:00:00Z'), hostIds: ['jimi'] });
  });

  it('includes the slot that ends exactly at the window end and nothing later', () => {
    const hour = computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { durations: [60] } }));
    expect(wall(hour, NY)).toEqual(clockTimes('09:00', '16:00', 30));
    expect(hour[hour.length - 1].endMs).toBe(T('2026-11-17T17:00:00-05:00'));
  });

  it('fits a 45 minute meeting on a 30 minute grid', () => {
    const slots = computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { durations: [30, 45, 60] }, durationMin: 45 }));
    expect(wall(slots, NY)).toEqual(clockTimes('09:00', '16:00', 30));
    expect(slots.every((s) => s.endMs - s.startMs === 45 * MIN)).toBe(true);
  });

  it('keeps to the grid when the working window does not', () => {
    const odd = makeHost('jimi', NY, everyDay(['09:10', '10:40']));
    expect(wall(computeSlots(makeQuery({ hosts: [odd], range: NY_TUESDAY })), NY)).toEqual(['09:30', '10:00']);
    const exact = makeHost('jimi', NY, everyDay(['09:30', '10:00']));
    expect(wall(computeSlots(makeQuery({ hosts: [exact], range: NY_TUESDAY })), NY)).toEqual(['09:30']);
    const tooShort = makeHost('jimi', NY, everyDay(['09:30', '09:59']));
    expect(computeSlots(makeQuery({ hosts: [tooShort], range: NY_TUESDAY }))).toEqual([]);
  });

  it('offers nothing for a duration the event type does not list', () => {
    const q = makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { durations: [30, 60] }, durationMin: 45 });
    expect(computeSlots(q)).toEqual([]);
    expect(checkSlot(q, T('2026-11-17T15:00:00Z'))).toEqual({ ok: false, reason: 'invalid_duration' });
    expect(computeSlots({ ...q, durationMin: 60 })).toHaveLength(15);
    expect(computeSlots({ ...q, durationMin: 0 })).toEqual([]);
    expect(computeSlots({ ...q, durationMin: Number.NaN })).toEqual([]);
  });

  it('returns slots in ascending order across several days, skipping days off', () => {
    const weekdays = makeHost('jimi', NY, weekly({ 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 5: [['09:00', '12:00']] }));
    const slots = computeSlots(makeQuery({ hosts: [weekdays], range: span('2026-11-14T00:00:00-05:00', '2026-11-23T00:00:00-05:00') }));
    expect(slots).toHaveLength(16 + 16 + 6);
    expect([...new Set(wall(slots, NY, 'ccc dd'))]).toEqual(['Mon 16', 'Tue 17', 'Fri 20']);
    for (let i = 1; i < slots.length; i++) expect(slots[i].startMs).toBeGreaterThan(slots[i - 1].startMs);
  });

  it('lets a meeting run across midnight when the hours do', () => {
    const night = makeHost('jimi', NY, everyDay(['00:00', '02:00'], ['22:00', '24:00']));
    const q = makeQuery({ hosts: [night], range: span('2026-11-17T12:00:00-05:00', '2026-11-18T12:00:00-05:00'), event: { durations: [60] } });
    expect(wall(computeSlots(q), NY, 'ccc HH:mm')).toEqual(['Tue 22:00', 'Tue 22:30', 'Tue 23:00', 'Tue 23:30', 'Wed 00:00', 'Wed 00:30', 'Wed 01:00']);
  });

  it('carries a working window across midnight UTC without a seam', () => {
    // Tuesday and Wednesday afternoons in Los Angeles: 13:00 to 21:00 PST is 21:00Z to 05:00Z the next day.
    const host = makeHost('jimi', LA, weekly({ 2: [['13:00', '21:00']], 3: [['13:00', '21:00']] }));
    const all = computeSlots(makeQuery({ hosts: [host], range: span('2026-11-17T00:00:00Z', '2026-11-20T00:00:00Z') }));
    expect(all).toHaveLength(32);
    expect(zulu(all).slice(4, 8)).toEqual(['2026-11-17T23:00Z', '2026-11-17T23:30Z', '2026-11-18T00:00Z', '2026-11-18T00:30Z']);
    expect(wall(all.slice(0, 16), LA, 'ccc HH:mm')).toEqual(clockTimes('13:00', '20:30', 30).map((t) => `Tue ${t}`));
    // An invitee paging through the UTC day of the 18th sees the tail of Tuesday and the head of Wednesday.
    const utcDay = computeSlots(makeQuery({ hosts: [host], range: span('2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z') }));
    expect(wall(utcDay, 'UTC')).toEqual([...clockTimes('00:00', '04:30', 30), ...clockTimes('21:00', '23:30', 30)]);
    expect(wall(utcDay, LA, 'ccc')).toEqual([...Array(10).fill('Tue'), ...Array(6).fill('Wed')]);
    // A meeting that itself straddles midnight UTC.
    const hour = computeSlots(makeQuery({ hosts: [host], range: span('2026-11-17T23:30:00Z', '2026-11-17T23:45:00Z'), event: { durations: [60] } }));
    expect(hour).toEqual([{ startMs: T('2026-11-17T23:30:00Z'), endMs: T('2026-11-18T00:30:00Z'), hostIds: ['jimi'] }]);
  });

  it('only limits the START to the range: a meeting may end after it', () => {
    const upTo = (end: string) => wall(computeSlots(makeQuery({ hosts: [jimi], range: span('2026-11-17T00:00:00-05:00', end) })), NY);
    expect(upTo('2026-11-17T10:15:00-05:00')).toEqual(['09:00', '09:30', '10:00']);
    expect(upTo('2026-11-17T10:00:00-05:00')).toEqual(['09:00', '09:30']);
    expect(upTo('2026-11-17T10:00:00.001-05:00')).toEqual(['09:00', '09:30', '10:00']);
    const from = (start: string) => wall(computeSlots(makeQuery({ hosts: [jimi], range: span(start, '2026-11-17T11:00:00-05:00') })), NY);
    expect(from('2026-11-17T09:30:00-05:00')).toEqual(['09:30', '10:00', '10:30']);
    expect(from('2026-11-17T09:30:00.001-05:00')).toEqual(['10:00', '10:30']);
    expect(computeSlots(makeQuery({ hosts: [jimi], range: { start: NY_TUESDAY.end, end: NY_TUESDAY.start } }))).toEqual([]);
    expect(computeSlots(makeQuery({ hosts: [jimi], range: { start: NY_TUESDAY.start, end: NY_TUESDAY.start } }))).toEqual([]);
  });

  it('uses the schedule the event type assigns to the host, falling back to the default', () => {
    const host: Host = {
      ...jimi,
      schedules: [
        { id: 'sch_default', name: 'Working hours', weekly: NINE_TO_FIVE, overrides: [] },
        { id: 'sch_mornings', name: 'Mornings', weekly: everyDay(['07:00', '09:00']), overrides: [] },
      ],
    };
    const run = (scheduleIds: Record<string, string>, h: Host = host) => wall(computeSlots(makeQuery({ hosts: [h], range: NY_TUESDAY, event: { scheduling: { scheduleIds } } })), NY);
    expect(run({ jimi: 'sch_mornings' })).toEqual(clockTimes('07:00', '08:30', 30));
    expect(run({})).toEqual(NY_WORKDAY);
    expect(run({ someone_else: 'sch_mornings' })).toEqual(NY_WORKDAY);
    expect(run({ jimi: 'sch_deleted' })).toEqual(NY_WORKDAY);
    expect(run({}, { ...host, defaultScheduleId: 'sch_gone' })).toEqual(NY_WORKDAY);
    expect(run({}, { ...host, schedules: [] })).toEqual([]);
  });

  it('has no slots without hosts, and fails loudly on unusable inputs', () => {
    expect(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { hostIds: [] } }))).toEqual([]);
    expect(() => computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, ownerTimezone: 'Nope/Nowhere' }))).toThrow(RangeError);
    expect(() => checkSlot(makeQuery({ hosts: [jimi], range: NY_TUESDAY, ownerTimezone: 'Nope/Nowhere' }), NY_TUESDAY.start)).toThrow(RangeError);
    expect(() => computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, nowMs: Number.NaN }))).toThrow(RangeError);
    expect(() => computeSlots(makeQuery({ hosts: [jimi], range: { start: Number.NaN, end: NY_TUESDAY.end } }))).toThrow(RangeError);
    expect(() =>
      computeSlots(makeQuery({ hosts: [jimi], range: { start: NY_TUESDAY.start, end: Number.POSITIVE_INFINITY }, event: { scheduling: { maxDaysAhead: Number.POSITIVE_INFINITY } } })),
    ).toThrow(RangeError);
  });

  it('answers at once for times at the edge of what a Date can hold', () => {
    const q = makeQuery({ hosts: [jimi], range: { start: -9e15, end: 9e15 }, event: { scheduling: { maxDaysAhead: Number.POSITIVE_INFINITY } } });
    expect(checkSlot(q, 8.64e15)).toEqual({ ok: false, reason: 'too_far' });
    expect(checkSlot(q, -8.64e15)).toEqual({ ok: false, reason: 'too_soon' });
    expect(checkSlot(q, Number.MAX_SAFE_INTEGER)).toEqual({ ok: false, reason: 'too_far' });
    expect(checkSlot(q, Number.MIN_SAFE_INTEGER)).toEqual({ ok: false, reason: 'too_soon' });
    expect(checkSlot(q, T('2026-11-17T09:00:00-05:00'))).toEqual({ ok: true, hostIds: ['jimi'] });
    // A sane rolling window makes the absurd range harmless; without one the call is refused, not attempted.
    expect(() => computeSlots(q)).toThrow(RangeError);
    const bounded = { ...q, eventType: makeEvent({ scheduling: { maxDaysAhead: 365 } }), nowMs: T('2026-11-16T00:00:00Z') };
    expect(computeSlots(bounded)).toHaveLength(365 * 16);
    // The last year a Date can hold is out of bounds for both functions alike.
    const lastDays = { ...q, range: { start: 8.63999e15, end: 8.64e15 } };
    expect(computeSlots(lastDays)).toEqual([]);
    expect(checkSlot(lastDays, 8.639995e15)).toEqual({ ok: false, reason: 'too_far' });
    expect(() => scheduleWindows(jimi.schedules[0], NY, { start: 8.6399e15, end: 8.64e15 })).toThrow(RangeError);
  });

  it('treats a host with an unreadable zone as never free', () => {
    const broken = makeHost('alex', 'Nope/Nowhere');
    expect(computeSlots(makeQuery({ hosts: [broken], range: NY_TUESDAY, ownerTimezone: NY }))).toEqual([]);
    expect(computeSlots(makeQuery({ hosts: [jimi, broken], range: NY_TUESDAY }))).toEqual([]);
    const rr = computeSlots(makeQuery({ hosts: [jimi, broken], range: NY_TUESDAY, event: { kind: 'round_robin' } }));
    expect(rr).toHaveLength(16);
    expect(rr.every((s) => s.hostIds.join() === 'jimi')).toBe(true);
  });

  it('survives a nonsense slot increment', () => {
    const run = (slotIncrementMin: number) => wall(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { scheduling: { slotIncrementMin } } })), NY);
    expect(run(Number.NaN)).toEqual(NY_WORKDAY);
    expect(run(0)).toHaveLength(8 * 60 - 29);
    expect(run(-15)).toHaveLength(8 * 60 - 29);
    expect(run(100000)).toEqual([]);
    expect(run(120)).toEqual(['10:00', '12:00', '14:00', '16:00']);
    expect(run(5)).toEqual(clockTimes('09:00', '16:30', 5));
    expect(run(50)).toEqual(['09:10', '10:00', '10:50', '11:40', '12:30', '13:20', '14:10', '15:00', '15:50']);
  });

  it('restarts the grid at every local midnight when the increment does not divide a day', () => {
    // 50 minute steps run 00:00, 00:50 ... 23:20. The next one is 00:00 the following day, not 00:10.
    const always = makeHost('jimi', NY, everyDay(['00:00', '24:00']));
    const q = makeQuery({ hosts: [always], range: span('2026-11-17T22:00:00-05:00', '2026-11-19T02:00:00-05:00'), event: { durations: [15], scheduling: { slotIncrementMin: 50 } } });
    const times = wall(computeSlots(q), NY, 'ccc HH:mm');
    expect(times.slice(0, 5)).toEqual(['Tue 22:30', 'Tue 23:20', 'Wed 00:00', 'Wed 00:50', 'Wed 01:40']);
    expect(times.slice(-5)).toEqual(['Wed 22:30', 'Wed 23:20', 'Thu 00:00', 'Thu 00:50', 'Thu 01:40']);
    expect(times).toHaveLength(2 + 29 + 3);
    expect(checkSlot(q, T('2026-11-18T00:00:00-05:00'))).toEqual({ ok: true, hostIds: ['jimi'] });
    expect(checkSlot(q, T('2026-11-18T00:10:00-05:00'))).toEqual({ ok: false, reason: 'not_on_grid' });
    // The owner's midnight is the anchor, wherever the host is.
    // The range holds one midnight in India (18:30Z), which is early afternoon for the New York host.
    const kolkata = wall(computeSlots({ ...q, ownerTimezone: IST }), IST, 'HH:mm');
    const midnight = kolkata.indexOf('00:00');
    expect(kolkata.slice(midnight - 2, midnight + 3)).toEqual(['22:30', '23:20', '00:00', '00:50', '01:40']);
    expect(kolkata.filter((t) => t === '00:00')).toHaveLength(1);
  });
});

describe('busy time and buffers', () => {
  const jimiBusy = (...busy: Interval[]): HostAvailabilityInput => ({ host: makeHost('jimi', NY), busy });
  const ny = (from: string, to: string): Interval => span(`2026-11-17T${from}-05:00`, `2026-11-17T${to}-05:00`);
  const offered = (busy: Interval[], scheduling: Partial<EventScheduling> = {}, extra: Partial<QueryInput> = {}) =>
    wall(computeSlots(makeQuery({ hosts: [jimiBusy(...busy)], range: NY_TUESDAY, event: { scheduling }, ...extra })), NY);

  it('treats busy time as half-open: touching a slot edge is fine', () => {
    expect(offered([ny('10:00:00', '10:30:00')])).toEqual(without(NY_WORKDAY, '10:00'));
    expect(offered([ny('10:00:00', '10:30:00.001')])).toEqual(without(NY_WORKDAY, '10:00', '10:30'));
    expect(offered([ny('09:59:59.999', '10:30:00')])).toEqual(without(NY_WORKDAY, '09:30', '10:00'));
    expect(offered([ny('10:15:00', '10:20:00')])).toEqual(without(NY_WORKDAY, '10:00'));
    expect(offered([ny('10:29:59.999', '10:30:00')])).toEqual(without(NY_WORKDAY, '10:00'));
    expect(offered([ny('10:30:00', '10:30:00.001')])).toEqual(without(NY_WORKDAY, '10:30'));
  });

  it('ignores empty and backwards busy intervals', () => {
    expect(offered([ny('10:00:00', '10:00:00'), { start: T('2026-11-17T16:00:00Z'), end: T('2026-11-17T15:00:00Z') }, { start: Number.NaN, end: Number.NaN }])).toEqual(NY_WORKDAY);
  });

  it('handles unsorted, overlapping and all-day busy time', () => {
    expect(offered([ny('13:00:00', '14:00:00'), ny('09:00:00', '09:45:00'), ny('13:30:00', '15:10:00'), ny('09:20:00', '10:00:00')])).toEqual(
      without(NY_WORKDAY, '09:00', '09:30', '13:00', '13:30', '14:00', '14:30', '15:00'),
    );
    expect(offered([span('2026-11-16T00:00:00Z', '2026-11-19T00:00:00Z')])).toEqual([]);
    expect(offered([span('2026-11-10T00:00:00Z', '2026-11-17T14:00:00Z'), span('2026-11-17T22:00:00Z', '2026-11-20T00:00:00Z')])).toEqual(NY_WORKDAY);
  });

  it('keeps the buffer before and the buffer after clear of busy time', () => {
    const buffers = { bufferBeforeMin: 15, bufferAfterMin: 10 };
    // A start s is ruled out when 10:20 < s < 12:15.
    expect(offered([ny('11:00:00', '12:00:00')], buffers)).toEqual(without(NY_WORKDAY, '10:30', '11:00', '11:30', '12:00'));
    expect(offered([ny('11:00:00', '12:00:00')])).toEqual(without(NY_WORKDAY, '11:00', '11:30'));
    expect(offered([ny('11:00:00', '12:00:00')], { bufferBeforeMin: 15 })).toEqual(without(NY_WORKDAY, '11:00', '11:30', '12:00'));
    expect(offered([ny('11:00:00', '12:00:00')], { bufferAfterMin: 10 })).toEqual(without(NY_WORKDAY, '10:30', '11:00', '11:30'));
  });

  it('lets a buffer touch busy time exactly', () => {
    const buffers = { bufferBeforeMin: 15, bufferAfterMin: 10 };
    // 10:30 + 30 + 10 = 11:10 and 12:30 - 15 = 12:15: both only touch.
    expect(offered([ny('11:10:00', '12:15:00')], buffers)).toEqual(without(NY_WORKDAY, '11:00', '11:30', '12:00'));
    expect(offered([ny('11:09:59.999', '12:15:00.001')], buffers)).toEqual(without(NY_WORKDAY, '10:30', '11:00', '11:30', '12:00', '12:30'));
  });

  it('lets buffers reach outside working hours, where only busy time matters', () => {
    const buffers = { bufferBeforeMin: 30, bufferAfterMin: 30 };
    expect(offered([], buffers)).toEqual(NY_WORKDAY);
    expect(offered([ny('08:40:00', '08:50:00')], buffers)).toEqual(without(NY_WORKDAY, '09:00'));
    expect(offered([ny('17:10:00', '17:20:00')], buffers)).toEqual(without(NY_WORKDAY, '16:30'));
    expect(offered([ny('08:00:00', '08:30:00'), ny('17:30:00', '18:00:00')], buffers)).toEqual(NY_WORKDAY);
  });

  it('counts our own confirmed bookings as busy for the hosts assigned to them only', () => {
    const jimi = makeHost('jimi', NY);
    const alex = makeHost('alex', NY);
    const index = [
      booked('bk_a', '2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00', ['jimi']),
      booked('bk_b', '2026-11-17T11:00:00-05:00', '2026-11-17T12:00:00-05:00', ['alex'], { eventTypeId: 'other' }),
      booked('bk_c', '2026-11-17T13:00:00-05:00', '2026-11-17T13:30:00-05:00', ['jimi', 'alex']),
      booked('bk_d', '2026-11-17T14:00:00-05:00', '2026-11-17T14:30:00-05:00', ['jimi'], { status: 'cancelled' }),
      booked('bk_e', '2026-11-17T15:00:00-05:00', '2026-11-17T15:30:00-05:00', ['stranger']),
      { ...booked('bk_f', '2026-11-17T15:30:00-05:00', '2026-11-17T16:00:00-05:00', ['jimi']), start: 'not a date' },
    ];
    expect(wall(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, index })), NY)).toEqual(without(NY_WORKDAY, '10:00', '13:00'));
    expect(wall(computeSlots(makeQuery({ hosts: [alex], range: NY_TUESDAY, index })), NY)).toEqual(without(NY_WORKDAY, '11:00', '11:30', '13:00'));
    expect(wall(computeSlots(makeQuery({ hosts: [jimi, alex], range: NY_TUESDAY, index })), NY)).toEqual(without(NY_WORKDAY, '10:00', '11:00', '11:30', '13:00'));
  });

  it('pads only the candidate by default, and both meetings when booking buffers are supplied', () => {
    const jimi = makeHost('jimi', NY);
    const index = [booked('bk_a', '2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00', ['jimi'])];
    const base: QueryInput = { hosts: [jimi], range: NY_TUESDAY, index, event: { scheduling: { bufferAfterMin: 10 } } };
    // As specified: the new meeting's own buffer must be clear, so 09:30 goes, but 10:30 right after the booking stays.
    expect(wall(computeSlots(makeQuery(base)), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00'));
    // Opt-in: the existing booking keeps its 10 minutes too.
    const padded = makeQuery({ ...base, ownBookingBuffers: { evt: { beforeMin: 0, afterMin: 10 } } });
    expect(wall(computeSlots(padded), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00', '10:30'));
    expect(checkSlot(padded, T('2026-11-17T10:30:00-05:00'))).toEqual({ ok: false, reason: 'busy' });
    expect(checkSlot(makeQuery(base), T('2026-11-17T10:30:00-05:00'))).toEqual({ ok: true, hostIds: ['jimi'] });
    // Buffers are looked up by the booking's own event type.
    const other = makeQuery({ ...base, ownBookingBuffers: { other: { beforeMin: 60, afterMin: 60 } } });
    expect(wall(computeSlots(other), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00'));
    const before = makeQuery({ ...base, event: {}, ownBookingBuffers: { evt: { beforeMin: 30, afterMin: 0 } } });
    expect(wall(computeSlots(before), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00'));
  });
});

describe('notice, rolling window, hard date window', () => {
  const jimi = makeHost('jimi', NY);

  it('applies minimum notice to the millisecond', () => {
    const run = (now: string, minNoticeMinutes: number) =>
      wall(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, nowMs: T(now), event: { scheduling: { minNoticeMinutes } } })), NY);
    expect(run('2026-11-17T10:00:00-05:00', 240)).toEqual(clockTimes('14:00', '16:30', 30));
    expect(run('2026-11-17T10:00:00.001-05:00', 240)).toEqual(clockTimes('14:30', '16:30', 30));
    expect(run('2026-11-17T09:59:59.999-05:00', 240)).toEqual(clockTimes('14:00', '16:30', 30));
    expect(run('2026-11-17T10:00:00-05:00', 0)).toEqual(clockTimes('10:00', '16:30', 30));
    expect(run('2026-11-17T10:00:00.001-05:00', 0)).toEqual(clockTimes('10:30', '16:30', 30));
    expect(run('2026-11-17T16:30:00.001-05:00', 0)).toEqual([]);
    expect(run('2026-11-16T12:00:00-05:00', 1440)).toEqual(clockTimes('12:00', '16:30', 30));
    // A negative notice period never opens the past.
    expect(run('2026-11-17T10:00:00-05:00', -600)).toEqual(clockTimes('10:00', '16:30', 30));
  });

  it('stops at the rolling window, exclusive', () => {
    const run = (now: string, maxDaysAhead: number) =>
      wall(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, nowMs: T(now), event: { scheduling: { maxDaysAhead } } })), NY);
    expect(run('2026-11-10T12:00:00-05:00', 7)).toEqual(clockTimes('09:00', '11:30', 30));
    expect(run('2026-11-10T12:00:00.001-05:00', 7)).toEqual(clockTimes('09:00', '12:00', 30));
    expect(run('2026-11-10T12:00:00-05:00', 6)).toEqual([]);
    expect(run('2026-11-10T12:00:00-05:00', 8)).toEqual(NY_WORKDAY);
    expect(run('2026-11-10T12:00:00-05:00', 0)).toEqual([]);
  });

  it('keeps to a hard date window read in the owner zone, end date included', () => {
    const week = span('2026-11-16T00:00:00-05:00', '2026-11-21T00:00:00-05:00');
    const run = (dateRange: { start: string; end: string } | null) =>
      [...new Set(wall(computeSlots(makeQuery({ hosts: [jimi], range: week, event: { scheduling: { dateRange } } })), NY, 'ccc dd'))];
    expect(run(null)).toEqual(['Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20']);
    expect(run({ start: '2026-11-17', end: '2026-11-18' })).toEqual(['Tue 17', 'Wed 18']);
    expect(run({ start: '2026-11-18', end: '2026-11-18' })).toEqual(['Wed 18']);
    expect(run({ start: '2026-11-19', end: '2026-11-18' })).toEqual([]);
    expect(run({ start: '2026-01-01', end: '2026-11-16' })).toEqual(['Mon 16']);
    expect(run({ start: 'garbage', end: '2026-11-18' })).toEqual([]);
  });

  it('reads the hard date window in the OWNER zone even when the host lives elsewhere', () => {
    // Owner in Auckland: "November 18" there is Tuesday 11:00Z to Wednesday 11:00Z, which holds all of New York's Tuesday.
    const q = makeQuery({
      hosts: [jimi],
      ownerTimezone: AKL,
      range: span('2026-11-16T00:00:00Z', '2026-11-21T00:00:00Z'),
      event: { scheduling: { dateRange: { start: '2026-11-18', end: '2026-11-18' } } },
    });
    const slots = computeSlots(q);
    expect(wall(slots, NY, 'ccc dd HH:mm')).toEqual(NY_WORKDAY.map((t) => `Tue 17 ${t}`));
    expect(checkSlot(q, T('2026-11-16T15:00:00Z'))).toEqual({ ok: false, reason: 'too_soon' });
    expect(checkSlot(q, T('2026-11-18T15:00:00Z'))).toEqual({ ok: false, reason: 'too_far' });
  });
});

describe('the grid lives in the owner zone', () => {
  it('anchors hourly slots at the top of the hour on the owner clock', () => {
    const jimi = makeHost('jimi', NY);
    const run = (ownerTimezone: string, slotIncrementMin: number) =>
      wall(computeSlots(makeQuery({ hosts: [jimi], range: NY_TUESDAY, ownerTimezone, event: { scheduling: { slotIncrementMin } } })), NY);
    expect(run(NY, 60)).toEqual(clockTimes('09:00', '16:00', 60));
    // India is UTC+5:30, so its :00 is New York's :30. Nepal is UTC+5:45, so its :00 is New York's :15.
    expect(run(IST, 60)).toEqual(clockTimes('09:30', '16:30', 60));
    expect(run(KTM, 60)).toEqual(clockTimes('09:15', '16:15', 60));
    expect(run(KTM, 30)).toEqual(clockTimes('09:15', '16:15', 30));
    expect(run(IST, 30)).toEqual(NY_WORKDAY);
    expect(run('America/St_Johns', 60)).toEqual(clockTimes('09:30', '16:30', 60));
  });

  it('serves hosts in half-hour and 45 minute offset zones', () => {
    const nepal = makeHost('jimi', KTM);
    const tuesdayNepal = span('2026-11-17T00:00:00+05:45', '2026-11-18T00:00:00+05:45');
    // 09:00 to 17:00 in Kathmandu is 03:15Z to 11:15Z. On a New York grid the first half-hour mark inside is 03:30Z.
    const forNyOwner = computeSlots(makeQuery({ hosts: [nepal], range: tuesdayNepal, ownerTimezone: NY }));
    expect(zulu(forNyOwner)[0]).toBe('2026-11-17T03:30Z');
    expect(wall(forNyOwner, KTM)).toEqual(clockTimes('09:15', '16:15', 30));
    expect(wall(computeSlots(makeQuery({ hosts: [nepal], range: tuesdayNepal })), KTM)).toEqual(NY_WORKDAY);

    const india = makeHost('jimi', IST);
    const tuesdayIndia = span('2026-11-17T00:00:00+05:30', '2026-11-18T00:00:00+05:30');
    const indian = computeSlots(makeQuery({ hosts: [india], range: tuesdayIndia, ownerTimezone: NY }));
    expect(zulu(indian)[0]).toBe('2026-11-17T03:30Z');
    expect(zulu(indian)[15]).toBe('2026-11-17T11:00Z');
    expect(wall(indian, IST)).toEqual(NY_WORKDAY);
  });

  it('shows a Nairobi host to an invitee browsing a Los Angeles day', () => {
    const jimi = makeHost('jimi', NBO, weekly({ 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] }));
    const laTuesday = span('2026-11-17T00:00:00-08:00', '2026-11-18T00:00:00-08:00');
    const slots = computeSlots(makeQuery({ hosts: [jimi], range: laTuesday }));
    // Nairobi Tuesday 11:00 to 16:30, then Nairobi Wednesday 09:00 to 10:30, all inside Tuesday in Los Angeles.
    expect(wall(slots, NBO, 'ccc HH:mm')).toEqual([...clockTimes('11:00', '16:30', 30).map((t) => `Tue ${t}`), ...clockTimes('09:00', '10:30', 30).map((t) => `Wed ${t}`)]);
    expect(wall(slots, LA, 'ccc HH:mm')).toEqual([...clockTimes('00:00', '05:30', 30).map((t) => `Tue ${t}`), ...clockTimes('22:00', '23:30', 30).map((t) => `Tue ${t}`)]);
    expect(zulu(slots)[0]).toBe('2026-11-17T08:00Z');
    expect(zulu(slots)[slots.length - 1]).toBe('2026-11-18T07:30Z');
  });
});

describe('clock-change days', () => {
  const sundayHost = (tz: string, ...ranges: Ranges) => makeHost('jimi', tz, weekly({ 0: ranges, 6: ranges, 1: ranges }));
  const nySpring = span('2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00');
  const nyFall = span('2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00');

  it('New York spring forward: no slot in the skipped hour, real elapsed durations', () => {
    const host = sundayHost(NY, ['01:00', '04:00']);
    const slots = computeSlots(makeQuery({ hosts: [host], range: nySpring }));
    expect(zulu(slots)).toEqual(['2026-03-08T06:00Z', '2026-03-08T06:30Z', '2026-03-08T07:00Z', '2026-03-08T07:30Z']);
    expect(wall(slots, NY, 'HH:mm ZZ')).toEqual(['01:00 -05:00', '01:30 -05:00', '03:00 -04:00', '03:30 -04:00']);

    const hour = computeSlots(makeQuery({ hosts: [host], range: nySpring, event: { durations: [60] } }));
    expect(zulu(hour)).toEqual(['2026-03-08T06:00Z', '2026-03-08T06:30Z', '2026-03-08T07:00Z']);
    // 01:30 EST plus an hour of real time is 03:30 EDT.
    expect(DateTime.fromMillis(hour[1].endMs, { zone: NY }).toFormat('HH:mm ZZ')).toBe('03:30 -04:00');
  });

  it('New York spring forward: ordinary working hours shift by an hour in UTC', () => {
    const host = sundayHost(NY, ['09:00', '17:00']);
    const weekend = span('2026-03-07T00:00:00-05:00', '2026-03-09T00:00:00-04:00');
    const slots = computeSlots(makeQuery({ hosts: [host], range: weekend }));
    expect(slots).toHaveLength(32);
    expect(zulu(slots)[0]).toBe('2026-03-07T14:00Z');
    expect(zulu(slots)[16]).toBe('2026-03-08T13:00Z');
    expect(wall(slots, NY)).toEqual([...NY_WORKDAY, ...NY_WORKDAY]);
  });

  it('New York fall back: both passes through the repeated hour are bookable', () => {
    const host = sundayHost(NY, ['01:00', '03:00']);
    const slots = computeSlots(makeQuery({ hosts: [host], range: nyFall }));
    expect(zulu(slots)).toEqual(['2026-11-01T05:00Z', '2026-11-01T05:30Z', '2026-11-01T06:00Z', '2026-11-01T06:30Z', '2026-11-01T07:00Z', '2026-11-01T07:30Z']);
    expect(wall(slots, NY, 'HH:mm ZZ')).toEqual(['01:00 -04:00', '01:30 -04:00', '01:00 -05:00', '01:30 -05:00', '02:00 -05:00', '02:30 -05:00']);
    for (const s of slots) expect(checkSlot(makeQuery({ hosts: [host], range: nyFall }), s.startMs)).toEqual({ ok: true, hostIds: ['jimi'] });
  });

  it('New York fall back: a range naming the repeated hour only covers its first pass', () => {
    const host = sundayHost(NY, ['01:30', '02:00']);
    // 01:30 (first pass, EDT) to 02:00 (unique, EST) is 90 minutes of real time.
    expect(zulu(computeSlots(makeQuery({ hosts: [host], range: nyFall })))).toEqual(['2026-11-01T05:30Z', '2026-11-01T06:00Z', '2026-11-01T06:30Z']);
    const firstPassOnly = sundayHost(NY, ['01:00', '01:30']);
    expect(zulu(computeSlots(makeQuery({ hosts: [firstPassOnly], range: nyFall })))).toEqual(['2026-11-01T05:00Z']);
  });

  it('keeps slots on the same clock times when the increment does not divide the shift', () => {
    const event: EventOverrides = { durations: [15], scheduling: { slotIncrementMin: 45 } };
    const spring = computeSlots(makeQuery({ hosts: [sundayHost(NY, ['00:00', '06:00'])], range: nySpring, event }));
    // 02:15 does not exist that morning; the grid carries on at 03:00, not 03:15.
    expect(wall(spring, NY)).toEqual(['00:00', '00:45', '01:30', '03:00', '03:45', '04:30', '05:15']);
    expect(zulu(spring)).toEqual(['2026-03-08T05:00Z', '2026-03-08T05:45Z', '2026-03-08T06:30Z', '2026-03-08T07:00Z', '2026-03-08T07:45Z', '2026-03-08T08:30Z', '2026-03-08T09:15Z']);

    // The slot at the very instant of the jump (07:00Z, which reads 03:00) is on the grid for checkSlot too.
    const springQuery = makeQuery({ hosts: [sundayHost(NY, ['00:00', '06:00'])], range: nySpring, event });
    for (const s of spring) expect(checkSlot(springQuery, s.startMs)).toEqual({ ok: true, hostIds: ['jimi'] });
    expect(checkSlot(springQuery, T('2026-03-08T07:15:00Z'))).toEqual({ ok: false, reason: 'not_on_grid' });
    expect(checkSlot(springQuery, T('2026-03-08T06:45:00Z'))).toEqual({ ok: false, reason: 'not_on_grid' });

    const twoHourly = computeSlots(makeQuery({ hosts: [sundayHost(NY, ['00:00', '10:00'])], range: nySpring, event: { durations: [15], scheduling: { slotIncrementMin: 120 } } }));
    expect(wall(twoHourly, NY)).toEqual(['00:00', '04:00', '06:00', '08:00']);

    const fall = computeSlots(makeQuery({ hosts: [sundayHost(NY, ['00:00', '04:00'])], range: nyFall, event }));
    expect(wall(fall, NY, 'HH:mm ZZ')).toEqual(['00:00 -04:00', '00:45 -04:00', '01:30 -04:00', '01:30 -05:00', '02:15 -05:00', '03:00 -05:00', '03:45 -05:00']);
    expect(zulu(fall)).toEqual(['2026-11-01T04:00Z', '2026-11-01T04:45Z', '2026-11-01T05:30Z', '2026-11-01T06:30Z', '2026-11-01T07:15Z', '2026-11-01T08:00Z', '2026-11-01T08:45Z']);
  });

  it('London spring forward and fall back', () => {
    const host = sundayHost(LON, ['00:00', '03:00']);
    const spring = computeSlots(makeQuery({ hosts: [host], range: span('2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z') }));
    expect(zulu(spring)).toEqual(['2026-03-29T00:00Z', '2026-03-29T00:30Z', '2026-03-29T01:00Z', '2026-03-29T01:30Z']);
    expect(wall(spring, LON, 'HH:mm ZZ')).toEqual(['00:00 +00:00', '00:30 +00:00', '02:00 +01:00', '02:30 +01:00']);

    const fall = computeSlots(makeQuery({ hosts: [host], range: span('2026-10-25T00:00:00+01:00', '2026-10-26T00:00:00Z') }));
    expect(zulu(fall)).toEqual([
      '2026-10-24T23:00Z', '2026-10-24T23:30Z', '2026-10-25T00:00Z', '2026-10-25T00:30Z',
      '2026-10-25T01:00Z', '2026-10-25T01:30Z', '2026-10-25T02:00Z', '2026-10-25T02:30Z',
    ]);
    expect(wall(fall, LON, 'HH:mm ZZ')).toEqual([
      '00:00 +01:00', '00:30 +01:00', '01:00 +01:00', '01:30 +01:00',
      '01:00 +00:00', '01:30 +00:00', '02:00 +00:00', '02:30 +00:00',
    ]);

    const office = sundayHost(LON, ['09:00', '17:00']);
    const days = computeSlots(makeQuery({ hosts: [office], range: span('2026-10-24T00:00:00+01:00', '2026-10-26T00:00:00Z') }));
    expect(zulu(days)[0]).toBe('2026-10-24T08:00Z');
    expect(zulu(days)[16]).toBe('2026-10-25T09:00Z');
    expect(wall(days, LON)).toEqual([...NY_WORKDAY, ...NY_WORKDAY]);
  });

  it('walks the owner grid through a clock change the host does not have', () => {
    // Owner in New York on the spring-forward morning, host in Nairobi (no clock changes), hourly grid.
    const host = makeHost('jimi', NBO, everyDay(['00:00', '24:00']));
    const q = makeQuery({ hosts: [host], ownerTimezone: NY, range: span('2026-03-08T04:00:00Z', '2026-03-08T10:00:00Z'), event: { scheduling: { slotIncrementMin: 60 } } });
    expect(zulu(computeSlots(q))).toEqual(['2026-03-08T04:00Z', '2026-03-08T05:00Z', '2026-03-08T06:00Z', '2026-03-08T07:00Z', '2026-03-08T08:00Z', '2026-03-08T09:00Z']);
    // Lord Howe Island moves its clocks by 30 minutes: an hourly grid there slides by half an hour in UTC.
    const lordHowe = makeQuery({ hosts: [host], ownerTimezone: 'Australia/Lord_Howe', range: span('2026-10-03T13:00:00Z', '2026-10-03T18:00:00Z'), event: { scheduling: { slotIncrementMin: 60 } } });
    expect(zulu(computeSlots(lordHowe))).toEqual(['2026-10-03T13:30Z', '2026-10-03T14:30Z', '2026-10-03T16:00Z', '2026-10-03T17:00Z']);
  });
});

describe('collective events: only when every host is free', () => {
  const jimi = makeHost('jimi', NBO);
  const alex = makeHost('alex', LON);
  const utcTuesday = span('2026-11-17T00:00:00Z', '2026-11-18T00:00:00Z');

  it('intersects two hosts in different zones', () => {
    // Nairobi 09:00 to 17:00 is 06:00Z to 14:00Z; London is 09:00Z to 17:00Z. Shared: 09:00Z to 14:00Z.
    const slots = computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday }));
    expect(zulu(slots)).toEqual(clockTimes('09:00', '13:30', 30).map((t) => `2026-11-17T${t}Z`));
    expect(slots.every((s) => s.hostIds.join() === 'jimi,alex')).toBe(true);
    expect(wall(slots, NBO)[0]).toBe('12:00');
    expect(wall(slots, LON)[0]).toBe('09:00');
  });

  it('removes times when either host is busy', () => {
    const slots = computeSlots(
      makeQuery({
        hosts: [
          { host: jimi, busy: [span('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')] },
          { host: alex, busy: [span('2026-11-17T12:30:00Z', '2026-11-17T13:00:00Z')] },
        ],
        range: utcTuesday,
        index: [booked('bk_x', '2026-11-17T09:00:00Z', '2026-11-17T09:30:00Z', ['alex'], { eventTypeId: 'other' })],
      }),
    );
    expect(wall(slots, 'UTC')).toEqual(['09:30', '11:00', '11:30', '12:00', '13:00', '13:30']);
  });

  it('follows each host through their own clock changes', () => {
    const run = (day: string, hosts: Host[]) => wall(computeSlots(makeQuery({ hosts, range: span(`${day}T00:00:00Z`, `${day}T23:59:00Z`) })), 'UTC');
    // July: London is on summer time (08:00Z to 16:00Z), Nairobi never changes.
    expect(run('2026-07-14', [jimi, alex])).toEqual(clockTimes('08:00', '13:30', 30));
    // Three Tuesdays in March with New York and London: the US changes on the 8th, the UK on the 29th.
    const ny = makeHost('jimi', NY);
    expect(run('2026-03-03', [ny, alex])).toEqual(clockTimes('14:00', '16:30', 30));
    expect(run('2026-03-10', [ny, alex])).toEqual(clockTimes('13:00', '16:30', 30));
    expect(run('2026-03-31', [ny, alex])).toEqual(clockTimes('13:00', '15:30', 30));
  });

  it('needs every listed host, in the order the event type lists them', () => {
    const sam = makeHost('sam', 'Asia/Dubai', everyDay(['14:00', '16:00']));
    // Dubai 14:00 to 16:00 is 10:00Z to 12:00Z.
    const three = computeSlots(makeQuery({ hosts: [sam, jimi, alex], range: utcTuesday, event: { hostIds: ['alex', 'sam', 'jimi'], kind: 'collective' } }));
    expect(wall(three, 'UTC')).toEqual(['10:00', '10:30', '11:00', '11:30']);
    expect(three[0].hostIds).toEqual(['alex', 'sam', 'jimi']);
    // No overlap at all.
    const tokyo = makeHost('sam', 'Asia/Tokyo');
    expect(computeSlots(makeQuery({ hosts: [tokyo, alex], range: utcTuesday }))).toEqual([]);
  });

  it('offers nothing when a listed host is missing from the query, and ignores hosts that are not listed', () => {
    const missing = makeQuery({ hosts: [jimi], range: utcTuesday, event: { hostIds: ['jimi', 'alex'], kind: 'collective' } });
    expect(computeSlots(missing)).toEqual([]);
    expect(checkSlot(missing, T('2026-11-17T10:00:00Z'))).toEqual({ ok: false, reason: 'outside_hours' });
    const extra = makeQuery({ hosts: [jimi, { host: alex, busy: [utcTuesday] }], range: utcTuesday, event: { hostIds: ['jimi'], kind: 'solo' } });
    expect(computeSlots(extra)).toHaveLength(16);
    const repeated = makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: { hostIds: ['jimi', 'alex', 'jimi'], kind: 'collective' } });
    expect(computeSlots(repeated)[0].hostIds).toEqual(['jimi', 'alex']);
  });

  it('treats a solo event with one host the same way', () => {
    const slots = computeSlots(makeQuery({ hosts: [jimi], range: utcTuesday }));
    expect(wall(slots, 'UTC')).toEqual(clockTimes('06:00', '13:30', 30));
    expect(slots.every((s) => s.hostIds.join() === 'jimi')).toBe(true);
  });
});

describe('round robin: whenever at least one host is free', () => {
  const jimi = makeHost('jimi', NBO);
  const alex = makeHost('alex', LON);
  const utcTuesday = span('2026-11-17T00:00:00Z', '2026-11-18T00:00:00Z');
  const rr: EventOverrides = { kind: 'round_robin' };
  const byTime = (slots: Slot[]) => Object.fromEntries(slots.map((s) => [iso(s.startMs).slice(11, 16), s.hostIds.join('+')]));

  it('offers the union and names the hosts who are free', () => {
    const slots = computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: rr }));
    expect(wall(slots, 'UTC')).toEqual(clockTimes('06:00', '16:30', 30));
    const who = byTime(slots);
    for (const t of clockTimes('06:00', '08:30', 30)) expect(who[t], t).toBe('jimi');
    for (const t of clockTimes('09:00', '13:30', 30)) expect(who[t], t).toBe('jimi+alex');
    for (const t of clockTimes('14:00', '16:30', 30)) expect(who[t], t).toBe('alex');
  });

  it('drops a busy host from a slot and drops the slot when nobody is left', () => {
    const slots = computeSlots(
      makeQuery({
        hosts: [
          { host: jimi, busy: [span('2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z'), span('2026-11-17T11:00:00Z', '2026-11-17T11:30:00Z'), span('2026-11-17T07:00:00Z', '2026-11-17T07:30:00Z')] },
          { host: alex, busy: [span('2026-11-17T11:00:00Z', '2026-11-17T11:30:00Z'), span('2026-11-17T12:00:00Z', '2026-11-17T12:30:00Z')] },
        ],
        range: utcTuesday,
        event: rr,
      }),
    );
    const who = byTime(slots);
    expect(who['09:00']).toBe('alex');
    expect(who['09:30']).toBe('alex');
    expect(who['10:00']).toBe('jimi+alex');
    expect(who['11:00']).toBeUndefined();
    expect(who['12:00']).toBe('jimi');
    expect(who['07:00']).toBeUndefined();
    expect(slots).toHaveLength(22 - 2);
  });

  it('lists free hosts in the event type order', () => {
    const slots = computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: { ...rr, hostIds: ['alex', 'jimi'] } }));
    expect(byTime(slots)['10:00']).toBe('alex+jimi');
  });

  it('still works when one listed host is missing from the query', () => {
    const slots = computeSlots(makeQuery({ hosts: [alex], range: utcTuesday, event: { ...rr, hostIds: ['jimi', 'alex'] } }));
    expect(wall(slots, 'UTC')).toEqual(clockTimes('09:00', '16:30', 30));
    expect(slots.every((s) => s.hostIds.join() === 'alex')).toBe(true);
  });
});

describe('daily cap (maxPerDay)', () => {
  // Auckland is UTC+13 in November. The owner is in London, so owner days and UTC days coincide.
  const kiri = makeHost('kiri', AKL);
  const localWeek = span('2026-11-17T00:00:00+13:00', '2026-11-21T00:00:00+13:00');
  const event: EventOverrides = { hostIds: ['kiri'], scheduling: { maxPerDay: 2 } };
  const bookings = [
    // Two on the host's Wednesday. In UTC (and for the owner) they fall on different days.
    booked('b1', '2026-11-18T09:00:00+13:00', '2026-11-18T09:30:00+13:00', ['kiri']),
    booked('b2', '2026-11-18T16:00:00+13:00', '2026-11-18T16:30:00+13:00', ['kiri']),
    // One late on the host's Thursday and one early on Friday. In UTC both are on the 19th.
    booked('b3', '2026-11-19T16:30:00+13:00', '2026-11-19T17:00:00+13:00', ['kiri']),
    booked('b4', '2026-11-20T09:00:00+13:00', '2026-11-20T09:30:00+13:00', ['kiri']),
  ];
  const byDay = (slots: Slot[]) => {
    const out: Record<string, string[]> = {};
    for (const s of slots) {
      const dt = DateTime.fromMillis(s.startMs, { zone: AKL });
      (out[dt.toFormat('ccc')] ??= []).push(dt.toFormat('HH:mm'));
    }
    return out;
  };
  const run = (index: BookingIndexEntry[], over: EventOverrides = {}) =>
    byDay(computeSlots(makeQuery({ hosts: [kiri], ownerTimezone: LON, range: localWeek, index, event: { ...event, ...over } })));

  it('counts bookings per day on the host own calendar, not the owner or UTC calendar', () => {
    expect(run(bookings)).toEqual({
      Tue: NY_WORKDAY,
      // Wed is full: two bookings that local day.
      Thu: without(NY_WORKDAY, '16:30'),
      Fri: without(NY_WORKDAY, '09:00'),
    });
  });

  it('only closes the day once the cap is reached', () => {
    expect(run(bookings, { scheduling: { maxPerDay: 3 } }).Wed).toEqual(without(NY_WORKDAY, '09:00', '16:00'));
    expect(run(bookings, { scheduling: { maxPerDay: 1 } })).toEqual({ Tue: NY_WORKDAY });
    expect(run(bookings, { scheduling: { maxPerDay: null } }).Wed).toEqual(without(NY_WORKDAY, '09:00', '16:00'));
    expect(run(bookings, { scheduling: { maxPerDay: 0 } }).Wed).toEqual(without(NY_WORKDAY, '09:00', '16:00'));
  });

  it('ignores cancelled bookings, other event types and other hosts when counting', () => {
    const swap = (over: Partial<BookingIndexEntry>) => bookings.map((b) => (b.id === 'b2' ? { ...b, ...over } : b));
    expect(run(swap({ status: 'cancelled' })).Wed).toEqual(without(NY_WORKDAY, '09:00'));
    expect(run(swap({ eventTypeId: 'other' })).Wed).toEqual(without(NY_WORKDAY, '09:00', '16:00'));
    expect(run(swap({ hostIds: ['someone_else'] })).Wed).toEqual(without(NY_WORKDAY, '09:00'));
  });

  it('says why in checkSlot, with busy taking precedence over the cap', () => {
    const q = makeQuery({ hosts: [kiri], ownerTimezone: LON, range: localWeek, index: bookings, event });
    expect(checkSlot(q, T('2026-11-18T11:00:00+13:00'))).toEqual({ ok: false, reason: 'daily_limit' });
    expect(checkSlot(q, T('2026-11-18T09:00:00+13:00'))).toEqual({ ok: false, reason: 'busy' });
    expect(checkSlot(q, T('2026-11-18T08:30:00+13:00'))).toEqual({ ok: false, reason: 'outside_hours' });
    expect(checkSlot(q, T('2026-11-19T11:00:00+13:00'))).toEqual({ ok: true, hostIds: ['kiri'] });
    // First and last grid times of the full local day, and the neighbours on either side of it.
    expect(checkSlot(q, T('2026-11-18T16:30:00+13:00'))).toEqual({ ok: false, reason: 'daily_limit' });
    expect(checkSlot(q, T('2026-11-17T16:30:00+13:00'))).toEqual({ ok: true, hostIds: ['kiri'] });
    expect(checkSlot(q, T('2026-11-19T09:00:00+13:00'))).toEqual({ ok: true, hostIds: ['kiri'] });
  });

  it('closes a collective day when one host is full, and only that host for round robin', () => {
    const jimi = makeHost('jimi', NY);
    const alex = makeHost('alex', NY);
    const index = [booked('b1', '2026-11-17T09:00:00-05:00', '2026-11-17T09:30:00-05:00', ['alex'])];
    const twoDays = span('2026-11-17T00:00:00-05:00', '2026-11-19T00:00:00-05:00');
    const collective = computeSlots(makeQuery({ hosts: [jimi, alex], range: twoDays, index, event: { scheduling: { maxPerDay: 1 } } }));
    expect([...new Set(wall(collective, NY, 'ccc'))]).toEqual(['Wed']);
    const q = makeQuery({ hosts: [jimi, alex], range: twoDays, index, event: { kind: 'round_robin', scheduling: { maxPerDay: 1 } } });
    const roundRobin = computeSlots(q);
    expect(roundRobin).toHaveLength(32);
    expect(roundRobin.slice(0, 16).every((s) => s.hostIds.join() === 'jimi')).toBe(true);
    expect(roundRobin.slice(16).every((s) => s.hostIds.join() === 'jimi,alex')).toBe(true);
    expect(checkSlot({ ...q, hosts: [{ host: alex, busy: [] }] }, T('2026-11-17T11:00:00-05:00'))).toEqual({ ok: false, reason: 'daily_limit' });
  });

  it('follows the local day through a clock change', () => {
    // New York, Sunday 2026-11-01 is 25 hours long: 04:00Z to 05:00Z the next day.
    const host = makeHost('jimi', NY, everyDay(['00:00', '24:00']));
    const index = [booked('b1', '2026-11-01T12:00:00-05:00', '2026-11-01T12:30:00-05:00', ['jimi'])];
    const slots = computeSlots(makeQuery({ hosts: [host], range: span('2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'), index, event: { scheduling: { maxPerDay: 1, slotIncrementMin: 60 }, durations: [60] } }));
    const starts = zulu(slots);
    expect(starts).toContain('2026-11-01T03:00Z');
    expect(starts).not.toContain('2026-11-01T04:00Z');
    expect(starts).not.toContain('2026-11-02T04:00Z');
    expect(starts).toContain('2026-11-02T05:00Z');
    expect(starts.filter((s) => s > '2026-11-01T03:00Z' && s < '2026-11-02T05:00Z')).toEqual([]);
  });
});

describe('rescheduling (ignoreBookingId)', () => {
  const jimi = makeHost('jimi', NY);
  const own = booked('bk1', '2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00', ['jimi']);
  // The booking's Google event is on the calendar as external busy too, next to a real outside meeting.
  const googleCopy = span('2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00');
  const outside = span('2026-11-17T13:00:00-05:00', '2026-11-17T14:00:00-05:00');
  const buffers = { bufferBeforeMin: 30, bufferAfterMin: 30 };

  it('hands the booking own time back, including the buffers around it', () => {
    const base: QueryInput = { hosts: [{ host: jimi, busy: [googleCopy, outside] }], range: NY_TUESDAY, index: [own], event: { scheduling: buffers } };
    expect(wall(computeSlots(makeQuery(base)), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00', '10:30', '12:30', '13:00', '13:30', '14:00'));
    expect(wall(computeSlots(makeQuery({ ...base, ignoreBookingId: 'bk1' })), NY)).toEqual(without(NY_WORKDAY, '12:30', '13:00', '13:30', '14:00'));
    expect(checkSlot(makeQuery(base), T('2026-11-17T10:30:00-05:00'))).toEqual({ ok: false, reason: 'busy' });
    expect(checkSlot(makeQuery({ ...base, ignoreBookingId: 'bk1' }), T('2026-11-17T10:30:00-05:00'))).toEqual({ ok: true, hostIds: ['jimi'] });
    expect(checkSlot(makeQuery({ ...base, ignoreBookingId: 'bk1' }), T('2026-11-17T13:00:00-05:00'))).toEqual({ ok: false, reason: 'busy' });
  });

  it('keeps other external busy time that merely overlaps the booking', () => {
    const merged = span('2026-11-17T09:45:00-05:00', '2026-11-17T10:45:00-05:00');
    const base: QueryInput = { hosts: [{ host: jimi, busy: [merged] }], range: NY_TUESDAY, index: [own] };
    expect(wall(computeSlots(makeQuery(base)), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:00', '10:30'));
    // Only 10:00 to 10:30 is handed back: 09:45 to 10:00 and 10:30 to 10:45 still block their slots.
    expect(wall(computeSlots(makeQuery({ ...base, ignoreBookingId: 'bk1' })), NY)).toEqual(without(NY_WORKDAY, '09:30', '10:30'));
  });

  it('frees every host of a collective booking, and nobody else', () => {
    const alex = makeHost('alex', NY);
    const sam = makeHost('sam', NY);
    const both = { ...own, hostIds: ['jimi', 'alex'] };
    const hosts = [
      { host: jimi, busy: [googleCopy] },
      { host: alex, busy: [googleCopy] },
    ];
    expect(wall(computeSlots(makeQuery({ hosts, range: NY_TUESDAY, index: [both] })), NY)).toEqual(without(NY_WORKDAY, '10:00'));
    expect(wall(computeSlots(makeQuery({ hosts, range: NY_TUESDAY, index: [both], ignoreBookingId: 'bk1' })), NY)).toEqual(NY_WORKDAY);
    // sam is not on the booking: the same busy time on sam's calendar is a different meeting and stays.
    const withSam = makeQuery({ hosts: [...hosts, { host: sam, busy: [googleCopy] }], range: NY_TUESDAY, index: [both], ignoreBookingId: 'bk1' });
    expect(wall(computeSlots(withSam), NY)).toEqual(without(NY_WORKDAY, '10:00'));
  });

  it('does not count the moved booking against the daily cap', () => {
    const base: QueryInput = { hosts: [{ host: jimi, busy: [googleCopy] }], range: NY_TUESDAY, index: [own], event: { scheduling: { maxPerDay: 1 } } };
    expect(computeSlots(makeQuery(base))).toEqual([]);
    expect(checkSlot(makeQuery(base), T('2026-11-17T15:00:00-05:00'))).toEqual({ ok: false, reason: 'daily_limit' });
    expect(wall(computeSlots(makeQuery({ ...base, ignoreBookingId: 'bk1' })), NY)).toEqual(NY_WORKDAY);
  });

  it('changes nothing for an unknown id and does not hand back time for a cancelled booking', () => {
    const base: QueryInput = { hosts: [{ host: jimi, busy: [googleCopy] }], range: NY_TUESDAY, index: [own] };
    expect(wall(computeSlots(makeQuery({ ...base, ignoreBookingId: 'nope' })), NY)).toEqual(without(NY_WORKDAY, '10:00'));
    const cancelled: QueryInput = { ...base, index: [{ ...own, status: 'cancelled' }], ignoreBookingId: 'bk1' };
    expect(wall(computeSlots(makeQuery(cancelled)), NY)).toEqual(without(NY_WORKDAY, '10:00'));
  });
});

describe('date overrides and restrictHours in computeSlots', () => {
  it('applies overrides: day off, special hours, an extra day', () => {
    const hours = weekly({ 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']] });
    const host = makeHost('jimi', NY, hours, [override('2026-11-17'), override('2026-11-18', ['12:00', '13:00']), override('2026-11-22', ['10:00', '11:00'])]);
    const slots = computeSlots(makeQuery({ hosts: [host], range: span('2026-11-16T00:00:00-05:00', '2026-11-23T00:00:00-05:00') }));
    expect(wall(slots, NY, 'ccc HH:mm')).toEqual([...NY_WORKDAY.map((t) => `Mon ${t}`), 'Wed 12:00', 'Wed 12:30', 'Sun 10:00', 'Sun 10:30']);
  });

  it('applies an override on a clock-change day', () => {
    // 01:30 to 03:30 on the morning New York skips 02:00 to 03:00 is one real hour: 01:30 EST and 03:00 EDT.
    const host = makeHost('jimi', NY, NINE_TO_FIVE, [override('2026-03-08', ['01:30', '03:30'])]);
    const slots = computeSlots(makeQuery({ hosts: [host], range: span('2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00') }));
    expect(wall(slots, NY, 'HH:mm ZZ')).toEqual(['01:30 -05:00', '03:00 -04:00']);
    // And the repeated hour in November, booked through an override that names it.
    const fall = makeHost('jimi', NY, NINE_TO_FIVE, [override('2026-11-01', ['01:00', '02:00'])]);
    const fallSlots = computeSlots(makeQuery({ hosts: [fall], range: span('2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00') }));
    expect(wall(fallSlots, NY, 'HH:mm ZZ')).toEqual(['01:00 -04:00', '01:30 -04:00', '01:00 -05:00', '01:30 -05:00']);
  });

  it('reads restrictHours on the owner clock and intersects it with the host hours', () => {
    const alex = makeHost('alex', LON);
    const week = span('2026-11-16T00:00:00Z', '2026-11-23T00:00:00Z');
    // Tuesday 10:00 to 12:00 in New York is 15:00Z to 17:00Z, the tail end of London's day.
    const q = makeQuery({ hosts: [alex], ownerTimezone: NY, range: week, event: { scheduling: { restrictHours: weekly({ 2: [['10:00', '12:00']] }) } } });
    expect(zulu(computeSlots(q))).toEqual(['2026-11-17T15:00Z', '2026-11-17T15:30Z', '2026-11-17T16:00Z', '2026-11-17T16:30Z']);
    expect(checkSlot(q, T('2026-11-17T14:30:00Z'))).toEqual({ ok: false, reason: 'outside_hours' });
    expect(checkSlot(q, T('2026-11-17T15:00:00Z'))).toEqual({ ok: true, hostIds: ['alex'] });
    // The same restriction read in London time would be 10:00Z to 12:00Z.
    expect(zulu(computeSlots({ ...q, ownerTimezone: LON }))).toEqual(['2026-11-17T10:00Z', '2026-11-17T10:30Z', '2026-11-17T11:00Z', '2026-11-17T11:30Z']);
  });

  it('picks the restrictHours weekday on the owner calendar', () => {
    // Owner in Los Angeles allows Tuesdays only. The Auckland host's Wednesday is the owner's Tuesday.
    const kiri = makeHost('kiri', AKL);
    const q = makeQuery({
      hosts: [kiri],
      ownerTimezone: LA,
      range: span('2026-11-16T00:00:00Z', '2026-11-20T00:00:00Z'),
      event: { scheduling: { restrictHours: weekly({ 2: [['00:00', '24:00']] }) } },
    });
    const slots = computeSlots(q);
    expect(slots).toHaveLength(16);
    expect([...new Set(wall(slots, AKL, 'ccc dd'))]).toEqual(['Wed 18']);
    expect([...new Set(wall(slots, LA, 'ccc dd'))]).toEqual(['Tue 17']);
  });

  it('applies restrictHours to every host and closes everything when it is empty', () => {
    const jimi = makeHost('jimi', NBO);
    const alex = makeHost('alex', LON);
    const utcTuesday = span('2026-11-17T00:00:00Z', '2026-11-18T00:00:00Z');
    const restrictHours = everyDay(['13:00', '15:30']);
    // Owner clock is Nairobi: 13:00 to 15:30 there is 10:00Z to 12:30Z.
    const collective = computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: { scheduling: { restrictHours } } }));
    expect(wall(collective, 'UTC')).toEqual(clockTimes('10:00', '12:00', 30));
    const roundRobin = computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: { kind: 'round_robin', scheduling: { restrictHours } } }));
    expect(wall(roundRobin, 'UTC')).toEqual(clockTimes('10:00', '12:00', 30));
    expect(computeSlots(makeQuery({ hosts: [jimi, alex], range: utcTuesday, event: { scheduling: { restrictHours: weekly({}) } } }))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkSlot
// ─────────────────────────────────────────────────────────────────────────────

describe('checkSlot', () => {
  const jimi = makeHost('jimi', NY);
  const at = (time: string) => T(`2026-11-17T${time}-05:00`);
  const reject = (reason: SlotRejection) => ({ ok: false, reason });
  const accept = (...hostIds: string[]) => ({ ok: true, hostIds });

  it('accepts a slot computeSlots offers', () => {
    const q = makeQuery({ hosts: [jimi], range: NY_TUESDAY });
    expect(checkSlot(q, at('09:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(q, at('16:30:00'))).toEqual(accept('jimi'));
  });

  it('rejects anything off the grid', () => {
    const q = makeQuery({ hosts: [jimi], range: NY_TUESDAY });
    for (const time of ['10:10:00', '10:00:01', '10:00:00.001', '09:59:59.999', '10:15:00', '10:29:00']) {
      expect(checkSlot(q, at(time)), time).toEqual(reject('not_on_grid'));
    }
    expect(checkSlot(q, at('10:00:00') + 0.5)).toEqual(reject('not_on_grid'));
    expect(checkSlot(q, Number.NaN)).toEqual(reject('not_on_grid'));
    expect(checkSlot(q, Number.POSITIVE_INFINITY)).toEqual(reject('not_on_grid'));
    const quarter = makeQuery({ hosts: [jimi], range: NY_TUESDAY, event: { scheduling: { slotIncrementMin: 15 } } });
    expect(checkSlot(quarter, at('10:15:00'))).toEqual(accept('jimi'));
    expect(checkSlot(quarter, at('10:20:00'))).toEqual(reject('not_on_grid'));
  });

  it('judges the grid on the owner clock', () => {
    const hourly = (ownerTimezone: string) => makeQuery({ hosts: [jimi], range: NY_TUESDAY, ownerTimezone, event: { scheduling: { slotIncrementMin: 60 } } });
    expect(checkSlot(hourly(NY), at('10:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(hourly(KTM), at('10:00:00'))).toEqual(reject('not_on_grid'));
    expect(checkSlot(hourly(KTM), at('10:15:00'))).toEqual(accept('jimi'));
    expect(checkSlot(hourly(IST), at('10:30:00'))).toEqual(accept('jimi'));
    expect(checkSlot(hourly(IST), at('10:00:00'))).toEqual(reject('not_on_grid'));
  });

  it('reports the notice period and the far limits', () => {
    const q = makeQuery({ hosts: [jimi], range: NY_TUESDAY, nowMs: at('10:00:00'), event: { scheduling: { minNoticeMinutes: 120, maxDaysAhead: 30 } } });
    expect(checkSlot(q, at('09:00:00'))).toEqual(reject('too_soon'));
    expect(checkSlot(q, at('11:30:00'))).toEqual(reject('too_soon'));
    expect(checkSlot(q, at('12:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot({ ...q, nowMs: at('10:00:00.001') }, at('12:00:00'))).toEqual(reject('too_soon'));

    const far = makeQuery({ hosts: [jimi], range: span('2026-11-01T00:00:00Z', '2027-06-01T00:00:00Z'), nowMs: at('10:00:00'), event: { scheduling: { maxDaysAhead: 7 } } });
    expect(checkSlot(far, T('2026-11-24T09:30:00-05:00'))).toEqual(accept('jimi'));
    expect(checkSlot(far, T('2026-11-24T10:00:00-05:00'))).toEqual(reject('too_far'));
    expect(checkSlot(far, T('2026-12-24T10:00:00-05:00'))).toEqual(reject('too_far'));
  });

  it('reports times outside the hard date window and outside the query range', () => {
    const windowed = makeQuery({ hosts: [jimi], range: span('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'), event: { scheduling: { dateRange: { start: '2026-11-17', end: '2026-11-17' } } } });
    expect(checkSlot(windowed, T('2026-11-16T16:30:00-05:00'))).toEqual(reject('too_soon'));
    expect(checkSlot(windowed, at('09:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(windowed, T('2026-11-18T09:00:00-05:00'))).toEqual(reject('too_far'));

    const narrow = makeQuery({ hosts: [jimi], range: span('2026-11-17T10:00:00-05:00', '2026-11-17T12:00:00-05:00') });
    expect(checkSlot(narrow, at('09:30:00'))).toEqual(reject('too_soon'));
    expect(checkSlot(narrow, at('10:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(narrow, at('11:30:00'))).toEqual(accept('jimi'));
    expect(checkSlot(narrow, at('12:00:00'))).toEqual(reject('too_far'));
  });

  it('reports working hours, busy time and order of precedence', () => {
    const busy = [span('2026-11-17T11:00:00-05:00', '2026-11-17T12:00:00-05:00'), span('2026-11-17T07:00:00-05:00', '2026-11-17T08:00:00-05:00')];
    const q = makeQuery({ hosts: [{ host: jimi, busy }], range: NY_TUESDAY, event: { durations: [30, 60], scheduling: { bufferBeforeMin: 15, bufferAfterMin: 10 } } });
    expect(checkSlot(q, at('08:30:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot(q, at('17:00:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot(q, at('07:00:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot(q, at('11:00:00'))).toEqual(reject('busy'));
    expect(checkSlot(q, at('10:30:00'))).toEqual(reject('busy'));
    expect(checkSlot(q, at('12:00:00'))).toEqual(reject('busy'));
    expect(checkSlot(q, at('10:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(q, at('12:30:00'))).toEqual(accept('jimi'));
    // The hour-long version of the same event no longer fits at 16:30, and 10:00 now runs into the buffer.
    expect(checkSlot({ ...q, durationMin: 60 }, at('16:30:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot({ ...q, durationMin: 60 }, at('16:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot({ ...q, durationMin: 60 }, at('10:00:00'))).toEqual(reject('busy'));
    // Earlier checks win: duration, then grid, then limits, then availability.
    expect(checkSlot({ ...q, durationMin: 45 }, at('11:10:00'))).toEqual(reject('invalid_duration'));
    expect(checkSlot({ ...q, nowMs: at('23:00:00') }, at('11:10:00'))).toEqual(reject('not_on_grid'));
    expect(checkSlot({ ...q, nowMs: at('23:00:00') }, at('11:00:00'))).toEqual(reject('too_soon'));
  });

  it('explains multi-host rejections', () => {
    const early = makeHost('jimi', NY, everyDay(['08:00', '12:00']));
    const late = makeHost('alex', NY, everyDay(['10:00', '17:00']));
    const hosts = [
      { host: early, busy: [span('2026-11-17T11:00:00-05:00', '2026-11-17T11:30:00-05:00')] },
      { host: late, busy: [span('2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00'), span('2026-11-17T11:00:00-05:00', '2026-11-17T11:30:00-05:00')] },
    ];
    const collective = makeQuery({ hosts, range: NY_TUESDAY });
    expect(checkSlot(collective, at('10:30:00'))).toEqual(accept('jimi', 'alex'));
    expect(checkSlot(collective, at('09:00:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot(collective, at('10:00:00'))).toEqual(reject('busy'));
    expect(checkSlot(collective, at('13:00:00'))).toEqual(reject('outside_hours'));

    const roundRobin = makeQuery({ hosts, range: NY_TUESDAY, event: { kind: 'round_robin' } });
    expect(checkSlot(roundRobin, at('09:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(roundRobin, at('10:00:00'))).toEqual(accept('jimi'));
    expect(checkSlot(roundRobin, at('10:30:00'))).toEqual(accept('jimi', 'alex'));
    expect(checkSlot(roundRobin, at('13:00:00'))).toEqual(accept('alex'));
    expect(checkSlot(roundRobin, at('11:00:00'))).toEqual(reject('busy'));
    expect(checkSlot(roundRobin, at('07:00:00'))).toEqual(reject('outside_hours'));
    expect(checkSlot(roundRobin, at('17:00:00'))).toEqual(reject('outside_hours'));
    // One host out of hours, the other busy: somebody was nearly available, so it reads as taken.
    expect(checkSlot({ ...roundRobin, hosts: [hosts[0], { host: late, busy: [span('2026-11-17T08:00:00-05:00', '2026-11-17T17:00:00-05:00')] }] }, at('13:00:00'))).toEqual(reject('busy'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickRoundRobinHost
// ─────────────────────────────────────────────────────────────────────────────

describe('pickRoundRobinHost', () => {
  const now = T('2026-11-17T12:00:00Z');
  const b = (id: string, start: string, hostIds: string[], over: Partial<BookingIndexEntry> = {}) =>
    booked(id, start, iso(T(start) + 30 * MIN), hostIds, over);

  it('picks the host with the fewest upcoming confirmed bookings', () => {
    const index = [b('1', '2026-11-18T10:00:00Z', ['a']), b('2', '2026-11-19T10:00:00Z', ['a']), b('3', '2026-11-18T12:00:00Z', ['b'])];
    expect(pickRoundRobinHost(['a', 'b'], index, now)).toBe('b');
    expect(pickRoundRobinHost(['b', 'a'], index, now)).toBe('b');
    expect(pickRoundRobinHost(['a', 'b', 'c'], index, now)).toBe('c');
    expect(pickRoundRobinHost(['a'], index, now)).toBe('a');
  });

  it('does not count cancelled, past or exactly-now bookings as upcoming', () => {
    const index = [
      b('1', '2026-11-18T10:00:00Z', ['a'], { status: 'cancelled' }),
      b('2', '2026-11-10T10:00:00Z', ['a']),
      b('3', '2026-11-17T12:00:00Z', ['a']),
      b('4', '2026-11-17T12:00:00.001Z', ['b']),
    ];
    expect(pickRoundRobinHost(['a', 'b'], index, now)).toBe('a');
    // A meeting starting this very instant is not "upcoming": a has one upcoming booking, b has two.
    // (Counting it would tie them at two and hand the slot to b, whose latest booking is earlier.)
    const boundary = [
      b('1', '2026-11-17T12:00:00Z', ['a']),
      b('2', '2026-11-20T12:00:00Z', ['a']),
      b('3', '2026-11-18T12:00:00Z', ['b']),
      b('4', '2026-11-19T12:00:00Z', ['b']),
    ];
    expect(pickRoundRobinHost(['a', 'b'], boundary, now)).toBe('a');
    expect(pickRoundRobinHost(['a', 'b'], boundary, now - 1)).toBe('b');
  });

  it('breaks a tie with whoever was booked longest ago, never booked first of all', () => {
    const index = [b('1', '2026-11-20T10:00:00Z', ['a']), b('2', '2026-11-18T10:00:00Z', ['b']), b('3', '2026-11-01T10:00:00Z', ['a'])];
    expect(pickRoundRobinHost(['a', 'b'], index, now)).toBe('b');
    // Nobody has anything upcoming: a was last booked on the 10th, b on the 5th, c never.
    const past = [b('1', '2026-11-10T10:00:00Z', ['a']), b('2', '2026-11-05T10:00:00Z', ['b']), b('3', '2026-11-12T10:00:00Z', ['c'], { status: 'cancelled' })];
    expect(pickRoundRobinHost(['a', 'b'], past, now)).toBe('b');
    expect(pickRoundRobinHost(['a', 'b', 'c'], past, now)).toBe('c');
    // The most recent booking decides, past or future, not the oldest one.
    const mixed = [b('1', '2026-11-01T10:00:00Z', ['a']), b('2', '2026-11-19T10:00:00Z', ['a']), b('3', '2026-11-02T10:00:00Z', ['b']), b('4', '2026-11-18T10:00:00Z', ['b'])];
    expect(pickRoundRobinHost(['a', 'b'], mixed, now)).toBe('b');
  });

  it('falls back to the smallest id, compared by code unit', () => {
    expect(pickRoundRobinHost(['host_b', 'host_a', 'host_c'], [], now)).toBe('host_a');
    expect(pickRoundRobinHost(['b', 'B', 'a'], [], now)).toBe('B');
    expect(pickRoundRobinHost(['host_2', 'host_10'], [], now)).toBe('host_10');
    const shared = [b('1', '2026-11-18T10:00:00Z', ['x', 'y'])];
    expect(pickRoundRobinHost(['y', 'x'], shared, now)).toBe('x');
  });

  it('is deterministic whatever order candidates and bookings arrive in', () => {
    const rand = prng(99);
    const hosts = ['h1', 'h2', 'h3', 'h4'];
    for (let round = 0; round < 200; round++) {
      const index: BookingIndexEntry[] = [];
      const n = Math.floor(rand() * 10);
      for (let i = 0; i < n; i++) {
        const start = now + Math.floor((rand() - 0.4) * 10 * DAY);
        const who = hosts.filter(() => rand() < 0.4);
        index.push(booked(`b${i}`, iso(start), iso(start + 30 * MIN), who.length ? who : ['h1'], { status: rand() < 0.2 ? 'cancelled' : 'confirmed' }));
      }
      const expected = pickRoundRobinHost(hosts, index, now);
      expect(hosts).toContain(expected);
      expect(pickRoundRobinHost([...hosts].reverse(), [...index].reverse(), now)).toBe(expected);
      expect(pickRoundRobinHost(['h3', 'h1', 'h4', 'h2', 'h1'], index, now)).toBe(expected);
    }
  });

  it('ignores bookings of people who are not candidates and bad dates', () => {
    const index = [b('1', '2026-11-18T10:00:00Z', ['z']), b('2', '2026-11-18T10:00:00Z', ['a']), { ...b('3', '2026-11-18T10:00:00Z', ['b']), start: 'garbage' }];
    expect(pickRoundRobinHost(['a', 'b'], index, now)).toBe('b');
  });

  it('refuses an empty candidate list', () => {
    expect(() => pickRoundRobinHost([], [], now)).toThrow(RangeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Generated scenarios
// ─────────────────────────────────────────────────────────────────────────────

const ZONES = [NY, LON, NBO, LA, IST, KTM, AKL, 'Asia/Tokyo', 'Australia/Lord_Howe', 'America/Santiago', 'America/St_Johns', 'UTC'];
/** Day before each clock change of 2026 in the zones above, plus two quiet dates. */
const ANCHORS = ['2026-03-07', '2026-03-28', '2026-04-04', '2026-06-15', '2026-09-05', '2026-09-26', '2026-10-03', '2026-10-24', '2026-10-31', '2026-11-16'];
const TIMES = ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '06:15', '08:00', '09:00', '09:10', '10:45', '12:00', '13:30', '15:00', '17:00', '18:20', '20:00', '22:00', '23:30', '24:00'];

interface ScenarioOptions {
  minHours: number;
  maxHours: number;
  maxBusy: number;
  maxBookings: number;
}

function randomScenario(rand: () => number, opts: ScenarioOptions): SlotQuery {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <X>(list: X[]): X => list[Math.floor(rand() * list.length)];
  const dateAt = (ms: number) => iso(ms).slice(0, 10);

  const anchor = T(`${pick(ANCHORS)}T00:00:00Z`);
  const rangeStart = anchor + int(0, 36) * 20 * MIN + pick([0, 0, 0, 1, -1, 7000]);
  const rangeEnd = rangeStart + int(opts.minHours, opts.maxHours) * HOUR + pick([0, 0, 1]);
  const rangeMinutes = Math.floor((rangeEnd - rangeStart) / MIN);

  const randomRanges = (): TimeRange[] => {
    const out: TimeRange[] = [];
    const n = pick([0, 1, 1, 1, 2, 3]);
    for (let i = 0; i < n; i++) {
      const a = pick(TIMES);
      const b = pick(TIMES);
      // Mostly well-formed, sometimes backwards or empty so that "ignored" paths run too.
      out.push(rand() < 0.85 ? { start: a < b ? a : b, end: a < b ? b : a } : { start: a, end: b });
    }
    return out;
  };
  const randomWeekly = (): WeeklyHours => ({ 0: randomRanges(), 1: randomRanges(), 2: randomRanges(), 3: randomRanges(), 4: randomRanges(), 5: randomRanges(), 6: randomRanges() });

  const hostCount = int(1, 3);
  const hosts: HostAvailabilityInput[] = [];
  for (let i = 0; i < hostCount; i++) {
    const overrides: DateOverride[] = [];
    for (let k = pick([0, 0, 1, 2]); k > 0; k--) overrides.push({ date: dateAt(anchor + int(-1, 4) * DAY), ranges: rand() < 0.4 ? [] : randomRanges() });
    const host = makeHost(`h${i}`, pick(ZONES), rand() < 0.25 ? everyDay(['00:00', '24:00']) : randomWeekly(), overrides);
    const busy: Interval[] = [];
    for (let k = int(0, opts.maxBusy); k > 0; k--) {
      const start = rangeStart + int(-600, rangeMinutes + 600) * MIN + pick([0, 0, 0, 1, -1, 30_000]);
      busy.push({ start, end: start + pick([5, 15, 30, 45, 60, 120, 300]) * MIN + pick([0, 0, 1, -1]) });
    }
    hosts.push({ host, busy });
  }
  const hostIds = hosts.map((h) => h.host.id);

  const durations = [15, 30, 45, 60, 90];
  const bufferBeforeMin = pick([0, 0, 5, 15, 30]);
  const bufferAfterMin = pick([0, 0, 10, 20, 45]);
  const nowMs = rangeStart - pick([-6 * HOUR, 0, HOUR, 30 * HOUR, 3 * DAY]);
  const eventType = makeEvent({
    hostIds,
    kind: hostCount === 1 ? 'solo' : pick(['collective', 'round_robin'] as const),
    durations,
    scheduling: {
      // 25, 50 and 70 do not divide a day, so the grid has to restart at each owner-local midnight.
      slotIncrementMin: pick([5, 10, 15, 20, 25, 30, 30, 45, 50, 60, 70, 90, 120]),
      bufferBeforeMin,
      bufferAfterMin,
      maxPerDay: pick([null, null, 1, 2]),
      minNoticeMinutes: pick([0, 0, 60, 240, 1440]),
      maxDaysAhead: pick([1, 2, 3, 30, 30, 90]),
      dateRange: rand() < 0.2 ? { start: dateAt(anchor + int(0, 1) * DAY), end: dateAt(anchor + int(1, 3) * DAY) } : null,
      restrictHours: rand() < 0.2 ? randomWeekly() : null,
    },
  });

  const index: BookingIndexEntry[] = [];
  const firstMark = Math.floor(rangeStart / (5 * MIN)) * 5 * MIN;
  for (let k = int(0, opts.maxBookings); k > 0; k--) {
    const start = firstMark + int(-60, Math.floor(rangeMinutes / 5) + 60) * 5 * MIN;
    const who = hostIds.filter(() => rand() < 0.6);
    index.push(
      booked(`bk${k}`, iso(start), iso(start + pick(durations) * MIN), who.length ? who : [pick(hostIds)], {
        eventTypeId: pick(['evt', 'evt', 'other']),
        status: pick(['confirmed', 'confirmed', 'confirmed', 'cancelled'] as const),
      }),
    );
  }

  const q: SlotQuery = {
    eventType,
    durationMin: rand() < 0.03 ? 20 : pick(durations),
    hosts,
    ownerTimezone: pick(ZONES),
    range: { start: rangeStart, end: rangeEnd },
    nowMs,
    index,
  };
  if (index.length > 0 && rand() < 0.3) {
    const moved = pick(index);
    q.ignoreBookingId = moved.id;
    // Its calendar event is still on the hosts' calendars.
    for (const h of hosts) if (moved.hostIds.includes(h.host.id)) h.busy.push({ start: T(moved.start), end: T(moved.end) });
  }
  if (rand() < 0.2) q.ownBookingBuffers = { evt: { beforeMin: bufferBeforeMin, afterMin: bufferAfterMin }, other: { beforeMin: 10, afterMin: 5 } };
  return q;
}

/**
 * Reference implementation of spec section 4.1, written the slow obvious way: try every whole minute,
 * read the owner's wall clock with luxon to test the grid, and compare the candidate against every
 * window, busy interval and booking one at a time. It shares no code with slots.ts beyond zonedToUtcMs,
 * which time.test.ts checks against its own oracle.
 */
function referenceSlots(q: SlotQuery): Slot[] {
  const et = q.eventType;
  const sch = et.scheduling;
  if (!et.durations.includes(q.durationMin)) return [];
  const duration = q.durationMin * MIN;
  const before = sch.bufferBeforeMin * MIN;
  const after = sch.bufferAfterMin * MIN;

  const windowsOf = (hours: WeeklyHours, overrides: DateOverride[], tz: string): Interval[] => {
    const found: Interval[] = [];
    let day = DateTime.fromISO(DateTime.fromMillis(q.range.start, { zone: tz }).toISODate()!, { zone: 'utc' }).minus({ days: 2 });
    const last = DateTime.fromISO(DateTime.fromMillis(q.range.end + duration, { zone: tz }).toISODate()!, { zone: 'utc' }).plus({ days: 2 });
    for (; day <= last; day = day.plus({ days: 1 })) {
      const date = day.toISODate()!;
      let ranges = hours[(day.weekday % 7) as Weekday] ?? [];
      for (const o of overrides) if (o.date === date) ranges = o.ranges;
      for (const r of ranges) {
        if (!/^\d\d:\d\d$/.test(r.start) || !/^\d\d:\d\d$/.test(r.end) || r.end <= r.start) continue;
        const start = zonedToUtcMs(date, r.start, tz);
        const end = zonedToUtcMs(date, r.end, tz);
        if (end > start) found.push({ start, end });
      }
    }
    found.sort((a, b) => a.start - b.start);
    const joined: Interval[] = [];
    for (const w of found) {
      const tail = joined[joined.length - 1];
      if (tail && w.start <= tail.end) tail.end = Math.max(tail.end, w.end);
      else joined.push({ ...w });
    }
    return joined;
  };

  const moved = q.index.filter((e) => e.status === 'confirmed' && e.id === q.ignoreBookingId);
  const live = q.index.filter((e) => e.status === 'confirmed' && e.id !== q.ignoreBookingId);
  const restrict = sch.restrictHours ? windowsOf(sch.restrictHours, [], q.ownerTimezone) : null;
  const hostIds = [...new Set(et.hostIds)];

  const perHost = hostIds.map((id) => {
    const input = q.hosts.find((h) => h.host.id === id);
    if (!input) return null;
    const host = input.host;
    const schedule = host.schedules.find((s) => s.id === sch.scheduleIds[id]) ?? host.schedules.find((s) => s.id === host.defaultScheduleId) ?? host.schedules[0];
    let external = input.busy.filter((b) => b.start < b.end);
    for (const m of moved) {
      if (!m.hostIds.includes(id)) continue;
      const cutStart = T(m.start);
      const cutEnd = T(m.end);
      external = external.flatMap((b) => [
        { start: b.start, end: Math.min(b.end, cutStart) },
        { start: Math.max(b.start, cutEnd), end: b.end },
      ]).filter((b) => b.start < b.end);
    }
    const mine = live.filter((e) => e.hostIds.includes(id));
    const own = mine.map((e) => {
      const pad = q.ownBookingBuffers?.[e.eventTypeId];
      return { start: T(e.start) - (pad?.beforeMin ?? 0) * MIN, end: T(e.end) + (pad?.afterMin ?? 0) * MIN };
    });
    const sameTypeDays = mine.filter((e) => e.eventTypeId === et.id).map((e) => DateTime.fromMillis(T(e.start), { zone: host.timezone }).toISODate());
    return { id, tz: host.timezone, windows: windowsOf(schedule.weekly, schedule.overrides, host.timezone), busy: [...external, ...own], sameTypeDays };
  });

  const out: Slot[] = [];
  for (let s = Math.ceil(q.range.start / MIN) * MIN; s < q.range.end; s += MIN) {
    if (s < q.nowMs + sch.minNoticeMinutes * MIN || s >= q.nowMs + sch.maxDaysAhead * DAY) continue;
    const ownerClock = DateTime.fromMillis(s, { zone: q.ownerTimezone });
    if ((ownerClock.hour * 60 + ownerClock.minute) % sch.slotIncrementMin !== 0) continue;
    if (sch.dateRange) {
      const ownerDate = ownerClock.toISODate()!;
      if (ownerDate < sch.dateRange.start || ownerDate > sch.dateRange.end) continue;
    }
    const end = s + duration;
    if (restrict && !restrict.some((w) => w.start <= s && end <= w.end)) continue;
    const free: string[] = [];
    for (const h of perHost) {
      if (!h) continue;
      if (!h.windows.some((w) => w.start <= s && end <= w.end)) continue;
      if (h.busy.some((b) => s - before < b.end && b.start < end + after)) continue;
      if (sch.maxPerDay) {
        const localDate = DateTime.fromMillis(s, { zone: h.tz }).toISODate();
        if (h.sameTypeDays.filter((d) => d === localDate).length >= sch.maxPerDay) continue;
      }
      free.push(h.id);
    }
    if (et.kind === 'round_robin' ? free.length > 0 : free.length === hostIds.length && hostIds.length > 0) out.push({ startMs: s, endMs: end, hostIds: free });
  }
  return out;
}

const describeSlots = (slots: Slot[]): string[] => slots.map((s) => `${iso(s.startMs)} ${(s.endMs - s.startMs) / MIN}m ${s.hostIds.join('+')}`);

describe('generated scenarios', () => {
  it('computeSlots matches the minute-by-minute reference implementation', () => {
    const rand = prng(4101);
    let totalSlots = 0;
    let nonEmpty = 0;
    const rounds = 220;
    for (let round = 0; round < rounds; round++) {
      const q = randomScenario(rand, { minHours: 8, maxHours: 72, maxBusy: 10, maxBookings: 8 });
      const actual = describeSlots(computeSlots(q));
      const expected = describeSlots(referenceSlots(q));
      if (actual.join('\n') !== expected.join('\n')) {
        // Fail with a readable diff and enough to replay the case.
        expect({ round, slots: actual }, JSON.stringify(q)).toEqual({ round, slots: expected });
      }
      totalSlots += actual.length;
      if (actual.length > 0) nonEmpty++;
    }
    // The generator must actually exercise availability, not just empty calendars.
    expect(nonEmpty).toBeGreaterThan(rounds / 4);
    expect(totalSlots).toBeGreaterThan(3000);
  });

  it('checkSlot agrees with computeSlots for every start time tried', () => {
    const rand = prng(8675309);
    const reasons = new Set<string>();
    const mismatches: string[] = [];
    let cases = 0;
    let accepted = 0;
    for (let round = 0; round < 60; round++) {
      const q = randomScenario(rand, { minHours: 6, maxHours: 30, maxBusy: 8, maxBookings: 6 });
      // Make sure the unlisted-duration path is part of every run, whatever the seed does.
      if (round % 20 === 7) q.durationMin = 20;
      const offered = new Map(computeSlots(q).map((s) => [s.startMs, s.hostIds.join('+')]));
      const probes = new Set<number>();
      // Every 5 minute mark from before the range to after it, every offered slot and its near misses, and some noise.
      const first = Math.floor((q.range.start - 2 * HOUR) / (5 * MIN)) * 5 * MIN;
      for (let t = first; t <= q.range.end + 2 * HOUR; t += 5 * MIN) probes.add(t);
      for (const start of [...offered.keys()].slice(0, 40)) for (const delta of [0, 1, -1, MIN, -MIN, 1000]) probes.add(start + delta);
      for (let i = 0; i < 20; i++) probes.add(q.range.start + Math.floor(rand() * (q.range.end - q.range.start)));
      probes.add(q.range.start).add(q.range.end).add(q.range.start - 1).add(q.range.end - 1);

      for (const t of probes) {
        const verdict = checkSlot(q, t);
        cases++;
        if (verdict.ok) {
          accepted++;
          if (offered.get(t) !== verdict.hostIds.join('+')) mismatches.push(`round ${round} ${iso(t)}: checkSlot ok [${verdict.hostIds}] but computeSlots has ${offered.get(t) ?? 'no slot'}`);
        } else {
          reasons.add(verdict.reason);
          if (offered.has(t)) mismatches.push(`round ${round} ${iso(t)}: computeSlots offers it but checkSlot says ${verdict.reason}`);
        }
      }
      if (mismatches.length > 0) {
        expect(mismatches.slice(0, 5), JSON.stringify(q)).toEqual([]);
      }
    }
    expect(mismatches).toEqual([]);
    expect(cases).toBeGreaterThan(5000);
    expect(accepted).toBeGreaterThan(300);
    // Every rejection reason shows up somewhere in the run.
    expect([...reasons].sort()).toEqual(['busy', 'daily_limit', 'invalid_duration', 'not_on_grid', 'outside_hours', 'too_far', 'too_soon']);
  });

  it('never returns a slot that overlaps busy time, leaves a working window, or breaks a limit', () => {
    const rand = prng(31337);
    let checked = 0;
    for (let round = 0; round < 25; round++) {
      const q = randomScenario(rand, { minHours: 24 * 10, maxHours: 24 * 45, maxBusy: 120, maxBookings: 40 });
      q.eventType.scheduling.maxDaysAhead = 90;
      const sch = q.eventType.scheduling;
      const duration = q.durationMin * MIN;
      const slots = computeSlots(q);
      const wide = { start: q.range.start - 3 * DAY, end: q.range.end + 3 * DAY };
      const windows = new Map(q.hosts.map((h) => [h.host.id, scheduleWindows(h.host.schedules[0], h.host.timezone, wide)]));
      const live = q.index.filter((e) => e.status === 'confirmed' && e.id !== q.ignoreBookingId);
      const moved = q.index.find((e) => e.status === 'confirmed' && e.id === q.ignoreBookingId);
      const problems: string[] = [];

      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const label = `round ${round} ${iso(s.startMs)}`;
        if (i > 0 && s.startMs <= slots[i - 1].startMs) problems.push(`${label}: not ascending`);
        if (s.endMs - s.startMs !== duration) problems.push(`${label}: wrong length`);
        if (s.startMs < q.range.start || s.startMs >= q.range.end) problems.push(`${label}: outside the range`);
        if (s.startMs < q.nowMs + sch.minNoticeMinutes * MIN) problems.push(`${label}: inside the notice period`);
        if (s.startMs >= q.nowMs + sch.maxDaysAhead * DAY) problems.push(`${label}: beyond the rolling window`);
        const ownerClock = DateTime.fromMillis(s.startMs, { zone: q.ownerTimezone });
        if ((ownerClock.hour * 60 + ownerClock.minute) % sch.slotIncrementMin !== 0 || s.startMs % MIN !== 0) problems.push(`${label}: off the owner grid`);
        if (s.hostIds.length === 0) problems.push(`${label}: nobody assigned`);
        if (q.eventType.kind !== 'round_robin' && s.hostIds.join() !== q.eventType.hostIds.join()) problems.push(`${label}: not every host`);
        for (const hostId of s.hostIds) {
          const input = q.hosts.find((h) => h.host.id === hostId)!;
          if (!windows.get(hostId)!.some((w) => w.start <= s.startMs && s.endMs <= w.end)) problems.push(`${label}: outside ${hostId}'s hours`);
          const padStart = s.startMs - sch.bufferBeforeMin * MIN;
          const padEnd = s.endMs + sch.bufferAfterMin * MIN;
          for (const b of input.busy) {
            if (!(b.start < b.end) || !(padStart < b.end && b.start < padEnd)) continue;
            // The one allowed overlap: the moved booking's own calendar event.
            const insideMoved = moved && moved.hostIds.includes(hostId) && T(moved.start) <= Math.max(b.start, padStart) && Math.min(b.end, padEnd) <= T(moved.end);
            if (!insideMoved) problems.push(`${label}: overlaps ${hostId}'s busy time ${iso(b.start)}`);
          }
          for (const e of live) {
            if (e.hostIds.includes(hostId) && padStart < T(e.end) && T(e.start) < padEnd) problems.push(`${label}: overlaps booking ${e.id}`);
          }
        }
        checked++;
      }
      expect(problems.slice(0, 5), JSON.stringify(q).slice(0, 4000)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('performance', () => {
  it('handles a 62 day range on a 15 minute grid with hundreds of busy intervals quickly, and correctly', () => {
    const rand = prng(62);
    const start = T('2026-10-20T00:00:00Z');
    const range = { start, end: start + 62 * DAY };
    const hosts: HostAvailabilityInput[] = [makeHost('jimi', NBO, everyDay(['08:00', '20:00'])), makeHost('alex', NY, everyDay(['07:00', '19:00'])), makeHost('sam', LON, everyDay(['06:00', '22:00']))].map((host) => {
      const busy: Interval[] = [];
      for (let i = 0; i < 400; i++) {
        const at = start + Math.floor(rand() * 62 * 24 * 12) * 5 * MIN;
        busy.push({ start: at, end: at + (1 + Math.floor(rand() * 8)) * 15 * MIN });
      }
      return { host, busy };
    });
    const index: BookingIndexEntry[] = [];
    for (let i = 0; i < 300; i++) {
      const at = start + Math.floor(rand() * 62 * 24 * 4) * 15 * MIN;
      index.push(booked(`bk${i}`, iso(at), iso(at + 30 * MIN), [['jimi'], ['alex'], ['sam'], ['jimi', 'alex', 'sam']][Math.floor(rand() * 4)]));
    }
    const event: EventOverrides = { scheduling: { slotIncrementMin: 15, bufferBeforeMin: 5, bufferAfterMin: 10, maxDaysAhead: 90, maxPerDay: 6 } };
    const collective = makeQuery({ hosts, range, index, ownerTimezone: NBO, nowMs: start - DAY, event });
    const roundRobin = makeQuery({ hosts, range, index, ownerTimezone: NBO, nowMs: start - DAY, event: { ...event, kind: 'round_robin' } });

    // Warm up once so the measurement is not dominated by first-call compilation.
    computeSlots(collective);
    const timings: number[] = [];
    let slots: Slot[] = [];
    let rrSlots: Slot[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      slots = computeSlots(collective);
      rrSlots = computeSlots(roundRobin);
      timings.push(performance.now() - t0);
    }
    const best = Math.min(...timings);
    // Typically a few milliseconds for both queries together. The bound is loose so a busy CI box does not flake.
    expect(best).toBeLessThan(250);

    expect(rrSlots.length).toBeGreaterThan(slots.length);
    expect(slots.length).toBeGreaterThan(50);
    expect(describeSlots(slots)).toEqual(describeSlots(referenceSlots(collective)));
    expect(describeSlots(rrSlots)).toEqual(describeSlots(referenceSlots(roundRobin)));

    const t1 = performance.now();
    for (const s of slots.slice(0, 200)) expect(checkSlot(collective, s.startMs).ok).toBe(true);
    expect((performance.now() - t1) / Math.min(200, slots.length)).toBeLessThan(10);
  });
});
