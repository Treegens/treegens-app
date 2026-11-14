/**
 * The whole HTTP API behind `/meeting/api/*`: one dispatcher over the route tables in
 * server/routes. Runs unchanged in the Netlify function, the local dev server and tests.
 */
import { hasValidSecretKey } from './lib/crypto';
import type { Ctx } from './lib/ctx';
import { dispatch, json, type Route } from './lib/http';
import { routes as adminRoutes } from './routes/admin';
import { routes as authRoutes } from './routes/auth';
import { routes as devRoutes } from './routes/dev';
import { routes as googleRoutes } from './routes/google';
import { routes as healthRoutes } from './routes/health';
import { routes as hostRoutes } from './routes/host';
import { routes as publicRoutes } from './routes/public';
import { routes as webhookRoutes } from './routes/webhooks';

/** Every route that can answer for this context. Dev routes exist only next to mocked providers. */
export function allRoutes(ctx: Ctx): Route[] {
  const routes = [...publicRoutes, ...webhookRoutes, ...authRoutes, ...adminRoutes, ...hostRoutes, ...googleRoutes, ...healthRoutes];
  return ctx.env.mockProviders ? [...routes, ...devRoutes] : routes;
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (!hasValidSecretKey(ctx)) {
    // Without the master secret nothing can be signed or decrypted. Say so once, clearly, instead of failing per route.
    ctx.log('error', 'MEETING_SECRET_KEY is missing or too short; refusing to serve the API');
    return json({ error: { code: 'not_configured', message: 'The scheduler is not set up yet. Please try again later.' } }, 503, {
      'X-Request-Id': ctx.requestId,
    });
  }
  return dispatch(allRoutes(ctx), ctx, req);
}
