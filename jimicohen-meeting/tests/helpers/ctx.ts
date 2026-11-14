/**
 * Shared test context: in-memory KV, a clock you control, captured logs, and a fetch that
 * fails loudly unless the test supplies one. Usage:
 *
 *   const ctx = makeTestCtx({ now: '2026-11-16T09:00:00Z' });
 *   ctx.clock.advance(60_000);
 *   await ctx.settle();            // wait for everything handed to ctx.waitUntil
 */
import type { Ctx, Env, KV, LogLevel } from '../../server/lib/ctx';
import { memoryKV } from '../../server/lib/store';

export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_BASE_URL = 'https://jimicohen.com/meeting';
export const TEST_NOW = '2026-11-16T09:00:00.000Z';

export interface TestCtx extends Ctx {
  clock: {
    set(at: string | number | Date): void;
    advance(ms: number): void;
  };
  logs: { level: LogLevel; msg: string; data?: unknown }[];
  /** resolves once every promise passed to waitUntil has settled (including ones added meanwhile) */
  settle(): Promise<void>;
}

export interface TestCtxOptions {
  kv?: KV;
  now?: string | number | Date;
  env?: Partial<Env>;
  fetch?: typeof fetch;
  ip?: string | null;
  requestId?: string;
}

export function makeTestCtx(opts: TestCtxOptions = {}): TestCtx {
  let nowMs = new Date(opts.now ?? TEST_NOW).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('makeTestCtx: invalid `now`');
  const pending = new Set<Promise<unknown>>();
  const logs: TestCtx['logs'] = [];

  const unexpectedFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`Unexpected network call in a test: ${url}`);
  };

  return {
    kv: opts.kv ?? memoryKV(),
    env: {
      secretKey: TEST_SECRET_KEY,
      setupCodeHash: null,
      publicBaseUrl: TEST_BASE_URL,
      mockProviders: false,
      overrides: {},
      ...opts.env,
    },
    fetch: opts.fetch ?? unexpectedFetch,
    now: () => new Date(nowMs),
    waitUntil: (p) => {
      const tracked: Promise<unknown> = Promise.resolve(p)
        .catch((err) => logs.push({ level: 'error', msg: 'waitUntil rejected', data: err }))
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    log: (level, msg, data) => {
      logs.push({ level, msg, data });
    },
    ip: opts.ip === undefined ? '203.0.113.7' : opts.ip,
    requestId: opts.requestId ?? 'req_test',
    clock: {
      set: (at) => {
        const ms = new Date(at).getTime();
        if (!Number.isFinite(ms)) throw new Error('clock.set: invalid date');
        nowMs = ms;
      },
      advance: (ms) => {
        nowMs += ms;
      },
    },
    logs,
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/** Builds a Request against the API. `path` is relative to the API prefix, e.g. "/public/site". */
export function apiRequest(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; cookie?: string; origin?: string | null; baseUrl?: string } = {},
): Request {
  const base = opts.baseUrl ?? TEST_BASE_URL;
  const headers = new Headers(opts.headers);
  const mutating = !['GET', 'HEAD'].includes(method.toUpperCase());
  if (mutating) {
    if (!headers.has('x-requested-with')) headers.set('x-requested-with', 'meeting');
    if (opts.origin !== null && !headers.has('origin')) headers.set('origin', opts.origin ?? new URL(base).origin);
  }
  if (opts.cookie) headers.set('cookie', opts.cookie);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Request(`${base}/api${path}`, { method, headers, body });
}

/** "name=value" part of a Set-Cookie header, ready to send back as a Cookie header. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0];
}
