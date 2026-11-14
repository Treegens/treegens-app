/**
 * Connecting a Google account. Two full-page redirects, no popups:
 *
 *   GET /google/connect?host=<id>&gmail=0|1&return=<path>[&t=<host token>]
 *       Allowed for the signed-in owner (any host), or for a co-host holding the private-link
 *       token of that same host. Answers 302 to Google's consent screen.
 *   GET /google/callback
 *       Where Google sends the browser back. Finishes the exchange, applies the defaults for a
 *       first connection, and answers 302 to where the person started, with
 *       `?google=connected` or `?google=error&reason=<sentence>`.
 *
 * Every redirect back into the app is an absolute URL built from ctx.env.publicBaseUrl. The
 * request's own URL is never used for that: behind the proxy it names the wrong host.
 */
import { hostFromToken, isAdmin, rateLimit } from '../lib/auth';
import { syncHostTimezone } from '../lib/busy';
import { BASE_PATH, type Ctx } from '../lib/ctx';
import { buildGoogleAuthUrl, completeGoogleAuth } from '../lib/google';
import { HttpError, json, redirect, route, type Route } from '../lib/http';
import { getHost, getSite, isStorageId, updateHost } from '../lib/repo';

const ATTEMPTS_PER_VISITOR = 30;
const WINDOW_SEC = 10 * 60;
const MAX_REASON_LENGTH = 240;
const FALLBACK_ROUTE = '/admin/integrations';

