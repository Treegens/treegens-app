/**
 * Twilio plumbing shared by texts and calls: credentials, the REST client, webhook signature
 * validation, phone number handling and the few TwiML helpers both channels need.
 *
 * Everything goes out through ctx.fetch, so tests and the dev server never reach Twilio.
 * The auth token never appears in a log line, an error message or a response.
 */
import { createHmac } from 'node:crypto';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import { parsePhoneNumberFromString as parseWithNumberTypes } from 'libphonenumber-js/max';
import { hmacHex, safeEqual } from './crypto';
import { API_PREFIX, BASE_PATH, type Ctx } from './ctx';
import { cacheGet, cacheSet, getSecrets } from './repo';

// ───────────────────────── account ─────────────────────────

export interface TwilioAccount {
  accountSid: string;
  authToken: string;
  /** E.164 number calls and texts come from. May be empty when only a messaging service is set. */
  fromNumber: string;
  messagingServiceSid?: string;
  /** "mock" in local development and tests, where ctx.fetch is the in-process stand-in */
  provider: 'twilio' | 'mock';
}

// Used only when ctx.env.mockProviders is on and nothing is configured, so the dev server can
// exercise texts and calls end to end. The number is Twilio's documented test "from" number.
const MOCK_ACCOUNT = {
  accountSid: 'ACmock00000000000000000000000000',
  authToken: 'mock-twilio-auth-token',
  fromNumber: '+15005550006',
};

/** The credentials in force (environment overrides already applied by the repo), or null when Twilio is not set up. */
export async function getTwilioAccount(ctx: Ctx): Promise<TwilioAccount | null> {
  const stored = (await getSecrets(ctx)).twilio;
  const accountSid = stored?.accountSid?.trim() ?? '';
  const authToken = stored?.authToken?.trim() ?? '';
  if (accountSid && authToken) {
    const messagingServiceSid = stored?.messagingServiceSid?.trim();
    return {
      accountSid,
      authToken,
      fromNumber: stored?.fromNumber?.trim() ?? '',
      ...(messagingServiceSid ? { messagingServiceSid } : {}),
      provider: ctx.env.mockProviders ? 'mock' : 'twilio',
    };
  }
  return ctx.env.mockProviders ? { ...MOCK_ACCOUNT, provider: 'mock' } : null;
}

/** True when a text can be sent: credentials plus a sender (a number or a messaging service). */
export async function twilioConfigured(ctx: Ctx): Promise<boolean> {
  const account = await getTwilioAccount(ctx);
  return !!account && (!!account.fromNumber || !!account.messagingServiceSid);
}

/** Which channels work right now. Calls need a real "from" number; a messaging service alone cannot place one. */
export async function twilioFeatures(ctx: Ctx): Promise<{ sms: boolean; calls: boolean }> {
  const account = await getTwilioAccount(ctx);
  return { sms: !!account && (!!account.fromNumber || !!account.messagingServiceSid), calls: !!account?.fromNumber };
}

// ───────────────────────── REST client ─────────────────────────

const TWILIO_API_ROOT = 'https://api.twilio.com/2010-04-01/Accounts';
export const TWILIO_TIMEOUT_MS = 8000;
const API_PATH = /^\/[A-Za-z0-9_\-./]+$/;

export class TwilioError extends Error {
  /** HTTP status, or 0 when Twilio never answered (network failure, timeout, not configured) */
  readonly status: number;
  /** Twilio's own error code, e.g. 21211 for an invalid "To" number */
  readonly code: number | null;
  /** The request was sent but no answer came back in time, so it may or may not have taken effect. */
  readonly timedOut: boolean;

  constructor(status: number, code: number | null, message: string, timedOut = false) {
    super(message);
    this.name = 'TwilioError';
    this.status = status;
    this.code = code;
    this.timedOut = timedOut;
  }
}

export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Settles with `work`, or rejects with DeadlineError once `ms` have passed, whichever comes first.
 * An AbortSignal alone is not enough for a hard limit: a fetch implementation may ignore it.
 */
export function withDeadline<T>(work: PromiseLike<T>, ms: number, onExpire?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onExpire?.();
      } finally {
        reject(new DeadlineError(ms));
      }
    }, ms);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function oneLine(text: unknown, max = 300): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Calls the REST API with an account that was already loaded. See `twilioRequest`. */
