// The 5 trees rule (the owner's decision of 23 November 2026): EVERY signature plants 5 trees, the free trial ones,
// plan signatures, top-ups and rewards alike. One constant, one counting function, and every sentence, price line
// and total worked out from them. Signatures from before the change keep what was promised then (10 when paid for,
// none when free), and the signer is told on the first screen of their link, next to Finish and on the finished
// screen. The payment provider is the stand-in of the billing tests (tests/stripe-fake.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { boot, Client, signUp, mailTo, simple, signAll, tokenFor, type Server } from './helpers.ts';
import './stripe-fake.ts';
import { PRICING, TREES_5_FROM, TREES_BEFORE, TREES_RULE_DAY, treesForSignature, treesFor } from '../src/lib/impact.ts';
import { TREES_PER_SIGNATURE, RULE_LINE, RULE_FULL, openLine, OPEN_UNDER, finishLine, mailLine, signerWords, senderWords, plantedLine, reviewPlus, recordLines } from '../src/lib/impactwords.ts';
import { SITE_TITLE, OG_ALT } from '../src/lib/site.ts';
import { expiryRuleText } from '../src/lib/policy.ts';
import { englishIf } from './words.ts';

let db: Server['db'];
let impact: typeof import('../src/server/impact.ts');

const root = new URL('../', import.meta.url).pathname;
const raw = (p: string) => readFileSync(join(root, p), 'utf8');
const read = (p: string) => englishIf(p, raw(p));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const en = JSON.parse(raw('src/locales/en.json')) as Record<string, string>;

let n = 0;
type Person = { c: Client; id: string; name: string; email: string };
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@five.example`;
  const c = await signUp(`${first} Sender`, email, `198.51.79.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name: `${first} Sender`, email };
}
async function send(p: Person, email: string, over: any = {}) {
  const e = await simple(p.c, email, { recipients: [{ id: 'r', role: 'signer', name: `Signer ${email.split('@')[0]}`, email }], ...over });
  const r = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return e.id as string;
}
const sees = async (eid: string, email: string) => (await new Client().get(`/sign/${tokenFor(eid, email)}/impact`)).data;

before(async () => {
  ({ db } = await boot());
  impact = await import('../src/server/impact.ts');
});

// ---- The constant and the counting function ----------------------------------------------------------------------

test('one constant: 5 trees a signature, and every number on a price line comes from it', () => {
  assert.equal(PRICING.treesPerSignature, 5);
  assert.equal(TREES_PER_SIGNATURE, PRICING.treesPerSignature, 'the signing side reads the same number');
  assert.ok(!('treesPerUsd' in PRICING), 'the per-dollar rate is gone');
  // "$9 a month: 9 signatures, 45 trees", and the 3 free ones plant 15.
  assert.equal(treesFor(PRICING.monthlySignatures), 45);
  assert.equal(treesFor(PRICING.welcomeSignatures), 15);
  assert.equal(treesFor(1), 5);
  assert.equal(treesFor(0), 0);
  assert.equal(treesFor(-3), 0);
  assert.equal(treesFor(2.9), 10, 'whole signatures only');
  assert.equal(RULE_LINE, 'Every signature plants 5 trees.');
  assert.equal(RULE_FULL, 'Every signature plants 5 trees: mangroves, planted by Treegens. Free signatures count too.');
  assert.match(SITE_TITLE, /every signature plants 5 trees/);
  assert.equal(OG_ALT, 'GrowSigning: sign on screen. Every signature plants 5 trees.');
  assert.equal(raw('src/app/opengraph-image.alt.txt').trim(), OG_ALT);
  assert.match(expiryRuleText(), /Each signature plants 5 trees when signed\.$/);
  assert.doesNotMatch(expiryRuleText(), /dollar/);
});

test('one counting function: 5 from the change on, whatever the signature cost; before it, what was promised then', () => {
  assert.equal(TREES_5_FROM, '2026-11-23T00:00:00.000Z');
  assert.equal(TREES_RULE_DAY, '23 November 2026');
  // perUsd (repair): money paid before the change keeps 10 a dollar in the totals.
  assert.deepEqual(TREES_BEFORE, { paid: 10, free: 0, perUsd: 10 });
  // Today's rule: no question about money is asked at all.
  assert.equal(treesForSignature(), 5);
  assert.equal(treesForSignature({ paid: false }), 5, 'a free signature');
  assert.equal(treesForSignature({ paid: true }), 5);
  assert.equal(treesForSignature({ at: TREES_5_FROM, paid: false }), 5, 'the first moment of the rule');
  assert.equal(treesForSignature({ at: '2027-03-01T10:00:00.000Z', paid: false }), 5);
  // Before the change: the promise of that day.
  assert.equal(treesForSignature({ at: '2026-11-22T23:59:59.999Z', paid: true }), 10);
  assert.equal(treesForSignature({ at: '2026-11-22T23:59:59.999Z', paid: false }), 0);
  assert.equal(treesForSignature({ at: '2026-06-01T00:00:00.000Z' }), 0);
});

