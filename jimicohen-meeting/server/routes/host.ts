/**
 * Co-host self-service. A co-host has no account: the private link the owner sent them carries
 * a token (`?t=`), and that token is the whole key. It opens exactly one host record, their
 * own, and nothing else: no other hosts, no bookings, no credentials.
 *
 *   GET /host/:id?t=             HostSelfResponse
 *   PUT /host/:id?t=             HostUpdate (the role, the email address and the photo stay the owner's call) → { host }
 *   GET /host/:id/calendars?t=   { calendars }
 *
 * A wrong, old or missing token gives the same 404 as a host that does not exist.
 */
import type { Host, HostSelfResponse } from '../../shared/types';
import { applyHostUpdate, loadCalendars } from '../lib/admin/hosts';
import { toAdminHost } from '../lib/admin/view';
import { assertSameOrigin, hostFromToken, rateLimit } from '../lib/auth';
import type { Ctx } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';
import { getSecrets, getSite } from '../lib/repo';

const REQUESTS_PER_VISITOR = 120;
const WINDOW_SEC = 10 * 60;

/** The host this link belongs to, or a 404 that says nothing about why. */
async function hostOfLink(ctx: Ctx, url: URL, hostId: string): Promise<Host> {
  await rateLimit(ctx, 'host-link', ctx.ip ?? 'unknown', REQUESTS_PER_VISITOR, WINDOW_SEC);
  const host = await hostFromToken(ctx, hostId, url.searchParams.get('t'));
  if (!host) throw new HttpError(404, 'not_found', 'This link does not work any more. Ask the person who invited you for a new one.');
  return host;
}

export const routes: Route[] = [
  route('GET', '/host/:id', async ({ ctx, url, params }) => {
    const host = await hostOfLink(ctx, url, params.id);
    const [site, secrets] = await Promise.all([getSite(ctx), getSecrets(ctx)]);
    const answer: HostSelfResponse = {
      host: toAdminHost(ctx, host),
      siteName: site.profile.name,
      theme: site.theme,
      googleConfigured: !!secrets.google?.clientId && !!secrets.google?.clientSecret,
      // Loaded separately (GET /host/:id/calendars), so a slow answer from Google never holds up this page.
      calendars: null,
    };
    return json(answer);
  }),

  route('PUT', '/host/:id', async ({ ctx, req, url, params }) => {
    assertSameOrigin(ctx, req);
    const host = await hostOfLink(ctx, url, params.id);
    const result = await applyHostUpdate(ctx, host, await readJson(req), { self: true });
    return json({ host: toAdminHost(ctx, result.host), timezone: result.host.timezone, timezoneChanged: result.timezoneChanged });
  }),

  route('GET', '/host/:id/calendars', async ({ ctx, url, params }) => {
    const host = await hostOfLink(ctx, url, params.id);
    return json({ calendars: await loadCalendars(ctx, host) });
  }),
];
