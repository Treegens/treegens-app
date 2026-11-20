// The rules that both the server and the public pages quote, in one place, so the help page, checkout emails and the
// code that enforces them can never disagree. This file has no side effects and registers nothing, which makes it
// safe to import from pages as well as from the server. It reads the environment, so use it in server code and
// server components only, not in 'use client' files.

/** Unused signatures from the latest payment are refunded on request within this many days. */
export const refundDays = (): number => Number(process.env.REFUND_DAYS) || 30;

/** The refund rule as one sentence. Every email, page and error that states it uses this, so they cannot disagree. */
export const refundRuleText = (days: number): string =>
  `Signatures you have not used are refunded in full within ${days} days of the payment that bought them, from the Plan page, without talking to anyone. Refunding a monthly payment also ends the monthly plan.`;

/** A paid plan nobody has used for this many days is not renewed. 0 turns the rule off. */
export const dormantStopDays = (): number => (process.env.DORMANT_AUTO_STOP_DAYS === undefined ? 90 : Number(process.env.DORMANT_AUTO_STOP_DAYS) || 0);

/** A closed account can be brought back by signing in for this many days. */
export const CLOSE_GRACE_DAYS = 30;

/** How many different recipients must report an account before its sending is paused for review. */
export const abuseSuspendAfter = (): number => Number(process.env.ABUSE_SUSPEND_AFTER) || 3;

/** How many people a new, unpaid account may send to per day in its first week. */
export const newAccountDailyRecipients = (): number => Number(process.env.NEW_ACCOUNT_DAILY_RECIPIENTS) || 50;

/** How many people an account that has not paid may send to per day after its first week. Paying for anything, or being cleared by a person, lifts both limits. */
export const unpaidDailyRecipients = (): number => Number(process.env.UNPAID_DAILY_RECIPIENTS) || 200;

/** An access code a sender sets must have at least this many characters. */
export const ACCESS_CODE_MIN = 4;

/** After this many wrong tries in total an access code is frozen until the sender sets a new one. */
export const ACCESS_CODE_TRIES = 10;

/** A start from a public form that nobody has touched for this many hours is closed, and the signature held for it comes back. */
export const powerformIdleHours = (): number => Number(process.env.POWERFORM_IDLE_HOURS) || 24;

/** How many unfinished starts one device address may have on one public form at a time. */
export const POWERFORM_OPEN_STARTS = 3;
