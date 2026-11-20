// Numbers the public pages quote: the refund window, the unused-plan rule, the time to undo closing an account.
// Server components only: this reads the environment, so do not import it from a 'use client' file.
//
// They come from src/lib/policy.ts, the same file the server enforces them from, so the pages cannot drift.
// (A page must never import a routes-*.ts file from src/server: that registers the API handlers a second time and
// breaks their error handling. policy.ts registers nothing, which is why it is safe here.)
import { refundDays, dormantStopDays, CLOSE_GRACE_DAYS } from '@/lib/policy';

export type Facts = {
  refundDays: number; // unused signatures from the latest payment are refunded on request within this many days
  dormantStopDays: number; // an unused paid plan is not renewed after this many quiet days; 0 means the rule is off
  closeGraceDays: number; // a closed account can be brought back by signing in for this long
};

export function publicFacts(): Facts {
  return { refundDays: refundDays(), dormantStopDays: dormantStopDays(), closeGraceDays: CLOSE_GRACE_DAYS };
}
