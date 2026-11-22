/**
 * Everything a person hears or reads about a booking made under a brand (jimicohen.com/pod): emails,
 * texts, the calendar file, the Google event, the reminder call, the template variables and the consent
 * recorded. And the other way round: with a brand fully present, the owner's own bookings are exactly
 * as before (the leak checks).
 */
import { describe, expect, it, vi } from 'vitest';
import { ECO_CHAMPIONS, brandOf, siteForBrand, viewFor } from '../../shared/brands';
import { DEFAULT_CONSENT_TEXT, newEventType } from '../../shared/defaults';
import type { Booking, EventType, Host, Job } from '../../shared/types';

vi.mock('../../server/lib/sms', () => ({ sendSms: vi.fn(async () => ({ ok: true, provider: 'mock' })) }));

import { brandLineFor, calendarEventInput, createBooking } from '../../server/lib/booking';
import { buildBookingIcs } from '../../server/lib/ics';
import { brandedText, composeBookingSms, deliverMessage } from '../../server/lib/jobs';
import * as repo from '../../server/lib/repo';
import { sendSms } from '../../server/lib/sms';
import { buildVars } from '../../server/lib/templates';
import { buildCallScript, buildSystemPrompt, callPhrases, estimateSpeechSeconds } from '../../server/lib/voice';
import { makeTestCtx, markSetUp, TEST_BASE_URL, TEST_NOW, type TestCtx } from '../helpers/ctx';

const ECO = 'brand_eco_champions';
const START = '2026-11-17T20:00:00.000Z'; // the next day, 3 PM in New York
const END = '2026-11-17T20:30:00.000Z';

interface Sent {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  attachments?: { filename: string; content: string }[];
}

interface World {
  ctx: TestCtx;
  emails: Sent[];
  pod: EventType;
  intro: EventType;
  hosts: Host[];
}

