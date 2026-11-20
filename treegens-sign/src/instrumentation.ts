// Runs once when the server starts. Checks every 15 minutes for envelopes that expired or are due a reminder.
// On hosts that sleep, call POST /api/cron with "Authorization: Bearer $CRON_SECRET" from a scheduler instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const g = globalThis as any;
  if (g.__tscron) return;
  const { cronTick } = await import('./server/envelopes');
  g.__tscron = setInterval(() => cronTick().catch((e) => console.error('[cron]', e)), 15 * 60_000);
  g.__tscron.unref?.();
}
