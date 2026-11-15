/**
 * End-to-end harness: the real browser against the real backend (scripts/dev-server.ts) with
 * mocked providers. Plain Node ESM, no test framework. See README.md in this folder.
 *
 *   import { defineSuite } from './lib.mjs';
 *   export default defineSuite('smoke', { mockCreds: true }, async (t) => {
 *     await t.scenario('a visitor books', async (s) => {
 *       const page = await s.newPage({ timezoneId: 'Europe/London' });
 *       await s.step('open the booking page', async () => { await page.goto(s.url('/intro')); });
 *       s.expect((await s.outbox({ kind: 'email' })).length, 'emails sent').toBe(2);
 *     });
 *   });
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_DIR = path.join(ROOT, 'tests', 'e2e');
/** E2E_SCREENSHOT_DIR lets several people keep their screenshots apart, like E2E_DIST_DIR and E2E_WORK_DIR. */
export const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ? path.resolve(process.env.E2E_SCREENSHOT_DIR) : path.join(E2E_DIR, 'screenshots');
/** Must match scripts/dev-server.ts and vite.config.ts. */
export const BASE_PATH = '/meeting';
/** The dev server's one-time setup code. */
export const SETUP_CODE = 'dev-setup-code';
export const DEFAULT_PASSWORD = 'correct horse battery staple';
/** Credentials the dev server pretends to have when a suite runs with mockCreds. */
export const MOCK_GOOGLE_CLIENT_ID = 'mock-client-id.apps.googleusercontent.com';

const ACTION_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 10_000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.E2E_NAVIGATION_TIMEOUT_MS || 20_000);

// ───────────────────────── small things ─────────────────────────

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}

function show(value) {
  return inspect(value, { depth: 6, breakLength: 120, maxStringLength: 600, maxArrayLength: 30 });
}

function tail(text, lines) {
  return String(text).trimEnd().split('\n').slice(-lines).join('\n');
}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
export const green = (t) => paint(32, t);
export const red = (t) => paint(31, t);
export const dim = (t) => paint(2, t);
export const bold = (t) => paint(1, t);

/** Milliseconds from a number or from { days, hours, minutes, seconds, ms }. */
export function toMs(amount) {
  if (typeof amount === 'number') return amount;
  const a = amount ?? {};
  return (a.days ?? 0) * 86_400_000 + (a.hours ?? 0) * 3_600_000 + (a.minutes ?? 0) * 60_000 + (a.seconds ?? 0) * 1000 + (a.ms ?? 0);
}

// ───────────────────────── expectations ─────────────────────────

export class ExpectationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExpectationError';
  }
}

/** True when every key of `expected` is matched by `actual`, deeply. RegExp values test the string form. */
export function matchesObject(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (typeof expected === 'function') return !!expected(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matchesObject(actual[i], item));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.keys(expected).every((key) => matchesObject(actual[key], expected[key]));
  }
  return isDeepStrictEqual(actual, expected);
}

/**
 * expect(actual, 'what it is').toBe(…) and friends. Every matcher throws ExpectationError with
 * both values spelled out. `.not` inverts.
 */
export function expect(actual, label = 'value') {
  const build = (negate) => {
    const check = (pass, verb, expected) => {
      if (pass !== negate) return;
      const lines = [`Expected ${label} ${negate ? 'not ' : ''}${verb}`];
      if (expected !== undefined) lines.push(`  expected: ${show(expected)}`);
      lines.push(`  actual:   ${show(actual)}`);
      throw new ExpectationError(lines.join('\n'));
    };
    return {
      toBe: (expected) => check(Object.is(actual, expected), 'to be', expected),
      toEqual: (expected) => check(isDeepStrictEqual(actual, expected), 'to equal', expected),
      toMatchObject: (expected) => check(matchesObject(actual, expected), 'to match', expected),
      toContain: (expected) =>
        check(typeof actual === 'string' ? actual.includes(expected) : Array.isArray(actual) && actual.some((item) => isDeepStrictEqual(item, expected)), 'to contain', expected),
      toMatch: (pattern) => check(typeof actual === 'string' && pattern.test(actual), 'to match', pattern),
      toBeTruthy: () => check(!!actual, 'to be truthy'),
      toBeFalsy: () => check(!actual, 'to be falsy'),
      toBeNull: () => check(actual === null, 'to be null'),
      toBeDefined: () => check(actual !== undefined && actual !== null, 'to be defined'),
      toBeGreaterThan: (n) => check(actual > n, 'to be greater than', n),
      toBeGreaterThanOrEqual: (n) => check(actual >= n, 'to be at least', n),
      toBeLessThan: (n) => check(actual < n, 'to be less than', n),
      toBeLessThanOrEqual: (n) => check(actual <= n, 'to be at most', n),
      toHaveLength: (n) => check(actual != null && actual.length === n, `to have length ${n}`, undefined),
    };
  };
  return { ...build(false), not: build(true) };
}

/** Runs `fn` until it stops throwing (or returns a non-false value). Returns what it returned. */
export async function eventually(fn, { timeout = 5000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value !== false) return value;
      lastError = new Error('returned false');
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) throw new ExpectationError(`Timed out after ${timeout} ms waiting for ${label}: ${lastError?.message ?? lastError}`);
    await sleep(interval);
  }
}

// ───────────────────────── build ─────────────────────────

/** The folder that holds `meeting/` (the built app). E2E_DIST_DIR lets several people build side by side. */
export function distRoot() {
  return path.resolve(process.env.E2E_DIST_DIR || path.join(ROOT, 'dist'));
}

/**
 * Builds the app once into <dist>/meeting (vite build --outDir). Returns that folder.
 * E2E_SKIP_BUILD=1 reuses an existing build.
 */
