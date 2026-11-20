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
// The day a new monthly price starts, written the same way everywhere it is shown (the email that announces it, the
// Plan page and the operator page): as a calendar day in UTC, and saying so, so nobody reads a different day.
export const priceChangeDay = (iso: string | null | undefined): string =>
  iso ? `${new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} (UTC)` : '';
// How long we keep our own copy of an email that is not part of a document's record (invitations, notices, receipts,
// reminders). A copy of an email about a document stays with that document and goes when the document goes.
export const MAIL_COPY_DAYS = 90;

// ---- Emails that did not arrive (src/server/bounces.ts) -----------------------------------------------------
/**
 * Whether this server hears from its mail provider what became of an email after hand-over: it does once the
 * operator has set MAIL_EVENTS_TOKEN (at least MAIL_EVENTS_TOKEN_MIN characters) and pointed the provider at
 * POST /api/mail/events. Without it nothing in the product says that bounces are noticed, because they are not.
 */
export const MAIL_EVENTS_TOKEN_MIN = 16;
export const mailEventsOn = (env: Record<string, string | undefined> = process.env): boolean => (env.MAIL_EVENTS_TOKEN || '').trim().length >= MAIL_EVENTS_TOKEN_MIN;
/** An address that bounced for good is on its account's do-not-mail list for this many days: a new envelope to it warns first. */
export const BOUNCE_WARN_DAYS = 30;
/** "Try later" answers from one address on this many separate days (within BOUNCE_WARN_DAYS) count as an address that does not work. */
export const SOFT_BOUNCE_DAYS = 3;
/** News from the mail provider that names no email of ours is matched to the emails sent to that address in this many days. */
export const BOUNCE_MATCH_DAYS = 3;
/** What "Could not be delivered" means and does, in one sentence each, for the help page and the emails that say it. */
export const BOUNCE_MEANS = 'The mail server of the address answered that it cannot take the email for good: the mailbox or the domain does not exist, or it refuses.';
export const BOUNCE_STOPS = `Reminders to that address stop until you correct it or choose "Try again", and for ${BOUNCE_WARN_DAYS} days a new envelope to the same address warns you before it goes out.`;
export const COMPLAINT_MEANS = 'The person marked one of our emails for your account as spam in their mail program. Nothing more is emailed to them about your account\'s documents, that one and any later one, unless they ask for it themselves on a signing page with a code we email them. Correcting the address, trying again or sending a new envelope does not change that. It also counts as one report against your account.';

/** How many different recipients must report an account before its sending is paused for review. */
export const abuseSuspendAfter = (): number => Number(process.env.ABUSE_SUSPEND_AFTER) || 3;

/** How many people a new, unpaid account may send to per day in its first week. */
export const newAccountDailyRecipients = (): number => Number(process.env.NEW_ACCOUNT_DAILY_RECIPIENTS) || 50;

/** How many people an account that has not paid may send to per day after its first week. A payment that has stood for PAID_TRUST_DAYS, or being cleared by a person, lifts both limits. */
export const unpaidDailyRecipients = (): number => Number(process.env.UNPAID_DAILY_RECIPIENTS) || 200;

/**
 * Paying does not lift the protections at once. The daily limit and the filter for fake payment notices apply until
 * an account has a payment that is at least this many days old and was neither refunded nor disputed, or until a
 * person has marked the account as trusted. Otherwise a few dollars would buy a day of sending anything to anyone,
 * and could be taken back the same evening.
 */
export const PAID_TRUST_DAYS = 14;
/** The rule above as one sentence, for the refusals and the pages that explain the limits. */
export const paidTrustText = (days = PAID_TRUST_DAYS): string =>
  `These checks stop applying once the account has a payment that is at least ${days} days old and was not refunded or disputed, or once a person on our team has cleared it.`;

/** How many people one account can invite to its team in 24 hours. A person on our team can lift it by marking the account as trusted. */
export const TEAM_INVITES_PER_DAY = 20;

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
// Every start emails an address a stranger typed, so starts from one internet connection are limited per hour as
// well: across all ordinary public forms together, and for each shared-device form on its own, with room for a
// steady stream of people at a front desk (two a minute). Unfinished ones are still capped by the numbers above.
export const POWERFORM_STARTS_PER_HOUR = 20;
export const POWERFORM_SHARED_STARTS_PER_HOUR = 120;

