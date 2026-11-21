// Runs once when the server starts. Checks every 15 minutes for envelopes that expired or are due a reminder.
// On hosts that sleep, call POST /api/cron with "Authorization: Bearer $CRON_SECRET" from a scheduler instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const g = globalThis as any;
  if (g.__tscron) return;
  // Before anything else reads a setting or opens a connection: OUTSIDE_CALLS (src/lib/outside.ts). In mode none the
  // settings of every service that needs an outside host are taken away here, so those features are simply absent;
  // in listed and none the guard in src/server/outside.ts refuses other hosts. The list is logged either way.
  const { applyOutsideCalls, outsideStartLines } = await import('./lib/outside');
  applyOutsideCalls();
  const { installOutsideGuard } = await import('./server/outside');
  installOutsideGuard();
  for (const line of outsideStartLines()) console.log(line);
  const { securityContactWarning } = await import('./lib/selfhost');
  const contact = securityContactWarning();
  if (contact) console.error(contact);
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
  // And when the stored files need a key the server was not given, or FILE_ENCRYPTION_KEY is not a key: it stores no
  // new file until that is put right (src/server/filestore.ts), and the operator hears why before anyone uploads.
  const { fileStoreWarning } = await import('./server/filestore');
  const files = fileStoreWarning();
  if (files) console.error(files);
  // With a key, the text kept from uploaded PDFs for search is encrypted with it too, also what was kept before the
  // key was set, and text under an old key moves to the current one (src/server/searchtext.ts).
  const { sealKeptTexts } = await import('./server/searchtext');
  sealKeptTexts();
  const { tick } = await import('./server/cron');
  g.__tscron = setInterval(() => tick().catch((e) => console.error('[cron]', e)), 15 * 60_000);
  g.__tscron.unref?.();
}