// ---- The words a signer reads --------------------------------------------------------------------------------------

test('the signer\'s three moments in words: the first screen, next to Finish, and the finished screen', () => {
  assert.equal(openLine(5), 'When you sign, 5 trees are planted.');
  assert.equal(OPEN_UNDER, 'Mangroves, planted by Treegens.');
  assert.equal(openLine(1), 'When you sign, 1 tree is planted.');
  assert.equal(openLine(0), '', 'nothing for a signature that plants none');
  assert.equal(openLine(0.5), '');
  assert.ok(words(`${openLine(5)} ${OPEN_UNDER}`) <= 12, 'the first screen stays light: 11 words');
  assert.equal(finishLine(5), '5 trees will be planted when you finish.');
  assert.equal(mailLine(5), '5 trees will be planted with Treegens when you finish.');
  const done = signerWords({ trees: 5, first: true, total: 5, sheets: 2 });
  assert.equal(done.title, '5 trees will be planted for your signature');
  assert.equal(done.under, 'Mangroves, planted by Treegens. You also saved 2 pages of paper from a tree.');
  assert.equal(plantedLine(15), 'Its signatures plant 15 trees with Treegens.');
  assert.equal(plantedLine(0), '');
  assert.equal(reviewPlus(true), '5 trees are planted for each person who signs.');
  assert.equal(recordLines({ sheets: 2, litresWater: 20, trees: 5, site: 'https://x.example' })[1], 'The signatures on this document plant 5 trees: mangroves, planted by Treegens. How we count: https://x.example/impact');
  // Honest words: nothing about carbon, nothing said to be planted already, no em dash, no money on a signer's screen.
  const all = [openLine(5), OPEN_UNDER, finishLine(5), mailLine(5), ...Object.values(done), RULE_LINE, RULE_FULL, plantedLine(5), senderWords({ counted: 1, signers: 1, planted: 5, sheets: 1 }).promise].join(' ');
  assert.doesNotMatch(all, /\u2014|carbon|CO2|offset|climate|\bgreen\b|have planted|planted 5 trees\b/i);
  assert.doesNotMatch([openLine(5), OPEN_UNDER, finishLine(5), ...Object.values(done)].join(' '), /\$|dollar|paid|price/i);
});

// ---- Free trial signatures count ---------------------------------------------------------------------------------

test('a free trial signature plants 5 trees: said in the email, on the first screen, by Finish, and counted in every total', async () => {
  const p = await person('Trial');
  const lots = db.all('SELECT source, paid, qty FROM credit_lots WHERE account_id=?', p.id);
  assert.deepEqual(lots.map((l: any) => [l.source, l.paid, l.qty]), [['welcome', 0, PRICING.welcomeSignatures]], 'nothing but the free signatures of a new account');
  const eid = await send(p, 'tess@five.example');
  // The email: among the first lines, above the sender's reply line and the button.
  const mail = textOf(mailTo('tess@five.example').at(-1)!.html);
  assert.match(mail, /5 trees will be planted with Treegens when you finish\./);
  assert.ok(mail.indexOf('5 trees will be planted') < mail.indexOf('Reply to this email'), 'before the practical lines');
  // The link: 5, before anything is signed (the first screen and the line next to Finish both read this).
  assert.deepEqual(await sees(eid, 'tess@five.example'), { finish: 5, done: null });
  assert.equal((await signAll(eid, 'tess@five.example')).status, 200);
  const done = (await sees(eid, 'tess@five.example')).done;
  assert.deepEqual([done.trees, done.total, done.first, done.celebrate], [5, 5, true, true]);
  assert.equal(signerWords(done).title, '5 trees will be planted for your signature');
  // The row and the totals: the account's, the Plan page's, and everyone's.
  assert.deepEqual(db.all('SELECT trees FROM impact_signed WHERE envelope_id=?', eid).map((r: any) => r.trees), [5]);
  assert.equal(impact.treesOnEnvelope(eid), 5);
  assert.equal(impact.treesOfAccount(p.id), 5);
  const mine = (await p.c.get('/impact')).data;
  assert.equal(mine.account.treesFunded, 5);
  assert.equal(mine.account.donatedUsd, 0, 'nothing was paid, and the trees are counted all the same');
  assert.equal((await p.c.get('/billing')).data.mangroves, 5);
  const everyone = (await new Client().get('/public/impact')).data.treesFunded;
  assert.equal(everyone, impact.treesOfEveryone());
  assert.ok(everyone >= 5);
  // All three free signatures: 15 trees.
  for (const who of ['t2', 't3']) {
    const e = await send(p, `${who}@five.example`);
    assert.equal((await signAll(e, `${who}@five.example`)).status, 200);
  }
  assert.equal(impact.treesOfAccount(p.id), treesFor(PRICING.welcomeSignatures));
});

