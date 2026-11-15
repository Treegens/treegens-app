import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayKey,
  daysBetween,
  formatDateLong,
  formatDuration,
  formatMonthYear,
  formatOffset,
  formatRange,
  formatRelativeDay,
  formatTime,
  isValidZone,
  listZones,
  monthGrid,
  monthRange,
  searchZones,
  startOfDay,
  uses12h,
  weekStartsOn,
  weekdayNames,
  weekdayOfKey,
  zoneCity,
  zoneInfo,
  zoneLabel,
  zoneOffsetMinutes,
  zonedParts,
  zonedToMs,
} from '../../src/lib/tz';

const NBSP = / /g;
const T = Date.UTC(2026, 10, 17, 11, 30); // Tue 17 Nov 2026, 14:30 in Nairobi

describe('zoned arithmetic', () => {
  it('reads wall-clock parts in a zone', () => {
    expect(zonedParts(T, 'Africa/Nairobi')).toMatchObject({ year: 2026, month: 11, day: 17, hour: 14, minute: 30, weekday: 2 });
    expect(zonedParts(Date.UTC(2026, 10, 17, 21, 5), 'Africa/Nairobi')).toMatchObject({ day: 18, hour: 0, minute: 5 });
    expect(zonedParts(T, 'Asia/Kathmandu')).toMatchObject({ hour: 17, minute: 15 });
  });

  it('computes offsets, including half-hour zones and DST', () => {
    expect(zoneOffsetMinutes('Africa/Nairobi', T)).toBe(180);
    expect(zoneOffsetMinutes('Asia/Kolkata', T)).toBe(330);
    expect(zoneOffsetMinutes('America/New_York', T)).toBe(-300);
    expect(zoneOffsetMinutes('America/New_York', Date.UTC(2026, 6, 1))).toBe(-240);
    expect(zoneOffsetMinutes('UTC', T)).toBe(0);
  });

  it('maps instants to day keys per zone', () => {
    expect(dayKey(Date.UTC(2026, 10, 17, 22, 30), 'Africa/Nairobi')).toBe('2026-11-18');
    expect(dayKey(Date.UTC(2026, 10, 17, 2, 30), 'America/Los_Angeles')).toBe('2026-11-16');
    expect(dayKey('2026-11-17T11:30:00.000Z', 'UTC')).toBe('2026-11-17');
  });

  it('does calendar math on day keys', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekdayOfKey('2026-11-17')).toBe(2);
    expect(daysBetween('2026-11-17', '2026-12-01')).toBe(14);
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('turns wall times into instants', () => {
    expect(zonedToMs('2026-11-17', '14:30', 'Africa/Nairobi')).toBe(T);
    expect(zonedToMs('2026-07-01', '09:00', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(startOfDay('2026-11-17', 'Asia/Kolkata')).toBe(Date.UTC(2026, 10, 16, 18, 30));
  });

  it('moves skipped times forward and takes the first of repeated times', () => {
    // US spring forward: 02:30 does not exist on 8 March 2026
    expect(zonedToMs('2026-03-08', '02:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30));
    // US fall back: 01:30 happens twice on 1 November 2026
    expect(zonedToMs('2026-11-01', '01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
    // UK fall back: 01:30 happens twice on 25 October 2026
    expect(zonedToMs('2026-10-25', '01:30', 'Europe/London')).toBe(Date.UTC(2026, 9, 25, 0, 30));
    // UK spring forward: 01:30 does not exist on 29 March 2026
    expect(zonedToMs('2026-03-29', '01:30', 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 1, 30));
  });

  it('gives month ranges that follow DST', () => {
    const march = monthRange(2026, 3, 'America/New_York');
    expect(march.from).toBe(Date.UTC(2026, 2, 1, 5, 0));
    expect(march.to).toBe(Date.UTC(2026, 3, 1, 4, 0));
    const dec = monthRange(2026, 12, 'Africa/Nairobi');
    expect(dec.to).toBe(Date.UTC(2026, 11, 31, 21, 0));
  });

  it('builds month grids for any week start', () => {
    const monday = monthGrid(2026, 11, 1);
    expect(monday).toHaveLength(6);
    expect(monday[0][0]).toMatchObject({ key: '2026-10-26', inMonth: false, weekday: 1 });
    expect(monday[0][6]).toMatchObject({ key: '2026-11-01', inMonth: true, day: 1, weekday: 0 });
    expect(monday[5][0].key).toBe('2026-11-30');
    const sunday = monthGrid(2026, 2, 0);
    expect(sunday).toHaveLength(4);
    expect(sunday[0][0].key).toBe('2026-02-01');
    expect(sunday.flat().every((c) => c.inMonth)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats times in 12h, 24h and compact styles', () => {
    expect(formatTime(T, 'Africa/Nairobi', { hour12: true, locale: 'en-US' }).replace(NBSP, ' ')).toBe('2:30 PM');
    expect(formatTime(T, 'Africa/Nairobi', { hour12: false, locale: 'en-US' })).toBe('14:30');
    expect(formatTime(T, 'Africa/Nairobi', { hour12: true, locale: 'en-US', style: 'compact' })).toBe('2:30pm');
    expect(formatTime(Date.UTC(2026, 10, 17, 21, 5), 'Africa/Nairobi', { hour12: false, locale: 'en-US' })).toBe('00:05');
    expect(formatTime(T, 'America/New_York', { hour12: true, locale: 'en-US' }).replace(NBSP, ' ')).toBe('6:30 AM');
  });

  it('formats ranges without em dashes', () => {
    const range = formatRange(T, T + 30 * 60000, 'Africa/Nairobi', { hour12: true, locale: 'en-US' }).replace(NBSP, ' ');
    expect(range).toBe('2:30 – 3:00 PM');
    expect(formatRange(T, T + 30 * 60000, 'Africa/Nairobi', { hour12: false, locale: 'en-US' })).toBe('14:30 – 15:00');
    expect(range).not.toContain('—');
  });

  it('formats dates and durations', () => {
    expect(formatDateLong(T, 'Africa/Nairobi', 'en-US')).toBe('Tuesday, November 17, 2026');
    expect(formatMonthYear(2026, 11, 'en-US')).toBe('November 2026');
    expect(weekdayNames(1, 'en-US')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayNames(0, 'en-US', 'narrow')[0]).toBe('S');
    expect(formatDuration(15)).toBe('15 min');
    expect(formatDuration(60)).toBe('1 hr');
    expect(formatDuration(90)).toBe('1 hr 30 min');
    expect(formatRelativeDay(T, 'Africa/Nairobi', T)).toBe('Today');
    expect(formatRelativeDay(T + 86400000, 'Africa/Nairobi', T)).toBe('Tomorrow');
    expect(formatRelativeDay(T - 86400000, 'Africa/Nairobi', T)).toBe('Yesterday');
  });

  it('knows locale habits', () => {
    expect(uses12h('en-US')).toBe(true);
    expect(uses12h('en-GB')).toBe(false);
    expect(uses12h('de-DE')).toBe(false);
    expect(weekStartsOn('en-US')).toBe(0);
    expect(weekStartsOn('en-GB')).toBe(1);
    expect(weekStartsOn('fr-FR')).toBe(1);
  });
});

describe('zone names and search', () => {
  it('labels zones the way the booking page shows them', () => {
    expect(zoneLabel('Africa/Nairobi', T, 'en-US')).toBe('East Africa Time (Nairobi)');
    expect(zoneLabel('UTC', T, 'en-US')).toBe('Coordinated Universal Time (UTC)');
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('Asia/Calcutta')).toBe('Kolkata');
    expect(formatOffset(180)).toBe('GMT+3');
    expect(formatOffset(-210)).toBe('GMT-3:30');
    expect(formatOffset(0)).toBe('GMT');
    expect(isValidZone('Africa/Nairobi')).toBe(true);
    expect(isValidZone('Mars/Olympus')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });

  it('describes a single zone', () => {
    const z = zoneInfo('Africa/Nairobi', T, 'en-US');
    expect(z).toMatchObject({ id: 'Africa/Nairobi', city: 'Nairobi', region: 'Africa', offsetMin: 180, offset: 'GMT+3', name: 'East Africa Time' });
    expect(z.search).toContain('kenya');
  });

  it('lists zones grouped by region with UTC included', () => {
    const groups = listZones(T, 'en-US');
    expect(groups[0].region).toBe('Africa');
    expect(groups.map((g) => g.region)).toContain('Americas');
    expect(groups[groups.length - 1].region).toBe('UTC');
    const all = groups.flatMap((g) => g.zones);
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((z) => z.id === 'Africa/Nairobi')).toBe(true);
    expect(all.every((z) => !z.id.startsWith('Etc/'))).toBe(true);
  });

  it('searches by city, country, name and offset', () => {
    expect(searchZones('kenya', T, 'en-US')[0].city).toBe('Nairobi');
    expect(searchZones('new york', T, 'en-US')[0].id).toBe('America/New_York');
    expect(searchZones('india', T, 'en-US')[0].city).toBe('Kolkata');
    expect(searchZones('london', T, 'en-US')[0].id).toBe('Europe/London');
    expect(searchZones('gmt+3', T, 'en-US').length).toBeGreaterThan(3);
    expect(searchZones('east africa', T, 'en-US').some((z) => z.city === 'Nairobi')).toBe(true);
    expect(searchZones('qqqq', T, 'en-US')).toHaveLength(0);
    expect(searchZones('', T, 'en-US').length).toBeGreaterThan(200);
  });

  it('puts matches on the city name first, and the start of a word before the inside of one', () => {
    const ids = (q: string): string[] => searchZones(q, T, 'en-US').map((z) => z.id);
    // "new" is also a word in Sydney's "new south wales" and Auckland's "new zealand": the city named New York comes first.
    const typedNew = ids('new');
    expect(typedNew[0]).toBe('America/New_York');
    expect(typedNew.indexOf('America/New_York')).toBeLessThan(typedNew.indexOf('Australia/Sydney'));
    expect(typedNew.indexOf('America/New_York')).toBeLessThan(typedNew.indexOf('Pacific/Auckland'));
    // Every city that has "new" as a word comes before every zone that only has it elsewhere.
    const cityHits = searchZones('new', T, 'en-US').map((z) => /(^|[^a-z])new([^a-z]|$)/i.test(z.city));
    expect(cityHits.indexOf(false)).toBeGreaterThan(cityHits.lastIndexOf(true));
    // Half a word.
    expect(ids('syd')[0]).toBe('Australia/Sydney');
    expect(ids('york')[0]).toBe('America/New_York');
    expect(ids('ber')[0]).toBe('Europe/Berlin');
    // The start of a word before the inside of one: "lin" starts no big city, so the first hits are cities that start with it.
    const lin = searchZones('lin', T, 'en-US');
    const firstInside = lin.findIndex((z) => !/(^|[^a-z])lin/i.test(z.city));
    expect(firstInside).toBeGreaterThan(0);
    expect(lin.slice(0, firstInside).every((z) => /(^|[^a-z])lin/i.test(z.city))).toBe(true);
    expect(lin.slice(firstInside).some((z) => z.id === 'Europe/Berlin')).toBe(true);
  });
});
