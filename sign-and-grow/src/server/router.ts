import { authenticate, type Auth } from './auth.ts';
import { HttpError, bad, setOrigin, id } from './util.ts';
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

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
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
      const auth = authenticate(req);
      if (r.level !== 'public') {
        if (!auth) throw new HttpError(401, 'Please sign in.');
        if (r.level === 'admin' && auth.role !== 'owner' && auth.role !== 'admin') throw new HttpError(403, 'Only account admins can do that.');
      }
      // Cookie sessions must come from our own pages. API keys are exempt.
      if (auth?.via === 'session' && req.method !== 'GET' && r.level !== 'public') {
        const o = req.headers.get('origin');
        if (o && new URL(o).host !== host) throw new HttpError(403, 'Cross-site request blocked.');
      }
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
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
    if (e instanceof HttpError) return json({ error: e.message, request_id: requestId }, e.status, { 'x-request-id': requestId });
    console.error('[api]', requestId, req.method, path, e);
    return json({ error: `Something went wrong on our side. Please try again. If it keeps happening, tell us this reference: ${requestId}.`, request_id: requestId }, 500, { 'x-request-id': requestId });
  }
}