/** The site, Jimi and Ian, "Intro call" and the pod meeting. `brand: true`: the brand fully present (event, link map, stored changes). */
async function world(opts: { brand: boolean }): Promise<World> {
  const emails: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(input)}`);
    emails.push(JSON.parse(String(init.body)) as Sent);
    return Response.json({ id: `email_${emails.length}` });
  }) as typeof fetch;
  const ctx = makeTestCtx({ fetch: fetchImpl });
  const site = await repo.getSite(ctx);
  const changed = { ...structuredClone(ECO_CHAMPIONS.theme), radius: 6 };
  await repo.saveSite(ctx, {
    ...site,
    email: { provider: 'auto', fromName: 'Jimi Cohen', fromEmail: 'meet@jimicohen.com', replyTo: 'jimi@jimicohen.com' },
    ...(opts.brand ? { brands: [{ id: ECO, theme: changed, emailFromName: 'Eco Champions', updatedAt: TEST_NOW }], shortLinks: { meet: 'evt_meeting', pod: 'evt_pod' } } : {}),
  });
  await repo.saveSecrets(ctx, { resend: { apiKey: 're_test' } });
  await repo.updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com', timezone: 'America/New_York' }));
  const owner = (await repo.getHost(ctx, 'host_owner'))!;
  await repo.saveHost(ctx, { ...owner, id: 'host_ian', role: 'member', name: 'Ian Poirier', email: 'ian@example.com', timezone: 'America/Toronto' });
  const pod = await repo.saveEventType(
    ctx,
    newEventType(TEST_NOW, {
      id: 'evt_pod',
      slug: 'eco-champions',
      title: 'Eco Champions conversation',
      kind: 'collective',
      hostIds: ['host_owner', 'host_ian'],
      color: '#c2417a',
      visibility: 'unlisted',
      position: 2,
      ...(opts.brand ? { brandId: ECO } : {}),
    }),
  );
  const intro = (await repo.getEventType(ctx, 'evt_intro'))!;
  return { ctx, emails, pod, intro, hosts: await repo.listHosts(ctx) };
}

function booking(id: string, et: EventType, over: Partial<Booking> = {}): Booking {
  return {
    id,
    eventTypeId: et.id,
    eventSlug: et.slug,
    eventTitle: et.title,
    kind: et.kind,
    hostIds: [...et.hostIds],
    start: START,
    end: END,
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Ann Lee', email: 'ann@example.com', phone: '+14155552671', timezone: 'America/New_York' },
    guests: [],
    answers: [{ questionId: 'q_topic', label: 'What would you like to talk about?', value: 'Trees' }],
    location: { type: 'google_meet', label: 'Google Meet' },
    consent: { sms: true, call: true, at: TEST_NOW, text: 'agreed' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [{ at: TEST_NOW, type: 'created' }],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...over,
  };
}

function job(bookingId: string, kind: Job['kind'], audience: 'invitee' | 'host' = 'invitee'): Job {
  return { key: `jobs/${TEST_NOW}_${kind}`, id: `job_${kind}_${audience}`, type: 'message', bookingId, dueAt: TEST_NOW, channel: 'email', audience, kind, attempt: 0, createdAt: TEST_NOW };
}

function icsOf(sent: Sent): string {
  const file = sent.attachments?.[0];
  return file ? Buffer.from(file.content, 'base64').toString('utf8').replace(/\r\n /g, '') : '';
}

describe('emails about a booking made under Eco Champions', () => {
  it('to the invitee: from Eco Champions, its logo, its green, its footer, and the brand line in the calendar file', async () => {
    const w = await world({ brand: true });
    await repo.saveBooking(w.ctx, booking('bkg_pod', w.pod, { brandId: ECO }));
    const result = await deliverMessage(w.ctx, job('bkg_pod', 'confirmation'));
    expect(result.ok).toBe(true);
    const sent = w.emails[0];
    expect(sent.from).toBe('Eco Champions <meet@jimicohen.com>');
    // The address and the reply-to stay the site's.
    expect(sent.reply_to).toBe('jimi@jimicohen.com');
    expect(sent.subject).toBe('Confirmed: Eco Champions conversation with Jimi and Ian, Tue, Nov 17, 3:00 PM EST');
    expect(sent.html).toContain(`<img src="${TEST_BASE_URL}/api/assets/builtin_eco_champions_email" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border-radius:8px;border:0;">`);
    expect(sent.html).toContain('>Eco Champions</td>');
    // The brand's own green on the buttons, never the event's colour.
    expect(sent.html).toContain('bgcolor="#14432f"');
    expect(sent.html).not.toContain('#c2417a');
    expect(sent.html).toContain('You are getting this email because a meeting was booked with Eco Champions using this address.');
    expect(sent.text).toContain('You are getting this email because a meeting was booked with Eco Champions using this address.');
    expect(icsOf(sent)).toContain('Booked through Eco Champions: https://jimicohen.com/pod');
    expect(sent.html).not.toContain('Jimi Cohen</td>');
  });

  it('to the hosts: from Eco Champions, with the brand footer', async () => {
    const w = await world({ brand: true });
    await repo.saveBooking(w.ctx, booking('bkg_pod', w.pod, { brandId: ECO }));
    await deliverMessage(w.ctx, job('bkg_pod', 'host_new', 'host'));
    expect(w.emails.map((e) => e.to[0]).sort()).toEqual(['Ian Poirier <ian@example.com>', 'Jimi Cohen <jimi@example.com>']);
    for (const sent of w.emails) {
      expect(sent.from).toBe('Eco Champions <meet@jimicohen.com>');
      expect(sent.html).toContain('Sent by the Eco Champions booking page.');
      // Hosts answer the invitee directly.
      expect(sent.reply_to).toBe('ann@example.com');
    }
  });

  it("uses the brand's uploaded logo and sender name once the owner set them", async () => {
    const w = await world({ brand: true });
    await repo.updateSite(w.ctx, (s) => ({ ...s, brands: [{ ...s.brands![0], emailFromName: 'Eco Champions Studio', theme: { ...s.brands![0].theme, logoAssetId: 'ast_ecologo' } }] }));
    await repo.saveBooking(w.ctx, booking('bkg_pod', w.pod, { brandId: ECO }));
    await deliverMessage(w.ctx, job('bkg_pod', 'reminder'));
    expect(w.emails[0].from).toBe('Eco Champions Studio <meet@jimicohen.com>');
    expect(w.emails[0].html).toContain(`${TEST_BASE_URL}/api/assets/ast_ecologo`);
  });

  it('a cancellation offers to book again at jimicohen.com/pod', async () => {
    const w = await world({ brand: true });
    await repo.saveBooking(w.ctx, booking('bkg_pod', w.pod, { brandId: ECO, status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee' } }));
    await deliverMessage(w.ctx, job('bkg_pod', 'cancelled'));
    expect(w.emails[0].html).toContain('href="https://jimicohen.com/pod"');
  });
});

describe('the leak checks: with the brand fully present, the owner own bookings are exactly as before', () => {
  for (const [label, which] of [
    ['a booking of Intro call', 'intro'],
    ['a booking made before the pod meeting had the brand', 'pod'],
  ] as const) {
    it(`${label}: the same emails, byte for byte`, async () => {
      const before = await world({ brand: false });
      const after = await world({ brand: true });
      for (const w of [before, after]) {
        await repo.saveBooking(w.ctx, booking('bkg_x', which === 'intro' ? w.intro : w.pod));
        for (const kind of ['confirmation', 'reminder', 'cancelled'] as const) await deliverMessage(w.ctx, job('bkg_x', kind));
        await deliverMessage(w.ctx, job('bkg_x', 'host_new', 'host'));
      }
      expect(after.emails).toEqual(before.emails);
      const all = JSON.stringify(after.emails);
      expect(all).not.toContain('Eco Champions <');
      expect(all).not.toContain('builtin_eco_champions_email');
      expect(all).not.toContain('Booked through');
      expect(all).not.toContain('#14432f');
    });
  }

  it('the same texts, and the same calendar file', async () => {
    const before = await world({ brand: false });
    const after = await world({ brand: true });
    for (const which of ['intro', 'pod'] as const) {
      const [sb, sa] = await Promise.all([repo.getSite(before.ctx), repo.getSite(after.ctx)]);
      const bb = booking('bkg_y', which === 'intro' ? before.intro : before.pod);
      const ba = booking('bkg_y', which === 'intro' ? after.intro : after.pod);
      for (const kind of ['confirmation', 'reminder', 'cancelled'] as const) {
        const tb = composeBookingSms(before.ctx, { booking: bb, eventType: null, hosts: before.hosts, site: viewFor(sb, bb), kind, audience: 'invitee' });
        const ta = composeBookingSms(after.ctx, { booking: ba, eventType: null, hosts: after.hosts, site: viewFor(sa, ba), kind, audience: 'invitee' });
        expect(ta).toBe(tb);
        expect(ta).not.toMatch(/^Eco Champions:/);
      }
      expect(brandLineFor(after.ctx, sa, ba)).toBeNull();
      const icsB = buildBookingIcs({ booking: bb, hosts: before.hosts, site: sb, method: 'REQUEST', baseUrl: TEST_BASE_URL, brandLine: brandLineFor(before.ctx, sb, bb) });
      const icsA = buildBookingIcs({ booking: ba, hosts: after.hosts, site: sa, method: 'REQUEST', baseUrl: TEST_BASE_URL, brandLine: brandLineFor(after.ctx, sa, ba) });
      expect(icsA).toBe(icsB);
    }
  });
});

describe('texts about a branded booking name the brand', () => {
  it('in front, unless the text already says it', async () => {
    const w = await world({ brand: true });
    const site = await repo.getSite(w.ctx);
    const pod = booking('bkg_pod', w.pod, { brandId: ECO });
    const view = viewFor(site, pod);
    const confirmation = composeBookingSms(w.ctx, { booking: pod, eventType: w.pod, hosts: w.hosts, site: view, kind: 'confirmation', audience: 'invitee' });
    expect(confirmation.startsWith("Hi Ann, you're booked: Eco Champions conversation with Jimi and Ian")).toBe(true);
    // A meeting whose title does not say the brand gets it in front.
    const sponsor = { ...pod, eventTitle: 'Sponsor call' };
    const text = composeBookingSms(w.ctx, { booking: sponsor, eventType: w.pod, hosts: w.hosts, site: view, kind: 'reminder', audience: 'invitee' });
    expect(text.startsWith('Eco Champions: Hi Ann, a reminder: Sponsor call with Jimi and Ian')).toBe(true);
    const cancelled = composeBookingSms(w.ctx, { booking: { ...pod, status: 'cancelled' }, eventType: w.pod, hosts: w.hosts, site: view, kind: 'cancelled', audience: 'invitee' });
    expect(cancelled).toContain('Book a new time: https://jimicohen.com/pod');
    expect(brandedText(site, 'Hi there')).toBe('Hi there');
    expect(brandedText(view, 'hi from eco champions')).toBe('hi from eco champions');
  });

  it('through the job runner too', async () => {
    const w = await world({ brand: true });
    await repo.saveBooking(w.ctx, booking('bkg_pod', { ...w.pod, title: 'Sponsor call' }, { brandId: ECO }));
    vi.mocked(sendSms).mockClear();
    await deliverMessage(w.ctx, { ...job('bkg_pod', 'reminder'), channel: 'sms' });
    expect(vi.mocked(sendSms).mock.calls[0][1].body).toMatch(/^Eco Champions: Hi Ann, a reminder: Sponsor call/);
  });
});

describe('"Meeting with Jimi", the meeting behind jimicohen.com/meet', () => {
  it('is never "Meeting with Jimi with Jimi Cohen" in emails, texts or the reminder call', async () => {
    const w = await world({ brand: true });
    const meetEvent = { ...(await repo.getEventType(w.ctx, 'evt_meeting'))!, title: 'Meeting with Jimi' };
    await repo.saveEventType(w.ctx, meetEvent);
    await repo.saveBooking(w.ctx, booking('bkg_meet', meetEvent));
    await deliverMessage(w.ctx, job('bkg_meet', 'confirmation'));
    await deliverMessage(w.ctx, job('bkg_meet', 'reminder', 'host'));
    const [invitee, host] = w.emails;
    expect(invitee.subject).toBe('Confirmed: Meeting with Jimi, Tue, Nov 17, 3:00 PM EST');
    expect(invitee.text).toContain('Your Meeting with Jimi is confirmed for');
    expect(host.subject).toBe('Reminder: Meeting with Jimi (Ann Lee) is tomorrow at 3:00 PM EST');
    for (const m of [invitee, host]) expect(`${m.subject} ${m.text}`).not.toMatch(/Meeting with Jimi with/);
    const site = await repo.getSite(w.ctx);
    const meetBooking = booking('bkg_meet', meetEvent);
    const text = composeBookingSms(w.ctx, { booking: meetBooking, eventType: meetEvent, hosts: w.hosts, site, kind: 'confirmation', audience: 'invitee' });
    expect(text.startsWith("Hi Ann, you're booked: Meeting with Jimi on ")).toBe(true);
    const call = callPhrases(buildCallScript({ booking: meetBooking, site, hosts: w.hosts, purpose: 'reminder' }), Date.parse(TEST_NOW), 'reminder');
    expect(call.repeat).toMatch(/^Of course\. This is a reminder about your Meeting with Jimi, /);
    // A name that names only some of the hosts keeps them, in brackets; every other name reads as before.
    const pod = booking('bkg_pod2', { ...w.pod, title: 'Coffee with Jimi' }, { brandId: ECO });
    const coffee = composeBookingSms(w.ctx, { booking: pod, eventType: w.pod, hosts: w.hosts, site: viewFor(site, pod), kind: 'confirmation', audience: 'invitee' });
    expect(coffee).toContain("you're booked: Coffee with Jimi (Jimi and Ian) on ");
    const intro = composeBookingSms(w.ctx, { booking: booking('bkg_i', w.intro), eventType: w.intro, hosts: w.hosts, site, kind: 'confirmation', audience: 'invitee' });
    expect(intro).toContain("you're booked: Intro call with Jimi Cohen on ");
  });
});

describe('template variables', () => {
  it('site_name is the brand, book_url the short link that shows the booking look', async () => {
    const w = await world({ brand: true });
    const site = await repo.getSite(w.ctx);
    const pod = booking('bkg_pod', w.pod, { brandId: ECO });
    const vars = buildVars(w.ctx, { booking: pod, eventType: w.pod, hosts: w.hosts, site: viewFor(site, pod), audience: 'invitee' });
    expect(vars.site_name).toBe('Eco Champions');
    expect(vars.book_url).toBe('https://jimicohen.com/pod');
    expect(vars.host_names).toBe('Jimi and Ian');
    const intro = booking('bkg_intro', w.intro);
    const own = buildVars(w.ctx, { booking: intro, eventType: w.intro, hosts: w.hosts, site: viewFor(site, intro), audience: 'invitee' });
    expect(own.site_name).toBe('Jimi Cohen');
    expect(own.book_url).toBe(`${TEST_BASE_URL}/intro`);
    // With no host on record the brand is never cut to its first word.
    const lone = buildVars(w.ctx, { booking: { ...pod, hostIds: [] }, eventType: w.pod, hosts: [], site: viewFor(site, pod), audience: 'invitee' });
    expect(lone.host_first_name).toBe('Eco Champions');
  });

  it('times are written with the owner clock under the brand too', async () => {
    const w = await world({ brand: true });
    await repo.updateSite(w.ctx, (s) => ({ ...s, theme: { ...s.theme, timeFormat: '24h' } }));
    const site = await repo.getSite(w.ctx);
    const pod = booking('bkg_pod', w.pod, { brandId: ECO });
    const intro = booking('bkg_intro', w.intro);
    expect(buildVars(w.ctx, { booking: pod, eventType: w.pod, hosts: w.hosts, site: viewFor(site, pod), audience: 'invitee' }).time).toBe('15:00');
    expect(buildVars(w.ctx, { booking: intro, eventType: w.intro, hosts: w.hosts, site: viewFor(site, intro), audience: 'invitee' }).time).toBe('15:00');
  });
});

describe('the Google Calendar event', () => {
  it('starts its description with the brand line, with and without guests', async () => {
    const w = await world({ brand: true });
    const site = await repo.getSite(w.ctx);
    const owner = w.hosts.find((h) => h.id === 'host_owner')!;
    const pod = booking('bkg_pod', w.pod, { brandId: ECO });
    const input = calendarEventInput(w.ctx, pod, w.pod, owner, w.hosts, site);
    expect(input.summary).toBe('Eco Champions conversation: Ann Lee, Jimi Cohen and Ian Poirier');
    expect(input.description.split('\n')[0]).toBe('Booked through Eco Champions: https://jimicohen.com/pod');
    const guests = calendarEventInput(w.ctx, { ...pod, guests: ['bo@example.com'] }, w.pod, owner, w.hosts, site);
    expect(guests.description.split('\n')[0]).toBe('Booked through Eco Champions: https://jimicohen.com/pod');
    // The owner's own bookings: the description as before.
    const intro = booking('bkg_intro', w.intro);
    expect(calendarEventInput(w.ctx, intro, w.intro, owner, w.hosts, site).description).toBe(calendarEventInput(w.ctx, intro, w.intro, owner, w.hosts).description);
    expect(calendarEventInput(w.ctx, intro, w.intro, owner, w.hosts, site).description).not.toContain('Booked through');
  });
});

describe('the reminder call', () => {
  async function script(brand: boolean, hostIds = ['host_owner', 'host_ian']) {
    const w = await world({ brand: true });
    const site = await repo.getSite(w.ctx);
    const b = booking('bkg_pod', { ...w.pod, hostIds }, brand ? { brandId: ECO } : {});
    return buildCallScript({ booking: b, site: viewFor(site, b), hosts: w.hosts, purpose: 'reminder' });
  }
  const NOW = Date.parse('2026-11-16T17:00:00.000Z');

  it('calls for Eco Champions, on behalf of the hosts', async () => {
    const s = await script(true);
    expect(s.brandName).toBe('Eco Champions');
    const p = callPhrases(s, NOW);
    expect(p.greeting).toBe('Hi Ann, this is Ava, an AI assistant calling for Eco Champions. A quick reminder about your Eco Champions conversation with Jimi and Ian tomorrow at 3:00 PM your time. Are you still able to make it?');
    expect(p.identity).toBe('I am Ava, an AI assistant calling for Eco Champions. I am calling about your Eco Champions conversation with Jimi and Ian, tomorrow at 3:00 PM your time. Will you be able to make it?');
    expect(p.voicemail).toBe(
      'Hi Ann, this is Ava, an AI assistant calling for Eco Champions. A reminder: your Eco Champions conversation is tomorrow at 3:00 PM your time. To change it, use the link I am texting you now. Goodbye.',
    );
    expect(estimateSpeechSeconds(p.voicemail)).toBeLessThan(17);
    // The people are still the hosts.
    expect(p.cancelled).toBe('Okay, your Eco Champions conversation is cancelled, and I will let Jimi and Ian know. Goodbye.');
    const prompt = buildSystemPrompt(s, NOW);
    expect(prompt).toContain('a live phone call that you placed for Eco Champions, on behalf of Jimi Cohen and Ian Poirier,');
    expect(prompt).toContain('say plainly that you are an AI assistant calling for Eco Champions.');
    expect(prompt).toContain('suggest they contact Jimi and Ian directly');
  });

  it('a solo branded meeting is "with Jimi"', async () => {
    const p = callPhrases(await script(true, ['host_owner']), NOW);
    expect(p.greeting).toContain('calling for Eco Champions. A quick reminder about your Eco Champions conversation with Jimi tomorrow');
  });

  it('a call record from before brands speaks exactly as before', async () => {
    const plain = await script(false);
    expect(plain.brandName).toBeUndefined();
    const { brandName: _gone, ...older } = await script(true);
    expect(callPhrases(older, NOW)).toEqual(callPhrases(plain, NOW));
    // The first sentence names who is responsible for the call in full (47 CFR 64.1200(b)(1)).
    expect(callPhrases(plain, NOW).greeting).toBe('Hi Ann, this is Ava, an AI assistant calling for Jimi Cohen and Ian Poirier. A quick reminder about your Eco Champions conversation tomorrow at 3:00 PM your time. Are you still able to make it?');
  });
});

describe('a new booking', () => {
  it('records the brand of its event, and the site consent wording', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:00.000Z' });
    await repo.getSite(ctx);
    await markSetUp(ctx);
    await repo.updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com' }));
    await repo.saveEventType(ctx, newEventType(TEST_NOW, { id: 'evt_pod', slug: 'eco-champions', title: 'Eco Champions conversation', brandId: ECO, durations: [30, 60], position: 2 }));
    const req = { slug: 'eco-champions', start: '2026-11-18T14:00:00.000Z', durationMin: 30, name: 'Ann Lee', email: 'ann@example.com', timezone: 'Europe/London', elapsedMs: 5200 };
    const { booking: made } = await createBooking(ctx, req);
    expect(made.brandId).toBe(ECO);
    const plain = await createBooking(ctx, { ...req, slug: 'intro', durationMin: 15, start: '2026-11-18T15:00:00.000Z', email: 'bo@example.com' });
    expect(plain.booking.brandId).toBeUndefined();
    expect((await repo.getSite(ctx)).booking.consentText).toBe(DEFAULT_CONSENT_TEXT);
  });

  it('the consent shown on a branded page reads the same as the one recorded', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:00.000Z' });
    await repo.getSite(ctx);
    await markSetUp(ctx);
    const site = await repo.getSite(ctx);
    const view = siteForBrand(site, brandOf(site, { brandId: ECO })!);
    // The wording stays the site's: Jimi's assistant calls on his behalf on /pod too.
    expect(view.booking.consentText).toBe(DEFAULT_CONSENT_TEXT);
  });
});
