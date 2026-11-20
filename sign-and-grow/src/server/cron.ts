import { cronTick } from './envelopes.ts';
import { dormancyNudges, renewalReminders, billingRetries, endRemovedCodes } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';

// Everything that runs on a timer: expiry, expiry warnings, reminders to signers, the reminders before a renewal,
// refunds and cancellations the payment provider could not take the first time, the "you pay but do not use it"
// nudge, free codes that were switched off, and removing accounts whose closing grace period has passed.
export async function tick() {
  const r = await cronTick();
  return { ...r, renewals: await renewalReminders(), retried: await billingRetries(), nudged: await dormancyNudges(), codes_ended: await endRemovedCodes(), purged: await purgeClosedAccounts() };
}
