/**
 * Connecting a Google account. Two full-page redirects, no popups:
 *
 *   GET /google/connect?host=<id>&gmail=0|1&return=<path>[&t=<host token>][&add=1 | &account=<id> | &switch=1]
 *       Allowed for the signed-in owner (any host), or for a co-host holding the private-link
 *       token of that same host. Answers 302 to Google's consent screen.
 *         add=1       "Add another Google account": the account chooser, no login hint. 409
 *                     too_many_google_accounts at the ceiling.
 *         account=id  reconnect that account (main or extra), hinted by its address.
 *         switch=1    "Use a different Google account": the account picked becomes the main one.
 *         (none)      the plain Connect and Reconnect buttons, for the main account.
 *   GET /google/callback
 *       Where Google sends the browser back. Finishes the exchange, puts the account on the host
 *       (an account that is already there is refreshed, never added twice), and answers 302 to
 *       where the person started, with `?google=connected&gresult=<first|added|refreshed|promoted|
 *       replaced>&gaccount=<account id>` (plus `&gnote=other_account&gwanted=<id>` when another
 *       account was picked than the button was for, and `&zone=<IANA zone>` when the host's time
 *       zone changed with it) or `?google=error&reason=<sentence>`.
 *
 * A sign-in started from a co-host's private link carries a mark of that link. A link replaced while
 * the person was at Google finishes nothing.
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
import { detachEventsOfAccount } from '../lib/booking';
import { buildGoogleAuthUrl, completeGoogleAuth, linkMark, readGoogleState, type GoogleAuthResult } from '../lib/google';
import { findAccount, mainOf, type ConnectIntent, type ConnectOutcome } from '../lib/googleAccounts';
import { noticeGoogleConnection } from '../lib/googleNotices';
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
 * True only when a connection was started from one of this app's own pages (the Connect buttons on
 * Integrations and on a co-host's page, which send the browser here). Whoever goes through Google's
 * consent screen attaches their own calendar, so a link sent from anywhere else (another site, a mail
 * app, a chat) must not start one: the person clicking it would put their calendar on the record the
 * link names, which may be somebody else's. Browsers say where a navigation came from (Sec-Fetch-Site:
 * a mail app or a typed address is "none", which is not ours either); older ones are judged by the Referer.
 */
