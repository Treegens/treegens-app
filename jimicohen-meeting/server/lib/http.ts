/**
 * Tiny HTTP layer: JSON helpers, body readers with hard size limits, and a router that maps
 * `Route` patterns (relative to API_PREFIX) onto handlers and turns errors into JSON.
 */
import { API_PREFIX, type Ctx } from './ctx';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /** extra response headers, e.g. Retry-After on a 429 */
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>, headers?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (fields && Object.keys(fields).length > 0) this.fields = fields;
    if (headers) this.headers = headers;
  }
}

/** Header values may never carry a line break (response splitting). */
function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`Refusing to send a ${name} header that contains a line break`);
  return value;
}

function buildHeaders(base: Record<string, string>, extra?: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(base)) headers.set(k, assertHeaderSafe(k, v));
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, assertHeaderSafe(k, v));
  return headers;
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  const h = buildHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, headers);
  // Set last so a caller can never make an API payload cacheable by accident.
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data === undefined ? null : data), { status, headers: h });
}

export function redirect(location: string, status = 302, headers?: Record<string, string>): Response {
  if (![301, 302, 303, 307, 308].includes(status)) throw new Error(`Invalid redirect status ${status}`);
  const h = buildHeaders({ 'Cache-Control': 'no-store' }, headers);
  h.set('Location', assertHeaderSafe('Location', location));
  return new Response(null, { status, headers: h });
}

export const DEFAULT_JSON_LIMIT = 256 * 1024;
export const DEFAULT_FORM_LIMIT = 64 * 1024;

function mediaType(req: Request): string {
  return (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** Reads the whole body but stops (413) as soon as it grows past `maxBytes`, whatever Content-Length claims. */
async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new HttpError(413, 'too_large', 'That request is too large.');
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'too_large', 'That request is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'invalid_body', 'The request body is not valid UTF-8 text.');
  }
}

/**
 * Parses a JSON object body. 415 when the content type is not JSON, 413 when it is larger than
 * `maxBytes`, 400 when it is empty, malformed, or not a JSON object.
 */
export async function readJson<T>(req: Request, maxBytes: number = DEFAULT_JSON_LIMIT): Promise<T> {
  const type = mediaType(req);
  if (type !== 'application/json' && !type.endsWith('+json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the request body as JSON.');
  }
  const text = decodeUtf8(await readBodyLimited(req, maxBytes));
  if (text.trim() === '') throw new HttpError(400, 'invalid_json', 'The request body is empty.');
  let parsed: unknown;
  try {
    // Dropping "__proto__" keeps a hostile body from changing prototypes when it is later merged into stored objects.
    parsed = JSON.parse(text, (key, value) => (key === '__proto__' ? undefined : value));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  return parsed as T;
}

/** Parses an application/x-www-form-urlencoded body (provider webhooks). */
export async function readForm(req: Request, maxBytes: number = DEFAULT_FORM_LIMIT): Promise<URLSearchParams> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'unsupported_media_type', 'Send the request body as a URL encoded form.');
  }
  return new URLSearchParams(decodeUtf8(await readBodyLimited(req, maxBytes)));
}

export interface RouteContext {
  ctx: Ctx;
  req: Request;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (rc: RouteContext) => Promise<Response>;

export interface Route {
  method: string;
  /** relative to API_PREFIX, e.g. "/public/event/:slug" */
  pattern: string;
  handler: Handler;
}

export function route(method: string, pattern: string, handler: Handler): Route {
  if (!pattern.startsWith('/')) throw new Error(`Route pattern must start with "/": ${pattern}`);
  return { method: method.toUpperCase(), pattern, handler };
}

function splitPath(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed === '/' || trimmed === '' ? [] : trimmed.slice(1).split('/');
}

/**
 * Matches one pattern against raw (still percent-encoded) path segments.
 * Returns the decoded params and how many segments matched literally, or null.
 * Throws URIError when a parameter is not valid percent-encoding.
 */
export function matchPattern(pattern: string, segments: string[]): { params: Record<string, string>; literal: number } | null {
  const parts = splitPath(pattern);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  let literal = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const seg = segments[i];
    if (part.startsWith(':')) {
      if (seg === '') return null;
      params[part.slice(1)] = decodeURIComponent(seg);
    } else if (part === seg) {
      literal++;
    } else {
      return null;
    }
  }
  return { params, literal };
}