test('a signature counts whatever lot it came from: a reward or an adjustment that nobody paid for plants 5 too', async () => {
  const p = await person('Reward');
  const credits = await import('../src/server/credits.ts');
  // Use up the trial, then add signatures that were not paid for (the shape a reward for inviting a friend has).
  for (const who of ['a', 'b', 'c']) {
    const e = await send(p, `${who}-r@five.example`);
    assert.equal((await signAll(e, `${who}-r@five.example`)).status, 200);
  }
  assert.equal(credits.available(p.id), 0);
  assert.equal(credits.grant(p.id, 2, 'adjust', 'reward:test'), true);
  const eid = await send(p, 'gift@five.example');
  assert.equal((await sees(eid, 'gift@five.example')).finish, 5);
  assert.equal((await signAll(eid, 'gift@five.example')).status, 200);
  assert.equal((await sees(eid, 'gift@five.example')).done.trees, 5);
  assert.equal(impact.treesOfAccount(p.id), 20);
});

// ---- Old and new signatures in one total -------------------------------------------------------------------------

// Repair of 23 November 2026 (review finding: totals for the past dropped at the change). Before the change a total
// was 10 mangroves for every dollar paid, used or not. That promise stays for money paid before the change; rows
// from the change on are added at 5, except a signature bought with that old money, which is in the total already.
test('totals with old money and new signatures: old money at 10 a dollar used or not, new signatures at 5, nothing twice, nothing rewritten', async () => {
  const p = await person('History');
  const credits = await import('../src/server/credits.ts');
  const day = (d: number) => new Date(Date.parse(TREES_5_FROM) - d * 864e5).toISOString();
  const e1 = await send(p, 'new1@five.example');
  const e2 = await send(p, 'new2@five.example');
  assert.equal((await signAll(e1, 'new1@five.example')).status, 200);
  assert.equal((await signAll(e2, 'new2@five.example')).status, 200);
  assert.equal(impact.treesOfAccount(p.id), 10);
  const everyone = impact.treesOfEveryone();
  // 9 dollars paid a month before the change. The Plan page said 90 mangroves then, used or not: it still does.
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits) VALUES ('pay-old-h', ?, 900, 'usd', ?, 'plan', 9)", p.id, day(30));
  assert.equal(impact.treesOfOldMoney(p.id), 90);
  assert.equal(impact.treesOfAccount(p.id), 90 + 5 + 5, 'no total goes down at the change');
  assert.equal(impact.treesOfEveryone(), everyone + 90);
  assert.equal((await p.c.get('/impact')).data.account.treesFunded, 100);
  assert.equal((await p.c.get('/billing')).data.mangroves, 100);
  // Two signatures from before the change, as their rows were written then: one paid for (10), one free (0). They
  // are part of that money already, so the account's total does not move; the document keeps what it said.
  db.run('INSERT INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at) VALUES (?,?,?,?,?,?,?)', 'old-paid', 0, 'old-env-1', p.id, 'who-old-1', 10, day(29));
  db.run('INSERT INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at) VALUES (?,?,?,?,?,?,?)', 'old-free', 0, 'old-env-2', p.id, 'who-old-2', 0, day(20));
  assert.equal(impact.treesOfAccount(p.id), 100);
  assert.equal(impact.treesOnEnvelope('old-env-1'), 10, 'the old promise stands on the document');
  assert.equal(impact.treesOnEnvelope('old-env-2'), 0, 'an old free signature is not given trees after the fact');
  // Signatures bought with the old money and used now. The last free one goes first (it expires soonest) and adds
  // 5; the next comes out of the old payment: the signer is told 5, and the total does not count it a second time.
  assert.equal(credits.grant(p.id, 9, 'plan', 'pay-old-h'), true);
  const e3 = await send(p, 'new3@five.example');
  assert.equal((await signAll(e3, 'new3@five.example')).status, 200);
  assert.equal(impact.treesOfAccount(p.id), 105);
  const e4 = await send(p, 'new4@five.example');
  assert.equal((await sees(e4, 'new4@five.example')).finish, 5);
  assert.equal((await signAll(e4, 'new4@five.example')).status, 200);
  assert.equal(impact.treesOnEnvelope(e4), 5);
  assert.equal(db.get('SELECT old_payment FROM impact_signed WHERE envelope_id=?', e4).old_payment, 'pay-old-h');
  assert.equal(impact.treesOfAccount(p.id), 105, 'in the total already, as its payment');
  // Asking for totals changes no row, old or new.
  assert.deepEqual(db.all('SELECT trees FROM impact_signed WHERE account_id=? ORDER BY at', p.id).map((r: any) => r.trees), [10, 0, 5, 5, 5, 5]);
  // Part of the old payment goes back: the old promise follows the money, as it did then.
  db.run("UPDATE payments SET refunded_cents=400 WHERE id='pay-old-h'");
  assert.equal(impact.treesOfAccount(p.id), 50 + 15);
  // All of it goes back: nothing is left of the old promise, and the signature made with it still happened.
  db.run("UPDATE payments SET refunded_cents=900 WHERE id='pay-old-h'");
  assert.equal(impact.treesOfAccount(p.id), 20);
  // Money paid since the change plants nothing by itself: only its signatures do.
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits) VALUES ('pay-new-h', ?, 900, 'usd', ?, 'plan', 9)", p.id, new Date().toISOString());
  assert.equal(impact.treesOfAccount(p.id), 20);
});

