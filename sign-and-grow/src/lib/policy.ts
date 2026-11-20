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
// How long before a higher monthly price everyone who would pay it is told. The server holds renewals to this:
// a renewal above the price an account was on, without a notice that old, has the difference refunded.
export const PRICE_NOTICE_DAYS = 30;
export const priceRuleText = (days = PRICE_NOTICE_DAYS): string =>
  `The price of your plan never goes up without notice. If the monthly price ever changes, every owner and admin is told by email at least ${days} days before the first renewal at the new price, with the old price, the new price, the date and a link that stops the plan in one click. A renewal that charges more than the price you were on without that notice has the difference refunded automatically. Signatures you already have are never touched by a price change.`;
// How long we keep our own copy of an email that is not part of a document's record (invitations, notices, receipts,
// reminders). A copy of an email about a document stays with that document and goes when the document goes.
export const MAIL_COPY_DAYS = 90;

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
// A form its owner marked as filled in on a shared device (a tablet at the front desk, one office network): many
// people come from the same address there, so more unfinished starts are allowed, and one that was walked away
// from is cleared after an hour instead of a day so it does not stand in the next person's way.
export const POWERFORM_SHARED_OPEN_STARTS = 30;
export const powerformSharedIdleMinutes = (): number => Number(process.env.POWERFORM_SHARED_IDLE_MINUTES) || 60;

/** This many days before a closed account is deleted, its owner is reminded by email, with how to keep it and how to export first. */
export const CLOSING_REMINDER_DAYS = 7;

/**
 * What deleting an account removes and what stays, in the words the pages use (Settings, /help and /security all
 * print these lists). The code that does it is purgeUser() in src/server/routes-trust.ts: change both together.
 * Plain constants, so a 'use client' file may import them.
 */
export const DELETED_WITH_ACCOUNT: string[] = [
  'Your login, your profile and your saved signature.',
  'Every account you own: its envelopes, drafts and templates, the documents you uploaded, the signed PDFs, the files signers attached and every audit trail, with the names, email addresses and internet addresses in them.',
  'Its contacts, API keys, webhooks and their delivery logs, bulk send records, public forms and reports from recipients.',
  'Our stored copies of the emails about those envelopes, and of the emails we sent you about your account.',
  'Messages you sent through the help form that have been answered.',
];
export const KEPT_AFTER_DELETION: string[] = [
  'The record of payments, refunds and of signatures bought and used, without your name or your email address, because accounts have to be kept. If you ever paid, the payment provider has its own record of that.',
  'A message to the help form that nobody has answered yet. It is deleted once it has been answered.',
  'Documents other people sent you, with what you did on them, such as your signature or a report you made. They belong to whoever sent them.',
  'What you sent as a member of a team you do not own. It belongs to that team and passes to its owner, and its audit trail says so. An API key you made there stays on the team\'s list as stopped, under your name.',
  'Signed PDFs your recipients downloaded or were emailed. Those are theirs. The links in our emails to them stop working.',
  'A fingerprint of the security code in each email about a document you sent, for one year. It holds no name, address or title. It only lets someone who still has that email learn that it was real and that the document has been deleted.',
  `If you go by a single name: our stored copies of emails to other people that mention it and belong to no document, such as an invitation you sent. Those go with all such copies, ${MAIL_COPY_DAYS} days after they were sent. Copies that carry your email address or a full name are deleted with the account.`,
];

/**
 * The public pages say a person answers. With no SUPPORT_EMAIL no address is shown anywhere, and a new help request
 * is emailed to the people in OPERATOR_EMAILS instead. With neither, nobody is emailed and nobody can open the
 * queue. Returns the warning to log once when a production server starts, or null.
 */
export function supportWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV !== 'production' || (env.SUPPORT_EMAIL || '').trim()) return null;
  return `\n[config] SUPPORT_EMAIL IS NOT SET. The help page, the footer and every email promise that a person answers, ${(env.OPERATOR_EMAILS || '').trim()
    ? 'but no address is shown to anyone. Help requests are emailed to the people in OPERATOR_EMAILS and shown in the operator queue at /app/operator'
    : 'but nobody is emailed when a help request arrives and no address is shown to anyone. Requests are only stored, and OPERATOR_EMAILS is empty as well, so no person can see them at all. No response time is promised on the help page while that is so'}. Set SUPPORT_EMAIL to an address that somebody reads, for example SUPPORT_EMAIL=help@example.com\n`;
}

// ---- Help requests ---------------------------------------------------------------------------------
// The response times are published on the help page, said in the acknowledgement email and shown on every request.
// The server counts them (src/server/routes-support.ts), so the page and the code cannot disagree.

const hours = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback);

/** A person answers a help request within this many hours of the message. Real hours: nights and weekends count. */
export const supportFirstReplyHours = (env: Record<string, string | undefined> = process.env): number => hours(env.SUPPORT_FIRST_REPLY_HOURS, 24);

/** The same for an urgent request. It is never longer than the time for any other request. */
export const supportUrgentReplyHours = (env: Record<string, string | undefined> = process.env): number => Math.min(hours(env.SUPPORT_URGENT_REPLY_HOURS, 8), supportFirstReplyHours(env));

/**
 * Whether a help request reaches anybody at all: SUPPORT_EMAIL, or at least one address in OPERATOR_EMAILS. With
 * neither, no response time is promised anywhere, because nobody could keep it (see supportWarning above).
 */
export const supportReachable = (env: Record<string, string | undefined> = process.env): boolean =>
  [env.SUPPORT_EMAIL || '', ...(env.OPERATOR_EMAILS || '').split(',')].some((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()));

/** What a help request can be about, in the order the form lists them. Plain constants, so a 'use client' file may import them. */
export const SUPPORT_TOPICS: string[] = ['signing', 'stuck', 'sending', 'billing', 'charged-wrongly', 'cannot-log-in', 'suspicious', 'other'];

/** The topics that make a request urgent: someone is locked out, money was taken wrongly, or a document or a deadline cannot wait. */
export const SUPPORT_URGENT_TOPICS: string[] = ['cannot-log-in', 'charged-wrongly', 'stuck'];

/** A closed request opens again when its writer replies within this many days. Later, a reply starts a new request that names the old one. */
export const SUPPORT_REOPEN_DAYS = 30;

/** The help page shows the real median time to a first answer over this many days, and only when it covers at least this many requests. */
export const SUPPORT_MEDIAN_DAYS = 30;
export const SUPPORT_MEDIAN_MIN = 10;

/** How many messages a customer may add in 24 hours, to one request and from one address, so a link cannot be used to flood the people who answer. */
export const SUPPORT_REPLIES_PER_REQUEST = 10;
export const SUPPORT_REPLIES_PER_ADDRESS = 30;
