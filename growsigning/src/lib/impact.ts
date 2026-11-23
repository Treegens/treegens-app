// Every environmental number shown in the product comes from this file.
// These are estimates. The sources and the reasoning are spelled out on /impact so nobody has to take them on faith.

export const IMPACT = {
  // One average pulpwood tree yields roughly 8,333 sheets of office paper (Conservatree's widely used estimate).
  sheetsPerTree: 8333,
  // Paper making is water hungry. About 10 litres per A4 sheet is the commonly cited figure.
  litresWaterPerSheet: 10,
  // Wood needed per sheet, in grams (about 2x to 3x the weight of the 5 g sheet it becomes).
  gramsWoodPerSheet: 15,
};

// Sheets an envelope would have used on paper: every party gets one printed copy of every page.
// "Parties" is the number of recipients, at least one. The sender's own copy is not counted, to stay conservative.
export function sheetsSaved(pages: number, recipients: number): number {
  return Math.max(0, Math.round(pages)) * Math.max(1, Math.round(recipients));
}

export function impactOf(sheets: number) {
  return {
    sheets,
    trees: sheets / IMPACT.sheetsPerTree,
    litresWater: sheets * IMPACT.litresWaterPerSheet,
    kgWood: (sheets * IMPACT.gramsWoodPerSheet) / 1000,
  };
}

export function fmtTrees(trees: number): string {
  if (trees >= 10) return Math.round(trees).toLocaleString('en');
  if (trees >= 1) return trees.toFixed(1);
  if (trees >= 0.01) return trees.toFixed(2);
  return trees > 0 ? trees.toFixed(4) : '0';
}

export const fmtNum = (n: number, digits = 0) => n.toLocaleString('en', { maximumFractionDigits: digits });

// A total is shown only once it is large enough to mean something: the account's paper saved (the sidebar), and the
// public counters. Until then the place it would stand in is simply absent, never a tiny number or "...". The saving
// of one document is always shown where a person sends or finishes it.
// treesPublic: the total everybody sees (the home page and /impact) waits for more, and for money to have been paid
// in at all (publicTreesShown): a few free trial signatures on a server nobody has paid yet are not a public total.
export const TOTALS_FROM = { sheets: 1000, treesPlanted: 10, treesPublic: 100 };
/** May the public tree total be shown? Only from TOTALS_FROM.treesPublic up, and only once customers have paid something. */
export const publicTreesShown = (i: { treesFunded?: unknown; donatedUsd?: unknown } | null | undefined): boolean =>
  Number(i?.treesFunded) >= TOTALS_FROM.treesPublic && Number(i?.donatedUsd) > 0;
export const totalWorthShowing = (sheets: unknown): boolean => Number(sheets) >= TOTALS_FROM.sheets;

// Pricing. One number per rule, used by the server, the app and the public pages alike.
export const PRICING = {
  planName: 'Grove',
  monthlyUsd: 9, // the monthly plan
  monthlySignatures: 9, // signatures added to the balance with every monthly payment
  topUpUsd: 1, // one extra signature
  treesPerSignature: 5, // trees planted for every signature: plan, top-up, free trial and reward signatures alike
  welcomeSignatures: 3, // free signatures for a new account, once, to try the product
  topUpMax: 500, // most signatures in one top-up
};

// ---- Trees: one rule, one counting function ---------------------------------------------------------------------
// Every signature plants 5 trees (the owner's decision of 23 November 2026). It makes no difference where the
// signature came from: the free ones a new account starts with, the monthly plan, a top-up, a free code or a reward
// for inviting a friend. The trees are mangroves, planted by Treegens.
//
// Before that day the rule was another one: 10 mangroves for a signature that was paid for, none for a free one.
// A signature finished before the change keeps what was promised for it then, so totals never change after the fact,
// and a signing record that was already issued is never written again.
/** The first moment of the 5 trees rule (UTC). Signatures finished before it are counted by the rule of their day. */
export const TREES_5_FROM = '2026-11-23T00:00:00.000Z';
/** The same day in words, for the pages that explain the counting. */
export const TREES_RULE_DAY = '23 November 2026';
/**
 * What was promised before TREES_5_FROM: 10 mangroves for a signature that was paid for, none for a free one, and in
 * the totals 10 for every dollar paid, whether its signatures were used or not (perUsd). Money paid before the change
 * keeps that promise in every total (treesOfOldMoney in src/server/impact.ts).
 */
export const TREES_BEFORE = { paid: 10, free: 0, perUsd: 10 };

/**
 * The one counting function: the trees one finished signature plants. `at` is when it was finished (now when left
 * out) and `paid` whether it came out of a payment, which only matters for a signature from before the change.
 */
export function treesForSignature(s: { at?: string | null; paid?: boolean } = {}): number {
  if (s.at && s.at < TREES_5_FROM) return s.paid ? TREES_BEFORE.paid : TREES_BEFORE.free;
  return PRICING.treesPerSignature;
}
/** Trees for a number of signatures under today's rule: 9 signatures, 45 trees. */
export const treesFor = (signatures: number) => Math.max(0, Math.floor(Number(signatures) || 0)) * PRICING.treesPerSignature;

// How a price is written on a public page. A bare "$9" reads as nine local dollars in Australia, Canada, Singapore,
// New Zealand or Mexico, and only US dollars are accepted, so the country is always written out.
export const usd = (amount: number | string): string => `US$${amount}`;
/** The one line about currency under every public price list. */
export const CURRENCY_NOTE = 'Prices are in US dollars, and so is every payment. If your card is in another currency, your bank converts the amount and may add a fee of its own.';

// Signing is always free for recipients. What is paid, less card fees, goes to tree planting.
export const PLANS = {
  seedling: { name: 'Seedling', price: 0, blurb: `Try it with ${PRICING.welcomeSignatures} free signatures. Signing your own documents is always free.` },
  grove: { name: PRICING.planName, price: PRICING.monthlyUsd, blurb: `${PRICING.monthlySignatures} signatures every month. Top up any time at $${PRICING.topUpUsd} each.` },
} as const;
export type PlanId = keyof typeof PLANS;
