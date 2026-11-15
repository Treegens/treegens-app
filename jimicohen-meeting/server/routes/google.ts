/**
 * Connecting a Google account. Two full-page redirects, no popups:
 *
 *   GET /google/connect?host=<id>&gmail=0|1&return=<path>[&t=<host token>][&switch=1]
 *       Allowed for the signed-in owner (any host), or for a co-host holding the private-link
 *       token of that same host. Answers 302 to Google's consent screen. `switch=1` asks Google
 *       to show its account chooser (and sends no login hint), to pick another account.
 *   GET /google/callback
 *       Where Google sends the browser back. Finishes the exchange, applies the defaults for a
 *       first connection, and answers 302 to where the person started, with
 *       `?google=connected` (plus `&zone=<IANA zone>` when the host's time zone changed with it)
 *       or `?google=error&reason=<sentence>`.
 *
 * A connection belongs to the browser that started it: the connect answer sets a short-lived
 * cookie with the nonce of the state it sent to Google, and the callback goes no further unless
 * the browser brings that cookie back. Otherwise someone could start a connection for their own
 * record and have another person finish it, attaching that person's calendar to it.
 *
 * Every redirect back into the app is an absolute URL built from ctx.env.publicBaseUrl. The
 * request's own URL is never used for that: behind the proxy it names the wrong host. For the
 * same reason the connect link must be opened on the public address: the cookie is set there,
 * and Google always comes back there. A link opened from a page on another address of this site
 * (the app's own netlify.app address) is turned away with a sentence, on the public address.
 */
import { IANAZone } from 'luxon';
import { hostFromToken, isAdmin, rateLimit } from '../lib/auth';
import { syncHostTimezone } from '../lib/busy';
import { safeEqual } from '../lib/crypto';
import { BASE_PATH, type Ctx } from '../lib/ctx';
import { buildGoogleAuthUrl, completeGoogleAuth, readGoogleState } from '../lib/google';
import { HttpError, json, redirect, route, type Route } from '../lib/http';
import { getHost, getSite, isStorageId, listHosts, updateHost } from '../lib/repo';
import { isEmail } from '../lib/validate';

const ATTEMPTS_PER_VISITOR = 30;
const WINDOW_SEC = 10 * 60;
const MAX_REASON_LENGTH = 240;
const FALLBACK_ROUTE = '/admin/integrations';

/** Holds the nonces of the connections this browser started (a few, for a second tab), as long as a state lives. */
export const GSTATE_COOKIE = 'mtg_gstate';
const GSTATE_COOKIE_PATH = `${BASE_PATH}/api/google`;
const GSTATE_TTL_SEC = 600;
const GSTATE_KEEP = 3;

function isDev(ctx: Ctx): boolean {
  return ctx.env.publicBaseUrl.startsWith('http://');
}

