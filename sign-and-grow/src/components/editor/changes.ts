// Correcting an envelope that is already out: works out, before anything is saved, what the server will do for each
// person, and keeps the editor honest when signers act while the sender is still editing.
// These functions mirror correctEnvelope() and advance() in src/server/envelopes.ts. Plain data in, plain data out.
import { ownOutcome } from '../../lib/bysender.ts';
import { logicKey } from '../../lib/logic.ts';

export type Content = { ordered?: any; date_format?: any; documents: any[]; recipients: any[]; fields: any[] };

export type OutcomeKind = 'finished' | 'sign_again' | 'copy_sent' | 'unchanged' | 'updated' | 'new_link' | 'held' | 'invited' | 'waiting' | 'removed';
export type Outcome = { id: string; name: string; email: string; role: string; kind: OutcomeKind; badge: string; text: string };

const r6 = (n: any) => Math.round((Number(n) || 0) * 1e6);
const s = (v: any) => (v == null ? '' : String(v));
const lower = (v: any) => s(v).trim().toLowerCase();
const req = (f: any) => (f.required === false || f.required === 0 ? 0 : 1);
const order = (r: any) => (Number.isFinite(Number(r.routing_order)) ? Math.min(99, Math.max(1, Math.round(Number(r.routing_order)))) : 1);
const byFirst = (a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
// Values of these types are written by the sender. Everything else (signatures, initials, attachments, automatic
// fields) is only ever filled in by the signer, and the server keeps what is there.
const SENDER_VALUE = ['text', 'number', 'date', 'company', 'title', 'note', 'checkbox', 'radio', 'dropdown'];

/** People who have finished: signers, approvers and viewers. What they signed only changes if they sign again. */
export const finished = (recipients: any[]) => recipients.filter((r) => r.status === 'completed' && r.role !== 'cc');

const has = (v: any) => v != null && v !== '';

// The sender's own wording in a field, as the server keeps it once the editor's state is saved over `base`: a note,
// a read-only value, or the value a signer's field starts out with. An answer a signer typed is never the sender's.
// Mirrors writeContent() and senderText() on the server.
function wording(base: Content): (f: any) => string {
  const was = new Map<string, any>(base.fields.map((f) => [f.id, f]));
  const done = new Set<string>(finished(base.recipients).map((r) => r.id));
  return (f) => {
    const old = was.get(f.id);
    const mine = SENDER_VALUE.includes(f.type);
    const owned = f.type === 'note' || !!(old ? old.readonly : f.readonly);
    // What a finished person left in their field is their answer, also where they emptied a line or unticked a box
    // the sender had filled in. The server never puts the sender's value back there.
    const answered = !!old && !owned && (old.value ?? null) !== (old.prefill ?? null) && (done.has(old.recipient_id) || has(old.value));
    const value = answered ? s(old.value) : mine ? s(f.value) : old ? s(old.value) : '';
    if (f.readonly || f.type === 'note') return value;
    if (answered) return s(old.prefill);
    return mine ? value || (old && !has(old.value) ? s(old.prefill) : '') : '';
  };
}

// A full name field and an email field print the name and the address the sender gave their owner. Those are words
// on the page like any other the sender wrote. Mirrors printedWords() on the server.
function printedWords(x: Content, text: (f: any) => string): (f: any) => string {
  const who = new Map<string, any>(x.recipients.map((r) => [r.id, r]));
  return (f) => (f.type === 'full_name' ? s(who.get(f.recipient_id)?.name).trim() : f.type === 'email' ? s(who.get(f.recipient_id)?.email).trim() : text(f));
}

// What one person is asked to read and fill in. If this changes while they have the document, they are told. They
// are shown what the sender wrote in other people's fields too, so that counts as well, and so does their own name:
// the screen asks them to sign under it.
function askView(x: Content, recipientId: string, text: (f: any) => string): string {
  const words = printedWords(x, text);
  return JSON.stringify({
    docs: x.documents.map((d) => [d.file_id, s(d.name)]),
    me: s(x.recipients.find((r) => r.id === recipientId)?.name).trim(),
    fields: x.fields.filter((f) => !f.recipient_id || f.recipient_id === recipientId)
      .map((f) => [f.id, f.document_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), req(f), s(f.label), words(f), logicKey(f)]).sort(byFirst),
    words: x.fields.filter((f) => f.recipient_id && f.recipient_id !== recipientId && words(f))
      .map((f) => [f.id, f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), words(f)]).sort(byFirst),
  });
}

