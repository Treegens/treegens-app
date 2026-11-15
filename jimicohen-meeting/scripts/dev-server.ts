/**
 * Local stand-in for the Netlify site. Run with `npx tsx scripts/dev-server.ts`.
 *
 *   /meeting/api/*  the real API (server/api.ts) on a file-backed KV, with mocked providers
 *   /meeting/*      the built app from dist/meeting, with SPA fallback and the response
 *                   headers from netlify.toml (so the strict CSP is enforced locally too)
 *   /meet, /pod     the short links' static pages (dist/meet, dist/pod, written by the build), answered
 *                   at the root the way jimicohen.com answers them: 200 without the slash, and anything
 *                   below them opens the same page (netlify.toml)
 *
 * Environment:
 *   PORT              default 8788
 *   HOST              bind address; default is loopback only (127.0.0.1 and ::1)
 *   DIST_DIR          default dist/meeting
 *   DATA_DIR          default .data
 *   DEV_MOCK_CREDS=1  pretend every provider credential is set through the environment
 *   EMBED_BASE_URL    where embed snippets load from (default: the app's own address). "{port}" stands
 *                     for PORT, e.g. http://127.0.0.1:{port}/meeting: the same server under another
 *                     origin, the way the Netlify address relates to jimicohen.com in production
 *   DEV_CRON_SECONDS  run the scheduled job runner on this interval (off by default, use POST /dev/run-jobs)
 *   LOG_LEVEL         info (default) | warn | error
 *
 * Time can be frozen through POST /meeting/api/dev/clock (see server/routes/dev.ts).
 * POST /meeting/api/dev/settle answers once all background work (ctx.waitUntil) has finished.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../server/api';
import { runScheduled } from '../server/cron';
import { sha256Hex } from '../server/lib/crypto';
import { API_PREFIX, BASE_PATH, type Ctx, type Env, type LogLevel } from '../server/lib/ctx';
import { configureMocks, mockFetch } from '../server/lib/mocks';
import { consoleLogger } from '../server/lib/runtime';
import { fileKV } from '../server/lib/store';
import { readDevClock } from '../server/routes/dev';
import { shortNameOfPath, type ShortName } from '../shared/shortLinks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fromEnvPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? path.resolve(process.cwd(), value) : path.join(ROOT, fallback);
}

const PORT = (() => {
  const n = Number(process.env.PORT ?? '8788');
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);
  return n;
})();
const DIST_DIR = fromEnvPath('DIST_DIR', 'dist/meeting');
const DATA_DIR = fromEnvPath('DATA_DIR', '.data');
const PUBLIC_BASE_URL = `http://localhost:${PORT}${BASE_PATH}`;
const EMBED_BASE_URL = (process.env.EMBED_BASE_URL ?? '').trim().replace('{port}', String(PORT)).replace(/\/+$/, '') || undefined;
const SETUP_CODE = 'dev-setup-code';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOG_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const MIN_LOG_LEVEL: LogLevel = process.env.LOG_LEVEL === 'warn' || process.env.LOG_LEVEL === 'error' ? process.env.LOG_LEVEL : 'info';

const kv = fileKV(DATA_DIR);
// The mocks stamp what they record with the frozen dev clock when there is one, else with real time.
configureMocks({ kv, now: () => new Date() });

const env: Env = {
  // Fixed on purpose: sessions and sealed values in .data survive restarts. Never used outside local development.
  secretKey: createHash('sha256').update('meeting dev server secret').digest('base64'),
  setupCodeHash: sha256Hex(SETUP_CODE),
  publicBaseUrl: PUBLIC_BASE_URL,
  ...(EMBED_BASE_URL ? { embedBaseUrl: EMBED_BASE_URL } : {}),
  mockProviders: true,
  overrides:
    process.env.DEV_MOCK_CREDS === '1'
      ? {
          googleClientId: 'mock-client-id.apps.googleusercontent.com',
          googleClientSecret: 'mock-client-secret',
          twilioAccountSid: 'ACmock00000000000000000000000000',
          twilioAuthToken: 'mock-twilio-auth-token',
          twilioFromNumber: '+15005550006',
          anthropicApiKey: 'mock-anthropic-key',
          resendApiKey: 'mock-resend-key',
        }
      : {},
};

// ───────────────────────── request context ─────────────────────────

const background = new Set<Promise<unknown>>();

function clientIp(req: IncomingMessage): string | null {
  // Dev convenience: tests can pose as different visitors by sending X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return first || req.socket.remoteAddress || null;
}

async function buildCtx(ip: string | null): Promise<Ctx> {
  const requestId = randomUUID();
  const write = consoleLogger(requestId);
  const log: Ctx['log'] = (level, msg, data) => {
    if (LOG_RANK[level] >= LOG_RANK[MIN_LOG_LEVEL]) write(level, msg, data);
  };
  // Read once per request: the whole request sees one consistent "now".
  const frozen = await readDevClock(kv);
  return {
    kv,
    env,
    fetch: mockFetch,
    now: () => (frozen ? new Date(frozen.getTime()) : new Date()),
    waitUntil: (p) => {
      const tracked: Promise<unknown> = Promise.resolve(p)
        .catch((err) => log('error', 'background task failed', { error: err }))
        .finally(() => background.delete(tracked));
      background.add(tracked);
    },
    log,
    ip,
    requestId,
  };
}

// ───────────────────────── node <-> fetch API bridge ─────────────────────────

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const method = (req.method ?? 'GET').toUpperCase();
  // The Host header as sent, so same-origin checks see what the browser sees (also behind the Vite proxy).
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readBody(req) : null;
  return new Request(url, { method, headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined });
}

async function sendResponse(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  const body = Buffer.from(await response.arrayBuffer());
  headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(head ? undefined : body);
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
  res.end(body);
}

async function serveApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let request: Request;
  try {
    request = await toRequest(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) return sendJsonError(res, 413, 'too_large', 'That request is too large.');
    return sendJsonError(res, 400, 'bad_request', 'The request could not be read.');
  }
  const ctx = await buildCtx(clientIp(req));
  const response = await handle(request, ctx);
  await sendResponse(res, response, request.method === 'HEAD');
}

// ───────────────────────── static files ─────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

interface HeaderRule {
  /** URL prefix the rule applies to (the `for` pattern without its trailing "*"), or an exact path */
  prefix: string;
  exact: boolean;
  values: Record<string, string>;
}

