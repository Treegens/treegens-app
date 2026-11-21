// The rules of the document page (/app/envelopes/:id) that are worth testing without a browser: which one main
// button a state gets, the one status sentence, what the page's More holds and in which order, and which lines of
// the record are left off the page. The page (src/app/app/envelopes/[id]/page.tsx) draws what these return.
// Nothing here talks to the server, so the tests read it directly (tests/simplify-envelope.test.ts).
// research/ux-charter.md, section 2.5, is where these rules come from.

/** The most lines the page's More may hold in its busiest state (charter P4). */
export const PAGE_MORE_CAP = 9;
/** The most lines one person's More may hold with zero setup (charter P4). */
export const PERSON_MORE_CAP = 6;

export type PagePerson = {
  id: string; name: string; role: string; status: string;
  /** It is their turn: the document is out and they have it. */
  turn: boolean;
  /** This person is the sender who is looking at the page. */
  me: boolean;
  /** A reminder email would really go to them: an address, reminders not turned off, emails to them not stopped. */
  remindable: boolean;
};

export type MainKind = 'restore' | 'continue' | 'sign' | 'host' | 'remind' | 'download' | 'reopen' | 'copy_fix' | 'copy';
export type MainButton = { kind: MainKind; label: string; personId?: string };

const VERB: Record<string, string> = { signer: 'sign', inperson: 'sign', approver: 'approve', viewer: 'view', cc: 'view', witness: 'witness' };
const NOW: Record<string, string> = { signer: 'Sign now', approver: 'Review now', viewer: 'View now', witness: 'Sign now' };

export const joinNames = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

/** "Remind Ana Silva": the button says who it writes to. Three or more are counted, so the button stays short. */
export function remindLabel(names: string[]): string {
  const n = names.map((x) => x.trim()).filter(Boolean);
  if (!n.length) return 'Remind';
  return n.length <= 2 ? `Remind ${joinNames(n)}` : `Remind all ${n.length}`;
}

/**
 * The one main button of the page, by state. Null when there is nothing most people would do next (a template has
 * its own card, and a document that waits only for people who cannot be reminded offers their link instead).
 */
export function mainButton(o: { status: string; isTemplate?: boolean; removed?: boolean; purged?: boolean; people: PagePerson[] }): MainButton | null {
  if (o.removed) return { kind: 'restore', label: 'Put it back' };
  if (o.isTemplate) return null;
  if (o.status === 'draft') return { kind: 'continue', label: 'Continue' };
  if (o.status === 'sent') {
    const mine = o.people.find((p) => p.turn && p.me && p.role !== 'inperson');
    if (mine) return { kind: 'sign', label: NOW[mine.role] || 'Sign now', personId: mine.id };
    const here = o.people.find((p) => p.turn && p.role === 'inperson');
    if (here) return { kind: 'host', label: 'Host signing now', personId: here.id };
    const who = o.people.filter((p) => p.turn && p.remindable);
    return who.length ? { kind: 'remind', label: remindLabel(who.map((p) => p.name)) } : null;
  }
  if (o.status === 'completed') return o.purged ? null : { kind: 'download', label: 'Download' };
  if (o.status === 'expired') return { kind: 'reopen', label: 'Reopen' };
  if (o.status === 'declined') return o.purged ? null : { kind: 'copy_fix', label: 'Copy and fix' };
  if (o.status === 'voided') return o.purged ? null : { kind: 'copy', label: 'Copy' };
  return null;
}

/**
 * A Remind of their own in a person's More. The main button already reminds everyone who is waiting, so a second
 * control for one person is only worth its place when two or more wait at the same time, or when the main button
 * is busy with something else (the sender's own turn, or someone signing in person).
 */
export function personRemind(people: PagePerson[], main: MainButton | null, p: PagePerson): boolean {
  if (!p.turn || !p.remindable) return false;
  const waiting = people.filter((x) => x.turn && x.remindable);
  return waiting.length >= 2 || main?.kind !== 'remind';
}

/** "Waiting for Ana Silva to sign." One sentence, whoever is waited for. */
export function waitingSentence(people: PagePerson[]): string {
  const turn = people.filter((p) => p.turn);
  if (!turn.length) return 'Sent. Nobody is holding it up right now.';
  const names = [...(turn.some((p) => p.me && p.role !== 'inperson') ? ['you'] : []), ...turn.filter((p) => !(p.me && p.role !== 'inperson')).map((p) => p.name)];
  const verbs = [...new Set(turn.map((p) => VERB[p.role] || 'sign'))];
  return `Waiting for ${joinNames(names)}${verbs.length === 1 ? ` to ${verbs[0]}` : ''}.`;
}