// Repair (review finding, high): the public total said "Trees planted by signatures: 10" after two free signatures
// on a server nobody had paid. It is now worded as what signatures plant, and shown only from 100 trees and only once
// customers have paid something.
test('the public total: never for a few free signatures on a server nobody has paid, and never worded as already planted', async () => {
  const { publicTreesShown, TOTALS_FROM } = await import('../src/lib/impact.ts');
  assert.equal(TOTALS_FROM.treesPublic, 100);
  assert.equal(publicTreesShown({ treesFunded: 10, donatedUsd: 0 }), false, 'two trial signatures, nothing paid');
  assert.equal(publicTreesShown({ treesFunded: 5000, donatedUsd: 0 }), false, 'any number of free signatures, nothing paid');
  assert.equal(publicTreesShown({ treesFunded: 99, donatedUsd: 9 }), false);
  assert.equal(publicTreesShown({ treesFunded: 100, donatedUsd: 9 }), true);
  assert.equal(publicTreesShown(null), false);
  const band = read('src/components/Public.tsx');
  assert.match(band, /const planted = publicTreesShown\(i\);/);
  const view = read('src/components/ImpactView.tsx');
  assert.match(view, /own \? Number\(i\?\.treesFunded\) >= TOTALS_FROM\.treesPlanted : publicTreesShown\(i\)/);
  for (const f of ['src/components/Public.tsx', 'src/components/ImpactView.tsx', 'src/app/app/impact/page.tsx', 'src/app/impact/page.tsx'])
    assert.doesNotMatch(read(f), /Trees planted by|have planted|has done so far|come out of that same money/, `${f}: nothing says the trees are planted already`);
  assert.match(band, /Trees our signatures plant/);
  assert.match(view, /It says what our signatures plant, not what has been planted already: Treegens plants afterwards\./);
  assert.match(view, /Jimi plants the trees\./);
});

