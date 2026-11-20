import { cronTick, formVisitorsReady } from './envelopes.ts';
import { dormancyNudges, renewalReminders, billingRetries, endRemovedCodes } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';
import { supportTick } from './routes-support.ts';
import { retryMail } from './mail.ts';
import { retryTexts } from './sms.ts';
import { forgetOldBounces } from './bounces.ts';
import { twoStepTick } from './twostep.ts';
import { flushComments } from './routes-comments.ts';
import { pruneStampImages } from './stamps.ts';
import { sweepSignIns } from './reclaim.ts';
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
    bounces_forgotten: forgetOldBounces(),
    // Visitors of a public form who were told to come back once it can take their signature, emailed when it can.
    forms_ready: await formVisitorsReady(),
    // Resets of two-step login by email: announced once a day, and switched off when their day has come (twostep.ts).
    two_step: await twoStepTick(),
    // Emails about comments that waited, because one went to the same person about the same envelope minutes before,
    // or because sending was paused (routes-comments.ts).
    comments: await flushComments(),
    // Sign-ins at Google or Microsoft that were started and never finished (signin_states), past their ten minutes (reclaim.ts).
    signins_cleared: sweepSignIns(),
    // Stamp pictures that no field and no stamp of an account points at any more (stamps.ts).
    stamp_pictures: pruneStampImages() };
}
