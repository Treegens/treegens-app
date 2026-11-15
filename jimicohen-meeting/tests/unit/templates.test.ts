import { describe, expect, it, vi } from 'vitest';
import { defaultOwnerHost, defaultSite } from '../../shared/defaults';
import type { Booking, Host, MessageKind, ReminderChannel, SiteSettings } from '../../shared/types';
import { hmacHex } from '../../server/lib/crypto';
import { makeTestCtx, TEST_BASE_URL, TEST_NOW } from '../helpers/ctx';

// time.ts belongs to another engineer: the tests run against a stand-in with the documented output.
vi.mock('../../server/lib/time', async () => {
  const { DateTime } = await import('luxon');
  const FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
    full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    date: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit' },
    short: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    spoken: { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  };
  return {
    formatInZone: (ms: number, tz: string, style: string, locale = 'en-US') =>
      DateTime.fromMillis(ms, { zone: tz })
        .setLocale(locale)
        .toLocaleString(FORMATS[style])
        .replace(/[\u00A0\u2009\u202F]/g, ' '),
  };
});

import {
  buildVars,
  defaultMessage,
  escapeHtml,
  humanDuration,
  joinNames,
  messageLocale,
  renderTemplate,
  startsIn,
  TEMPLATE_VARIABLES,
} from '../../server/lib/templates';

const KINDS: MessageKind[] = ['confirmation', 'host_new', 'rescheduled', 'cancelled', 'reminder', 'followup', 'manage_link', 'host_alert'];
const CHANNELS: ReminderChannel[] = ['email', 'sms', 'call'];
const AUDIENCES = ['invitee', 'host'] as const;

function host(over: Partial<Host> = {}): Host {
  return { ...defaultOwnerHost(TEST_NOW, 'America/New_York'), email: 'jimi@example.com', ...over };
}

function site(over: Partial<SiteSettings> = {}): SiteSettings {
  return { ...defaultSite(TEST_NOW), ...over };
}

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: 'bkg_abc123',
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: '2026-11-17T22:30:00.000Z',
    end: '2026-11-17T23:00:00.000Z',
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', phone: '+254700000001', timezone: 'Africa/Nairobi', locale: 'en-US' },
    guests: ['pat@example.com', 'lee@example.com'],
    answers: [
      { questionId: 'q_topic', label: 'What would you like to talk about?', value: 'Tree planting in Kiambu' },
      { questionId: 'q_empty', label: 'Anything else?', value: '  ' },
    ],
    location: { type: 'google_meet', label: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij' },
    consent: { sms: true, call: true, at: TEST_NOW, text: 'consent' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...over,
  };
}

