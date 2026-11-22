// Every sentence about trees that a person reads at the moment they send or sign, in one place, so the signing page,
// the envelope page, the emails and the certificate cannot disagree. The server decides the facts (src/server/impact.ts):
// whether a signature was paid for, whether this is somebody's first time, and the counts. These functions only turn
// those facts into words.
//
// Rules the words keep (research/briefs.json "impact", point 7):
// - "10 mangroves" is said only for a signature that was paid for. A free signature (the trial, a free code, a
//   sender signing their own document) plants nothing, so nothing is said to be planted for it.
// - What happens is said as what happens: money funds planting by Treegens. No word such as "green", no carbon claim,
//   and nothing that says a signature undoes harm.
// - No figure under one tree, and no money words on a screen a signer reads.
import { PRICING, sheetsSaved } from './impact.ts';

/** Mangroves that one paid signature funds: a signature costs one dollar, and a dollar plants ten. */
export const TREES_PER_SIGNATURE = PRICING.topUpUsd * PRICING.treesPerUsd;

/** Where Treegens shows its own work. Linked from /impact, never fetched by the server. */
export const TREEGENS_URL = 'https://treegens.app';
/** Where Treegens states its average planting cost (ten cents a tree across a run). Linked from /impact. */
export const TREEGENS_ORG_URL = 'https://treegens.org';
/** The day both pages were read for the sentences on /impact that say what Treegens says about itself. When the
 *  pages are read again, change the sentences and this date together. */
export const TREEGENS_READ_ON = '21 November 2026';

/**
 * Where the money goes, in the one form every page uses. Card payments carry the card processor's fees, and nothing
 * in this code makes them up, so the words never say "100%" or "everything". Change it here, and only here.
 */
export const MONEY_LINE = 'What customers pay GrowSigning, less card fees, goes to Treegens to plant mangroves.';
/** The same, short, for the footer of every public page. */
export const MONEY_SHORT = 'What you pay, less card fees, goes to Treegens tree planting.';

const n = (k: number) => Math.round(k).toLocaleString('en');
const mangroves = (k: number) => `${n(k)} ${k === 1 ? 'mangrove' : 'mangroves'}`;
const pages = (k: number) => `${n(k)} ${k === 1 ? 'page' : 'pages'}`;

/**
 * For a signature that plants nothing itself: what is true of GrowSigning as a whole, and no more. Said only on the
 * signing record, and only by a server that takes payments: where there are no plans, nothing is earned or given.
 */
export const SOFT_LINE = 'GrowSigning gives what it earns from its plans to planting mangroves with Treegens.';

/** Next to Finish, for a person who signs with a paid signature. Empty for everyone else. */
export const finishLine = (trees: number): string => (trees >= 1 ? `${mangroves(trees)} will be planted when you finish.` : '');

/** One line in the email that asks someone to sign, when their signature is paid for. Empty otherwise. */
export const mailLine = (trees: number, signer = ''): string =>
  trees < 1 ? '' : `${mangroves(trees)} will be planted with Treegens when ${signer.trim() ? `${signer.trim()} finishes` : 'you finish'}.`;

export type SignerFacts = {
  /** Mangroves this signature funds: 10 when it was paid for, 0 when it was free. */
  trees: number;
  /** Nobody had finished a signature from this address on this server before. */
  first: boolean;
  /** Everything this person's paid signatures fund so far, this one included. */
  total: number;
  /** Sheets of paper this document would have used: its pages times the people who would each have had a copy. */
  sheets: number;
};

/**
 * The finished screen of a person who signs. `title` and `under` are the first-time card (the big line, and the line
 * under it, which does not say the mangroves again); `line` is the small card of every other time.
 *
 * The tense is one and the same everywhere: a signature "plants" and mangroves "are being planted", because at this
 * moment the planting has been paid for and Treegens does it afterwards. Nothing says it has already happened.
 */
