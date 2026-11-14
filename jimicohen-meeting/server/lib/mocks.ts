// STUB
/**
 * In-process stand-ins for the outside world (Google, Gmail, Resend, Twilio, Anthropic).
 * The dev server passes `mockFetch` as ctx.fetch, so no test or local run ever talks to a real
 * provider. INTEG fills this in; until then every call answers 501.
 *
 * The dev server calls `configureMocks({ kv })` once at start-up. Use that KV with
 * `appendOutbox` / `readDevClock` from ../routes/dev to record what was "sent" and to read the fake clock.
 */
import type { KV } from './ctx';

let mockKV: KV | null = null;

export function configureMocks(opts: { kv: KV }): void {
  mockKV = opts.kv;
}

/** The KV handed over by the dev server, or null when the mocks run without one. */
export function getMockKV(): KV | null {
  return mockKV;
}

export async function mockFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  return new Response(JSON.stringify({ error: { code: 'mock_not_implemented', message: `No mock for ${method} ${url}` } }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Compile-time proof that mockFetch can stand in for fetch.
const _typecheck: typeof fetch = mockFetch;
void _typecheck;
