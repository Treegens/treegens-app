import { all, get, run } from './db.ts';
import { hmac, isEmail, now, safeEqual, sha256, str } from './util.ts';
import { mailEventsOn, BOUNCE_WARN_DAYS } from '../lib/policy.ts';
import { bouncedLine as line } from '../lib/mailnews.ts';

// Knowing when an email did not arrive.
//
// The mail server only tells us that it took an email. What became of it afterwards (it arrived, it came back, the
// reader marked it as spam) is told later by the mail provider, which calls POST /mail/events. This file holds what
// that needs and nothing that sends: who may call, how each provider's message is read into one shape of our own,
// what a mail server's answer means in plain words, the do-not-mail list of an account, and the count of "try
// later" days. What is then done about it (marks on recipients and logins, the record, the emails to the sender) is
// in routes-bounces.ts. This file imports nothing from envelopes.ts, so envelopes.ts can ask it before sending.

// ---- Who may call ----------------------------------------------------------------------------

/**
 * 'off' when MAIL_EVENTS_TOKEN is not set (or is too short to be a secret): the route then answers 404 like any
 * address that does not exist. Otherwise the caller must show the secret in one of the three ways mail providers
 * can: ?token=..., "Authorization: Bearer ...", or as the password of HTTP Basic (any user name). Compared through
 * a fingerprint of both, in constant time, so neither its length nor how much of it was right can be measured.
 */
export function mailEventsAuth(req: Request, url: URL): 'off' | 'ok' | 'no' {
  if (!mailEventsOn()) return 'off';
  const want = sha256((process.env.MAIL_EVENTS_TOKEN || '').trim());
  const given: string[] = [];
  const q = url.searchParams.get('token');
  if (q) given.push(q);
  const h = req.headers.get('authorization') || '';
  if (/^Bearer\s+/i.test(h)) given.push(h.replace(/^Bearer\s+/i, '').trim());
  if (/^Basic\s+/i.test(h)) {
    const pair = Buffer.from(h.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
    given.push(pair.includes(':') ? pair.slice(pair.indexOf(':') + 1) : pair);
  }
  // Every way that was used is compared, also after one has matched.
  return given.map((g) => safeEqual(sha256(g), want)).some(Boolean) ? 'ok' : 'no';
}

// ---- One shape for every provider --------------------------------------------------------------

export const EVENT_TYPES = ['bounce', 'soft_bounce', 'complaint', 'delivered'] as const;
export type MailEvent = {
  /** 'bounce': the address does not work. 'soft_bounce': try later. 'complaint': marked as spam. 'delivered': the recipient's mail server took it. */
  type: (typeof EVENT_TYPES)[number];
  email: string; // who the email was to, lower case
  mail_id?: string; // our X-SG-Mail, when the provider handed it back
  message_id?: string; // our Message-ID, without angle brackets, lower case
  reason?: string; // what the mail server or the provider said, cleaned
  at?: string; // when it happened, if the provider said
};

/** What a mail server said, made safe to show and to mail on: one line, no links, not long. */
export const cleanReason = (v: any): string => str(v, 2000).replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s.;:,-]+$/, '').slice(0, 240);
/** A Message-ID as we store it: no angle brackets, lower case. */
export const normMessageId = (v: any): string => str(v, 500).trim().replace(/^<|>$/g, '').trim().toLowerCase();
const bare = (v: any): string => {
  const s = str(v, 400).trim();
  return (/<([^<>]+)>\s*$/.exec(s)?.[1] || s).trim().toLowerCase();
};
const iso = (v: any): string | undefined => {
  const ms = typeof v === 'number' ? v * 1000 : Date.parse(str(v, 60));
  // Beyond the last date a computer can write (year 275760) toISOString throws: such a value is no time at all.
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : undefined;
};
function ev(type: MailEvent['type'], email: any, o: { mail_id?: any; message_id?: any; reason?: any; at?: any } = {}): MailEvent[] {
  const to = bare(email);
  if (!isEmail(to)) return [];
  const id = /^\d{1,15}$/.test(str(o.mail_id, 20).trim()) ? str(o.mail_id, 20).trim() : undefined;
  return [{ type, email: to, ...(id ? { mail_id: id } : {}), ...(normMessageId(o.message_id) ? { message_id: normMessageId(o.message_id) } : {}), ...(cleanReason(o.reason) ? { reason: cleanReason(o.reason) } : {}), ...(iso(o.at) ? { at: iso(o.at) } : {}) }];
}
// A header of the original email, from a list of { name, value } or from a plain object. Names in any case.
const headerOf = (headers: any, name: string): string | undefined => {
  const list: [string, any][] = Array.isArray(headers) ? headers.map((h: any) => [str(h?.name, 100), h?.value]) : headers && typeof headers === 'object' ? Object.entries(headers) : [];
  const hit = list.find(([k]) => k.toLowerCase() === name);
  return hit ? str(hit[1], 500) : undefined;
};
const join = (...parts: any[]) => parts.map((p) => str(p, 1000).trim()).filter(Boolean).join(' ');

