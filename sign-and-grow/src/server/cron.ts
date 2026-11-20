import { cronTick } from './envelopes.ts';
import { dormancyNudges, renewalReminders, billingRetries, endRemovedCodes } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';
import { supportTick } from './routes-support.ts';
import { retryMail } from './mail.ts';
import { retryTexts } from './sms.ts';
import { forgetOldBounces } from './bounces.ts';
// Loaded for what it listens to: what became of a text is written to its envelope's record from there.
import './signercode.ts';

// Everything that runs on a timer: expiry, expiry warnings, reminders to signers, the reminders before a renewal,
// refunds and cancellations the payment provider could not take the first time, the "you pay but do not use it"
// nudge, free codes that were switched off, and removing accounts whose closing grace period has passed. Emails the
// mail server would not take earlier are tried again here too (`mail` in the answer says how that went).
export async function tick() {
  // Text messages the provider would not take are tried again the same way (`texts`).
  const r = { ...(await cronTick()), mail: await retryMail(), texts: await retryTexts() };
  return { ...r, renewals: await renewalReminders(), retried: await billingRetries(), nudged: await dormancyNudges(), codes_ended: await endRemovedCodes(), purged: await purgeClosedAccounts(),
    // Help requests that have passed the time a person should have answered by: the operators are emailed and the customer is told.
    support: await supportTick(),
    // Addresses that bounced, and "try later" days, older than BOUNCE_WARN_DAYS (bounces.ts).
    bounces_forgotten: forgetOldBounces() };
}
