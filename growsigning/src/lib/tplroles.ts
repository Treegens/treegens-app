// Who can use a template, who can change it, and whether its wording is locked. The server enforces it
// (src/server/tplroles.ts). The sentences live here so the template page, the editor and the server say the same.

export const TPL_USES = ['team', 'admins', 'chosen'] as const;
export const TPL_CHANGES = ['owner', 'chosen', 'team'] as const;
export type TplUse = (typeof TPL_USES)[number];
export type TplChange = (typeof TPL_CHANGES)[number];

/** What GET /envelopes/:id/access answers, and what the template list carries in `access` (without the people). */
export type TplAccess = {
  use: TplUse;
  change: TplChange;
  locked: boolean;
  /** The person the template belongs to. */
  owner: string;
  /** Names of the chosen people who may use it, and of those who may also change it. */
  chosen_use?: string[];
  chosen_change?: string[];
};

/** The words for each choice, as the page offers them. */
export const USE_LABEL: Record<TplUse, string> = { team: 'Everyone on the team', admins: 'Admins only', chosen: 'Chosen members' };
export const CHANGE_LABEL: Record<TplChange, string> = { owner: 'Its owner and admins', chosen: 'Chosen members as well', team: 'Everyone on the team' };

export const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What a locked wording means, in one sentence. Said on the template, in the editor and in a refusal. */
export const LOCK_MEANS = 'Whoever may not change the template fills in names, email addresses and the fields left empty for them, and cannot change the documents, the fixed wording, the fields, the message, who signs in what order, or the private note and the checks the template gives each person. The subject stays theirs to set.';

/** What a locked template gave one person, which stays (wording_lock.people on the envelope, by recipient id). */
export type KeptForPerson = { note?: 1; verify?: 'email_code' | 'sms_code'; code?: 1 };

/** The editor's line under a person's options when the template gave them a note or a check. */
export function keptLine(k: KeptForPerson, ask: string): string {
  const parts = [k.note && 'the private note', k.verify && 'a one-time code before the document opens (by email or by text message, but not none)', k.code && 'an access code (you can change it, not take it off)'].filter(Boolean) as string[];
  return `From the template, and it stays: ${listNames(parts)}. To change ${parts.length > 1 ? 'them' : 'it'}, ask ${ask}.`;
}

/** The current rule as sentences: who can use it, who can change it, and the lock. */
export function accessSentence(a: TplAccess): string {
  const use = a.chosen_use || [];
  const editors = a.change === 'chosen' ? a.chosen_change || [] : [];
  const users = a.use === 'chosen' ? [...new Set([...use, ...editors])] : editors;
  // One list for everyone named, so two or more chosen people read "A, B, C and D", never "A, B and C and D".
  const all = (first: string[], more: string[]) => listNames([...new Set([...first, ...more])]);
  const who = a.use === 'team' || a.change === 'team' ? 'Everyone on the team can use it.'
    : users.length ? `Only ${all(['admins', a.owner], users)} can use it.`
    : `Only admins and ${a.owner} can use it${a.use === 'chosen' ? ', because nobody else has been chosen yet' : ''}.`;
  const change = a.change === 'team' ? 'Everyone on the team can change it.'
    : editors.length ? `${all([a.owner, 'admins'], editors)} can change it.`
    : `Only ${a.owner} and admins can change it${a.change === 'chosen' ? ', because nobody else has been chosen yet' : ''}.`;
  const lock = a.locked ? `Its wording is locked. ${LOCK_MEANS}` : 'Its wording is not locked: whoever uses it can change the envelope they make from it before sending.';
  return `${who} ${change} ${lock} Only ${a.owner} and admins can change these rules or delete it.`;
}

/** A short mark for the template list, or '' for the usual rule. */
export function accessMark(a: { use: TplUse }): string {
  return a.use === 'admins' ? 'Admins only' : a.use === 'chosen' ? 'Chosen members' : '';
}

/** What the editor says above an envelope whose wording is locked. `ask` is "Maya Lopez or an admin of your team". */
export function lockedBanner(template: string | null, ask: string): string {
  return `${template ? `It was started from the template "${template}", whose wording is locked.` : 'It was started from a template whose wording is locked, and that template has since been deleted.'} You can fill in the names and email addresses, and the fields left empty for you, and choose the subject. The documents, the fixed wording, the fields, the message, who signs in what order and the notes and checks it gives each person stay as the template has them. To change them, ask ${ask} to change the template.`;
}