// Each adapter answers null when the message is not its provider's, and otherwise the events in it that matter here
// (an empty list for news we do not act on, such as "opened"). They were written from each provider's documentation.
// None was tried against the real service: see the README.

// Our own shape: { type, email, message_id?, mail_id?, reason?, at? }.
function plain(x: any): MailEvent[] | null {
  if (!EVENT_TYPES.includes(x?.type) || typeof x.email !== 'string') return null;
  return ev(x.type, x.email, x);
}

// Postmark: one object per webhook call, told apart by RecordType. Our id comes back as Metadata (X-PM-Metadata-sg-mail).
const POSTMARK_HARD = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated'];
const POSTMARK_SOFT = ['Transient', 'SoftBounce', 'DnsError', 'Blocked', 'DMARCPolicy', 'SpamNotification', 'SMTPApiError', 'Unknown'];
function postmark(x: any): MailEvent[] | null {
  if (typeof x?.RecordType !== 'string') return null;
  const o = { mail_id: x.Metadata?.['sg-mail'], at: x.BouncedAt || x.DeliveredAt };
  if (x.RecordType === 'Delivery') return ev('delivered', x.Recipient, { ...o, reason: x.Details });
  if (x.RecordType === 'SpamComplaint' || (x.RecordType === 'Bounce' && x.Type === 'SpamComplaint')) return ev('complaint', x.Email, o);
  if (x.RecordType !== 'Bounce') return [];
  const kind = POSTMARK_HARD.includes(x.Type) ? 'bounce' : POSTMARK_SOFT.includes(x.Type) ? 'soft_bounce' : null;
  return kind ? ev(kind, x.Email, { ...o, reason: x.Type === 'ManuallyDeactivated' ? 'inactive recipient, deactivated at the mail provider' : x.Details || x.Description || x.Name }) : [];
}

// SendGrid: a list of events. "smtp-id" is the Message-ID we set, and sg_mail the value we sent in X-SMTPAPI.
function sendgrid(x: any): MailEvent[] | null {
  if (typeof x?.event !== 'string' || typeof x.email !== 'string' || !['sg_event_id', 'sg_message_id', 'smtp-id', 'timestamp'].some((k) => k in x)) return null;
  const o = { mail_id: x.sg_mail, message_id: x['smtp-id'], at: x.timestamp, reason: join(x.status, x.reason || x.response) };
  if (x.event === 'delivered') return ev('delivered', x.email, o);
  if (x.event === 'spamreport') return ev('complaint', x.email, o);
  if (x.event === 'bounce') return ev(x.type === 'blocked' ? 'soft_bounce' : 'bounce', x.email, o);
  if (x.event === 'blocked' || x.event === 'deferred') return ev('soft_bounce', x.email, o);
  // "dropped": the provider did not send it, because the address is on its own list of addresses that bounced,
  // are invalid or reported spam. For the person waiting for the email that is the same as an email that came back.
  if (x.event === 'dropped') return ev('bounce', x.email, { ...o, reason: join('Dropped by the mail provider (suppressed):', x.reason) });
  return [];
}

// Mailgun: { signature, "event-data": { event, severity, recipient, message.headers["message-id"], "user-variables" } }.
function mailgun(x: any): MailEvent[] | null {
  const d = x?.['event-data'];
  if (!d || typeof d !== 'object' || typeof d.event !== 'string') return null;
  const s = d['delivery-status'] || {};
  const o = { mail_id: d['user-variables']?.sg_mail, message_id: d.message?.headers?.['message-id'], at: d.timestamp, reason: join(s.code, s.message || s.description || d.reason) };
  if (d.event === 'delivered') return ev('delivered', d.recipient, o);
  if (d.event === 'complained') return ev('complaint', d.recipient, o);
  if (d.event === 'failed') return ev(d.severity === 'temporary' ? 'soft_bounce' : 'bounce', d.recipient, o);
  return [];
}