/**
 * Reads the `[[headers]]` blocks of netlify.toml so local pages get the same security headers
 * as production. Two things are dropped because they only make sense over https:
 * Strict-Transport-Security and the CSP directive `upgrade-insecure-requests`.
 */
function loadHeaderRules(): HeaderRule[] {
  let toml: string;
  try {
    toml = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  } catch {
    return [];
  }
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  let inValues = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inValues = false;
      if (line === '[[headers]]') {
        current = { prefix: '', exact: true, values: {} };
        rules.push(current);
      } else if (line === '[headers.values]' && current) {
        inValues = true;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/\\(["\\])/g, '$1');
    if (!inValues && m[1] === 'for') {
      current.exact = !value.endsWith('*');
      current.prefix = current.exact ? value : value.slice(0, -1);
    } else if (inValues) {
      const name = m[1].toLowerCase();
      if (name === 'strict-transport-security') continue;
      current.values[name] =
        name === 'content-security-policy'
          ? value
              .split(';')
              .map((d) => d.trim())
              .filter((d) => d !== '' && d !== 'upgrade-insecure-requests')
              .join('; ')
          : value;
    }
  }
  return rules.filter((r) => r.prefix !== '');
}

const HEADER_RULES = loadHeaderRules();

function staticHeaders(pathname: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
  for (const rule of HEADER_RULES) {
    const matches = rule.exact ? pathname === rule.prefix : pathname.startsWith(rule.prefix);
    if (matches) Object.assign(headers, rule.values);
  }
  // Without a rule, always revalidate: a rebuilt index.html must show up on the next reload.
  if (!('cache-control' in headers)) headers['cache-control'] = 'no-cache';
  return headers;
}

async function fileIfExists(file: string): Promise<Buffer | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });

  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(BASE_PATH.length));
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return sendText(res, 400, 'Bad request');

  const target = path.resolve(DIST_DIR, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  const inside = target === DIST_DIR || target.startsWith(DIST_DIR + path.sep);
  if (!inside) return sendText(res, 404, 'Not found');

  let file = target;
  let body = target === DIST_DIR ? null : await fileIfExists(target);
  if (!body) {
    // Like the Netlify rewrite: unknown paths are client-side routes. Missing files with an
    // extension (and anything under assets/) stay 404, which keeps broken asset links visible.
    const looksLikeFile = path.extname(rel) !== '' || rel.startsWith('/assets/');
    if (looksLikeFile) return sendText(res, 404, 'Not found');
    file = path.join(DIST_DIR, 'index.html');
    body = await fileIfExists(file);
    if (!body) {
      return sendText(res, 503, `The app is not built yet (${path.relative(process.cwd(), file) || file} is missing).\nRun: npm run build\n`);
    }
  }

  const headers = staticHeaders(pathname);
  headers['content-type'] = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * A short link's page. Locally the server plays jimicohen.com, whose address never shows the slash, so
 * /pod answers 200 directly (the netlify.app address answers it with a 301 to /pod/).
 */
async function serveShortPage(req: IncomingMessage, res: ServerResponse, name: ShortName): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
  const file = path.resolve(DIST_DIR, '..', name, 'index.html');
  const body = await fileIfExists(file);
  if (!body) return sendText(res, 503, `The short page is not built yet (${file} is missing).\nRun: npm run build\n`);
  const headers = staticHeaders(`/${name}/`);
  headers['content-type'] = MIME['.html'] ?? 'text/html; charset=utf-8';
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

// ───────────────────────── server ─────────────────────────

/**
 * POST /meeting/api/dev/settle answers once every background task (ctx.waitUntil) has finished,
 * including tasks started meanwhile. Tests call it to know that "nothing more will be sent".
 * It lives here and not in server/routes/dev.ts because only this process knows its own tasks.
 */
async function settleBackground(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendJsonError(res, 405, 'method_not_allowed', 'Use POST.');
  req.resume();
  let waited = 0;
  while (background.size > 0) {
    waited += background.size;
    await Promise.all([...background]);
  }
  const body = Buffer.from(JSON.stringify({ ok: true, waited }), 'utf8');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
  res.end(body);
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname === `${API_PREFIX}/dev/settle`) return settleBackground(req, res);
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) return serveApi(req, res);
  if (pathname === '/' || pathname === BASE_PATH) {
    res.writeHead(302, { location: `${BASE_PATH}/`, 'cache-control': 'no-store', 'content-length': '0' });
    res.end();
    return;
  }
  if (pathname.startsWith(`${BASE_PATH}/`)) return serveStatic(req, res, pathname);
  const short = shortNameOfPath(pathname);
  if (short) return serveShortPage(req, res, short);
  return sendText(res, 404, 'Not found');
}

