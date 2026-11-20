import { cronTick } from './envelopes.ts';
import { dormancyNudges } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';

// Everything that runs on a timer: expiry, expiry warnings, reminders, the "you pay but do not use it" nudge,
// and removing accounts whose closing grace period has passed.
export async function tick() {
  const r = await cronTick();
  return { ...r, nudged: await dormancyNudges(), purged: purgeClosedAccounts() };
}
