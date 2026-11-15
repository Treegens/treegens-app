import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../server/lib/http';
import { IcsFeedError, assertSafeFeedUrl, fetchIcsBusy, mergeBusy, parseIcsBusy, parseIcsDetailed, windowsZoneToIana } from '../../server/lib/icsfeed';
import type { Interval } from '../../server/lib/time';
import { makeTestCtx } from '../helpers/ctx';

// ───────────────────────── helpers ─────────────────────────

const ms = (iso: string): number => Date.parse(iso);
const iv = (start: string, end: string): Interval => ({ start: ms(start), end: ms(end) });
const range = (start: string, end: string): Interval => iv(start, end);
const NOVEMBER = range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');

function calendar(...parts: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...parts, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

/** US Eastern, the way Google Calendar writes it. */
const TZ_NEW_YORK = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

/** The same zone, the way Outlook writes it: a Windows name and rules that start in 1601. */
const TZ_OUTLOOK_EASTERN = [
  'BEGIN:VTIMEZONE',
  'TZID:Eastern Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

// ───────────────────────── URL guard ─────────────────────────

describe('assertSafeFeedUrl', () => {
  it.each([
    ['https://calendar.google.com/calendar/ical/someone%40example.com/private-abc/basic.ics', 'https://calendar.google.com/calendar/ical/someone%40example.com/private-abc/basic.ics'],
    ['  https://outlook.office365.com/owa/calendar/abc/def/calendar.ics  ', 'https://outlook.office365.com/owa/calendar/abc/def/calendar.ics'],
    ['webcal://p01-caldav.icloud.com/published/2/MTIzNDU', 'https://p01-caldav.icloud.com/published/2/MTIzNDU'],
    ['WEBCAL://Example.ORG/feed.ics?key=1#section', 'https://example.org/feed.ics?key=1'],
    ['https://example.org:443/feed.ics', 'https://example.org/feed.ics'],
    ['https://xn--bcher-kva.example.org/feed.ics', 'https://xn--bcher-kva.example.org/feed.ics'],
  ])('accepts %s', (input, expected) => {
    expect(assertSafeFeedUrl(input).href).toBe(expected);
  });

  it.each([
    ['plain http', 'http://example.org/feed.ics'],
    ['another scheme', 'ftp://example.org/feed.ics'],
    ['file scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/calendar,BEGIN:VCALENDAR'],
    ['credentials', 'https://user:secret@example.org/feed.ics'],
    ['user name only', 'https://user@example.org/feed.ics'],
    ['IPv4 literal', 'https://93.184.216.34/feed.ics'],
    ['loopback', 'https://127.0.0.1/feed.ics'],
    ['private range', 'https://10.0.0.8/feed.ics'],
    ['link-local metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['decimal IPv4', 'https://2130706433/feed.ics'],
    ['hex IPv4', 'https://0x7f000001/feed.ics'],
    ['octal IPv4', 'https://0177.0.0.1/feed.ics'],
    ['short IPv4', 'https://127.1/feed.ics'],
    ['IPv6 loopback', 'https://[::1]/feed.ics'],
    ['IPv4-mapped IPv6', 'https://[::ffff:10.0.0.1]/feed.ics'],
    ['localhost', 'https://localhost/feed.ics'],
    ['localhost with a trailing dot', 'https://localhost./feed.ics'],
    ['a localhost subdomain', 'https://app.localhost/feed.ics'],
    ['.local', 'https://printer.local/feed.ics'],
    ['.internal', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['.home.arpa', 'https://nas.home.arpa/feed.ics'],
    ['a single-label host', 'https://intranet/feed.ics'],
    ['a numeric top-level label', 'https://example.123/feed.ics'],
    ['an address-in-name service', 'https://10.0.0.1.nip.io/feed.ics'],
    ['another port', 'https://example.org:8443/feed.ics'],
    ['an internal port', 'https://example.org:22/feed.ics'],
    ['whitespace inside', 'https://exa mple.org/feed.ics'],
    ['a line break', 'https://example.org/feed.ics\r\nHost: evil'],
    ['a backslash', 'https://example.org\\@127.0.0.1/feed.ics'],
    ['not a URL', 'calendar please'],
    ['empty', ''],
    ['too long', `https://example.org/${'a'.repeat(2100)}`],
  ])('refuses %s', (_name, input) => {
    let caught: unknown;
    try {
      assertSafeFeedUrl(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ status: 422, code: 'invalid_feed_url' });
  });

  it('refuses values that are not strings', () => {
    expect(() => assertSafeFeedUrl(undefined as unknown as string)).toThrow(HttpError);
    expect(() => assertSafeFeedUrl(42 as unknown as string)).toThrow(HttpError);
  });
});

// ───────────────────────── parsing ─────────────────────────

describe('parseIcsBusy: single events', () => {
  it('reads UTC, zoned and floating times, floating ones in the host\'s zone', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent('UID:utc', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'),
      vevent('UID:zoned', 'DTSTART;TZID=America/New_York:20261104T090000', 'DTEND;TZID=America/New_York:20261104T093000'),
      vevent('UID:floating', 'DTSTART:20261105T120000', 'DTEND:20261105T130000'),
    );
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Africa/Nairobi' })).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-04T14:00:00Z', '2026-11-04T14:30:00Z'), // EST, UTC-5
      iv('2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z'), // floating: the host's local time, Nairobi is UTC+3
    ]);
    // Without a host zone the reader's local time is UTC.
    expect(parseIcsBusy(text, NOVEMBER)[2]).toEqual(iv('2026-11-05T12:00:00Z', '2026-11-05T13:00:00Z'));
  });

  it('reads floating times in the zone the calendar names (X-WR-TIMEZONE), as league and school feeds write them', () => {
    // The reviewer's case: an 18:00 to 19:30 event in a New York feed, for a host in New York.
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-TIMEZONE:America/New_York', vevent('UID:game', 'DTSTART:20261110T180000', 'DTEND:20261110T193000'), 'END:VCALENDAR', ''].join('\r\n');
    const evening = iv('2026-11-10T23:00:00Z', '2026-11-11T00:30:00Z'); // 18:00 EST
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'America/New_York' })).toEqual([evening]);
    // The calendar's zone wins over the host's: the feed says where its times are.
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Europe/London' })).toEqual([evening]);
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([evening]);
    // A Windows name works there too; a zone nobody knows falls back to the host's zone.
    expect(parseIcsBusy(text.replace('America/New_York', 'Eastern Standard Time'), NOVEMBER)).toEqual([evening]);
    expect(parseIcsBusy(text.replace('America/New_York', 'Atlantis/Central'), NOVEMBER, { timezone: 'Africa/Nairobi' })).toEqual([iv('2026-11-10T15:00:00Z', '2026-11-10T16:30:00Z')]);
    // UTC and zoned times are not touched by it, and all-day events still block the host's day.
    const mixed = [
      'BEGIN:VCALENDAR',
      'X-WR-TIMEZONE:America/New_York',
      vevent('UID:utc', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'),
      vevent('UID:berlin', 'DTSTART;TZID=Europe/Berlin:20261104T100000', 'DTEND;TZID=Europe/Berlin:20261104T110000'),
      vevent('UID:day', 'DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118'),
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseIcsBusy(mixed, NOVEMBER, { timezone: 'Africa/Nairobi' })).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z'),
      iv('2026-11-16T21:00:00Z', '2026-11-17T21:00:00Z'),
    ]);
  });

  it('keeps the calendar zone when the strict parser rejects the feed and events are salvaged', () => {
    const text = ['BEGIN:VCALENDAR', 'X-WR-TIMEZONE:America/New_York', 'BEGIN:VEVENT', 'UID:a', 'this line is not a property', 'DTSTART:20261110T180000', 'DTEND:20261110T193000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Europe/London' })).toEqual([iv('2026-11-10T23:00:00Z', '2026-11-11T00:30:00Z')]);
  });

  it('uses the VTIMEZONE of the feed, including zones no database knows', () => {
    const text = calendar(
      ['BEGIN:VTIMEZONE', 'TZID:Head Office', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n'),
      TZ_OUTLOOK_EASTERN,
      vevent('UID:office', 'DTSTART;TZID=Head Office:20261103T100000', 'DTEND;TZID=Head Office:20261103T110000'),
      vevent('UID:summer', 'DTSTART;TZID=Eastern Standard Time:20260707T090000', 'DTEND;TZID=Eastern Standard Time:20260707T100000'),
      vevent('UID:winter', 'DTSTART;TZID=Eastern Standard Time:20261207T090000', 'DTEND;TZID=Eastern Standard Time:20261207T100000'),
    );
    expect(parseIcsBusy(text, range('2026-07-01T00:00:00Z', '2026-12-31T00:00:00Z'))).toEqual([
      iv('2026-07-07T13:00:00Z', '2026-07-07T14:00:00Z'), // daylight time, UTC-4
      iv('2026-11-03T07:00:00Z', '2026-11-03T08:00:00Z'), // UTC+3
      iv('2026-12-07T14:00:00Z', '2026-12-07T15:00:00Z'), // standard time, UTC-5
    ]);
  });

  it('falls back to the zone database when a TZID has no definition in the feed', () => {
    const text = calendar(
      vevent('UID:summer', 'DTSTART;TZID=Europe/Berlin:20260715T100000', 'DTEND;TZID=Europe/Berlin:20260715T110000'),
      vevent('UID:winter', 'DTSTART;TZID=Europe/Berlin:20261103T100000', 'DTEND;TZID=Europe/Berlin:20261103T110000'),
      vevent('UID:prefixed', 'DTSTART;TZID=/mozilla.org/20050126_1/Asia/Kolkata:20261104T100000', 'DTEND;TZID=/mozilla.org/20050126_1/Asia/Kolkata:20261104T110000'),
      vevent('UID:unknown', 'DTSTART;TZID=Not A Zone:20261105T100000', 'DTEND;TZID=Not A Zone:20261105T110000'),
    );
    expect(parseIcsBusy(text, range('2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z'))).toEqual([
      iv('2026-07-15T08:00:00Z', '2026-07-15T09:00:00Z'),
      iv('2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'),
      iv('2026-11-04T04:30:00Z', '2026-11-04T05:30:00Z'),
      iv('2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'), // nothing known about the zone, and no host zone: UTC
    ]);
    // With a host zone, a zone nobody can place is read like a floating time: in the host's zone.
    expect(parseIcsBusy(text, range('2026-11-05T00:00:00Z', '2026-12-01T00:00:00Z'), { timezone: 'America/Chicago' })).toEqual([iv('2026-11-05T16:00:00Z', '2026-11-05T17:00:00Z')]);
  });

  it('places Windows zone names that come without a VTIMEZONE', () => {
    // Read as UTC this used to come out 8 hours early.
    const text = calendar(
      vevent('UID:pst', 'DTSTART;TZID=Pacific Standard Time:20261103T100000', 'DTEND;TZID=Pacific Standard Time:20261103T110000'),
      vevent('UID:summer', 'DTSTART;TZID="W. Europe Standard Time":20260715T100000', 'DTEND;TZID="W. Europe Standard Time":20260715T110000'),
      vevent('UID:india', 'DTSTART;TZID=India Standard Time:20261104T100000', 'DTEND;TZID=India Standard Time:20261104T110000'),
    );
    expect(parseIcsBusy(text, range('2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z'), { timezone: 'Europe/London' })).toEqual([
      iv('2026-07-15T08:00:00Z', '2026-07-15T09:00:00Z'), // CEST, UTC+2
      iv('2026-11-03T18:00:00Z', '2026-11-03T19:00:00Z'), // PST, UTC-8
      iv('2026-11-04T04:30:00Z', '2026-11-04T05:30:00Z'), // IST, UTC+5:30
    ]);
  });

  it('maps every Windows zone in its table to a zone the zone database knows', () => {
    for (const name of ['Pacific Standard Time', 'eastern standard time', ' GMT Standard Time ', 'E. Africa Standard Time', 'AUS Eastern Standard Time', 'UTC', 'UTC+12', 'Dateline Standard Time']) {
      const iana = windowsZoneToIana(name);
      expect(iana, name).not.toBeNull();
      expect(IANAZone.isValidZone(iana!), name).toBe(true);
    }
    expect(windowsZoneToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(windowsZoneToIana('Not A Zone')).toBeNull();
    expect(windowsZoneToIana('constructor')).toBeNull();
  });

  it('handles events that start in one zone and end in another', () => {
    const text = calendar(vevent('UID:flight', 'DTSTART;TZID=America/New_York:20261110T180000', 'DTEND;TZID=Europe/London:20261111T060000'));
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-10T23:00:00Z', '2026-11-11T06:00:00Z')]);
  });

  it('reads DTEND without a TZID in the zone of DTSTART', () => {
    const text = calendar(vevent('UID:sloppy', 'DTSTART;TZID=Asia/Tokyo:20261110T090000', 'DTEND:20261110T100000'));
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z')]);
  });

  it('understands DURATION and ignores events without any length', () => {
    const text = calendar(
      vevent('UID:duration', 'DTSTART:20261103T100000Z', 'DURATION:PT1H30M'),
      vevent('UID:instant', 'DTSTART:20261104T100000Z'),
      vevent('UID:zero', 'DTSTART:20261105T100000Z', 'DTEND:20261105T100000Z'),
      vevent('UID:backwards', 'DTSTART:20261106T100000Z', 'DTEND:20261106T090000Z'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-03T10:00:00Z', '2026-11-03T11:30:00Z')]);
  });

  it('skips cancelled and transparent events', () => {
    const text = calendar(
      vevent('UID:busy', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'STATUS:CONFIRMED', 'TRANSP:OPAQUE'),
      vevent('UID:tentative', 'DTSTART:20261103T120000Z', 'DTEND:20261103T130000Z', 'STATUS:TENTATIVE'),
      vevent('UID:cancelled', 'DTSTART:20261104T100000Z', 'DTEND:20261104T110000Z', 'STATUS:CANCELLED'),
      vevent('UID:cancelled-lower', 'DTSTART:20261104T120000Z', 'DTEND:20261104T130000Z', 'STATUS:cancelled'),
      vevent('UID:free', 'DTSTART:20261105T100000Z', 'DTEND:20261105T110000Z', 'TRANSP:TRANSPARENT'),
      vevent('UID:outlook-free', 'DTSTART:20261106T100000Z', 'DTEND:20261106T110000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:FREE'),
      vevent('UID:outlook-busy', 'DTSTART:20261107T100000Z', 'DTEND:20261107T110000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:BUSY'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-03T12:00:00Z', '2026-11-03T13:00:00Z'),
      iv('2026-11-07T10:00:00Z', '2026-11-07T11:00:00Z'),
    ]);
  });

  it('blocks all-day events for the whole local day, unless they are transparent', () => {
    const text = calendar(
      vevent('UID:one-day', 'DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118'),
      vevent('UID:no-end', 'DTSTART;VALUE=DATE:20261120'),
      vevent('UID:three-days', 'DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261126'),
      vevent('UID:birthday', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'TRANSP:TRANSPARENT'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-17T00:00:00Z', '2026-11-18T00:00:00Z'),
      iv('2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z'),
      iv('2026-11-23T00:00:00Z', '2026-11-26T00:00:00Z'),
    ]);
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'America/Los_Angeles' })).toEqual([
      iv('2026-11-17T08:00:00Z', '2026-11-18T08:00:00Z'),
      iv('2026-11-20T08:00:00Z', '2026-11-21T08:00:00Z'),
      iv('2026-11-23T08:00:00Z', '2026-11-26T08:00:00Z'),
    ]);
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Africa/Nairobi' })[0]).toEqual(iv('2026-11-16T21:00:00Z', '2026-11-17T21:00:00Z'));
    // an unknown zone name falls back to UTC instead of failing
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Nowhere/Land' })[0]).toEqual(iv('2026-11-17T00:00:00Z', '2026-11-18T00:00:00Z'));
  });

  it('makes an all-day event on a daylight-saving day as long as that day really is', () => {
    const text = calendar(vevent('UID:dst', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102'));
    const [day] = parseIcsBusy(text, range('2026-10-25T00:00:00Z', '2026-11-08T00:00:00Z'), { timezone: 'America/New_York' });
    expect(day).toEqual(iv('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'));
    expect(day.end - day.start).toBe(25 * 3_600_000);
  });

  it('clips to the range, drops what lies outside and merges overlaps', () => {
    const text = calendar(
      vevent('UID:before', 'DTSTART:20261030T100000Z', 'DTEND:20261030T110000Z'),
      vevent('UID:straddles-start', 'DTSTART:20261031T230000Z', 'DTEND:20261101T010000Z'),
      vevent('UID:a', 'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z'),
      vevent('UID:b', 'DTSTART:20261110T103000Z', 'DTEND:20261110T120000Z'),
      vevent('UID:c', 'DTSTART:20261110T120000Z', 'DTEND:20261110T123000Z'),
      vevent('UID:straddles-end', 'DTSTART:20261130T230000Z', 'DTEND:20261201T020000Z'),
      vevent('UID:touches-end', 'DTSTART:20261201T000000Z', 'DTEND:20261201T010000Z'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z'),
      iv('2026-11-10T10:00:00Z', '2026-11-10T12:30:00Z'),
      iv('2026-11-30T23:00:00Z', '2026-12-01T00:00:00Z'),
    ]);
  });

  it('accepts bare line feeds, folded lines, a byte order mark and several calendars in one file', () => {
    const one = calendar(vevent('UID:one', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'SUMMARY:A long title that is fol', ' ded over two lines'));
    const two = calendar(vevent('UID:two', 'DTSTART:20261104T100000Z', 'DTEND:20261104T110000Z'));
    const text = `﻿${one}${two}`.replace(/\r\n/g, '\n');
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'), iv('2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z')]);
  });
});

describe('parseIcsBusy: recurring events', () => {
  it('expands a weekly series with EXDATE across a daylight-saving change', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent(
        'UID:standup',
        'DTSTART;TZID=America/New_York:20261005T090000',
        'DTEND;TZID=America/New_York:20261005T093000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
        'EXDATE;TZID=America/New_York:20261104T090000',
      ),
    );
    expect(parseIcsBusy(text, range('2026-10-26T00:00:00Z', '2026-11-12T00:00:00Z'))).toEqual([
      iv('2026-10-26T13:00:00Z', '2026-10-26T13:30:00Z'), // 09:00 EDT
      iv('2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z'),
      iv('2026-11-02T14:00:00Z', '2026-11-02T14:30:00Z'), // 09:00 EST, the clocks went back on 1 November
      // 4 November is excluded
      iv('2026-11-09T14:00:00Z', '2026-11-09T14:30:00Z'),
      iv('2026-11-11T14:00:00Z', '2026-11-11T14:30:00Z'),
    ]);
  });

  it('honours EXDATE written in UTC, as a bare date, or without the TZID of DTSTART', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent(
        'UID:daily',
        'DTSTART;TZID=America/New_York:20261109T090000',
        'DTEND;TZID=America/New_York:20261109T100000',
        'RRULE:FREQ=DAILY;COUNT=5',
        'EXDATE:20261110T140000Z',
        'EXDATE;VALUE=DATE:20261111',
        'EXDATE:20261112T090000',
      ),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-09T14:00:00Z', '2026-11-09T15:00:00Z'), iv('2026-11-13T14:00:00Z', '2026-11-13T15:00:00Z')]);
  });

  it('respects COUNT, UNTIL and INTERVAL', () => {
    const text = calendar(
      vevent('UID:count', 'DTSTART:20261102T080000Z', 'DTEND:20261102T083000Z', 'RRULE:FREQ=DAILY;COUNT=3'),
      vevent('UID:until', 'DTSTART:20261103T120000Z', 'DTEND:20261103T130000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261117T120000Z'),
      vevent('UID:interval', 'DTSTART:20261106T160000Z', 'DTEND:20261106T170000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2'),
      vevent('UID:monthly', 'DTSTART:20260115T180000Z', 'DTEND:20260115T190000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15'),
      vevent('UID:over', 'DTSTART:20250106T100000Z', 'DTEND:20250106T110000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20260601T000000Z'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-02T08:00:00Z', '2026-11-02T08:30:00Z'),
      iv('2026-11-03T08:00:00Z', '2026-11-03T08:30:00Z'),
      iv('2026-11-03T12:00:00Z', '2026-11-03T13:00:00Z'),
      iv('2026-11-04T08:00:00Z', '2026-11-04T08:30:00Z'),
      iv('2026-11-06T16:00:00Z', '2026-11-06T17:00:00Z'),
      iv('2026-11-10T12:00:00Z', '2026-11-10T13:00:00Z'),
      iv('2026-11-15T18:00:00Z', '2026-11-15T19:00:00Z'),
      iv('2026-11-17T12:00:00Z', '2026-11-17T13:00:00Z'),
      iv('2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z'),
    ]);
  });

  it('includes DTSTART next to RDATE', () => {
    const text = calendar(vevent('UID:rdate', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'RDATE:20261105T100000Z,20261107T140000Z'));
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'),
      iv('2026-11-07T14:00:00Z', '2026-11-07T15:00:00Z'),
    ]);
  });

  it('reads RDATE periods, each with its own end or length', () => {
    // The reviewer's case: only Monday came back before, Wednesday and Friday were read as free.
    const text = calendar(vevent('UID:p1', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RDATE;VALUE=PERIOD:20261104T140000Z/20261104T160000Z,20261106T140000Z/PT1H'));
    const result = parseIcsDetailed(text, NOVEMBER);
    expect(result.busy).toEqual([iv('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'), iv('2026-11-04T14:00:00Z', '2026-11-04T16:00:00Z'), iv('2026-11-06T14:00:00Z', '2026-11-06T15:00:00Z')]);
    expect(result).toMatchObject({ skipped: 0, incomplete: false });
  });

  it('reads RDATE periods next to a rule and plain RDATEs, in their zone, honouring EXDATE and replaced instances', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent(
        'UID:mix',
        'DTSTART;TZID=America/New_York:20261102T090000',
        'DTEND;TZID=America/New_York:20261102T100000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'RDATE;TZID=America/New_York:20261104T090000',
        'RDATE;TZID=America/New_York;VALUE=PERIOD:20261106T130000/PT30M,20261113T130000/PT30M,20261120T130000/20261120T150000',
        'EXDATE;TZID=America/New_York:20261113T130000',
      ),
      // the 20 November period was moved to the afternoon
      vevent('UID:mix', 'RECURRENCE-ID;TZID=America/New_York:20261120T130000', 'DTSTART;TZID=America/New_York:20261120T160000', 'DTEND;TZID=America/New_York:20261120T170000'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'),
      iv('2026-11-04T14:00:00Z', '2026-11-04T15:00:00Z'),
      iv('2026-11-06T18:00:00Z', '2026-11-06T18:30:00Z'),
      iv('2026-11-09T14:00:00Z', '2026-11-09T15:00:00Z'),
      iv('2026-11-20T21:00:00Z', '2026-11-20T22:00:00Z'),
    ]);
  });

  it('expands recurring all-day events in the local zone', () => {
    const text = calendar(vevent('UID:offsite', 'DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261110', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;VALUE=DATE:20261116'));
    expect(parseIcsBusy(text, NOVEMBER, { timezone: 'Europe/London' })).toEqual([
      iv('2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z'),
      iv('2026-11-23T00:00:00Z', '2026-11-24T00:00:00Z'),
    ]);
  });

  it('applies replaced instances: moved, cancelled and made free', () => {
    const text = calendar(
      vevent('UID:weekly', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=5'),
      // 10 November moved to the next day and made longer
      vevent('UID:weekly', 'RECURRENCE-ID:20261110T100000Z', 'DTSTART:20261111T150000Z', 'DTEND:20261111T163000Z'),
      // 17 November cancelled
      vevent('UID:weekly', 'RECURRENCE-ID:20261117T100000Z', 'DTSTART:20261117T100000Z', 'DTEND:20261117T110000Z', 'STATUS:CANCELLED'),
      // 24 November kept but marked free
      vevent('UID:weekly', 'RECURRENCE-ID:20261124T100000Z', 'DTSTART:20261124T100000Z', 'DTEND:20261124T110000Z', 'TRANSP:TRANSPARENT'),
      // an unrelated series at the same times must not be affected by those overrides
      vevent('UID:other', 'DTSTART:20261110T100000Z', 'DTEND:20261110T101500Z'),
    );
    expect(parseIcsBusy(text, range('2026-11-01T00:00:00Z', '2026-12-15T00:00:00Z'))).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-10T10:00:00Z', '2026-11-10T10:15:00Z'),
      iv('2026-11-11T15:00:00Z', '2026-11-11T16:30:00Z'),
      iv('2026-12-01T10:00:00Z', '2026-12-01T11:00:00Z'),
    ]);
  });

  it('matches a replaced instance whose RECURRENCE-ID is written in another form than DTSTART', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent('UID:sync', 'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      // 9 November, identified in UTC, moved to the afternoon
      vevent('UID:sync', 'RECURRENCE-ID:20261109T140000Z', 'DTSTART;TZID=America/New_York:20261109T150000', 'DTEND;TZID=America/New_York:20261109T160000'),
      // 16 November, identified without a zone, cancelled
      vevent('UID:sync', 'RECURRENCE-ID:20261116T090000', 'DTSTART;TZID=America/New_York:20261116T090000', 'DTEND;TZID=America/New_York:20261116T100000', 'STATUS:CANCELLED'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([iv('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'), iv('2026-11-09T20:00:00Z', '2026-11-09T21:00:00Z')]);
  });

  it('keeps a moved instance that enters the range from outside, and a replaced instance without its series', () => {
    const text = calendar(
      vevent('UID:monthly', 'DTSTART:20260905T100000Z', 'DTEND:20260905T110000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5'),
      // the December occurrence is pulled into November
      vevent('UID:monthly', 'RECURRENCE-ID:20261205T100000Z', 'DTSTART:20261127T100000Z', 'DTEND:20261127T110000Z'),
      // an invitation to one occurrence of somebody else's series
      vevent('UID:orphan', 'RECURRENCE-ID:20261112T090000Z', 'DTSTART:20261112T090000Z', 'DTEND:20261112T093000Z'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'),
      iv('2026-11-12T09:00:00Z', '2026-11-12T09:30:00Z'),
      iv('2026-11-27T10:00:00Z', '2026-11-27T11:00:00Z'),
    ]);
  });

  it('shifts every later occurrence for a THISANDFUTURE replacement', () => {
    const text = calendar(
      vevent('UID:taf', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'RRULE:FREQ=WEEKLY'),
      vevent('UID:taf', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261117T100000Z', 'DTSTART:20261117T120000Z', 'DTEND:20261117T133000Z'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      iv('2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z'),
      iv('2026-11-17T12:00:00Z', '2026-11-17T13:30:00Z'),
      iv('2026-11-24T12:00:00Z', '2026-11-24T13:30:00Z'),
    ]);
  });

  it('agrees with an independent calculation for an old fortnightly series (zone database path)', () => {
    // Monday 2 January 2012, every second week on Monday, Wednesday and Friday, 08:30 London time, 45 minutes
    const text = calendar(vevent('UID:old', 'DTSTART;TZID=Europe/London:20120102T083000', 'DURATION:PT45M', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=MO'));
    const window = range('2026-10-12T00:00:00Z', '2026-11-20T00:00:00Z'); // spans the end of British Summer Time
    const expected: Interval[] = [];
    const first = DateTime.fromObject({ year: 2012, month: 1, day: 2, hour: 8, minute: 30 }, { zone: 'Europe/London' });
    for (let day = 0; ; day++) {
      const at = first.plus({ days: day });
      if (at.toMillis() >= window.end) break;
      const weekIndex = Math.floor(day / 7);
      if (weekIndex % 2 !== 0 || ![1, 3, 5].includes(at.weekday)) continue;
      if (at.toMillis() + 45 * 60_000 > window.start) expected.push({ start: at.toMillis(), end: at.toMillis() + 45 * 60_000 });
    }
    expect(expected.length).toBeGreaterThanOrEqual(8);
    const result = parseIcsDetailed(text, window);
    expect(result.busy).toEqual(expected);
    expect(result.truncated).toBe(false);
  });

  it('agrees with an independent calculation for an old weekday series (VTIMEZONE path)', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent('UID:weekdays', 'DTSTART;TZID=America/New_York:20100104T170000', 'DTEND;TZID=America/New_York:20100104T173000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'EXDATE;TZID=America/New_York:20261126T170000'),
    );
    const window = range('2026-10-20T00:00:00Z', '2026-12-05T00:00:00Z');
    const expected: Interval[] = [];
    let at = DateTime.fromObject({ year: 2026, month: 10, day: 15, hour: 17 }, { zone: 'America/New_York' });
    for (; at.toMillis() < window.end; at = at.plus({ days: 1 })) {
      if (at.weekday > 5 || at.toISODate() === '2026-11-26') continue;
      if (at.toMillis() + 30 * 60_000 > window.start) expected.push({ start: at.toMillis(), end: at.toMillis() + 30 * 60_000 });
    }
    expect(parseIcsBusy(text, window)).toEqual(expected);
  });

  it('repeats the clock-face length when the first instance sits on a daylight-saving change', () => {
    const text = calendar(
      TZ_NEW_YORK,
      // 00:30 EDT to 03:00 EST on the night the clocks go back: three and a half hours long, once
      vevent('UID:night', 'DTSTART;TZID=America/New_York:20261101T003000', 'DTEND;TZID=America/New_York:20261101T030000', 'RRULE:FREQ=WEEKLY;COUNT=2'),
    );
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([
      iv('2026-11-01T04:30:00Z', '2026-11-01T08:00:00Z'),
      iv('2026-11-08T05:30:00Z', '2026-11-08T08:00:00Z'),
    ]);
  });

  it('agrees with an independent calculation for old all-day and every-third-day series', () => {
    const text = calendar(
      vevent('UID:fridays-off', 'DTSTART;VALUE=DATE:20130104', 'DTEND;VALUE=DATE:20130105', 'RRULE:FREQ=WEEKLY'),
      vevent('UID:third-day', 'DTSTART;TZID=Asia/Kolkata:20110301T061500', 'DTEND;TZID=Asia/Kolkata:20110301T064500', 'RRULE:FREQ=DAILY;INTERVAL=3'),
    );
    const window = range('2026-11-01T00:00:00Z', '2026-11-22T00:00:00Z');
    const expected: Interval[] = [];
    // every Friday, as a whole day in Sydney
    let friday = DateTime.fromObject({ year: 2013, month: 1, day: 4 }, { zone: 'Australia/Sydney' });
    for (; friday.toMillis() < window.end; friday = friday.plus({ weeks: 1 })) {
      const end = friday.plus({ days: 1 }).toMillis();
      if (end > window.start) expected.push({ start: Math.max(friday.toMillis(), window.start), end: Math.min(end, window.end) });
    }
    // every third day at 06:15 India time
    const first = DateTime.fromObject({ year: 2011, month: 3, day: 1, hour: 6, minute: 15 }, { zone: 'Asia/Kolkata' });
    for (let n = 0; ; n += 3) {
      const at = first.plus({ days: n }).toMillis();
      if (at >= window.end) break;
      if (at + 30 * 60_000 > window.start) expected.push({ start: at, end: at + 30 * 60_000 });
    }
    const result = parseIcsDetailed(text, window, { timezone: 'Australia/Sydney' });
    expect(result.busy).toEqual(mergeBusy(expected));
    expect(result.busy.length).toBeGreaterThanOrEqual(9);
    expect(result.truncated).toBe(false);
  });

  it('walks old series quickly', () => {
    const events: string[] = [];
    for (let i = 0; i < 150; i++) {
      const hour = String(i % 10).padStart(2, '0');
      events.push(vevent(`UID:daily-${i}`, `DTSTART;TZID=America/New_York:20100104T${hour}0000`, `DTEND;TZID=America/New_York:20100104T${hour}3000`, 'RRULE:FREQ=DAILY'));
    }
    const result = parseIcsDetailed(calendar(TZ_NEW_YORK, ...events), range('2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z'));
    expect(result.truncated).toBe(false);
    expect(result.events).toBe(150);
    // ten distinct half hours a day for seven days
    expect(result.busy).toHaveLength(70);
    expect(result.busy[0]).toEqual(iv('2026-11-02T05:00:00Z', '2026-11-02T05:30:00Z'));
  });
});

describe('parseIcsBusy: bad input', () => {
  it.each([
    ['an empty string', ''],
    ['a web page', '<!doctype html><html><body><h1>Sign in</h1></body></html>'],
    ['random text', 'this is not\na calendar: at all\n'],
    ['a calendar without events', calendar()],
    ['a calendar that never ends', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\n'],
    ['binary noise', '\u0000\u0001\u0002BEGIN\u0000:VCALENDAR'],
  ])('returns nothing for %s', (_name, text) => {
    expect(parseIcsBusy(text, NOVEMBER)).toEqual([]);
  });

  it('never throws for values of the wrong type or a broken range', () => {
    expect(parseIcsBusy(undefined as unknown as string, NOVEMBER)).toEqual([]);
    expect(parseIcsBusy(42 as unknown as string, NOVEMBER)).toEqual([]);
    const text = calendar(vevent('UID:1', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'));
    expect(parseIcsBusy(text, { start: NOVEMBER.end, end: NOVEMBER.start })).toEqual([]);
    expect(parseIcsBusy(text, { start: Number.NaN, end: NOVEMBER.end })).toEqual([]);
    expect(parseIcsBusy(text, undefined as unknown as Interval)).toEqual([]);
  });

  it('keeps the good events of a feed with broken ones', () => {
    const text = calendar(
      TZ_NEW_YORK,
      vevent('UID:good-1', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'),
      vevent('UID:bad-date', 'DTSTART:2026-11-04 10 o clock', 'DTEND:20261104T110000Z'),
      vevent('UID:bad-rule', 'DTSTART:20261105T100000Z', 'DTEND:20261105T110000Z', 'RRULE:FREQ=SOMETIMES'),
      vevent('UID:no-start', 'DTEND:20261106T110000Z'),
      vevent('UID:good-2', 'DTSTART;TZID=America/New_York:20261109T090000', 'DTEND;TZID=America/New_York:20261109T100000'),
    );
    const result = parseIcsDetailed(text, NOVEMBER);
    expect(result.busy).toEqual([
      iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
      // the rule is unreadable, but the first instance is still known
      iv('2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'),
      iv('2026-11-09T14:00:00Z', '2026-11-09T15:00:00Z'),
    ]);
    expect(result.events).toBe(5);
    expect(result.skipped).toBe(3);
    expect(result.truncated).toBe(false);
    // Every later instance of that series is unknown, so the answer is incomplete.
    expect(result.incomplete).toBe(true);
  });

  it('marks the answer incomplete only for a series that blocks time and could not be expanded', () => {
    const lost = (...extra: string[]) => calendar(vevent('UID:series', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;BYDAY=XX', ...extra), vevent('UID:fine', 'DTSTART:20261103T140000Z', 'DTEND:20261103T150000Z'));
    // The reviewer's case: an unreadable rule kept only its first instance.
    const busy = parseIcsDetailed(lost(), NOVEMBER);
    expect(busy.busy).toEqual([iv('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'), iv('2026-11-03T14:00:00Z', '2026-11-03T15:00:00Z')]);
    expect(busy).toMatchObject({ skipped: 1, incomplete: true });
    // A series marked free, or cancelled, blocks nothing: losing its rule loses nothing.
    expect(parseIcsDetailed(lost('TRANSP:TRANSPARENT'), NOVEMBER)).toMatchObject({ skipped: 1, incomplete: false });
    expect(parseIcsDetailed(lost('STATUS:CANCELLED'), NOVEMBER)).toMatchObject({ skipped: 1, incomplete: false });
    // A series that only starts after the window cannot reach into it.
    expect(parseIcsDetailed(lost(), range('2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'))).toMatchObject({ incomplete: false });
    // Events that are simply unreadable (no start) are left out without failing the feed.
    expect(parseIcsDetailed(calendar(vevent('UID:no-start', 'DTEND:20261106T110000Z'), vevent('UID:bad', 'DTSTART:whenever')), NOVEMBER)).toMatchObject({ incomplete: false });
    // An unreadable exclusion list is dropped, not the series: that only adds busy time.
    const exdate = parseIcsDetailed(calendar(vevent('UID:weekly', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE:not a date')), NOVEMBER);
    expect(exdate.busy).toHaveLength(3);
    expect(exdate).toMatchObject({ skipped: 1, incomplete: false });
  });

  it('marks the answer incomplete when walking a busy series fails half way', () => {
    const spy = vi.spyOn(ICAL.RecurExpansion.prototype, 'next').mockImplementation(() => {
      throw new Error('broken rule');
    });
    try {
      const result = parseIcsDetailed(calendar(vevent('UID:weekly', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY')), NOVEMBER);
      expect(result.busy).toEqual([iv('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z')]);
      expect(result).toMatchObject({ skipped: 1, incomplete: true });
      const free = parseIcsDetailed(calendar(vevent('UID:weekly', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY', 'TRANSP:TRANSPARENT')), NOVEMBER);
      expect(free).toMatchObject({ busy: [], incomplete: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('salvages events from a feed the strict parser rejects as a whole', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      TZ_NEW_YORK,
      'BEGIN:VEVENT',
      'UID:with-garbage',
      'this line is not a property',
      'DTSTART;TZID=America/New_York:20261103T100000',
      'DTEND;TZID=America/New_York:20261103T110000',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'another broken line inside the alarm',
      'END:VALARM',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:broken-parameter',
      'DTSTART;TZID:20261104T100000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:fine',
      'DTSTART:20261105T100000Z',
      'DTEND:20261105T103000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cut-off-by-a-truncated-download',
      'DTSTART:20261106T100000Z',
    ].join('\r\n');
    const result = parseIcsDetailed(text, NOVEMBER);
    expect(result.busy).toEqual([iv('2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'), iv('2026-11-05T10:00:00Z', '2026-11-05T10:30:00Z')]);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });

  it('stops at a rule that is too dense and says so', () => {
    const text = calendar(
      vevent('UID:normal', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'),
      vevent('UID:every-minute', 'DTSTART:20200101T000000Z', 'DTEND:20200101T000030Z', 'RRULE:FREQ=MINUTELY'),
    );
    const result = parseIcsDetailed(text, NOVEMBER);
    expect(result.truncated).toBe(true);
    expect(result.busy).toContainEqual(iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'));
    expect(() => parseIcsBusy(text, NOVEMBER)).not.toThrow();
  });

  it('refuses to parse absurdly large input', () => {
    const result = parseIcsDetailed(`${calendar(vevent('UID:1', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'))}${' '.repeat(6_000_001)}`, NOVEMBER);
    expect(result).toMatchObject({ busy: [], truncated: true });
  });
});

describe('mergeBusy', () => {
  it('sorts, joins and drops empty intervals', () => {
    expect(
      mergeBusy([
        { start: 50, end: 60 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
        { start: 15, end: 18 },
        { start: 40, end: 40 },
        { start: 70, end: 65 },
        { start: Number.NaN, end: 5 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 50, end: 60 },
    ]);
    expect(mergeBusy([])).toEqual([]);
  });
});

// ───────────────────────── fetching ─────────────────────────

interface FeedCall {
  url: string;
  init: Parameters<typeof fetch>[1];
}

function feedFetch(handler: (url: string, index: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: FeedCall[] } {
  const calls: FeedCall[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

const FEED = calendar(vevent('UID:1', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'), vevent('UID:2', 'DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118'));
const FEED_URL = 'https://calendar.example.org/private/SECRET-FEED-KEY/basic.ics';

function icsResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers } });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('fetchIcsBusy', () => {
  it('downloads the feed without following redirects automatically and parses it', async () => {
    const net = feedFetch(() => icsResponse(FEED));
    const ctx = makeTestCtx({ fetch: net.fetch });
    const busy = await fetchIcsBusy(ctx, FEED_URL, NOVEMBER, { timezone: 'Africa/Nairobi' });
    expect(busy).toEqual([iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'), iv('2026-11-16T21:00:00Z', '2026-11-17T21:00:00Z')]);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(FEED_URL);
    expect(net.calls[0].init?.redirect).toBe('manual');
    expect(net.calls[0].init?.method).toBe('GET');
    expect(net.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(net.calls[0].init?.headers).has('authorization')).toBe(false);
  });

  it('turns webcal into https', async () => {
    const net = feedFetch(() => icsResponse(FEED));
    await fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), 'webcal://calendar.example.org/feed.ics', NOVEMBER);
    expect(net.calls[0].url).toBe('https://calendar.example.org/feed.ics');
  });

  it('follows safe redirects, relative ones included, checking every hop', async () => {
    const net = feedFetch((_url, index) => {
      if (index === 0) return redirectTo('https://cdn.example.net/feeds/a.ics', 301);
      if (index === 1) return redirectTo('/feeds/b.ics', 307);
      return icsResponse(FEED);
    });
    const busy = await fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER);
    expect(busy).toHaveLength(2);
    expect(net.calls.map((c) => c.url)).toEqual([FEED_URL, 'https://cdn.example.net/feeds/a.ics', 'https://cdn.example.net/feeds/b.ics']);
    expect(net.calls.every((c) => c.init?.redirect === 'manual')).toBe(true);
  });

  it.each([
    ['plain http', 'http://calendar.example.org/basic.ics'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/iam/'],
    ['loopback', 'https://127.0.0.1:443/admin'],
    ['localhost', 'https://localhost/secret'],
    ['an internal name', 'https://db.internal/dump'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['another port', 'https://calendar.example.org:6379/'],
    ['an address with credentials', 'https://a:b@calendar.example.org/'],
    ['a file', 'file:///etc/passwd'],
  ])('refuses a redirect to %s and never requests it', async (_name, location) => {
    const net = feedFetch((_url, index) => (index === 0 ? redirectTo(location) : icsResponse(FEED)));
    const err = await fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcsFeedError);
    expect((err as Error).message).toMatch(/not allowed/);
    expect(net.calls).toHaveLength(1);
  });

  it('gives up after too many redirects', async () => {
    const net = feedFetch((_url, index) => redirectTo(`https://calendar.example.org/hop-${index + 1}`));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toThrow(/too many times/);
    expect(net.calls).toHaveLength(6);
  });

  it('refuses a redirect without a destination', async () => {
    const net = feedFetch(() => new Response(null, { status: 302 }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toBeInstanceOf(IcsFeedError);
  });

  it('refuses an unsafe address before any request', async () => {
    const net = feedFetch(() => icsResponse(FEED));
    const ctx = makeTestCtx({ fetch: net.fetch });
    await expect(fetchIcsBusy(ctx, 'https://192.168.1.10/feed.ics', NOVEMBER)).rejects.toBeInstanceOf(HttpError);
    await expect(fetchIcsBusy(ctx, 'http://calendar.example.org/feed.ics', NOVEMBER)).rejects.toBeInstanceOf(HttpError);
    expect(net.calls).toHaveLength(0);
  });

  it.each([401, 403, 404, 500, 503])('fails on HTTP %i', async (status) => {
    const net = feedFetch(() => new Response('nope', { status }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toBeInstanceOf(IcsFeedError);
  });

  it('does not mistake a page that is not a calendar for an empty calendar', async () => {
    const net = feedFetch(() => new Response('<html><body>Please sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toThrow(/did not return a calendar/);
  });

  it('accepts an empty calendar as "nothing booked"', async () => {
    const net = feedFetch(() => icsResponse(calendar()));
    expect(await fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).toEqual([]);
  });

  it('rejects a feed whose declared size is over the limit without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode('X'.repeat(1024)));
      },
    });
    const net = feedFetch(() => new Response(body, { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toThrow(/larger than 5 MB/);
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it('stops reading a feed that turns out to be over the limit', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`BEGIN:VCALENDAR\r\n${'X-PADDING:1\r\n'.repeat(70)}`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk); // endless
      },
    });
    const net = feedFetch(() => new Response(body, { status: 200 }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER, { maxBytes: 64 * 1024 })).rejects.toThrow(/larger than/);
    expect(pulled * chunk.byteLength).toBeLessThan(200 * 1024);
  });

  it('gives up on a server that does not answer in time', async () => {
    let aborted = false;
    const net = feedFetch(
      (_url) =>
        new Promise<Response>(() => {
          // never answers
        }),
    );
    const slowFetch: typeof fetch = (input, init) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return net.fetch(input, init);
    };
    await expect(fetchIcsBusy(makeTestCtx({ fetch: slowFetch }), FEED_URL, NOVEMBER, { timeoutMs: 40 })).rejects.toThrow(/took too long/);
    expect(aborted).toBe(true);
  });

  it('gives up on a body that stalls', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n'));
        // and then nothing, forever
      },
    });
    const net = feedFetch(() => new Response(body, { status: 200 }));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER, { timeoutMs: 40 })).rejects.toThrow(/took too long/);
  });

  it('reports a network failure without leaking the feed address', async () => {
    const net = feedFetch(() => {
      throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND for ${FEED_URL}`);
    });
    const ctx = makeTestCtx({ fetch: net.fetch });
    const err = await fetchIcsBusy(ctx, FEED_URL, NOVEMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcsFeedError);
    expect((err as Error).message).not.toContain('SECRET-FEED-KEY');
    expect((err as Error).message).not.toContain('calendar.example.org');
    expect(JSON.stringify(ctx.logs)).not.toContain('SECRET-FEED-KEY');
  });

  it('fails instead of returning half an answer when a feed is too dense to expand', async () => {
    const dense = calendar(vevent('UID:every-minute', 'DTSTART:20200101T000000Z', 'DTEND:20200101T000030Z', 'RRULE:FREQ=MINUTELY'));
    const net = feedFetch(() => icsResponse(dense));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toThrow(/too large/);
  });

  it('fails instead of reading a busy series it could not expand as free', async () => {
    const lost = calendar(vevent('UID:series', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;BYDAY=XX'));
    const net = feedFetch(() => icsResponse(lost));
    await expect(fetchIcsBusy(makeTestCtx({ fetch: net.fetch }), FEED_URL, NOVEMBER)).rejects.toThrow(/repeating event that could not be read/);
  });

  it('logs how many events were unreadable, never the address', async () => {
    const mixed = calendar(vevent('UID:good', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z'), vevent('UID:bad', 'DTSTART:whenever'));
    const net = feedFetch(() => icsResponse(mixed));
    const ctx = makeTestCtx({ fetch: net.fetch });
    expect(await fetchIcsBusy(ctx, FEED_URL, NOVEMBER)).toEqual([iv('2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z')]);
    expect(ctx.logs).toHaveLength(1);
    expect(ctx.logs[0]).toMatchObject({ level: 'warn', data: { skipped: 1, events: 2 } });
    expect(JSON.stringify(ctx.logs)).not.toContain('SECRET-FEED-KEY');
  });
});