function baseUrl(ctx: Ctx): URL | null {
  try {
    const url = new URL(ctx.env.publicBaseUrl.replace(/\/+$/, ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Turns a path inside the app ("/meeting/host/h1?t=…") into an absolute URL on the public
 * address. Anything that is not such a path, or that would leave the app, gives the fallback page.
 */
export function absoluteReturnUrl(ctx: Ctx, returnTo: string | null | undefined): URL | null {
  const base = baseUrl(ctx);
  if (!base) return null;
  const root = base.pathname.replace(/\/+$/, '');
  const fallback = new URL(`${base.origin}${root}${FALLBACK_ROUTE}`);
  if (typeof returnTo !== 'string' || returnTo.length > 1024 || /[\u0000-\u001F\u007F\\]/.test(returnTo)) return fallback;
  const inside = returnTo === BASE_PATH || returnTo.startsWith(`${BASE_PATH}/`) || returnTo.startsWith(`${BASE_PATH}?`) || returnTo.startsWith(`${BASE_PATH}#`);
  if (!inside) return fallback;
  try {
    const target = new URL(`${base.origin}${root}${returnTo.slice(BASE_PATH.length)}`);
    const stays = target.origin === base.origin && (target.pathname === root || target.pathname.startsWith(`${root}/`)) && !target.pathname.includes('//');
    return stays ? target : fallback;
  } catch {
    return fallback;
  }
}

function withResult(target: URL, result: { ok: true } | { ok: false; reason: string }): string {
  const url = new URL(target.href);
  url.searchParams.delete('google');
  url.searchParams.delete('reason');
  url.searchParams.set('google', result.ok ? 'connected' : 'error');
  if (!result.ok) url.searchParams.set('reason', result.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH));
  return url.href;
}

function notConfigured(): Response {
  return json({ error: { code: 'not_configured', message: 'This site does not know its public address yet. Set PUBLIC_BASE_URL in the deployment settings.' } }, 500);
}

/** A browser navigating to the connect link expects a page, not JSON. */
function wantsPage(req: Request): boolean {
  return (req.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

/** What a first connection sets up, on top of what the token exchange already stored. */
async function finishConnection(ctx: Ctx, hostId: string, firstConnect: boolean): Promise<void> {
  const host = await getHost(ctx, hostId);
  if (!host?.google) return;
  const noSelection = (host.google.busyCalendarIds ?? []).length === 0 || !host.google.writeCalendarId;
  // Someone who let their zone follow their device now has a better source: their calendar.
  const followGoogle = firstConnect && host.timezoneMode === 'device';
  let current = host;
  if (noSelection || followGoogle) {
    const saved = await updateHost(ctx, hostId, (h) => {
      if (!h.google) return h;
      const google = { ...h.google };
      if ((google.busyCalendarIds ?? []).length === 0) google.busyCalendarIds = ['primary'];
      if (!google.writeCalendarId) google.writeCalendarId = 'primary';
      return { ...h, google, timezoneMode: followGoogle && h.timezoneMode === 'device' ? 'google' : h.timezoneMode };
    });
    if (saved) current = saved;
  }
  // Does nothing unless the host follows Google Calendar. Never throws.
  await syncHostTimezone(ctx, current);
}

export const routes: Route[] = [
  route('GET', '/google/connect', async ({ ctx, req, url }) => {
    const hostId = url.searchParams.get('host') ?? '';
    const token = url.searchParams.get('t');
    const byToken = typeof token === 'string' && token !== '';
    // Where a refusal is shown when this is a page navigation: the page the person came from.
    const refusalPage = byToken && isStorageId(hostId) ? `${BASE_PATH}/host/${hostId}?t=${encodeURIComponent(token)}` : `${BASE_PATH}${FALLBACK_ROUTE}`;

    try {
      await rateLimit(ctx, 'google-connect', ctx.ip ?? 'unknown', ATTEMPTS_PER_VISITOR, WINDOW_SEC);
      if (!isStorageId(hostId)) throw new HttpError(400, 'invalid_host', 'Choose whose calendar to connect.');

      const admin = await isAdmin(ctx, req);
      // A private link opens exactly one host: its own. The owner's session opens any of them.
      const host = admin ? await getHost(ctx, hostId) : await hostFromToken(ctx, hostId, token);
      if (!host) {
        if (admin) throw new HttpError(404, 'host_not_found', 'That person is no longer on the team.');
        throw new HttpError(401, 'unauthorized', byToken ? 'This link does not work any more. Ask for a new one.' : 'Please sign in, then connect Google again.');
      }

      const site = await getSite(ctx);
      const returnTo = url.searchParams.get('return') ?? refusalPage;
      // Sending mail from Gmail only ever happens from the owner's account, and only the owner can ask for it.
      const gmail = admin && host.id === site.ownerHostId && url.searchParams.get('gmail') === '1';
      const location = await buildGoogleAuthUrl(ctx, { hostId: host.id, returnTo, gmail, loginHint: host.google?.email || host.email || undefined });
      return redirect(location);
    } catch (err) {
      if (!(err instanceof HttpError) || !wantsPage(req)) throw err;
      const target = absoluteReturnUrl(ctx, refusalPage);
      if (!target) throw err;
      return redirect(withResult(target, { ok: false, reason: err.message }));
    }
  }),

  route('GET', '/google/callback', async ({ ctx, url }) => {
    if (!baseUrl(ctx)) return notConfigured();
    try {
      await rateLimit(ctx, 'google-callback', ctx.ip ?? 'unknown', ATTEMPTS_PER_VISITOR, WINDOW_SEC);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return redirect(withResult(absoluteReturnUrl(ctx, null)!, { ok: false, reason: 'Too many attempts. Please wait a few minutes and try again.' }));
    }

    const result = await completeGoogleAuth(ctx, url.searchParams);
    // Without a host the state could not be read, so the return path in it is not to be relied on.
    const target = absoluteReturnUrl(ctx, result.hostId ? result.returnTo : null)!;

    if (!result.ok) {
      return redirect(withResult(target, { ok: false, reason: result.error || 'Google did not finish connecting. Please try again.' }));
    }
    if (result.hostId) {
      try {
        await finishConnection(ctx, result.hostId, result.firstConnect === true);
      } catch (err) {
        // The connection itself is saved. Defaults and the zone catch up on the next save or scheduled run.
        ctx.log('warn', 'google: could not finish setting up a new connection', { hostId: result.hostId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    return redirect(withResult(target, { ok: true }));
  }),
];