// What is printed on the pages whoever fills them in: the files in their order, where every field sits and whose it
// is, the sender's own wording (names and addresses printed by a field included), and how dates are written. Once
// someone has finished, a change to any of it is only saved if the sender chooses to ask them to sign again.
// Mirrors printedView() on the server.
function printedView(x: Content, text: (f: any) => string, dates: string): string {
  const words = printedWords(x, text);
  return JSON.stringify({
    docs: x.documents.map((d) => [d.id, d.file_id]),
    dates,
    // logicKey: when a field is shown and what it is worked out from are part of what the page says (src/lib/logic.ts).
    fields: x.fields.map((f) => [f.id, f.document_id, f.recipient_id || null, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.readonly || f.type === 'note' ? 1 : 0, words(f), logicKey(f)]).sort(byFirst),
  });
}

/**
 * The people who have finished and would have to sign again if `after` were saved: everyone who finished when what
 * is printed changes, and anyone who finished and is themselves changed or removed. Empty when nobody has to.
 */
export function signsAgain(before: Content, after: Content): any[] {
  const done = finished(before.recipients);
  if (!done.length) return [];
  const text = wording(before);
  // A state that says nothing about the date format leaves it as it is, like a request without one does.
  const was = s((before as any).date_format), now = (after as any).date_format;
  const printed = printedView(before, text, was) !== printedView(after, text, now ? s(now) : was);
  return done.filter((o) => {
    const n = after.recipients.find((r) => r.id === o.id);
    return printed || !n || n.role !== o.role || s(n.name).trim() !== s(o.name) || lower(n.email) !== lower(o.email) || order(n) !== order(o);
  });
}

/** True when saving `after` touches what finished people signed, so it is only saved if they are asked to sign again. */
export const touchesLocked = (before: Content, after: Content) => signsAgain(before, after).length > 0;

/**
 * What happens to each person when the correction is saved, in the order they appear in the editor, followed by
 * anyone who was removed. `completes` is true when nobody is left to act, so saving finishes the envelope.
 */