function errorBody(code: string, message: string, extra?: Record<string, unknown>): { error: Record<string, unknown> } {
  return { error: { code, message, ...extra } };
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}

/** Defaults for anything a handler did not set itself. API responses are data, never documents. */
function finalize(res: Response, ctx: Ctx, head: boolean): Response {
  let out = res;
  try {
    out.headers.set('X-Request-Id', ctx.requestId);
  } catch {
    // Responses that came straight from fetch() have immutable headers: copy them.
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
    out.headers.set('X-Request-Id', ctx.requestId);
  }
  if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store');
  if (!out.headers.has('X-Content-Type-Options')) out.headers.set('X-Content-Type-Options', 'nosniff');
  if (!out.headers.has('Content-Security-Policy')) out.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (head) return new Response(null, { status: out.status, statusText: out.statusText, headers: out.headers });
  return out;
}

/**
 * Finds the route for the request and runs it. Never throws:
 * unknown path → 404, known path with another method → 405 (+ Allow), HttpError → its JSON,
 * anything else → 500 carrying the request id (details go to the log only).
 * The most specific pattern wins (more literal segments), then registration order.
 */
export async function dispatch(routes: Route[], ctx: Ctx, req: Request): Promise<Response> {
  const startedAt = ctx.now().getTime();
  const method = req.method.toUpperCase();
  const head = method === 'HEAD';
  let path = '';
  let res: Response;
  let failure: unknown;

  try {
    const url = new URL(req.url);
    path = url.pathname;
    const inApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
    const segments = inApi ? splitPath(path.slice(API_PREFIX.length) || '/') : null;

    let best: { route: Route; params: Record<string, string>; literal: number } | null = null;
    const allowed = new Set<string>();
    if (segments) {
      const wanted = head ? 'GET' : method;
      for (const r of routes) {
        const m = matchPattern(r.pattern, segments);
        if (!m) continue;
        const routeMethod = r.method.toUpperCase();
        allowed.add(routeMethod);
        if (routeMethod === wanted && (!best || m.literal > best.literal)) best = { route: r, params: m.params, literal: m.literal };
      }
    }

    if (best) {
      res = await best.route.handler({ ctx, req, url, params: best.params });
      if (!res || typeof res.status !== 'number' || !res.headers) {
        throw new Error(`Handler for ${best.route.method} ${best.route.pattern} did not return a Response`);
      }
    } else if (allowed.size > 0) {
      if (allowed.has('GET')) allowed.add('HEAD');
      res = json(errorBody('method_not_allowed', 'That method is not allowed here.'), 405, { Allow: [...allowed].sort().join(', ') });
    } else {
      res = json(errorBody('not_found', 'Not found.'), 404);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      failure = err.status >= 500 ? err : undefined;
      const extra = err.fields ? { fields: err.fields } : undefined;
      res = json(errorBody(err.code, err.message, extra), err.status, err.headers);
    } else if (err instanceof URIError) {
      res = json(errorBody('bad_request', 'The address is not valid.'), 400);
    } else {
      failure = err;
      res = json(errorBody('internal', 'Something went wrong on our side. Please try again.', { requestId: ctx.requestId }), 500);
    }
  }

  const status = res.status;
  // The query string is left out on purpose: it can carry manage and invite tokens.
  const entry = { method, path, status, ms: Math.max(0, ctx.now().getTime() - startedAt) };
  if (failure !== undefined) ctx.log('error', 'request failed', { ...entry, error: describeError(failure) });
  else ctx.log(status >= 500 ? 'warn' : 'info', 'request', entry);

  return finalize(res, ctx, head);
}
