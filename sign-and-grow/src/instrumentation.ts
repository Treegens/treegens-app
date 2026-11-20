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
  // And when signing in with Microsoft was set up with a MICROSOFT_TENANT we cannot check sign-ins against: it
  // stays switched off, and the operator should hear why instead of looking for a missing button.
  const { signInWarning } = await import('./lib/signin');
  const signIn = signInWarning();
  if (signIn) console.error(signIn);
  // And when the security page has to tell visitors that the operator has not said where the server is or who
  // else handles data: the operator hears it here first, with the settings that fill it in.
  const { dataPlaceWarning } = await import('./lib/dataplace');
  const where = dataPlaceWarning();
  if (where) console.error(where);
  // And when text messages were half set up: they stay switched off, and the operator hears which setting is missing.
  const { smsWarning } = await import('./lib/checks');
  const sms = smsWarning();
  if (sms) console.error(sms);
  const { tick } = await import('./server/cron');
  g.__tscron = setInterval(() => tick().catch((e) => console.error('[cron]', e)), 15 * 60_000);
  g.__tscron.unref?.();
}