/** This many days before a closed account is deleted, its owner is reminded by email, with how to keep it and how to export first. */
export const CLOSING_REMINDER_DAYS = 7;

/**
 * A closed help request opens again when its writer replies within this many days. Later, a reply starts a new
 * request that names the old one. (The other rules for help requests are further down. This one stands here
 * because the list below quotes it.)
 */
export const SUPPORT_REOPEN_DAYS = 30;

/**
 * What deleting an account removes and what stays, in the words the pages use (Settings, /help and /security all
 * print these lists). The code that does it is purgeUser() in src/server/routes-trust.ts: change both together.
 * Plain constants, so a 'use client' file may import them.
 */
export const DELETED_WITH_ACCOUNT: string[] = [
  'Your login, your profile and your saved signature.',
  'Every account you own: its envelopes, drafts and templates, the documents you uploaded, the signed PDFs, the files signers attached and every audit trail, with the names, email addresses and internet addresses in them.',
  'Its contacts, API keys, webhooks and their delivery logs, bulk send records, public forms and reports from recipients.',
  'Its click-to-agree terms with every version, every acceptance recorded for them (with the names, email addresses, customer numbers, internet addresses, browsers and pages in them), reports about their pages, and our stored copies of the emails that sent people a copy of what they accepted.',
  'Our stored copies of the emails about those envelopes, and of the emails we sent you about your account.',
  'Help requests of yours that have been answered or closed, each with everything written back and forth on it.',
];
export const KEPT_AFTER_DELETION: string[] = [
  'The record of payments, refunds and of signatures bought and used, without your name or your email address, because accounts have to be kept. If you ever paid, the payment provider has its own record of that.',
  `A help request that nobody has answered yet, or on which we asked you something and wait for your reply. It is deleted once it has been answered. The answer is emailed to you first. An unanswered question of ours is kept for ${SUPPORT_REOPEN_DAYS} more days, then deleted.`,
  'A help request you wrote while signed in, but under somebody else\'s email address. Its answers go to that address, so it belongs to that mailbox and stays for it, without your login, your account or your name. It is deleted like the other requests of that address.',
  'Documents other people sent you, with what you did on them, such as your signature or a report you made. They belong to whoever sent them.',
  'What you sent as a member of a team you do not own. It belongs to that team and passes to its owner, and its audit trail says so. An API key you made there stays on the team\'s list as stopped, under your name.',
  'Signed PDFs your recipients downloaded or were emailed. Those are theirs. The links in our emails to them stop working.',
  'A fingerprint of the security code in each email about a document you sent, for one year. It holds no name, address or title. It only lets someone who still has that email learn that it was real and that the document has been deleted.',
  'For each completed document you sent: the fingerprint (SHA-256) of its signed PDF, its envelope ID and the day it was completed, for one year. Nothing else: no name, address or title. It only lets someone who holds that exact file learn at Verify a document that it was completed here on that day and that its sender has deleted it since.',
  'A fingerprint of your email address and the day you were given the welcome signatures, if your address was confirmed. The welcome signatures are given once per address, and this is how we know after your login is gone, or after it moved to another address (that fingerprint is kept from the day it moved). It is made with a key only this server has, cannot be turned back into your address, and holds no name.',
  `Our stored copies of emails to other people are deleted with your login when we marked them as being about you when they were sent: an invitation you sent, a notice to a team about your API keys or that you left, or our note to the people who answer help requests about a request of yours. Any other copy, such as one where somebody else typed your name or address, and any email still waiting to be delivered at that moment, is deleted like every copy that is not part of a document's record: ${MAIL_COPY_DAYS} days after it was sent.`,
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
// 'not-me' ("I am named on a document I did not sign") is never passed to the document's sender: only 'signing' is.
export const SUPPORT_TOPICS: string[] = ['signing', 'stuck', 'sending', 'billing', 'charged-wrongly', 'cannot-log-in', 'suspicious', 'not-me', 'other'];

/** The topics that make a request urgent: someone is locked out, money was taken wrongly, or a document or a deadline cannot wait. */
export const SUPPORT_URGENT_TOPICS: string[] = ['cannot-log-in', 'charged-wrongly', 'stuck'];

/** The help page shows the real median time to a first answer over this many days, and only when it covers at least this many requests. */
export const SUPPORT_MEDIAN_DAYS = 30;
export const SUPPORT_MEDIAN_MIN = 10;

/** How many messages a customer may add in 24 hours, to one request and from one address, so a link cannot be used to flood the people who answer. */
export const SUPPORT_REPLIES_PER_REQUEST = 10;
export const SUPPORT_REPLIES_PER_ADDRESS = 30;
/**
 * How many help requests may be written under one address by people who are not known to own it (not signed in
 * under it as their confirmed address): in 24 hours, and open at once. Each one sends that address an email, so this
 * is all a stranger can send to somebody's inbox through the form. The owner's own messages never count against it.
 */
export const SUPPORT_OTHERS_PER_ADDRESS = 3;
/**
 * A closed help request that belongs to no login (written without one, or under an address whose login is gone) is
 * deleted this many days after it was closed, with everything written on it. A login's requests go with the login.
 */
export const SUPPORT_KEEP_DAYS = 90;

// ---- What a signer agrees to before any field opens ------------------------------------------------
// The signing screen shows these words, the server writes their version into the audit line when the signer agrees,
// and /help prints them with the version, so a certificate that says "wording 2026-11" can be read back by anyone.
// The words say what kind of signature this is and what the software does not check. They never say that a
// signature is valid or equal to a handwritten one: that depends on the country and on the kind of document, and
// the software knows neither. To change a word, add a new version here, keep the old one, and move CONSENT_VERSION.
// Plain functions with no environment in them, so a 'use client' file may import them.
export type ConsentWording = { version: string; legal: string; practical: string; agree: string };
export const CONSENT_VERSION = '2026-11';
const CONSENT_WORDINGS: Record<string, (sender: string, signs: boolean) => Omit<ConsentWording, 'version'>> = {
  '2026-11': (sender, signs) => ({
    legal: signs
      ? `You are about to review and sign this document on screen, with a simple electronic signature: your name or mark on the page and a record of when and from where you signed. In many countries a signature like this can be used for agreements that need no special form. The rules differ by country and by kind of document, and some documents need a handwritten, witnessed, notarised or qualified signature instead. Sign&Grow does not know which kind this document is. If you are not sure, ask ${sender} or a lawyer before you sign. By continuing, you accept this electronic method as a valid way for you and the other parties to sign this document.`
      : `You are about to review this document on screen. What you do here is recorded electronically, not on paper. In many countries that can be used for agreements that need no special form. The rules differ by country and by kind of document, and some documents need a handwritten, witnessed, notarised or qualified signature instead. Sign&Grow does not know which kind this document is. If you are not sure, ask ${sender} or a lawyer before you continue.`,
    practical: `You can download or print a copy before you ${signs ? 'sign' : 'finish'}, and afterwards you can download what you ${signs ? 'signed' : 'finished'} from this same link, also if the document is later cancelled, declined or runs out of time. You can decline, or ask ${sender} for a paper copy instead. We record the time, your IP address and each step you take in a tamper-evident audit trail.`,
    agree: 'I agree to use electronic records and signatures.',
  }),
};
/** Whether a version is one we have shown. A screen that was open across a change of wording sends its own. */
export const isConsentVersion = (v: unknown): v is string => typeof v === 'string' && Object.hasOwn(CONSENT_WORDINGS, v);
/** The words of one version. `signs` is false for someone who approves or only reads. */
export const consentWording = (sender: string, signs: boolean, version: string = CONSENT_VERSION): ConsentWording =>
  ({ version: isConsentVersion(version) ? version : CONSENT_VERSION, ...CONSENT_WORDINGS[isConsentVersion(version) ? version : CONSENT_VERSION](sender, signs) });
/**
 * What the audit line says after the signer's name. The certificate prints it, so it says where the words can be
 * read. `stated` is false when the call that agreed did not say which wording its screen showed: the line then
 * names the wording in use at that moment and says that it is not the screen's own word.
 */
export const consentAuditNote = (version: string, stated = true): string =>
  `${stated ? `Wording ${version}` : `The screen did not say which wording it showed. The wording in use was ${version}`}, as printed on the help page under "What do I agree to before I sign?".`;
/** The line under "Adopt and sign". It says what the mark is, not what a court will make of it. */
export const adoptLine = (word: 'signature' | 'initials'): string => `I agree that this mark stands for my ${word}.`;

// ---- Language ----------------------------------------------------------------------------------------
// One sentence, quoted by the landing page, /help, /security and the README. Whoever adds languages changes it here.
export const LANGUAGE_NOTE = 'The signing screen and our emails are in English for now. Your document can be in any language.';

// ---- When the signing page will not open where the signer is -----------------------------------------
// Some countries and some office networks do not let a page through, and we have not tested from where this one can
// be reached. So every email that asks someone to open a signing page ends with a way round that needs no page: its
// reply goes to the sender, who can send the document as a PDF. /help tells senders what to do then.
export const cannotOpenLine = (sender: string): string => `Page will not open where you are? Reply to this email and ask ${sender} to send the document as a PDF.`;

// ---- Checking who signs ----------------------------------------------------------------------------
// A one-time code sent by email or by text message before a document opens. The server enforces these
// (src/server/signercode.ts), and the signing screen, the help page and the security page quote them.

/** A one-time code has this many digits. */
export const SIGNER_CODE_DIGITS = 6;
/** A one-time code works for this many minutes after it was sent. */
export const SIGNER_CODE_MINUTES = 10;
/** After this many wrong tries a one-time code no longer works and a new one has to be asked for. */
export const SIGNER_CODE_TRIES = 5;
/** A device that typed the right code opens the document without another one for this many hours, counted by the server. */
export const SIGNER_PASS_HOURS = 24;
/** A new one-time code can be asked for this many seconds after the last one. */
export const SIGNER_CODE_WAIT_SECONDS = 60;
/** How many one-time codes one recipient can be sent in an hour. */
export const SIGNER_CODES_PER_HOUR = 5;
/**
 * How many one-time codes one device address can ask for in an hour for the documents of one sender and then not
 * type in. A code typed in correctly does not count, and another sender's documents are counted apart, because an
 * office behind one address can be signing a whole bulk send at once.
 */
export const SIGNER_CODES_PER_CALLER_HOUR = 100;
/** How many one-time codes one sender's documents can send to one mailbox or one phone number in a day (a public form counts on its own). */
export const SIGNER_CODES_PER_DESTINATION_DAY = 15;
/** How many texts with a signing link or a reminder can go to one phone number from one account in a day. */
export const LINK_TEXTS_PER_NUMBER_DAY = 4;

/**
 * The most text messages one account can cause in 24 hours: codes, signing links and reminders, every new one counted.
 * A text costs the operator money and customers are not charged for it, so this is a hard stop. 0 lets none through.
 */
export const smsDailyPerAccount = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number((env.SMS_DAILY_PER_ACCOUNT ?? '').trim() === '' ? NaN : env.SMS_DAILY_PER_ACCOUNT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
};

// ---- Reminders ---------------------------------------------------------------------------------------
// A new account starts with automatic reminders on: whoever has their turn and has not finished is emailed again
// every DEFAULT_REMINDER_DAYS days, until they finish or the deadline passes. The landing page promises reminders,
// and that has to be true without the sender finding a setting first. The choice is shown on the review step before
// every send, an admin changes the default under Settings, Account, and each recipient can stop the reminders to
// themselves. Accounts made before this default keep the number they had. Plain constants and functions with no
// environment in them, so a 'use client' file may import them.
export const DEFAULT_REMINDER_DAYS = 3;
/** The choices the review step offers. A number set elsewhere (the API, an older draft) is shown as it is. */
export const REMINDER_CHOICES: number[] = [0, 1, 2, 3, 5, 7, 14];
/** One choice, in words. */
export const reminderChoice = (days: number): string => (days <= 0 ? 'Never' : days === 1 ? 'Every day' : days === 7 ? 'Every week' : days === 14 ? 'Every two weeks' : `Every ${days} days`);
/** What a reminder setting means, in one sentence. The review step, the envelope page and Settings all print it. */
export const reminderText = (days: any): string => {
  const n = Math.max(0, Math.round(Number(days)) || 0);
  return n > 0
    ? `Automatic reminders are on: whoever has not finished is emailed again every ${n === 1 ? 'day' : `${n} days`}, until they finish or the deadline passes. Each person can stop the reminders to themselves.`
    : 'Automatic reminders are off: nobody is reminded unless you send a reminder yourself.';
};

// ---- Signing in person ---------------------------------------------------------------------------------
// Said wherever in-person signing is offered. There is no offline mode: the document is opened from the server, and
// the time and the internet address in the audit trail are taken by the server when Finish arrives.
export const IN_PERSON_ONLINE = 'It needs an internet connection from opening the document to pressing Finish. There is no offline mode.';

// ---- Bulk send: what it costs -------------------------------------------------------------------------
// "Bulk send is on every plan" is true of the feature and misleading about the price unless this is said with it.
// The server holds a batch to it (POST /bulk and POST /bulk/check in src/server/routes-envelopes.ts).
export const BULK_COST_NOTE = 'Each person who signs uses one signature, like on any envelope, and a batch only goes out when all of its signatures are already in your balance.';

// ---- Not for patient information ------------------------------------------------------------------------
// One statement, kept here once. /security prints it under "What this is not", the landing page under the pricing
// rules, and /help as a question. Nobody who wrote it is a lawyer: it says what does not exist here (an agreement
// nobody can sign with us, at any price), what that means for the people it matters to, and what would have to be
// true before it could change. It is deliberately not softened into "ask us", and there is no click-through
// agreement: one signed in a minute with nothing behind it is the false comfort the research complains about.
// Whoever can one day stand behind such an agreement changes the words here, and only here.
export const NO_BAA_TITLE = 'Not for patient information.';
export const NO_BAA_TEXT = 'There is no HIPAA business associate agreement (BAA) for Sign&Grow. Nobody can sign one with us, on any plan, at any price. HIPAA is the United States law on health information, and it asks a healthcare provider to have such an agreement with every service that handles patient information for them. So if you are a healthcare provider in the United States, or work for one, do not put protected health information through Sign&Grow: no patient intake forms, no consent forms that name a patient or a treatment, nothing else that says who a patient is together with anything about their health, their care or their bills.';
/** What would have to be true before that sentence could change. Every line is something that does not exist today. */
export const NO_BAA_FIRST: string[] = [
  'A business associate agreement written by a lawyer, signed by whoever runs this service.',
  'The same kind of agreement between them and every company that handles the data for them: the host of the server, and the mail provider that carries the emails and the signed PDFs attached to them.',
  'The database encrypted by the software itself, not only the stored files. Today the software can encrypt the files, when the people who run the server switch that on, and it never encrypts the database.',
  'A record of who opened which document, and a written way of telling you about a breach.',
];
export const NO_BAA_AFTER = 'None of that exists today, and this page will say so on the day it does. Rules about health information differ by country and by kind of document: outside the United States too, check what applies to you before you send anything about a person\'s health.';

// ---- Who can see your documents ---------------------------------------------------------------------
// The block of that name on /security, kept here once. Every line says what the code does, and where a line is a
// promise that code cannot keep by itself (what the people with the server's disk do with it, that nothing is sold)
// it says so in so many words. Before changing a line, find the code that makes it true:
//   the link         src/server/routes-sign.ts (every signing route is authorised by the token in the link alone)
//   members, admins  mine() in src/server/routes-envelopes.ts
//   the operator     GET /operator/queue in src/server/routes-trust.ts, forOperator() in src/server/routes-support.ts
//                    and the card lookup in the payment routes: no route there returns a document, a signed PDF, a
//                    signature, an answer or an audit trail
//   stored files     saveBlob() in src/server/db.ts encrypts them only when FILE_ENCRYPTION_KEY is set
//                    (src/server/filestore.ts), with the key in the server's settings; the database never
export const WHO_CAN_SEE: { who: string; what: string }[] = [
  { who: 'The people it was sent to, and anyone they pass their link to.',
    what: 'A signing link opens the document for whoever holds it. There is no login behind it, so forwarding the email, or sharing an inbox, shares the document. That is why a sender can put an access code on a document, which they give to the signer themselves and which is never in our email, or ask for a one-time code that is sent to the signer when they open the link. A recipient cannot open a document before their turn in a signing order. After it has been voided, declined or left to expire, only someone who already signed can still open the copy of what they signed.' },
  { who: 'The person who sent it.',
    what: 'They see the document, what each person filled in, the signatures, the audit trail, and whether each email left and each person opened it.' },
  { who: 'The owner and the admins of the sender\'s account.',
    what: 'On a team, the owner and every admin can open every envelope, template and bulk send of every member. A member sees only what they sent themselves, and every template. If you send from a team, its admins can read what you send.' },
  { who: 'The people who run this server.',
    what: 'Inside the app they work a queue of help requests and reports. There they see what somebody wrote to them. For a reported document they see its subject, the sender\'s message, the sender\'s name and address and who reported it. For an account they see its name, its age, its plan and whether it renews or ends and when, a free code it uses, its last payment, a card dispute, how many signatures it has left, the names and addresses of its owner and admins, and whether it is paused or marked as trusted. The queue has no screen and no function that opens a document, a signed PDF, a signature, an answer typed into a field or an audit trail. Outside the app it is different: the software adds no encryption of its own to the database, and the key to the stored files, where it encrypts them, is in the server\'s settings, so whoever has the disk, the database and the settings of the server can read everything on them. The rule for that is: only to answer a help request or a report about that document, or to repair the service, and never for anything else. That rule is a promise by the people who run the server. Software cannot enforce it.' },
  { who: 'The companies that carry it.',
    what: 'The host of the server, and the mail provider that delivers the emails with the signed PDF attached. Who they are on this server is listed under "Where your data is" on this page.' },
  { who: 'Nobody else.',
    what: 'These pages load no advertising and no tracking of any kind. No document, contact, name or address is sold or handed to an advertiser, a data broker, a parent company or a partner. Nothing you upload or sign is sent to an AI service or used to train one. The first and the last of these you can check in the code. That nothing is sold is a promise by the people who run this server.' },
];

// ---- Sending from a phone ----------------------------------------------------------------------------
// Photos of paper, staying signed in, and documents that are heavy for a phone. Plain numbers, no environment:
// the editor, Settings, /security and the server all quote them.

/** A picture with a longer side than this many pixels is made smaller in the browser before it is uploaded. On an A4 page that is about 170 dots per inch: small print stays readable, and a phone photo shrinks to a fraction of its size. */
export const PHOTO_MAX_SIDE = 2000;
/** How many pictures one upload can join into one document, a page for each. */
export const MAX_PHOTOS_PER_DOCUMENT = 50;
/** The most pixels a PNG can have. The server unpacks every pixel of a PNG to put it in a PDF, and a PNG of 300 KB can say it is 10,000 pixels square: that took 800 MB of memory when we tried. */
export const PNG_MAX_PIXELS = 25_000_000;
/** The most pixels a JPEG can have. The server does not unpack a JPEG, but every signer's phone does. A 50 megapixel phone photo fits. */
export const JPEG_MAX_PIXELS = 50_000_000;

/** A browser stays signed in for this many days after it was last used. Using the app moves the end forward. */
export const SESSION_DAYS = 30;
/**
 * However often it is used, a browser is signed out this many days after it signed in, and the person signs in
 * again. Without it a cookie copied off a device, used once a month from anywhere, stayed signed in for ever (a test
 * kept one alive for three years). The owner's decision of 2026-11-20. A session from before its sign-in time was
 * kept is no longer moved forward at all (src/server/auth.ts).
 */
export const SESSION_MAX_DAYS = 30;
/** How long a browser stays signed in, in the words /security and Settings print, from the two numbers above. */
export const sessionWords = (days = SESSION_DAYS, maxDays = SESSION_MAX_DAYS): string =>
  maxDays <= days
    ? `A browser is signed out ${maxDays} days after you signed in on it, however often you use it in between, and then you sign in again. That way a sign-in copied off a device, or left on a computer you no longer use, does not last.`
    : `A browser stays signed in while you use it: it is signed out ${days} days after you last used Sign&Grow in it, and in any case ${maxDays} days after you signed in on it, however often you use it. Then you sign in again. That way a sign-in copied off a device, or left on a computer you no longer use, does not last.`;
/** How often, at most, a browser's "last used" time is written down. Shown times are this exact, no more. */
export const SESSION_TOUCH_MINUTES = 60;
/** After this many wrong passwords on a device that was handed to a signer, that browser is signed out. */
export const HAND_OVER_TRIES = 5;
/** A stored document of at least this many bytes is pointed out to the sender as slow to open on a phone (phoneWeight() in src/lib/phone.ts). */
export const PHONE_SLOW_BYTES = 5_000_000;
/**
 * Seconds a phone needed for each megabyte of a document on the signing page over a slow mobile connection, measured
 * on 2026-11-20 in Chromium at 390 by 844 with Chrome's "Slow 4G" setting (1.6 megabits a second): 5 MB took 28.6
 * seconds, 10 MB 56.4, 20 MB 113.3. With "Fast 4G" (9 megabits) it was about 1.1 seconds a megabyte. The first page
 * was drawn within 0.3 seconds of the last byte: that day a signer waited for all of it before seeing page 1 (the
 * file is served without range requests). Not measured on a real phone.
 */
export const PHONE_SECONDS_PER_MB = 5.7;

// Signing groups: a recipient that is a group of people, any one of whom can act (src/server/groups.ts). The
// Contacts page, the editor, the help page and the server all quote these.

/** The fewest and the most people a group can have. One person is a recipient, not a group. */
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 20;
/** How many groups one account can keep. */
export const GROUPS_PER_ACCOUNT = 200;
/** How a group recipient works, in the words the Contacts page, the editor and the help page share. */
export const GROUP_RULE = 'Every member gets their own email with their own link. The first one who agrees to sign takes the document on, and the others are then told who has it. The record names the person who signed and the group. A group that signs uses one signature, like one person.';

// Two-step login with an authenticator app (src/server/twostep.ts). Settings, the sign-in page, /help and /security
// quote these, and the server enforces them from here.

/** Wrong codes in a row, at sign-in or when a code is asked for under Settings, before that login's second step pauses. */
export const TWO_STEP_TRIES = 5;
export const TWO_STEP_PAUSE_MINUTES = 15;
/** "Remember this device": that browser skips the second step of that one login for this many days from the day it was ticked. */
export const TWO_STEP_REMEMBER_DAYS = 30;
export const TWO_STEP_RECOVERY_CODES = 10;
/** A reset by email takes effect this many days after it was started from the emailed link. */
export const TWO_STEP_EMAIL_RESET_DAYS = 3;
/** How long the second screen waits for the code after the password, or after Google or Microsoft. */
export const TWO_STEP_SIGNIN_MINUTES = 10;
export const TWO_STEP_API_KEYS = 'API keys are not affected: a program that uses one is never asked for a code. Treat a key like a password, and revoke it under Settings, API and webhooks if it may have leaked.';
/** What someone who lost their phone and their recovery codes can do, in the words Settings and the sign-in screen share. */
export const TWO_STEP_LOST: string[] = [
  'On a team: an owner or an admin of the team can switch your second step off under Settings, Team. You are emailed at once, and it is written down who did it. Then you sign in with your password and set it up again.',
  `The owner of an account (nobody else can reset it for you): ask for a reset by email on the sign-in screen, after your password. Open the link we email you, and your second step is switched off ${TWO_STEP_EMAIL_RESET_DAYS} days later. We email you when it starts and every day until then. Signing in with your code or a recovery code stops it, and so does Stop under Settings in a browser where you are still signed in. The wait is there so that someone who has only got into your mailbox cannot get into your login quietly.`,
];

// Questions and comments on a document while it is out (src/server/comments.ts, src/server/routes-comments.ts). The
// signing page, the envelope page, /help and the server quote these, and the server enforces them from here.

/** The longest comment, in characters. */
export const COMMENT_MAX_CHARS = 2000;
/** How many comments one person can write on one envelope. Each person on the sender's side is counted apart. */
export const COMMENTS_PER_PERSON = 50;
/** How many comments one signing link can send in COMMENT_BURST_MINUTES. */
export const COMMENT_BURST = 10;
export const COMMENT_BURST_MINUTES = 10;
/** At most one email about new comments every this many minutes, for each person and envelope. Newer ones wait for the next. */
export const COMMENT_MAIL_MINUTES = 10;
/** What a comment is not, in the words every screen and email about comments uses. */
export const COMMENTS_NOT_SIGNED = 'Comments are not printed on the document and are not part of what is signed. The record of the document says that a comment was written, by whom and when, never what it says.';

// ---- Click-to-agree ----------------------------------------------------------------------------------
// An acceptance of click-to-agree terms is not a signature and costs none (src/server/clickwrap.ts). So that a page
// anyone can open cannot be used to fill our database or a mailbox, each account may record this many acceptances in
// a calendar month (UTC), counted over all its agreements. The admins are emailed at CLICKWRAP_WARN_PERCENT and again
// when it is reached. 0 records none.
export const clickwrapMonthlyLimit = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number((env.CLICKWRAP_MONTHLY_LIMIT ?? '').trim() === '' ? NaN : env.CLICKWRAP_MONTHLY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1000;
};
export const CLICKWRAP_WARN_PERCENT = 80;
/** Acceptances from one internet address in an hour, over every agreement, and on one agreement. */
export const CLICKWRAP_PER_ADDRESS_HOUR = 30;
export const CLICKWRAP_PER_ADDRESS_AGREEMENT_HOUR = 10;