export function buildApp({ dist = distRoot(), quiet = false } = {}) {
  const outDir = path.join(dist, 'meeting');
  if (process.env.E2E_SKIP_BUILD === '1' && fs.existsSync(path.join(outDir, 'index.html'))) {
    if (!quiet) console.log(dim(`build: reusing ${outDir}`));
    return outDir;
  }
  const started = Date.now();
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, VITE_MOCK_API: '' } });
  if (result.status !== 0 || !fs.existsSync(path.join(outDir, 'index.html'))) {
    throw new Error(`vite build failed (exit ${result.status}).\n${tail(`${result.stdout}\n${result.stderr}`, 40)}`);
  }
  if (!quiet) console.log(dim(`build: ${outDir} (${Date.now() - started} ms)`));
  return outDir;
}

// ───────────────────────── dev server ─────────────────────────

const liveServers = new Set();
let cleanupInstalled = false;

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = () => {
    for (const child of liveServers) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    liveServers.clear();
  };
  process.on('exit', killAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      killAll();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  process.on('uncaughtException', (err) => {
    console.error(err);
    killAll();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error(err);
    killAll();
    process.exit(1);
  });
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function isPortFree(port) {
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'));
}

/** True when something answers HTTP on the port. A refused connection is the proof that a server is gone. */
export async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** "8800-8809" → [8800, …, 8809]. Also accepts [from, to] and a list of ports. */
export function parsePorts(spec) {
  if (Array.isArray(spec) && spec.length === 2 && spec[1] >= spec[0]) return Array.from({ length: spec[1] - spec[0] + 1 }, (_, i) => spec[0] + i);
  if (Array.isArray(spec)) return spec.map(Number);
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(spec ?? '').trim());
  if (m && Number(m[2]) >= Number(m[1])) return parsePorts([Number(m[1]), Number(m[2])]);
  const single = Number(spec);
  if (Number.isInteger(single) && single > 0) return [single];
  throw new Error(`Cannot read a port range from "${spec}". Use for example 8800-8809.`);
}

/**
 * Starts scripts/dev-server.ts on the first free port of `ports`, with a fresh data folder.
 * Resolves once the API answers. The log of the server goes to `<workDir>/server.log`.
 */
export async function startServer({ name = 'e2e', ports = process.env.E2E_PORTS || '8800-8899', mockCreds = true, dist = path.join(distRoot(), 'meeting'), workDir, env = {} } = {}) {
  installCleanup();
  const dir = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `meeting-e2e-${slug(name)}-`));
  const dataDir = path.join(dir, 'data');
  const logFile = path.join(dir, 'server.log');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`No built app in ${dist}. Run buildApp() first (or npm run build).`);

  const tried = [];
  for (const port of parsePorts(ports)) {
    if (!(await isPortFree(port))) {
      tried.push(`${port} (in use)`);
      continue;
    }
    fs.writeFileSync(logFile, '');
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'dev-server.ts')], {
      cwd: ROOT,
      env: { ...process.env, HOST: '', DEV_CRON_SECONDS: '', ...env, PORT: String(port), DATA_DIR: dataDir, DIST_DIR: dist, DEV_MOCK_CREDS: mockCreds ? '1' : '' },
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    liveServers.add(child);
    let exited = null;
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      liveServers.delete(child);
    });

    const origin = `http://localhost:${port}`;
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (!exited && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${BASE_PATH}/api/dev/clock`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    const readLog = () => {
      try {
        return fs.readFileSync(logFile, 'utf8');
      } catch {
        return '';
      }
    };
    if (!ready) {
      child.kill('SIGKILL');
      if (exited && /EADDRINUSE/.test(readLog())) {
        tried.push(`${port} (taken while starting)`);
        continue;
      }
      throw new Error(`The dev server did not come up on port ${port}.\n${tail(readLog(), 30)}`);
    }

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (!exited) {
        child.kill('SIGTERM');
        for (let i = 0; i < 30 && !exited; i++) await sleep(100);
        if (!exited) child.kill('SIGKILL');
        for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      }
      liveServers.delete(child);
      for (let i = 0; i < 30 && (await portAnswers(port)); i++) await sleep(100);
      if (await portAnswers(port)) throw new Error(`Port ${port} still answers after the dev server (pid ${child.pid}) was stopped.`);
    };
    return { name, port, pid: child.pid, origin, base: `${origin}${BASE_PATH}`, api: `${origin}${BASE_PATH}/api`, dataDir, workDir: dir, logFile, mockCreds, log: readLog, stop, exited: () => exited };
  }
  throw new Error(`No free port for the dev server. Tried: ${tried.join(', ') || '(empty range)'}`);
}

// ───────────────────────── API client ─────────────────────────

/**
 * Talks to the API like the app does: Origin and X-Requested-With on writes, a cookie jar,
 * and an X-Forwarded-For of its own so rate limits are counted per client.
 */
export class ApiClient {
  constructor(server, ip) {
    this.server = server;
    this.ip = ip;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  storeCookies(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * One request. `path` is relative to /meeting/api. Options: body (JSON), form (urlencoded,
   * sent as a Twilio webhook with the mock signature), query, headers. Never throws for an
   * HTTP status. Returns { status, ok, data, text, headers, location }.
   */
  async request(method, pathname, { body, form, query, headers = {} } = {}) {
    const url = new URL(`${this.server.api}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const verb = method.toUpperCase();
    const send = { Accept: 'application/json', 'X-Forwarded-For': this.ip, ...headers };
    if (this.cookies.size > 0) send.Cookie = this.cookieHeader();
    let payload;
    if (form !== undefined) {
      send['Content-Type'] = 'application/x-www-form-urlencoded';
      if (!('X-Twilio-Signature' in send)) send['X-Twilio-Signature'] = 'mock';
      payload = new URLSearchParams(form).toString();
    } else {
      if (verb !== 'GET' && verb !== 'HEAD') {
        if (!('Origin' in send)) send.Origin = this.server.origin;
        if (!('X-Requested-With' in send)) send['X-Requested-With'] = 'meeting';
      }
      if (body !== undefined) {
        send['Content-Type'] = 'application/json';
        payload = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    const response = await fetch(url, { method: verb, headers: send, body: payload, redirect: 'manual' });
    this.storeCookies(response);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, text, headers: response.headers, location: response.headers.get('location') };
  }

  /** Like request(), but throws when the status is not 2xx and returns the parsed body. */
  async ok(method, pathname, options) {
    const res = await this.request(method, pathname, options);
    if (!res.ok) throw new Error(`${method} ${pathname} answered ${res.status}: ${res.text.slice(0, 400)}`);
    return res.data;
  }
}

