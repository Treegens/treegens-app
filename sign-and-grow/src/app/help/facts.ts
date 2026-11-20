// Numbers the public pages quote: the refund window, the unused-plan rule, the time to undo closing an account.
// Server components only: this reads the environment, so do not import it from a 'use client' file.
//
// They come from src/lib/policy.ts, the same file the server enforces them from, so the pages cannot drift.
// (A page must never import a routes-*.ts file from src/server: that registers the API handlers a second time and
// breaks their error handling. policy.ts registers nothing, which is why it is safe here.)
import { refundDays, dormantStopDays, CLOSE_GRACE_DAYS } from '@/lib/policy';
import { newAccountDailyRecipients, unpaidDailyRecipients, abuseSuspendAfter, ACCESS_CODE_MIN, ACCESS_CODE_TRIES, powerformIdleHours } from '@/lib/policy';

export type Facts = {
  refundDays: number; // unused signatures from the latest payment are refunded on request within this many days
  dormantStopDays: number; // an unused paid plan is not renewed after this many quiet days; 0 means the rule is off
  closeGraceDays: number; // a closed account can be brought back by signing in for this long
};

export function publicFacts(): Facts {
  return { refundDays: refundDays(), dormantStopDays: dormantStopDays(), closeGraceDays: CLOSE_GRACE_DAYS };
}

// The numbers behind the rules that keep scammers out, for the help and security pages. Same source as the server.
export function abuseFacts() {
  return {
    firstWeekDaily: newAccountDailyRecipients(), // people a day for an account that has not paid, in its first week
    unpaidDaily: unpaidDailyRecipients(), // and after that
    reportsToPause: abuseSuspendAfter(), // different recipients reporting one account before it is paused
    codeMin: ACCESS_CODE_MIN, // shortest access code a sender may set
    codeTries: ACCESS_CODE_TRIES, // wrong tries before an access code is frozen
    formIdleHours: powerformIdleHours(), // an unfinished start from a public form is cleared after this long
  };
}