function startedOnOurPages(ctx: Ctx, req: Request): boolean {
  const site = (req.headers.get('sec-fetch-site') ?? '').toLowerCase();
  if (site !== '') return site === 'same-origin';
  const from = originOf(req.headers.get('referer'));
  if (!from) return false;
  return [originOf(ctx.env.publicBaseUrl), originOf(ctx.env.embedBaseUrl), originOf(req.url)].includes(from);
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

const RETURN_PARAMS = ['google', 'reason', 'zone', 'gresult', 'gaccount', 'gnote', 'gwanted'];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type Connected = { ok: true; zone?: string | null; outcome?: ConnectOutcome; accountId?: string; note?: 'other_account'; wanted?: string };

/**
 * The return address with the result. Accounts are named by id, never by address, so nothing personal
 * lands in the address bar or the browser history: the page looks the addresses up.
 */
function withResult(target: URL, result: Connected | { ok: false; reason: string }): string {
  const url = new URL(target.href);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  url.searchParams.set('google', result.ok ? 'connected' : 'error');
  if (!result.ok) {
    url.searchParams.set('reason', result.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH));
    return url.href;
  }
  // The page says so: a new zone moves every hour the host offers.
  if (result.zone && result.zone.length <= 64 && IANAZone.isValidZone(result.zone)) url.searchParams.set('zone', result.zone);
  if (result.outcome) url.searchParams.set('gresult', result.outcome);
  if (result.accountId && ID_RE.test(result.accountId)) url.searchParams.set('gaccount', result.accountId);
  if (result.note) url.searchParams.set('gnote', result.note);
  if (result.note && result.wanted && ID_RE.test(result.wanted)) url.searchParams.set('gwanted', result.wanted);
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
 * What a connection sets up, on top of what the token exchange already stored. Returns the host's new
 * time zone when connecting changed it (a host who followed their device now follows their calendar,
 * SPEC 4.6), so the page can say so. Only the host's first account ever switches the zone mode; an extra
 * account never changes the zone or the address.
 */
async function finishConnection(ctx: Ctx, hostId: string, accountId: string, firstConnect: boolean): Promise<string | null> {
  const host = await getHost(ctx, hostId);
  const ref = host ? findAccount(host, { id: accountId }) : null;
  if (!host || !ref || !ref.main || !host.google) return null;
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
      if (!h.google || mainOf(h)?.account.id !== accountId) return h;
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

/** Everything after a successful sign-in that is not the connection itself. None of it may undo the connection. */
async function afterConnection(ctx: Ctx, result: GoogleAuthResult, viaLink: boolean): Promise<string | null> {
  const hostId = result.hostId!;
  let zone: string | null = null;
  if (result.accountId) {
    try {
      zone = await finishConnection(ctx, hostId, result.accountId, result.firstConnect === true);
    } catch (err) {
      // The connection itself is saved. Defaults and the zone catch up on the next save or scheduled run.
      ctx.log('warn', 'google: could not finish setting up a new connection', { hostId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  if (result.dropped) {
    // "Use a different Google account": the old main's events stay where they are. Writing them again
    // into the new account would send every attendee a second invitation, so they are detached instead.
    // Any that are missed here are found by the stamp of the next housekeeping runs.
    try {
      await detachEventsOfAccount(ctx, hostId, { id: result.dropped.id, email: result.dropped.email }, { includeUnstamped: true, why: 'replaced' });
    } catch (err) {
      ctx.log('warn', 'google: could not detach the bookings of a replaced account', { hostId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  if (result.outcome && result.accountId && result.email) {
    await noticeGoogleConnection(ctx, { hostId, accountId: result.accountId, email: result.email, outcome: result.outcome, viaLink, ...(result.dropped ? { replacedEmail: result.dropped.email } : {}) });
  }
  return zone;
}

function intentFrom(url: URL): ConnectIntent {
  if (url.searchParams.get('add') === '1') return 'extra';
  if ((url.searchParams.get('account') ?? '') !== '') return 'reconnect';
  if (url.searchParams.get('switch') === '1') return 'replace';
  return 'main';
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
      // Either way only from this app's own pages, where the person can see whose calendar is being connected.
      if (linked && !startedOnOurPages(ctx, req)) {
        throw new HttpError(403, 'start_from_your_page', 'For your safety, Google can only be connected from this page. Press Connect here to go on.');
      }
      if (admin && !startedOnOurPages(ctx, req)) {
        throw new HttpError(403, 'start_from_dashboard', 'For your safety, Google can only be connected from your dashboard. Open Integrations or Team and connect from there.');
      }
      const host = linked ?? (admin ? await getHost(ctx, hostId) : null);
      if (!host) {
        if (admin) throw new HttpError(404, 'host_not_found', 'That person is no longer on the team.');
        throw new HttpError(401, 'unauthorized', byToken ? 'This link does not work any more. Ask for a new one.' : 'Please sign in, then connect Google again.');
      }

      const site = await getSite(ctx);
      // A co-host's link always comes back to that co-host's own page, which names them, never to the dashboard.
      const returnTo = linked ? refusalPage : (url.searchParams.get('return') ?? refusalPage);
      const intent = intentFrom(url);
      const accountId = intent === 'reconnect' ? (url.searchParams.get('account') ?? '') : undefined;
      // Sending mail from Gmail only ever happens from the owner's main account, and only the owner can ask
      // for it. Reconnecting that account asks for it again by itself when it had it.
      const ownersMain = admin && host.id === site.ownerHostId;
      const reconnectsGmail = ownersMain && intent === 'reconnect' && !!host.google && mainOf(host)?.account.id === accountId && host.google.gmailSend === true;
      const gmail = ownersMain && intent !== 'extra' && (url.searchParams.get('gmail') === '1' || reconnectsGmail);
      const location = await buildGoogleAuthUrl(ctx, {
        hostId: host.id,
        returnTo,
        gmail,
        intent,
        ...(accountId !== undefined ? { accountId } : {}),
        // The main account's address, else the host's own (unused for the account chooser).
        loginHint: host.google?.email || host.email || undefined,
        // Marks the link this was started from, so a link replaced meanwhile cannot finish it.
        ...(linked && typeof linked.inviteTokenHash === 'string' && linked.inviteTokenHash !== '' ? { linkMark: linkMark(ctx, linked.inviteTokenHash) } : {}),
      });
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

    // Started from a co-host's private link: that link must still be the current one, before any code is exchanged.
    const viaLink = !!state && (state.lt !== undefined || state.returnTo.startsWith(`${BASE_PATH}/host/`));
    if (state && viaLink) {
      const linkHost = await getHost(ctx, state.hostId);
      const current = typeof linkHost?.inviteTokenHash === 'string' && linkHost.inviteTokenHash !== '' ? linkHost.inviteTokenHash : null;
      // A state signed by the previous deploy has no mark: then the host only has to still have a link.
      const still = !!current && (state.lt === undefined || safeEqual(state.lt, linkMark(ctx, current)));
      if (!still) {
        ctx.log('warn', 'google: a sign-in came back for a private link that was replaced meanwhile', { hostId: state.hostId });
        return redirect(
          withResult(absoluteReturnUrl(ctx, state.returnTo)!, { ok: false, reason: 'This private link was replaced while you were at Google. Open the new link and connect again.' }),
          302,
          cookie,
        );
      }
    }

    const result = await completeGoogleAuth(ctx, url.searchParams);
    // Without a host the state could not be read, so the return path in it is not to be relied on.
    const target = absoluteReturnUrl(ctx, result.hostId ? result.returnTo : null)!;

    if (!result.ok) {
      return redirect(withResult(target, { ok: false, reason: result.error || 'Google did not finish connecting. Please try again.' }), 302, cookie);
    }
    const zone = result.hostId ? await afterConnection(ctx, result, viaLink) : null;
    return redirect(withResult(target, { ok: true, zone, outcome: result.outcome, accountId: result.accountId, note: result.note, wanted: result.wanted }), 302, cookie);
  }),
];
