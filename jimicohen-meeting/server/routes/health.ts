/**
 * GET /health : is the function wired up, and does storage keep the promises bookings rely on?
 *
 * The compare-and-swap behaviour of the production store (Netlify Blobs, strong consistency)
 * cannot be exercised in unit tests, so this runs the real thing against a scratch key.
 * Use it right after a deploy: 200 { ok: true } means double-booking protection is working.
 * It reveals nothing about the site, and is rate limited per visitor.
 */
import { rateLimit } from '../lib/auth';
import { randomId } from '../lib/crypto';
import { HttpError, json, route, type Route } from '../lib/http';
import { kvSelfTest } from '../lib/store';

export const routes: Route[] = [
  route('GET', '/health', async ({ ctx }) => {
    try {
      await rateLimit(ctx, 'health', ctx.ip ?? 'unknown', 6, 60);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // The limiter itself runs on the store. If that is what is broken, the self test below says how.
      ctx.log('warn', 'health: rate limiter failed', { error: err });
    }
    const result = await kvSelfTest(ctx.kv, randomId('st'));
    if (!result.ok) ctx.log('error', 'health: storage self test failed', result);
    return json(
      { ok: result.ok, storage: result.ok ? 'ok' : (result.failed ?? 'failed'), time: ctx.now().toISOString() },
      result.ok ? 200 : 503,
    );
  }),
];