// Repair (review finding, medium): the completion emails said nothing about trees.
test('the completion email says what the signatures plant, to the signer and to the sender, and nothing with tree words off', async () => {
  const p = await person('Done');
  const eid = await send(p, 'fin@five.example');
  assert.equal((await signAll(eid, 'fin@five.example')).status, 200);
  const LINE = 'The signatures on this document plant 5 trees: mangroves, planted by Treegens.';
  const { completedMailLine } = await import('../src/lib/impactwords.ts');
  assert.equal(completedMailLine(5), LINE);
  assert.equal(completedMailLine(0), '');
  assert.match(en['mail.sender.complete.trees'], /other \{The signatures on this document plant # trees: mangroves, planted by Treegens\.\}/);
  const toSigner = mailTo('fin@five.example').filter((m) => /^Completed:/.test(m.subject)).at(-1)!;
  assert.ok(textOf(toSigner.html).includes(LINE), 'the signer');
  const toSender = mailTo(p.email).filter((m) => /Completed|complete/i.test(m.subject)).at(-1)!;
  assert.ok(textOf(toSender.html).includes(LINE), 'the sender');
  const q = await person('Hush');
  assert.equal((await q.c.put('/account/policy', { impact_display: 'off' })).status, 200);
  const e2 = await send(q, 'still@five.example');
  assert.equal((await signAll(e2, 'still@five.example')).status, 200);
  for (const m of [...mailTo('still@five.example'), ...mailTo(q.email)].filter((x) => /complete/i.test(x.subject))) assert.doesNotMatch(textOf(m.html), /trees|mangrove/i, m.subject);
});

// Repair (review finding, medium): the tree line came with a second request, after the screen was drawn.
test('the number comes with the signing page\'s first answer, before and after Finish, so nothing arrives late', async () => {
  const p = await person('First');
  const eid = await send(p, 'paint@five.example');
  const tok = tokenFor(eid, 'paint@five.example');
  assert.equal((await new Client().get(`/sign/${tok}`)).data.envelope.plants, 5);
  assert.equal((await signAll(eid, 'paint@five.example')).status, 200);
  assert.equal((await new Client().get(`/sign/${tok}`)).data.envelope.plants, 5, 'the finished screen has it at once too');
  // Nobody who plants none gets a number: tree words off, a sender's own document.
  const own = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'signer', name: p.name, email: p.email }] });
  assert.equal((await p.c.post(`/envelopes/${own.id}/send`)).status, 200);
  assert.equal((await new Client().get(`/sign/${tokenFor(own.id, p.email)}`)).data.envelope.plants, 0);
  // The page draws from that answer: no request of its own for the first screen or the Finish bar.
  const trees = read('src/components/impact/SignerTrees.tsx');
  const top = trees.slice(trees.indexOf('export function OpenTreesLine'), trees.indexOf('const num ='));
  assert.doesNotMatch(top, /api\(|useEffect|useState/, 'the first screen and the Finish line ask the server nothing');
  assert.doesNotMatch(read('src/components/sign/ConsentTop.tsx'), /treesIn/, 'nothing is counted again after the screen is up');
});

// Repair (UX review): a sender who signs their own document was shown a leaf and no trees, with no word why.
test('a sender signing their own document is told plainly that it plants none', async () => {
  const p = await person('Self');
  const e = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'signer', name: p.name, email: p.email }] });
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, p.email)).status, 200);
  const d = (await sees(e.id, p.email)).done;
  assert.deepEqual([d.trees, d.own], [0, true]);
  const w = signerWords({ ...d });
  assert.equal(w.under, 'Signing your own document is free and plants no trees. You saved 1 page of paper from a tree.');
  assert.doesNotMatch(w.title, /tree/);
  // Someone else's signature never carries the flag.
  const eid = await send(p, 'other@five.example');
  assert.equal((await signAll(eid, 'other@five.example')).status, 200);
  assert.equal((await sees(eid, 'other@five.example')).done.own, undefined);
});

test('a signing record that was already issued is not written again', async () => {
  const p = await person('Record');
  const eid = await send(p, 'rec@five.example');
  assert.equal((await signAll(eid, 'rec@five.example')).status, 200);
  const first = db.get('SELECT final_sha256 FROM envelopes WHERE id=?', eid).final_sha256;
  assert.ok(first, 'the completed PDF is stored once, with its fingerprint');
  // Even if the row said something else afterwards, the stored record is the one that is handed out.
  db.run('UPDATE impact_signed SET trees=10 WHERE envelope_id=?', eid);
  await p.c.get(`/envelopes/${eid}/download`);
  assert.equal(db.get('SELECT final_sha256 FROM envelopes WHERE id=?', eid).final_sha256, first);
  assert.match(raw('src/server/envelopes.ts'), /UPDATE envelopes SET final_sha256=\?, final_size=\? WHERE id=\? AND final_sha256 IS NULL/);
});

