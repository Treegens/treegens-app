// Every sentence about trees that a person reads at the moment they send or sign, in one place, so the signing page,
// the envelope page, the emails and the certificate cannot disagree. The server decides the facts (src/server/impact.ts):
// whether a signature counts, whether this is somebody's first time, and the counts. These functions only turn those
// facts into words.
//
// Rules the words keep:
// - Every signature plants 5 trees (PRICING.treesPerSignature in src/lib/impact.ts, the one number): free trial
//   signatures, plan signatures, top-ups and rewards alike. "5 trees" is the number people remember; "mangroves" is
//   said where the kind of tree is described.
// - What happens is said as what happens: Treegens plants the trees, afterwards. No word such as "green", no carbon
//   claim, and nothing that says a signature undoes harm.
// - No figure under one tree, and no money words on a screen a signer reads.
import { PRICING, sheetsSaved } from './impact.ts';

/** Trees one signature plants. The number itself is PRICING.treesPerSignature; this is its name on the signing side. */
export const TREES_PER_SIGNATURE = PRICING.treesPerSignature;

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
const trees = (k: number) => `${n(k)} ${k === 1 ? 'tree' : 'trees'}`;
const pages = (k: number) => `${n(k)} ${k === 1 ? 'page' : 'pages'}`;

/** The one sentence of the rule, for a headline, a page title or the foot of an email. */
export const RULE_LINE = `Every signature plants ${trees(TREES_PER_SIGNATURE)}.`;
/** The rule with who plants and what kind of tree, for places that have room for a whole sentence. */
export const RULE_FULL = `Every signature plants ${trees(TREES_PER_SIGNATURE)}: mangroves, planted by Treegens. Free signatures count too.`;

/**
 * For a signature that plants nothing itself (one from before the 5 trees rule that was free): what is true of
 * GrowSigning as a whole, and no more. Said only on the signing record, and only by a server that takes payments.
 */
export const SOFT_LINE = 'GrowSigning gives what it earns from its plans to planting mangroves with Treegens.';

/**
 * The first thing a person reads when they open their link, above everything legal: "When you sign, 5 trees are
 * planted." Empty when their signature plants none (someone who does not sign, a server with no plans, tree words
 * switched off).
 */
export const openLine = (k: number): string => (k >= 1 ? `When you sign, ${trees(k)} ${k === 1 ? 'is' : 'are'} planted.` : '');
/** The short line under it: who plants them, and what kind of tree. */
export const OPEN_UNDER = 'Mangroves, planted by Treegens.';

/** Next to Finish. Empty when this signature plants nothing. */
export const finishLine = (k: number): string => (k >= 1 ? `${trees(k)} will be planted when you finish.` : '');

/** One line in the email that asks someone to sign. Empty when their signature plants nothing. */
export const mailLine = (k: number, signer = ''): string =>
  k < 1 ? '' : `${trees(k)} will be planted with Treegens when ${signer.trim() ? `${signer.trim()} finishes` : 'you finish'}.`;

export type SignerFacts = {
  /** Trees this signature plants: 5 for a signature that counts, 0 when it does not (see counts in server/impact.ts). */
  trees: number;
  /** Nobody had finished a signature from this address on this server before. */
  first: boolean;
  /** Everything this person's signatures plant so far, this one included. */
  total: number;
  /** Sheets of paper this document would have used: its pages times the people who would each have had a copy. */
  sheets: number;
  /** A sender who signed their own document on a server with plans: it used no signature, so it plants none, and that is said. */
  own?: boolean;
};

/** Said to a sender who signs their own document, where they would otherwise look for trees and find none. */
export const OWN_LINE = 'Signing your own document is free and plants no trees.';

/** The finished screen, right under "All done": what this person's signature does. Empty when it plants none. */
export const doneLine = (k: number): string => (k >= 1 ? `${trees(k)} will be planted for your signature.` : '');

/** One line in the email that says a document is complete. Empty when its signatures plant none. */
export const completedMailLine = (k: number): string => (k >= 1 ? `The signatures on this document plant ${trees(k)}: mangroves, planted by Treegens.` : '');

/**
 * The finished screen of a person who signs. `title` and `under` are the first-time card (the big line, and the line
 * under it); `line` is the small card of every other time.
 *
 * The tense: at this moment Treegens still has the planting to do, so the person reads what will happen because they
 * signed ("5 trees will be planted for your signature"), which is a result of their own, and never that it has
 * already happened.
 */
