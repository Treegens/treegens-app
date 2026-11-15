import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { defaultOwnerHost, defaultSite } from '../../shared/defaults';
import type { Booking, Host } from '../../shared/types';
import { buildBookingIcs, calendarLinks, escapeIcsText, foldIcsLine } from '../../server/lib/ics';
import { TEST_BASE_URL, TEST_NOW } from '../helpers/ctx';

const site = defaultSite(TEST_NOW);
const jimi: Host = { ...defaultOwnerHost(TEST_NOW, 'America/New_York'), email: 'jimi@example.com' };
const alex: Host = { ...jimi, id: 'host_alex', role: 'member', name: 'Alex Mwangi', email: 'alex@example.com' };

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: 'bkg_abc123',
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: '2026-11-17T20:30:00.000Z',
    end: '2026-11-17T21:00:00.000Z',
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', timezone: 'Africa/Nairobi' },
    guests: [],
    answers: [],
    location: { type: 'google_meet', label: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij' },
    consent: { sms: false, call: false, at: TEST_NOW, text: '' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [],
    createdAt: '2026-11-16T09:00:00.000Z',
    updatedAt: '2026-11-16T09:05:07.000Z',
    ...over,
  };
}

/** Physical lines as they are in the file. */
function rawLines(ics: string): string[] {
  return ics.split('\r\n');
}