export async function twilioRequestAs(
  ctx: Ctx,
  account: TwilioAccount,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<any> {
  const resource = typeof path === 'string' && path !== '' && !path.startsWith('/') ? `/${path}` : path;
  if (typeof resource !== 'string' || !API_PATH.test(resource) || resource.includes('..') || resource.includes('//')) {
    throw new TwilioError(0, null, 'Invalid Twilio API path');
  }
  const encoded = new URLSearchParams(params).toString();
  let url = `${TWILIO_API_ROOT}/${encodeURIComponent(account.accountSid)}${resource}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`, 'utf8').toString('base64')}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encoded;
  } else if (encoded) {
    url += `?${encoded}`;
  }

  const controller = new AbortController();
  init.signal = controller.signal;
  let res: Response;
  let text: string;
  try {
    [res, text] = await withDeadline(
      (async (): Promise<[Response, string]> => {
        const answer = await ctx.fetch(url, init);
        return [answer, await answer.text()];
      })(),
      TWILIO_TIMEOUT_MS,
      () => controller.abort(),
    );
  } catch (err) {
    if (err instanceof DeadlineError) throw new TwilioError(0, null, 'Twilio did not answer in time', true);
    throw new TwilioError(0, null, `Could not reach Twilio: ${oneLine(err instanceof Error ? err.message : err, 160)}`);
  }

  let data: any = null;
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const code = typeof data?.code === 'number' && Number.isFinite(data.code) ? data.code : null;
    const detail = typeof data?.message === 'string' && data.message.trim() ? oneLine(data.message) : `Twilio answered with status ${res.status}`;
    throw new TwilioError(res.status, code, code === null ? detail : `${detail} (Twilio error ${code})`);
  }
  if (data === null || typeof data !== 'object') {
    if (res.status === 204 || text.trim() === '') return {};
    throw new TwilioError(res.status, null, 'Twilio sent an answer that could not be read');
  }
  return data;
}

/**
 * Calls the Twilio REST API. `path` is relative to /2010-04-01/Accounts/<sid>, for example
 * "/Messages.json" (the leading slash is optional). POST parameters are form encoded, GET
 * parameters become the query string.
 * Returns the parsed JSON body. Throws TwilioError for anything else.
 */
export async function twilioRequest(ctx: Ctx, method: 'GET' | 'POST', path: string, params?: Record<string, string>): Promise<any> {
  const account = await getTwilioAccount(ctx);
  if (!account) throw new TwilioError(0, null, 'Twilio is not configured');
  return twilioRequestAs(ctx, account, method, path, params);
}

// ───────────────────────── webhook signatures ─────────────────────────

/**
 * Twilio's request signature: the full URL, followed by every POST field as name then value with
 * the names sorted and no separators, HMAC-SHA1 with the auth token, base64. A repeated name
 * contributes each distinct value once, sorted, exactly as Twilio's own libraries do.
 */
function signPairs(authToken: string, url: string, pairs: Iterable<[string, string]>): string {
  const byName = new Map<string, Set<string>>();
  for (const [name, value] of pairs) {
    const values = byName.get(name) ?? new Set<string>();
    values.add(value);
    byName.set(name, values);
  }
  let data = url;
  for (const name of [...byName.keys()].sort()) {
    for (const value of [...byName.get(name)!].sort()) data += name + value;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  return signPairs(authToken, url, Object.entries(params));
}

/** Twilio signs the URL as it knows it. Some of its edge servers include the default port, some leave it out. */
function portVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!url.toLowerCase().startsWith(origin)) return [url];
  const rest = url.slice(origin.length);
  if (parsed.port) return [url, `${parsed.protocol}//${parsed.hostname}${rest}`];
  const standard = parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : null;
  return standard === null ? [url] : [url, `${parsed.protocol}//${parsed.hostname}:${standard}${rest}`];
}

/**
 * The URL(s) Twilio may have signed for this request. The function runs behind a proxy and sees
 * its own internal host in req.url, so only the path below the API prefix and the query string
 * are taken from the request. The origin always comes from configuration.
 */
export function publicRequestUrls(ctx: Ctx, req: Request): string[] {
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return [];
  }
  if (!parsed.pathname.startsWith(`${API_PREFIX}/`)) return [];
  const tail = `${API_PREFIX.slice(BASE_PATH.length)}${parsed.pathname.slice(API_PREFIX.length)}${parsed.search}`;
  const bases = [ctx.env.publicBaseUrl, ctx.env.embedBaseUrl]
    .filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    .map((b) => b.trim().replace(/\/+$/, ''));
  const urls = new Set<string>();
  for (const base of bases) for (const url of portVariants(`${base}${tail}`)) urls.add(url);
  return [...urls];
}

