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
  assert.deepEqual(TREES_BEFORE, { paid: 10, free: 0 });
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
  assert.equal(done.title, 'Your signature plants 5 trees');
  assert.equal(done.under, 'Mangroves, planted by Treegens. You also saved 2 pages of paper from a tree.');
  assert.equal(plantedLine(15), 'Its signatures plant 15 trees with Treegens.');
  assert.equal(plantedLine(0), '');
  assert.equal(reviewPlus(true), 'Plus: 5 trees are planted for each person who signs.');
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
  assert.equal(signerWords(done).title, 'Your signature plants 5 trees');
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

test('totals with old and new signatures: old paid ones at 10, old free ones at 0, new ones at 5, and nothing is rewritten', async () => {
  const p = await person('History');
  const e1 = await send(p, 'new1@five.example');
  const e2 = await send(p, 'new2@five.example');
  assert.equal((await signAll(e1, 'new1@five.example')).status, 200);
  assert.equal((await signAll(e2, 'new2@five.example')).status, 200);
  assert.equal(impact.treesOfAccount(p.id), 10);
  // Two signatures from before the change, as their rows were written then: one paid for (10), one free (0). Their
  // envelopes are long gone, so the rows stand as written.
  const day = (d: number) => new Date(Date.parse(TREES_5_FROM) - d * 864e5).toISOString();
  db.run('INSERT INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at) VALUES (?,?,?,?,?,?,?)', 'old-paid', 0, 'old-env-1', p.id, 'who-old-1', 10, day(30));
  db.run('INSERT INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at) VALUES (?,?,?,?,?,?,?)', 'old-free', 0, 'old-env-2', p.id, 'who-old-2', 0, day(20));
  const before = impact.treesOfEveryone();
  assert.equal(impact.treesOfAccount(p.id), 10 + 0 + 5 + 5);
  assert.equal(impact.treesOnEnvelope('old-env-1'), 10, 'the old promise stands');
  assert.equal(impact.treesOnEnvelope('old-env-2'), 0, 'an old free signature is not given trees after the fact');
  assert.equal((await p.c.get('/impact')).data.account.treesFunded, 20);
  assert.equal((await p.c.get('/billing')).data.mangroves, 20);
  // Asking for totals changes no row, old or new.
  assert.deepEqual(db.all('SELECT trees FROM impact_signed WHERE account_id=? ORDER BY at', p.id).map((r: any) => r.trees), [10, 0, 5, 5]);
  // One more signature moves every total by exactly 5.
  const e3 = await send(p, 'new3@five.example');
  assert.equal((await signAll(e3, 'new3@five.example')).status, 200);
  assert.equal(impact.treesOfAccount(p.id), 25);
  assert.equal(impact.treesOfEveryone(), before + 5);
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
  assert.match(trees, /export function OpenTrees\(/);
  assert.match(trees, /const line = openLine\(Number\(trees\) \|\| 0\);\s+if \(!line\) return null;/, 'nothing is drawn when the signature plants none');
  assert.match(trees, /<Mark size=\{30\} label="" \/>\s+<p><b>\{line\}<\/b><span>\{OPEN_UNDER\}<\/span><\/p>/, 'a small leaf, the line, and who plants under it');
  assert.doesNotMatch(trees.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /\b5 trees\b|10 mangroves/, 'the number is never typed into the screen');
  // The first screen: inside ConsentTop, after who it is from and for, before the sender's words and the legal text.
  const top = read('src/components/sign/ConsentTop.tsx');
  assert.ok(top.indexOf('{trees?.(') > top.indexOf('className="sg-from"'), 'after the From line');
  assert.ok(top.indexOf('{trees?.(') < top.indexOf('<SenderWords'), 'before the sender\'s message');
  assert.match(top, /if \(need > level\) setLevel\(need\);/, 'the words are counted again once the line is in, so the screen keeps to its limit');
  const page = read('src/app/sign/[token]/page.tsx');
  const consent = page.slice(page.indexOf("if (stage === 'consent')"));
  const at = consent.indexOf('<OpenTrees base={base} show={!ask}');
  assert.ok(at > 0, 'the consent screen draws it, for someone asked to sign');
  assert.ok(at < consent.indexOf("type=\"checkbox\"") || consent.indexOf("type=\"checkbox\"") < 0 || at < consent.indexOf('sg-read'), 'above the legal text and the tick');
  assert.equal((page.match(/<OpenTrees /g) || []).length, 1);
  // By Finish, in both bars, and the finished screen.
  assert.equal((page.match(/<TreeLine base=\{base\} show=\{acts && !hasNext\} \/>/g) || []).length, 2);
  assert.equal((page.match(/<SignerDone /g) || []).length, 1);
  // A public form (a shared link) says it on its own first screen, from the number the server gives.
  const form = read('src/app/f/[slug]/page.tsx');
  assert.match(form, /<OpenTreesLine trees=\{form\.plants\} \/>/);
  assert.ok(form.indexOf('<OpenTreesLine') < form.indexOf('Your full name'), 'before the first thing to fill in');
  assert.match(raw('src/server/routes-envelopes.ts'), /plants: showsTrees\(p\.account_id\) && creditsEnabled\(\) \? treesForSignature\(\) : 0,/);
  // The ceilings of the core flows are not touched by this change.
  const ceil = JSON.parse(raw('tests/ux/ceilings.json')).default;
  assert.deepEqual([ceil['b-sign-phone'].words, ceil['b-sign-phone'].max_choices, ceil['b-sign-desktop'].words], [432, 11, 442]);
  assert.doesNotMatch(trees.slice(trees.indexOf('export function OpenTrees'), trees.indexOf('/** Next to Finish')), /<button|<a |<details|<input/, 'the line adds no choice to the first screen');
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
});

// ---- The pages ---------------------------------------------------------------------------------------------------

test('the home page, pricing, the plan page and the emails all say the one rule, from the one number', () => {
  // The home page: the headline with its one button.
  assert.equal(en['public.home.h1'], 'Every signature plants {trees}');
  assert.equal(en['public.home.h1_trees'], '{count} trees.');
  assert.match(en['public.home.lead'], /Each time someone signs, Treegens plants \{trees\} mangroves\. What you pay, less card fees, goes to Treegens\./);
  assert.match(en['public.home.note'], /free to try it, no card needed\. They plant trees too\./);
  const home = raw('src/app/page.tsx');
  assert.match(home, /h1_trees', \{ count: String\(TREES_PER_SIGNATURE\) \}/);
  assert.equal((home.match(/className="btn primary lg"/g) || []).length, 1, 'one button');
  // /impact and the app's Trees planted page.
  assert.equal(en['public.impact.paid_h'], 'Every signature plants {trees} trees');
  assert.match(en['public.impact.paid_body'], /Free signatures count too\./);
  const view = read('src/components/ImpactView.tsx');
  assert.match(view, /Every signature plants \{PRICING\.treesPerSignature\} trees\./);
  assert.match(view, /Before \{TREES_RULE_DAY\} the rule was another one: \{TREES_BEFORE\.paid\} mangroves for a signature that was paid for and none for a free one\./);
  assert.match(view, /stay in the total at what was promised then/);
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
  const OLD = /every dollar (still )?(paid )?plants|for every dollar|per dollar|treesPerUsd|mangrovesFor\(|10 mangrove|ten mangroves|free signatures? (plant|fund)s? (no|none)|plant no trees|paid signature on it|signature you pay for plants|whether (its|the|their) signatures (are|were) used or not/i;
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
  const sent = spec.paths['/envelopes/{id}/impact'].get.responses[200].content['application/json'].schema.properties.sent.properties;
  assert.deepEqual(Object.keys(sent).sort(), ['celebrate', 'counted', 'here', 'planted', 'sheets', 'signers']);
  assert.doesNotMatch(JSON.stringify(spec.paths['/sign/{token}/impact']) + JSON.stringify(spec.paths['/envelopes/{id}/impact']), /paid signature|funds? none|per dollar/i);
});
