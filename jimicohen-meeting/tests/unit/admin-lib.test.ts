/**
 * Direct tests of the small helpers under server/lib/admin. The routes that use them are
 * covered in admin-routes.test.ts, host-routes.test.ts and google-routes.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/lib/booking', async () => {
  const { hmacHex } = await import('../../server/lib/crypto');
  return { manageToken: (ctx: never, id: string) => hmacHex(ctx, 'manage', id) };
});

import { cleanPurpose, MAX_ASSET_BYTES, parseImageDataUrl, sniffImageType } from '../../server/lib/admin/assets';
import { countScopes, csvCell, scopeOf, searchTerms, selectEntries, toCsv } from '../../server/lib/admin/bookings';
import { freeSlug, slugify } from '../../server/lib/admin/event-types';
import { assetExists, isWebUrl } from '../../server/lib/admin/fields';
import { parseRanges, parseSchedules, parseWeekly } from '../../server/lib/admin/schedules';
import { cleanCustomCss, compactOverride, mergeTheme } from '../../server/lib/admin/theme';
import { maskMiddle, toAdminHost } from '../../server/lib/admin/view';
import { seal } from '../../server/lib/crypto';
import { HttpError } from '../../server/lib/http';
import { putAsset } from '../../server/lib/repo';
import { FieldErrors } from '../../server/lib/validate';
import { DEFAULT_THEME, defaultOwnerHost } from '../../shared/defaults';
import type { BookingIndexEntry, Host } from '../../shared/types';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

describe('csv', () => {
  it('leaves plain cells alone and quotes the rest', () => {
    expect(csvCell('Sam Rivera')).toBe('Sam Rivera');
    expect(csvCell(30)).toBe('30');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('Rivera, Sam')).toBe('"Rivera, Sam"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('puts an apostrophe in front of anything a spreadsheet would run', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+14155552671')).toBe("'+14155552671");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
    expect(csvCell('=cmd|\' /C calc\'!A0,"x"')).toBe('"\'=cmd|\' /C calc\'!A0,""x"""');
    // Only the first character decides.
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('2026-11-17T12:00:00.000Z')).toBe('2026-11-17T12:00:00.000Z');
  });

  it('joins rows with CRLF and ends with one', () => {
    expect(toCsv([['a', 'b'], [1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

describe('booking selection', () => {
  const now = Date.parse(TEST_NOW);
  const entry = (id: string, startOffsetH: number, over: Partial<BookingIndexEntry> = {}): BookingIndexEntry => ({
    id,
    start: new Date(now + startOffsetH * 3_600_000).toISOString(),
    end: new Date(now + startOffsetH * 3_600_000 + 1_800_000).toISOString(),
    hostIds: ['host_owner'],
    eventTypeId: 'evt_intro',
    status: 'confirmed',
    inviteeName: 'Sam Rivera',
    inviteeEmail: 'sam@example.com',
    eventTitle: 'Intro call',
    ...over,
  });
  const index = [entry('c', 5), entry('a', 1), entry('p1', -30), entry('p2', -3), entry('x', 2, { status: 'cancelled' }), entry('now', -0.25), entry('b', 1)];

  it('sorts each scope the way its tab reads', () => {
    expect(selectEntries(index, 'upcoming', [], now).map((e) => e.id)).toEqual(['now', 'a', 'b', 'c']);
    expect(selectEntries(index, 'past', [], now).map((e) => e.id)).toEqual(['p2', 'p1']);
    expect(selectEntries(index, 'cancelled', [], now).map((e) => e.id)).toEqual(['x']);
    expect(selectEntries(index, 'all', [], now).map((e) => e.id)).toEqual(['c', 'x', 'b', 'a', 'now', 'p2', 'p1']);
    expect(countScopes(index, now)).toEqual({ upcoming: 4, past: 2, cancelled: 1 });
  });

  it('a meeting is upcoming until the moment it ends', () => {
    const e = entry('e', -0.5);
    expect(scopeOf(e, Date.parse(e.end) - 1)).toBe('upcoming');
    expect(scopeOf(e, Date.parse(e.end))).toBe('past');
    expect(scopeOf({ ...e, status: 'cancelled' }, 0)).toBe('cancelled');
  });

  it('splits a search into at most eight lower-case words', () => {
    expect(searchTerms('  Sam   RIVERA ')).toEqual(['sam', 'rivera']);
    expect(searchTerms(null)).toEqual([]);
    expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(searchTerms('x'.repeat(500))[0]).toHaveLength(200);
  });
});

describe('images', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

  it('recognises the four formats by their first bytes', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF87a....', 'latin1'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('GIF89a....', 'latin1'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('decodes a good upload and names the problem of a bad one', () => {
    const parsed = parseImageDataUrl(`data:image/png;base64,${png.toString('base64')}`);
    expect(parsed.contentType).toBe('image/png');
    expect(Buffer.from(parsed.data).equals(png)).toBe(true);
    // Parameters and capitals in the header are fine.
    expect(parseImageDataUrl(`data:IMAGE/PNG;charset=utf-8;base64,${png.toString('base64')}`).contentType).toBe('image/png');

    const failure = (value: unknown): HttpError => {
      try {
        parseImageDataUrl(value);
      } catch (err) {
        return err as HttpError;
      }
      throw new Error('expected a refusal');
    };
    expect(failure(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toMatchObject({ status: 422, fields: { dataUrl: expect.stringMatching(/SVG/) } });
    expect(failure(`data:image/jpeg;base64,${png.toString('base64')}`)).toMatchObject({ status: 422 });
    expect(failure(`data:text/html;base64,${png.toString('base64')}`)).toMatchObject({ status: 422 });
    expect(failure(`data:image/png;base64,${png.toString('base64')}\n`)).toMatchObject({ status: 422 });
    expect(failure(`data:image/png;base64,${png.toString('base64').slice(0, -1)}`)).toMatchObject({ status: 422 });
    expect(failure({ dataUrl: 'x' })).toMatchObject({ status: 422 });
    const big = Buffer.concat([png.subarray(0, 8), Buffer.alloc(MAX_ASSET_BYTES)]);
    expect(failure(`data:image/png;base64,${big.toString('base64')}`)).toMatchObject({ status: 413, code: 'too_large' });
  });

  it('keeps purposes to short plain tags', () => {
    expect(cleanPurpose('host-avatar')).toBe('host-avatar');
    expect(cleanPurpose('Logo')).toBe('image');
    expect(cleanPurpose('a/b')).toBe('image');
    expect(cleanPurpose(undefined)).toBe('image');
  });

  it('checks that an image exists without reading it', async () => {
    const ctx = makeTestCtx();
    const id = await putAsset(ctx, png, 'image/png', 'logo');
    expect(await assetExists(ctx, id)).toBe(true);
    expect(await assetExists(ctx, id.slice(0, -1))).toBe(false);
    expect(await assetExists(ctx, '../site')).toBe(false);
    expect(await assetExists(ctx, null)).toBe(false);
  });
});

describe('hours', () => {
  it('sorts the ranges of a day and accepts midnight as an end', () => {
    const errors = new FieldErrors();
    expect(parseRanges([{ start: '13:00', end: '24:00' }, { start: '08:00', end: '13:00' }], 'p', 'Monday', errors)).toEqual([
      { start: '08:00', end: '13:00' },
      { start: '13:00', end: '24:00' },
    ]);
    expect(parseRanges([], 'p', 'Monday', errors)).toEqual([]);
    expect(errors.has()).toBe(false);
  });

  it.each([
    [[{ start: '09:00', end: '09:00' }], /end after it starts/],
    [[{ start: '09:00', end: '12:00' }, { start: '11:59', end: '13:00' }], /overlap/],
    [[{ start: '9:00', end: '12:00' }], /09:00/],
    [[{ start: '09:00', end: '25:00' }], /09:00/],
    [[{ start: '09:00' }], /09:00/],
    [['09:00-12:00'], /09:00/],
    ['09:00-12:00', /missing/],
  ])('refuses %j', (ranges, message) => {
    const errors = new FieldErrors();
    expect(parseRanges(ranges, 'weekly.1', 'Working hours, Monday', errors)).toBeNull();
    expect(errors.toJSON()['weekly.1']).toMatch(message);
    expect(errors.toJSON()['weekly.1'].startsWith('Working hours, Monday: ')).toBe(true);
  });

  it('fills in missing weekdays and accepts a list of seven days', () => {
    const errors = new FieldErrors();
    expect(parseWeekly({ 3: [{ start: '09:00', end: '10:00' }] }, 'w', 'Hours', errors)).toEqual({ 0: [], 1: [], 2: [], 3: [{ start: '09:00', end: '10:00' }], 4: [], 5: [], 6: [] });
    expect(parseWeekly([[], [{ start: '09:00', end: '10:00' }], [], [], [], [], []], 'w', 'Hours', errors)?.[1]).toEqual([{ start: '09:00', end: '10:00' }]);
    expect(errors.has()).toBe(false);
    expect(parseWeekly('always', 'w', 'Hours', errors)).toBeNull();
  });

  it('accepts exactly 12 ranges a day and 366 overrides', () => {
    const errors = new FieldErrors();
    const twelve = Array.from({ length: 12 }, (_, i) => ({ start: `${String(i + 8).padStart(2, '0')}:00`, end: `${String(i + 8).padStart(2, '0')}:30` }));
    const overrides = Array.from({ length: 366 }, (_, i) => ({ date: new Date(Date.UTC(2028, 0, 1 + i)).toISOString().slice(0, 10), ranges: [] }));
    const parsed = parseSchedules([{ id: 'sch_1', name: 'Full', weekly: { 1: twelve }, overrides }], errors);
    expect(errors.toJSON()).toEqual({});
    expect(parsed?.[0].weekly[1]).toHaveLength(12);
    expect(parsed?.[0].overrides).toHaveLength(366);
  });
});

describe('links, slugs, css, masks', () => {
  it('accepts web links and nothing else', () => {
    expect(isWebUrl('https://jimicohen.com/about')).toBe(true);
    expect(isWebUrl('http://jimicohen.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', '//example.com', 'jimicohen.com', 'https://user:pw@example.com', 'https://exa mple.com', '', null, 42]) {
      expect(isWebUrl(bad), String(bad)).toBe(false);
    }
  });

  it('makes links out of titles', () => {
    expect(slugify('  Intro call with Jimi! ')).toBe('intro-call-with-jimi');
    expect(slugify('Café crème ☕')).toBe('cafe-creme');
    expect(slugify('会议')).toBe('');
    expect(slugify('x'.repeat(100))).toHaveLength(60);
    expect(slugify(`${'x'.repeat(59)} y`)).toBe('x'.repeat(59));
  });

  it('finds a link that is free and not reserved', () => {
    expect(freeSlug('Intro', new Set())).toBe('intro');
    expect(freeSlug('Intro', new Set(['intro', 'intro-2']))).toBe('intro-3');
    expect(freeSlug('Admin', new Set())).toBe('admin-2');
    expect(freeSlug('Booking', new Set(['booking-2']))).toBe('booking-3');
    expect(freeSlug('会议', new Set(['meeting']))).toBe('meeting-2');
    const long = freeSlug('y'.repeat(80), new Set(['y'.repeat(60)]));
    expect(long).toBe(`${'y'.repeat(58)}-2`);
  });

  it('strips anything that could close the style element, however it is spelled', () => {
    for (const css of ['</style>', '< / STYLE >', '</sty</stylele>', '<<//ssttyyllee>', '</style\n>', '.a{}</style><img src=x onerror=alert(1)>']) {
      const out = cleanCustomCss(css).toLowerCase();
      expect(out, css).not.toMatch(/<\s*\/\s*style/);
      expect(out, css).not.toContain('<img');
    }
    expect(cleanCustomCss('.card { border-radius: 4px; }')).toBe('.card { border-radius: 4px; }');
  });

  it('merges a theme patch group by group', () => {
    const merged = mergeTheme(DEFAULT_THEME, { colors: { primary: '#000000' }, darkColors: { background: '#111111' }, texts: { ctaLabel: 'Go' }, radius: 4 });
    expect(merged.colors).toEqual({ ...DEFAULT_THEME.colors, primary: '#000000' });
    // Dark colours that did not exist yet start from the (merged) light ones.
    expect(merged.darkColors).toEqual({ ...DEFAULT_THEME.colors, primary: '#000000', background: '#111111' });
    expect(merged.texts.ctaLabel).toBe('Go');
    expect(merged.texts.pickTimeLabel).toBe(DEFAULT_THEME.texts.pickTimeLabel);
    expect(merged.radius).toBe(4);
    expect(mergeTheme(merged, { darkColors: null }).darkColors).toBeNull();
    expect(mergeTheme(DEFAULT_THEME, {})).toEqual(DEFAULT_THEME);
  });

  it('stores an empty override as nothing', () => {
    expect(compactOverride({})).toBeNull();
    expect(compactOverride({ colors: {}, texts: {} })).toBeNull();
    expect(compactOverride({ layout: 'stacked', colors: {}, darkColors: null })).toEqual({ layout: 'stacked', darkColors: null });
  });

  it('masks identifiers, and short ones completely', () => {
    expect(maskMiddle('AC' + '0123456789abcdef'.repeat(2))).toBe('AC01…cdef');
    expect(maskMiddle('short')).toBe('••••');
    expect(maskMiddle('1234567890')).toBe('••••');
    expect(maskMiddle('')).toBe('••••');
  });

  it('turns a stored host into what the screens may see', () => {
    const ctx = makeTestCtx();
    const host: Host = {
      ...defaultOwnerHost(TEST_NOW, 'Africa/Nairobi'),
      email: 'jimi@example.com',
      phone: '+14155552671',
      avatarAssetId: 'ast_abcdefghijklmnop',
      inviteTokenHash: 'a'.repeat(64),
      icsFeeds: [{ id: 'ics_1', label: 'Work', urlEnc: seal(ctx, 'ics-url', 'https://calendar.example.com/secret.ics') }],
      google: { email: 'jimi@gmail.example', refreshTokenEnc: seal(ctx, 'google-refresh', 'rt'), scopes: ['a'], busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: true, status: 'ok', connectedAt: TEST_NOW },
    };
    const view = toAdminHost(ctx, host);
    expect(Object.keys(view).sort()).toEqual(
      ['avatarAssetId', 'avatarUrl', 'calendarHealth', 'defaultScheduleId', 'email', 'google', 'hasInviteLink', 'icsFeeds', 'id', 'name', 'notify', 'phone', 'role', 'schedules', 'timezone', 'timezoneMode', 'title'].sort(),
    );
    expect(view.avatarUrl).toBe('/meeting/api/assets/ast_abcdefghijklmnop');
    expect(view.hasInviteLink).toBe(true);
    expect(view.icsFeeds).toEqual([{ id: 'ics_1', label: 'Work' }]);
    expect(Object.keys(view.google!).sort()).toEqual(['busyCalendarIds', 'email', 'gmailSend', 'status', 'writeCalendarId']);
    expect(toAdminHost(ctx, { ...host, inviteTokenHash: null, google: null, phone: undefined })).toMatchObject({ hasInviteLink: false, google: null });
  });
});
