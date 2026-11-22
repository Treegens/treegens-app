// Government prices: the one table that /pricing/government is built from, the contract rules that go with it, the
// tree commitment per contract, and the arithmetic of the total-cost calculator on /tco. Every number a government
// buyer reads comes from this file (research/government.json, G14).
//
// What is decided, and what is not (owner decision 7 is open on 2026-11-22):
//   - Self-hosting under the open licence (EUPL-1.2) is always free. That is decided and printed.
//   - The fixed annual fee per band, the currencies, the support hours and response times, and the share of each fee
//     that funds planting are NOT decided. They stay null (or empty) here, and the page says "not published yet"
//     instead of a number. Fill them in here, in one place, once the owner decides; nothing else needs to change.
//   - Hosting by us or a partner is not offered yet (owner decision 5), so the hosted fee is null for every band and
//     the page says so.
// Rules: no price of any other product is printed anywhere, and nothing says "cheaper than" anyone. Consumer
// signatures that expire each month do not apply to a government contract. Citizens never pay, in any mode.
//
// Pure data and arithmetic: pages, server code and tests can import it.

export const OPEN_LICENCE = 'EUPL-1.2';

/** Amounts by currency code ("EUR": 12000). An empty object means not published yet. */
export type Money = Partial<Record<string, number>>;

export type Band = {
  key: string;
  /** Expected signatures a year, at most. null: more than the band before. */
  upTo: number | null;
  /** The fixed annual fee for support and updates when the agency hosts it itself. */
  selfHosted: Money;
  /** The fixed annual fee when we or a partner host it. null: not offered for this band. */
  hosted: Money | null;
  /** Hours of support a year in the fee. null: not decided yet. */
  supportHours: number | null;
  /** How fast a serious fault is answered, in words ("within 4 working hours"). null: not decided yet. */
  response: string | null;
  /** Mangroves planted each year of the contract for this band. null: not decided yet. */
  treesPerYear: number | null;
};

export type GovPricing = {
  /** The currencies prices are published in, in the order shown. Empty until the owner chooses (decision 2 and 7). */
  currencies: string[];
  bands: Band[];
  /** The share of each contract fee that funds mangrove planting with Treegens, in percent. null: not decided yet. */
  treeSharePct: number | null;
  /** The longest price hold a contract may have, in years. null: not decided yet. */
  holdYearsMax: number | null;
};

export const GOV_PRICING: GovPricing = {
  currencies: [],
  bands: [
    { key: 'b100k', upTo: 100_000, selfHosted: {}, hosted: null, supportHours: null, response: null, treesPerYear: null },
    { key: 'b1m', upTo: 1_000_000, selfHosted: {}, hosted: null, supportHours: null, response: null, treesPerYear: null },
    { key: 'b10m', upTo: 10_000_000, selfHosted: {}, hosted: null, supportHours: null, response: null, treesPerYear: null },
    { key: 'more', upTo: null, selfHosted: {}, hosted: null, supportHours: null, response: null, treesPerYear: null },
  ],
  treeSharePct: null,
  holdYearsMax: null,
};

/** Notice before any price rise takes effect, in days. */
export const RISE_NOTICE_DAYS = 90;

/** In every fee, whatever the band: true of the software, so it is printed as fact. */
export const ALWAYS_INCLUDED = [
  'Every update and security fix, as soon as it is released. They are the same releases everyone gets under the open licence.',
  'No limit on senders, documents or signatures, and no daily limit on the people they send to. Nothing is counted per signature, and there are no overage charges. Text messages, where they are switched on, have a daily limit that the people who run the server set, because each one costs money.',
  'Nothing is ever charged to the people who sign: citizens never pay.',
];