function gstateCookie(ctx: Ctx, nonces: string[]): string {
  const attributes = `Path=${GSTATE_COOKIE_PATH}; HttpOnly; ${isDev(ctx) ? '' : 'Secure; '}SameSite=Lax`;
  if (nonces.length === 0) return `${GSTATE_COOKIE}=; ${attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return `${GSTATE_COOKIE}=${nonces.join('.')}; ${attributes}; Max-Age=${GSTATE_TTL_SEC}`;
}

/** The nonces this browser holds. SameSite=Lax still sends the cookie on the top-level return from Google. */
function heldNonces(req: Request): string[] {
  const header = req.headers.get('cookie') ?? '';
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== GSTATE_COOKIE) continue;
    for (const n of part.slice(eq + 1).trim().split('.')) if (/^[A-Za-z0-9_-]{16,64}$/.test(n)) out.push(n);
  }
  return out;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * True when a dashboard connection was started from another site: a link elsewhere must not walk
 * the signed-in owner into Google's consent screen for somebody else's record. Browsers say where
 * a navigation came from (Sec-Fetch-Site); older ones are judged by the Referer when they send one.
 * Typing the address or opening a bookmark ("none") is fine.
 */
function startedElsewhere(ctx: Ctx, req: Request): boolean {
  const site = (req.headers.get('sec-fetch-site') ?? '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return true;
  if (site !== '') return false;
  const from = originOf(req.headers.get('referer'));
  if (!from) return false;
  return ![originOf(ctx.env.publicBaseUrl), originOf(ctx.env.embedBaseUrl), originOf(req.url)].includes(from);
}

/**
 * True when the page that opened the connect link is on another address of this site than the
 * public one (the app's own netlify.app address, or a dev server reached under another name). The
 * cookie would be set on that address while Google always comes back to the public one, so the
 * connection could never finish. Only the Referer tells: behind the proxy the request's own URL
 * names the app's address either way.
 */
function openedOnAnotherAddress(ctx: Ctx, req: Request): boolean {
  const from = originOf(req.headers.get('referer'));
  const publicOrigin = originOf(ctx.env.publicBaseUrl);
  if (!from || !publicOrigin || from === publicOrigin) return false;
  return from === originOf(ctx.env.embedBaseUrl) || from === originOf(req.url);
}

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

function withResult(target: URL, result: { ok: true; zone?: string | null } | { ok: false; reason: string }): string {
  const url = new URL(target.href);
  url.searchParams.delete('google');
  url.searchParams.delete('reason');
  url.searchParams.delete('zone');
  url.searchParams.set('google', result.ok ? 'connected' : 'error');
  if (!result.ok) url.searchParams.set('reason', result.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH));
  // The page says so: a new zone moves every hour the host offers.
  else if (result.zone && result.zone.length <= 64 && IANAZone.isValidZone(result.zone)) url.searchParams.set('zone', result.zone);
  return url.href;
}

/** What to tell a browser that came back from Google without the cookie of the connection it finishes. */
function unboundReason(returnTo: string): string {
  return returnTo.startsWith(`${BASE_PATH}/host/`)
    ? 'This Google sign-in was not started in this browser, or it took too long. Please press Connect Google Calendar again on this page.'
    : 'This Google sign-in was not started in this browser, or it took too long. Please start the connection again from the dashboard.';
}

function notConfigured(): Response {
  return json({ error: { code: 'not_configured', message: 'This site does not know its public address yet. Set PUBLIC_BASE_URL in the deployment settings.' } }, 500);
}

/** A browser navigating to the connect link expects a page, not JSON. */
function wantsPage(req: Request): boolean {
  return (req.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

/**
 * What a first connection sets up, on top of what the token exchange already stored. Returns the
 * host's new time zone when connecting changed it (a host who followed their device now follows
 * their calendar, SPEC 4.6), so the page can say so.
 */
async function finishConnection(ctx: Ctx, hostId: string, firstConnect: boolean): Promise<string | null> {
  const host = await getHost(ctx, hostId);
  if (!host?.google) return null;
  const zoneBefore = host.timezone;
  const noSelection = (host.google.busyCalendarIds ?? []).length === 0 || !host.google.writeCalendarId;
  // Someone who let their zone follow their device now has a better source: their calendar.
  const followGoogle = firstConnect && host.timezoneMode === 'device';
  // The owner starts without an address of their own (first-run setup never asks for one), and
  // booking notices and alerts go to the host's address. Until they choose another under Team,
  // the account they just connected is where to reach them.
  const account = host.google.email;
  const adoptEmail =
    !isEmail(host.email) && isEmail(account) && !(await listHosts(ctx)).some((h) => h.id !== hostId && h.email.toLowerCase() === account.toLowerCase());
  let current = host;
  if (noSelection || followGoogle || adoptEmail) {
    const saved = await updateHost(ctx, hostId, (h) => {
      if (!h.google) return h;
      const google = { ...h.google };
      if ((google.busyCalendarIds ?? []).length === 0) google.busyCalendarIds = ['primary'];
      if (!google.writeCalendarId) google.writeCalendarId = 'primary';
      return {
        ...h,
        google,
        email: adoptEmail && !isEmail(h.email) ? account : h.email,
        timezoneMode: followGoogle && h.timezoneMode === 'device' ? 'google' : h.timezoneMode,
      };
    });
    if (saved) current = saved;
  }
  // Does nothing unless the host follows Google Calendar. Never throws.
  const after = await syncHostTimezone(ctx, current);
  return after.timezone !== zoneBefore ? after.timezone : null;
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
      // The answer below lands on the public address, where pressing Connect again works.
      if (openedOnAnotherAddress(ctx, req)) {
        throw new HttpError(409, 'use_public_address', 'Google only sends you back to this address, and the connection was started on another one. Please press Connect again on this page.');
      }

      // A valid private link is used first: it opens one host, its own, whoever is signed in.
      const linked = byToken ? await hostFromToken(ctx, hostId, token) : null;
      const admin = !linked && (await isAdmin(ctx, req));
      // The owner's session opens any host, but only from the owner's own pages.
      if (admin && startedElsewhere(ctx, req)) {
        throw new HttpError(403, 'start_from_dashboard', 'For your safety, Google can only be connected from your dashboard. Open Integrations or Team and connect from there.');
      }
      const host = linked ?? (admin ? await getHost(ctx, hostId) : null);
      if (!host) {
        if (admin) throw new HttpError(404, 'host_not_found', 'That person is no longer on the team.');
        throw new HttpError(401, 'unauthorized', byToken ? 'This link does not work any more. Ask for a new one.' : 'Please sign in, then connect Google again.');
      }

      const site = await getSite(ctx);
      const returnTo = url.searchParams.get('return') ?? refusalPage;
      // Sending mail from Gmail only ever happens from the owner's account, and only the owner can ask for it.
      const gmail = admin && host.id === site.ownerHostId && url.searchParams.get('gmail') === '1';
      // "Use a different Google account": the account chooser, and no hint pointing at the old one.
      const selectAccount = url.searchParams.get('switch') === '1';
      const location = await buildGoogleAuthUrl(ctx, { hostId: host.id, returnTo, gmail, selectAccount, loginHint: selectAccount ? undefined : host.google?.email || host.email || undefined });
      const nonce = readGoogleState(ctx, new URL(location).searchParams.get('state') ?? '')?.nonce;
      if (!nonce) throw new Error('google: the new state could not be read back');
      const kept = heldNonces(req).filter((n) => n !== nonce).slice(-(GSTATE_KEEP - 1));
      return redirect(location, 302, { 'Set-Cookie': gstateCookie(ctx, [...kept, nonce]) });
    } catch (err) {
      if (!(err instanceof HttpError) || !wantsPage(req)) throw err;
      const target = absoluteReturnUrl(ctx, refusalPage);
      if (!target) throw err;
      return redirect(withResult(target, { ok: false, reason: err.message }));
    }
  }),

  route('GET', '/google/callback', async ({ ctx, req, url }) => {
    if (!baseUrl(ctx)) return notConfigured();
    const held = heldNonces(req);
    const state = readGoogleState(ctx, url.searchParams.get('state') ?? '');
    // The nonce of this connection leaves the cookie whatever happens next; any other connection this browser has open stays.
    const cookie = state && held.length > 0 ? { 'Set-Cookie': gstateCookie(ctx, held.filter((n) => !safeEqual(n, state.nonce))) } : undefined;
    try {
      await rateLimit(ctx, 'google-callback', ctx.ip ?? 'unknown', ATTEMPTS_PER_VISITOR, WINDOW_SEC);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return redirect(withResult(absoluteReturnUrl(ctx, null)!, { ok: false, reason: 'Too many attempts. Please wait a few minutes and try again.' }), 302, cookie);
    }

    // Only the browser that started this connection may finish it, before any code is exchanged.
    if (state && !held.some((n) => safeEqual(n, state.nonce))) {
      ctx.log('warn', 'google: a sign-in came back without the cookie of the browser that started it', { hostId: state.hostId });
      return redirect(withResult(absoluteReturnUrl(ctx, state.returnTo)!, { ok: false, reason: unboundReason(state.returnTo) }), 302, cookie);
    }

    const result = await completeGoogleAuth(ctx, url.searchParams);
    // Without a host the state could not be read, so the return path in it is not to be relied on.
    const target = absoluteReturnUrl(ctx, result.hostId ? result.returnTo : null)!;

    if (!result.ok) {
      return redirect(withResult(target, { ok: false, reason: result.error || 'Google did not finish connecting. Please try again.' }), 302, cookie);
    }
    let zone: string | null = null;
    if (result.hostId) {
      try {
        zone = await finishConnection(ctx, result.hostId, result.firstConnect === true);
      } catch (err) {
        // The connection itself is saved. Defaults and the zone catch up on the next save or scheduled run.
        ctx.log('warn', 'google: could not finish setting up a new connection', { hostId: result.hostId, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    return redirect(withResult(target, { ok: true, zone }), 302, cookie);
  }),
];
