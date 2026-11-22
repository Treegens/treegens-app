// Someone who signs for a person while they are away (src/server/delegation.ts). What the Settings card, the signing
// page, the emails and the certificate all say about it is here, so the server and the pages cannot disagree. Plain
// data in, words out.

/** The longest a delegation can run, in days, start and end included. A longer absence is set again later. */
export const DELEGATION_MAX_DAYS = 92;
/** How far ahead a delegation can start, in days. */
export const DELEGATION_AHEAD_DAYS = 365;

/** A day written year-month-day that exists on the calendar, or null. */
export function dayOf(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** Days from a to b, both written year-month-day. */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Today as year-month-day in a time zone (the person's own, else UTC). */
export function todayIn(tz?: string | null, at: Date = new Date()): string {
  try {
    if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {}
  return at.toISOString().slice(0, 10);
}

/** "3 March 2027", the way every line about a delegation writes a day. */
export function dayWords(day: string): string {
  const d = dayOf(day);
  if (!d) return String(day ?? '');
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "from 3 March 2027 to 14 March 2027", or "on 3 March 2027" for one day. */
export const datesWords = (from: string, to: string): string => (from === to ? `on ${dayWords(from)}` : `from ${dayWords(from)} to ${dayWords(to)}`);

/**
 * Why these dates cannot be saved, or null when they can. `today` is the person's own today. The end may not be
 * before the start or before today, the start not more than a year ahead, and the whole not longer than
 * DELEGATION_MAX_DAYS.
 */
export function datesProblem(from: unknown, to: unknown, today: string): string | null {
  const a = dayOf(from), b = dayOf(to);
  if (!a || !b) return 'Choose a first and a last day, each from the calendar or written year-month-day, like 2027-03-20.';
  if (b < a) return 'The last day is before the first day. Swap them, or choose again.';
  if (b < today) return 'Those days are over already. Choose days from today on.';
  if (daysBetween(today, a) > DELEGATION_AHEAD_DAYS) return `The first day can be at most a year from today. Set it nearer the time.`;
  if (daysBetween(a, b) + 1 > DELEGATION_MAX_DAYS) return `That is ${daysBetween(a, b) + 1} days. Someone can sign for you for up to ${DELEGATION_MAX_DAYS} days at a time; set it again when it ends.`;
  return null;
}

/** Said under the switch admins see in Settings, Team. */
export const SWITCH_TITLE = 'Let people name someone to sign for them while they are away';
export const SWITCH_HINT = 'Off until you turn it on. When it is on, each person in this account can name someone who signs for them on some days, in Settings, Away and sharing. A document sent from this account to them on those days also goes to that person, who signs with their own name and signature, for them. Someone sending to a person who is away is told so in the last step and can say that only that person may sign. Documents sent to many people at once, or straight from a template, are not asked.';

/** The card a person sees under Settings, Away and sharing. */
export const CARD_TITLE = 'Documents sent to me: someone signs for me while I am away';
export const CARD_HINT = (account: string) => `A document sent to you from ${account} on the days you choose also goes to the person you name here, unless its sender says only you may sign. Whoever of you agrees first takes it on. They sign with their own name and signature, for you, and the record says so. You are emailed when they do. Documents sent before the first day, documents from anyone else, and signing in person or as a witness stay with you only. It stops by itself after the last day.`;

/** For the sender, in step 3: the one choice there is about it. */
export const ONLY_NAMED = 'Only the person named may sign';
export const ONLY_NAMED_HINT = 'Tick this to send it to the people named here only.';

/** Step 3, above the box: who is away and who signs for them, one line each. */
export const awayLine = (p: { name: string; delegate: string; role?: string }): string =>
  `${p.name} is away and named ${p.delegate} to ${p.role === 'approver' ? 'approve' : 'sign'} for them. Tick the box so only ${p.name} may ${p.role === 'approver' ? 'approve' : 'sign'}.`;

/** "from 22 to 27 November 2026": shorter, for the Settings card, when the days share a month and a year. */
export function datesShort(from: string, to: string): string {
  if (from === to) return `on ${dayWords(from)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `from ${Number(from.slice(8))} to ${dayWords(to)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `from ${dayWords(from).replace(/ \d{4}$/, '')} to ${dayWords(to)}`;
  return datesWords(from, to);
}

/** The line on the certificate, and in the record, for a request a delegate took on. */
export function certLine(o: { delegate: string; person: string; setOn: string; from: string; to: string; product?: string }): string {
  const product = o.product || 'GrowSigning';
  const days = o.from === o.to ? dayWords(o.from) : `${dayWords(o.from)} to ${dayWords(o.to)}`;
  return `Signed by ${o.delegate} for ${o.person}, under a delegation ${o.person} set on ${dayWords(o.setOn.slice(0, 10))} for ${days}. ${product} does not know whether ${o.delegate} has the authority to sign for ${o.person}.`;
}

/** The same for an approver, who approves rather than signs. */
export const certLineFor = (role: string, o: Parameters<typeof certLine>[0]): string => (role === 'approver' ? certLine(o).replace(/^Signed by/, 'Approved by') : certLine(o));

/** The sender's line under a recipient (recipient.delegation on the envelope), or '' when no delegate is involved. */
export function senderLine(d: any, role: string): string {
  if (!d) return '';
  const verb = role === 'approver' ? 'approve' : 'sign';
  if (d.state === 'took') return ` · ${role === 'approver' ? 'Approving' : 'Signing'} for ${d.for_name}, who named them to ${verb} while away`;
  if (d.state === 'open') return ` · ${d.for_name} is away: ${d.name} (${d.email}) can also ${verb} for them ${d.dates}. Whoever agrees first takes it on.`;
  return '';
}
