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
import { calendarBeingRemoved, countScopes, csvCell, eraseRefusal, scopeOf, searchTerms, selectEntries, toCsv } from '../../server/lib/admin/bookings';
import { freeSlug, slugify } from '../../server/lib/admin/event-types';
import { assetExists, isWebUrl } from '../../server/lib/admin/fields';
import { parseRanges, parseSchedules, parseWeekly } from '../../server/lib/admin/schedules';
import { cleanCustomCss, compactOverride, mergeTheme } from '../../server/lib/admin/theme';
import { checkSharedHours } from '../../server/lib/admin/overview';
import { maskMiddle, toAdminHost } from '../../server/lib/admin/view';
import { seal } from '../../server/lib/crypto';
import { HttpError } from '../../server/lib/http';
import { putAsset, putJob } from '../../server/lib/repo';
import { FieldErrors } from '../../server/lib/validate';
import { CALENDAR_PENDING, calendarEventLeft } from '../../shared/calendar';
import { DEFAULT_THEME, defaultOwnerHost, newEventType } from '../../shared/defaults';
import type { AdminHost, Booking, BookingIndexEntry, EventType, Host, Job } from '../../shared/types';
import { hostGap, unreachableHosts } from '../../src/admin/components/event/reach';
import { askSharedHours, currentAnswer, sharedHoursKey } from '../../src/admin/components/event/sharedHours';
import { describeTimelineDetail } from '../../src/admin/format';
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
      ['avatarAssetId', 'avatarUrl', 'calendarHealth', 'defaultScheduleId', 'email', 'google', 'googleExtra', 'hasInviteLink', 'icsFeeds', 'id', 'name', 'notify', 'phone', 'role', 'schedules', 'timezone', 'timezoneMode', 'title'].sort(),
    );
    expect(view.avatarUrl).toBe('/meeting/api/assets/ast_abcdefghijklmnop');
    expect(view.hasInviteLink).toBe(true);
    expect(view.icsFeeds).toEqual([{ id: 'ics_1', label: 'Work' }]);
    // The id and health are there for the per-account screens; never the token, the scopes or Google's account id.
    expect(Object.keys(view.google!).sort()).toEqual(['busyCalendarIds', 'connectedAt', 'email', 'gmailSend', 'health', 'id', 'status', 'writeCalendarId']);
    expect(view.googleExtra).toEqual([]);
    expect(toAdminHost(ctx, { ...host, inviteTokenHash: null, google: null, phone: undefined })).toMatchObject({ hasInviteLink: false, google: null });
  });
});