// Resend: { type: "email.bounced", created_at, data: { to: [...], bounce: { type, subType, message }, headers? } }.
function resend(x: any): MailEvent[] | null {
  if (typeof x?.type !== 'string' || !x.type.startsWith('email.') || !x.data || typeof x.data !== 'object') return null;
  const d = x.data;
  const o = { mail_id: headerOf(d.headers, 'x-sg-mail'), message_id: headerOf(d.headers, 'message-id'), at: x.created_at };
  const each = (type: MailEvent['type'], reason?: string) => (Array.isArray(d.to) ? d.to : [d.to]).flatMap((to: any) => ev(type, to, { ...o, reason }));
  if (x.type === 'email.delivered') return each('delivered');
  if (x.type === 'email.complained') return each('complaint');
  if (x.type === 'email.delivery_delayed') return each('soft_bounce', 'delivery delayed, try later');
  if (x.type === 'email.bounced') return each(/transient|undetermined|temporary/i.test(str(d.bounce?.type, 40)) ? 'soft_bounce' : 'bounce', join(d.bounce?.subType, d.bounce?.message));
  return [];
}

// Amazon SES: the notification itself, as it arrives inside an SNS message (or alone, with "raw message delivery").
// Told apart by notificationType (notifications) or eventType (event publishing). Our ids are in mail.headers when
// "include original headers" is switched on, and the Message-ID we set is in mail.commonHeaders.
function ses(x: any): MailEvent[] | null {
  const kind = x?.notificationType || x?.eventType;
  if (typeof kind !== 'string' || !x.mail || typeof x.mail !== 'object') return null;
  const o = { mail_id: headerOf(x.mail.headers, 'x-sg-mail'), message_id: x.mail.commonHeaders?.messageId || headerOf(x.mail.headers, 'message-id') };
  const list = (v: any): any[] => (Array.isArray(v) ? v : []);
  if (kind === 'Bounce') return list(x.bounce?.bouncedRecipients).flatMap((r) => ev(x.bounce.bounceType === 'Permanent' ? 'bounce' : 'soft_bounce', r?.emailAddress, { ...o, at: x.bounce.timestamp, reason: join(r?.status, r?.diagnosticCode) || join(x.bounce.bounceType, x.bounce.bounceSubType) }));
  if (kind === 'Complaint') return list(x.complaint?.complainedRecipients).flatMap((r) => ev('complaint', r?.emailAddress, { ...o, at: x.complaint.timestamp, reason: x.complaint.complaintFeedbackType }));
  if (kind === 'Delivery') return list(x.delivery?.recipients).flatMap((to) => ev('delivered', to, { ...o, at: x.delivery.timestamp, reason: x.delivery.smtpResponse }));
  if (kind === 'DeliveryDelay') return list(x.deliveryDelay?.delayedRecipients).flatMap((r) => ev('soft_bounce', r?.emailAddress, { ...o, at: x.deliveryDelay.timestamp, reason: join(r?.status, r?.diagnosticCode, x.deliveryDelay.delayType) }));
  return [];
}

// Our own shape is asked last: a SendGrid event also has "type" and "email", and is read as SendGrid's.
const one = (x: any): MailEvent[] | null => (x && typeof x === 'object' ? postmark(x) ?? sendgrid(x) ?? mailgun(x) ?? resend(x) ?? ses(x) ?? plain(x) : null);

/**
 * Reads what a mail provider posted. Answers null for a shape nobody here knows. `confirm` is the address Amazon SNS
 * asks to be fetched before it starts sending (a SubscriptionConfirmation): whether it is fetched is decided by the
 * route, not here.
 */
