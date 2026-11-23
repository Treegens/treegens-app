import { cronTick, formVisitorsReady } from './envelopes.ts';
import { dormancyNudges, renewalReminders, billingRetries, endRemovedCodes, expireSignatures, topUpExpiryNotices } from './routes-billing.ts';
import { purgeClosedAccounts } from './routes-trust.ts';
import { supportTick } from './routes-support.ts';
import { retryMail } from './mail.ts';
import { retryTexts } from './sms.ts';
import { retryWhatsApp } from './whatsapp.ts';
import { forgetOldBounces } from './bounces.ts';
import { twoStepTick } from './twostep.ts';
import { flushComments } from './routes-comments.ts';
import { pruneStampImages } from './stamps.ts';
import { sweepSignIns } from './reclaim.ts';
import { purgeSecurityLog, sendHeldAlerts } from './seclog.ts';
import { exportSecurityHeads } from './secheads.ts';
import { retentionTick, sweepArchiveCopies } from './records.ts';
import { noteTickStart, noteTick } from './selfhost.ts';
import { monthlyReports } from './routes-reports.ts';
import { purgeOldLists } from './bulklists.ts';
import { ocrTick } from './ocr.ts';
import { recheckDomains } from './orgsso.ts';
import { timingTick } from './timing.ts';
import { forgetOldExports } from './exportfull.ts';
import { forgetImportedFiles } from './importer.ts';
import { keyDatesTick, keyReminders } from './airepo.ts';
import { counterTick } from './counter.ts';
import { sweepScanPhotos } from './scanphotos.ts';
import { purgeDrafts } from './webforms.ts';
import { columnsTick } from './colsweep.ts';
import { acrobatTick } from './acrobat.ts';
// Loaded for what it listens to: what became of a text is written to its envelope's record from there.
import './signercode.ts';

// Everything that runs on a timer: expiry, expiry warnings, reminders to signers, the reminders before a renewal,
// refunds and cancellations the payment provider could not take the first time, the "you pay but do not use it"
// nudge, free codes that were switched off, and removing accounts whose closing grace period has passed. Emails the
// mail server would not take earlier are tried again here too (`mail` in the answer says how that went).
export async function tick() {
  // When each run starts and ends, for GET /api/health (src/server/selfhost.ts).
  noteTickStart();
  try {
    const out = await tickOnce();
    noteTick(true);
    return out;
  } catch (e) {
    noteTick(false);
    throw e;
  }
}
async function tickOnce() {
  // Text messages the provider would not take are tried again the same way (`texts`).
  // Drafts set to go out now (Send later), and people whose wait before their step has ended (timing.ts).
  const timing = await timingTick();
  const r = { ...(await cronTick()), timing, mail: await retryMail(), texts: await retryTexts(), whatsapp: await retryWhatsApp() };
  return { ...r, renewals: await renewalReminders(),
    // Signatures whose date has passed and that nobody holds expire, with a line in the plan history (credits.ts),
    // and top-ups about to expire unused are announced 30 and 3 days before (routes-billing.ts).
    signatures_expired: expireSignatures(), topups_warned: await topUpExpiryNotices(),
    retried: await billingRetries(), nudged: await dormancyNudges(), codes_ended: await endRemovedCodes(), purged: await purgeClosedAccounts(),
    // Help requests that have passed the time a person should have answered by: the operators are emailed and the customer is told.
    support: await supportTick(),
    // Addresses that bounced, and "try later" days, older than BOUNCE_WARN_DAYS (bounces.ts).
    bounces_forgotten: forgetOldBounces(),
    // Visitors of a public form who were told to come back once it can take their signature, emailed when it can.
    forms_ready: await formVisitorsReady(),
    form_answers_forgotten: purgeDrafts(), // a form's unsigned answers, after a day (webforms.ts)
    // Resets of two-step login by email: announced once a day, and switched off when their day has come (twostep.ts).
    two_step: await twoStepTick(),
    // Emails about comments that waited, because one went to the same person about the same envelope minutes before,
    // or because sending was paused (routes-comments.ts).
    comments: await flushComments(),
    // Sign-ins at Google or Microsoft that were started and never finished (signin_states), past their ten minutes (reclaim.ts).
    signins_cleared: sweepSignIns(),
    // Stamp pictures that no field and no stamp of an account points at any more (stamps.ts).
    stamp_pictures: pruneStampImages(),
    // Lines of the security record older than SECURITY_LOG_DAYS (seclog.ts).
    security_lines_purged: purgeSecurityLog(),
    // What a security alert held back during its hour, said in one email once the hour is over (seclog.ts).
    security_alerts_followed: await sendHeldAlerts(),
    // Where each account's security record stands, noted once a day in a folder outside the database, when
    // SECURITY_HEADS_DIR names one (secheads.ts).
    security_heads_noted: exportSecurityHeads(),
    // Full exports past their 7 days, and files of records brought in whose record has gone (exportfull.ts, importer.ts).
    exports_forgotten: forgetOldExports(), imported_files_forgotten: forgetImportedFiles(),
    // Photos that pages were cleaned from, of files that are gone (scanphotos.ts).
    scan_photos_removed: sweepScanPhotos(),
    // Closed envelopes at the end of their retention period: the email 14 days before, then the purge (records.ts).
    retention: await retentionTick(),
    // Our stored archive copies about envelopes deleted or purged since, once they have left (archivemail.ts).
    archive_copies_forgotten: sweepArchiveCopies(),
    // Counter codes past their day, screens past their hours, and ID pictures of purged documents (counter.ts).
    counter: counterTick(),
    // Last month's report for the admins who asked for it, on the first days of a month (routes-reports.ts).
    monthly_reports: await monthlyReports().catch((e) => (console.error('[cron] monthly reports', e?.message), 0)),
    // Saved lists for Send to many that nobody used for the account's number of days (bulklists.ts).
    lists_deleted: purgeOldLists(),
    // Text of scanned pages still waiting to be read, when OCR_CMD or OCRMYPDF_URL is set (ocr.ts).
    // It waits at most 20 seconds: a long batch goes on by itself and never holds up the timer (ocrTick).
    ocr_read: await ocrTick(),
    // Email domains claimed for single sign-on, looked at again once a day: a DNS line that is gone pauses it (orgsso.ts).
    sso_domains_checked: await recheckDomains().catch((e) => (console.error('[cron] sso domains', e?.message), 0)),
    // Key dates: completed documents read by the AI a few at a time, and "Remind me" emails before a checked date (airepo.ts).
    key_dates_read: await keyDatesTick().catch((e) => (console.error('[cron] key dates', e?.message), 0)),
    key_dates_reminded: await keyReminders().catch((e) => (console.error('[cron] key date reminders', e?.message), 0)),
    // The automatic Adobe Acrobat check: a sample never reported on, no check for too long, and the last 60 kept (acrobat.ts).
    acrobat_check: await acrobatTick().catch((e) => (console.error('[cron] acrobat check', e?.message), null)),
    // With FILE_ENCRYPTION_KEY: database values still in the clear or under an old key, a batch a tick (colsweep.ts).
    values_encrypted: (() => { try { return columnsTick(); } catch (e: any) { console.error('[cron] encrypted columns', e?.message); return 0; } })() };
}
