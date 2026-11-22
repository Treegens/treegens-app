// The rules of the three editor steps that the screens, the server and the tests share (research/ux-charter.md,
// section 2.3). Pure functions and words: nothing here reads the environment or the database.

import { IMPACT, sheetsSaved } from './impact.ts';
// A language is shown by its own name (Français), never by its code.
import { languageOf } from './i18n.ts';

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
export const ROLE_WORDS: Record<string, string> = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Gets a copy', viewer: 'Must open it', witness: 'Is a witness', inperson: 'Needs to sign', editor: 'Can change the document', agent: 'Chooses who comes next' };
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
 * `languages` is how many languages this server offers, `isTpl` whether this is a template, `texts` whether this
 * server sends text messages.
 */
export function moreLines(r: any, o: { isTpl?: boolean; languages?: number; texts?: boolean; whatsapp?: boolean } = {}): MoreLine[] {
  const lines: MoreLine[] = [];
  lines.push({ key: 'role', label: 'Role', value: ROLE_WORDS[r.role] || ROLE_WORDS.signer });
  if ((o.languages || 1) >= 2) lines.push({ key: 'language', label: 'Language', value: r.locale ? languageOf(r.locale)?.own || String(r.locale) : 'Their browser decides' });
  // Listed when there is something to choose: sending the link yourself, or (where this server sends texts, `texts`)
  // the link by text message as well. Something set earlier keeps its line, so it can be taken off.
  const canText = (!!o.texts && r.role !== 'inperson') || !!r.text_link;
  // The link by WhatsApp as well, where the operator set it up (src/components/editor/WaLink.tsx), for one person on an envelope.
  const canWa = (!!o.whatsapp && !o.isTpl && !r.group_id && ['signer', 'approver', 'viewer', 'witness'].includes(r.role)) || !!r.whatsapp;
  if (canSendMyself(r, !!o.isTpl) || r.link_by_sender || canText || canWa) lines.push({ key: 'deliver', label: 'How they get it', value: r.link_by_sender ? 'I will send the link myself' : r.text_link ? 'Email and a text message' : r.whatsapp ? 'Email and WhatsApp' : 'Email' });
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
  else if (r.whatsapp) said.push('Link also by WhatsApp');
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

// ---- Words for a person who has no name yet -------------------------------------------------------------------------

const has = (v: unknown) => !!String(v || '').trim();

/**
 * What a person is called on steps 2 and 3. Someone nothing was typed for is "Person 2 (no name yet)", counted the
 * way the rows of step 1 are, never "Unnamed".
 */
export function personLabel(r: any, index: number): string {
  return String(r?.name || '').trim() || String(r?.role_name || '').trim() || String(r?.email || '').trim() || `Person ${Math.max(0, index) + 1} (no name yet)`;
}

/** The same person inside a sentence for a screen reader: "More options for this person". */
export const personInSentence = (r: any): string => String(r?.name || '').trim() || String(r?.role_name || '').trim() || String(r?.email || '').trim() || 'this person';

/** Under a person on step 3 who has no address. Only a template says it is filled in later. */
export function noAddressWords(r: any, isTpl: boolean, chooser?: string | null): string {
  if (r?.link_by_sender) return 'No email from us. You send them the link yourself after sending.';
  // A place left open for the person who chooses who comes next (src/lib/recipienttypes.ts): the same as step 1 says.
  if (chooser != null && !isTpl) return `${chooser || 'The person who chooses who comes next'} names this person on their turn.`;
  return isTpl ? 'Filled in when the template is used' : 'No email address yet. Add it in step 1.';
}

/** What step 1 says when Next is pressed with nothing to go on. Shown in place, and gone once it is put right. */
export const NUDGE = {
  file: 'Add a file first. Choose one here.',
  person: 'Add at least one person: a name and an email address.',
} as const;

// ---- Step 1: "Check who signs" is one choice -----------------------------------------------------------------------

export type CheckChoice = { value: string; label: string; code: boolean; verify: 'none' | 'email_code' | 'sms_code' };

const CHECK_LIST: CheckChoice[] = [
  { value: 'none', label: 'None', code: false, verify: 'none' },
  { value: 'code', label: 'Access code (a code you tell them)', code: true, verify: 'none' },
  { value: 'email_code', label: 'Code by email', code: false, verify: 'email_code' },
  { value: 'code+email_code', label: 'Access code and a code by email', code: true, verify: 'email_code' },
  { value: 'sms_code', label: 'Code by text', code: false, verify: 'sms_code' },
  { value: 'code+sms_code', label: 'Access code and a code by text', code: true, verify: 'sms_code' },
];

const verifyOf = (v: unknown): CheckChoice['verify'] => (v === 'email_code' || v === 'sms_code' ? v : 'none');

/** Which of the choices is set for this person now. `wantsCode`: the sender picked an access code and has not typed it yet. */
export function checkValue(r: any, wantsCode = false): string {
  const code = wantsCode || has(r?.access_code);
  const v = verifyOf(r?.verify);
  return v === 'none' ? (code ? 'code' : 'none') : code ? `code+${v}` : v;
}

/**
 * The choices offered for one person: one list, nothing to combine by hand. A code by text only where this server
 * sends texts, or where it is already set (so it can be taken off). What a locked template asks for cannot be taken
 * off: `keepVerify` leaves out the choices without a one-time code, `keepCode` the ones without an access code.
 */
export function checkChoices(o: { textsOn?: boolean; current?: string; keepVerify?: boolean; keepCode?: boolean } = {}): CheckChoice[] {
  return CHECK_LIST.filter((c) => {
    if (c.value === o.current) return true;
    if (c.verify === 'sms_code' && !o.textsOn) return false;
    if (o.keepVerify && c.verify === 'none') return false;
    if (o.keepCode && !c.code) return false;
    return true;
  });
}

/** What picking a choice changes on the person. Leaving the access code out empties it; picking it keeps what is typed. */
export function checkPatch(value: string): { verify: string; access_code?: string } {
  const c = CHECK_LIST.find((x) => x.value === value) || CHECK_LIST[0];
  return c.code ? { verify: c.verify } : { verify: c.verify, access_code: '' };
}
export const checkHasCode = (value: string) => !!CHECK_LIST.find((x) => x.value === value)?.code;

/** Said under the list when there is no check at all. */
export const NO_CHECK_SAYS = 'With no check, the document opens for whoever has the link.';
/** Said under the list for an access code alone. A one-time code has its own sentence (src/lib/checks.ts). */
export const ACCESS_CODE_SAYS = 'You tell them the code yourself, so it is as strong as the way you pass it on.';

// ---- Step 3: what is said next to More options ---------------------------------------------------------------------

/**
 * The line next to step 3's closed More options. Reminders are always said, because a new account has them on without
 * anyone having chosen that. The deadline and the date format are said only when they differ from the account's own
 * defaults, and a payment link only when signers will see one. When the sender signs alone ("Sign now") nobody is
 * invited or reminded, so reminders are left out.
 */
export function reviewSummary(o: {
  reminderDays: number; expireDays?: number | null; closesOn?: string; dateFormat?: string | null;
  defaults: { expireDays?: number | null; dateFormat?: string | null };
  dateExample?: string; signNow?: boolean; payLink?: boolean;
}): string {
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const said: string[] = [];
  if (!o.signNow) said.push(o.reminderDays > 0 ? `Reminder every ${days(Math.round(o.reminderDays))}` : 'No automatic reminders');
  if (o.closesOn) said.push(`closes on ${o.closesOn}`);
  else if (o.expireDays != null && o.defaults.expireDays != null && Number(o.expireDays) !== Number(o.defaults.expireDays)) said.push(`closes after ${days(Number(o.expireDays))}`);
  if (o.dateFormat && o.dateFormat !== o.defaults.dateFormat && o.dateExample) said.push(`dates written like ${o.dateExample}`);
  if (o.payLink) said.push('payment link shown after signing');
  const line = said.join(' · ');
  return line ? line[0].toUpperCase() + line.slice(1) : '';
}

/**
 * The day used to show how each date format looks. Today, unless the day of the month could be taken for a month
 * (1 to 12): then the 25th, so "25/05/2026" and "05/25/2026" can be told apart.
 */
export function dateExampleDay(today: Date): Date {
  const d = new Date(today.getTime());
  if (d.getDate() <= 12) d.setDate(25);
  return d;
}

/** The kinds of field step 2 shows without "More fields": the six common ones, the one being placed, and every kind already on the document. */
export function paletteKinds(all: string[], o: { open?: boolean; tool?: string | null; used?: Iterable<string> } = {}): string[] {
  const used = new Set(o.used || []);
  return all.filter((t) => o.open || isCommonField(t) || t === o.tool || used.has(t));
}