// ---- Who is not told ---------------------------------------------------------------------------------------------

test('tree words off stay off, a sender\'s own signature plants none, and a server without plans says nothing', async () => {
  const p = await person('Quiet');
  const off = await p.c.put('/account/policy', { impact_display: 'off' });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const eid = await send(p, 'hush@five.example');
  assert.doesNotMatch(textOf(mailTo('hush@five.example').at(-1)!.html), /trees will be planted|mangrove/i);
  assert.deepEqual(await sees(eid, 'hush@five.example'), { finish: 0, done: null }, 'no line on the first screen and none by Finish');
  assert.deepEqual((await p.c.get(`/envelopes/${eid}/impact`)).data, { plus: false, sent: null });
  // The signature is still counted: the switch is about words, not about the planting.
  assert.equal((await signAll(eid, 'hush@five.example')).status, 200);
  assert.equal(impact.treesOfAccount(p.id), 5);

  const own = await person('Own');
  const e = await simple(own.c, own.email, { recipients: [{ id: 'r', role: 'signer', name: own.name, email: own.email }] });
  assert.equal((await own.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await sees(e.id, own.email)).finish, 0, 'signing your own document uses no signature');
  assert.equal((await signAll(e.id, own.email)).status, 200);
  assert.equal(impact.treesOfAccount(own.id), 0);

  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const np = await person('Noplans');
    const ne = await send(np, 'np@five.example');
    assert.equal((await sees(ne, 'np@five.example')).finish, 0);
    assert.equal((await signAll(ne, 'np@five.example')).status, 200);
    assert.equal(impact.treesOfAccount(np.id), 0);
  } finally {
    process.env.STRIPE_SECRET_KEY = key;
  }
  // The government profile reads the same switch in one place.
  assert.match(raw('src/server/routes-impact.ts'), /!showsTrees\(e\.account_id\)\) return \{ finish: 0, done: null \}/);
});

// ---- The screens -------------------------------------------------------------------------------------------------