/** The rules every government contract carries, in plain words. The contract itself is written with the buyer's lawyers. */
export function contractRules(p: GovPricing = GOV_PRICING): string[] {
  return [
    'One fixed fee a year, invoiced once a year through your own invoicing system. Nothing else is billed.',
    `A price rise is capped at the rise in the consumer price index named in the contract, and is announced at least ${RISE_NOTICE_DAYS} days before it applies.`,
    p.holdYearsMax ? `A price can be held for up to ${p.holdYearsMax} years in a multi-year contract.` : 'A price can be held for several years in a multi-year contract. The longest hold is written into the contract.',
    'A contract never renews at a new price without your written acceptance. Without it, it renews at the price you have, or ends.',
    'You can end the contract for convenience, with the notice the contract states. You keep your documents and the software: self-hosting under the open licence is free whether or not you have a contract.',
    'The monthly signatures of the consumer plan, and their expiry, do not apply to a government contract.',
  ];
}

const plain = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 0 });

/** "Up to 100,000 a year" or "More than 10,000,000 a year". */
export function bandWords(b: Band, p: GovPricing = GOV_PRICING): string {
  if (b.upTo != null) return `Up to ${plain(b.upTo)} signatures a year`;
  const before = p.bands.filter((x) => x.upTo != null).map((x) => x.upTo as number);
  return `More than ${plain(Math.max(0, ...before))} signatures a year`;
}

/** The band for an expected number of signatures a year. */
export function bandFor(signatures: number, p: GovPricing = GOV_PRICING): Band {
  return p.bands.find((b) => b.upTo != null && signatures <= b.upTo) || p.bands[p.bands.length - 1];
}

/** "EUR 12,000 a year", or the words for a fee that is not published. */
export function feeWords(m: Money | null, currency: string | null): string {
  if (m === null) return 'Not offered yet';
  const v = currency ? m[currency] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? `${currency} ${plain(v)} a year` : 'Not published yet';
}

/**
 * The tree commitment of a band, in the words the contract and the page use, or null while the share or the count is
 * not decided. Per contract, never per signature, never tied to use, and never a gift to anyone.
 */
export function treeLine(b: Band, p: GovPricing = GOV_PRICING): string | null {
  if (p.treeSharePct == null || b.treesPerYear == null) return null;
  return `${p.treeSharePct}% of each government contract fee funds mangrove planting with Treegens: ${plain(b.treesPerYear)} trees a year for this band.`;
}

export const TREE_RULES = [
  'The trees are part of the contract fee. They are planted whether or not the service is used, and they do not depend on how many people sign.',
  'They are not a gift to the public body or to anyone who works there. Nobody receives anything for them.',
  'Once a year a planting statement is published on the impact page: the sites, the dates, the species, the counts, and links to the evidence Treegens provides (geotagged photos and partner reports). People at Treegens put each statement there by hand; the software does not schedule it or check the evidence behind the links.',
];

// ---- The total-cost calculator (/tco) ---------------------------------------------------------------------------

/**
 * Signatures a year that one server was measured to handle, from the load measurements (G26). null until they have
 * been made: the calculator then says "not yet measured" and asks for the agency's own number of servers.
 */
export const MEASURED_SIGNATURES_PER_SERVER_YEAR: number | null = null;

export const TCO_SIZES = [1_000_000, 10_000_000, 100_000_000];

/** What a person types into the calculator. A box left empty is null and counted as 0, and said so. */
export type TcoInput = {
  signatures: number | null;
  /** The agency's own cost of one server for one month. */
  serverMonth: number | null;
  /** Servers needed. null: taken from the measurements when there are some, otherwise counted as 0. */
  servers: number | null;
  staffHoursMonth: number | null;
  staffHourCost: number | null;
  /** The fee of the support band, a year. */
  supportYear: number | null;
  smsPerSignature: number | null;
  smsCost: number | null;
  emailsPerSignature: number | null;
  emailCost: number | null;
  /** For the comparison line only: a price per envelope the user was quoted, and signatures on one envelope. */
  perEnvelope: number | null;
  signaturesPerEnvelope: number | null;
};

export const EMPTY_TCO: TcoInput = {
  signatures: null, serverMonth: null, servers: null, staffHoursMonth: null, staffHourCost: null, supportYear: null,
  smsPerSignature: null, smsCost: null, emailsPerSignature: null, emailCost: null, perEnvelope: null, signaturesPerEnvelope: null,
};

