// The email that asks someone to sign, approve or look (a request, a reminder, "expires soon", "updated", "reopened",
// "changed after you finished", a fresh link), in the reader's language when it is not English (lang-mail). The words
// are in src/locales/en.json under "mail.request.*"; notifyRecipient in envelopes.ts gathers the facts and writes the
// English email itself, as it always has. tests/ds-lang-mail.test.ts holds the two to the same English, word for word,
// so a change to one without the other is caught.
//
// Only the plain roles are written here: someone who signs, approves, views or gets a copy, by themselves. An email to
// a witness, to the host of an in-person signing or to a member of a group, and one that carries what changed in our
// English words (last_change), stays in English as a whole: translatable() says so. An email is never half translated.
import { mt, theirWords } from './maillang.ts';
import { momentOnScreen, stampText } from '../lib/dates.ts';
import { SOURCE_LOCALE } from '../lib/i18n.ts';
import { changerWords } from '../lib/recipienttypes.ts';

export type RequestFacts = {
  kind: 'new' | 'reminder' | 'updated' | 'reopened' | 'expiring' | 'resent' | 'again' | 'resumed';
  role: string;
  name: string;
  sender: { name: string; email: string };
  subject: string;
  message?: string | null;
  note?: string | null;
  accessCode: boolean;
  shared: boolean;
  /** The person has finished and asked for their link again. */
  done: boolean;
  /** The whole envelope is complete. */
  complete: boolean;
  /** When the request closes, as an ISO moment, or '' for none or not shown. */
  deadline: string;
  tz?: string | null;
  /** Their own device has told this document its zone, so the deadline is in their time already. */
  zoneKnown: boolean;
  /** When they finished the first time, for "again". */
  before?: string | null;
  /** The person who "Can change the document" made the change, for "again" and "updated" (agents.ts). */
  changer?: string | null;
  /** The changer is someone else who signs, who changed a field anyone on the document can fill in (collab.ts). */
  cosigner?: boolean;
  /** Everything is filled in and only Finish is left (a reminder says so). */
  ready: boolean;
  /** Trees planted when they finish (5), 0 for none. */
  trees: number;
  url: string;
};

const PLAIN = new Set(['signer', 'approver', 'viewer', 'cc']);
/** Whether this email can be written here in `locale`: see the top of this file. English is always written by envelopes.ts. */
export const translatable = (locale: string, r: any, lastChange?: string | null): boolean =>
  locale !== SOURCE_LOCALE && PLAIN.has(r?.role) && !r?.member && !r?.group_name && !r?.link_by_sender && !lastChange;

const how = (role: string): 'signed' | 'approved' | 'viewed' => (role === 'signer' ? 'signed' : role === 'approver' ? 'approved' : 'viewed');

