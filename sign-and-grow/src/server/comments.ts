// Questions and comments on a document while it is out: who can read which thread, what each side is shown, and the
// threads in full for the sender's export and evidence pack. The routes, the limits and the emails are in
// routes-comments.ts. Nothing here is printed on the document or is part of what is signed (COMMENTS_NOT_SIGNED), and
// the audit trail only says that a comment was written, by whom and when.
//
// Who reads what. A thread is for everyone on the envelope, or private between the sender's side (the sender, the
// admins of the account, an API key) and one person on it. Someone on the envelope reads the threads for everyone and
// their own private ones, never another person's: not on the signing page, not in an email, not through any route.
// An in-person signer is a person on the envelope like any other, so the host's private threads with other people
// stay out of their sight on the host's own device (and the host's account is locked in that browser: handover.ts).
import { all, run } from './db.ts';
import { id, now } from './util.ts';
import { pinWords, type Pin } from '../lib/comments.ts';
import { COMMENTS_NOT_SIGNED } from '../lib/policy.ts';
import { stampText } from '../lib/dates.ts';

// Which person on a recipient row someone is. A private thread is with a person, not with a row: a row can pass to
// someone else (a hand-over, a correction to another address, another member of a group), and the next person must
// never read what the one before asked privately. person_gen goes up each time a row passes on (credits.ts). A member
// of a group is that member, also once they have taken the document on (claimed_by) and act as the row.
export const partyOf = (r: any): string => (r?.member ? `m:${r.member.id}` : r?.claimed_by ? `m:${r.claimed_by}` : `p:${Number(r?.person_gen) || 0}`);

// `hidden`: files this person is not shown ("Each person sees only their files", visibility.ts). A thread pinned to one
// of them is not theirs to read or answer, whoever it is for.
export type Viewer = { side: 'sender' } | { side: 'recipient'; rid: string; party: string; hidden?: Set<string> };
export const sees = (t: any, v: Viewer): boolean => v.side === 'sender' || (!(t.document_id && v.hidden?.has(t.document_id)) && (!t.private || (t.recipient_id === v.rid && t.party === v.party)));
const isMine = (c: any, v: Viewer) => v.side === 'recipient' && !c.by_sender && c.recipient_id === v.rid && c.party === v.party;
const at = (s: any) => stampText(s);

function pinOf(docs: any[], t: any): Pin | null {
  if (!t.document_id) return null;
  return { document_id: t.document_id, document: docs.find((d: any) => d.id === t.document_id)?.name || null, page: t.page ?? 0, x: t.x, y: t.y };
}

// The threads one side may read, oldest first, each with its comments. The sender's side also gets the address of
// whoever wrote, and for each comment who is to be emailed about it and what became of that ("news").
export function threadsOf(e: any, v: Viewer): any[] {
  const threads = all('SELECT * FROM comment_threads WHERE envelope_id=? ORDER BY at, rowid', e.id).filter((t) => sees(t, v));
  if (!threads.length) return [];
  const ids = new Set(threads.map((t) => t.id));
  const byThread = new Map<string, any[]>();
  for (const c of all('SELECT * FROM comments WHERE envelope_id=? ORDER BY at, rowid', e.id)) if (ids.has(c.thread_id)) byThread.set(c.thread_id, [...(byThread.get(c.thread_id) || []), c]);
  const news = v.side === 'sender' ? all('SELECT comment_id, audience, mailed_at, dropped FROM comment_news WHERE envelope_id=? ORDER BY id', e.id) : [];
  // The name behind each audience of an email, from what that person wrote or from the thread they were asked in.
  const names = new Map<string, string>();
  for (const t of threads) if (t.private && t.party_name) names.set(`${t.recipient_id}|${t.party}`, t.party_name);
  for (const list of byThread.values()) for (const c of list) if (!c.by_sender) names.set(`${c.recipient_id}|${c.party}`, c.name);
  // An envelope row from a list has no documents loaded: their names are read here, for the place a pin points at.
  const docs: any[] = e.documents || all('SELECT id, name FROM documents WHERE envelope_id=? ORDER BY position', e.id);
  return threads.map((t) => {
    const list = byThread.get(t.id) || [];
    const last = list[list.length - 1];
    const first = list[0];
    const pin = pinOf(docs, t);
    return {
      id: t.id, private: !!t.private,
      // Only the sender's side is told who a private thread is with: on a signing page it is always that person.
      with: v.side === 'sender' && t.private ? { recipient_id: t.recipient_id, name: t.party_name } : null,
      pin, pin_words: pinWords(pin, docs.length),
      started_by: first?.by_sender ? 'sender' : 'recipient', mine: !!first && isMine(first, v),
      settled_at: t.settled_at || null, settled_by: t.settled_by || null,
      // Waiting for an answer from the sender's side: the last word is from someone on the envelope.
      waiting: !t.settled_at && !!last && !last.by_sender,
      comments: list.map((c) => ({
        id: c.id, by_sender: !!c.by_sender, name: c.name, body: c.body, at: c.at,
        ...(v.side === 'sender'
          ? { email: c.email || null, recipient_id: c.recipient_id || null,
              news: news.filter((n) => n.comment_id === c.id).map((n) => ({ to: n.audience === 'sender' ? 'sender' : names.get(n.audience) || 'someone on the envelope', mailed_at: n.mailed_at || null, not_emailed: n.dropped || null })) }
          : { mine: isMine(c, v) }),
      })),
    };
  });
}