test('the signer screens: the line on the first screen above everything legal, again by Finish, and on the finished screen', () => {
  const trees = read('src/components/impact/SignerTrees.tsx');
  assert.match(trees, /export function OpenTreesLine\(/);
  assert.match(trees, /const line = openLine\(Number\(trees\) \|\| 0\);\s+if \(!line\) return null;/, 'nothing is drawn when the signature plants none');
  assert.match(trees, /<Mark size=\{30\} label="" \/>\s+<p><b>\{line\}<\/b><span>\{OPEN_UNDER\}<\/span><\/p>/, 'a small leaf, the line, and who plants under it');
  assert.doesNotMatch(trees.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /\b5 trees\b|10 mangroves/, 'the number is never typed into the screen');
  // The first screen: inside ConsentTop, after who it is from and for, before the sender's words and the legal text.
  const top = read('src/components/sign/ConsentTop.tsx');
  assert.ok(top.indexOf('      {trees}') > top.indexOf('className="sg-from"'), 'after the From line');
  assert.ok(top.indexOf('      {trees}') < top.indexOf('<SenderWords'), 'before the sender\'s message');
  assert.match(top, /if \(need > level\) setLevel\(need\);/, 'the line is drawn with the screen, so the one count of its words includes it');
  const page = read('src/app/sign/[token]/page.tsx');
  const consent = page.slice(page.indexOf("if (stage === 'consent')"));
  const at = consent.indexOf('trees={!ask ? <OpenTreesLine trees={env.plants} /> : null}');
  assert.ok(at > 0, 'the consent screen draws it, for someone asked to sign');
  assert.ok(at < consent.indexOf("type=\"checkbox\"") || consent.indexOf("type=\"checkbox\"") < 0 || at < consent.indexOf('sg-read'), 'above the legal text and the tick');
  assert.equal((page.match(/<OpenTreesLine /g) || []).length, 1);
  // The finished screen: right under the heading, before the line about the copy and the buttons (a phone shows it without a scroll).
  const done = page.slice(page.indexOf("if (stage === 'done')"));
  assert.ok(done.indexOf('<DoneTrees trees={finished?.plants ?? env.plants} />') > done.indexOf('<StateCard tone="ok" title={title}>'));
  assert.ok(done.indexOf('<DoneTrees ') < done.indexOf('doneActions(allDone)'), 'above the buttons');
  // By Finish, in both bars, and the finished screen.
  assert.equal((page.match(/<TreeLine trees=\{env\.plants\} show=\{acts && !hasNext\} \/>/g) || []).length, 2);
  assert.equal((page.match(/<SignerDone /g) || []).length, 1);
  // A public form (a shared link) says it on its own first screen, from the number the server gives.
  const form = read('src/app/f/[slug]/page.tsx');
  assert.match(form, /<OpenTreesLine trees=\{form\.plants\} \/>/);
  assert.ok(form.indexOf('<OpenTreesLine') < form.indexOf('Your full name'), 'before the first thing to fill in');
  assert.match(raw('src/server/routes-envelopes.ts'), /plants: showsTrees\(p\.account_id\) && creditsEnabled\(\) && [^\n]*available\(p\.account_id\) >= 1 \? treesForSignature\(\) : 0,/);
  // The ceilings of the core flows are not touched by this change.
  const ceil = JSON.parse(raw('tests/ux/ceilings.json')).default;
  assert.deepEqual([ceil['b-sign-phone'].words, ceil['b-sign-phone'].max_choices, ceil['b-sign-desktop'].words], [432, 11, 442]);
  assert.doesNotMatch(trees.slice(trees.indexOf('export function OpenTreesLine'), trees.indexOf('/** Next to Finish')), /<button|<a |<details|<input/, 'the line adds no choice to the first screen');
});

test('a public form tells its visitor before they type: plants 5, and 0 when tree words are off', async () => {
  const p = await person('Form');
  const tpl = await simple(p.c, '', { kind: 'template', subject: 'Join', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  const made = await p.c.post('/powerforms', { template_id: tpl.id, name: 'Join us' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const slug = (await p.c.get('/powerforms')).data.powerforms[0].slug;
  const open = (await new Client().get(`/public/powerforms/${slug}`)).data;
  assert.equal(open.plants, 5);
  assert.equal(open.trees, true);
  assert.equal((await p.c.put('/account/policy', { impact_display: 'off' })).status, 200);
  const quiet = (await new Client().get(`/public/powerforms/${slug}`)).data;
  assert.deepEqual([quiet.plants, quiet.trees], [0, false]);
  // Repair (review finding, low): no trees are promised for a signature the form cannot take. With the owner's
  // signatures used up the start would be refused, so the form says nothing about trees.
  assert.equal((await p.c.put('/account/policy', { impact_display: 'on' })).status, 200);
  for (const who of ['f1', 'f2', 'f3']) {
    const e = await send(p, `${who}@five.example`);
    assert.equal((await signAll(e, `${who}@five.example`)).status, 200);
  }
  assert.equal((await new Client().get(`/public/powerforms/${slug}`)).data.plants, 0);
});

// ---- The pages ---------------------------------------------------------------------------------------------------

test('the home page, pricing, the plan page and the emails all say the one rule, from the one number', () => {
  // The home page: the headline with its one button.
  assert.equal(en['public.home.h1'], 'Every signature plants {trees}');
  assert.equal(en['public.home.h1_trees'], '{count} trees.');
  // Shortened in the repair (UX review): the money line is said once in point 3 and in the footer, not in the lead as well.
  assert.equal(en['public.home.lead'], 'Send documents and get them signed online. Each time someone signs, Treegens plants {trees} mangroves.');
  assert.match(en['public.home.note'], /free, no card needed\. They plant trees too\.\}?$/);
  assert.match(en['public.home.trees_body'], /^What you pay, less card fees, goes to Treegens\./);
  const home = raw('src/app/page.tsx');
  assert.match(home, /h1_trees', \{ count: String\(TREES_PER_SIGNATURE\) \}/);
  assert.equal((home.match(/className="btn primary lg"/g) || []).length, 1, 'one button');
  // /impact and the app's Trees planted page.
  assert.equal(en['public.impact.paid_h'], 'Every signature plants {trees} trees');
  assert.match(en['public.impact.paid_body'], /Free signatures count too\./);
  const view = read('src/components/ImpactView.tsx');
  assert.match(view, /Every signature plants \{PRICING\.treesPerSignature\} trees\./);
  assert.match(view, /<summary>Signatures and payments before \{TREES_RULE_DAY\}<\/summary>/, 'the old rule is one tap away, not in the way');
  assert.match(view, /\{TREES_BEFORE\.perUsd\} mangroves for each US dollar a customer paid[^<]*Money paid before that day stays in the total at that promise\./);
  // Pricing: "9 signatures added every month, 45 trees".
  const pricing = read('src/app/pricing/page.tsx');
  assert.match(pricing, /added every month<\/b>, \{treesFor\(P\.monthlySignatures\)\} trees<\/li>/);
  assert.match(pricing, /to try the product, \{treesFor\(P\.welcomeSignatures\)\} trees planted<\/li>/);
  assert.match(pricing, /Every signature plants \{P\.treesPerSignature\} trees with Treegens, the free ones too/);
  // The Plan page and the stop screens at the review step.
  const plan = read('src/app/app/settings/page.tsx');
  assert.match(plan, /Every signature plants \{P\.treesPerSignature\} trees<\/h2>/);
  assert.match(plan, /\{treesFor\(q\)\.toLocaleString\(\)\} trees<\/b> when signed/);
  assert.match(read('src/components/editor/StepReview.tsx'), /Every signature plants \{PRICING\.treesPerSignature\} trees\./);
  // Emails.
  assert.equal(en['mail.footer.trees'], 'Sent with GrowSigning, where every signature plants {trees} mangrove trees with Treegens.');
  assert.match(en['mail.request.trees'], /one \{# tree\} other \{# trees\}\} will be planted with Treegens when you finish\./);
  assert.match(raw('src/server/requestmail.ts'), /\(f\.kind === 'new' \|\| f\.kind === 'reminder'\) && f\.trees >= 1/, 'the reminder says it too');
  assert.match(raw('src/server/envelopes.ts'), /\(kind === 'new' \|\| kind === 'reminder'\) && showsTrees\(e\.account_id\) && treesInInvite\(r\)/);
});

test('nothing still says the old rule: no "every dollar plants", no "10 mangroves", no "paid only", no "free signatures plant no trees"', () => {
  const OLD = /every dollar (still )?(paid )?plants|for every dollar|per dollar|treesPerUsd|mangrovesFor\(|10 mangrove|ten mangroves|free signatures? (plant|fund)s? (no|none)|plant no trees|plants? 10\b|paid signature on it|signature you pay for plants|whether (its|the|their) signatures (are|were) used or not/i;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(root, dir))) {
      const p = `${dir}/${f}`;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else if (/\.(tsx?|json|txt|css|mjs)$/.test(f)) files.push(p);
    }
  };
  walk('src');
  files.push('scripts/build-brand.mjs', 'brand/README.md', 'brand/guide.html', '.env.example');
  for (const f of files) {
    // Lines of comment may tell the history (what the rule was before); what a person or a program reads may not.
    const hit = raw(f).split('\n').find((l) => !/^\s*(\/\/|\*|\/\*|--|#)/.test(l) && OLD.test(l));
    assert.equal(hit, undefined, `${f}: ${String(hit).trim().slice(0, 160)}`);
  }
  // The README explains the old rule once, as history, and says the new one.
  const readme = raw('README.md');
  assert.match(readme, /Every signature plants 5 trees \(the owner's decision of 23 November 2026\)/);
  assert.match(readme, /tests\/trees-5\.test\.ts/);
  // No em dash in anything this change wrote.
  for (const f of ['src/lib/impact.ts', 'src/lib/impactwords.ts', 'src/server/impact.ts', 'src/components/impact/SignerTrees.tsx', 'tests/trees-5.test.ts']) assert.doesNotMatch(raw(f), /\u2014/, f);
});

test('the API says the rule: finish is 5, the envelope answer names who counts, and the description is the new one', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  const signer = spec.paths['/sign/{token}/impact'].get;
  assert.match(signer.description, /Every signature plants 5 trees: mangroves, planted by Treegens\./);
  assert.match(signer.description, /Signatures finished before 23 November 2026 count what was promised then/);
  assert.match(spec.paths['/sign/{token}/impact'].get.responses[200].content['application/json'].schema.properties.done.properties.own.description, /own document/);
  const sent = spec.paths['/envelopes/{id}/impact'].get.responses[200].content['application/json'].schema.properties.sent.properties;
  assert.deepEqual(Object.keys(sent).sort(), ['celebrate', 'counted', 'here', 'planted', 'sheets', 'signers']);
  assert.doesNotMatch(JSON.stringify(spec.paths['/sign/{token}/impact']) + JSON.stringify(spec.paths['/envelopes/{id}/impact']), /paid signature|funds? none|per dollar/i);
});
