// gov-G14: government billing (research/government.json, design.batches G14).
//   1. BILLING_MODE=deployment (src/lib/billingmode.ts, src/server/billingmode.ts): nothing counted, held or expiring,
//      no call to the payment provider, the plan's routes 404, sending without a signature limit, Settings, Plan as
//      one line about the agreement. The default stays the consumer product.
//   2. The price table (src/lib/govpricing.ts) and its rules.
//   3. Tree commitments per contract, filled in by the operator; /impact lists signed ones only.
//   4. /pricing/government built from the table.
//   5. The total-cost calculator's arithmetic for 1M, 10M and 100M signatures with fixed inputs.
import { readEnglish } from './words.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, signAll, tokenFor, type Server } from './helpers.ts';
import * as BM from '../src/lib/billingmode.ts';

// A government server that was also given payment settings by mistake: they must be ignored.
process.env.BILLING_MODE = 'deployment';
process.env.STRIPE_SECRET_KEY = 'sk_test_should_be_ignored';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ignored';
process.env.STRIPE_PRICE_GROVE = 'price_ignored';
process.env.LICENSE_HOLDER = 'Example Ministry of Records';
process.env.AGREEMENT_REF = 'EMR-2026-014';
process.env.AGREEMENT_UNTIL = '2099-12-31';
const OP = 'op@g14.example';
process.env.OPERATOR_EMAILS = OP;

let db: Server['db'];
const outside: string[] = [];
const realFetch = globalThis.fetch;
let sender: Client, op: Client, stranger: Client;
let accountId: string;

/** Every message a person reads: no em dash, at least two sentences. */
const plain = (msg: string) => {
  assert.ok(typeof msg === 'string' && msg.length > 20, msg);
  assert.ok(!/—/.test(msg), `em dash in: ${msg}`);
  assert.ok(msg.split(/(?<=\.)\s+/).length >= 2, `one sentence only: ${msg}`);
};
const count = (table: string) => db.get(`SELECT COUNT(*) n FROM ${table}`).n as number;

before(async () => {
  // Nothing in this file may reach the network: every call is recorded and refused.
  globalThis.fetch = (async (u: any) => {
    outside.push(String(u?.url ?? u));
    throw new Error('no network in tests');
  }) as any;
  const s = await boot();
  db = s.db;
  op = await signUp('Opal Operator', OP, '198.51.140.1');
  sender = await signUp('Gita Clerk', 'gita@agency.example', '198.51.140.2');
  stranger = await signUp('Sam Stranger', 'sam@else.example', '198.51.140.3');
  accountId = (await sender.get('/me')).data.account.id;
});
after(() => {
  globalThis.fetch = realFetch;
});

test('1. deployment mode takes the payment settings away, so nothing reads them', () => {
  assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
  assert.equal(process.env.STRIPE_WEBHOOK_SECRET, undefined);
  assert.equal(process.env.STRIPE_PRICE_GROVE, undefined);
});

test('1. signing up, sending and signing never touch the signature ledger; sending has no limit', async () => {
  // More documents than the 3 welcome signatures of the consumer product, each to a new signer.
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e = await simple(sender, `citizen${i}@public.example`);
    const r = await sender.post(`/envelopes/${e.id}/send`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids.push(e.id);
  }
  for (const [i, eid] of ids.entries()) assert.equal((await signAll(eid, `citizen${i}@public.example`)).status, 200);
  for (const t of ['credits', 'credit_lots', 'credit_holds', 'credit_draws', 'payments']) assert.equal(count(t), 0, `${t} stays empty`);
  // No tree line per signature: nothing was paid per signature.
  const seen = (await new Client().get(`/sign/${tokenFor(ids[0], 'citizen0@public.example')}/impact`)).data;
  assert.equal(seen.finish, 0);
  assert.equal(seen.done?.trees ?? 0, 0);
  assert.deepEqual(outside.filter((u) => /stripe/i.test(u)), [], 'the payment provider is never called');
});