function outboxMatcher(filter) {
  if (!filter) return () => true;
  if (typeof filter === 'function') return filter;
  return (entry) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = entry[key];
      // `to: 'ada@example.com'` matches an email sent to several people as well.
      if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((item) => matchesObject(item, expected));
      return matchesObject(actual, expected);
    });
}

function describeOutbox(entries) {
  if (entries.length === 0) return '  (the outbox is empty)';
  return entries
    .map((e) => `  #${e.index} ${e.at ?? ''} ${e.service}/${e.kind} ${e.status}${e.to ? ` to=${[].concat(e.to).join(',')}` : ''}${e.subject ? ` subject=${JSON.stringify(e.subject)}` : ''}${e.injected ? ` injected=${e.injected}` : ''}`)
    .join('\n');
}

/**
 * Everything a test needs from the dev routes, on top of an ApiClient. Both the suite (`t`)
 * and each scenario (`s`) have these methods.
 */
class DevTools {
  constructor(server, ip) {
    this.server = server;
    this.ip = ip;
    this.client = new ApiClient(server, ip);
    /** pages that follow the dev clock */
    this.pages = new Set();
  }

  /** Absolute URL of an app page: url('/intro') → http://localhost:8800/meeting/intro */
  url(route = '/') {
    return `${this.server.base}${route.startsWith('/') ? route : `/${route}`}`;
  }

  api(method, pathname, options) {
    return this.client.request(method, pathname, options);
  }

  apiOk(method, pathname, options) {
    return this.client.ok(method, pathname, options);
  }

  /** A second, unrelated client: its own cookies and its own IP address. */
  visitor(ip = nextIp()) {
    return new ApiClient(this.server, ip);
  }

  // ── data ──

  /** Wipes ALL stored data (a fresh first run) and forgets this client's cookies. */
  async reset() {
    this.client.cookies.clear();
    return this.apiOk('POST', '/dev/reset', { body: {} });
  }

  /** Waits until every background task of the server (what it does after answering) has finished. */
  async settle() {
    return this.apiOk('POST', '/dev/settle', { body: {} });
  }

  // ── outbox ──

  /**
   * What the mocks recorded, oldest first, each with its `index`. Filter by a function or by
   * fields: outbox({ kind: 'email', to: 'ada@example.com', subject: /Confirmed/ }).
   */
  async outbox(filter) {
    const { outbox } = await this.apiOk('GET', '/dev/outbox');
    return outbox.map((entry, index) => ({ ...entry, index })).filter(outboxMatcher(filter));
  }

  async clearOutbox() {
    await this.apiOk('DELETE', '/dev/outbox');
  }

  /** Polls the outbox until at least `count` entries match. Returns them. */
  async waitForOutbox(filter, { count = 1, timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = await this.outbox(filter);
      if (found.length >= count) return found;
      if (Date.now() >= deadline) {
        throw new ExpectationError(`Waited ${timeout} ms for ${count} outbox entr${count === 1 ? 'y' : 'ies'} matching ${show(filter)}, found ${found.length}. The outbox holds:\n${describeOutbox(await this.outbox())}`);
      }
      await sleep(100);
    }
  }

  // ── clock ──

  /** The server's "now" as an ISO string: the frozen dev clock, or real time when it is not frozen. */
  async now() {
    const { now } = await this.apiOk('GET', '/dev/clock');
    return now ?? new Date().toISOString();
  }

  /** Freezes the server clock (ISO string or Date). `null` returns to real time. Open pages follow. */
  async setClock(at) {
    const { now } = await this.apiOk('POST', '/dev/clock', { body: { now: at === null ? null : new Date(at).toISOString() } });
    await this.syncPageClocks(now);
    return now;
  }

  /** Moves the frozen clock on: advanceClock({ hours: 23 }) or advanceClock(ms). Open pages follow. */
  async advanceClock(amount) {
    const { now } = await this.apiOk('POST', '/dev/clock', { body: { advanceMs: toMs(amount) } });
    await this.syncPageClocks(now);
    return now;
  }

  async syncPageClocks(now) {
    for (const page of this.pages) {
      if (!page.isClosed()) await page.clock.setSystemTime(now ? new Date(now) : new Date());
    }
  }

  // ── jobs, calls, bookings, raw store ──

  /** What the cron function does (deliver due messages, housekeeping), then waits for background work. */
  async runJobs() {
    const result = await this.apiOk('POST', '/dev/run-jobs', { body: {} });
    await this.settle();
    return result;
  }

  /**
   * The one-time setup of the short links (server/lib/seed.ts), which only the deploy's scheduled function
   * runs in production and runJobs() never does. Returns its report, or 'already_done'.
   */
  async runOneTimeMoves() {
    const result = await this.apiOk('POST', '/dev/one-time-moves', { body: {} });
    await this.settle();
    return result.shortLinks;
  }

  /**
   * Address of a short link: shortUrl('pod') → http://localhost:8800/pod, the way jimicohen.com/pod reaches
   * the app. { origin: 'http://127.0.0.1:8800' } plays the app's own (netlify.app) address.
   */
  shortUrl(name, { origin } = {}) {
    return `${origin ?? this.server.origin}/${name}`;
  }

