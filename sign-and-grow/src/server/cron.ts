import { cronTick } from './envelopes.ts';
import { dormancyNudges, renewalReminders, billingRetries, endRemovedCodes } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';
import { retryMail } from './mail.ts';

// Everything that runs on a timer: expiry, expiry warnings, reminders to signers, the reminders before a renewal,
// refunds and cancellations the payment provider could not take the first time, the "you pay but do not use it"
// nudge, free codes that were switched off, and removing accounts whose closing grace period has passed. Emails the
// mail server would not take earlier are tried again here too (`mail` in the answer says how that went).
export async function tick() {
  const r = { ...(await cronTick()), mail: await retryMail() };
  return { ...r, renewals: await renewalReminders(), retried: await billingRetries(), nudged: await dormancyNudges(), codes_ended: await endRemovedCodes(), purged: await purgeClosedAccounts() };
}