export function signerWords(f: SignerFacts): { title: string; under: string; line: string; count: string; announce: string } {
  const paid = f.trees >= 1;
  const saved = f.sheets >= 1 ? `${pages(f.sheets)} of paper from a tree` : '';
  const title = paid ? `Your signature plants ${mangroves(f.trees)}` : 'You signed your first document with GrowSigning';
  const under = !saved ? '' : paid ? `You also saved ${saved}.` : `You saved ${saved}.`;
  // "More" is said only when there were some before: the total is above what this signature funds.
  const more = paid && f.total > f.trees;
  // The owner's two-part line: the pages first, then the trees, and the trees only when they are true.
  const line = more ? `${n(f.trees)} more ${f.trees === 1 ? 'mangrove' : 'mangroves'}.${saved ? ` You saved ${saved}.` : ''}`
    : paid ? saved ? `You saved ${saved}, and ${mangroves(f.trees)} are being planted.` : `${mangroves(f.trees)} are being planted.`
    : saved ? `You saved ${saved}.` : '';
  // The running count is said only when it says more than this signature already did.
  const count = f.total > f.trees && f.total >= 1 ? `Your signatures on GrowSigning fund ${mangroves(f.total)} so far.` : '';
  return { title, under, line, count, announce: `${title}.` };
}

export type SenderFacts = {
  /** People on the envelope who sign and whose signature is paid for, as far as it is known today. */
  paid: number;
  /** Everyone on the envelope who signs, the sender included when they sign their own document. */
  signers: number;
  /** Mangroves funded by signatures already finished on this account's documents. */
  planted: number;
  sheets: number;
};

/**
 * The envelope page after sending. `title` is said only the first time an account sends anything. `promise` is empty
 * when no signature on it is paid for: nothing is said about planting then. "Every signature" is said only when every
 * person who signs, the sender included, signs with a paid signature.
 */
export function senderWords(f: SenderFacts): { title: string; promise: string; saving: string; saved: string; announce: string } {
  const each = TREES_PER_SIGNATURE;
  const promise = f.paid < 1 ? ''
    : f.paid >= f.signers ? `Every signature on it plants ${mangroves(each)} with Treegens.`
    : `Each paid signature on it plants ${mangroves(each)} with Treegens.`;
  // While it is out, in the card that says who it is waiting on: short, because that page is read on every send.
  const saving = f.sheets >= 1 ? `Paper saved: ${pages(f.sheets)}.` : '';
  // Once everyone finished.
  const saved = f.sheets >= 1 ? `This saved ${pages(f.sheets)} of paper from a tree.` : '';
  const title = 'Your first document is out.';
  return { title, promise, saving, saved, announce: `${title}${promise ? ` ${promise}` : ''}` };
}

/** The second sentence of the box at the review step, only when every signature of this document will be a paid one. */
export const reviewPlus = (allPaid: boolean): string => (allPaid ? `Plus: ${mangroves(TREES_PER_SIGNATURE)} are planted for each person who signs.` : '');

/**
 * The lines of the box "Signed without paper" on the signing record (the certificate of completion). Paper, water
 * and CO2e are estimates and are called that, with where the working is shown. No fraction of a tree.
 */
export function recordLines(f: { sheets: number; litresWater: number; kgCo2: number; trees: number; site: string; plans?: boolean }): string[] {
  const num = (v: number, d = 0) => v.toLocaleString('en', { maximumFractionDigits: d });
  const paper = `An estimate: about ${num(f.sheets)} ${f.sheets === 1 ? 'sheet' : 'sheets'} of paper, ${num(f.litresWater)} litres of water and ${num(f.kgCo2, 2)} kg of CO2e were not used.`;
  const trees = f.trees >= 1
    ? `The signatures paid for on this document fund ${mangroves(f.trees)}, planted by Treegens. How we count: ${f.site}/impact`
    : `${f.plans === false ? '' : `${SOFT_LINE} `}How we count: ${f.site}/impact`;
  return [paper, trees];
}

/** Sheets for the people of an envelope: everyone on it would have had a paper copy. */
export const sheetsFor = (pageCount: number, people: number) => sheetsSaved(pageCount, people);