describe('joint meeting hours', () => {
  const owner: Host = { ...defaultOwnerHost(TEST_NOW, 'America/Los_Angeles'), email: 'jimi@example.com' };
  const coHost = (id: string, name: string, timezone: string, patch: Partial<Host> = {}): Host => ({ ...defaultOwnerHost(TEST_NOW, timezone), id, role: 'member', name, email: `${id}@example.com`, ...patch });
  const joint = (hostIds: string[], patch: Partial<EventType> = {}): EventType => ({ ...newEventType(TEST_NOW, { id: 'evt_joint', slug: 'joint', title: 'Together', hostIds }), kind: 'collective', ...patch });
  const nowMs = Date.parse(TEST_NOW);

  it('passes when the hours meet, and for every other kind of meeting', () => {
    const alex = coHost('host_alex', 'Alex Rivera', 'America/New_York');
    expect(checkSharedHours({ eventType: joint([owner.id, alex.id]), hosts: [owner, alex], owner, nowMs })).toEqual({ ok: true });
    const berlin = coHost('host_alex', 'Alex Rivera', 'Europe/Berlin');
    expect(checkSharedHours({ eventType: joint([owner.id, berlin.id], { kind: 'round_robin' }), hosts: [owner, berlin], owner, nowMs })).toEqual({ ok: true });
    // Someone no longer on the team is a problem the editor reports itself.
    expect(checkSharedHours({ eventType: joint([owner.id, 'host_gone']), hosts: [owner], owner, nowMs })).toEqual({ ok: true });
    // Dates that are over leave nothing to check.
    expect(checkSharedHours({ eventType: joint([owner.id, berlin.id], { scheduling: { ...joint([]).scheduling, dateRange: { start: '2026-01-05', end: '2026-01-09' } } }), hosts: [owner, berlin], owner, nowMs })).toEqual({ ok: true });
  });

  it('says why nobody can book a joint meeting, by name and zone', () => {
    const berlin = coHost('host_alex', 'Alex Rivera', 'Europe/Berlin');
    const sam = coHost('host_sam', 'Sam Lee', 'Asia/Tokyo');
    const three = checkSharedHours({ eventType: joint([owner.id, berlin.id, sam.id]), hosts: [owner, berlin, sam], owner, nowMs });
    expect(three).toEqual({
      ok: false,
      reason: 'no_overlap',
      message:
        '"Together" cannot be booked: there is no time when you, Alex and Sam are all working. Your hours are in Los Angeles time, Alex\'s hours are in Berlin time and Sam\'s hours are in Tokyo time. Change your hours under Availability, or ask Alex and Sam to change theirs on their private pages.',
      href: '/admin/availability',
    });
    for (const text of [three.message ?? '']) expect(text).not.toContain('—');

    // Two co-hosts without the owner: only they can fix it.
    const apart = checkSharedHours({ eventType: joint([berlin.id, coHost('host_la', 'Lee Park', 'America/Los_Angeles').id]), hosts: [owner, berlin, coHost('host_la', 'Lee Park', 'America/Los_Angeles')], owner, nowMs });
    expect(apart).toMatchObject({ ok: false, reason: 'no_overlap', href: '/admin/team' });
    expect(apart.message).toContain('Ask Alex and Lee to change their hours on their private pages.');

    // The owner has no hours at all.
    const idle = { ...owner, schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, overrides: [] }] };
    const alex = coHost('host_alex', 'Alex Rivera', 'America/Los_Angeles');
    expect(checkSharedHours({ eventType: joint([idle.id, alex.id]), hosts: [idle, alex], owner: idle, nowMs })).toEqual({
      ok: false,
      reason: 'no_hours',
      message: '"Together" cannot be booked: you have no working hours for it in the next 60 days. Set your hours under Availability.',
      href: '/admin/availability',
    });
  });

  it('tells hours that meet too briefly apart from hours that never meet, and names the fixed dates', () => {
    // Los Angeles and New York share five working hours a day: a 6 hour meeting never fits in them.
    const ny = coHost('host_sam', 'Sam Lee', 'America/New_York');
    const long = checkSharedHours({ eventType: joint([owner.id, ny.id], { durations: [360, 480], defaultDuration: 360 }), hosts: [owner, ny], owner, nowMs });
    expect(long).toMatchObject({ ok: false, reason: 'no_overlap', href: '/admin/availability' });
    expect(long.message).toBe(
      '"Together" cannot be booked: the times when you and Sam are both working are never as long as its shortest length, 6 hours. Your hours are in Los Angeles time and Sam\'s hours are in New York time. Change your hours under Availability, or ask Sam to change theirs on their private page.',
    );
    // A length that fits is fine.
    expect(checkSharedHours({ eventType: joint([owner.id, ny.id], { durations: [240], defaultDuration: 240 }), hosts: [owner, ny], owner, nowMs })).toEqual({ ok: true });

    // Fixed dates on a weekend: the dates are part of the answer, so the message says so.
    const weekend = joint([owner.id, ny.id], { scheduling: { ...joint([]).scheduling, dateRange: { start: '2026-12-05', end: '2026-12-06' } } });
    expect(checkSharedHours({ eventType: weekend, hosts: [owner, ny], owner, nowMs }).message).toBe(
      '"Together" cannot be booked: you and Sam have no working hours for it on the dates it can be booked. Set your hours under Availability, and ask Sam to set theirs on their private page. The dates on its Scheduling tab count too.',
    );
  });

  describe('in the editor (Hosts and Scheduling tabs)', () => {
    const asAdmin = (h: Host): AdminHost => toAdminHost(makeTestCtx(), h);
    const alex = coHost('host_alex', 'Alex Rivera', 'Europe/Berlin');
    const sam = coHost('host_sam', 'Sam Lee', 'Asia/Tokyo');
    const team = [owner, alex, sam].map(asAdmin);
    const draft = joint([owner.id, alex.id]);
    const NO_OVERLAP = { ok: false, reason: 'no_overlap', message: '"Together" cannot be booked.', href: '/admin/availability' } as const;
    const AFTERNOONS = { 0: [], 1: [{ start: '13:00', end: '17:00' }], 2: [], 3: [], 4: [], 5: [], 6: [] };

    it('asks again for a change on either tab, and only for a joint meeting', () => {
      const key = sharedHoursKey(draft, team);
      expect(key).not.toBe('');
      // Nothing to check for one host, or for any other kind of meeting.
      expect(sharedHoursKey({ ...draft, hostIds: [owner.id] }, team)).toBe('');
      expect(sharedHoursKey({ ...draft, kind: 'round_robin' }, team)).toBe('');
      expect(sharedHoursKey({ ...draft, kind: 'solo' }, team)).toBe('');
      // The Scheduling tab: limited hours, fixed dates, another schedule for a host.
      expect(sharedHoursKey({ ...draft, scheduling: { ...draft.scheduling, restrictHours: AFTERNOONS } }, team)).not.toBe(key);
      expect(sharedHoursKey({ ...draft, scheduling: { ...draft.scheduling, dateRange: { start: '2026-12-05', end: '2026-12-06' } } }, team)).not.toBe(key);
      expect(sharedHoursKey({ ...draft, scheduling: { ...draft.scheduling, scheduleIds: { host_alex: 'sch_evenings' } } }, team)).not.toBe(key);
      // The Hosts tab, and the lengths.
      expect(sharedHoursKey({ ...draft, hostIds: [owner.id, sam.id] }, team)).not.toBe(key);
      expect(sharedHoursKey({ ...draft, durations: [60] }, team)).not.toBe(key);
      // A chosen host's own zone moved (another page, a refresh). Somebody who is not on the meeting does not count, nor does the title.
      expect(sharedHoursKey(draft, [owner, { ...alex, timezone: 'America/New_York' }, sam].map(asAdmin))).not.toBe(key);
      expect(sharedHoursKey(draft, [owner, alex, { ...sam, timezone: 'UTC' }].map(asAdmin))).toBe(key);
      expect(sharedHoursKey({ ...draft, title: 'A new name' }, team)).toBe(key);
    });

    it('never shows an answer about the draft as it was before an edit', () => {
      const before = sharedHoursKey(draft, team);
      const after = sharedHoursKey({ ...draft, scheduling: { ...draft.scheduling, restrictHours: AFTERNOONS } }, team);
      const held = { key: before, answer: NO_OVERLAP };
      expect(currentAnswer(before, held)).toEqual(NO_OVERLAP);
      // The edit starts a new check: the old warning goes at once, and nothing is shown until the new answer is in.
      expect(currentAnswer(after, held)).toBeNull();
      expect(currentAnswer(after, { key: after, answer: { ok: true } })).toEqual({ ok: true });
      // No longer a joint meeting: nothing at all.
      expect(currentAnswer('', held)).toBeNull();
      expect(currentAnswer(before, null)).toBeNull();
    });

    it('says the check could not run when it fails, and nothing when the draft moved on in the meantime', async () => {
      const sent: unknown[] = [];
      const answered = await askSharedHours(draft, async (body) => {
        sent.push(body);
        return NO_OVERLAP;
      }, new AbortController().signal);
      expect(answered).toEqual(NO_OVERLAP);
      // Only what decides when people can be booked, and the title for the message.
      expect(Object.keys(sent[0] as object).sort()).toEqual(['durations', 'hostIds', 'id', 'kind', 'scheduling', 'title']);

      // The server or the network failed: that is said, so the notice of an earlier answer does not stay.
      const offline = async (): Promise<never> => {
        throw new Error('Could not reach the server.');
      };
      expect(await askSharedHours(draft, offline, new AbortController().signal)).toBe('failed');
      // Called off because the draft changed again: neither an answer nor a failure.
      const called = new AbortController();
      expect(
        await askSharedHours(draft, async (_body, { signal }) => {
          called.abort();
          if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
          return NO_OVERLAP;
        }, called.signal),
      ).toBeNull();
      const late = new AbortController();
      expect(
        await askSharedHours(draft, async () => {
          late.abort();
          return NO_OVERLAP;
        }, late.signal),
      ).toBeNull();
    });
  });
});