export type MoreKey = 'open_pdf' | 'full_record' | 'edit' | 'more_time' | 'copy' | 'save_template' | 'cancel' | 'keep' | 'hold' | 'lift_hold' | 'delete';
export type MoreLine = { key: MoreKey; label: string; danger?: boolean };

/**
 * The lines of the page's More, in their fixed order, only those that apply. Nothing the page could do before is
 * missing: what used to be a row of header buttons is here. `schedule` is true when a deletion schedule applies to
 * this document; without one, Keep it and Hold are not listed (charter P3).
 */
export function pageMore(o: {
  status: string; isTemplate?: boolean; removed?: boolean; purged?: boolean; hasFiles?: boolean; mayChange?: boolean; mayDelete?: boolean;
  main?: MainKind | null; schedule?: boolean; mayKeep?: boolean; mayHold?: boolean; held?: boolean; heldHere?: boolean;
}): MoreLine[] {
  const out: MoreLine[] = [];
  const sent = o.status === 'sent';
  const add = (key: MoreKey, label: string, danger?: boolean) => out.push({ key, label, ...(danger ? { danger } : {}) });
  // A completed document has Download as its main button: the same file, so no second way to open it next to it.
  if (o.hasFiles && !(o.status === 'completed' && !o.purged)) add('open_pdf', 'Open the PDF');
  if (!o.isTemplate && o.status !== 'draft' && !o.purged) add('full_record', 'Full record for disputes');
  if (!o.removed && o.mayChange && sent) add('edit', 'Edit');
  if (!o.removed && sent) add('more_time', 'Give more time');
  if (!o.removed && !o.purged && o.main !== 'copy' && o.main !== 'copy_fix') add('copy', o.isTemplate ? 'Use' : 'Copy');
  if (!o.removed && !o.purged && !o.isTemplate) add('save_template', 'Save as template');
  if (!o.removed && sent) add('cancel', 'Cancel the request', true);
  if (!o.isTemplate && !o.purged && o.schedule && o.mayKeep) add('keep', 'Keep it');
  if (!o.isTemplate && !o.purged && o.mayHold && o.heldHere) add('lift_hold', 'Lift the hold');
  else if (!o.isTemplate && !o.purged && o.mayHold && o.schedule) add('hold', 'Hold');
  if (!o.removed && !sent && o.mayChange && o.mayDelete !== false) add('delete', 'Delete', true);
  return out;
}

/**
 * Lines of the record that stay off the page: what a device reported about itself. They are in the full record
 * (the download "Full record for disputes"), with every address and fingerprint.
 */
export const offThePage = (action: string) => /^Time zone reported$/i.test(action.trim());

/** Internet addresses and long fingerprints, taken out of a line before it is shown on the page. */
export function withoutAddresses(text: string): string {
  return String(text || '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '(address in the full record)')
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}(?![\w:])/gi, '(address in the full record)')
    .replace(/\b[0-9a-f]{32,}\b/gi, '(fingerprint in the full record)');
}

export type HistoryLine = { key: string; at: string; title: string; detail: string; who?: string; mail?: boolean; bad?: boolean; removed?: string | null };

/**
 * One list for History: the lines of the record and the emails about the document, oldest first. An email line
 * carries its delivery state in `detail`, so there is no second list of emails.
 */
export function historyLines(audit: any[], mails: { at: string; subject: string; to_email: string; state: string; bad?: boolean }[]): HistoryLine[] {
  const a: HistoryLine[] = (audit || []).filter((x) => !offThePage(x.action || '')).map((x) => ({
    key: `a${x.seq}`, at: x.at, title: x.action, detail: withoutAddresses(x.detail || ''), who: x.actor, removed: x.redacted_at || null,
  }));
  const m: HistoryLine[] = (mails || []).map((d, i) => ({ key: `m${i}`, at: d.at, title: `Email: ${d.subject}`, detail: `To ${d.to_email}. ${d.state}`, mail: true, bad: !!d.bad }));
  return [...a, ...m].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.key.localeCompare(y.key)));
}
