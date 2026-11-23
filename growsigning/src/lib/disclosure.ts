// The account's own consent text: the words an organisation adds to the consent screen, under our own sentence and
// its link on how electronic signing works. Ours stay and cannot be removed (src/lib/policy.ts). Plain values and
// functions with no environment in them, shared by the server (src/server/disclosure.ts), Settings
// (src/components/settings/Disclosure.tsx) and the signing page (src/components/sign/OwnTerms.tsx).
//
// On screens this is "Your consent text" for the sender and "Read <Org>'s terms" for the signer. The word
// "disclosure" is the API's and the code's only (research/ux-notes.json, ds-consent-own).
import { t } from './i18n.ts';

/** What an admin writes, for one language. Every value is plain text: nothing in it becomes a link or markup. */
export type OwnTextFields = {
  /** The organisation, as the signer should read it. */
  org: string;
  /** How to reach it. At least one of the three. */
  email: string;
  phone: string;
  address: string;
  /** How to ask for a paper copy. */
  paper: string;
  /** What a paper copy costs. May say that it is free. */
  paper_cost: string;
  /** How to stop agreeing to electronic documents, and what happens then. */
  withdraw: string;
  /** What a person needs to read the documents. Left empty, our default sentence is used. */
  needs: string;
  /** Anything else. */
  other: string;
};
export const OWN_TEXT_KEYS = ['org', 'email', 'phone', 'address', 'paper', 'paper_cost', 'withdraw', 'needs', 'other'] as const;
/** The most characters of each part. Enough for a paragraph, short enough that a signer reads it. */
export const OWN_TEXT_MAX: Record<keyof OwnTextFields, number> = { org: 120, email: 254, phone: 40, address: 300, paper: 600, paper_cost: 200, withdraw: 600, needs: 400, other: 2000 };
/** What Settings calls each part. */
export const OWN_TEXT_LABEL: Record<keyof OwnTextFields, string> = {
  org: 'Organisation name',
  email: 'Email',
  phone: 'Phone',
  address: 'Postal address',
  paper: 'How to ask for a paper copy',
  paper_cost: 'What a paper copy costs',
  withdraw: 'How to stop agreeing to electronic documents, and what happens then',
  needs: 'What a person needs to read the documents',
  other: 'Anything else',
};
/** Our sentence for "what a person needs", used when the account writes none. True of this software as it stands. */
export const DEFAULT_NEEDS = 'A phone, tablet or computer with a current web browser and a connection to the internet. To keep your copy you need a program that opens PDF files, or a printer.';

/** The sentence Settings shows under the form. We never call our own text, or theirs, an ESIGN consumer disclosure. */
export const ESIGN_NOTE = 'If you deal with consumers in the United States, the ESIGN Act section 101(c) lists what this text must say. Ask your lawyer.';
/** What Settings says the text is and is not. */
export const OWN_TEXT_IS = 'Signers can read this on the screen where they agree to sign on screen, above the box they tick. Our own link on how electronic signing works always stays on that screen. GrowSigning shows your words as you wrote them and does not check that they meet any law.';

/** How often the consent screen is shown: once for each document (the default), or every time the link is opened. */
export const HOW_OFTEN = [['once', 'Once for each document'], ['each', 'Every time the link is opened']] as const;

/** One part of the text as a signer reads it: a short heading of ours and the account's words under it. */
export type OwnSection = { h: string; lines: string[] };