/**
 * True when the request carries a valid X-Twilio-Signature for our auth token and public URL.
 * `form` is the already parsed body. In mock mode the literal signature "mock" is accepted too.
 */
export async function verifyTwilioRequest(ctx: Ctx, req: Request, form: URLSearchParams): Promise<boolean> {
  const given = (req.headers.get('x-twilio-signature') ?? '').trim();
  if (!given || given.length > 200) return false;
  if (ctx.env.mockProviders && safeEqual(given, 'mock')) return true;
  const account = await getTwilioAccount(ctx);
  if (!account) return false;
  const pairs = [...form.entries()];
  let valid = false;
  for (const url of publicRequestUrls(ctx, req)) {
    if (safeEqual(given, signPairs(account.authToken, url, pairs))) valid = true;
  }
  return valid;
}

// ───────────────────────── phone numbers ─────────────────────────

/**
 * E.164 ("+14155552671") or null when the input is not a valid number. Without a default country
 * the number has to be international: "+…", or "00…" which is read as "+…".
 */
export function normalizePhone(input: string, defaultCountry?: string): string | null {
  if (typeof input !== 'string') return null;
  let text = input.normalize('NFKC').trim();
  if (text === '' || text.length > 40) return null;
  const wanted = typeof defaultCountry === 'string' ? defaultCountry.trim().toUpperCase() : '';
  const country = wanted && isSupportedCountry(wanted) ? (wanted as CountryCode) : undefined;
  if (!country && /^00\s*[1-9]/.test(text)) text = `+${text.replace(/^00\s*/, '')}`;
  try {
    const phone = parsePhoneNumberFromString(text, country);
    return phone && phone.isValid() ? phone.number : null;
  } catch {
    return null;
  }
}

const RESTRICTED_NUMBER_TYPES = new Set(['PREMIUM_RATE', 'SHARED_COST', 'PERSONAL_NUMBER', 'UAN', 'PAGER', 'VOICEMAIL']);

/**
 * Numbers we never dial or text on our own initiative: premium rate, shared cost and similar
 * ranges bill the caller and are the classic way to turn an automated reminder into toll fraud.
 * A number whose type is unknown is not restricted.
 */
export function isRestrictedNumber(e164: string): boolean {
  try {
    const type = parseWithNumberTypes(e164)?.getType();
    return !!type && RESTRICTED_NUMBER_TYPES.has(type);
  } catch {
    return false;
  }
}

// ───────────────────────── do not contact ─────────────────────────

/**
 * Someone who says "stop" has withdrawn consent for their number, not just for one booking. The
 * number is remembered (as a keyed hash, never in the clear) and no automated text or reminder
 * call goes to it until its owner texts START, or the entry runs out after 180 days.
 */
export type ContactChannel = 'sms' | 'call';
const DO_NOT_CONTACT_TTL_SEC = 180 * 86_400;

function doNotContactName(ctx: Ctx, e164: string, channel: ContactChannel): string {
  return `dnc-${channel}-${hmacHex(ctx, 'do-not-contact', e164)}`;
}

export async function blockNumber(ctx: Ctx, e164: string, channels: ContactChannel[]): Promise<void> {
  const at = ctx.now().toISOString();
  for (const channel of channels) await cacheSet(ctx, doNotContactName(ctx, e164, channel), { blocked: true, at }, DO_NOT_CONTACT_TTL_SEC);
}

export async function unblockNumber(ctx: Ctx, e164: string, channels: ContactChannel[]): Promise<void> {
  for (const channel of channels) await cacheSet(ctx, doNotContactName(ctx, e164, channel), { blocked: false }, 0);
}

export async function isNumberBlocked(ctx: Ctx, e164: string, channel: ContactChannel): Promise<boolean> {
  return (await cacheGet<{ blocked?: boolean }>(ctx, doNotContactName(ctx, e164, channel)))?.blocked === true;
}

// ───────────────────────── TwiML ─────────────────────────

/** Escapes text for XML content and attribute values, and drops characters XML 1.0 cannot carry. */
export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wraps already escaped TwiML verbs in a <Response> document. */
export function twimlResponse(verbs: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${verbs}</Response>`, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** What a webhook answers when the request is not acceptable. Deliberately says nothing useful. */
export function webhookRefusal(status: number): Response {
  const text = status === 403 ? 'Forbidden' : status === 404 ? 'Not found' : 'Bad request';
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
