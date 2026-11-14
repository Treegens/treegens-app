import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSite } from '../../shared/defaults';
import { contrastRatio, readableOn } from '../../shared/theme';
import type { HostGoogle, SiteSettings } from '../../shared/types';
import { getSite, saveSecrets, saveSite, updateHost } from '../../server/lib/repo';
import { makeTestCtx, TEST_NOW, type TestCtx } from '../helpers/ctx';

// google.ts belongs to another engineer: Gmail sending is replaced by a spy.
vi.mock('../../server/lib/google', () => ({ gmailSendRaw: vi.fn() }));

import { gmailSendRaw } from '../../server/lib/google';
import {
  buildMime,
  pickEmailProvider,
  renderEmailHtml,
  renderEmailText,
  resolveEmailProvider,
  safeUrl,
  sendEmail,
  type EmailMessage,
} from '../../server/lib/email';

const gmailSend = vi.mocked(gmailSendRaw);

const GOOGLE: HostGoogle = {
  email: 'jimi@gmail.example',
  refreshTokenEnc: 'sealed',
  scopes: [],
  busyCalendarIds: ['primary'],
  writeCalendarId: 'primary',
  gmailSend: true,
  status: 'ok',
  connectedAt: TEST_NOW,
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Record<string, string>;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => Response.json({ id: 'email_123' })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      init,
      body: init.body ? JSON.parse(String(init.body)) : {},
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function configure(
  ctx: TestCtx,
  opts: { provider?: SiteSettings['email']['provider']; fromEmail?: string; replyTo?: string; resendKey?: string; gmail?: boolean; ownerEmail?: string },
): Promise<void> {
  const site = await getSite(ctx);
  await saveSite(ctx, {
    ...site,
    email: { provider: opts.provider ?? 'auto', fromName: 'Jimi Cohen', fromEmail: opts.fromEmail ?? '', replyTo: opts.replyTo ?? '' },
  });
  if (opts.resendKey) await saveSecrets(ctx, { resend: { apiKey: opts.resendKey } });
  await updateHost(ctx, 'host_owner', (h) => ({ ...h, email: opts.ownerEmail ?? 'jimi@example.com', google: opts.gmail ? { ...GOOGLE } : null }));
}

const MESSAGE: EmailMessage = {
  to: 'sam@example.com',
  toName: 'Sam Rivera',
  subject: 'Confirmed: Intro call with Jimi Cohen',
  text: 'Plain body',
  html: '<p>HTML body</p>',
};

const ICS = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n';

beforeEach(() => {
  gmailSend.mockReset();
});

// ───────────────────────── provider ─────────────────────────

describe('pickEmailProvider', () => {
  it('prefers Resend, then Gmail, in auto mode', () => {
    expect(pickEmailProvider('auto', { resend: true, gmail: true })).toBe('resend');
    expect(pickEmailProvider('auto', { resend: false, gmail: true })).toBe('gmail');
    expect(pickEmailProvider('auto', { resend: false, gmail: false })).toBe('none');
  });

  it('never falls back when a provider is chosen explicitly', () => {
    expect(pickEmailProvider('resend', { resend: false, gmail: true })).toBe('none');
    expect(pickEmailProvider('gmail', { resend: true, gmail: false })).toBe('none');
    expect(pickEmailProvider('resend', { resend: true, gmail: true })).toBe('resend');
    expect(pickEmailProvider('gmail', { resend: true, gmail: true })).toBe('gmail');
    expect(pickEmailProvider('none', { resend: true, gmail: true })).toBe('none');
  });
});

describe('resolveEmailProvider', () => {
  it('is none on a fresh install', async () => {
    expect(await resolveEmailProvider(makeTestCtx())).toBe('none');
  });

  it('uses Resend only with both a key and a from address', async () => {
    const withBoth = makeTestCtx();
    await configure(withBoth, { resendKey: 're_test', fromEmail: 'meet@jimicohen.com' });
    expect(await resolveEmailProvider(withBoth)).toBe('resend');

    const keyOnly = makeTestCtx();
    await configure(keyOnly, { resendKey: 're_test' });
    expect(await resolveEmailProvider(keyOnly)).toBe('none');

    const badFrom = makeTestCtx();
    await configure(badFrom, { resendKey: 're_test', fromEmail: 'not an address' });
    expect(await resolveEmailProvider(badFrom)).toBe('none');
  });

  it('accepts a Resend key from the environment', async () => {
    const ctx = makeTestCtx({ env: { overrides: { resendApiKey: 're_env' } } });
    await configure(ctx, { fromEmail: 'meet@jimicohen.com' });
    expect(await resolveEmailProvider(ctx)).toBe('resend');
  });

  it("falls back to the owner's Gmail when it may send", async () => {
    const ctx = makeTestCtx();
    await configure(ctx, { resendKey: 're_test', gmail: true }); // key but no from address
    expect(await resolveEmailProvider(ctx)).toBe('gmail');

    await updateHost(ctx, 'host_owner', (h) => ({ ...h, google: { ...GOOGLE, gmailSend: false } }));
    expect(await resolveEmailProvider(ctx)).toBe('none');
  });

  it('honours an explicit setting', async () => {
    const ctx = makeTestCtx();
    await configure(ctx, { provider: 'gmail', resendKey: 're_test', fromEmail: 'meet@jimicohen.com', gmail: true });
    expect(await resolveEmailProvider(ctx)).toBe('gmail');
    await saveSite(ctx, { ...(await getSite(ctx)), email: { provider: 'none', fromName: 'J', fromEmail: 'meet@jimicohen.com', replyTo: '' } });
    expect(await resolveEmailProvider(ctx)).toBe('none');
  });
});

// ───────────────────────── sending ─────────────────────────

describe('sendEmail with Resend', () => {
  it('posts the documented request and reports the message id', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const ctx = makeTestCtx({ fetch: fetchImpl });
    await configure(ctx, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com', replyTo: 'hello@jimicohen.com' });

    const result = await sendEmail(ctx, {
      ...MESSAGE,
      ics: { filename: 'invite.ics', content: ICS, method: 'REQUEST' },
      idempotencyKey: 'job_abc-invitee',
    });
    expect(result).toEqual({ ok: true, provider: 'resend', id: 'email_123' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer re_secret');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['Idempotency-Key']).toBe('job_abc-invitee');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toEqual({
      from: 'Jimi Cohen <meet@jimicohen.com>',
      to: ['Sam Rivera <sam@example.com>'],
      subject: 'Confirmed: Intro call with Jimi Cohen',
      html: '<p>HTML body</p>',
      text: 'Plain body',
      reply_to: 'hello@jimicohen.com',
      attachments: [
        { filename: 'invite.ics', content: Buffer.from(ICS).toString('base64'), content_type: 'text/calendar; charset=UTF-8; method=REQUEST' },
      ],
    });
  });

  it('replies to the owner when no reply-to is set, and to the message reply-to when given', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const ctx = makeTestCtx({ fetch: fetchImpl });
    await configure(ctx, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com', ownerEmail: 'owner@example.com' });
    await sendEmail(ctx, MESSAGE);
    await sendEmail(ctx, { ...MESSAGE, replyTo: 'sam@example.com' });
    await sendEmail(ctx, { ...MESSAGE, replyTo: 'broken\r\nBcc: x@example.com' });
    expect(calls.map((c) => c.body.reply_to)).toEqual(['owner@example.com', 'sam@example.com', 'owner@example.com']);
    expect(calls[0].body.attachments).toBeUndefined();
    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('strips line breaks and control characters from the subject and names', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const ctx = makeTestCtx({ fetch: fetchImpl });
    await configure(ctx, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com' });
    await sendEmail(ctx, { ...MESSAGE, subject: 'Hello\r\nBcc: evil@example.com\u0000', toName: 'Sam "the\r\nman" <x@y.z>' });
    expect(calls[0].body.subject).toBe('Hello Bcc: evil@example.com');
    expect(calls[0].body.to).toEqual(['Sam the man x y.z <sam@example.com>']);
    expect(JSON.stringify(calls[0].headers)).not.toMatch(/\\r|\\n/);
  });

  it('turns a provider error into a failed result without throwing', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ statusCode: 422, name: 'validation_error', message: 'The from address is not verified' }, { status: 422 }));
    const ctx = makeTestCtx({ fetch: fetchImpl });
    await configure(ctx, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com' });
    const result = await sendEmail(ctx, MESSAGE);
    expect(result.ok).toBe(false);
    expect(result.provider).toBe('resend');
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBe('Resend answered 422: The from address is not verified');
    expect(result.error).not.toContain('re_secret');
  });

  it('turns a network failure or a non-JSON answer into a failed result', async () => {
    const down = makeTestCtx({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await configure(down, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com' });
    expect(await sendEmail(down, MESSAGE)).toEqual({ ok: false, provider: 'resend', error: 'fetch failed' });

    const { fetchImpl } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const gateway = makeTestCtx({ fetch: fetchImpl });
    await configure(gateway, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com' });
    const result = await sendEmail(gateway, MESSAGE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('502');
  });

  it('skips, without any network call, when the recipient is unusable or nothing is configured', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const ctx = makeTestCtx({ fetch: fetchImpl });
    expect(await sendEmail(ctx, MESSAGE)).toEqual({ ok: false, provider: 'none', skipped: 'email_not_configured' });
    await configure(ctx, { resendKey: 're_secret', fromEmail: 'meet@jimicohen.com' });
    expect(await sendEmail(ctx, { ...MESSAGE, to: 'sam@example.com\r\nBcc: evil@example.com' })).toEqual({ ok: false, provider: 'none', skipped: 'invalid_recipient' });
    expect(await sendEmail(ctx, { ...MESSAGE, to: 'a@b.co, c@d.co' })).toEqual({ ok: false, provider: 'none', skipped: 'invalid_recipient' });
    expect(calls).toHaveLength(0);
  });

  it('hands mail to the local mock when providers are mocked and nothing is configured', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const ctx = makeTestCtx({ fetch: fetchImpl, env: { mockProviders: true } });
    const result = await sendEmail(ctx, MESSAGE);
    expect(result).toEqual({ ok: true, provider: 'mock', id: 'email_123' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].body.to).toEqual(['Sam Rivera <sam@example.com>']);

    // switched off on purpose stays off, mock or not
    await configure(ctx, { provider: 'none' });
    expect(await sendEmail(ctx, MESSAGE)).toEqual({ ok: false, provider: 'none', skipped: 'email_not_configured' });
    expect(calls).toHaveLength(1);
  });
});

describe('sendEmail with Gmail', () => {
  it("sends a raw message as the owner's connected account", async () => {
    gmailSend.mockResolvedValue({ id: 'gmail_1' });
    const ctx = makeTestCtx({ now: '2026-11-17T12:00:00Z' });
    await configure(ctx, { gmail: true, ownerEmail: 'owner@example.com' });
    const result = await sendEmail(ctx, MESSAGE);
    expect(result).toEqual({ ok: true, provider: 'gmail', id: 'gmail_1' });
    expect(gmailSend).toHaveBeenCalledTimes(1);
    const [, host, raw] = gmailSend.mock.calls[0];
    expect(host.id).toBe('host_owner');
    expect(raw).toContain('From: "Jimi Cohen" <jimi@gmail.example>\r\n');
    expect(raw).toContain('To: "Sam Rivera" <sam@example.com>\r\n');
    expect(raw).toContain('Reply-To: owner@example.com\r\n');
    expect(raw).toContain('Date: Tue, 17 Nov 2026 12:00:00 +0000\r\n');
  });

  it('reports a Gmail failure as a failed result', async () => {
    gmailSend.mockRejectedValue(new Error('Google needs to be reconnected'));
    const ctx = makeTestCtx();
    await configure(ctx, { gmail: true });
    expect(await sendEmail(ctx, MESSAGE)).toEqual({ ok: false, provider: 'gmail', error: 'Google needs to be reconnected' });
  });
});

// ───────────────────────── MIME ─────────────────────────

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

/** Splits a raw message (or a multipart body) into unfolded headers and body. */
function parseEntity(raw: string): MimePart {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim();
  return { headers, body: raw.slice(split + 4) };
}

function parts(entity: MimePart): MimePart[] {
  const boundary = /boundary="([^"]+)"/.exec(entity.headers['content-type'])?.[1];
  if (!boundary) throw new Error('not multipart');
  const pieces = entity.body.split(`--${boundary}`);
  expect(pieces[pieces.length - 1].startsWith('--')).toBe(true); // closing delimiter
  return pieces.slice(1, -1).map((p) => parseEntity(p.replace(/^\r\n/, '').replace(/\r\n$/, '')));
}

function decode(part: MimePart): string {
  expect(part.headers['content-transfer-encoding']).toBe('base64');
  return Buffer.from(part.body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

const FROM = { name: 'Jimi Cohen', email: 'meet@jimicohen.com' };

describe('buildMime', () => {
  it('builds a two-part alternative message', () => {
    const raw = buildMime({ ...MESSAGE, replyTo: 'hello@jimicohen.com' }, FROM, { date: new Date('2026-11-17T12:00:00Z') });
    const message = parseEntity(raw);
    expect(message.headers.from).toBe('"Jimi Cohen" <meet@jimicohen.com>');
    expect(message.headers.to).toBe('"Sam Rivera" <sam@example.com>');
    expect(message.headers['reply-to']).toBe('hello@jimicohen.com');
    expect(message.headers.subject).toBe('Confirmed: Intro call with Jimi Cohen');
    expect(message.headers.date).toBe('Tue, 17 Nov 2026 12:00:00 +0000');
    expect(message.headers['mime-version']).toBe('1.0');
    expect(message.headers['content-type']).toMatch(/^multipart\/alternative; boundary="/);
    const [text, html] = parts(message);
    expect(text.headers['content-type']).toBe('text/plain; charset=UTF-8');
    expect(html.headers['content-type']).toBe('text/html; charset=UTF-8');
    expect(decode(text)).toBe('Plain body');
    expect(decode(html)).toBe('<p>HTML body</p>');
    expect(parts(message)).toHaveLength(2);
  });

  it('uses CRLF everywhere and keeps every line short', () => {
    const raw = buildMime({ ...MESSAGE, html: `<p>${'long line '.repeat(400)}</p>`, text: 'x'.repeat(5000) }, FROM);
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const [text] = parts(parseEntity(raw));
    expect(decode(text)).toBe('x'.repeat(5000));
  });

  it('carries an invitation both inline and as an attachment', () => {
    const raw = buildMime({ ...MESSAGE, ics: { filename: 'invite.ics', content: ICS.replace(/\r\n/g, '\n'), method: 'REQUEST' } }, FROM);
    const message = parseEntity(raw);
    expect(message.headers['content-type']).toMatch(/^multipart\/mixed; boundary="/);
    const [alternative, attachment] = parts(message);
    expect(alternative.headers['content-type']).toMatch(/^multipart\/alternative; boundary="/);
    const inner = parts(alternative);
    expect(inner.map((p) => p.headers['content-type'])).toEqual([
      'text/plain; charset=UTF-8',
      'text/html; charset=UTF-8',
      'text/calendar; charset=UTF-8; method=REQUEST',
    ]);
    expect(decode(inner[2])).toBe(ICS); // line endings normalised to CRLF
    expect(attachment.headers['content-type']).toBe('application/ics; name="invite.ics"');
    expect(attachment.headers['content-disposition']).toBe('attachment; filename="invite.ics"');
    expect(decode(attachment)).toBe(ICS);
  });

  it('labels a cancellation as such', () => {
    const raw = buildMime({ ...MESSAGE, ics: { filename: 'cancelled.ics', content: ICS, method: 'CANCEL' } }, FROM);
    const [alternative] = parts(parseEntity(raw));
    expect(parts(alternative)[2].headers['content-type']).toBe('text/calendar; charset=UTF-8; method=CANCEL');
  });

  it('attaches a PUBLISH calendar without an inline copy, so nothing is added twice', () => {
    const raw = buildMime({ ...MESSAGE, ics: { filename: 'invite.ics', content: ICS, method: 'PUBLISH' } }, FROM);
    const [alternative, attachment] = parts(parseEntity(raw));
    expect(parts(alternative)).toHaveLength(2);
    expect(raw).not.toContain('text/calendar');
    expect(decode(attachment)).toBe(ICS);
  });

  it('encodes a UTF-8 subject and names as RFC 2047 words', () => {
    const subject = 'Réunion confirmée ☕ avec Zoë: 🌱 plantation à Kiambu, mardi 17 novembre à 15h30';
    const raw = buildMime({ ...MESSAGE, subject, toName: 'Zoë Åkesson' }, { name: 'Jímí Cohen', email: 'meet@jimicohen.com' });
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(headerBlock).toMatch(/^[\x00-\x7F]*$/); // headers are pure ASCII
    for (const line of headerBlock.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const message = parseEntity(raw);
    expect(message.headers.subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(message.headers.subject)).toBe(subject);
    expect(decodeWords(message.headers.to)).toBe('Zoë Åkesson<sam@example.com>');
    expect(decodeWords(message.headers.from)).toBe('Jímí Cohen<meet@jimicohen.com>');
    // each encoded word decodes on its own: no character was split between two words
    for (const word of message.headers.subject.split(' ')) expect(decodeWords(word)).not.toContain('\uFFFD');
  });

  it('folds a long plain subject at spaces', () => {
    const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const raw = buildMime({ ...MESSAGE, subject }, FROM);
    const lines = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
    const start = lines.findIndex((l) => l.startsWith('Subject:'));
    expect(lines[start + 1].startsWith(' ')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    expect(parseEntity(raw).headers.subject).toBe(subject);
  });

  it('cannot be made to carry extra headers', () => {
    const raw = buildMime(
      {
        ...MESSAGE,
        subject: 'Hi\r\nBcc: evil@example.com\nX-Injected: 1',
        toName: 'Sam\r\nCc: evil@example.com',
        replyTo: 'x@example.com\r\nBcc: evil@example.com',
        ics: { filename: 'a"\r\nX-Evil: 1\r\n.ics', content: ICS, method: 'REQUEST\r\nX-Evil: 1' as 'REQUEST' },
      },
      { name: 'Jimi\r\nBcc: evil@example.com', email: 'meet@jimicohen.com' },
    );
    const headerLines = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
    expect(headerLines.some((l) => /^(bcc|cc|x-injected|x-evil)\s*:/i.test(l))).toBe(false);
    expect(raw).not.toMatch(/\r\n(Bcc|Cc|X-Injected|X-Evil):/i);
    const message = parseEntity(raw);
    expect(message.headers.subject).toBe('Hi Bcc: evil@example.com X-Injected: 1');
    expect(message.headers['reply-to']).toBeUndefined();
    expect(message.headers.to).toBe('"Sam Cc: evil@example.com" <sam@example.com>');
    const [, attachment] = parts(message);
    expect(attachment.headers['content-type']).toBe('application/ics; name="a-X-Evil-1-.ics"');
  });

  it('escapes quotes and backslashes in display names', () => {
    const raw = buildMime({ ...MESSAGE, toName: 'Sam "Sammy" \\ Rivera' }, FROM);
    expect(parseEntity(raw).headers.to).toBe('"Sam \\"Sammy\\" \\\\ Rivera" <sam@example.com>');
  });

  it('refuses addresses that are not plain email addresses', () => {
    expect(() => buildMime({ ...MESSAGE, to: 'sam@example.com\r\nBcc: evil@example.com' }, FROM)).toThrow(/recipient/);
    expect(() => buildMime({ ...MESSAGE, to: 'Sam <sam@example.com>' }, FROM)).toThrow(/recipient/);
    expect(() => buildMime(MESSAGE, { name: 'J', email: 'nope' })).toThrow(/sender/);
  });

  it('is deterministic for the same message', () => {
    expect(buildMime(MESSAGE, FROM)).toBe(buildMime(MESSAGE, FROM));
  });
});

// ───────────────────────── HTML ─────────────────────────

describe('renderEmailHtml', () => {
  const site = defaultSite(TEST_NOW);
  const base = {
    site,
    preheader: 'Intro call with Jimi Cohen is confirmed.',
    heading: "You're booked",
    paragraphs: ['Hi Sam,', "You're all set."],
    details: [
      { label: 'When', value: 'Tuesday, November 17, 2026\n3:30 PM to 4:00 PM (Eastern Standard Time)' },
      { label: 'Link', value: 'https://meet.google.com/abc-defg-hij' },
    ],
    actions: [
      { label: 'Join the meeting', url: 'https://meet.google.com/abc-defg-hij', primary: true },
      { label: 'Reschedule', url: 'https://jimicohen.com/meeting/booking/b1/reschedule?t=abc&x=1' },
      { label: 'Cancel', url: 'https://jimicohen.com/meeting/booking/b1/cancel?t=abc' },
    ],
    footer: 'You are getting this email because a meeting was booked with Jimi Cohen using this address.',
  };

  it('renders heading, paragraphs, details and obvious buttons', () => {
    const html = renderEmailHtml(base);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('You&#39;re booked</h1>');
    expect(html).toContain('>Hi Sam,</p>');
    expect(html).toContain('>When</td>');
    expect(html).toContain('Tuesday, November 17, 2026<br>3:30 PM to 4:00 PM (Eastern Standard Time)');
    expect(html).toMatch(/<a href="https:\/\/meet\.google\.com\/abc-defg-hij" target="_blank" style="[^"]*">Join the meeting<\/a>/);
    expect(html).toContain('href="https://jimicohen.com/meeting/booking/b1/reschedule?t=abc&amp;x=1"');
    expect(html).toContain('>Reschedule</a>');
    expect(html).toContain('>Cancel</a>');
    expect(html).toContain(base.footer);
  });

  it('uses a table layout with inline styles and no remote resources', () => {
    const html = renderEmailHtml(base);
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/<script|<link|<iframe|<form|@import|url\(|<img/i);
    expect(html).not.toMatch(/ on[a-z]+=/i);
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    // without the style block the email still carries its full light design inline
    const withoutStyle = html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(withoutStyle).toContain('background:#ffffff');
    expect(withoutStyle).toContain('color:#1b2320');
    expect(html).toContain('max-width:600px');
  });

  it('supports dark mode without depending on it', () => {
    const html = renderEmailHtml(base);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('[data-ogsc]');
  });

  it('paints the primary button in the brand colour with readable text', () => {
    const html = renderEmailHtml(base);
    const brand = site.theme.colors.primary; // light green
    expect(html).toContain(`bgcolor="${brand}"`);
    const ink = /bgcolor="#5ede8e"[^>]*><a [^>]*color:(#[0-9a-f]{6});/.exec(html)?.[1];
    expect(ink).toBe(readableOn(brand));
    expect(contrastRatio(ink!, brand)).toBeGreaterThanOrEqual(4.5);

    const navy = structuredClone(site);
    navy.theme.colors.primary = '#1d3a8a';
    expect(renderEmailHtml({ ...base, site: navy })).toMatch(/bgcolor="#1d3a8a"[^>]*><a [^>]*color:#ffffff;/);
  });

  it('keeps text links readable on white even when the brand colour is pale', () => {
    const html = renderEmailHtml({ ...base, paragraphs: ['See https://example.com/a for more.'] });
    const linkColor = /<a href="https:\/\/example\.com\/a" class="m-link" style="color:(#[0-9a-f]{6});/.exec(html)?.[1];
    expect(linkColor).toBeDefined();
    expect(contrastRatio(linkColor!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to a safe brand colour, and lets an event colour take over', () => {
    const broken = structuredClone(site);
    broken.theme.colors.primary = 'red;background:url(https://evil.example/x)';
    const html = renderEmailHtml({ ...base, site: broken });
    expect(html).not.toContain('evil.example');
    expect(html).toContain('bgcolor="#1f6f4a"');
    expect(renderEmailHtml({ ...base, accentColor: '#AA3355' })).toContain('bgcolor="#aa3355"');
    expect(renderEmailHtml({ ...base, accentColor: '"><script>' })).toContain(`bgcolor="${site.theme.colors.primary}"`);
  });

  it('escapes every piece of content', () => {
    const evil = '<script>alert("x")</script>';
    const hostile = structuredClone(site);
    hostile.profile.name = `Jimi ${evil}`;
    const html = renderEmailHtml({
      site: hostile,
      preheader: evil,
      heading: evil,
      paragraphs: [evil, `Line one\n${evil}`],
      details: [{ label: evil, value: `${evil} & "quotes" 'single'` }],
      actions: [{ label: evil, url: 'https://example.com/?q="><script>alert(1)</script>', primary: true }],
      links: [{ label: evil, url: 'https://example.com/ok' }],
      linksLabel: evil,
      footer: evil,
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert("x")');
    expect(html.match(/&lt;script&gt;/g)!.length).toBeGreaterThanOrEqual(9);
    expect(html).toContain('&amp; &quot;quotes&quot; &#39;single&#39;');
    // the button whose address could not be made safe is left out entirely
    expect(html).not.toContain('example.com/?q=');
  });

  it('only links to web, mail and phone addresses', () => {
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('mailto:sam@example.com')).toBe('mailto:sam@example.com');
    expect(safeUrl('tel:+254700000001')).toBe('tel:+254700000001');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(safeUrl('https://example.com/a b')).toBeNull();
    expect(safeUrl('/relative')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();

    const html = renderEmailHtml({
      ...base,
      actions: [
        { label: 'Bad', url: 'javascript:alert(1)', primary: true },
        { label: 'Good', url: 'https://example.com/good' },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('>Bad</a>');
    expect(html).toContain('>Good</a>');
  });

  it('turns web addresses in text into links and leaves sentence punctuation outside', () => {
    const html = renderEmailHtml({ ...base, paragraphs: ['Join at https://meet.google.com/abc?x=1&y=2. See you there (or at https://example.com/b).'] });
    expect(html).toMatch(/<a href="https:\/\/meet\.google\.com\/abc\?x=1&amp;y=2" class="m-link" style="[^"]*">https:\/\/meet\.google\.com\/abc\?x=1&amp;y=2<\/a>\. See you/);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/b" [^>]*>https:\/\/example\.com\/b<\/a>\)\./);
  });

  it('shows the profile picture only from an https address', () => {
    expect(renderEmailHtml({ ...base, avatarUrl: 'https://jimicohen.com/meeting/api/assets/ast_1' })).toMatch(
      /<img src="https:\/\/jimicohen\.com\/meeting\/api\/assets\/ast_1" width="40" height="40" alt=""/,
    );
    expect(renderEmailHtml({ ...base, avatarUrl: 'http://insecure.example/a.png' })).not.toContain('<img');
    expect(renderEmailHtml({ ...base, avatarUrl: 'javascript:alert(1)' })).not.toContain('<img');
    expect(renderEmailHtml({ ...base, avatarUrl: null })).not.toContain('<img');
  });

  it('hides the preheader and follows the theme button shape', () => {
    const html = renderEmailHtml(base);
    expect(html).toMatch(/<div style="display:none;[^"]*">Intro call with Jimi Cohen is confirmed\./);
    expect(html).toContain('border-radius:999px'); // default theme: pill buttons
    const square = structuredClone(site);
    square.theme.buttonShape = 'square';
    expect(renderEmailHtml({ ...base, site: square })).not.toContain('border-radius:999px');
  });

  it('renders small text links under the buttons', () => {
    const html = renderEmailHtml({
      ...base,
      linksLabel: 'Add to your calendar:',
      links: [
        { label: 'Google', url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Intro%20call' },
        { label: 'Outlook', url: 'https://outlook.live.com/calendar/0/action/compose?rru=addevent' },
      ],
    });
    expect(html).toContain('Add to your calendar: <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Intro%20call"');
    expect(html).toContain('>Outlook</a>');
  });

  it('stacks a long label above its value instead of squeezing it into the side column', () => {
    const html = renderEmailHtml({
      ...base,
      details: [
        { label: 'Phone', value: '+254700000001' },
        { label: 'What would you like to talk about?', value: 'Tree planting' },
      ],
    });
    expect(html).toMatch(/<td class="m-muted m-line" valign="top" width="84"[^>]*>Phone<\/td>/);
    expect(html).toMatch(/<td class="m-line" colspan="2"[^>]*><div class="m-muted"[^>]*>What would you like to talk about\?<\/div><div class="m-ink"[^>]*>Tree planting<\/div><\/td>/);
  });

  it('copes with the minimum: a heading and one paragraph', () => {
    const html = renderEmailHtml({ site, heading: 'Hello', paragraphs: ['Just this.'] });
    expect(html).toContain('>Hello</h1>');
    expect(html).toContain('>Just this.</p>');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });
});

describe('renderEmailText', () => {
  it('carries the same content as plain text', () => {
    const text = renderEmailText({
      heading: "You're booked",
      paragraphs: ['Hi Sam,', "You're all set."],
      details: [
        { label: 'When', value: 'Tuesday, November 17, 2026\n3:30 PM to 4:00 PM' },
        { label: 'Empty', value: ' ' },
        { label: 'Anything else?', value: 'No' },
      ],
      actions: [
        { label: 'Reschedule', url: 'https://jimicohen.com/meeting/booking/b1/reschedule?t=abc' },
        { label: 'Bad', url: 'javascript:alert(1)' },
      ],
      linksLabel: 'Add to your calendar:',
      links: [{ label: 'Google', url: 'https://calendar.google.com/x' }],
      footer: 'Sent by the booking page.',
    });
    expect(text).toBe(
      [
        "You're booked",
        'Hi Sam,',
        "You're all set.",
        'When: Tuesday, November 17, 2026\n  3:30 PM to 4:00 PM\nAnything else? No',
        'Reschedule: https://jimicohen.com/meeting/booking/b1/reschedule?t=abc',
        'Add to your calendar:\nGoogle: https://calendar.google.com/x',
        '--\nSent by the booking page.',
      ].join('\n\n') + '\n',
    );
  });
});