describe('renderTemplate', () => {
  it('fills in variables and tolerates spaces inside the braces', () => {
    expect(renderTemplate('Hi {{name}}, see you {{ when }}.', { name: 'Sam', when: 'today' })).toBe('Hi Sam, see you today.');
  });

  it('renders unknown variables as nothing', () => {
    expect(renderTemplate('A{{nope}}B', {})).toBe('AB');
    expect(renderTemplate('', { a: 'b' })).toBe('');
  });

  it('never resolves inherited object properties', () => {
    expect(renderTemplate('[{{constructor}}][{{toString}}][{{__proto__}}][{{hasOwnProperty}}]', {})).toBe('[][][][]');
  });

  it('escapes values but not the template when html is set', () => {
    const out = renderTemplate('<b>{{name}}</b>', { name: `<img src=x onerror="alert('1')"> & co` }, { html: true });
    expect(out).toBe('<b>&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt; &amp; co</b>');
  });

  it('leaves values alone without the html flag', () => {
    expect(renderTemplate('{{name}}', { name: 'A & B <c>' })).toBe('A & B <c>');
  });

  it('does not expand template syntax that arrives inside a value', () => {
    const vars = { name: '{{secret}} {{#secret}}x{{/secret}}', secret: 'TOKEN' };
    expect(renderTemplate('Hi {{name}}', vars)).toBe('Hi {{secret}} {{#secret}}x{{/secret}}');
  });

  it('keeps a section only when its variable has a value', () => {
    const tpl = 'Done.{{#reason}} Reason: {{reason}}.{{/reason}}';
    expect(renderTemplate(tpl, { reason: 'Travelling' })).toBe('Done. Reason: Travelling.');
    expect(renderTemplate(tpl, { reason: '' })).toBe('Done.');
    expect(renderTemplate(tpl, { reason: '   ' })).toBe('Done.');
    expect(renderTemplate(tpl, {})).toBe('Done.');
  });

  it('supports inverted and nested sections', () => {
    expect(renderTemplate('{{^join_url}}No link yet.{{/join_url}}', {})).toBe('No link yet.');
    expect(renderTemplate('{{^join_url}}No link yet.{{/join_url}}', { join_url: 'https://x.test' })).toBe('');
    const nested = '{{#a}}A{{#b}}B{{/b}}{{^b}}no-b{{/b}}{{/a}}';
    expect(renderTemplate(nested, { a: '1', b: '1' })).toBe('AB');
    expect(renderTemplate(nested, { a: '1' })).toBe('Ano-b');
    expect(renderTemplate(nested, { b: '1' })).toBe('');
  });

  it('drops unbalanced section tags instead of printing them', () => {
    expect(renderTemplate('A {{#x}}B', { x: '1' })).toBe('A B');
    expect(renderTemplate('A {{/x}}B', {})).toBe('A B');
  });

  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('wording helpers', () => {
  it('writes durations the way people say them', () => {
    expect(humanDuration(15)).toBe('15 minutes');
    expect(humanDuration(1)).toBe('1 minute');
    expect(humanDuration(60)).toBe('1 hour');
    expect(humanDuration(90)).toBe('1 hour 30 minutes');
    expect(humanDuration(120)).toBe('2 hours');
    expect(humanDuration(0)).toBe('0 minutes');
  });

  it('joins names with commas and "and"', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Jimi'])).toBe('Jimi');
    expect(joinNames(['Jimi', 'Alex'])).toBe('Jimi and Alex');
    expect(joinNames(['Jimi', ' Alex ', '', 'Sam'])).toBe('Jimi, Alex and Sam');
  });

  it('describes the time left until the start', () => {
    const start = Date.parse('2026-11-17T22:30:00Z');
    const min = 60_000;
    expect(startsIn(start, start)).toBe('now');
    expect(startsIn(start + min, start)).toBe('now');
    expect(startsIn(start - 20_000, start)).toBe('in less than a minute');
    expect(startsIn(start - 7 * min, start)).toBe('in 7 minutes');
    expect(startsIn(start - 14 * min, start)).toBe('in 15 minutes');
    expect(startsIn(start - 58 * min, start)).toBe('in 1 hour');
    expect(startsIn(start - 90 * min, start)).toBe('in 1 hour 30 minutes');
    expect(startsIn(start - 5 * 60 * min, start)).toBe('in 5 hours');
    expect(startsIn(start - 24 * 60 * min, start)).toBe('in 24 hours');
    expect(startsIn(start - 72 * 60 * min, start)).toBe('in 3 days');
  });

  it('keeps dates in English and lets the clock follow the reader', () => {
    expect(messageLocale(undefined)).toBe('en-US');
    expect(messageLocale('en-GB')).toBe('en-GB');
    expect(messageLocale('en_AU')).toBe('en-AU');
    expect(messageLocale('de-DE')).toBe('en-GB'); // 24 hour clock, English words
    expect(messageLocale('es-MX')).toBe('en-US'); // 12 hour clock
    expect(messageLocale('en-US', '24h')).toBe('en-GB');
    expect(messageLocale('en-GB', '12h')).toBe('en-US');
    expect(messageLocale('not a locale')).toBe('en-US');
  });
});

describe('buildVars', () => {
  const ctx = makeTestCtx({ now: '2026-11-17T09:00:00Z' });
  const jimi = host();
  const alex = host({ id: 'host_alex', role: 'member', name: 'Alex Mwangi', email: 'alex@example.com', timezone: 'Europe/London' });

  it("writes invitee messages in the invitee's zone", () => {
    const v = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    // 22:30 UTC on the 17th is 01:30 on the 18th in Nairobi
    expect(v.date).toBe('Wednesday, November 18, 2026');
    expect(v.time).toBe('1:30 AM');
    expect(v.end_time).toBe('2:00 AM');
    expect(v.datetime).toBe('Wednesday, November 18, 2026 at 1:30 AM GMT+3');
    expect(v.datetime_short).toBe('Wed, Nov 18, 1:30 AM');
    expect(v.timezone).toBe('East Africa Time');
    expect(v.timezone_short).toBe('GMT+3');
    expect(v.relative_day).toBe('tomorrow');
  });

  it("writes host messages in the reading host's own zone", () => {
    const shared = { booking: booking({ hostIds: ['host_owner', 'host_alex'], kind: 'collective' }), eventType: null, hosts: [jimi, alex], site: site() };
    const forJimi = buildVars(ctx, { ...shared, audience: 'host', recipientHost: jimi });
    expect(forJimi.date).toBe('Tuesday, November 17, 2026');
    expect(forJimi.time).toBe('5:30 PM');
    expect(forJimi.timezone).toBe('Eastern Standard Time');
    expect(forJimi.timezone_short).toBe('EST');
    expect(forJimi.relative_day).toBe('today');
    expect(forJimi.host_name).toBe('Jimi Cohen');
    expect(forJimi.host_first_name).toBe('Jimi');

    const forAlex = buildVars(ctx, { ...shared, audience: 'host', recipientHost: alex });
    expect(forAlex.time).toBe('10:30 PM');
    expect(forAlex.timezone).toBe('Greenwich Mean Time');
    expect(forAlex.host_first_name).toBe('Alex');
    expect(forAlex.invitee_timezone).toBe('East Africa Time');

    // without a named reader the first assigned host's zone is used
    expect(buildVars(ctx, { ...shared, audience: 'host' }).time).toBe('5:30 PM');
  });

  it('never greets with a "name" that reads as a link, and keeps real names that have dots or dashes', () => {
    const greet = (name: string, audience: 'invitee' | 'host' = 'invitee') =>
      buildVars(ctx, { booking: booking({ invitee: { name, email: 'third.party@example.org', timezone: 'Africa/Nairobi' } }), eventType: null, hosts: [jimi], site: site(), audience })
        .invitee_first_name;
    for (const name of ['https://evil.example/verify-account now', 'evil.example/verify-account now', 'www.evil.example', 'evil.com', 'Win-prize.xyz today', 'me@evil.example']) {
      expect(greet(name), name).toBe('there');
    }
    expect(greet('evil.com', 'host')).toBe('the invitee');
    for (const [name, first] of [['J.R.R. Tolkien', 'J.R.R.'], ["Mary-Jane O'Neil Jr.", 'Mary-Jane'], ['J.Smith', 'J.Smith'], ['Zoë Ångström', 'Zoë']]) {
      expect(greet(name), name).toBe(first);
    }
    // what the person typed is still shown as it is where it is not a greeting
    expect(buildVars(ctx, { booking: booking({ invitee: { name: 'evil.com', email: 'a@example.org', timezone: 'UTC' } }), eventType: null, hosts: [jimi], site: site(), audience: 'host' }).invitee_name).toBe(
      'evil.com',
    );
  });

  it('follows daylight saving in the reader zone', () => {
    const summer = booking({ start: '2026-07-01T14:00:00.000Z', end: '2026-07-01T14:30:00.000Z' });
    const v = buildVars(ctx, { booking: summer, eventType: null, hosts: [jimi], site: site(), audience: 'host', recipientHost: jimi });
    expect(v.time).toBe('10:00 AM');
    expect(v.timezone).toBe('Eastern Daylight Time');
    expect(v.timezone_short).toBe('EDT');
  });

  it('names the people involved', () => {
    const solo = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi, alex], site: site(), audience: 'invitee' });
    expect(solo.invitee_name).toBe('Sam Rivera');
    expect(solo.invitee_first_name).toBe('Sam');
    expect(solo.invitee_email).toBe('sam@example.com');
    expect(solo.host_name).toBe('Jimi Cohen');
    expect(solo.host_first_name).toBe('Jimi');
    expect(solo.host_names).toBe('Jimi Cohen'); // only the assigned host, not everyone passed in

    const joint = buildVars(ctx, {
      booking: booking({ hostIds: ['host_owner', 'host_alex'] }),
      eventType: null,
      hosts: [alex, jimi],
      site: site(),
      audience: 'invitee',
    });
    expect(joint.host_names).toBe('Jimi and Alex'); // booking order, first names
    expect(joint.host_name).toBe('Jimi Cohen');
  });

  it('falls back gracefully when the invitee gave a single-word or empty name and an unknown zone', () => {
    const odd = booking({ invitee: { name: '', email: 'x@example.com', timezone: 'Mars/Olympus' } });
    const v = buildVars(ctx, { booking: odd, eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    expect(v.invitee_first_name).toBe('there');
    expect(v.time).toBe('5:30 PM'); // the host's zone stands in for a zone that does not exist
  });

  it('builds the manage links from the public base URL and the booking token', () => {
    const v = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    const token = hmacHex(ctx, 'manage', 'bkg_abc123');
    expect(v.manage_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123?t=${token}`);
    expect(v.reschedule_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123/reschedule?t=${token}`);
    expect(v.cancel_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123/cancel?t=${token}`);
    expect(v.confirm_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123?t=${token}&confirm=1`);
    expect(v.book_url).toBe(`${TEST_BASE_URL}/intro`);
    expect(v.join_url).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('marks the manage links in host messages, so the booking page knows a host is acting', () => {
    const v = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: site(), audience: 'host', recipientHost: jimi });
    const token = hmacHex(ctx, 'manage', 'bkg_abc123');
    expect(v.manage_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123?t=${token}&as=host`);
    expect(v.reschedule_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123/reschedule?t=${token}&as=host`);
    expect(v.cancel_url).toBe(`${TEST_BASE_URL}/booking/bkg_abc123/cancel?t=${token}&as=host`);
  });

  it('describes the rest of the booking', () => {
    const v = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    expect(v.event_name).toBe('Intro call');
    expect(v.duration).toBe('30 minutes');
    expect(v.location).toBe('Google Meet');
    expect(v.answers).toBe('What would you like to talk about? Tree planting in Kiambu');
    const plain = booking({ answers: [{ questionId: 'q', label: 'Company', value: 'Green Belt' }, { questionId: 'r', label: 'Role', value: 'Founder' }] });
    expect(buildVars(ctx, { booking: plain, eventType: null, hosts: [jimi], site: site(), audience: 'host' }).answers).toBe('Company: Green Belt\nRole: Founder');
    expect(v.guests).toBe('pat@example.com, lee@example.com');
    expect(v.site_name).toBe('Jimi Cohen');
    expect(v.assistant_name).toBe('Ava');
    expect(v.starts_in).toBe('in 14 hours');
    expect(v.previous_datetime).toBe('');
    expect(v.cancel_reason).toBe('');
  });

  it('words the location for whoever is reading', () => {
    const phone = booking({ location: { type: 'phone_host_calls', label: 'Phone call' } });
    const args = { booking: phone, eventType: null, hosts: [jimi], site: site() };
    expect(buildVars(ctx, { ...args, audience: 'invitee' }).location).toBe('Phone call. Jimi will call you on +254700000001');
    expect(buildVars(ctx, { ...args, audience: 'host' }).location).toBe('Phone call. Call Sam on +254700000001');
    const office = booking({ location: { type: 'in_person', label: 'In person', value: '12 Riverside Drive, Nairobi' } });
    expect(buildVars(ctx, { ...args, booking: office, audience: 'invitee' }).location).toBe('In person: 12 Riverside Drive, Nairobi');
    const dialIn = booking({ location: { type: 'phone_invitee_calls', label: 'Phone call', value: '+1 555 0100' } });
    expect(buildVars(ctx, { ...args, booking: dialIn, audience: 'invitee' }).location).toBe('Phone call. Call +1 555 0100');
  });

  it('carries reschedule and cancellation details', () => {
    const moved = booking({ rescheduledFromStart: '2026-11-16T22:30:00.000Z', rescheduleCount: 1 });
    const v = buildVars(ctx, { booking: moved, eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    expect(v.previous_datetime).toBe('Tuesday, November 17, 2026 at 1:30 AM GMT+3');

    const cancelled = booking({ status: 'cancelled', cancellation: { at: TEST_NOW, by: 'assistant', reason: ' Double booked ' } });
    const c = buildVars(ctx, { booking: cancelled, eventType: null, hosts: [jimi], site: site(), audience: 'host' });
    expect(c.cancel_reason).toBe('Double booked');
    expect(c.cancelled_by).toBe("Ava, the AI assistant, at Sam's request");
  });

  it('uses a 24 hour clock for readers whose locale does, and when the site says so', () => {
    const british = booking({ invitee: { name: 'Sam Rivera', email: 'sam@example.com', timezone: 'Europe/London', locale: 'en-GB' } });
    const v = buildVars(ctx, { booking: british, eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    expect(v.time).toBe('22:30');

    const fixed = site();
    fixed.theme.timeFormat = '24h';
    const h = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: fixed, audience: 'host', recipientHost: jimi });
    expect(h.time).toBe('17:30');
  });

  it('documents only variables that exist, including every one the spec promises', () => {
    const v = buildVars(ctx, { booking: booking(), eventType: null, hosts: [jimi], site: site(), audience: 'invitee' });
    for (const { key, description } of TEMPLATE_VARIABLES) {
      expect(Object.keys(v), `variable ${key}`).toContain(key);
      expect(description.length).toBeGreaterThan(5);
    }
    const promised = [
      'invitee_name', 'invitee_first_name', 'invitee_email', 'host_name', 'host_first_name', 'host_names', 'event_name', 'duration',
      'date', 'time', 'timezone', 'datetime', 'location', 'join_url', 'manage_url', 'reschedule_url', 'cancel_url', 'confirm_url',
      'answers', 'site_name', 'assistant_name',
    ];
    const documented = TEMPLATE_VARIABLES.map((t) => t.key);
    for (const key of promised) expect(documented).toContain(key);
    expect(new Set(documented).size).toBe(documented.length);
  });
});

describe('defaultMessage', () => {
  const ctx = makeTestCtx({ now: '2026-11-17T09:00:00Z' });
  const jimi = host();
  const longNames = booking({
    eventTitle: 'Quarterly partnership review',
    invitee: { name: 'Alexandria Montgomery-Fitzgerald', email: 'alexandria@example.com', timezone: 'America/Los_Angeles' },
    cancellation: { at: TEST_NOW, by: 'invitee', reason: 'Something came up at work' },
    rescheduledFromStart: '2026-11-16T22:30:00.000Z',
  });
  const varsFor = (audience: 'invitee' | 'host') =>
    buildVars(ctx, { booking: longNames, eventType: null, hosts: [jimi], site: site(), audience, recipientHost: jimi });

  it('has wording for every kind on every channel for both audiences', () => {
    for (const kind of KINDS) {
      for (const channel of CHANNELS) {
        for (const audience of AUDIENCES) {
          const m = defaultMessage(kind, channel, audience);
          const where = `${kind}/${channel}/${audience}`;
          expect(m.body.trim().length, where).toBeGreaterThan(20);
          if (channel === 'email') {
            expect(m.subject.trim().length, where).toBeGreaterThan(8);
            expect(m.heading.trim().length, where).toBeGreaterThan(4);
            expect(m.subject, where).not.toMatch(/[\r\n]/);
          } else {
            expect(m.subject, where).toBe('');
          }
        }
      }
    }
  });

  it('never uses an em dash or en dash', () => {
    for (const kind of KINDS) {
      for (const channel of CHANNELS) {
        for (const audience of AUDIENCES) {
          const m = defaultMessage(kind, channel, audience);
          expect(`${m.subject}${m.heading}${m.body}`, `${kind}/${channel}/${audience}`).not.toMatch(/[\u2012-\u2015]/);
        }
      }
    }
  });

  it('only uses variables that buildVars provides, with balanced sections', () => {
    const known = new Set(Object.keys(varsFor('invitee')));
    for (const kind of KINDS) {
      for (const channel of CHANNELS) {
        for (const audience of AUDIENCES) {
          const m = defaultMessage(kind, channel, audience);
          const all = `${m.subject} ${m.heading} ${m.body}`;
          for (const [, name] of all.matchAll(/\{\{\s*[#^/]?\s*([A-Za-z_]\w*)\s*\}\}/g)) {
            expect(known.has(name), `${kind}/${channel}/${audience} uses {{${name}}}`).toBe(true);
          }
          const rendered = renderTemplate(all, varsFor(audience));
          expect(rendered, `${kind}/${channel}/${audience}`).not.toMatch(/\{\{|\}\}/);
        }
      }
    }
  });

  it('keeps text messages short and puts who and when first', () => {
    for (const kind of KINDS) {
      for (const audience of AUDIENCES) {
        const text = renderTemplate(defaultMessage(kind, 'sms', audience).body, varsFor(audience));
        expect(text.length, `${kind}/${audience}: ${text}`).toBeLessThan(300);
        expect(text, `${kind}/${audience}`).not.toMatch(/\n/);
      }
    }
    const reminder = renderTemplate(defaultMessage('reminder', 'sms', 'invitee').body, varsFor('invitee'));
    expect(reminder).toBe('Hi Alexandria, a reminder: Quarterly partnership review with Jimi Cohen is today at 2:30 PM PST.');
    const confirmation = renderTemplate(defaultMessage('confirmation', 'sms', 'invitee').body, varsFor('invitee'));
    expect(confirmation).toBe("Hi Alexandria, you're booked: Quarterly partnership review with Jimi Cohen on Tue, Nov 17, 2:30 PM PST.");
  });

  it('reads naturally once filled in', () => {
    const invitee = varsFor('invitee');
    const confirmation = defaultMessage('confirmation', 'email', 'invitee');
    expect(renderTemplate(confirmation.subject, invitee)).toBe('Confirmed: Quarterly partnership review with Jimi Cohen, Tue, Nov 17, 2:30 PM PST');
    expect(renderTemplate(confirmation.heading, invitee)).toBe("You're booked");
    expect(renderTemplate(confirmation.body, invitee)).toContain(
      "You're all set. Your Quarterly partnership review with Jimi Cohen is confirmed for Tuesday, November 17, 2026 at 2:30 PM PST.",
    );

    const reminder = defaultMessage('reminder', 'email', 'invitee');
    expect(renderTemplate(reminder.subject, invitee)).toBe('Reminder: Quarterly partnership review with Jimi Cohen is today at 2:30 PM PST');
    expect(renderTemplate(reminder.heading, invitee)).toBe('Your meeting is today');

    const hostVars = varsFor('host');
    const hostNew = defaultMessage('host_new', 'email', 'host');
    expect(renderTemplate(hostNew.subject, hostVars)).toBe(
      'New booking: Alexandria Montgomery-Fitzgerald for Quarterly partnership review, Tue, Nov 17, 5:30 PM EST',
    );
    expect(renderTemplate(hostNew.body, hostVars)).toContain('Hi Jimi,');
    expect(renderTemplate(hostNew.body, hostVars)).toContain(
      'Alexandria Montgomery-Fitzgerald just booked time with you: Quarterly partnership review, Tuesday, November 17, 2026 at 5:30 PM EST.',
    );

    const cancelled = renderTemplate(defaultMessage('cancelled', 'email', 'host').body, hostVars);
    expect(cancelled).toContain('was cancelled by Alexandria Montgomery-Fitzgerald.');
    expect(cancelled).toContain('Reason given: Something came up at work');
    const noReason = renderTemplate(defaultMessage('cancelled', 'email', 'host').body, { ...hostVars, cancel_reason: '', cancelled_by: '' });
    expect(noReason).toContain('was cancelled.');
    expect(noReason).not.toContain('Reason given');

    const moved = renderTemplate(defaultMessage('rescheduled', 'email', 'invitee').body, invitee);
    expect(moved).toContain('The new time is Tuesday, November 17, 2026 at 2:30 PM PST. The old time was Monday, November 16, 2026 at 2:30 PM PST.');
  });

  it('opens the reminder call by saying it is an AI and why it is calling', () => {
    const line = renderTemplate(defaultMessage('reminder', 'call', 'invitee').body, varsFor('invitee'));
    expect(line).toBe(
      'Hi Alexandria, this is Ava, an AI assistant calling for Jimi Cohen. A quick reminder about your Quarterly partnership review today at 2:30 PM your time. Are you still able to make it?',
    );
  });

  it("names the reader's zone wherever a subject gives a time, and keeps subjects short", () => {
    const kinds = ['confirmation', 'host_new', 'rescheduled', 'cancelled', 'reminder', 'followup', 'manage_link', 'host_alert'] as const;
    for (const audience of AUDIENCES) {
      const vars = varsFor(audience);
      for (const kind of kinds) {
        const subject = renderTemplate(defaultMessage(kind, 'email', audience).subject, vars);
        if (subject.includes(vars.time)) expect(subject, `${kind}/${audience}`).toContain(`${vars.time} ${vars.timezone_short}`);
        expect(subject.length, `${kind}/${audience}: ${subject}`).toBeLessThan(120);
      }
    }
    expect(renderTemplate(defaultMessage('rescheduled', 'email', 'host').subject, varsFor('host'))).toBe(
      'Rescheduled: Alexandria Montgomery-Fitzgerald for Quarterly partnership review, now Tue, Nov 17, 5:30 PM EST',
    );
    expect(renderTemplate(defaultMessage('cancelled', 'email', 'invitee').subject, varsFor('invitee'))).toBe(
      'Cancelled: Quarterly partnership review with Jimi Cohen, Tue, Nov 17, 2:30 PM PST',
    );
  });

  it('gives hosts and invitees different words, and treats host_new as the confirmation', () => {
    expect(defaultMessage('reminder', 'email', 'host').body).not.toBe(defaultMessage('reminder', 'email', 'invitee').body);
    expect(defaultMessage('host_new', 'email', 'invitee')).toEqual(defaultMessage('confirmation', 'email', 'invitee'));
    expect(defaultMessage('confirmation', 'email', 'host')).toEqual(defaultMessage('host_new', 'email', 'host'));
  });

  it('returns a copy, so callers cannot change the built-in wording', () => {
    const first = defaultMessage('reminder', 'sms', 'invitee');
    first.body = 'changed';
    expect(defaultMessage('reminder', 'sms', 'invitee').body).not.toBe('changed');
  });
});

describe('the real time formatter', () => {
  it('still produces the formats the wording was written for', async () => {
    const real = await vi.importActual<typeof import('../../server/lib/time')>('../../server/lib/time');
    const ms = Date.parse('2026-11-17T22:30:00Z');
    expect(real.formatInZone(ms, 'America/New_York', 'time')).toBe('5:30 PM');
    expect(real.formatInZone(ms, 'America/New_York', 'date')).toBe('Tuesday, November 17, 2026');
    expect(real.formatInZone(ms, 'America/New_York', 'short')).toBe('Tue, Nov 17, 5:30 PM');
    expect(real.formatInZone(ms, 'America/New_York', 'full')).toBe('Tuesday, November 17, 2026 at 5:30 PM EST');
  });
});
