import type { Config, Context } from '@netlify/functions';
import { runScheduled } from '../../server/cron';
import { hasValidSecretKey } from '../../server/lib/crypto';
import { netlifyCtx } from '../../server/lib/runtime';

/** Every two minutes: deliver due reminders and other jobs, then periodic housekeeping. */
export default async (req: Request, context: Context): Promise<Response> => {
  const ctx = netlifyCtx(req, context);
  if (!hasValidSecretKey(ctx)) {
    ctx.log('error', 'MEETING_SECRET_KEY is missing or too short; scheduled run skipped');
    return new Response(null, { status: 503 });
  }
  try {
    // Only this function runs the one-time setup of stored data: Netlify runs it for the published deploy alone.
    ctx.log('info', 'scheduled run finished', await runScheduled(ctx, { oneTimeMoves: true }));
    return new Response(null, { status: 204 });
  } catch (err) {
    ctx.log('error', 'scheduled run failed', { error: err });
    return new Response(null, { status: 500 });
  }
};

export const config: Config = { schedule: '*/2 * * * *' };
