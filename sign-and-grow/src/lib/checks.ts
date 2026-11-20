// Checking who signs: the kinds of check a sender can ask for, how an address or a number is shown without giving
// it away, what each check proves in words, and whether this server can send text messages at all. The pages, the
// certificate of completion and the server all read these from here, so none of them can say more than the others.
//
// Everything down to smsProvider() is plain constants and functions with no side effects, safe in a 'use client'
// file. smsProvider() and smsWarning() read the environment: server code and server components only.

/** What a sender can ask for before a document opens, besides the link itself and an access code of their own. */
export const CHECKS = ['none', 'email_code', 'sms_code'] as const;
export type Check = (typeof CHECKS)[number];
export const isCheck = (s: any): s is Check => (CHECKS as readonly string[]).includes(s);
export const isCodeCheck = (s: any): s is 'email_code' | 'sms_code' => s === 'email_code' || s === 'sms_code';

export const CHECK_NAMES: Record<Check, string> = {
  none: 'No extra check',
  email_code: 'One-time code by email',
  sms_code: 'One-time code by text message',
};

/** How a code travels, in the words the audit trail and the certificate use. */
export const CHANNEL_WORDS: Record<'email_code' | 'sms_code', string> = { email_code: 'email', sms_code: 'text message' };

// ---- Phone numbers ------------------------------------------------------------------------------