test('1. the plan routes answer 404 in plain words, for people, strangers and the payment provider alike', async () => {
  const tries: [Client, string, string][] = [
    [sender, 'GET', '/billing'], [sender, 'POST', '/billing/checkout'], [sender, 'POST', '/billing/topup'], [sender, 'POST', '/billing/redeem'],
    [sender, 'POST', '/billing/cancel'], [sender, 'POST', '/billing/refund'], [new Client(), 'GET', '/public/billing/stop?t=x'],
    [new Client(), 'POST', '/public/billing/find'], [new Client(), 'POST', '/stripe/webhook'], [op, 'GET', '/operator/billing/lookup?q=x'],
  ];
  for (const [c, method, url] of tries) {
    const r = await c.call(method, url, method === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${method} ${url}`);
    plain(r.data.error);
  }
  // Paths that only look alike are not caught.
  assert.equal((await sender.get('/billing-mode')).status, 200);
  assert.deepEqual(outside.filter((u) => /stripe/i.test(u)), []);
});

test('1. Settings, Plan is one line naming the agreement; parts not set are left out', async () => {
  const m = (await sender.get('/billing-mode')).data;
  assert.equal(m.mode, 'deployment');
  assert.equal(m.line, 'This service is provided under Example Ministry of Records\'s agreement EMR-2026-014, valid until 31 December 2099. Nothing is counted or charged per signature here, and people who sign never pay.');
  const { agreementLine, agreementOf, billingModeWarnings } = await import('../src/lib/billingmode.ts');
  assert.equal(agreementLine(agreementOf({})), 'This service is provided under an agreement with the people who run this server. Nothing is counted or charged per signature here, and people who sign never pay.');
  const ended = agreementLine(agreementOf({ LICENSE_HOLDER: 'City of Example', AGREEMENT_UNTIL: '2020-01-31' }));
  assert.match(ended, /which was valid until 31 January 2020\. That date has passed\. Nothing has stopped or been locked/);
  // It does not promise that the agreement will be renewed.
  assert.ok(!/renew the agreement/.test(ended));
  // A date that is not a date, markup and control characters never reach the screen.
  const odd = agreementOf({ LICENSE_HOLDER: '<b>Evil</b>\u0007 Office', AGREEMENT_UNTIL: '2027-02-30' });
  assert.equal(odd.until, null);
  assert.equal(odd.holder, 'b Evil /b Office');
  assert.equal(new Set(billingModeWarnings({ BILLING_MODE: 'deploymnet' })).size, 1);
  plain(billingModeWarnings({ BILLING_MODE: 'deploymnet' })[0]);
  const w = billingModeWarnings({ BILLING_MODE: 'deployment', AGREEMENT_UNTIL: 'next year' });
  assert.equal(w.length, 2);
  w.forEach(plain);
  assert.deepEqual(billingModeWarnings({}), []);
  // Every account on the server reads the same line, and nobody who is not signed in does.
  assert.equal((await stranger.get('/billing-mode')).data.mode, 'deployment');
  assert.equal((await new Client().get('/billing-mode')).status, 401);
});

test('1. the Settings page shows the agreement line in place of the plan, and the plan everywhere else', () => {
  const page = fs.readFileSync('src/app/app/settings/page.tsx', 'utf8');
  assert.match(page, /tab === 'billing' && <AgreementPlan plan=\{<Billing \/>\} \/>/);
  const comp = readEnglish('src/components/settings/AgreementPlan.tsx');
  // The line comes with /me, so the plan draws at once wherever the mode is not deployment, with no extra loading.
  assert.match(comp, /if \(!me\?\.agreement\) return <>\{plan\}<\/>/);
  assert.ok(!/Loading/.test(comp));
  // Headed like its tab: one name for one place.
  assert.match(comp, /<h2>Plan<\/h2>/);
});

test('1. /me carries the agreement line on a deployment server, and nothing of the kind elsewhere', async () => {
  const me = (await sender.get('/me')).data;
  assert.equal(me.agreement, (await sender.get('/billing-mode')).data.line);
  delete process.env.BILLING_MODE;
  try {
    assert.equal('agreement' in (await sender.get('/me')).data, false);
  } finally {
    process.env.BILLING_MODE = 'deployment';
  }
});

// Last of point 1: back to the default, the consumer product counts again (the switch is the only difference).
test('1. with BILLING_MODE unset the same server counts signatures again', async () => {
  delete process.env.BILLING_MODE;
  process.env.STRIPE_SECRET_KEY = 'sk_test_back';
  const { creditsEnabled } = await import('../src/server/credits.ts');
  assert.equal(creditsEnabled(), true);
  assert.equal((await sender.get('/billing-mode')).data.mode, 'signatures');
  assert.notEqual((await sender.get('/billing')).status, 404);
  process.env.BILLING_MODE = 'deployment';
  // The next request takes the setting away again before anything reads it.
  assert.equal((await sender.get('/billing')).status, 404);
  assert.equal(creditsEnabled(), false);
});

// ---- 2. The price table ------------------------------------------------------------------------------------------

test('2. one table: bands by signatures a year, nothing invented while the owner has not decided', async () => {
  const g = await import('../src/lib/govpricing.ts');
  const P = g.GOV_PRICING;
  assert.deepEqual(P.bands.map((b) => b.upTo), [100_000, 1_000_000, 10_000_000, null]);
  assert.equal(g.bandWords(P.bands[3]), 'More than 10,000,000 signatures a year');
  assert.equal(g.bandFor(1).key, 'b100k');
  assert.equal(g.bandFor(100_000).key, 'b100k');
  assert.equal(g.bandFor(100_001).key, 'b1m');
  assert.equal(g.bandFor(100_000_000).key, 'more');
  // Not decided yet: no fee, no hosted offer, no tree line. The page says so instead of a number.
  for (const b of P.bands) {
    assert.equal(g.feeWords(b.selfHosted, P.currencies[0] || null), 'Not published yet');
    assert.equal(g.feeWords(b.hosted, 'EUR'), 'Not offered yet');
    assert.equal(g.treeLine(b), null);
  }
  // Once filled in, the same functions print it.
  const filled = { ...P, currencies: ['EUR'], treeSharePct: 10, bands: P.bands.map((b, i) => ({ ...b, selfHosted: { EUR: 1000 * (i + 1) }, treesPerYear: 500 * (i + 1) })) };
  assert.equal(g.feeWords(filled.bands[1].selfHosted, 'EUR'), 'EUR 2,000 a year');
  assert.equal(g.feeWords(filled.bands[1].selfHosted, 'USD'), 'Not published yet');
  assert.equal(g.treeLine(filled.bands[1], filled), '10% of each government contract fee funds mangrove planting with Treegens: 1,000 trees a year for this band.');
  const rules = g.contractRules().join(' ');
  for (const must of [/consumer price index/, /90 days/, /multi-year/, /written acceptance/, /once a year/, /for convenience/, /do not apply to a government contract/]) assert.match(rules, must);
  assert.match(g.ALWAYS_INCLUDED.join(' '), /citizens never pay/);
  // No other product's price, no comparison claim, no em dash, anywhere in the file.
  const src = fs.readFileSync('src/lib/govpricing.ts', 'utf8');
  assert.ok(!/—/.test(src));
  assert.ok(!/cheaper|docusign|adobe sign/i.test(src.replace(/nothing says "cheaper than" anyone/, '')));
});

// ---- 3. Tree commitments per contract ----------------------------------------------------------------------------

const COMMIT = { holder: 'City of Example', agreement_ref: 'CE-2026-7', band: 'b1m', share_pct: 10, trees_per_year: 4000, starts_on: '2026-01-01', ends_on: '2028-12-31' };
const STATEMENT = { year: 2026, sites: 'Site A, coastal estuary', planted_from: '2026-03-01', planted_to: '2026-05-30', species: 'Rhizophora mucronata', trees: 4100, evidence: 'https://evidence.example/photos\nhttps://evidence.example/partner-report.pdf' };

test('3. only the operator fills the table; everyone else gets 404', async () => {
  for (const c of [sender, stranger]) {
    assert.equal((await c.get('/operator/tree-commitments')).status, 404);
    assert.equal((await c.post('/operator/tree-commitments', COMMIT)).status, 404);
  }
  assert.equal((await new Client().post('/operator/tree-commitments', COMMIT)).status, 401);
  assert.equal(count('tree_commitments'), 0);
});

test('3. a commitment is checked field by field, in words that say what to change', async () => {
  const bads: any[] = [
    { ...COMMIT, holder: '  ' }, { ...COMMIT, agreement_ref: '' }, { ...COMMIT, band: 'b5' }, { ...COMMIT, share_pct: 0 }, { ...COMMIT, share_pct: 101 },
    { ...COMMIT, trees_per_year: 2.5 }, { ...COMMIT, trees_per_year: -1 }, { ...COMMIT, starts_on: '2026-02-30' }, { ...COMMIT, ends_on: '2025-01-01' },
  ];
  for (const b of bads) {
    const r = await op.post('/operator/tree-commitments', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    plain(r.data.error);
  }
  assert.equal(count('tree_commitments'), 0);
});

test('3. /impact lists signed contracts only, each with its yearly planting statement and evidence', async () => {
  const draft = (await op.post('/operator/tree-commitments', COMMIT)).data.commitment;
  assert.equal(draft.status, 'draft');
  const other = (await op.post('/operator/tree-commitments', { ...COMMIT, holder: 'Region still negotiating', agreement_ref: 'R-1' })).data.commitment;
  // A draft is never public.
  assert.deepEqual((await new Client().get('/public/tree-commitments')).data.commitments, []);
  // Signing needs a real day that has come.
  for (const day of ['', '2026-13-01', '2999-01-01']) {
    const r = await op.post(`/operator/tree-commitments/${draft.id}/signed`, { signed: true, signed_on: day });
    assert.equal(r.status, 400);
    plain(r.data.error);
  }
  assert.equal((await op.post(`/operator/tree-commitments/${draft.id}/signed`, { signed: true, signed_on: '2026-01-10' })).data.commitment.status, 'signed');
  // A statement: every part is required, links are https only, the year has started, one per year.
  for (const b of [{ ...STATEMENT, sites: '' }, { ...STATEMENT, species: '' }, { ...STATEMENT, evidence: '' }, { ...STATEMENT, evidence: 'http://plain.example/x' },
    { ...STATEMENT, evidence: 'javascript:alert(1)' }, { ...STATEMENT, year: 2999 }, { ...STATEMENT, planted_to: '2999-01-01' }, { ...STATEMENT, planted_to: '2026-01-01' }, { ...STATEMENT, trees: 'many' }]) {
    const r = await op.post(`/operator/tree-commitments/${draft.id}/statements`, b);
    assert.equal(r.status, 400, JSON.stringify(b));
    plain(r.data.error);
  }
  assert.equal((await op.post(`/operator/tree-commitments/${draft.id}/statements`, STATEMENT)).status, 200);
  const twice = await op.post(`/operator/tree-commitments/${draft.id}/statements`, STATEMENT);
  assert.equal(twice.status, 409);
  plain(twice.data.error);
  // Statements on a draft are kept but not shown.
  assert.equal((await op.post(`/operator/tree-commitments/${other.id}/statements`, STATEMENT)).status, 200);
  const pub = (await new Client().get('/public/tree-commitments')).data.commitments;
  assert.equal(pub.length, 1);
  assert.equal(pub[0].holder, 'City of Example');
  assert.equal(pub[0].trees_per_year, 4000);
  assert.equal(pub[0].statements.length, 1);
  assert.deepEqual(pub[0].statements[0].evidence, ['https://evidence.example/photos', 'https://evidence.example/partner-report.pdf']);
  assert.equal(pub[0].statements[0].trees, 4100);
  // Nothing about who typed it in, or internal ids of statements, reaches the public.
  assert.ok(!JSON.stringify(pub).includes(OP));
  assert.equal(pub[0].statements[0].id, undefined);
  // Back to a draft: gone from the public list at once.
  await op.post(`/operator/tree-commitments/${draft.id}/signed`, { signed: false });
  assert.deepEqual((await new Client().get('/public/tree-commitments')).data.commitments, []);
  await op.post(`/operator/tree-commitments/${draft.id}/signed`, { signed: true, signed_on: '2026-01-10' });
  // The operator sees everything, drafts too.
  assert.equal((await op.get('/operator/tree-commitments')).data.commitments.length, 2);
  // A statement removed by mistake can be added again; a wrong id is said in words.
  const sid = (await op.get('/operator/tree-commitments')).data.commitments.find((c: any) => c.id === draft.id).statements[0].id;
  const gone = await op.call('DELETE', `/operator/tree-commitments/${other.id}/statements/${sid}`);
  assert.equal(gone.status, 404);
  plain(gone.data.error);
});

test('3. the impact page shows the commitments section only when there is a signed one, and words it as the rules say', () => {
  const page = readEnglish('src/app/impact/page.tsx');
  assert.match(page, /<Commitments \/>/);
  const comp = fs.readFileSync('src/components/Commitments.tsx', 'utf8');
  assert.match(comp, /if \(!list\?\.length\) return null/);
  assert.match(comp, /TREE_RULES/);
  assert.ok(!/gift to you|thank you for|reward/i.test(comp));
});

// ---- 4. /pricing/government ---------------------------------------------------------------------------------------

test('4. the government price page is built from govpricing.ts alone, and promises nothing the table does not hold', () => {
  const src = fs.readFileSync('src/app/pricing/government/page.tsx', 'utf8');
  assert.match(src, /from '@\/lib\/govpricing'/);
  for (const fn of ['GOV_PRICING', 'bandWords', 'feeWords', 'treeLine', 'contractRules', 'ALWAYS_INCLUDED', 'TREE_RULES', 'OPEN_LICENCE']) assert.ok(src.includes(fn), fn);
  // No number, price or currency of its own, no comparison with anyone, no em dash.
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/\b\d{3,}\b/.test(code.replace(/marginBottom: 0|style=\{[^}]*\}/g, '')), 'a number written into the page');
  assert.ok(!/[$€£]\s?\d|\b(EUR|USD|GBP)\b/.test(code), 'a price written into the page');
  assert.ok(!/cheaper|docusign|adobe sign|than any/i.test(src));
  assert.ok(!/—/.test(src));
  // Monthly signatures and their expiry appear only to say they do not apply.
  assert.ok(!/expire|top-up|top up/i.test(code.replace(/contractRules\(P\)/, '')));
  // In the footer of every public page, and from the calculator.
  assert.match(fs.readFileSync('src/components/Public.tsx', 'utf8'), /<Link href="\/pricing\/government">Government prices<\/Link>/);
  assert.match(fs.readFileSync('src/app/tco/page.tsx', 'utf8'), /href="\/pricing\/government"/);
  assert.match(src, /href="\/tco"/);
});

// ---- 5. The total-cost calculator ---------------------------------------------------------------------------------

test('5. the arithmetic for 1M, 10M and 100M signatures a year with fixed inputs', async () => {
  const { tco, TCO_SIZES, EMPTY_TCO } = await import('../src/lib/govpricing.ts');
  assert.deepEqual(TCO_SIZES, [1_000_000, 10_000_000, 100_000_000]);
  const base = { ...EMPTY_TCO, serverMonth: 200, staffHoursMonth: 10, staffHourCost: 50, supportYear: 10_000, smsPerSignature: 0.5, smsCost: 0.05, emailsPerSignature: 3, emailCost: 0.001, perEnvelope: 2, signaturesPerEnvelope: 2 };
  const want: [number, number, Record<string, number>, number, number][] = [
    [1_000_000, 2, { hosting: 4800, staff: 6000, support: 10_000, sms: 25_000, email: 3000 }, 48_800, 1_000_000],
    [10_000_000, 4, { hosting: 9600, staff: 6000, support: 10_000, sms: 250_000, email: 30_000 }, 305_600, 10_000_000],
    [100_000_000, 20, { hosting: 48_000, staff: 6000, support: 10_000, sms: 2_500_000, email: 300_000 }, 2_864_000, 100_000_000],
  ];
  for (const [signatures, servers, lines, total, compare] of want) {
    const r = tco({ ...base, signatures, servers });
    assert.deepEqual(Object.fromEntries(r.lines.map((l) => [l.key, l.amount])), lines, String(signatures));
    assert.equal(r.total, total);
    assert.equal(r.perSignature, total / signatures);
    assert.equal(r.licencePerSignature, 0);
    assert.deepEqual(r.compare, { envelopes: signatures / 2, amount: compare });
    assert.deepEqual(r.servers, { n: servers, from: 'yours' });
    for (const l of r.lines) assert.deepEqual(l.missing, []);
  }
  // Nothing entered: everything 0, each empty box named, servers "not yet measured", no comparison.
  const empty = tco(EMPTY_TCO);
  assert.equal(empty.total, 0);
  assert.equal(empty.perSignature, null);
  assert.equal(empty.compare, null);
  assert.equal(empty.servers.from, 'none');
  assert.ok(empty.lines.find((l) => l.key === 'hosting')!.missing.includes('servers needed (not yet measured)'));
  // Until G26 measures it there is no figure of ours; once there is one, it fills an empty servers box.
  const { MEASURED_SIGNATURES_PER_SERVER_YEAR } = await import('../src/lib/govpricing.ts');
  assert.equal(MEASURED_SIGNATURES_PER_SERVER_YEAR, null);
  assert.deepEqual(tco({ ...base, signatures: 1_000_000 }, 300_000).servers, { n: 4, from: 'measured' });
  // Nonsense is counted as 0, never as a negative or a NaN.
  const odd = tco({ ...base, signatures: 1000, serverMonth: -5, servers: NaN, smsCost: Infinity });
  assert.ok(Number.isFinite(odd.total) && odd.total >= 0);
  assert.equal(odd.lines.find((l) => l.key === 'hosting')!.amount, 0);
});

test('5. the calculator page prints the licence line, offers the three sizes and a printable view, and prints no price of ours', () => {
  const src = fs.readFileSync('src/app/tco/Calculator.tsx', 'utf8');
  assert.match(src, /Licence cost per signature: 0/);
  assert.match(src, /TCO_SIZES\.map/);
  assert.match(src, /window\.print\(\)/);
  assert.match(src, /not yet measured/i);
  assert.ok(!/cheaper|docusign|adobe sign/i.test(src));
  assert.ok(!/—/.test(src));
  assert.match(fs.readFileSync('src/app/styles/govpricing.css', 'utf8'), /@media print/);
});

// ---- Repairs after review (tests/out/verify-g14, tests/out/ux-g14) -----------------------------------------------

test('repair: on a deployment server a new account sends to more than the consumer daily limit on day one, and is told nothing about paying', async () => {
  const fresh = await signUp('Nia Newclerk', 'nia@agency.example', '198.51.140.9');
  // 55 is more than NEW_ACCOUNT_DAILY_RECIPIENTS (50 in an account's first week).
  for (let i = 0; i < 55; i++) {
    const e = await simple(fresh, `resident${i}@public.example`);
    const r = await fresh.post(`/envelopes/${e.id}/send`);
    assert.equal(r.status, 200, `envelope ${i + 1}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  // More team invitations than the consumer limit of 20 a day.
  for (let i = 0; i < 22; i++) {
    const r = await fresh.post('/account/invites', { email: `colleague${i}@agency.example` });
    assert.equal(r.status, 200, `invite ${i + 1}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  // The filter for fake payment notices still protects the people emailed, and says how it is lifted here: by a
  // person, never by a payment that cannot be made on this server.
  const lure = await simple(fresh, 'resident-x@public.example', { subject: 'PayPal invoice: your payment of $499 was charged, call +1 800 555 0199' });
  const no = await fresh.post(`/envelopes/${lure.id}/send`);
  assert.equal(no.status, 422);
  plain(no.data.error);
  assert.match(no.data.error, /a person who runs this server has cleared the account/);
  assert.ok(!/payment that is at least|pay for anything|Plan page/.test(no.data.error), no.data.error);
  const { paidTrustText } = await import('../src/lib/policy.ts');
  const { payNotYet } = await import('../src/lib/paylink.ts');
  assert.ok(!/payment that is at least/.test(paidTrustText()));
  assert.ok(!/top-up/.test(payNotYet(14)));
  // The consumer words are unchanged where the mode is not deployment.
  assert.match(paidTrustText(14, false), /payment that is at least 14 days old/);
  assert.match(payNotYet(14, false), /top-up/);
});

test('repair: "signed" must be a real boolean, so a string never publishes a draft', async () => {
  const c = (await op.post('/operator/tree-commitments', { ...COMMIT, agreement_ref: 'STR-1' })).data.commitment;
  for (const signed of ['false', 'true', 1, null, undefined]) {
    const r = await op.post(`/operator/tree-commitments/${c.id}/signed`, { signed, signed_on: '2026-02-01' });
    assert.equal(r.status, 400, String(signed));
    plain(r.data.error);
  }
  assert.equal(db.get('SELECT status FROM tree_commitments WHERE id=?', c.id).status, 'draft');
  assert.ok(!(await new Client().get('/public/tree-commitments')).data.commitments.some((x: any) => x.agreement_ref === 'STR-1'));
});

test('repair: a share that rounds to 0% is refused, and a statement must fall in its year and inside the contract', async () => {
  const z = await op.post('/operator/tree-commitments', { ...COMMIT, agreement_ref: 'Z-1', share_pct: 0.001 });
  assert.equal(z.status, 400);
  plain(z.data.error);
  assert.equal((await op.post('/operator/tree-commitments', { ...COMMIT, agreement_ref: 'Z-2', share_pct: 0.25 })).data.commitment.share_pct, 0.25);
  const later = (await op.post('/operator/tree-commitments', { ...COMMIT, agreement_ref: 'L-1', starts_on: '2026-06-01', ends_on: '2026-12-31' })).data.commitment;
  const S = { ...STATEMENT, year: 2026, planted_from: '2026-07-01', planted_to: '2026-08-01' };
  for (const b of [
    { ...S, year: 2025 }, // the days are in 2026
    { ...S, planted_from: '2010-01-01', planted_to: '2010-02-01' }, // not in the year
    { ...S, planted_from: '2026-01-01', planted_to: '2026-03-01' }, // before the contract
    { ...S, year: 2001, planted_from: '2001-01-01', planted_to: '2001-02-01' }, // years before the contract
  ]) {
    const r = await op.post(`/operator/tree-commitments/${later.id}/statements`, b);
    assert.equal(r.status, 400, JSON.stringify(b));
    plain(r.data.error);
  }
  assert.equal((await op.post(`/operator/tree-commitments/${later.id}/statements`, S)).status, 200);
});

test('repair: in deployment mode no page offers money tools, consumer prices, top-ups or trees per signature', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  // The operator's money tools call routes that answer 404 here, so they are not drawn; the tree table sits last,
  // after the people who are waiting.
  const op = read('src/app/app/operator/page.tsx');
  assert.match(op, /\{!me\?\.agreement && <BillingTools \/>\}/);
  assert.ok(op.indexOf('<TreeCommitments />') > op.indexOf('Paused accounts'), 'the tree table comes after the queue');
  // The home page and the price page say what is paid there: nothing.
  for (const f of ['src/app/page.tsx', 'src/app/pricing/page.tsx']) assert.match(read(f), /if \(isDeploymentBilling\(\)\) return <DeploymentHome /);
  const home = read('src/components/DeploymentHome.tsx');
  assert.match(home, /GOV_PUBLIC_LINE/);
  assert.ok(!/US\$|top-up|expire|a month/i.test(home.replace(/\/\/.*$/gm, '')));
  // The footer leaves out the money line and "Stop a subscription"; /impact says trees are per contract.
  const pub = read('src/components/Public.tsx');
  assert.match(pub, /\{!gov && <p>\{MONEY_SHORT\}<\/p>\}/);
  assert.match(pub, /\{!gov && <Link href="\/help#cancel">Stop a subscription<\/Link>\}/);
  assert.match(readEnglish('src/app/impact/page.tsx'), /gov \? \(\s*<div className="card">\s*<h2[^>]*>Trees here are set per contract/);
  // The help page answers "Does anyone pay here?" in place of cancelling, refunds, signatures and codes.
  const help = read('src/app/help/page.tsx');
  assert.match(help, /\{gov \? <QA id="paying" q="Does anyone pay here\?">/);
  assert.match(help, /\{!gov && <QA id="unknown-charge"/);
  const { GOV_HELP, GOV_PUBLIC_LINE } = BM;
  for (const s of [GOV_HELP, GOV_PUBLIC_LINE]) { plain(s); assert.ok(!/valid|will hold up/i.test(s)); }
});

test('repair: /public/billing-mode says the mode and nothing about the agreement', async () => {
  const r = await new Client().get('/public/billing-mode');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { mode: 'deployment' });
});

test('repair: the calculator speaks of documents, checks the signatures box, and starts with one line', () => {
  const src = fs.readFileSync('src/app/tco/Calculator.tsx', 'utf8');
  const shown = src.replace(/\/\/.*$/gm, '').replace(/perEnvelope|signaturesPerEnvelope|r\.compare\.envelopes/g, '');
  assert.ok(!/envelope/i.test(shown), 'no "envelope" on a public page');
  assert.match(src, /aria-invalid=\{bad\('signatures'\) \|\| undefined\}/);
  assert.match(src, /Enter the signatures a year, or pick a size above, to see the total\./);
  assert.match(fs.readFileSync('src/app/styles/govpricing.css', 'utf8'), /\.tco \.btn, \.tco summary, \.gov-commit \.btn[^{]*\{ min-height: 44px/);
  // The operator's commitments: a date box next to the button, no pop-up.
  const op = fs.readFileSync('src/app/app/operator/commitments.tsx', 'utf8');
  assert.ok(!/window\.prompt/.test(op));
  assert.match(op, /type="date"/);
  assert.match(fs.readFileSync('src/components/Commitments.tsx', 'utf8'), /<details key=\{s\.year\} data-fold>/);
});
