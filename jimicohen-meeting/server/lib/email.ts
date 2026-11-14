/**
 * Outbound email: choosing the provider, rendering the HTML and plain-text bodies, building the
 * raw MIME message for Gmail, and sending. sendEmail never throws: every outcome is a SendResult.
 */
import { ensureContrast, normalizeHex, readableOn } from '../../shared/theme';
import type { Host, Secrets, SendResult, SiteSettings } from '../../shared/types';
import { sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { gmailSendRaw } from './google';
import { getSecrets, getSite, listHosts } from './repo';
import { escapeHtml } from './templates';
import { isEmail } from './validate';

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  ics?: { filename: string; content: string; method: 'REQUEST' | 'CANCEL' | 'PUBLISH' };
  /** Same key = same message. Lets the provider drop a repeat when a send is retried after an unclear failure. */
  idempotencyKey?: string;
}

export type EmailProvider = 'resend' | 'gmail' | 'none';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;
const MAX_SUBJECT = 200;
const MAX_NAME = 120;

// ───────────────────────── provider choice ─────────────────────────

/** `auto` prefers Resend (needs a key and a from address), then the owner's Gmail, else nothing. */
export function pickEmailProvider(
  setting: SiteSettings['email']['provider'],
  has: { resend: boolean; gmail: boolean },
): EmailProvider {
  if (setting === 'none') return 'none';
  if (setting === 'resend') return has.resend ? 'resend' : 'none';
  if (setting === 'gmail') return has.gmail ? 'gmail' : 'none';
  if (has.resend) return 'resend';
  return has.gmail ? 'gmail' : 'none';
}

interface EmailSetup {
  site: SiteSettings;
  secrets: Secrets;
  owner: Host | null;
  provider: EmailProvider;
}

async function loadEmailSetup(ctx: Ctx): Promise<EmailSetup> {
  const [site, secrets, hosts] = await Promise.all([getSite(ctx), getSecrets(ctx), listHosts(ctx)]);
  const owner = hosts.find((h) => h.id === site.ownerHostId) ?? hosts.find((h) => h.role === 'owner') ?? null;
  const provider = pickEmailProvider(site.email?.provider ?? 'auto', {
    resend: !!secrets.resend?.apiKey && isEmail(site.email?.fromEmail),
    gmail: !!owner?.google?.gmailSend && isEmail(owner.google.email),
  });
  return { site, secrets, owner, provider };
}

export async function resolveEmailProvider(ctx: Ctx): Promise<EmailProvider> {
  return (await loadEmailSetup(ctx)).provider;
}

// ───────────────────────── header hygiene ─────────────────────────

/** One line of plain text: no CR/LF, no control characters, collapsed spaces. Stops header injection. */
function headerText(value: unknown, max: number): string {
  const line = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(line).slice(0, max).join('').trim();
}

