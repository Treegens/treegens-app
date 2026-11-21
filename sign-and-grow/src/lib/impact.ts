// Every environmental number shown in the product comes from this file.
// These are estimates. The sources and the reasoning are spelled out on /impact so nobody has to take them on faith.

export const IMPACT = {
  // One average pulpwood tree yields roughly 8,333 sheets of office paper (Conservatree's widely used estimate).
  sheetsPerTree: 8333,
  // Paper making is water hungry. About 10 litres per A4 sheet is the commonly cited figure.
  litresWaterPerSheet: 10,
  // Lifecycle emissions of office paper, roughly 4.5 g CO2e per sheet (about 0.9 kg CO2e per kg of paper, 5 g per sheet).
  gramsCo2PerSheet: 4.5,
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
    kgCo2: (sheets * IMPACT.gramsCo2PerSheet) / 1000,
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
export const TOTALS_FROM = { sheets: 1000, treesPlanted: 10 };
export const totalWorthShowing = (sheets: unknown): boolean => Number(sheets) >= TOTALS_FROM.sheets;

// Pricing. One number per rule, used by the server, the app and the public pages alike.
export const PRICING = {
  planName: 'Grove',
  monthlyUsd: 9, // the monthly plan
  monthlySignatures: 9, // signatures added to the balance with every monthly payment
  topUpUsd: 1, // one extra signature
  treesPerUsd: 10, // mangrove trees planted for every dollar paid
  welcomeSignatures: 3, // free signatures for a new account, once, to try the product
  topUpMax: 500, // most signatures in one top-up
};

export const mangrovesFor = (usd: number) => Math.floor(usd * PRICING.treesPerUsd);

// How a price is written on a public page. A bare "$9" reads as nine local dollars in Australia, Canada, Singapore,
// New Zealand or Mexico, and only US dollars are accepted, so the country is always written out.
export const usd = (amount: number | string): string => `US$${amount}`;
/** The one line about currency under every public price list. */
export const CURRENCY_NOTE = 'Prices are in US dollars, and so is every payment. If your card is in another currency, your bank converts the amount and may add a fee of its own.';

// Signing is always free for recipients. Everything paid goes to tree planting.
export const PLANS = {
  seedling: { name: 'Seedling', price: 0, blurb: `Try it with ${PRICING.welcomeSignatures} free signatures. Signing your own documents is always free.` },
  grove: { name: PRICING.planName, price: PRICING.monthlyUsd, blurb: `${PRICING.monthlySignatures} signatures every month. Top up any time at $${PRICING.topUpUsd} each.` },
} as const;
export type PlanId = keyof typeof PLANS;
