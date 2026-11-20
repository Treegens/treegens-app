// The words about help requests that emails and screens both use, so an email and a page never say different things
// about the same request. Nothing here reads the environment or the database, so 'use client' files may import it.
// The numbers (hours, days) come from src/lib/policy.ts through the server.
import { SUPPORT_REOPEN_DAYS } from './policy.ts';

export const TOPIC_LABEL: Record<string, string> = {
  signing: 'Signing a document',
  stuck: 'A document is stuck, or a deadline is near',
  sending: 'Sending documents',
  billing: 'Billing or a refund',
  'charged-wrongly': 'I was charged and should not have been',
  'cannot-log-in': 'I cannot log in',
  suspicious: 'Something looks suspicious',
  other: 'Something else',
};

/** How a request's state is named to the person who wrote it, and to the people who answer. */
export const STATUS_FOR_CUSTOMER: Record<string, string> = { open: 'Waiting for us', waiting: 'Waiting for you', answered: 'Answered', closed: 'Closed' };
export const STATUS_FOR_OPERATOR: Record<string, string> = { open: 'Waiting for us', waiting: 'Waiting for the customer', answered: 'Answered', closed: 'Closed' };

/** The customer is shown a first name only: "Maya is looking at this". */
export const firstName = (name?: string | null): string => String(name || '').trim().split(/\s+/)[0] || '';

const hoursText = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;

/** The published response time, in one place. The help page, the form and the README use these sentences. */
export const replyPromise = (hours: number, urgentHours: number): string =>
  `A person answers within ${hoursText(hours)}${urgentHours < hours ? `, and within ${hoursText(urgentHours)} when you cannot log in, were charged wrongly, or a document is stuck or a deadline is near` : ''}. These are real hours, counted from the moment you write: nights and weekends count too.`;

const zoneOk = (tz?: string | null): tz is string => {
  if (!tz || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** A time zone name a browser sent, or null when it is not one this server knows. */
export const knownZone = (tz: any): string | null => (typeof tz === 'string' && zoneOk(tz.slice(0, 64)) ? tz.slice(0, 64) : null);

/**
 * A moment the way a person says it: "Tuesday 24 November, 14:00".
 * In an email, pass the reader's time zone: the answer names it. Pass null when we do not know it: the time is then
 * given in UTC and says so. On a screen, pass nothing: the browser's own time zone is used and need not be named.
 */
export function whenText(iso: string, tz?: string | null): string {
  const zone = tz === undefined ? undefined : zoneOk(tz) ? tz : 'UTC';
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).formatToParts(new Date(iso))) p[x.type] = x.value;
  const text = `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
  if (zone === undefined) return text;
  return zoneOk(tz) ? `${text} (${zone.replace(/_/g, ' ')} time)` : `${text} UTC (we do not know your time zone, so this is UTC)`;
}

/** How long something took, in words: "40 minutes", "3 hours", "2 days". */
export function spanText(minutes: number): string {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const h = Math.round(minutes / 60);
  if (h < 48) return hoursText(h);
  return `${Math.round(h / 24)} days`;
}

/** What the customer is told about a request. The server builds it (forCustomer in routes-support.ts). */
export type CustomerRequest = {
  id?: string;
  reference: string;
  topic: string;
  status: string;
  priority: string;
  at: string;
  updated_at: string;
  owner: string | null;
  due_at: string | null;
  late: boolean;
  passed_on: boolean;
  closed_at: string | null;
  closed_how: string | null;
  reopen_until: string | null;
  follows: string | null;
  held: boolean;
  message?: string;
  can_reply?: boolean;
  thread: { from: 'you' | 'us'; kind: 'message' | 'question'; name: string | null; at: string; body: string }[] | null;
};

/**
 * Where a request stands, in a heading and a sentence or two, for the person who wrote it. `when` turns a time into
 * words for this reader (whenText with their time zone in an email, with nothing on a screen).
 */
export function standing(t: CustomerRequest, when: (iso: string) => string): { tone: '' | 'warn' | 'late'; title: string; text: string } {
  const who = t.owner || 'A person on our team';
  if (t.status === 'open' && t.late)
    return { tone: 'late', title: 'We are late with this. Sorry.',
      text: `We said a person would have answered by ${when(t.due_at!)}, and that has not happened. ${t.passed_on ? 'It has been passed to everyone on the support team and is at the top of their list' : 'It is being passed to everyone on the support team'}${t.owner ? `, and ${t.owner} still has it` : ''}. You do not need to write again.` };
  if (t.status === 'open')
    return { tone: '', title: t.owner ? `${t.owner} is looking at this` : 'Waiting for a person to pick this up',
      text: t.due_at ? `A person will have answered by ${when(t.due_at)}. The answer comes by email and is shown here.` : 'A person will read it and answer by email. The answer is shown here too.' };
  if (t.status === 'waiting')
    return { tone: 'warn', title: `${who} asked you a question`, text: 'We wait for your answer. The time we promised is paused until you reply.' };
  if (t.status === 'answered')
    return { tone: '', title: `${who} answered`, text: 'If that solved it, mark it as solved. If it did not, reply and the request is open again.' };
  const again = t.reopen_until && Date.parse(t.reopen_until) < Date.now()
    ? `It was closed more than ${SUPPORT_REOPEN_DAYS} days ago, so a reply now starts a new request that is linked to this one.`
    : t.reopen_until ? `Not solved after all? Reply before ${when(t.reopen_until)} and this same request opens again.` : 'Not solved after all? Reply and this request opens again.';
  if (t.closed_how === 'solved') return { tone: '', title: 'Solved', text: `You marked this as solved. ${again}` };
  if (t.closed_how === 'disowned') return { tone: '', title: 'Closed: you told us you did not write this', text: `Nothing more will be sent to you about it. Sorry for the bother. ${again}` };
  if (t.closed_how === 'spam') return { tone: 'warn', title: 'Closed: this did not look like it came from you', text: 'A person on our team looked at it and thought someone else had typed your address into our form, so it was closed without an answer. If you did write it, we are sorry: reply and it opens again.' };
  return { tone: '', title: 'Closed with an answer', text: again };
}