/** The subject, heading, lines, button and footnote of the email, in `L`. */
export function requestMail(L: string, f: RequestFacts) {
  const fh = how(f.role);
  const when = (iso: string | null | undefined) => momentOnScreen(iso, L, f.tz);
  // When they finished the first time is said as the record says it (in UTC), in English; else the language's own way.
  const first = /^en(-|$)/.test(L) ? stampText(f.before) : momentOnScreen(f.before, L);
  const deadline = f.deadline ? when(f.deadline) : '';
  const s = f.sender.name;
  // Who changed it: the editor, said with who asked them (changerWords), or else the sender.
  const by = changerWords(f.changer, s, f.cosigner);
  const subjectUnder = (f.role === 'signer' || f.role === 'viewer') && f.kind !== 'again' && !f.done;
  const subject = {
    new: mt(L, 'mail.request.subject.new', { subject: f.subject }),
    resent: mt(L, 'mail.request.subject.new', { subject: f.subject }),
    reminder: mt(L, 'mail.request.subject.reminder', { subject: f.subject }),
    updated: mt(L, 'mail.request.subject.updated', { subject: f.subject }),
    reopened: mt(L, 'mail.request.subject.reopened', { subject: f.subject }),
    resumed: mt(L, 'mail.request.subject.resumed', { subject: f.subject }),
    expiring: mt(L, 'mail.request.subject.expiring', { subject: f.subject }),
    again: mt(L, 'mail.request.subject.again', { subject: f.subject }),
  }[f.kind];
  const bare = f.kind === 'again'
    ? { signed: mt(L, 'mail.request.heading.again.signed', { sender: f.changer || s }), approved: mt(L, 'mail.request.heading.again.approved', { sender: f.changer || s }), viewed: mt(L, 'mail.request.heading.again.viewed', { sender: f.changer || s }) }[fh]
    : f.done ? mt(L, 'mail.request.heading.done', { subject: f.subject })
      : f.role === 'signer' ? mt(L, 'mail.request.heading.signer', { sender: s })
        : f.role === 'viewer' ? mt(L, 'mail.request.heading.viewer', { sender: s })
          : f.role === 'approver' ? mt(L, 'mail.request.heading.approver', { sender: s, subject: f.subject })
            : mt(L, 'mail.request.heading.cc', { sender: s, subject: f.subject });
  const heading = f.shared ? mt(L, 'mail.request.for_name', { name: f.name, heading: bare }) : bare;
  const lines: string[] = [
    ...(subjectUnder ? [f.subject] : []),
    ...(f.shared ? [mt(L, 'mail.request.shared', { name: f.name })] : []),
    ...((f.kind === 'new' || f.kind === 'reminder') && f.trees >= 1 ? [mt(L, 'mail.request.trees', { count: f.trees })] : []),
    ...(f.kind === 'again' ? [
      { signed: mt(L, 'mail.request.again.signed', { subject: f.subject, when: first, sender: by }), approved: mt(L, 'mail.request.again.approved', { subject: f.subject, when: first, sender: by }), viewed: mt(L, 'mail.request.again.viewed', { subject: f.subject, when: first, sender: by }) }[fh],
      f.role === 'approver' ? mt(L, 'mail.request.again.look.approve', { sender: s }) : mt(L, 'mail.request.again.look.sign', { sender: s }),
    ] : []),
    ...(f.kind === 'updated' ? [f.changer ? mt(L, 'mail.request.updated_by', { changer: by }) : mt(L, 'mail.request.updated', { sender: s })] : []),
    ...(f.kind === 'reopened' ? [mt(L, 'mail.request.reopened', { sender: s })] : []),
    ...(f.kind === 'resumed' ? [mt(L, 'mail.request.resumed', { sender: s })] : []),
    ...(f.kind === 'expiring' ? [mt(L, 'mail.request.expiring', { when: deadline, sender: s })] : []),
    ...(f.kind === 'resent' ? [mt(L, 'mail.request.resent')] : []),
    ...(f.done ? [f.complete
      ? { signed: mt(L, 'mail.request.done.all.signed'), approved: mt(L, 'mail.request.done.all.approved'), viewed: mt(L, 'mail.request.done.all.viewed') }[fh]
      : { signed: mt(L, 'mail.request.done.wait.signed'), approved: mt(L, 'mail.request.done.wait.approved'), viewed: mt(L, 'mail.request.done.wait.viewed') }[fh]] : []),
    ...(f.kind === 'reminder' && f.ready ? [mt(L, 'mail.request.ready', { sender: s })] : []),
    ...(f.message ? [theirWords(L, s, f.message)] : []),
    ...(f.note ? [mt(L, 'mail.request.note', { note: f.note })] : []),
    ...(f.accessCode ? [mt(L, 'mail.request.access_code', { sender: s })] : []),
    mt(L, 'mail.request.reply', { sender: s, email: f.sender.email }),
  ];
  const label = f.done ? (f.complete ? mt(L, 'mail.request.button.completed') : mt(L, 'mail.request.button.view'))
    : f.role === 'cc' || f.role === 'viewer' ? mt(L, 'mail.request.button.view')
      : f.role === 'approver' ? (f.kind === 'again' ? mt(L, 'mail.request.button.approve_again') : mt(L, 'mail.request.button.approve'))
        : f.kind === 'again' ? mt(L, 'mail.request.button.sign_again') : mt(L, 'mail.request.button.sign');
  const footnote = [
    deadline && f.kind !== 'expiring' ? `${mt(L, 'mail.request.open_until', { when: deadline })}${f.zoneKnown ? '' : ` ${mt(L, 'mail.request.own_time')}`}` : '',
    f.kind === 'reminder' ? mt(L, 'mail.request.mute', { url: `${f.url}?mute=1` }) : '',
  ].filter(Boolean).join(' ') || undefined;
  return { subject, heading, lines, cta: { label, url: f.url }, footnote };
}