export function outcomes(before: Content, after: Content): { people: Outcome[]; completes: boolean } {
  const old = new Map<string, any>(before.recipients.map((r) => [r.id, r]));
  const status = new Map<string, string>();
  const kind = new Map<string, OutcomeKind>();
  const text = wording(before);
  const again = new Set<string>(signsAgain(before, after).map((r) => r.id));
  for (const r of after.recipients) {
    const o = old.get(r.id);
    const other = !!o && (lower(o.email) !== lower(r.email) || o.role !== r.role);
    if (!o) (kind.set(r.id, 'invited'), status.set(r.id, 'pending'));
    else if (again.has(r.id)) (kind.set(r.id, 'sign_again'), status.set(r.id, 'pending'));
    else if (o.status === 'completed' && o.role === 'cc' && other) (kind.set(r.id, 'new_link'), status.set(r.id, 'pending'));
    else if (o.status === 'completed') (kind.set(r.id, o.role === 'cc' ? 'copy_sent' : 'finished'), status.set(r.id, 'completed'));
    else if (o.status === 'pending') (kind.set(r.id, 'waiting'), status.set(r.id, 'pending'));
    else if (other) (kind.set(r.id, 'new_link'), status.set(r.id, 'pending'));
    else (kind.set(r.id, askView(before, r.id, text) !== askView(after, r.id, text) ? 'updated' : 'unchanged'), status.set(r.id, o.status));
  }
  // The signing order holds for people who already have the document too. Anyone who is now behind a person who has
  // not finished gives the turn back. Same rule as outOfTurn() on the server.
  if (after.ordered) {
    const waiting = after.recipients.filter((r) => status.get(r.id) !== 'completed' && r.role !== 'cc');
    const turn = Math.min(...waiting.map(order));
    for (const r of waiting) if ((status.get(r.id) === 'sent' || status.get(r.id) === 'viewed') && order(r) > turn) (kind.set(r.id, 'held'), status.set(r.id, 'pending'));
  }

  // Who is asked right away. Same walk as advance() on the server: the lowest open routing order goes first, and
  // people who only receive a copy never hold anyone up.
  const asked = new Set<string>();
  let completes = false;
  for (let guard = 0; guard < 200; guard++) {
    const open = after.recipients.filter((r) => status.get(r.id) !== 'completed');
    if (!open.length) {
      completes = after.recipients.length > 0;
      break;
    }
    const turn = after.ordered ? Math.min(...open.map(order)) : null;
    const next = open.filter((r) => status.get(r.id) === 'pending' && (turn === null || order(r) === turn));
    if (!next.length) break;
    let copied = false;
    for (const r of next) {
      asked.add(r.id);
      if (r.role === 'cc') (status.set(r.id, 'completed'), (copied = true));
      else status.set(r.id, 'sent');
    }
    if (!copied) break;
  }

  const people: Outcome[] = after.recipients.map((r) => {
    const k = kind.get(r.id)!;
    const o = old.get(r.id);
    const now = asked.has(r.id);
    const host = r.role === 'inperson';
    const copy = r.role === 'cc';
    let badge = 'No change';
    let text = 'Nothing changes for them. They keep the same link.';
    if (k === 'finished') (badge = 'Finished'), (text = 'Already finished. Nothing changes for them.');
    else if (k === 'sign_again') {
      const did = r.role === 'approver' ? 'approved' : r.role === 'viewer' ? 'viewed' : 'signed';
      const redo = r.role === 'approver' ? 'approve' : r.role === 'viewer' ? 'confirm' : 'sign';
      badge = r.role === 'approver' ? 'Approves again' : r.role === 'viewer' ? 'Looks again' : 'Signs again';
      text = `Already ${did}. This change touches what they ${did}, so ${host ? 'you get an email' : 'they get an email'} ${now ? 'now' : 'when it is their turn'} that says what changed and asks them to ${redo} again. What they ${did} the first time stays on record.`;
    } else if (k === 'held') (badge = 'Waits again'), (text = host ? 'Someone before them in the signing order has not finished, so their turn is taken back. What they filled in is kept.' : 'Someone before them in the signing order has not finished, so their turn is taken back. They get an email that says so, and another when it is their turn. What they filled in is kept.');
    else if (k === 'copy_sent') (badge = 'Has a copy'), (text = 'Already has their copy. Nothing more is sent now.');
    else if (k === 'updated') (badge = 'Told it changed'), (text = host ? 'Keeps the same link. You get an email saying the document changed.' : 'Keeps the same link and gets an email saying the document changed.');
    else if (k === 'new_link') {
      badge = 'New link';
      text = now
        ? host ? 'You get a new link to host their signing. The old link stops working.' : copy ? 'Gets a copy by email now. The old link stops working.' : 'Gets a new link by email now. The old link stops working.'
        : 'The old link stops working. They get a new one when it is their turn.';
    } else if (k === 'invited') {
      badge = 'New';
      text = now ? (copy ? 'Is added and gets a copy by email now.' : host ? 'Is added. You get a link to host their signing now.' : 'Is added and invited by email now.') : 'Is added. They are invited when it is their turn.';
    } else if (k === 'waiting') {
      badge = now ? 'Their turn' : 'Not asked yet';
      text = now ? (copy ? 'It is now their turn, so their copy goes out by email.' : 'It is now their turn, so they are invited by email.') : 'Has not been asked yet. Nothing is sent until it is their turn.';
    }
    // Someone whose link the sender sends themselves gets no email: their sentence says so (editor/SendMyself.tsx).
    const own = r.link_by_sender && !s(r.email) ? ownOutcome(k, now, r.role) : null;
    return { id: r.id, name: s(r.name) || s(r.role_name) || 'Unnamed', email: s(r.email), role: r.role, kind: k, badge, text: own || text };
  });
  for (const o of before.recipients) {
    if (after.recipients.some((r) => r.id === o.id)) continue;
    const text = o.status === 'pending' ? 'Is removed. They had not been asked yet, so no email is sent.'
      : o.status === 'completed' && o.role !== 'cc' ? 'Is removed. What they signed is set aside and kept on record, and they get an email saying they are no longer on the document.'
      : o.status === 'completed' ? 'Is removed. The link they have stops working.'
      : o.role === 'inperson' ? 'Is removed. The link to host their signing stops working.'
      : 'Is removed and gets an email saying they are no longer needed. Their link stops working.';
    people.push({ id: o.id, name: s(o.name) || 'Unnamed', email: s(o.email), role: o.role, kind: 'removed', badge: 'Removed', text });
  }
  return { people, completes };
}

// ---- Keeping up with signers who act while the sender is editing ------------------------------------------------

const PERSON_KEYS = ['name', 'email', 'role', 'role_name', 'routing_order', 'access_code', 'note', 'verify', 'phone', 'text_link'];
const SERVER_KEYS = ['status', 'sent_at', 'viewed_at', 'completed_at', 'consent_at', 'decline_reason', 'reassigned_from', 'muted', 'has_signature'];
const same = (a: any, b: any) => s(a) === s(b);

/** Field values the server has now, wherever the sender did not type something different themselves. */
export function freshValues(base: Content, fresh: Content, fields: any[]): any[] {
  const was = new Map<string, any>(base.fields.map((f) => [f.id, f]));
  const now = new Map<string, any>(fresh.fields.map((f) => [f.id, f]));
  return fields.map((f) => {
    const b = was.get(f.id), n = now.get(f.id);
    return b && n && same(f.value, b.value) && !same(f.value, n.value) ? { ...f, value: n.value } : f;
  });
}