  /** A plain request, no browser and no scripts, the way a link preview crawler fetches a page. */
  async fetchHtml(url, { userAgent = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)' } = {}) {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'manual' });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  /** Queued jobs, soonest first. */
  async jobs(filter) {
    const { jobs } = await this.apiOk('GET', '/dev/jobs');
    return jobs.filter(outboxMatcher(filter));
  }

  /** Calls placed through mock Twilio: { sid, callId, to, status, record: <our CallRecord> }. */
  async calls() {
    return (await this.apiOk('GET', '/dev/calls')).calls;
  }

  /** Every booking, oldest first, each with manageToken and manageUrl. */
  async bookings(filter) {
    return (await this.apiOk('GET', '/dev/bookings')).bookings.filter(outboxMatcher(filter));
  }

  /** Raw value of one key in the store, e.g. kv('hosts'). */
  async kv(key) {
    return (await this.apiOk('GET', '/dev/kv', { query: { key } })).value;
  }

  async kvKeys(prefix = '') {
    return (await this.apiOk('GET', '/dev/kv', { query: { prefix } })).keys;
  }

  /** Writes one raw record, for data in the shape an older deploy left it. null removes it. */
  async putKv(key, value) {
    return this.apiOk('PUT', '/dev/kv', { body: { key, value } });
  }

  /** The Google accounts of a host as stored: { main, extras }. */
  async googleAccountsOf(hostId) {
    const host = ((await this.kv('hosts')) ?? []).find((h) => h.id === hostId) ?? null;
    return { main: host?.google ?? null, extras: host?.googleExtra ?? [] };
  }

  // ── mock Google ──

  /** Busy time of a mock Google account: [{ start, end, calendarId? }]. Replaces what was set before. */
  async setGoogleBusy(email, busy) {
    return this.apiOk('PUT', '/dev/google/busy', { body: { email, busy } });
  }

  async clearGoogleBusy(email) {
    return this.apiOk('DELETE', '/dev/google/busy', { query: { email } });
  }

  /** Change a mock Google account: { timezone, calendars, revoked }. */
  async setGoogleAccount(email, change) {
    return (await this.apiOk('PUT', '/dev/google/account', { body: { email, ...change } })).account;
  }

  /** Events on the mock calendars: [{ account, calendarId, event }]. */
  async googleEvents(email) {
    return (await this.apiOk('GET', '/dev/google/events', { query: { email } })).events;
  }

  // ── failures, model, feeds ──

  /**
   * Makes a mocked service fail until cleared. failService('resend') answers 500;
   * failService('google-freebusy', { mode: 'timeout', ms: 300 }); failService('twilio-sms', { status: 400, code: 21610 });
   * add `times: 1` to fail once, `account` to hit one Google account. Service names: see server/lib/mocks.ts.
   */
  async failService(service, spec = {}) {
    return this.apiOk('PUT', '/dev/fail', { body: { service, ...spec } });
  }

  async clearFailures(service) {
    return this.apiOk('DELETE', '/dev/fail', { query: { service } });
  }

  /** Answers the mock model gives next, in order: [{ say, action }, { stopReason: 'refusal' }, { text: 'raw' }, { status: 529 }]. */
  async scriptModel(replies) {
    return this.apiOk('PUT', '/dev/llm-script', { body: { replies } });
  }

  /** A calendar feed served by the mock. Returns its https address to paste into the app. */
  async setIcsFeed(name, feed) {
    return (await this.apiOk('PUT', '/dev/ics', { body: { name, ...feed } })).url;
  }

  // ── Twilio webhooks ──

  /**
   * Plays Twilio for a call: voice(call, 'start'), voice(call, 'turn', { SpeechResult: 'yes' }),
   * voice(call, 'status', { CallStatus: 'completed', CallDuration: '42' }), voice(call, 'amd', { AnsweredBy: 'human' }).
   * `call` is an entry of calls() (or { sid, callId }). Returns { status, xml, said, listens, hangsUp }.
   */
  async voice(call, step, fields = {}) {
    const res = await this.visitor('54.172.60.1').request('POST', `/twilio/voice/${step}`, { query: { c: call.callId }, form: { CallSid: call.sid, ...fields } });
    const xml = res.text;
    const said = [...xml.matchAll(/<Say\b[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => unescapeXml(m[1])).join(' ');
    return { status: res.status, xml, said, listens: xml.includes('<Gather '), hangsUp: xml.includes('<Hangup/>') };
  }

  /** A text message sent to our number. Returns { status, xml, reply }. */
  async inboundSms(from, body) {
    const res = await this.visitor('54.172.60.2').request('POST', '/twilio/sms', { form: { From: from, Body: body, MessageSid: `SM${'0'.repeat(32)}` } });
    const reply = [...res.text.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((m) => unescapeXml(m[1])).join(' ');
    return { status: res.status, xml: res.text, reply };
  }

  // ── bookings through the API ──

  /** Bookable start times: slots({ slug: 'intro', duration: 15, from, to }) → [ISO, …]. `from`/`to` default to the next 14 days. */
  async slots({ slug, duration, from, to, visitor = this.visitor() } = {}) {
    const start = from ? new Date(from) : new Date(await this.now());
    const end = to ? new Date(to) : new Date(start.getTime() + 14 * 86_400_000);
    const res = await visitor.ok('GET', '/public/slots', { query: { slug, duration, from: start.toISOString(), to: end.toISOString() } });
    return res.slots.map((slot) => slot.start);
  }

  /**
   * Books through the API, as a visitor of its own (useful to prepare a scenario). Returns the
   * raw answer { status, ok, data: { booking, manageToken } } so a refusal can be asserted too.
   */
  async book({ slug = 'intro', start, durationMin = 15, name = 'Ada Lovelace', email = 'ada@example.com', timezone = 'America/New_York', visitor = this.visitor(), ...rest } = {}) {
    return visitor.request('POST', '/public/bookings', { body: { slug, start, durationMin, name, email, timezone, elapsedMs: 5000, ...rest } });
  }

  // ── sign-in ──

  /** First-run setup through the API with the dev setup code. This client is signed in afterwards. */
  async setupAdmin({ password = DEFAULT_PASSWORD, timezone = 'UTC' } = {}) {
    await this.apiOk('POST', '/auth/setup', { body: { code: SETUP_CODE, password, deviceTimezone: timezone } });
    return { password };
  }

  async login(password = DEFAULT_PASSWORD) {
    await this.apiOk('POST', '/auth/login', { body: { password } });
  }
}

function unescapeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

let ipCounter = 0;
/** A fresh private address for every client, so no two share a rate-limit bucket. */
function nextIp() {
  ipCounter += 1;
  return `10.${50 + (process.pid % 150)}.${Math.floor(ipCounter / 250) % 250}.${1 + (ipCounter % 250)}`;
}

// ───────────────────────── browser ─────────────────────────

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      return createRequire(import.meta.url)('playwright');
    } catch {
      throw new Error('Playwright is not available. It is expected as a global package (npm install -g playwright).');
    }
  }
}

/**
 * Chromium that cannot reach anything but this machine: it ignores any proxy from the
 * environment and resolves no host name except localhost. Requests to other sites that the
 * page makes directly are answered by the scenario's network guard (see newPage); the ones the
 * guard cannot see, such as a redirect that leaves the app, fail at once instead of going out.
 */
export async function launchBrowser() {
  const { chromium } = await loadPlaywright();
  return chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
}

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Google's consent screen, played by the harness. Checks the request the way Google would and
 * answers with a redirect back to our callback. Returns what to fulfil the request with.
 */
function consentAnswer(requestUrl, armed, server) {
  const p = requestUrl.searchParams;
  const problems = [];
  if (requestUrl.pathname !== '/o/oauth2/v2/auth') problems.push(`unexpected path ${requestUrl.pathname}`);
  if (!p.get('client_id')) problems.push('client_id is missing');
  if (p.get('response_type') !== 'code') problems.push(`response_type is ${p.get('response_type')}, expected code`);
  if (p.get('access_type') !== 'offline') problems.push('access_type=offline is missing (no refresh token would be issued)');
  // A space separated list: "consent", or "consent select_account" when the account chooser is asked for.
  const prompt = (p.get('prompt') ?? '').split(/\s+/).filter(Boolean);
  if (!prompt.includes('consent')) problems.push('prompt=consent is missing');
  if (prompt.some((v) => !['consent', 'select_account'].includes(v))) problems.push(`unexpected prompt ${p.get('prompt')}`);
  if (!p.get('state')) problems.push('state is missing');
  const redirectUri = p.get('redirect_uri') ?? '';
  if (redirectUri !== `${server.api}/google/callback`) problems.push(`redirect_uri is ${redirectUri || '(missing)'}, expected ${server.api}/google/callback`);
  const scopes = (p.get('scope') ?? '').split(/\s+/).filter(Boolean);
  for (const scope of ['openid', 'email', ...CALENDAR_SCOPES]) if (!scopes.includes(scope)) problems.push(`scope ${scope} was not requested`);
  const request = {
    url: requestUrl.href,
    clientId: p.get('client_id'),
    redirectUri,
    scopes,
    state: p.get('state'),
    loginHint: p.get('login_hint'),
    gmailRequested: scopes.includes(GMAIL_SCOPE),
    accountChooser: prompt.includes('select_account'),
  };
  if (problems.length > 0) {
    return { request, problems, fulfil: { status: 400, contentType: 'text/plain; charset=utf-8', body: `Error 400: invalid_request\n${problems.join('\n')}` } };
  }

  const back = new URL(redirectUri);
  back.searchParams.set('state', request.state);
  if (armed.deny) {
    back.searchParams.set('error', armed.deny === true ? 'access_denied' : String(armed.deny));
  } else {
    const flags = [...armed.flags];
    if (request.gmailRequested && armed.gmail !== false && !flags.includes('gmail')) flags.push('gmail');
    back.searchParams.set('code', ['mock', armed.email, armed.zone, ...flags].join(':'));
    back.searchParams.set('scope', scopes.join(' '));
    back.searchParams.set('authuser', '0');
    back.searchParams.set('prompt', 'consent');
  }
  return { request, problems, fulfil: { status: 302, headers: { location: back.href } } };
}

// ───────────────────────── scenario ─────────────────────────

class ScenarioAbort extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause));
    this.name = 'ScenarioAbort';
    this.cause = cause;
  }
}