export type TcoLine = { key: string; label: string; amount: number; working: string; missing: string[] };
export type TcoResult = {
  lines: TcoLine[];
  total: number;
  /** null when no signatures were entered. */
  perSignature: number | null;
  /** Always 0: the licence is free. */
  licencePerSignature: 0;
  /** Servers counted, and where the number came from. */
  servers: { n: number; from: 'yours' | 'measured' | 'none' };
  /** The comparison line, from the user's own price per envelope. null when none was entered. */
  compare: { envelopes: number; amount: number } | null;
};

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const has = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
export const amountWords = (n: number): string => n.toLocaleString('en', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const perWords = (n: number): string => (n === 0 ? '0' : n < 0.01 ? n.toPrecision(2) : n.toLocaleString('en', { maximumFractionDigits: 4 }));

/** The annual cost of running it, from the user's own numbers only. */
export function tco(i: TcoInput, measured: number | null = MEASURED_SIGNATURES_PER_SERVER_YEAR): TcoResult {
  const sigs = num(i.signatures);
  const servers = has(i.servers) ? { n: num(i.servers), from: 'yours' as const }
    : measured && sigs ? { n: Math.max(1, Math.ceil(sigs / measured)), from: 'measured' as const } : { n: 0, from: 'none' as const };
  const miss = (pairs: [number | null, string][]) => pairs.filter(([v]) => !has(v)).map(([, w]) => w);
  const lines: TcoLine[] = [
    { key: 'hosting', label: 'Hosting', amount: round2(num(i.serverMonth) * servers.n * 12),
      working: `${amountWords(num(i.serverMonth))} a server a month × ${servers.n} server${servers.n === 1 ? '' : 's'} × 12 months`,
      missing: [...miss([[i.serverMonth, 'cost of a server a month']]), ...(servers.from === 'none' ? ['servers needed (not yet measured)'] : [])] },
    { key: 'staff', label: 'Staff to run it', amount: round2(num(i.staffHoursMonth) * num(i.staffHourCost) * 12),
      working: `${amountWords(num(i.staffHoursMonth))} hours a month × ${amountWords(num(i.staffHourCost))} an hour × 12 months`,
      missing: miss([[i.staffHoursMonth, 'staff hours a month'], [i.staffHourCost, 'cost of a staff hour']]) },
    { key: 'support', label: 'Support and updates', amount: round2(num(i.supportYear)), working: `${amountWords(num(i.supportYear))} a year`, missing: miss([[i.supportYear, 'support fee a year']]) },
    { key: 'sms', label: 'Text messages', amount: round2(sigs * num(i.smsPerSignature) * num(i.smsCost)),
      working: `${amountWords(sigs)} signatures × ${amountWords(num(i.smsPerSignature))} messages each × ${perWords(num(i.smsCost))} a message`,
      missing: miss([[i.smsPerSignature, 'text messages a signature'], [i.smsCost, 'cost of a text message']]) },
    { key: 'email', label: 'Email', amount: round2(sigs * num(i.emailsPerSignature) * num(i.emailCost)),
      working: `${amountWords(sigs)} signatures × ${amountWords(num(i.emailsPerSignature))} emails each × ${perWords(num(i.emailCost))} an email`,
      missing: miss([[i.emailsPerSignature, 'emails a signature'], [i.emailCost, 'cost of an email']]) },
  ];
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  const per = num(i.signaturesPerEnvelope) || 1;
  const compare = has(i.perEnvelope) && sigs ? { envelopes: Math.ceil(sigs / per), amount: round2(Math.ceil(sigs / per) * num(i.perEnvelope)) } : null;
  return { lines, total, perSignature: sigs ? total / sigs : null, licencePerSignature: 0, servers, compare };
}

export const perSignatureWords = (n: number | null): string => (n == null ? 'Enter the signatures a year' : perWords(n));