function listener(req: IncomingMessage, res: ServerResponse): void {
  onRequest(req, res).catch((err) => {
    console.error('[dev-server] request crashed:', err);
    if (!res.headersSent) sendJsonError(res, 500, 'internal', 'The dev server hit an unexpected error. See its console.');
    else res.end();
  });
}

function listen(host: string, required: boolean): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer(listener);
    server.once('error', (err) => {
      if (required) reject(err);
      else resolve(null);
    });
    server.listen(PORT, host, () => resolve(server));
  });
}

async function main(): Promise<void> {
  // A bug in a background task must be loud but must not take the server down mid test run.
  process.on('unhandledRejection', (err) => console.error('[dev-server] unhandled rejection:', err));

  const host = process.env.HOST?.trim();
  // By default listen on both loopback addresses, so "localhost" works whichever one it resolves to.
  const servers = (host ? [await listen(host, true)] : [await listen('127.0.0.1', true), await listen('::1', false)]).filter(
    (s): s is Server => s !== null,
  );

  const cronSeconds = Number(process.env.DEV_CRON_SECONDS ?? '');
  const cronTimer =
    Number.isFinite(cronSeconds) && cronSeconds >= 1
      ? setInterval(() => {
          buildCtx(null)
            .then((ctx) => runScheduled(ctx))
            .catch((err) => console.error('[dev-server] scheduled run failed:', err));
        }, cronSeconds * 1000)
      : null;

  console.log(
    [
      'Meeting dev server',
      `  App         ${PUBLIC_BASE_URL}/`,
      `  API         ${PUBLIC_BASE_URL}/api`,
      `  Static      ${DIST_DIR}`,
      `  Data        ${DATA_DIR}`,
      `  Setup code  ${SETUP_CODE}`,
      '  Providers   mocked (nothing leaves this machine)',
    ].join('\n'),
  );

  const shutdown = (): void => {
    if (cronTimer) clearInterval(cronTimer);
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[dev-server] failed to start:', err);
  process.exit(1);
});
