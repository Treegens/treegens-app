/**
 * The one server module allowed to touch the real environment: process.env, the global
 * fetch, the wall clock and Netlify Blobs. It builds the `Ctx` for a Netlify invocation.
 */
import { randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { BASE_PATH, type Ctx, type Env, type LogLevel } from './ctx';
import { blobsKV } from './store';

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * ANTHROPIC_API_KEY, but only when it is a real Anthropic key that the site set itself.
 * Netlify's AI Gateway writes its own credential into ANTHROPIC_API_KEY (and its own address into
 * ANTHROPIC_BASE_URL) in every function unless the site defines them. That value is not an
 * Anthropic key: taken as an override it would beat the key saved in the dashboard and every call
 * to api.anthropic.com would be refused. Same shape rule as a key pasted in the dashboard.
 */
function anthropicKeyFromEnv(): string | undefined {
  const key = readEnv('ANTHROPIC_API_KEY');
  if (!key) return undefined;
  const gatewayKey = readEnv('NETLIFY_AI_GATEWAY_KEY');
  if (gatewayKey && key === gatewayKey) return undefined;
  if (!key.startsWith('sk-ant-') || key.length < 20 || key.length > 300 || /\s/.test(key)) return undefined;
  return key;
}

/**
 * "https://jimicohen.com/meeting/" → "https://jimicohen.com/meeting".
 * A bare origin gets the mount path appended, because every link we send lives under it.
 * Returns '' for anything that is not an http(s) URL.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '' ? BASE_PATH : path}`;
}

export function envFromProcess(): Env {
  const setupCodeHash = readEnv('MEETING_SETUP_CODE_HASH')?.toLowerCase();
  return {
    // Left empty when unset: server/api.ts answers 503 with a clear log line instead of crashing the function.
    secretKey: readEnv('MEETING_SECRET_KEY') ?? '',
    setupCodeHash: setupCodeHash && /^[0-9a-f]{64}$/.test(setupCodeHash) ? setupCodeHash : null,
    // URL is Netlify's own variable for the site's main address; PUBLIC_BASE_URL is needed when the app is proxied under another domain.
    publicBaseUrl: normalizeBaseUrl(readEnv('PUBLIC_BASE_URL')) || normalizeBaseUrl(readEnv('URL')),
    // The app's own origin. Embeds on other websites must load from here because the proxying domain forbids framing.
    // Netlify's URL is exactly that origin, so it is the fallback; EMBED_BASE_URL stays an override.
    embedBaseUrl: normalizeBaseUrl(readEnv('EMBED_BASE_URL')) || normalizeBaseUrl(readEnv('URL')) || undefined,
    // Never taken from the environment: it would expose the dev-only routes (data reset, fake clock) in production.
    mockProviders: false,
    overrides: {
      googleClientId: readEnv('GOOGLE_CLIENT_ID'),
      googleClientSecret: readEnv('GOOGLE_CLIENT_SECRET'),
      twilioAccountSid: readEnv('TWILIO_ACCOUNT_SID'),
      twilioAuthToken: readEnv('TWILIO_AUTH_TOKEN'),
      twilioFromNumber: readEnv('TWILIO_FROM_NUMBER'),
      anthropicApiKey: anthropicKeyFromEnv(),
      resendApiKey: readEnv('RESEND_API_KEY'),
    },
  };
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|signature|sealed|refresh|credential|(?:^|_)enc$|Enc$/i;
const MAX_LOG_STRING = 2000;

/** Makes log data JSON-safe and masks anything whose key suggests a credential. */
export function redactForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_LOG_STRING ? `${value.slice(0, MAX_LOG_STRING)}… (${value.length} chars)` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (seen.has(value)) return '[circular]';
  if (depth >= 6) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForLog(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactForLog(v, depth + 1, seen);
  return out;
}

/** One JSON object per line on the console stream that matches the level. */
export function consoleLogger(requestId: string): Ctx['log'] {
  return (level: LogLevel, msg: string, data?: unknown) => {
    let line: string;
    try {
      line = JSON.stringify({ level, msg, requestId, ...(data === undefined ? {} : { data: redactForLog(data) }) });
    } catch {
      line = JSON.stringify({ level, msg, requestId, data: '[unserializable]' });
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/** The eight 16-bit groups of a valid IPv6 address (an IPv4 tail such as ::ffff:1.2.3.4 becomes the last two). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const parse = (part: string | undefined): number[] => (part ? part.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  if (rest === undefined) return front;
  const back = parse(rest);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * The form of a client address that rate limits count by. One IPv6 customer is handed a whole /64
 * and can send every request from a new address inside it, so IPv6 counts by its /64. An IPv4
 * address written as IPv6 (::ffff:a.b.c.d) counts as that IPv4 address. Anything else is kept as given.
 */
export function rateLimitAddress(raw: string): string {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (withPort) value = withPort[1];
  const zone = value.indexOf('%');
  if (zone !== -1 && value.includes(':')) value = value.slice(0, zone);
  if (isIPv4(value)) return value;
  if (!isIPv6(value)) return raw.trim();
  const groups = ipv6Groups(value);
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return value.toLowerCase();
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * Client address used for rate limiting. Netlify's `context.ip` by default. When the app is
 * reached through another proxy, set MEETING_CLIENT_IP_HEADER to the header that proxy fills
 * with the visitor's address (first entry of a comma separated list is used).
 * Only rate limits read ctx.ip, so it carries the counting form (see rateLimitAddress).
 */
function clientIp(req: Request, contextIp: string | undefined): string | null {
  const header = readEnv('MEETING_CLIENT_IP_HEADER');
  if (header) {
    const first = (req.headers.get(header) ?? '').split(',')[0].trim();
    if (first && first.length <= 64) return rateLimitAddress(first);
  }
  return contextIp && contextIp.trim() !== '' ? rateLimitAddress(contextIp) : null;
}

export function netlifyCtx(
  req: Request,
  context: { waitUntil?: (p: Promise<unknown>) => void; ip?: string; requestId?: string },
): Ctx {
  const requestId = typeof context?.requestId === 'string' && context.requestId !== '' ? context.requestId : randomUUID();
  const log = consoleLogger(requestId);
  const env = envFromProcess();
  if (env.publicBaseUrl === '') {
    // Last resort so links still resolve: the address this request was sent to.
    try {
      env.publicBaseUrl = `${new URL(req.url).origin}${BASE_PATH}`;
    } catch {
      env.publicBaseUrl = '';
    }
  }

  const waitUntil = (p: Promise<unknown>): void => {
    // A background failure must never become an unhandled rejection that kills the function.
    const guarded = Promise.resolve(p).catch((err) => log('error', 'background task failed', { error: err }));
    if (typeof context?.waitUntil === 'function') context.waitUntil(guarded);
  };

  return {
    kv: blobsKV(),
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    waitUntil,
    log,
    ip: clientIp(req, context?.ip),
    requestId,
  };
}