describe('reminders to the hosts', () => {
  const adminHost = (id: string, name: string, patch: Partial<AdminHost> = {}): AdminHost => ({
    ...toAdminHost(makeTestCtx(), { ...defaultOwnerHost(TEST_NOW), id, role: id === 'host_owner' ? 'owner' : 'member', name, email: `${id}@example.com` }),
    ...patch,
  });

  it('knows who a text or an email to the hosts does not reach', () => {
    const owner = adminHost('host_owner', 'Jimi Cohen');
    const alex = adminHost('host_alex', 'Alex Rivera', { phone: '+14155552671', notify: { email: true, sms: true } });
    const sam = adminHost('host_sam', 'Sam Lee', { phone: '+14155552672', notify: { email: false, sms: false } });
    expect(unreachableHosts('sms', [owner, alex, sam]).map((h) => h.id)).toEqual(['host_owner', 'host_sam']);
    expect(unreachableHosts('email', [owner, alex, sam]).map((h) => h.id)).toEqual(['host_sam']);
    expect(unreachableHosts('email', [{ ...owner, email: '' }]).map((h) => h.id)).toEqual(['host_owner']);
    expect(unreachableHosts('call', [owner])).toEqual([]);
  });

  it('says so, and where it is fixed', () => {
    const owner = adminHost('host_owner', 'Jimi Cohen');
    const alex = adminHost('host_alex', 'Alex Rivera');
    expect(hostGap('sms', [], 'host_owner')).toBeNull();
    expect(hostGap('sms', [owner], 'host_owner')).toEqual({
      text: 'You have no mobile number saved, so this text does not reach you. Add it under Settings, next to where your booking notices go.',
      short: 'Does not reach you yet',
      href: '/admin/settings#notices',
      place: 'Open Settings',
    });
    expect(hostGap('sms', [alex], 'host_owner')).toMatchObject({ short: 'Does not reach Alex yet', href: '/admin/team', place: 'Open Team' });
    expect(hostGap('email', [owner, alex], 'host_owner')).toMatchObject({ short: 'Does not reach you and Alex yet', href: '/admin/settings#notices' });
    for (const gap of [hostGap('sms', [owner], 'host_owner'), hostGap('sms', [alex], 'host_owner'), hostGap('email', [owner, alex], 'host_owner')]) expect(gap!.text).not.toContain('—');
  });

  it('says what is actually missing: the number or address, or only the switch', () => {
    const owner = adminHost('host_owner', 'Jimi Cohen');
    const alex = adminHost('host_alex', 'Alex Rivera');
    const withNumber = (h: AdminHost): AdminHost => ({ ...h, phone: '+14155552671', notify: { ...h.notify, sms: false } });
    // The address for booking notices is the very field to fill in, not something "next to" it.
    expect(hostGap('email', [{ ...owner, email: '' }], 'host_owner')!.text).toBe(
      'You have no email address saved, so this email does not reach you. Add the address for your booking notices under Settings.',
    );
    // A number is saved, only the texts are off: nothing needs adding.
    expect(hostGap('sms', [withNumber(owner)], 'host_owner')!.text).toBe(
      'You have texts about bookings switched off, so this text does not reach you. Switch texts on under Settings, next to where your booking notices go.',
    );
    expect(hostGap('sms', [withNumber(alex)], 'host_owner')!.text).toBe(
      'Alex has texts about bookings switched off, so this text does not reach them. Switch their texts on in their details on the Team page, or ask them to on their private page.',
    );
    // A co-host's email switch is only on their own page.
    expect(hostGap('email', [{ ...alex, notify: { email: false, sms: false } }], 'host_owner')!.text).toBe(
      'Alex has emails about bookings switched off, so this email does not reach them. Ask them to switch emails about bookings on, on their private page.',
    );
    // Several people, for different reasons.
    const sam = adminHost('host_sam', 'Sam Lee');
    expect(hostGap('sms', [withNumber(alex), sam], 'host_owner')!.text).toBe(
      'Alex and Sam have no mobile number saved, or texts switched off, so this text does not reach those hosts. Add what is missing in their details on the Team page, or ask them to on their private page.',
    );
  });
});