class Scenario extends DevTools {
  constructor(suite, name) {
    super(suite.server, nextIp());
    this.suite = suite;
    this.name = name;
    this.slug = slug(name);
    this.steps = [];
    this.failures = [];
    this.contexts = [];
    this.console = [];
    this.allowedConsole = [];
    this.allowedExternal = [];
    this.localOrigins = [];
    this.shots = 0;
    this.consent = new WeakMap();
  }

  /** expect(actual, 'label') */
  expect(actual, label) {
    return expect(actual, label);
  }

  /** Retries `fn` until it passes: eventually(async () => { expect(await s.jobs()).toHaveLength(0) }) */
  eventually(fn, options) {
    return eventually(fn, options);
  }

  /** Console errors matching one of these are expected in this scenario (for example /status of 409/). */
  allowConsoleErrors(...patterns) {
    this.allowedConsole.push(...patterns);
  }

  /** Requests to other sites are blocked and fail the scenario, unless their URL matches one of these. */
  allowExternalRequests(...patterns) {
    this.allowedExternal.push(...patterns);
  }

  /**
   * Lets pages of this scenario really load another origin on THIS machine, for example a page a
   * test serves on its own port to embed the app in (allowLocalOrigin('http://localhost:8899')).
   * Anything that is not localhost stays blocked.
   */
  allowLocalOrigin(...origins) {
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error(`allowLocalOrigin is for pages on this machine, not ${origin}`);
      this.localOrigins.push(url.origin);
    }
  }

  /**
   * A named step. Prints a line, and on failure records the error with a screenshot of every
   * open page and the browser console, then ends the scenario. Returns what `fn` returns.
   */
  async step(name, fn) {
    const started = Date.now();
    try {
      const value = await fn();
      this.steps.push({ name, ok: true, ms: Date.now() - started });
      console.log(`    ${green('✓')} ${name} ${dim(`${Date.now() - started} ms`)}`);
      return value;
    } catch (err) {
      this.steps.push({ name, ok: false, ms: Date.now() - started });
      await this.recordFailure(name, err);
      throw new ScenarioAbort(err);
    }
  }

  /** Like step(), but the scenario carries on after a failure (which still fails the suite). */
  async softStep(name, fn) {
    try {
      return await this.step(name, fn);
    } catch (err) {
      if (!(err instanceof ScenarioAbort)) throw err;
      return undefined;
    }
  }

  async recordFailure(step, err) {
    const screenshots = [];
    for (const page of this.openPages()) {
      try {
        screenshots.push(await this.screenshot(page, `FAILED-${step}`));
      } catch {
        // a page that cannot be captured must not hide the real failure
      }
    }
    const failure = {
      step,
      // Playwright colours its call logs. Reports are read in files and CI logs, so the codes come out.
      message: String(err?.message ?? err).replace(/\u001b\[[0-9;]*m/g, ''),
      stack: err instanceof ExpectationError ? null : (err?.stack ?? null),
      urls: this.openPages().map((p) => p.url()),
      screenshots,
      console: this.console.slice(-15).map((c) => `[${c.type}] ${c.text}`),
    };
    this.failures.push(failure);
    console.log(`    ${red('✗')} ${step}`);
    console.log(red(indent(failure.message, 6)));
    for (const url of failure.urls) console.log(dim(`      at ${url}`));
    for (const shot of screenshots) console.log(dim(`      screenshot: ${path.relative(ROOT, shot)}`));
    if (failure.console.length > 0) console.log(dim(indent(`browser console:\n${failure.console.join('\n')}`, 6)));
  }

  openPages() {
    return this.contexts.flatMap((context) => context.pages()).filter((page) => !page.isClosed());
  }

  /**
   * A page in a browser context of its own (its own cookies and storage).
   *   viewport     default 1280 x 800; a phone is { width: 390, height: 844 } with isMobile and hasTouch
   *   timezoneId   the visitor's time zone, default UTC
   *   locale       default en-US
   *   signedIn     start with this scenario's admin session (after setupAdmin() or login())
   *   ip           the address the server sees, default this scenario's
   *   allowConsoleErrors  patterns that are fine on this page
   * Other options go to browser.newContext (colorScheme, reducedMotion, isMobile, hasTouch, …).
   * While the dev clock is frozen, the page's own clock shows the same time.
   */
  async newPage({ viewport = { width: 1280, height: 800 }, timezoneId = 'UTC', locale = 'en-US', signedIn = false, ip = this.ip, allowConsoleErrors = [], ...contextOptions } = {}) {
    const context = await this.suite.browser.newContext({
      viewport,
      timezoneId,
      locale,
      baseURL: this.server.origin,
      serviceWorkers: 'block',
      extraHTTPHeaders: { 'X-Forwarded-For': ip },
      ...contextOptions,
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    this.contexts.push(context);

    // Nothing leaves this machine: fonts get an empty stylesheet, Google's consent screen is
    // played by connectGoogle(), and any other outside request is blocked and reported.
    const origin = this.server.origin;
    await context.route(
      (url) => /^https?:$/.test(url.protocol) && url.origin !== origin,
      async (route) => {
        const url = new URL(route.request().url());
        if (this.localOrigins.includes(url.origin)) return route.continue();
        if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: '/* web fonts are not loaded in end-to-end tests */' });
        if (url.hostname === 'fonts.gstatic.com') return route.fulfill({ status: 204, body: '' });
        if (url.hostname === 'accounts.google.com') return route.fulfill(this.googleConsent(context, url));
        if (!this.allowedExternal.some((pattern) => pattern.test(url.href))) {
          this.failures.push({ step: 'network', message: `The page asked for something outside the app: ${route.request().method()} ${url.href}`, urls: [], screenshots: [], console: [], stack: null });
        }
        return route.abort('blockedbyclient');
      },
    );

    // The app reaches Google's consent screen through a redirect from our own connect route, and
    // a redirect cannot be intercepted on its way out. So the connect request itself is caught:
    // the real route runs (session check, signed state, authorization URL), and where the browser
    // would now leave for accounts.google.com it gets Google's answer instead, a redirect to our
    // real callback.
    await context.route(
      (url) => url.origin === origin && url.pathname === `${BASE_PATH}/api/google/connect`,
      async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers().location;
        let target = null;
        try {
          target = location ? new URL(location) : null;
        } catch {
          target = null;
        }
        if (response.status() >= 300 && response.status() < 400 && target?.hostname === 'accounts.google.com') return route.fulfill(this.googleConsent(context, target));
        return route.fulfill({ response });
      },
    );

    // The page's clock starts at the server's "now" (the frozen dev clock, or real time) and
    // runs on from there, so the calendar shows the same day the server computes slots for.
    // setClock() and advanceClock() move it along; linger() lets a moment pass on one page.
    const frozen = (await this.apiOk('GET', '/dev/clock')).now;
    await context.clock.install({ time: frozen ? new Date(frozen) : new Date() });
    if (signedIn) {
      if (this.client.cookies.size === 0) throw new Error('newPage({ signedIn: true }) needs a session first: call s.setupAdmin() or s.login().');
      await context.addCookies([...this.client.cookies].map(([name, value]) => ({ name, value, domain: 'localhost', path: BASE_PATH, httpOnly: true, sameSite: 'Lax' })));
    }

    // Every page of the context is watched, also a tab the app opens itself (target="_blank").
    const allowed = [...allowConsoleErrors];
    context.on('page', (opened) => {
      this.pages.add(opened);
      opened.on('console', (message) => {
        this.console.push({ type: message.type(), text: message.text(), url: opened.url(), allowed });
      });
      opened.on('pageerror', (error) => {
        this.console.push({ type: 'pageerror', text: error?.stack || error?.message || String(error), url: opened.url(), allowed });
      });
    });
    return context.newPage();
  }

  /**
   * Lets time pass on a page without waiting for it (2 seconds by default). People take a
   * moment to fill in a form, and the booking form refuses a submit that comes within 1.5
   * seconds of opening, the way it refuses a bot. Call this before pressing "Confirm booking".
   */
  async linger(page, ms = 2000) {
    await page.clock.fastForward(ms);
  }

  /** Console errors and uncaught page errors nobody allowed. */
  unexpectedConsole() {
    return this.console.filter((c) => (c.type === 'error' || c.type === 'pageerror') && ![...this.allowedConsole, ...c.allowed].some((pattern) => pattern.test(c.text)));
  }

  /** What Google's consent screen answers for a browser context, as route.fulfill options. Problems fail the scenario. */
  googleConsent(context, authUrl) {
    const armed = this.consent.get(context);
    if (!armed) {
      this.failures.push({ step: 'google consent', message: `The app went to Google's consent screen, but no account was armed. Call s.connectGoogle(page, email, zone) first.\n${authUrl.href}`, urls: [], screenshots: [], console: [], stack: null });
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: 'Mock Google consent screen: no account armed. Call connectGoogle() first.' };
    }
    const answer = consentAnswer(authUrl, armed, this.server);
    armed.requests.push(answer.request);
    if (answer.problems.length > 0) {
      this.failures.push({ step: 'google consent', message: `The authorization request sent to Google is not valid:\n${answer.problems.map((p) => `  - ${p}`).join('\n')}\n${authUrl.href}`, urls: [], screenshots: [], console: [], stack: null });
    }
    return answer.fulfil;
  }

  /** Saves a full-page screenshot under tests/e2e/screenshots/<suite>/ and returns its path. */
  async screenshot(page, label = 'page', { fullPage = true } = {}) {
    this.shots += 1;
    const dir = path.join(SCREENSHOT_DIR, slug(this.suite.name));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.slug}--${String(this.shots).padStart(2, '0')}-${slug(label)}.png`);
    await page.screenshot({ path: file, fullPage, animations: 'disabled' });
    return file;
  }

  /**
   * Renders an email from the outbox (its HTML body) and saves a screenshot, so a person can
   * look at what was sent. Images that live outside the email are not loaded.
   */
  async screenshotEmail(email, label = 'email', { width = 640 } = {}) {
    const context = await this.suite.browser.newContext({ viewport: { width, height: 800 }, javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.setContent(String(email?.html ?? ''), { waitUntil: 'domcontentloaded' });
      return await this.screenshot(page, label);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * Plays Google's consent screen for this page's browser context: when the app sends the
   * browser to accounts.google.com, the answer is a redirect back to our own callback with
   * code=mock:<email>:<zone> and the original state. Everything on our side stays real: the
   * connect route, the signed state, the callback, the token exchange, the defaults.
   *
   *   const google = await s.connectGoogle(page, 'jimi@example.com', 'Europe/London');
   *   await page.getByRole('link', { name: 'Connect Google Calendar' }).click();
   *   const result = await google.done();   // { status: 'connected' | 'error', reason, url, request }
   *
   * Options: flags (extra code flags such as 'norefresh', 'nocalendar', 'noidtoken'),
   * gmail: false (decline the Gmail permission even when asked), deny: true (the person clicks
   * Cancel at Google), and `start` to trigger the flow for you: a locator to click, or
   * { hostId, returnTo, gmail, token } to open the connect link directly.
   */
  async connectGoogle(page, email, zone = 'UTC', { flags = [], gmail, deny = false, start } = {}) {
    const armed = { email, zone, flags, gmail, deny, requests: [] };
    this.consent.set(page.context(), armed);
    const done = async ({ timeout = NAVIGATION_TIMEOUT_MS } = {}) => {
      await page.waitForURL((url) => url.origin === this.server.origin && url.searchParams.has('google'), { timeout });
      const url = new URL(page.url());
      return { status: url.searchParams.get('google'), reason: url.searchParams.get('reason'), url: url.href, request: armed.requests.at(-1) ?? null };
    };
    const handle = { requests: armed.requests, done };
    if (!start) return handle;
    if (typeof start.click === 'function') {
      await start.click();
    } else {
      const query = new URLSearchParams({ host: start.hostId, gmail: start.gmail ? '1' : '0', return: start.returnTo ?? `${BASE_PATH}/admin/integrations` });
      if (start.token) query.set('t', start.token);
      // add: "Add another Google account"; accountId: reconnect that one account; switch: "Use a different Google account".
      if (start.add) query.set('add', '1');
      if (start.accountId) query.set('account', start.accountId);
      if (start.switch) query.set('switch', '1');
      // As a Connect button does: from one of the app's own pages (the server refuses a link opened from anywhere
      // else). A page of the app without an earlier ?google= answer in its address, so done() waits for this one.
      await page.goto(`${this.server.origin}${BASE_PATH}/`);
      await page.evaluate((target) => window.location.assign(target), `${this.server.api}/google/connect?${query}`);
    }
    return { ...handle, result: await done() };
  }

  /**
   * "Add another Google account" in `region` (a locator), signing in as `email` at Google. Checks that the
   * request asked Google for its account chooser and sent no login hint, and returns the result.
   */
  async addGoogleAccount(page, region, email, zone = 'UTC') {
    const google = await this.connectGoogle(page, email, zone, { start: region.getByRole('button', { name: 'Add another Google account' }) });
    const request = google.result.request;
    this.expect(request?.accountChooser, `the account chooser for ${email}`).toBe(true);
    this.expect(request?.loginHint ?? null, `no login hint for ${email}`).toBe(null);
    return google.result;
  }

  async finish() {
    for (const context of this.contexts) await context.close().catch(() => undefined);
    this.pages.clear();
  }
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

// ───────────────────────── suite ─────────────────────────

/**
 * A suite file exports `defineSuite(name, options, run)` as its default.
 *   options.mockCreds  true (default): the server pretends every provider credential is configured
 *                      through the environment (DEV_MOCK_CREDS=1). false: nothing is configured,
 *                      like a brand new deployment.
 *   options.env        extra environment for the dev server
 *   run(t)             t is the suite context: t.scenario(name, fn), plus every dev helper
 */
export function defineSuite(name, options, run) {
  if (typeof options === 'function') return { name, options: {}, run: options };
  return { name, options: options ?? {}, run };
}

class SuiteContext extends DevTools {
  constructor(name, server, browser, only) {
    super(server, nextIp());
    this.name = name;
    this.browser = browser;
    this.only = only;
    this.scenarios = [];
  }

  /**
   * One scenario: its own client address (so rate limits do not carry over), its own cookie
   * jar and pages. `options.reset` wipes all stored data first. A failing scenario does not
   * stop the suite. Returns true when it passed.
   */
  async scenario(name, optionsOrFn, maybeFn) {
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    const options = typeof optionsOrFn === 'function' ? {} : (optionsOrFn ?? {});
    if (this.only && !name.toLowerCase().includes(this.only.toLowerCase())) {
      this.scenarios.push({ name, skipped: true, ok: true, steps: [], failures: [], ms: 0 });
      console.log(`  ${dim(`- ${name} (skipped)`)}`);
      return true;
    }
    const s = new Scenario(this, name);
    const started = Date.now();
    console.log(`  ${bold(name)}`);
    try {
      if (options.reset) await s.reset();
      await fn(s);
    } catch (err) {
      if (!(err instanceof ScenarioAbort)) await s.recordFailure('scenario', err);
    }
    // Whatever the scenario asserted: an error in the browser nobody expected is a failure.
    const unexpected = s.unexpectedConsole();
    if (unexpected.length > 0) {
      const lines = unexpected.slice(0, 12).map((c) => `  [${c.type}] ${c.text}\n      on ${c.url}`);
      const message = `${unexpected.length} unexpected browser error${unexpected.length === 1 ? '' : 's'} (allow the ones you expect with s.allowConsoleErrors):\n${lines.join('\n')}`;
      s.failures.push({ step: 'browser console', message, urls: [], screenshots: [], console: [], stack: null });
      console.log(`    ${red('✗')} browser console`);
      console.log(red(indent(message, 6)));
    }
    // Failures pushed by the network guard are printed here, once.
    for (const failure of s.failures.filter((f) => f.step === 'google consent' || f.step === 'network')) {
      console.log(`    ${red('✗')} ${failure.step}`);
      console.log(red(indent(failure.message, 6)));
    }
    await s.finish();
    const result = { name, ok: s.failures.length === 0, steps: s.steps, failures: s.failures, ms: Date.now() - started };
    this.scenarios.push(result);
    return result.ok;
  }
}

/**
 * Runs one suite against a server of its own. Returns
 * { name, ok, scenarios: [{ name, ok, steps, failures, ms }], logFile, ms, error? }.
 */
export async function runSuite(suite, { browser, ports, workDir, dist, only } = {}) {
  const started = Date.now();
  console.log(`\n${bold(`▸ ${suite.name}`)}`);
  let server = null;
  let error = null;
  let context = null;
  try {
    server = await startServer({ name: suite.name, ports, workDir, dist, mockCreds: suite.options.mockCreds !== false, env: suite.options.env });
    console.log(dim(`  server ${server.base}  data ${server.dataDir}  log ${server.logFile}`));
    context = new SuiteContext(suite.name, server, browser, only);
    await suite.run(context);
  } catch (err) {
    error = err;
    console.log(red(`  The suite stopped: ${err?.stack ?? err}`));
    if (server) console.log(dim(indent(`server log (last lines):\n${tail(server.log(), 25)}`, 2)));
  } finally {
    if (server) {
      try {
        await server.stop();
      } catch (err) {
        error = error ?? err;
        console.log(red(`  ${err.message}`));
      }
    }
  }
  const scenarios = context?.scenarios ?? [];
  const ran = scenarios.filter((s) => !s.skipped);
  const ok = !error && scenarios.every((s) => s.ok) && (ran.length > 0 || !!only);
  if (!error && ran.length === 0 && !only) console.log(red('  The suite ran no scenario.'));
  return { name: suite.name, ok, scenarios, logFile: server?.logFile ?? null, ms: Date.now() - started, error: error ? (error.message ?? String(error)) : null };
}

/**
 * The <title>, <meta> and <link> tags of an HTML page, the way a link preview reads them:
 * { title, meta: { 'og:title': ..., description: ... }, links: [{ rel, href, sizes, type }] }.
 */
export function metaOf(html) {
  const head = String(html ?? '').split(/<\/head>/i)[0];
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = a.property ?? a.name;
    if (key && a.content !== undefined) meta[key] = a.content;
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/gi)].map((m) => m[1]);
  return { title: titles[0] ?? null, titles, meta, links };
}