function cleanAddress(value: unknown): string | null {
  const address = typeof value === 'string' ? value.trim() : '';
  return isEmail(address) ? address : null;
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

/** RFC 2047 encoded-words, split on character boundaries so each word stays under 75 characters. */
function encodedWords(text: string): string[] {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > 39 && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words;
}

/** Unstructured header value (Subject): ASCII is folded at spaces, anything else becomes encoded-words. */
function unstructuredHeader(name: string, value: string): string {
  if (!isAscii(value)) return `${name}: ${encodedWords(value).join('\r\n ')}`;
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of value.split(' ')) {
    if (line.length + 1 + word.length > 78 && line !== `${name}:`) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function mimeAddress(name: string | undefined, email: string): string {
  const display = headerText(name, MAX_NAME);
  if (!display) return email;
  if (!isAscii(display)) return `${encodedWords(display).join('\r\n ')} <${email}>`;
  return `"${display.replace(/[\\"]/g, '\\$&')}" <${email}>`;
}

/**
 * `Name <email>` for JSON APIs (UTF-8 is fine there). Characters that mean something in an
 * address list are taken out of the name, so one recipient can never be read as several.
 */
function displayAddress(name: string | undefined, email: string): string {
  const display = headerText(name, MAX_NAME)
    .replace(/[\\"<>()[\],;:@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return display ? `${display} <${email}>` : email;
}

function base64Lines(data: string): string {
  return (Buffer.from(data, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

function rfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${two(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`
  );
}

function icsFilename(name: unknown): string {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60);
  if (!cleaned) return 'invite.ics';
  return /\.ics$/i.test(cleaned) ? cleaned : `${cleaned}.ics`;
}

function icsMethod(method: unknown): 'REQUEST' | 'CANCEL' | 'PUBLISH' {
  return method === 'REQUEST' || method === 'CANCEL' ? method : 'PUBLISH';
}

/** CRLF line endings, as the calendar format requires, whatever the caller produced. */
function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

// ───────────────────────── MIME ─────────────────────────

/**
 * A complete RFC 5322 message. Layout:
 *   multipart/alternative: text/plain, text/html [, text/calendar when the invite needs an answer]
 *   wrapped in multipart/mixed with the .ics file attached when there is one.
 * A PUBLISH calendar travels as an attachment only, so mail clients never add a second copy of an
 * event the invitee already received from Google Calendar.
 * Throws when the sender or recipient is not a plain email address.
 */
export function buildMime(msg: EmailMessage, from: { name: string; email: string }, opts?: { date?: Date }): string {
  const to = cleanAddress(msg.to);
  const sender = cleanAddress(from.email);
  if (!to) throw new Error('buildMime: invalid recipient address');
  if (!sender) throw new Error('buildMime: invalid sender address');
  const replyTo = cleanAddress(msg.replyTo);
  const subject = headerText(msg.subject, MAX_SUBJECT) || '(no subject)';
  const seed = sha256Hex(`${to}\n${subject}\n${msg.text}\n${msg.html}`).slice(0, 24);
  const altBoundary = `=_alt_${seed}`;
  const mixedBoundary = `=_mix_${seed}`;

  const headers = [`From: ${mimeAddress(from.name, sender)}`, `To: ${mimeAddress(msg.toName, to)}`];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(unstructuredHeader('Subject', subject));
  if (opts?.date && Number.isFinite(opts.date.getTime())) headers.push(`Date: ${rfc5322Date(opts.date)}`);
  headers.push('MIME-Version: 1.0');

  const part = (contentType: string, body: string, extra: string[] = []): string =>
    [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64', ...extra, '', base64Lines(body)].join('\r\n');

  const ics = msg.ics && msg.ics.content ? { ...msg.ics, method: icsMethod(msg.ics.method), content: crlf(msg.ics.content) } : null;
  const alternatives = [part('text/plain; charset=UTF-8', msg.text ?? ''), part('text/html; charset=UTF-8', msg.html ?? '')];
  if (ics && ics.method !== 'PUBLISH') alternatives.push(part(`text/calendar; charset=UTF-8; method=${ics.method}`, ics.content));
  const alternative =
    alternatives.map((p) => `--${altBoundary}\r\n${p}`).join('\r\n') + `\r\n--${altBoundary}--`;

  if (!ics) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', alternative, ''].join('\r\n');
  }
  const filename = icsFilename(ics.filename);
  const attachment = part(`application/ics; name="${filename}"`, ics.content, [`Content-Disposition: attachment; filename="${filename}"`]);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    alternative,
    `--${mixedBoundary}`,
    attachment,
    `--${mixedBoundary}--`,
    '',
  ].join('\r\n');
}

// ───────────────────────── sending ─────────────────────────

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

async function sendWithResend(
  ctx: Ctx,
  apiKey: string,
  provider: 'resend' | 'mock',
  msg: EmailMessage,
  p: { to: string; subject: string; from: string; replyTo: string | null },
): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    from: p.from,
    to: [displayAddress(msg.toName, p.to)],
    subject: p.subject,
    html: msg.html,
    text: msg.text,
  };
  if (p.replyTo) payload.reply_to = p.replyTo;
  if (msg.ics?.content) {
    const method = icsMethod(msg.ics.method);
    payload.attachments = [
      {
        filename: icsFilename(msg.ics.filename),
        content: Buffer.from(crlf(msg.ics.content), 'utf8').toString('base64'),
        content_type: `text/calendar; charset=UTF-8; method=${method}`,
      },
    ];
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const key = headerText(msg.idempotencyKey, 200);
  if (key && isAscii(key)) headers['Idempotency-Key'] = key;

  try {
    const res = await ctx.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const raw = await res.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    if (!res.ok) {
      const reason = typeof record.message === 'string' ? record.message : typeof record.name === 'string' ? record.name : raw.slice(0, 200);
      return { ok: false, provider, error: shortError(`Resend answered ${res.status}${reason ? `: ${reason}` : ''}`) };
    }
    const id = typeof record.id === 'string' ? record.id : undefined;
    return { ok: true, provider, id };
  } catch (err) {
    return { ok: false, provider, error: shortError(err) };
  }
}

/**
 * Sends one email through the configured provider. `skipped` (instead of `error`) means there is
 * no point retrying: nothing is configured or the recipient address is unusable.
 */
export async function sendEmail(ctx: Ctx, msg: EmailMessage): Promise<SendResult> {
  const to = cleanAddress(msg.to);
  if (!to) return { ok: false, provider: 'none', skipped: 'invalid_recipient' };
  const subject = headerText(msg.subject, MAX_SUBJECT) || '(no subject)';

  let setup: EmailSetup;
  try {
    setup = await loadEmailSetup(ctx);
  } catch (err) {
    return { ok: false, provider: 'none', error: shortError(err) };
  }
  const { site, secrets, owner, provider } = setup;
  const fromName = headerText(site.email?.fromName, MAX_NAME) || headerText(site.profile?.name, MAX_NAME) || 'Meetings';
  const replyTo = cleanAddress(msg.replyTo) ?? cleanAddress(site.email?.replyTo) ?? cleanAddress(owner?.email);

  if (provider === 'resend') {
    const from = displayAddress(fromName, site.email.fromEmail.trim());
    return sendWithResend(ctx, secrets.resend!.apiKey, 'resend', msg, { to, subject, from, replyTo });
  }

  if (provider === 'gmail' && owner?.google) {
    try {
      const mime = buildMime({ ...msg, to, subject, replyTo: replyTo ?? undefined }, { name: fromName, email: owner.google.email }, { date: ctx.now() });
      const sent = await gmailSendRaw(ctx, owner, mime);
      return { ok: true, provider: 'gmail', id: sent.id };
    } catch (err) {
      return { ok: false, provider: 'gmail', error: shortError(err) };
    }
  }

  if (ctx.env.mockProviders && site.email?.provider !== 'none') {
    // Local development and end-to-end tests: nothing is configured, so hand the message to the
    // in-process mock (ctx.fetch) in Resend's shape. It lands in the dev outbox. Email that was
    // switched off on purpose stays off here too.
    const fromEmail = cleanAddress(site.email?.fromEmail) ?? 'meetings@example.test';
    return sendWithResend(ctx, 'mock', 'mock', msg, { to, subject, from: displayAddress(fromName, fromEmail), replyTo });
  }

  return { ok: false, provider: 'none', skipped: 'email_not_configured' };
}

// ───────────────────────── HTML + text bodies ─────────────────────────

export interface EmailContent {
  site: SiteSettings;
  preheader?: string;
  heading: string;
  paragraphs: string[];
  details?: { label: string; value: string }[];
  actions?: { label: string; url: string; primary?: boolean }[];
  footer?: string;
  /** small text links under the buttons, e.g. add-to-calendar */
  links?: { label: string; url: string }[];
  linksLabel?: string;
  /** absolute https URL of the profile picture; left out when not given */
  avatarUrl?: string | null;
  /** overrides the theme's brand colour (per-event colour) */
  accentColor?: string | null;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LIGHT = { page: '#f3f4f0', card: '#ffffff', ink: '#1b2320', muted: '#5c665f', line: '#e2e6e0', outline: '#c6cdc6' };
const DARK = { page: '#0f1512', card: '#182019', ink: '#eef2ec', muted: '#a5afa7', line: '#2c3830', outline: '#4a574e' };
const FALLBACK_BRAND = '#1f6f4a';
/** detail labels longer than this are stacked above their value instead of sitting beside it */
const STACK_LABELS_OVER = 16;

/** Only web, mail and phone links ever become an href. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\s\u0000-\u001F\u007F<>"`]/.test(text)) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** Escapes text, turns bare web addresses into links and line breaks into <br>. */
function richText(text: string, linkStyle: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const shown = match[0].replace(/[.,;:!?)\]]+$/, ''); // punctuation after a link belongs to the sentence
    const href = safeUrl(shown);
    out += escapeHtml(text.slice(last, start));
    out += href ? `<a href="${escapeHtml(href)}" class="m-link" style="${linkStyle}">${escapeHtml(shown)}</a>` : escapeHtml(shown);
    last = start + shown.length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\r\n|\r|\n/g, '<br>');
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function buttonRadius(site: SiteSettings): string {
  const shape = site.theme?.buttonShape;
  if (shape === 'pill') return '999px';
  if (shape === 'square') return '4px';
  const radius = Number(site.theme?.radius);
  return `${Number.isFinite(radius) ? Math.max(6, Math.min(14, Math.round(radius))) : 10}px`;
}

/**
 * The HTML body. Table layout with inline styles so it holds together in Gmail, Apple Mail and
 * Outlook. The one <style> block only adds dark-mode colours and tighter padding on phones;
 * clients that drop it still show the complete light design. Every value is escaped.
 */
export function renderEmailHtml(p: EmailContent): string {
  const brand = normalizeHex(p.accentColor, normalizeHex(p.site.theme?.colors?.primary, FALLBACK_BRAND));
  const onBrand = readableOn(brand);
  const link = ensureContrast(brand, LIGHT.card, 4.5);
  const linkDark = ensureContrast(brand, DARK.card, 4.5);
  const radius = buttonRadius(p.site);
  const linkStyle = `color:${link};text-decoration:underline;word-break:break-word;`;

  const heading = clean(p.heading);
  const siteName = clean(p.site.profile?.name);
  const preheader = clean(p.preheader);
  const paragraphs = (p.paragraphs ?? []).map(clean).filter(Boolean);
  const details = (p.details ?? []).map((d) => ({ label: clean(d.label), value: clean(d.value) })).filter((d) => d.label && d.value);
  const withUrl = <T extends { label: string; url: string }>(list: T[] | undefined) =>
    (list ?? [])
      .map((item) => ({ ...item, label: clean(item.label), href: safeUrl(item.url) }))
      .filter((item): item is T & { href: string } => !!item.label && !!item.href);
  const actions = withUrl(p.actions);
  const links = withUrl(p.links);
  const footer = clean(p.footer);
  const avatar = safeUrl(p.avatarUrl);
  const avatarOk = avatar && avatar.startsWith('https://') ? avatar : null;

  const rows: string[] = [];
  const row = (inner: string, padding: string) => rows.push(`<tr><td class="m-pad" style="padding:${padding};">${inner}</td></tr>`);

  if (siteName || avatarOk) {
    const picture = avatarOk
      ? `<td valign="middle" style="padding-right:12px;"><img src="${escapeHtml(avatarOk)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border-radius:50%;border:0;"></td>`
      : '';
    row(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${picture}<td valign="middle" class="m-muted" style="font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${LIGHT.muted};">${escapeHtml(siteName)}</td></tr></table>`,
      '28px 32px 0 32px',
    );
  }
  if (heading) {
    row(
      `<h1 class="m-ink m-h1" style="margin:0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:700;color:${LIGHT.ink};">${escapeHtml(heading)}</h1>`,
      '20px 32px 0 32px',
    );
  }
  for (const paragraph of paragraphs) {
    row(
      `<p class="m-ink" style="margin:0;font-family:${FONT};font-size:16px;line-height:25px;color:${LIGHT.ink};">${richText(paragraph, linkStyle)}</p>`,
      '14px 32px 0 32px',
    );
  }
  if (details.length > 0) {
    const cells = details
      .map((d, i) => {
        const border = i < details.length - 1 ? `border-bottom:1px solid ${LIGHT.line};` : '';
        const labelStyle = `font-family:${FONT};font-size:13px;line-height:20px;color:${LIGHT.muted};`;
        const valueStyle = `font-family:${FONT};font-size:15px;line-height:21px;color:${LIGHT.ink};`;
        if (d.label.length > STACK_LABELS_OVER) {
          // A long label (a booking question, say) would crush a side column, so it sits above its value.
          return (
            `<tr><td class="m-line" colspan="2" valign="top" style="padding:11px 16px;${border}">` +
            `<div class="m-muted" style="${labelStyle}">${escapeHtml(d.label)}</div>` +
            `<div class="m-ink" style="padding-top:2px;${valueStyle}">${richText(d.value, linkStyle)}</div></td></tr>`
          );
        }
        return (
          `<tr><td class="m-muted m-line" valign="top" width="84" style="padding:11px 10px 11px 16px;${labelStyle}${border}">${escapeHtml(d.label)}</td>` +
          `<td class="m-ink m-line" valign="top" style="padding:11px 16px 11px 0;${valueStyle}${border}">${richText(d.value, linkStyle)}</td></tr>`
        );
      })
      .join('');
    row(
      `<table role="presentation" class="m-line" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LIGHT.line};border-radius:12px;border-collapse:separate;">${cells}</table>`,
      '22px 32px 0 32px',
    );
  }
  if (actions.length > 0) {
    const buttons = actions
      .map((a) => {
        const cell = a.primary
          ? `<td align="center" bgcolor="${brand}" style="background:${brand};border-radius:${radius};mso-padding-alt:12px 22px;"><a href="${escapeHtml(a.href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${onBrand};text-decoration:none;border-radius:${radius};">${escapeHtml(a.label)}</a></td>`
          : `<td align="center" class="m-outline" style="border:1px solid ${LIGHT.outline};border-radius:${radius};mso-padding-alt:11px 20px;"><a href="${escapeHtml(a.href)}" target="_blank" class="m-ink" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${LIGHT.ink};text-decoration:none;border-radius:${radius};">${escapeHtml(a.label)}</a></td>`;
        return `<table role="presentation" align="left" cellpadding="0" cellspacing="0" border="0" style="mso-table-lspace:0;mso-table-rspace:0;"><tr>${cell}<td width="10" style="font-size:0;line-height:0;">&nbsp;</td></tr><tr><td colspan="2" height="10" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
      })
      .join('');
    row(buttons, '24px 32px 0 32px');
  }
  if (links.length > 0) {
    const label = clean(p.linksLabel);
    const items = links.map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" class="m-link" style="${linkStyle}">${escapeHtml(l.label)}</a>`).join(' &nbsp;|&nbsp; ');
    row(
      `<p class="m-muted" style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;color:${LIGHT.muted};">${label ? `${escapeHtml(label)} ` : ''}${items}</p>`,
      '14px 32px 0 32px',
    );
  }
  rows.push('<tr><td style="height:30px;font-size:0;line-height:0;">&nbsp;</td></tr>');

  const hidden = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`
    : '';
  const footerRow = footer
    ? `<tr><td class="m-muted" align="center" style="padding:18px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${LIGHT.muted};">${richText(footer, `color:${LIGHT.muted};text-decoration:underline;`)}</td></tr>`
    : '';

  const css =
    ':root{color-scheme:light dark;supported-color-schemes:light dark;}' +
    `@media (prefers-color-scheme:dark){.m-page{background:${DARK.page} !important;}.m-card{background:${DARK.card} !important;}.m-ink{color:${DARK.ink} !important;}.m-muted{color:${DARK.muted} !important;}.m-line{border-color:${DARK.line} !important;}.m-outline{border-color:${DARK.outline} !important;}.m-link{color:${linkDark} !important;}}` +
    `[data-ogsb] .m-page{background:${DARK.page} !important;}[data-ogsb] .m-card{background:${DARK.card} !important;}[data-ogsc] .m-ink{color:${DARK.ink} !important;}[data-ogsc] .m-muted{color:${DARK.muted} !important;}[data-ogsc] .m-link{color:${linkDark} !important;}` +
    '@media only screen and (max-width:480px){.m-pad{padding-left:20px !important;padding-right:20px !important;}.m-h1{font-size:23px !important;line-height:29px !important;}}';

  return [
    '<!DOCTYPE html>',
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(heading || siteName)}</title>`,
    `<style>${css}</style>`,
    '</head>',
    `<body class="m-page" style="margin:0;padding:0;background:${LIGHT.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">`,
    hidden,
    `<table role="presentation" class="m-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.page}" style="background:${LIGHT.page};">`,
    '<tr><td align="center" style="padding:28px 12px 36px 12px;">',
    '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">`,
    `<tr><td class="m-card" bgcolor="${LIGHT.card}" style="background:${LIGHT.card};border-radius:16px;overflow:hidden;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    `<tr><td bgcolor="${brand}" style="background:${brand};height:6px;font-size:0;line-height:0;border-radius:16px 16px 0 0;">&nbsp;</td></tr>`,
    ...rows,
    '</table>',
    '</td></tr>',
    footerRow,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** "When: " for an ordinary label, "What would you like to talk about? " for one that brings its own punctuation. */
function labelled(label: string): string {
  return /[?!.:]$/.test(label) ? `${label} ` : `${label}: `;
}

/** The plain-text twin of renderEmailHtml: same content, same order. */
export function renderEmailText(p: Omit<EmailContent, 'site' | 'preheader' | 'avatarUrl' | 'accentColor'>): string {
  const blocks: string[] = [];
  const heading = clean(p.heading);
  if (heading) blocks.push(heading);
  for (const paragraph of p.paragraphs ?? []) if (clean(paragraph)) blocks.push(clean(paragraph));
  const details = (p.details ?? []).filter((d) => clean(d.label) && clean(d.value));
  if (details.length > 0) blocks.push(details.map((d) => `${labelled(clean(d.label))}${clean(d.value).replace(/\n/g, '\n  ')}`).join('\n'));
  const linkLine = (item: { label: string; url: string }) => {
    const href = safeUrl(item.url);
    return href && clean(item.label) ? `${clean(item.label)}: ${href}` : '';
  };
  const actions = (p.actions ?? []).map(linkLine).filter(Boolean);
  if (actions.length > 0) blocks.push(actions.join('\n'));
  const links = (p.links ?? []).map(linkLine).filter(Boolean);
  if (links.length > 0) blocks.push([clean(p.linksLabel), ...links].filter(Boolean).join('\n'));
  if (clean(p.footer)) blocks.push(`--\n${clean(p.footer)}`);
  return `${blocks.join('\n\n')}\n`;
}