describe('booking timeline wording', () => {
  it('names the service that carried a message the way people know it', () => {
    expect(describeTimelineDetail('to sam@example.com via resend')).toBe('to sam@example.com via Resend');
    expect(describeTimelineDetail('to sam@example.com via gmail')).toBe('to sam@example.com via Gmail');
    expect(describeTimelineDetail('to +14155552671 via twilio')).toBe('to +14155552671 via Twilio');
    expect(describeTimelineDetail('via mock')).toBe('via the test outbox');
    expect(describeTimelineDetail('to jimi@example.com via mock. Twilio did not confirm it in time.')).toBe('to jimi@example.com via the test outbox. Twilio did not confirm it in time.');
    // Anything else is left alone.
    expect(describeTimelineDetail('Booked through an embedded page')).toBe('Booked through an embedded page');
    expect(describeTimelineDetail('via mockingbird lane')).toBe('via mockingbird lane');
  });
});

describe('deleting a booking', () => {
  const at = Date.parse(TEST_NOW);
  const booking = (patch: Partial<Booking>): Booking =>
    ({
      id: 'bk_1',
      status: 'confirmed',
      start: new Date(at + 3_600_000).toISOString(),
      end: new Date(at + 5_400_000).toISOString(),
      google: null,
      timeline: [],
      ...patch,
    }) as Booking;
  const job = (patch: Partial<Job>): Job => ({ key: 'jobs/x', id: 'job_x', type: 'message', bookingId: 'bk_1', dueAt: TEST_NOW, attempt: 0, createdAt: TEST_NOW, ...patch });

  it('only lets go of what is over or cancelled and finished', () => {
    expect(eraseRefusal(booking({}), [], at)?.code).toBe('upcoming');
    expect(eraseRefusal(booking({ start: new Date(at - 60_000).toISOString() }), [], at)?.code).toBe('in_progress');
    expect(eraseRefusal(booking({ start: new Date(at - 7_200_000).toISOString(), end: new Date(at - 3_600_000).toISOString() }), [job({ kind: 'followup' })], at)).toBeNull();
    // Cancelled and still ahead: only once the cancellation is done.
    const cancelled = booking({ status: 'cancelled' });
    expect(eraseRefusal(cancelled, [], at)).toBeNull();
    expect(eraseRefusal(cancelled, [job({ kind: 'reminder' })], at)).toBeNull();
    expect(eraseRefusal(cancelled, [job({ kind: 'cancelled' })], at)?.code).toBe('still_cancelling');
    expect(eraseRefusal(cancelled, [job({ type: 'gcal_sync' })], at)?.code).toBe('still_cancelling');
    expect(eraseRefusal({ ...cancelled, followUp: { kind: 'cancelled', id: 'f', at: TEST_NOW } }, [], at)?.code).toBe('still_cancelling');
    const stuck = { ...cancelled, google: { hostId: 'h', calendarId: 'primary', eventId: 'e', error: 'Google Calendar did not answer in time. Trying again shortly.' } };
    const left = eraseRefusal(stuck, [], at);
    expect(left?.code).toBe('calendar_event_left');
    expect(left?.message).toContain('Google Calendar did not answer in time.');
    expect(left?.message).not.toContain('—');
    // The calendar retry queued for that event is the same trouble, which the owner may choose to leave: not "still cancelling".
    expect(eraseRefusal(stuck, [job({ type: 'gcal_sync' })], at)?.code).toBe('calendar_event_left');
    // Telling people is not something to skip, event or not.
    expect(eraseRefusal(stuck, [job({ kind: 'cancelled' })], at)?.code).toBe('still_cancelling');
    // Google was disconnected: the error is gone, the event is not.
    const leftThere = { at: TEST_NOW, type: 'calendar_event_left', detail: 'Google Calendar is no longer connected, so the event was not removed.' };
    const disconnected = { ...cancelled, google: { hostId: 'h', calendarId: 'primary', eventId: 'e' }, timeline: [leftThere] };
    expect(calendarEventLeft(disconnected)).toBe('Google Calendar is no longer connected, so the event was not removed.');
    expect(eraseRefusal(disconnected, [], at)?.code).toBe('calendar_event_left');
    // Taken off later after all (Google reconnected): nothing is left.
    const removedLater = { ...disconnected, timeline: [leftThere, { at: TEST_NOW, type: 'calendar_event_removed' }] };
    expect(calendarEventLeft(removedLater)).toBeNull();
    expect(eraseRefusal(removedLater, [], at)).toBeNull();
    // An event a round robin move left on a former host's calendar is no longer the booking's (google is null then).
    expect(calendarEventLeft({ ...cancelled, google: null, timeline: [leftThere] })).toBeNull();
    expect(calendarEventLeft({ ...disconnected, status: 'confirmed' })).toBeNull();
    // Cancelled and in the past: whatever is left of the cancellation no longer matters.
    const past = { start: new Date(at - 7_200_000).toISOString(), end: new Date(at - 3_600_000).toISOString() };
    expect(eraseRefusal({ ...cancelled, ...past, followUp: { kind: 'cancelled', id: 'f', at: TEST_NOW } }, [job({ kind: 'cancelled' })], at)).toBeNull();
  });

  it('says a cancelled meeting\'s event is being removed until it is gone, and removed only after', async () => {
    const ctx = makeTestCtx();
    const g = { hostId: 'h', calendarId: 'primary', eventId: 'e' };
    const cancelled = booking({ status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee' } });
    // The cancellation has not reached Google yet (cancelBooking marks the record until it has).
    const marked = { ...cancelled, google: { ...g, error: CALENDAR_PENDING } };
    expect(await calendarBeingRemoved(ctx, marked)).toBe(true);
    // A removal that went wrong is said as such, not as on its way.
    expect(await calendarBeingRemoved(ctx, { ...cancelled, google: { ...g, error: 'Google request failed' } })).toBe(false);
    // No mark and nothing queued: done, or there was never an event.
    const unmarked = { ...cancelled, google: g };
    expect(await calendarBeingRemoved(ctx, unmarked)).toBe(false);
    expect(await calendarBeingRemoved(ctx, { ...cancelled, google: null })).toBe(false);
    // A calendar sync still queued for it, with no word yet that the event is gone.
    await putJob(ctx, job({ key: `jobs/${TEST_NOW}_job_sync`, id: 'job_sync', type: 'gcal_sync' }));
    expect(await calendarBeingRemoved(ctx, unmarked)).toBe(true);
    expect(await calendarBeingRemoved(ctx, { ...unmarked, timeline: [{ at: TEST_NOW, type: 'calendar_event_removed' }] })).toBe(false);
    expect(await calendarBeingRemoved(ctx, { ...unmarked, timeline: [{ at: TEST_NOW, type: 'calendar_event_left', detail: 'Google Calendar is no longer connected, so the event was not removed.' }] })).toBe(false);
    // Only for cancelled meetings.
    expect(await calendarBeingRemoved(ctx, { ...marked, status: 'confirmed' })).toBe(false);
    // The delete itself is not changed by it.
    expect(eraseRefusal(marked, [], at)?.code).toBe('calendar_event_left');
  });
});