export function signerWords(f: SignerFacts): { title: string; under: string; line: string; count: string; announce: string } {
  const plants = f.trees >= 1;
  const saved = f.sheets >= 1 ? `${pages(f.sheets)} of paper from a tree` : '';
  const title = plants ? doneLine(f.trees).slice(0, -1) : 'You signed your first document with GrowSigning';
  const own = !plants && f.own ? OWN_LINE : '';
  const under = plants ? `${OPEN_UNDER}${saved ? ` You also saved ${saved}.` : ''}` : [own, saved ? `You saved ${saved}.` : ''].filter(Boolean).join(' ');
  // "More" is said only when there were some before: the total is above what this signature plants.
  const more = plants && f.total > f.trees;
  // The two-part line: the trees first when they are true, then the pages.
  const line = more ? `${n(f.trees)} more ${f.trees === 1 ? 'tree' : 'trees'} will be planted for your signature.${saved ? ` You saved ${saved}.` : ''}`
    : plants ? `${doneLine(f.trees)}${saved ? ` You saved ${saved}.` : ''}`
    : [saved ? `You saved ${saved}.` : '', own].filter(Boolean).join(' ');
  // The running count is said only when it says more than this signature already did.
  const count = f.total > f.trees && f.total >= 1 ? `Your signatures on GrowSigning plant ${trees(f.total)} so far.` : '';
  return { title, under, line, count, announce: `${title}.` };
}

export type SenderFacts = {
  /** People on the envelope whose signature plants trees: everyone who signs with a signature from the balance. */
  counted: number;
  /** Everyone on the envelope who signs, the sender included when they sign their own document. */
  signers: number;
  /** Trees planted by the signatures already finished on this account's documents. */
  planted: number;
  sheets: number;
};

/**
 * The envelope page after sending. `title` is said only the first time an account sends anything. `promise` is empty
 * when no signature on it counts. "Every signature" is said only when every person who signs counts; a sender who
 * signs their own document uses no signature, so with them on it the line is about the people who were asked.
 */
export function senderWords(f: SenderFacts): { title: string; promise: string; saving: string; saved: string; announce: string } {
  const each = TREES_PER_SIGNATURE;
  const promise = f.counted < 1 ? ''
    : f.counted >= f.signers ? `Every signature on it plants ${trees(each)} with Treegens.`
    : `Each person you asked to sign plants ${trees(each)} with Treegens.`;
  // While it is out, in the card that says who it is waiting on: short, because that page is read on every send.
  const saving = f.sheets >= 1 ? `Paper saved: ${pages(f.sheets)}.` : '';
  // Once everyone finished.
  const saved = f.sheets >= 1 ? `This saved ${pages(f.sheets)} of paper from a tree.` : '';
  const title = 'Your first document is out.';
  return { title, promise, saving, saved, announce: `${title}${promise ? ` ${promise}` : ''}` };
}

/** Once everyone finished, on the envelope page: what the signatures of this document plant together. */
export const plantedLine = (k: number): string => (k >= 1 ? `Its signatures plant ${trees(k)} with Treegens.` : '');

/** The first sentence of the box at the review step, before the paper, when every signature of this document plants trees. */
export const reviewPlus = (all: boolean): string => (all ? `${trees(TREES_PER_SIGNATURE)} are planted for each person who signs.` : '');

/**
 * The lines of the box "Signed without paper" on the signing record (the certificate of completion). Paper and water
 * are estimates and are called that, with where the working is shown. No fraction of a tree.
 */
export function recordLines(f: { sheets: number; litresWater: number; trees: number; site: string; plans?: boolean }): string[] {
  const num = (v: number, d = 0) => v.toLocaleString('en', { maximumFractionDigits: d });
  const paper = `An estimate: about ${num(f.sheets)} ${f.sheets === 1 ? 'sheet' : 'sheets'} of paper and ${num(f.litresWater)} litres of water were not used.`;
  const line = f.trees >= 1
    ? `The signatures on this document plant ${trees(f.trees)}: mangroves, planted by Treegens. How we count: ${f.site}/impact`
    : `${f.plans === false ? '' : `${SOFT_LINE} `}How we count: ${f.site}/impact`;
  return [paper, line];
}

/** Sheets for the people of an envelope: everyone on it would have had a paper copy. */
export const sheetsFor = (pageCount: number, people: number) => sheetsSaved(pageCount, people);