/** Logical content lines: continuation lines joined back onto the line they belong to. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
}

function prop(ics: string, name: string): string | undefined {
  const line = unfold(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line?.slice(line.indexOf(':') + 1);
}

function vevent(ics: string): InstanceType<typeof ICAL.Component> {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  const event = calendar.getFirstSubcomponent('vevent');
  if (!event) throw new Error('no VEVENT');
  return event;
}

const manageUrl = `${TEST_BASE_URL}/booking/bkg_abc123?t=tok`;

describe('buildBookingIcs', () => {
  it('writes a complete, parseable invitation', () => {
    const ics = buildBookingIcs({ booking: booking(), hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL, manageUrl });
    const lines = unfold(ics);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('METHOD:REQUEST');
    expect(lines).toContain('UID:bkg_abc123@jimicohen.com');
    expect(lines).toContain('DTSTAMP:20261116T090000Z'); // when the booking was made, not its last save
    expect(lines).toContain('DTSTART:20261117T203000Z');
    expect(lines).toContain('DTEND:20261117T210000Z');
    expect(lines).toContain('SEQUENCE:0');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('SUMMARY:Intro call: Sam Rivera and Jimi Cohen');
    expect(lines).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
    expect(lines).toContain('URL:https://meet.google.com/abc-defg-hij');
    expect(lines).toContain('ORGANIZER;CN="Jimi Cohen":mailto:jimi@example.com');
    expect(lines).toContain('ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE;CN="Sam Rivera":mailto:sam@example.com');
    expect(prop(ics, 'PRODID')).toMatch(/^-\/\/jimicohen\.com\/\//);

    const event = vevent(ics);
    expect(event.getFirstPropertyValue('summary')).toBe('Intro call: Sam Rivera and Jimi Cohen');
    expect(String(event.getFirstPropertyValue('dtstart'))).toBe('2026-11-17T20:30:00Z');
    expect(String(event.getFirstPropertyValue('dtend'))).toBe('2026-11-17T21:00:00Z');
    expect(event.getFirstPropertyValue('description')).toBe(
      `Intro call with Jimi Cohen.\nJoin: https://meet.google.com/abc-defg-hij\nReschedule or cancel: ${manageUrl}`,
    );
  });

  it('uses CRLF line endings only and ends with one', () => {
    const ics = buildBookingIcs({ booking: booking(), hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL, manageUrl });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('adds a reminder alarm 15 minutes before', () => {
    const lines = unfold(buildBookingIcs({ booking: booking(), hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }));
    const begin = lines.indexOf('BEGIN:VALARM');
    const end = lines.indexOf('END:VALARM');
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(lines.slice(begin, end)).toEqual(expect.arrayContaining(['ACTION:DISPLAY', 'TRIGGER:-PT15M']));
    expect(end).toBeLessThan(lines.indexOf('END:VEVENT'));
  });

  it('folds long lines at 75 octets without breaking characters', () => {
    const long = booking({
      eventTitle: 'Révision trimestrielle du partenariat 🌱 avec toute l’équipe de reboisement, première partie',
      invitee: { name: 'Zoë Åkesson-Ñandú', email: 'zoe@example.com', timezone: 'Europe/Stockholm' },
      location: { type: 'in_person', label: 'In person', value: 'Bürogebäude 7, Straße des Friedens 123, 10115 Berlin, Deutschland, dritter Stock' },
    });
    const ics = buildBookingIcs({ booking: long, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL, manageUrl });
    const physical = rawLines(ics);
    expect(physical.some((l) => l.startsWith(' '))).toBe(true); // something was folded
    for (const line of physical) expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(75);
    // every physical line is valid UTF-8 on its own: no character was cut in half
    for (const line of physical) expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
    expect(ics).not.toContain('\uFFFD');

    const event = vevent(ics);
    expect(event.getFirstPropertyValue('summary')).toBe(`${long.eventTitle}: Zoë Åkesson-Ñandú and Jimi Cohen`);
    expect(event.getFirstPropertyValue('location')).toBe(long.location.value);
  });

  it('folds exactly: 75 octets on the first line, a leading space on the rest', () => {
    const line = `SUMMARY:${'a'.repeat(200)}`;
    const folded = foldIcsLine(line).split('\r\n');
    expect(folded[0]).toHaveLength(75);
    expect(folded[1].startsWith(' ')).toBe(true);
    expect(folded[1]).toHaveLength(75);
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(line);
    expect(foldIcsLine('SHORT:line')).toBe('SHORT:line');
    // four-byte characters land on a boundary, never across it
    const emoji = foldIcsLine(`X:${'🌱'.repeat(40)}`).split('\r\n');
    for (const l of emoji) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    expect(emoji.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(`X:${'🌱'.repeat(40)}`);
  });

  it('escapes text values', () => {
    expect(escapeIcsText('a;b,c\\d\ne\r\nf')).toBe('a\\;b\\,c\\\\d\\ne\\nf');
    const tricky = booking({ eventTitle: 'Plan; review, and \\ sign\noff' });
    const ics = buildBookingIcs({ booking: tricky, hosts: [jimi], site, method: 'PUBLISH', baseUrl: TEST_BASE_URL });
    expect(prop(ics, 'SUMMARY')).toBe('Plan\\; review\\, and \\\\ sign\\noff: Sam Rivera and Jimi Cohen');
    expect(vevent(ics).getFirstPropertyValue('summary')).toBe('Plan; review, and \\ sign\noff: Sam Rivera and Jimi Cohen');
  });

  it('cannot be tricked into extra lines or attendees by booking data', () => {
    const hostile = booking({
      eventTitle: 'Chat\r\nATTENDEE:mailto:evil@example.com',
      invitee: { name: 'Sam"\r\nORGANIZER:mailto:evil@example.com\r\nX:"', email: 'sam@example.com', timezone: 'UTC' },
      guests: ['guest@example.com', 'not-an-email', 'evil@example.com\r\nATTENDEE:mailto:other@example.com'],
      location: { type: 'in_person', label: 'In person', value: 'Office\r\nEND:VEVENT' },
    });
    const ics = buildBookingIcs({ booking: hostile, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL });
    const lines = unfold(ics);
    expect(lines.filter((l) => l.startsWith('ORGANIZER'))).toEqual(['ORGANIZER;CN="Jimi Cohen":mailto:jimi@example.com']);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    const attendees = lines.filter((l) => l.startsWith('ATTENDEE'));
    expect(attendees.map((l) => l.slice(l.lastIndexOf(':mailto:') + 8))).toEqual(['sam@example.com', 'jimi@example.com', 'guest@example.com']);
    expect(attendees.every((l) => l.startsWith('ATTENDEE;CUTYPE=INDIVIDUAL;'))).toBe(true);
    expect(() => ICAL.parse(ics)).not.toThrow();
    expect(vevent(ics).getAllProperties('attendee')).toHaveLength(3);
  });

  it('lists co-hosts and guests, each address once', () => {
    const joint = booking({ kind: 'collective', hostIds: ['host_owner', 'host_alex'], guests: ['pat@example.com', 'SAM@example.com'] });
    const lines = unfold(buildBookingIcs({ booking: joint, hosts: [alex, jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }));
    expect(lines).toContain('ORGANIZER;CN="Jimi Cohen":mailto:jimi@example.com'); // first assigned host, not first in the list
    const attendees = lines.filter((l) => l.startsWith('ATTENDEE'));
    expect(attendees).toHaveLength(4);
    expect(attendees[1]).toContain('CN="Jimi Cohen":mailto:jimi@example.com');
    expect(attendees[2]).toContain('PARTSTAT=ACCEPTED;RSVP=FALSE;CN="Alex Mwangi":mailto:alex@example.com');
    expect(attendees[3]).toBe('ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="pat@example.com":mailto:pat@example.com');
    expect(lines).toContain('SUMMARY:Intro call: Sam Rivera\\, Jimi Cohen and Alex Mwangi');
  });

  it('keeps DTSTAMP still while only notes change, and moves it with a reschedule or a cancellation', () => {
    const stamp = (b: Booking) => prop(buildBookingIcs({ booking: b, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }), 'DTSTAMP');
    const made = booking({ timeline: [{ at: '2026-11-16T09:00:00.000Z', type: 'created' }] });
    expect(stamp(made)).toBe('20261116T090000Z');
    // a retry of the same email after a timeline note (which changes updatedAt) carries the same file
    const noted = { ...made, updatedAt: '2026-11-16T09:12:00.000Z', timeline: [...made.timeline, { at: '2026-11-16T09:12:00.000Z', type: 'confirmation_email_failed' }] };
    expect(buildBookingIcs({ booking: noted, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL })).toBe(
      buildBookingIcs({ booking: made, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }),
    );
    const moved = { ...noted, rescheduleCount: 1, timeline: [...noted.timeline, { at: '2026-11-16T10:30:00.000Z', type: 'rescheduled' }] };
    expect(stamp(moved)).toBe('20261116T103000Z');
    const cancelled = { ...moved, status: 'cancelled' as const, timeline: [...moved.timeline, { at: '2026-11-16T11:00:00.000Z', type: 'cancelled' }, { at: '2026-11-16T11:01:00.000Z', type: 'cancelled_email_sent' }] };
    expect(stamp(cancelled)).toBe('20261116T110000Z');
  });

  it('carries the reschedule count as SEQUENCE', () => {
    const moved = booking({ rescheduleCount: 3 });
    expect(unfold(buildBookingIcs({ booking: moved, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }))).toContain('SEQUENCE:3');
  });

  it('writes a cancellation that withdraws the same event', () => {
    const cancelled = booking({ status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee' }, rescheduleCount: 1 });
    const ics = buildBookingIcs({ booking: cancelled, hosts: [jimi], site, method: 'CANCEL', baseUrl: TEST_BASE_URL, manageUrl });
    const lines = unfold(ics);
    expect(lines).toContain('METHOD:CANCEL');
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('UID:bkg_abc123@jimicohen.com');
    expect(lines).toContain('SEQUENCE:1');
    expect(lines).not.toContain('BEGIN:VALARM');
    expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(2);
    expect(vevent(ics).getFirstPropertyValue('description')).toBe('This meeting was cancelled.');
    expect(() => ICAL.parse(ics)).not.toThrow();
  });

  it('leaves attendees out of a PUBLISH file', () => {
    const lines = unfold(buildBookingIcs({ booking: booking(), hosts: [jimi], site, method: 'PUBLISH', baseUrl: TEST_BASE_URL }));
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines.some((l) => l.startsWith('ATTENDEE'))).toBe(false);
    expect(lines.some((l) => l.startsWith('ORGANIZER'))).toBe(true);
  });

  it('falls back to PUBLISH when no organizer address exists', () => {
    const noEmail: Host = { ...jimi, email: '' };
    const lines = unfold(buildBookingIcs({ booking: booking(), hosts: [noEmail], site, method: 'REQUEST', baseUrl: TEST_BASE_URL }));
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines.some((l) => l.startsWith('ORGANIZER'))).toBe(false);

    const withReplyTo = { ...site, email: { ...site.email, replyTo: 'hello@jimicohen.com' } };
    const viaSite = unfold(buildBookingIcs({ booking: booking(), hosts: [noEmail], site: withReplyTo, method: 'REQUEST', baseUrl: TEST_BASE_URL }));
    expect(viaSite).toContain('METHOD:REQUEST');
    expect(viaSite).toContain('ORGANIZER;CN="Jimi Cohen":mailto:hello@jimicohen.com');
  });

  it('describes places that are not links', () => {
    const office = booking({ location: { type: 'in_person', label: 'In person', value: '12 Riverside Drive, Nairobi' } });
    const ics = buildBookingIcs({ booking: office, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL, manageUrl });
    expect(prop(ics, 'LOCATION')).toBe('12 Riverside Drive\\, Nairobi');
    expect(prop(ics, 'URL')).toBe(manageUrl); // no video link: the manage page is the event URL

    const phone = booking({ location: { type: 'phone_host_calls', label: 'Phone call' } });
    const phoneIcs = buildBookingIcs({ booking: phone, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL });
    expect(prop(phoneIcs, 'LOCATION')).toBe('Phone call');
    expect(prop(phoneIcs, 'URL')).toBeUndefined();

    const meetLater = booking({ location: { type: 'google_meet', label: 'Google Meet' }, google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'e1', meetUrl: 'https://meet.google.com/zzz-zzzz-zzz' } });
    expect(prop(buildBookingIcs({ booking: meetLater, hosts: [jimi], site, method: 'PUBLISH', baseUrl: TEST_BASE_URL }), 'LOCATION')).toBe(
      'https://meet.google.com/zzz-zzzz-zzz',
    );
  });

  it('never writes an unsafe URL property', () => {
    const odd = booking({ location: { type: 'custom_link', label: 'Video call', joinUrl: 'javascript:alert(1)' } });
    const ics = buildBookingIcs({ booking: odd, hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL, manageUrl: 'ftp://x.test/y' });
    expect(prop(ics, 'URL')).toBeUndefined();
    expect(ics).not.toContain('javascript:');
  });

  it('refuses a booking without valid times', () => {
    expect(() => buildBookingIcs({ booking: booking({ start: 'soon' }), hosts: [jimi], site, method: 'REQUEST', baseUrl: TEST_BASE_URL })).toThrow(RangeError);
  });
});

describe('calendarLinks', () => {
  const links = calendarLinks({ booking: booking(), hosts: [jimi], baseUrl: `${TEST_BASE_URL}/`, manageToken: 'tok+/=' });

  it('builds a Google Calendar link', () => {
    const url = new URL(links.google);
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Intro call: Sam Rivera and Jimi Cohen');
    expect(url.searchParams.get('dates')).toBe('20261117T203000Z/20261117T210000Z');
    expect(url.searchParams.get('location')).toBe('https://meet.google.com/abc-defg-hij');
    expect(url.searchParams.get('details')).toContain('Join: https://meet.google.com/abc-defg-hij');
    expect(url.searchParams.get('details')).toContain(`Reschedule or cancel: ${TEST_BASE_URL}/booking/bkg_abc123?t=tok%2B%2F%3D`);
  });

  it('builds an Outlook link', () => {
    const url = new URL(links.outlook);
    expect(url.origin + url.pathname).toBe('https://outlook.live.com/calendar/0/action/compose');
    expect(url.searchParams.get('rru')).toBe('addevent');
    expect(url.searchParams.get('subject')).toBe('Intro call: Sam Rivera and Jimi Cohen');
    expect(url.searchParams.get('startdt')).toBe('2026-11-17T20:30:00Z');
    expect(url.searchParams.get('enddt')).toBe('2026-11-17T21:00:00Z');
    expect(url.searchParams.get('body')).toContain('Intro call with Jimi Cohen.');
  });

  it('builds the same link for Microsoft 365 work and school calendars', () => {
    const work = new URL(links.office365);
    const personal = new URL(links.outlook);
    expect(work.origin + work.pathname).toBe('https://outlook.office.com/calendar/0/action/compose');
    expect(work.search).toBe(personal.search);
    expect(work.searchParams.get('subject')).toBe('Intro call: Sam Rivera and Jimi Cohen');
  });

  it('writes spaces as %20 so no client shows plus signs', () => {
    expect(links.google).not.toContain('+');
    expect(links.outlook).not.toContain('+');
    expect(links.office365).not.toContain('+');
    expect(links.google).toContain('Intro%20call');
  });

  it('points the file link at our own API with the manage token', () => {
    expect(links.ics).toBe(`${TEST_BASE_URL}/api/public/bookings/bkg_abc123/ics?t=tok%2B%2F%3D`);
  });

  it('leaves the location out when there is none', () => {
    const bare = calendarLinks({ booking: booking({ location: { type: 'ask_invitee', label: '' } }), hosts: [jimi], baseUrl: TEST_BASE_URL, manageToken: 't' });
    expect(new URL(bare.google).searchParams.has('location')).toBe(false);
    expect(new URL(bare.outlook).searchParams.has('location')).toBe(false);
  });
});