export function readEvents(body: any): { events: MailEvent[]; confirm?: string } | null {
  if (Array.isArray(body)) {
    const read = body.slice(0, 2000).map(one);
    return read.length && read.every((r) => r === null) ? null : { events: read.flatMap((r) => r || []) };
  }
  if (!body || typeof body !== 'object') return null;
  // Amazon SNS wraps everything: { Type, TopicArn, Message (a string of JSON), SubscribeURL }.
  if (typeof body.Type === 'string' && typeof body.TopicArn === 'string') {
    if (body.Type === 'SubscriptionConfirmation') return { events: [], confirm: str(body.SubscribeURL, 2000) };
    if (body.Type !== 'Notification') return { events: [] };
    let inner: any = null;
    try {
      inner = JSON.parse(str(body.Message, 2_000_000));
    } catch {
      /* a notice in words, such as the one SES sends when a topic is first connected */
    }
    return { events: one(inner) || [] };
  }
  const events = one(body);
  return events ? { events } : null;
}

// ---- What a mail server's answer means, in plain words ------------------------------------------

// Read from the status code (RFC 3463) and the words mail servers commonly use. The first line that fits wins.
const WHY: [RegExp, string][] = [
  [/suppress|bounced address|inactive recipient|deactivated at the mail provider/i, 'the mail provider no longer sends to this address, because earlier emails to it came back'],
  [/spam report|complain/i, 'the mail provider no longer sends to this address, because an email to it was marked as spam'],
  // The domain is asked before the mailbox: "domain does not exist" would otherwise read as "no such mailbox".
  [/\b5\.1\.2\b|\b5\.4\.4\b|domain (not found|does(n't| not) exist|name not found)|host (not found|unknown)|unknown host|no mx|no mail ?server|nxdomain|unrouteable|bad destination system|DnsError/i, 'the domain does not exist or takes no email'],
  [/\b5\.1\.[136]\b|user unknown|unknown user|no such (user|mailbox|recipient|address|person)|does(n't| not) exist|not exist|invalid (recipient|mailbox|address)|mailbox not found|recipient (address )?rejected|address rejected|\bNoEmail\b|bad destination mailbox/i, 'no such mailbox'],
  [/\b[45]\.2\.2\b|mailbox (is )?full|over ?quota|quota exceeded|MailboxFull|insufficient (system )?storage/i, 'the mailbox is full'],
  [/\b5\.2\.1\b|mailbox (is )?(disabled|inactive|unavailable)|account (is )?(disabled|inactive|suspended)/i, 'the mailbox is switched off'],
  [/\b5\.[23]\.[34]\b|too (large|big)|MessageTooLarge|size limit/i, 'the email is too large for that mailbox'],
  [/\b5\.7\.\d+\b|blocked|blacklist|blocklist|denied|policy|not authori[sz]ed|dmarc|spam|ContentRejected/i, 'the mail server refused the email'],
  [/\b4\.\d\.\d+\b|try (again )?later|temporar|time(d)? ?out|greylist|deferred|delayed/i, 'the mail server asked us to try again later'],
];
/**
 * `plain` is what we say to people. `raw` is what the mail server said, cleaned, kept for the record and quoted as
 * the mail server's own words. `full` is both in one line, as stored on the email.
 */
export function bounceWhy(reason: string | undefined, hard: boolean): { plain: string; raw: string; full: string } {
  const raw = cleanReason(reason);
  const plain = WHY.find(([re]) => re.test(raw))?.[1] || (hard ? 'the mail server will not take email for this address' : 'the mail server did not take it yet');
  return { plain, raw, full: raw ? `${plain} (${raw})` : plain };
}

const same = (a: any, b: any) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// ---- "Try later" on separate days ---------------------------------------------------------------

const softKey = (email: string) => hmac(`soft-bounce:${email.trim().toLowerCase()}`);
/** Notes that this address answered "try later" on the day of `at`, and answers on how many separate days it has by now. */
export function softBounceDays(email: string, at: string): number {
  const from = new Date(Date.now() - BOUNCE_WARN_DAYS * 864e5).toISOString().slice(0, 10);
  run('DELETE FROM soft_bounce_days WHERE day < ?', from);
  // A day the provider names is taken when it is believable: not in the future, not older than the days we count.
  const day = at.slice(0, 10) >= from && Date.parse(at) < Date.now() + 864e5 ? at.slice(0, 10) : now().slice(0, 10);
  run('INSERT OR IGNORE INTO soft_bounce_days (address_hash, day) VALUES (?,?)', softKey(email), day);
  return get('SELECT COUNT(*) n FROM soft_bounce_days WHERE address_hash=?', softKey(email)).n;
}
/**
 * Called by the timer (cron.ts). The list of addresses that bounced and the "try later" days are kept for
 * BOUNCE_WARN_DAYS, as the data processing summary says, also when no new bounce comes in to clear them out.
 */
export function forgetOldBounces(): number {
  const from = new Date(Date.now() - BOUNCE_WARN_DAYS * 864e5).toISOString();
  return Number(run('DELETE FROM bounced_addresses WHERE at < ?', from).changes) + Number(run('DELETE FROM soft_bounce_days WHERE day < ?', from.slice(0, 10)).changes);
}
/** An email arrived there, or the address counts as not working now: the days start again. */
export const forgetSoftDays = (email: string) => void run('DELETE FROM soft_bounce_days WHERE address_hash=?', softKey(email));

// ---- The do-not-mail list of an account ---------------------------------------------------------

export type Bounced = { email: string; at: string; reason: string };
export function noteBounced(accountId: string, email: string, reason: string, at: string) {
  run('DELETE FROM bounced_addresses WHERE at < ?', new Date(Date.now() - BOUNCE_WARN_DAYS * 864e5).toISOString());
  run('INSERT INTO bounced_addresses (account_id, email, reason, at) VALUES (?,?,?,?) ON CONFLICT(account_id, email) DO UPDATE SET reason=excluded.reason, at=excluded.at', accountId, email.trim().toLowerCase(), reason, at);
}
/** `before`: only a line older than this goes, so news about an email sent before the bounce does not undo it. */
export function forgetBounced(accountId: string, email: string, before?: string) {
  run(`DELETE FROM bounced_addresses WHERE account_id=? AND email=?${before ? ' AND at < ?' : ''}`, ...(before ? [accountId, email.trim(), before] : [accountId, email.trim()]));
}
/** Which of these addresses bounced for good for this account in the last BOUNCE_WARN_DAYS, newest first. */
export function bouncedBefore(accountId: string, emails: any[]): Bounced[] {
  const want = new Set(emails.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  if (!want.size) return [];
  return all('SELECT email, at, reason FROM bounced_addresses WHERE account_id=? AND at > ? ORDER BY at DESC', accountId, new Date(Date.now() - BOUNCE_WARN_DAYS * 864e5).toISOString()).filter((b) => want.has(b.email.toLowerCase()));
}
/** The warning: "x@y.z bounced on 3 May: no such mailbox. Check the address." Worded in src/lib/mailnews.ts, for the pages too. */
export const bouncedLine = (b: Bounced): string => line(b);
/**
 * What a send is answered with when it would email an address on the list and the sender has not said "anyway".
 * It never refuses for good and never drops anyone quietly: the same request with "send_anyway": true goes out.
 */
export function bouncedRefusal(list: Bounced[], what = 'Nothing was sent'): { message: string; data: Record<string, any> } {
  return {
    message: `${list.map(bouncedLine).join(' ')} ${what}. If the address is right and the mailbox works now, send anyway: in the app, press Send again and choose "Send anyway". Through the API, repeat the call with "send_anyway": true.`,
    data: { code: 'bounced_address', bounced: list.map((b) => ({ email: b.email, bounced_at: b.at, reason: b.reason })) },
  };
}

// ---- Marks on a recipient -------------------------------------------------------------------------

/** Why this recipient is not emailed a reminder right now, or null when they are. A complaint weighs more than a bounce. */
export const mailStop = (r: any): 'complaint' | 'bounce' | null => (r?.complained_at ? 'complaint' : r?.bounced_at ? 'bounce' : null);
/** The sentence a sender is told when they ask for an email that is not sent because of such a mark. */
export function mailStopText(r: any): string {
  return mailStop(r) === 'complaint'
    ? `${r.name} marked our email about this document as spam, so we do not email them about it again. Only they can change that, with the button on their signing page. You can still give them their link yourself: choose Copy link next to their name.`
    : `Our last email to ${r.email} could not be delivered${r.bounce_reason ? `: ${r.bounce_reason}` : ''}. No reminder was sent. Correct the address, or choose "Try again" next to their name if the mailbox works now.`;
}

// ---- A login whose own address does not work ----------------------------------------------------

/** What GET /me says about it (email_problem): null while emails to the login arrive as far as we know. */
export const emailProblem = (u: any): { address: string; since: string; reason: string } | null =>
  (u?.email_bounced_at ? { address: u.email, since: u.email_bounced_at, reason: u.email_bounce_reason || 'the mail server will not take email for this address' } : null);

export { same as sameAddress };
