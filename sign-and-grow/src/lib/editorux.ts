// The rules of the three editor steps that the screens, the server and the tests share (research/ux-charter.md,
// section 2.3). Pure functions and words: nothing here reads the environment or the database.

import { IMPACT, sheetsSaved } from './impact.ts';

/** The names of the three steps. Never a fourth. */
export const STEP_NAMES = ['Files and people', 'Fields', 'Review and send'] as const;

// ---- Step 2 ------------------------------------------------------------------------------------------------------

/** The six kinds of field most documents need. Every other kind is one press away, under "More fields". */
export const COMMON_FIELDS = ['signature', 'initials', 'date_signed', 'full_name', 'text', 'checkbox'];
export const isCommonField = (type: string) => COMMON_FIELDS.includes(type);

// ---- Step 1: what one person does ----------------------------------------------------------------------------------

/**
 * The roles in the order they are offered. Signing in person is not a role here: it is a way of signing, chosen
 * under "How they sign", and is kept on the person as the role "inperson" as before.
 */
export const ROLE_CHOICES = ['signer', 'approver', 'cc', 'viewer', 'witness'];
export const ROLE_WORDS: Record<string, string> = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Gets a copy', viewer: 'Must open it', witness: 'Is a witness', inperson: 'Needs to sign' };
/** The most roles the list may ever offer, with everything set up. */
export const ROLE_CAP = 8;
/** The most lines inside one person's More: with nothing set up, and with everything set up. */
export const MORE_CAP = { zero: 6, everything: 8 };

/** "I will send the link myself" is for one person who signs, approves or must open it, on a document, not a template. */
export const canSendMyself = (r: any, isTpl: boolean) => !isTpl && !r.group_id && (r.role === 'signer' || r.role === 'approver' || r.role === 'viewer');

export type MoreLine = { key: 'role' | 'deliver' | 'check' | 'sign' | 'language' | 'note'; label: string; value: string };

const CHECK_WORDS: Record<string, string> = { email_code: 'Code by email', sms_code: 'Code by text' };

/**
 * The lines inside one person's More, each with what it is set to now. A line whose choice has only one possible
 * answer for this person is left out, so nobody opens a picker with nothing to pick.
 * `languages` is how many languages this server offers, `isTpl` whether this is a template.
 */
export function moreLines(r: any, o: { isTpl?: boolean; languages?: number } = {}): MoreLine[] {
  const lines: MoreLine[] = [];
  lines.push({ key: 'role', label: 'Role', value: ROLE_WORDS[r.role] || ROLE_WORDS.signer });
  if ((o.languages || 1) >= 2) lines.push({ key: 'language', label: 'Language', value: r.locale ? String(r.locale) : 'Their browser decides' });
  if (canSendMyself(r, !!o.isTpl) || r.link_by_sender) lines.push({ key: 'deliver', label: 'How they get it', value: r.link_by_sender ? 'I send the link myself' : r.text_link ? 'Email and a text message' : 'Email' });
  const checks = [String(r.access_code || '').trim() ? 'Access code' : '', CHECK_WORDS[r.verify] || ''].filter(Boolean);
  lines.push({ key: 'check', label: 'Check who signs', value: checks.length ? checks.join(' and ').replace(' and Code', ' and a code') : 'None' });
  // On screen, or on the sender's own device with the sender next to them. Not for someone the sender only sends a link.
  if ((r.role === 'signer' && !r.link_by_sender && !r.group_id) || r.role === 'inperson') lines.push({ key: 'sign', label: 'How they sign', value: r.role === 'inperson' ? 'In person, with me' : 'On screen' });
  lines.push({ key: 'note', label: 'Private note', value: String(r.note || '').trim() ? 'Added' : 'None' });
  return lines;
}

/**
 * What a person's row says under the name while More is closed: only what differs from the plain case (someone who
 * signs on screen and gets an email). Empty for the plain case, so a first sender sees a name and an email, no more.
 */
export function personSummary(r: any): string {
  const said: string[] = [];
  if (r.role === 'inperson') said.push('Signs in person, with you');
  else if (r.role && r.role !== 'signer') said.push(ROLE_WORDS[r.role] || '');
  if (r.link_by_sender) said.push('You send the link yourself');
  else if (r.text_link) said.push('Link also by text');
  if (String(r.access_code || '').trim()) said.push('Access code');
  if (CHECK_WORDS[r.verify]) said.push(CHECK_WORDS[r.verify]);
  if (String(r.note || '').trim()) said.push('Private note');
  return said.filter(Boolean).join(' · ');
}

/** A row nobody has typed anything into yet: the one that is there when step 1 opens. */
export const isBlankPerson = (r: any) => !String(r?.name || '').trim() && !String(r?.email || '').trim() && !r?.group_id && !r?.link_by_sender && !r?.named_by_signer;

// ---- Step 3 --------------------------------------------------------------------------------------------------------

const sameAddress = (a: unknown, b: unknown) => !!String(a || '').trim() && String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * "Sign now": the only person on the document is the sender, signing on screen at their own sign-in address. The
 * main button of step 3 then opens the signing page in the same tab, and no invitation email is written. Anyone
 * else on the document, or any other role, and it is an ordinary Send. Answers that one person, or null.
 */
export function onlyMe(recipients: any[], myEmail: string | null | undefined): any | null {
  if (!Array.isArray(recipients) || recipients.length !== 1) return null;
  const r = recipients[0];
  return r && r.role === 'signer' && !r.group_id && !r.link_by_sender && sameAddress(r.email, myEmail) ? r : null;
}

/** What step 3 keeps under More options: only what changes from one send to the next. Never more than this many. */
export const STEP3_MORE_CAP = 7;

/**
 * The saving of this one document, in the owner's words: the pages of the document times the people who would each
 * have had a paper copy. No fraction of a tree. Water and CO2e stand behind "How we work this out", as estimates.
 */
export function savingLine(pages: number, people: number): { sheets: number; line: string; how: string } {
  const sheets = sheetsSaved(pages, people);
  const n = sheets.toLocaleString('en');
  const copies = Math.max(1, Math.round(people));
  const water = (sheets * IMPACT.litresWaterPerSheet).toLocaleString('en', { maximumFractionDigits: 0 });
  const co2 = ((sheets * IMPACT.gramsCo2PerSheet) / 1000).toLocaleString('en', { maximumFractionDigits: 2 });
  return {
    sheets,
    line: `This saves ${n} ${sheets === 1 ? 'page' : 'pages'} of paper from a tree.`,
    how: `An estimate: ${Math.max(0, Math.round(pages)).toLocaleString('en')} ${Math.round(pages) === 1 ? 'page' : 'pages'} for ${copies === 1 ? '1 person' : `each of ${copies} people`}, one paper copy each. Making that paper would take about ${water} litres of water and ${co2} kg of CO2e. Printing, couriers and filing are not counted.`,
  };
}
