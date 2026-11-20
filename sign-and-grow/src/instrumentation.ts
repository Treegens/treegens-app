// Runs once when the server starts. Checks every 15 minutes for envelopes that expired or are due a reminder.
// On hosts that sleep, call POST /api/cron with "Authorization: Bearer $CRON_SECRET" from a scheduler instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const g = globalThis as any;
  if (g.__tscron) return;
  // Said once, loudly, when a production server starts with nobody set up to receive help requests.
  const { supportWarning } = await import('./lib/policy');
  const warning = supportWarning();
  if (warning) console.error(warning);
  const { tick } = await import('./server/cron');
  g.__tscron = setInterval(() => tick().catch((e) => console.error('[cron]', e)), 15 * 60_000);
  g.__tscron.unref?.();
}