const clean = (v: unknown, max: number): string =>
  // Line ends as one kind, no control characters, no more than one empty line in a row, nothing but text.
  String(typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim();

/** The fields as they are kept: text only, trimmed, cut to their lengths. Unknown keys are dropped. */
export function tidyOwnText(v: any): OwnTextFields {
  const o = {} as OwnTextFields;
  for (const k of OWN_TEXT_KEYS) o[k] = clean(v?.[k], OWN_TEXT_MAX[k]);
  // One line each for what is printed on one line.
  for (const k of ['org', 'email', 'phone', 'paper_cost'] as const) o[k] = o[k].replace(/\s*\n\s*/g, ' ');
  return o;
}

/**
 * Why these fields cannot be saved, in words for the person typing, or '' when they can. `raw` is what was typed,
 * before tidying, so a part that is too long is said to be too long and never cut without a word.
 */
export function ownTextProblem(raw: any): string {
  for (const k of OWN_TEXT_KEYS) {
    if (raw?.[k] != null && typeof raw[k] !== 'string') return `"${OWN_TEXT_LABEL[k]}" must be text. Type it as words and save again.`;
    if (String(raw?.[k] ?? '').trim().length > OWN_TEXT_MAX[k]) return `"${OWN_TEXT_LABEL[k]}" is longer than ${OWN_TEXT_MAX[k]} characters. Shorten it and save again.`;
  }
  const f = tidyOwnText(raw);
  if (!f.org) return 'The organisation name is missing. Type the name signers know you by and save again.';
  if (!f.email && !f.phone && !f.address) return 'There is no way to reach you yet. Add an email address, a phone number or a postal address and save again.';
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return 'The email address does not look like one. Check it and save again.';
  if (!f.paper) return 'The part on paper copies is empty. Say how a person asks you for a paper copy and save again.';
  if (!f.withdraw) return 'The part on stopping is empty. Say how a person tells you they no longer agree to electronic documents, and what happens then, and save again.';
  return '';
}

/**
 * The text as a signer reads it, in the language of the version: our headings from the catalogue, their words under
 * them. Made once when a version is saved and kept with it, so a later change of a heading never changes what an
 * earlier signer is on record as having seen.
 */
export function ownSections(fields: OwnTextFields, language: string): OwnSection[] {
  const f = tidyOwnText(fields);
  const reach = [f.email && `${t(language, 'ownterms.email')}: ${f.email}`, f.phone && `${t(language, 'ownterms.phone')}: ${f.phone}`, f.address && `${t(language, 'ownterms.post')}: ${f.address}`].filter(Boolean) as string[];
  const out: OwnSection[] = [
    { h: t(language, 'ownterms.reach', { org: f.org }), lines: reach },
    { h: t(language, 'ownterms.paper'), lines: [f.paper, f.paper_cost && `${t(language, 'ownterms.cost')}: ${f.paper_cost}`].filter(Boolean) as string[] },
    { h: t(language, 'ownterms.stop'), lines: [f.withdraw] },
    { h: t(language, 'ownterms.needs'), lines: [f.needs || DEFAULT_NEEDS] },
    { h: t(language, 'ownterms.other', { org: f.org }), lines: f.other ? [f.other] : [] },
  ];
  return out.filter((s) => s.lines.length);
}

/** The same text as plain words, for the record: the evidence pack prints it and its fingerprint is taken from it. */
export const ownTextPlain = (sections: OwnSection[]): string => sections.map((s) => `${s.h}\n${s.lines.join('\n')}`).join('\n\n');

/** "Acme Ltd's" and "Chris'": the name in front of "terms". */
export const possessive = (name: string): string => (/s$/i.test(name.trim()) ? `${name.trim()}'` : `${name.trim()}'s`);

// ---- Asking for paper instead (withdrawing consent) --------------------------------------------------------------
// One entry in Other actions, "Sign on paper instead", with one choice in it for now: ask the sender to send the
// document by post, which stops signing on screen (research/ux-charter.md 2.6 and 2.9). It closes the person's part
// like a decline, with one of these two reasons, written by the software and never typed by the person.
/** The reason on record for someone who had agreed to electronic records and takes that back. */
export const WITHDREW_REASON = 'Withdrew consent to electronic records';
/** The reason on record for someone who never agreed and asks for paper from the consent screen. */
export const NEVER_AGREED_REASON = 'Did not agree to electronic records';
/**
 * Whether this person closed their part with "Sign on paper instead". Told by recipients.paper_at, which only that
 * action sets, and never by the words of the reason: a person who declines and types the same words has declined.
 */
export const askedPaper = (r: { status?: string; paper_at?: string | null } | null | undefined): boolean => r?.status === 'declined' && !!r.paper_at;

/**
 * "E-record consent" on the certificate for one person: when they agreed, and for someone who asked for paper
 * instead, that they took it back (or never gave it) and when. `ts` writes a moment the way the certificate does.
 */
export function consentCertValue(r: { status?: string; paper_at?: string | null; consent_at?: string | null; completed_at?: string | null; paper_scan_id?: string | null }, ts: (at: string | null | undefined) => string): string {
  // Signed on paper without agreeing to electronic records: they were never asked to (src/server/paper.ts).
  if (r.paper_scan_id && r.status === 'completed' && !r.consent_at) return 'Not asked: signed on paper';
  if (!askedPaper(r)) return ts(r.consent_at);
  if (r.consent_at) return `${ts(r.consent_at)}, withdrawn ${ts(r.paper_at)}: asked for paper instead`;
  return `Not given. Asked for paper instead ${ts(r.paper_at)}`;
}
