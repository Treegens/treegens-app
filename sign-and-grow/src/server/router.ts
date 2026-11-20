import { authenticate, renewedCookie, type Auth } from './auth.ts';
import { HttpError, bad, setOrigin, id } from './util.ts';
import { twoStepGate } from './twostep.ts';
import type { Actor } from './envelopes.ts';

export type Ctx = {
  req: Request;
  url: URL;
  q: URLSearchParams;
  params: Record<string, string>;
  auth: Auth | null;
  user: any;
  account: any;
  role: string;
  admin: boolean;
  actor: Actor;
  ip: string;
  ua: string;
  secure: boolean;
  origin: string;
  cookies: string[];
  body: () => Promise<any>;
};

type Level = 'user' | 'admin' | 'public';
type Handler = (c: Ctx) => any;
const g = globalThis as any;
const routes: { method: string; path: string; re: RegExp; keys: string[]; level: Level; fn: Handler }[] = (g.__tsroutes ??= []);

// Every registered route, for documentation checks.
export const listRoutes = () => routes.map((r) => ({ method: r.method, path: r.path, level: r.level }));

export function route(method: string, path: string, fn: Handler, level: Level = 'user') {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  // Hot reload re-registers routes; replace instead of stacking duplicates.
  const i = routes.findIndex((r) => r.method === method && String(r.re) === String(re));
  const entry = { method, path, re, keys, level, fn };
  if (i >= 0) routes[i] = entry;
  else routes.push(entry);
}

export const json = (data: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const pdfResponse = (bytes: Uint8Array, filename: string, inline = false) =>
  new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, no-store',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w .-]+/g, '_').slice(0, 100) || 'document'}.pdf"`,
    },
  });