/**
 * Brings the editor's copy up to date with the server without losing the sender's edits. `base` is what the editor
 * loaded, `fresh` is the envelope as it is now, `mine` is the editor's state. Anything the sender did not touch
 * takes the server's value (a signer may have typed into a field, finished, or passed the document to a colleague).
 * `conflict` names the people who finished meanwhile if the sender also changed their part.
 */
export function rebase(base: Content, fresh: Content, mine: Content): { recipients: any[]; fields: any[]; conflict: string[] } {
  const was = new Map<string, any>(base.recipients.map((r) => [r.id, r]));
  const now = new Map<string, any>(fresh.recipients.map((r) => [r.id, r]));
  const recipients = mine.recipients.map((r) => {
    const b = was.get(r.id), n = now.get(r.id);
    if (!b || !n) return r;
    const out = { ...r };
    for (const k of PERSON_KEYS) if (same(r[k], b[k])) out[k] = n[k];
    for (const k of SERVER_KEYS) out[k] = n[k];
    return out;
  });
  const fields = freshValues(base, fresh, mine.fields);
  const merged = { ...mine, recipients, fields };
  // Only people who finished after the editor was opened are a surprise. Saving a change that touches what they
  // signed would mean asking them to sign again, so the sender is told before anything is sent.
  const already = new Set(finished(base.recipients).map((r) => r.id));
  const conflict = signsAgain(fresh, merged).filter((r) => !already.has(r.id)).map((r) => s(r.name) || 'Someone');
  return { recipients, fields, conflict };
}

/**
 * Puts back everything finished people signed exactly as the server has it: the documents, the fields on them, the
 * sender's wording and the finished people themselves. The sender's other changes are kept: names, addresses and
 * the order of the people who have not finished, people added without fields, and what a field asks of its signer
 * (label, required, choices). Anyone the sender removed who still has fields on the pages stays, with those fields.
 */
export function restoreLocked(fresh: Content, mine: Content): Content {
  const done = new Set(finished(fresh.recipients).map((r) => r.id));
  const names = new Map<string, any>(mine.documents.map((d) => [d.id, d.name]));
  const documents = fresh.documents.map((d) => ({ ...d, name: names.get(d.id) || d.name }));
  const kept = mine.recipients.filter((r) => !done.has(r.id));
  const there = new Set(kept.map((r) => r.id));
  const needed = fresh.recipients.filter((r) => !done.has(r.id) && !there.has(r.id) && fresh.fields.some((f) => f.recipient_id === r.id));
  const recipients = [...fresh.recipients.filter((r) => done.has(r.id)), ...kept, ...needed];
  const asked = new Map<string, any>(mine.fields.map((f) => [f.id, f]));
  const fields = fresh.fields.map((f) => {
    const m = asked.get(f.id);
    return m && !done.has(f.recipient_id) && f.type !== 'note' ? { ...f, label: m.label, required: m.required, options: m.options, group_name: m.group_name, validation: m.validation } : f;
  });
  return { ordered: mine.ordered, documents, recipients, fields, ...((fresh as any).date_format ? { date_format: (fresh as any).date_format } : {}) } as Content;
}

/** A canonical string of everything the editor can change. Two envelopes with the same fingerprint save the same. */
export function fingerprint(e: { subject?: any; message?: any; ordered?: any; reminder_days?: any; date_format?: any }, c: Content): string {
  return JSON.stringify([
    s(e.subject), s(e.message), e.ordered ? 1 : 0, Number(e.reminder_days) || 0, s(e.date_format),
    c.documents.map((d) => [d.id, d.file_id, s(d.name)]),
    // The check before the document opens is part of what a correction saves: "none" and nothing are the same.
    // A signing group and who is in it on this envelope are part of it too (editor/GroupRecipient.tsx).
    c.recipients.map((r) => [r.id, r.role, s(r.role_name), s(r.name).trim(), s(r.email).trim(), order(r), s(r.access_code).trim(), s(r.note), s(r.verify) || 'none', s(r.phone).trim(), r.text_link ? 1 : 0,
      s(r.group_id), ((r as any).members || []).map((m: any) => `${s(m.name).trim()}<${s(m.email).trim().toLowerCase()}>`).join(','),
      // The language of our screens for this person (editor/RecipientLanguage.tsx): changing it alone is a change to save.
      s((r as any).locale)]),
    c.fields.map((f) => [f.id, f.document_id, f.recipient_id || '', f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), req(f), s(f.label), s(f.value),
      (f.options || []).join('\n'), s(f.group_name), s(f.validation), f.readonly || f.type === 'note' ? 1 : 0]).sort(byFirst),
  ]);
}