// Country calling codes with one digit (1 and 7) and with two digits. Every other code has three digits. Only used
// to decide where the country code ends when a number is shown masked.
const CC2 = new Set('20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(' '));
const countryCode = (digits: string): string => (digits[0] === '1' || digits[0] === '7' ? digits[0] : CC2.has(digits.slice(0, 2)) ? digits.slice(0, 2) : digits.slice(0, 3));

/**
 * A mobile number as the sender typed it, in the international form text message providers want ("E.164": a plus
 * sign, the country code and the number, 8 to 15 digits, no spaces). Spaces, dots, dashes, brackets and a "(0)" are
 * forgiven, and so is 00 in place of the plus sign. Returns null when it is not a full international number: a
 * number without a country code cannot be told apart from the same digits in another country.
 */
export function normalPhone(typed: any): string | null {
  let s = String(typed ?? '').trim().replace(/\(0\)/g, '').replace(/[\s().\- ]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** Said wherever a number is refused, so every screen and the API ask for the same thing. */
export const PHONE_HOW = 'Write the mobile number with its country code, starting with a plus sign, for example +44 7700 900123.';

/** "+44 *** *** 4321": the country and the last digits, enough for its owner to recognise and nobody to dial. */
export function maskPhone(phone: any): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return 'a mobile number';
  const cc = countryCode(digits);
  // A very short number keeps fewer digits in view, so most of it always stays hidden.
  const shown = digits.length - cc.length >= 8 ? 4 : 2;
  return `+${cc} *** *** ${digits.slice(-shown)}`;
}

/** "j***@example.com": the first letter and where the mailbox is, enough for its owner to recognise. */
export function maskEmail(email: any): string {
  const s = String(email ?? '').trim();
  const at = s.lastIndexOf('@');
  return at < 1 ? 'an email address' : `${s[0]}***${s.slice(at)}`;
}

// ---- What each check proves, in words ------------------------------------------------------------

/** "12 March 2026 14:02 UTC": a moment written so nobody has to work out a time zone or a date order. */
export function plainTime(iso: any): string {
  const d = new Date(String(iso ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * How one recipient was checked, for the certificate of completion and the sender's own page. It says what happened
 * and nothing more: "Link sent by email only" when there was no check, and a code that was asked for but never
 * typed is said to be exactly that. `passed` is the record of a code that was typed correctly: what the code was
 * sent as and to where (masked), and when.
 */
export function checkLine(r: { role?: string; access_code?: any; verify?: any; link_by_sender?: any }, passed: { how: string; at: string } | null): string {
  const inPerson = r.role === 'inperson';
  // "I will send the link myself": we know the sender had the link, not how it travelled (src/lib/bysender.ts).
  const link = inPerson ? 'Signed in person on a device of the sender, who was emailed the link' : r.link_by_sender ? 'Link shared by the sender' : 'Link sent by email';
  const code = r.access_code ? ' and an access code chosen by the sender' : '';
  // A link that did not simply arrive by email is said with the code, so the line keeps how the person got in.
  const via = inPerson || r.link_by_sender ? `${link}. ` : '';
  if (passed) return `${via}${passed.how}, passed ${plainTime(passed.at)}${r.access_code ? '. Also an access code chosen by the sender' : ''}`;
  if (isCodeCheck(r.verify)) return `${link}${code}. A one-time code by ${CHANNEL_WORDS[r.verify]} was asked for and was not passed`;
  return r.access_code ? `${link}${code}` : inPerson ? link : `${link} only`;
}

/**
 * What each way of opening a document shows about the person, and what it does not. Two sentences each, printed on
 * the security page and the help page and shown to the sender where they choose. Change them here and nowhere else.
 */
export const CHECK_PROVES: { key: 'link' | 'access_code' | 'email_code' | 'sms_code'; title: string; text: string }[] = [
  { key: 'link', title: 'The link alone', text: 'With no check, a document opens for whoever has the link from our email. That shows the email reached a mailbox, and says nothing about who opened it.' },
  { key: 'access_code', title: 'An access code', text: 'A secret the sender chooses and passes on themselves, by phone or in person. It shows that whoever opened the document was told the code, so it is as strong as the way the sender passed it on.' },
  { key: 'email_code', title: 'A one-time code by email', text: 'Shows that the person could read the mailbox at the moment they opened the document. The code goes to the same mailbox as the link, so it proves little more than the link does: it mainly stops a link that was forwarded or left open on another device.' },
  { key: 'sms_code', title: 'A one-time code by text message', text: 'Shows that the person held the phone with the number the sender typed, at the moment they opened the document. That is a second thing besides the mailbox, so it proves more than a code by email, but it is only as right as the number the sender typed and does not show who was holding the phone.' },
];

/** Said next to the list above, so nobody takes any of these for a check of an identity document. */
export const CHECK_LIMITS = 'None of these looks at a passport or an identity card, and none makes a signature "advanced" or "qualified" in the legal sense. The certificate of completion says for every signer which check was passed, to which masked address or number the code went and when, and says "Link sent by email only" when there was none, or "Link shared by the sender only" for someone whose link the sender passed on themselves.';

// ---- Settings (server only from here) ------------------------------------------------------------

type Env = Record<string, string | undefined>;
const set = (v: string | undefined) => !!(v || '').trim();

/**
 * How this server sends text messages, or null when its operator has not switched them on. Then text messages do
 * not exist in the product: nothing offers them and the API refuses them.
 *   'twilio'  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and one of TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID
 *   'hook'    SMS_WEBHOOK_URL: any other provider, through a small POST of our own
 *   'outbox'  SMS_DEV_OUTBOX=1 on a machine that is not production: texts are only written to the outbox
 */
export function smsProvider(env: Env = process.env): 'twilio' | 'hook' | 'outbox' | null {
  if (set(env.TWILIO_ACCOUNT_SID) && set(env.TWILIO_AUTH_TOKEN) && (set(env.TWILIO_FROM) || set(env.TWILIO_MESSAGING_SERVICE_SID))) return 'twilio';
  if (/^https?:\/\//i.test((env.SMS_WEBHOOK_URL || '').trim())) return 'hook';
  // The outbox delivers nothing, so it never counts as "switched on" on a real server, unless the same switch that
  // shows the email outbox there (DEV_OUTBOX=1) was set on purpose.
  if (env.SMS_DEV_OUTBOX === '1' && (env.NODE_ENV !== 'production' || env.DEV_OUTBOX === '1')) return 'outbox';
  return null;
}

/** Said by the API wherever a text message is asked for on a server that cannot send one. */
export const SMS_OFF = 'The operator of this server has not switched text messages on, so nothing can be sent by text from here.';

/** Said once when a server starts with text messages half set up, or null. */
export function smsWarning(env: Env = process.env): string | null {
  if (smsProvider(env) && smsProvider(env) !== 'outbox') return null;
  const twilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID'].filter((k) => set(env[k]));
  if (twilio.length) return `\n[config] TEXT MESSAGES ARE SWITCHED OFF, because the Twilio settings are incomplete (found: ${twilio.join(', ')}). They need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and one of TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID. Until then nobody is offered a code by text message.\n`;
  if (set(env.SMS_WEBHOOK_URL)) return '\n[config] TEXT MESSAGES ARE SWITCHED OFF, because SMS_WEBHOOK_URL is not an address that starts with https:// or http://.\n';
  if (env.SMS_DEV_OUTBOX === '1' && env.NODE_ENV === 'production') return '\n[config] SMS_DEV_OUTBOX=1 IS IGNORED on a production server, because it delivers no text message to anyone. Set up Twilio or SMS_WEBHOOK_URL to send text messages.\n';
  return null;
}