// The caller's address, for rate limits and the audit trail. X-Forwarded-For is a list that each proxy adds to on
// the right, so everything left of what our own proxies added is whatever the caller typed. Count in from the
// right: TRUSTED_PROXY_HOPS says how many proxies of ours sit in front (default 1), and the entry that many places
// from the right is the address the outermost of them saw. With 0 there is no proxy and the header is ignored.
export function clientIp(req: Request): string {
  const raw = (process.env.TRUSTED_PROXY_HOPS ?? '').trim();
  const hops = /^\d+$/.test(raw) ? Number(raw) : 1;
  if (!hops) return 'unknown';
  const list = (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  // A shorter list than expected still starts with an entry one of our proxies wrote, so that one is used. No
  // other header is consulted: X-Real-IP is as easy to type as this one.
  return list[Math.max(0, list.length - hops)] || 'unknown';
}

// What an API key can never do, whatever its scope. These decide who controls the account or move money, so they
// need a person who is signed in. Matched on the route, so a billing route added later is covered from day one.
const PERSON_ONLY: [RegExp, string][] = [
  [/^(POST|DELETE) \/api-keys/, 'create or revoke API keys'],
  [/^POST \/account\/transfer-owner$/, 'hand the account to another owner'],
  [/^DELETE \/account\/members\//, 'remove someone from the team'],
  [/^POST \/account\/leave$/, 'leave the team'],
  // Which workspace a person works in, and lands in at their next sign-in, is chosen in a browser. A key belongs to
  // one account and never moves.
  [/^POST \/auth\/switch$/, 'switch to another workspace'],
  [/^POST \/me\/delete$/, 'close the account'],
  // Who can get into a login is its owner's business alone: connecting Google or Microsoft, disconnecting them,
  // asking for the link that sets a password, or reading which of them are connected.
  [/^[A-Z]+ \/me\/signin/, 'see or change the ways to sign in'],
  // The address of a login is where its links and notices go: moving it, or saying that it works again, is for
  // the person themselves (routes-bounces.ts).
  [/^POST \/me\/email/, 'change the email address of a login, or say that it works again'],
  // Which browsers a person is signed in on, and signing them out, is for that person in a browser of theirs.
  [/^[A-Z]+ \/me\/sessions/, 'see or end where a person is signed in'],
  // A second step that a key could switch off, reset or ask of a team would not be a second step (twostep.ts).
  [/two-step/, 'see or change two-step login'],
  [/^(POST|PUT|PATCH|DELETE) \/billing\//, 'change the plan, pay or refund'],
  [/^[A-Z]+ \/operator\//, 'work the operator queue'],
];
// The one admin-level call a "send" key may make: reading the webhooks and their delivery log. The handler leaves
// the signing secrets out for it.
const SEND_KEY_MAY = new Set(['GET /webhooks']);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  // The address this browser used. Good for answers to the same browser (cookies, the cross-site check). Never for
  // links in emails: setOrigin() only keeps it when APP_URL is unset and it names this machine itself.
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  const proto = (req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  const origin = `${proto}://${host}`;
  setOrigin(origin);
  const cookies: string[] = [];
  // Every answer carries an id that also appears in the server log, so "it failed at 3pm" becomes findable.
  const requestId = id('req');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const auth = authenticate(req, r.level !== 'public');
      // A browser that is used stays signed in: when this request moved the end of its session forward, the cookie
      // goes out again with the new end. A handler that signs out or in pushes its own cookie after this one.
      if (auth?.slid) cookies.push(renewedCookie(req, proto === 'https'));
      if (r.level !== 'public') {
        if (!auth) throw new HttpError(401, 'Please sign in.');
        if (r.level === 'admin' && auth.role !== 'owner' && auth.role !== 'admin') throw new HttpError(403, 'Only account admins can do that.');
        // A key never carries its creator's whole role. One leaked integration key must not be the whole account.
        if (auth.via === 'api_key') {
          const what = `${r.method} ${r.path}`;
          const never = PERSON_ONLY.find(([re]) => re.test(what));
          if (never) throw new HttpError(403, `An API key cannot ${never[1]}. That needs a person signed in to the app.`);
          if (r.level === 'admin' && auth.scope !== 'admin' && !SEND_KEY_MAY.has(what))
            throw new HttpError(403, 'This API key has the "send" scope. It covers envelopes, templates, files, contacts, bulk sends and reports, but not account settings. An admin can create a key with the "admin" scope under Settings, API and webhooks.');
        }
        // An account that asks everyone for two-step login opens nothing else to a person signed in without it.
        twoStepGate(auth, `${r.method} ${r.path}`);
      }
      // Cookie sessions must come from our own pages. API keys are exempt.
      if (auth?.via === 'session' && req.method !== 'GET' && r.level !== 'public') {
        const o = req.headers.get('origin');
        if (o && new URL(o).host !== host) throw new HttpError(403, 'Cross-site request blocked.');
      }
      const ip = clientIp(req);
      const ua = req.headers.get('user-agent') || '';
      const c: Ctx = {
        req, url, q: url.searchParams, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
        auth, user: auth?.user, account: auth?.account, role: auth?.role || '', admin: auth?.role === 'owner' || auth?.role === 'admin',
        actor: { name: auth ? `${auth.user.name} <${auth.user.email}>` : 'Anonymous', ip, ua }, ip, ua,
        secure: proto === 'https', origin, cookies,
        body: async () => {
          try {
            const b = await req.json();
            if (!b || typeof b !== 'object') throw 0;
            return b;
          } catch {
            throw bad('Send a JSON body.');
          }
        },
      };
      const out = await r.fn(c);
      const res = out instanceof Response ? out : json(out ?? { ok: true });
      for (const ck of cookies) res.headers.append('set-cookie', ck);
      res.headers.set('x-request-id', requestId);
      return res;
    }
    return json({ error: 'Not found', request_id: requestId }, 404, { 'x-request-id': requestId });
  } catch (e: any) {
    if (e instanceof HttpError) return json({ ...(e.data || {}), error: e.message, request_id: requestId }, e.status, { 'x-request-id': requestId });
    console.error('[api]', requestId, req.method, path, e);
    return json({ error: `Something went wrong on our side. Please try again. If it keeps happening, tell us this reference: ${requestId}.`, request_id: requestId }, 500, { 'x-request-id': requestId });
  }
}