export function newThread(e: any, o: { private: boolean; recipient_id?: string | null; party?: string | null; party_name?: string | null; pin?: Pin | null }): string {
  const tid = id('thr');
  run('INSERT INTO comment_threads (id, envelope_id, private, recipient_id, party, party_name, document_id, page, x, y, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    tid, e.id, o.private ? 1 : 0, o.private ? o.recipient_id : null, o.private ? o.party : null, o.private ? o.party_name : null,
    o.pin?.document_id ?? null, o.pin ? o.pin.page : null, o.pin?.x ?? null, o.pin?.y ?? null, now());
  return tid;
}

export function newComment(e: any, threadId: string, o: { by_sender: boolean; author: string; recipient_id?: string | null; party?: string | null; name: string; email?: string | null; body: string }): any {
  const row = { id: id('cmt'), thread_id: threadId, envelope_id: e.id, by_sender: o.by_sender ? 1 : 0, author: o.author, recipient_id: o.recipient_id ?? null, party: o.party ?? null, name: o.name, email: o.email ?? null, body: o.body, at: now() };
  run('INSERT INTO comments (id, thread_id, envelope_id, by_sender, author, recipient_id, party, name, email, body, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.thread_id, row.envelope_id, row.by_sender, row.author, row.recipient_id, row.party, row.name, row.email, row.body, row.at);
  // A new word in a settled thread opens it again: somebody has something more to say.
  run('UPDATE comment_threads SET settled_at=NULL, settled_by=NULL WHERE id=?', threadId);
  return row;
}

// Every thread in full, for the sender's export and evidence pack. Empty when nobody wrote anything.
export function commentsText(e: any): string {
  const threads = threadsOf(e, { side: 'sender' });
  if (!threads.length) return '';
  return [
    `Questions and comments on "${e.subject}" (envelope ${e.id}), as stored on ${at(now())}.`, COMMENTS_NOT_SIGNED, '',
    ...threads.flatMap((t, i) => [
      `Thread ${i + 1}: ${t.private ? `private between the sender's side and ${t.with?.name || 'one person on the envelope'}` : 'for everyone on the envelope'}${t.pin_words ? `, about ${t.pin_words}` : ''}.${t.settled_at ? ` Marked as settled on ${at(t.settled_at)} by ${t.settled_by}.` : t.waiting ? ' Waiting for an answer.' : ''}`,
      ...t.comments.flatMap((c: any) => [`  ${at(c.at)}  ${c.name}${c.email ? ` <${c.email}>` : ''}${c.by_sender ? ' (sender\'s side)' : ''}`, ...String(c.body).split('\n').map((l) => `    ${l}`)]),
      '',
    ]),
  ].join('\r\n');
}
