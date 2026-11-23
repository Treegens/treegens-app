// Trees (research/briefs.json "impact", and the 5 trees rule of 23 November 2026, see tests/trees-5.test.ts):
// who is told that trees are planted and who is not, the first time and
// every later time, the counts, the line in the email, the signing record and its switch, and the words themselves.
// The payment provider is the stand-in of the billing tests (tests/stripe-fake.ts): nothing here reaches the network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, mailTo, simple, signAll, upload, tokenFor, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { finishLine, mailLine, signerWords, senderWords, reviewPlus, recordLines, SOFT_LINE, TREES_PER_SIGNATURE } from '../src/lib/impactwords.ts';
import { TOTALS_FROM, TREES_5_FROM, totalWorthShowing } from '../src/lib/impact.ts';
import { englishIf } from './words.ts';

let db: Server['db'];
let billing: Server['billing'];
let impact: typeof import('../src/server/impact.ts');

// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const aboveButton = (html: string) => textOf(html.slice(html.indexOf('<h1'), html.indexOf('<p style="margin:24px 0 8px">')));
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

let evn = 0;
const event = (type: string, object: any) => billing.applyStripeEvent({ id: `evti_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object } });

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@trees.example`;
  const c = await signUp(`${first} Sender`, email, `198.51.77.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name: `${first} Sender`, email, cus: `cusi_${k}`, sub: `subi_${k}`, k };
}
// A month of the plan, paid. With `days` under 30 its 9 signatures end before the trial's 3, so they are used first.
async function subscribe(p: Person, days = 20) {
  const inv = `ini_${p.k}_1`;
  Object.assign(stripe.sub(p.sub), { customer: p.cus, status: 'active', metadata: { sg_account: p.id }, current_period_end: unix(days) });
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(days) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] },
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: 900, currency: 'usd', customer: p.cus, invoice: inv, last4: '4242', created: unix(0) });
  stripe.sub(p.sub).current_period_end = o.lines.data[0].period.end;
  await event('checkout.session.completed', { id: `csi_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid' });
  await event('invoice.paid', o);
}
async function send(p: Person, email: string, over: any = {}) {
  const e = await simple(p.c, email, { recipients: [{ id: 'r', role: 'signer', name: `Signer ${email.split('@')[0]}`, email }], ...over });
  const r = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return e.id as string;
}
const sees = async (eid: string, email: string) => (await new Client().get(`/sign/${tokenFor(eid, email)}/impact`)).data;
const lastInvite = (email: string) => mailTo(email).filter((m: any) => /sign|approve|copy|view/i.test(textOf(m.html))).at(-1)!;
async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}
const record = async (p: Person, eid: string) => pdfText((await p.c.get(`/envelopes/${eid}/download`)).data as Uint8Array);

before(async () => {
  ({ db, billing } = await boot());
  impact = await import('../src/server/impact.ts');
});

// ---- The words ----------------------------------------------------------------------------------------------------

test('the words: 5 trees for every signature, the soft line only for one that plants none, never a figure under one tree', () => {
  assert.equal(TREES_PER_SIGNATURE, 5);
  assert.equal(finishLine(5), '5 trees will be planted when you finish.');
  assert.equal(finishLine(0), '');
  assert.equal(finishLine(0.4), '', 'nothing under one tree is ever said');
  assert.equal(mailLine(5), '5 trees will be planted with Treegens when you finish.');
  assert.equal(mailLine(0), '');
  assert.equal(mailLine(5, ' Walk-in Client '), '5 trees will be planted with Treegens when Walk-in Client finishes.', 'to a host: the person who signs is named');
  assert.equal(mailLine(0, 'Walk-in Client'), '');

  const first = signerWords({ trees: 5, first: true, total: 5, sheets: 15 });
  // One tense: a signature "plants", trees "will be planted". Nothing says the planting has already happened.
  assert.equal(first.title, 'Your signature plants 5 trees');
  assert.equal(first.under, 'Mangroves, planted by Treegens. You also saved 15 pages of paper from a tree.', 'under the title: the kind of tree and who plants it, then the paper');
  assert.equal(first.line, 'Your signature plants 5 trees. You saved 15 pages of paper from a tree.', 'the small card that stays after Close');
  assert.equal(first.count, '', 'the running count says nothing this signature did not already say');
  assert.equal(first.announce, 'Your signature plants 5 trees.', 'one sentence for a screen reader');
  assert.doesNotMatch(Object.values(first).join(' '), /\bplanted 5|just planted|have planted/, 'nothing is said to be planted already');

  const later = signerWords({ trees: 5, first: false, total: 20, sheets: 1 });
  assert.equal(later.line, 'Your signature plants 5 more trees. You saved 1 page of paper from a tree.');
  assert.equal(later.count, 'Your signatures on GrowSigning plant 20 trees so far.');
  // "More" needs something before it: a first signature that plants, after one that planted none, is not "5 more".
  const afterNone = signerWords({ trees: 5, first: false, total: 5, sheets: 2 });
  assert.equal(afterNone.line, 'Your signature plants 5 trees. You saved 2 pages of paper from a tree.');
  assert.equal(afterNone.title, 'Your signature plants 5 trees');
  assert.doesNotMatch(Object.values(afterNone).join(' '), /more/);

  // A signature that plants none: a sender signing their own document, or a server without plans.
  const none = signerWords({ trees: 0, first: true, total: 0, sheets: 6 });
  assert.equal(none.title, 'You signed your first document with GrowSigning');
  assert.equal(none.line, 'You saved 6 pages of paper from a tree.');
  assert.equal(none.under, 'You saved 6 pages of paper from a tree.');
  assert.equal(none.count, '');
  assert.doesNotMatch(Object.values(none).join(' '), /plant|mangrove|Treegens|plans/, 'a signature that plants none is never said to plant anything');
  // Plants none itself, but this person planted with earlier signatures: the count is true and is said.
  assert.equal(signerWords({ trees: 0, first: false, total: 20, sheets: 2 }).count, 'Your signatures on GrowSigning plant 20 trees so far.');

  assert.equal(senderWords({ counted: 2, signers: 2, planted: 0, sheets: 15 }).promise, 'Every signature on it plants 5 trees with Treegens.');
  assert.equal(senderWords({ counted: 1, signers: 3, planted: 0, sheets: 15 }).promise, 'Each person you asked to sign plants 5 trees with Treegens.');
  const own = senderWords({ counted: 0, signers: 2, planted: 0, sheets: 15 });
  assert.equal(own.promise, '', 'no signature on it counts: nothing is said about planting');
  assert.equal(own.title, 'Your first document is out.');
  assert.equal(own.announce, 'Your first document is out.');
  assert.equal(own.saving, 'Paper saved: 15 pages.', 'short: the envelope page is read on every send');
  assert.equal(own.saved, 'This saved 15 pages of paper from a tree.');
  assert.equal(senderWords({ counted: 0, signers: 1, planted: 0, sheets: 1 }).saving, 'Paper saved: 1 page.');
  assert.equal(reviewPlus(true), 'Plus: 5 trees are planted for each person who signs.');
  assert.equal(reviewPlus(false), '');

  const withTrees = recordLines({ sheets: 15, litresWater: 150, trees: 10, site: 'https://sign.example' });
  assert.deepEqual(withTrees, ['An estimate: about 15 sheets of paper and 150 litres of water were not used.', 'The signatures on this document plant 10 trees: mangroves, planted by Treegens. How we count: https://sign.example/impact']);
  assert.equal(recordLines({ sheets: 1, litresWater: 10, trees: 0, plans: true, site: 'https://sign.example' })[1], `${SOFT_LINE} How we count: https://sign.example/impact`);
  assert.equal(recordLines({ sheets: 1, litresWater: 10, trees: 0, plans: false, site: 'https://sign.example' })[1], 'How we count: https://sign.example/impact', 'no plans on this server: nothing is earned, so nothing is said to be given');

  // Every sentence above: no em dash, no generic claim, no carbon claim, no share of a tree, no money word.
  const all = [finishLine(5), mailLine(5), SOFT_LINE, reviewPlus(true), ...withTrees, ...Object.values(first), ...Object.values(later), ...Object.values(none), ...Object.values(own)].join(' ');
  assert.doesNotMatch(all, /\u2014|eco.?friendly|\bgreen\b|sustainab|planet|carbon|CO2|climate|offset|\d of a tree|0\.\d+ tree/i);
  assert.doesNotMatch([finishLine(5), ...Object.values(first), ...Object.values(later), ...Object.values(none)].join(' '), /\$|dollar|pays?\b|paid|price|plan\b/i, 'no money words where a signer reads');
});

// ---- Free signatures ----------------------------------------------------------------------------------------------

test('a free signature (the trial) plants 5 trees like any other: the email, the link, the finished screen and the record say so', async () => {
  const p = await person('Trial');
  const eid = await send(p, 'una@signers.example');
  assert.match(textOf(lastInvite('una@signers.example').html), /5 trees will be planted with Treegens when you finish\./, 'the tree line is in the email for a free signature too');
  assert.deepEqual(await sees(eid, 'una@signers.example'), { finish: 5, done: null });
  assert.equal((await signAll(eid, 'una@signers.example')).status, 200);
  const done = (await sees(eid, 'una@signers.example')).done;
  assert.deepEqual(done, { trees: 5, first: true, celebrate: true, total: 5, sheets: 1 });
  // Shown: the server remembers, on any device.
  assert.equal((await new Client().post(`/sign/${tokenFor(eid, 'una@signers.example')}/impact/seen`)).status, 200);
  assert.deepEqual((await sees(eid, 'una@signers.example')).done, { ...done, celebrate: false });
  // The signing record names the trees of this document, and nothing about dollars.
  const rec = await record(p, eid);
  assert.match(rec, /Signed without paper/);
  assert.match(rec, /An estimate: about 1 sheet of paper and 10 litres of water were not used\./);
  assert.match(rec, /The signatures on this document plant 5 trees: mangroves, planted by Treegens\./);
  assert.ok(!rec.includes(SOFT_LINE));
  assert.doesNotMatch(rec, /of a tree|Every dollar|paid for/);
});

test('a sender signing their own document plants nothing and is told nothing about planting', async () => {
  const p = await person('Own');
  await subscribe(p);
  const e = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'signer', name: p.name, email: p.email }] });
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await sees(e.id, p.email)).finish, 0);
  assert.equal((await signAll(e.id, p.email)).status, 200);
  const d = (await sees(e.id, p.email)).done;
  assert.equal(d.trees, 0);
  assert.equal(d.total, 0);
  assert.equal((await p.c.get(`/envelopes/${e.id}/impact`)).data.sent.counted, 0);
});

test('a server that takes no payments says nothing about planting anywhere', async () => {
  const p = await person('Nopay');
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const eid = await send(p, 'zed@signers.example');
    assert.equal((await sees(eid, 'zed@signers.example')).finish, 0);
    assert.doesNotMatch(textOf(lastInvite('zed@signers.example').html), /mangrove|trees will be planted/i);
    const d = (await p.c.get(`/envelopes/${eid}/impact`)).data;
    assert.equal(d.sent.counted, 0);
    assert.equal(senderWords(d.sent).promise, '');
    assert.doesNotMatch(Object.values(senderWords(d.sent)).join(' '), /plant|mangrove|Treegens|earns|plans/i, 'the sender of a server with no plans reads nothing about giving or planting');
    // The signing record of such a server: the paper estimate and where the working is, and no sentence about plans.
    assert.equal((await signAll(eid, 'zed@signers.example')).status, 200);
    const rec = await record(p, eid);
    assert.match(rec, /Signed without paper/);
    assert.match(rec, /How we count: http:\/\/test\.local\/impact/);
    assert.ok(!rec.includes(SOFT_LINE) && !/earns from its plans|mangrove|plant \d+ trees/i.test(rec), 'nothing is earned here, so nothing is said to be given');
    const draft = await simple(p.c, 'zed2@signers.example');
    assert.equal((await p.c.get(`/envelopes/${draft.id}/impact`)).data.plus, false);
  } finally {
    process.env.STRIPE_SECRET_KEY = key;
  }
});

// ---- Paid signatures ----------------------------------------------------------------------------------------------

test('a plan signature: the line by Finish and in the email for the signer only, the first time once, then "5 more" and the count', async () => {
  const p = await person('Payer');
  await subscribe(p);
  const file = await upload(p.c, 3);
  const made = await p.c.post('/envelopes', {
    subject: 'Lease', documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 's', role: 'signer', name: 'Ada Signer', email: 'ada@signers.example', routing_order: 1 },
      { id: 'a', role: 'approver', name: 'Abe Approver', email: 'abe@signers.example', routing_order: 1 },
      { id: 'v', role: 'viewer', name: 'Vic Viewer', email: 'vic@signers.example', routing_order: 1 },
      { id: 'c', role: 'cc', name: 'Cee Copy', email: 'cee@signers.example', routing_order: 1 },
    ],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 's', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const eid = made.data.envelope.id;
  assert.equal((await p.c.post(`/envelopes/${eid}/send`)).status, 200);

  // The email: one line for the person who signs, within the 80 words above the button, and none for the others.
  const mail = lastInvite('ada@signers.example');
  assert.ok(aboveButton(mail.html).includes('5 trees will be planted with Treegens when you finish.'), aboveButton(mail.html));
  assert.ok(words(aboveButton(mail.html)) <= 80, `${words(aboveButton(mail.html))} words above the button`);
  assert.doesNotMatch(textOf(mail.html), /\$|dollar|pays for/i, 'no money words to someone who only came to sign');
  for (const other of ['abe', 'vic', 'cee']) {
    assert.ok(mailTo(`${other}@signers.example`).length > 0, `${other} was emailed`);
    for (const m of mailTo(`${other}@signers.example`)) assert.doesNotMatch(textOf(m.html), /mangrove|trees will be planted/i, `${other} is not told they plant anything`);
  }

  // The signing page: the signer is told next to Finish, an approver, a viewer and a copy are told nothing.
  assert.deepEqual(await sees(eid, 'ada@signers.example'), { finish: 5, done: null });
  for (const other of ['abe', 'vic', 'cee']) assert.deepEqual(await sees(eid, `${other}@signers.example`), { finish: 0, done: null });

  for (const who of ['ada', 'abe', 'vic']) assert.equal((await signAll(eid, `${who}@signers.example`)).status, 200, who);
  for (const other of ['abe', 'vic', 'cee']) assert.deepEqual(await sees(eid, `${other}@signers.example`), { finish: 0, done: null }, `${other} after finishing`);
  // 3 pages for 4 people: 12 sheets. The first time: the picture, once.
  const first = (await sees(eid, 'ada@signers.example')).done;
  assert.deepEqual(first, { trees: 5, first: true, celebrate: true, total: 5, sheets: 12 });
  assert.equal(signerWords(first).title, 'Your signature plants 5 trees');
  await new Client().post(`/sign/${tokenFor(eid, 'ada@signers.example')}/impact/seen`);
  assert.equal((await sees(eid, 'ada@signers.example')).done.celebrate, false);

  // The same person signs again, for another account even: no picture, "5 more", and the count from real rows.
  const q = await person('Second');
  await subscribe(q);
  const e2 = await send(q, 'ADA@signers.example');
  assert.equal((await sees(e2, 'ADA@signers.example')).finish, 5);
  assert.equal((await signAll(e2, 'ADA@signers.example')).status, 200);
  const later = (await sees(e2, 'ADA@signers.example')).done;
  assert.deepEqual(later, { trees: 5, first: false, celebrate: false, total: 10, sheets: 1 });
  assert.equal(signerWords(later).line, 'Your signature plants 5 more trees. You saved 1 page of paper from a tree.');
  assert.equal(signerWords(later).count, 'Your signatures on GrowSigning plant 10 trees so far.');

  // What is kept: no address, only a keyed hash.
  const rows = db.all('SELECT * FROM impact_signed');
  assert.ok(rows.length >= 2);
  assert.doesNotMatch(JSON.stringify(rows), /@|signers\.example|Ada/i);
  assert.doesNotMatch(JSON.stringify(db.all('SELECT * FROM impact_seen')), /@|signers\.example/);

  // The sender's page: every signature on it counts; the signing record names the trees of this document.
  const s = (await p.c.get(`/envelopes/${eid}/impact`)).data.sent;
  assert.deepEqual([s.counted, s.signers, s.planted, s.here, s.sheets], [1, 1, 5, 5, 12]);
  const rec = await record(p, eid);
  assert.match(rec, /The signatures on this document plant 5 trees: mangroves, planted by Treegens\. How we count: http:\/\/test\.local\/impact/);
  assert.match(rec, /An estimate: about 12 sheets of paper and 120 litres of water were not used\./);
  // The owner dropped the CO2 figure: no answer of the API carries one, for the account, the public counter or the signer.
  for (const path of ['/impact', '/reports/summary']) assert.doesNotMatch(JSON.stringify((await p.c.get(path)).data), /co2|carbon/i, path);
  assert.doesNotMatch(JSON.stringify((await new Client().get('/public/impact')).data), /co2|carbon/i, '/public/impact');
  assert.doesNotMatch(JSON.stringify((await new Client().get(`/sign/${tokenFor(eid, 'ada@signers.example')}`)).data), /co2|carbon/i, 'the signing page answer');
  assert.doesNotMatch(rec, /of a tree|Every dollar/);
  // The completion email calls its figures an estimate and says where the working is.
  const doneMail = textOf(mailTo('ada@signers.example').at(-1)!.html);
  assert.match(doneMail, /about 12 sheets of paper and 120 litres of water were not used\. That is an estimate: http:\/\/test\.local\/impact shows how it is worked out\./);
});

test('the first time is by address: an earlier signature from before the count, and one whose envelope was deleted, both count as earlier', async () => {
  const p = await person('History');
  const e1 = await send(p, 'old@signers.example');
  assert.equal((await signAll(e1, 'old@signers.example')).status, 200);
  // As if signed before this was counted: no row was ever written for it.
  db.run('DELETE FROM impact_signed WHERE envelope_id=?', e1);
  const e2 = await send(p, 'old@signers.example');
  assert.equal((await signAll(e2, 'old@signers.example')).status, 200);
  assert.equal((await sees(e2, 'old@signers.example')).done.first, false);
  // Not their first signature, but the first of theirs that plants trees (the old one has no row): the seedlings
  // are shown once for it, as for anyone whose earlier signature planted none.
  assert.equal((await sees(e2, 'old@signers.example')).done.celebrate, true);
  await new Client().post(`/sign/${tokenFor(e2, 'old@signers.example')}/impact/seen`);
  assert.equal((await sees(e2, 'old@signers.example')).done.celebrate, false);
  // A row outlives its envelope: with both envelopes gone from the tables, a third signature is still not the first.
  db.run('DELETE FROM recipients WHERE envelope_id IN (?,?)', e1, e2);
  const e3 = await send(p, 'old@signers.example');
  assert.equal((await signAll(e3, 'old@signers.example')).status, 200);
  assert.equal((await sees(e3, 'old@signers.example')).done.first, false);
});

test('a signature keeps its 5 trees when a payment goes back; one from before the change still follows its payment, as promised then', async () => {
  const p = await person('Refund');
  await subscribe(p);
  const eid = await send(p, 'rita@signers.example');
  assert.equal((await signAll(eid, 'rita@signers.example')).status, 200);
  const old = await send(p, 'rolf@signers.example');
  assert.equal((await signAll(old, 'rolf@signers.example')).status, 200);
  // As if Rolf had signed before the change, with a paid signature: the row says the 10 that was promised then.
  const before = new Date(Date.parse(TREES_5_FROM) - 864e5).toISOString();
  db.run('UPDATE impact_signed SET trees=10, at=? WHERE envelope_id=?', before, old);
  assert.equal((await sees(eid, 'rita@signers.example')).done.total, 5);
  assert.equal(impact.treesOfAccount(p.id), 15);
  const ch = stripe.refundByHand(`ch_ini_${p.k}_1`, 900);
  await event('charge.refunded', { ...ch, id: `ch_ini_${p.k}_1` });
  // The signature happened: its 5 trees stay. The old promise was about the payment, so it goes with the payment.
  const d = (await sees(eid, 'rita@signers.example')).done;
  assert.deepEqual([d.trees, d.total], [5, 5]);
  assert.equal(impact.treesOnEnvelope(eid), 5);
  assert.equal(impact.treesOnEnvelope(old), 0);
  assert.equal(impact.treesOfAccount(p.id), 5);
  assert.equal((await p.c.get(`/envelopes/${eid}/impact`)).data.sent.planted, 5);
});

// ---- What a link gives away, and who may ask ---------------------------------------------------------------------

test('the answers are for the person holding the link: nothing before an access code, nothing on a closed envelope, nothing for a stranger', async () => {
  const p = await person('Locked');
  await subscribe(p);
  const eid = await send(p, 'lou@signers.example', { recipients: [{ id: 'r', role: 'signer', name: 'Lou Locked', email: 'lou@signers.example', access_code: '424242' }] });
  const tok = tokenFor(eid, 'lou@signers.example');
  assert.equal((await new Client().get(`/sign/${tok}/impact`)).status, 401, 'not before the access code');
  assert.equal((await new Client().post(`/sign/${tok}/impact/seen`)).status, 401);
  assert.equal((await new Client().get('/sign/not-a-link/impact')).status, 404);
  // A voided envelope: the old link is told nothing about trees.
  const gone = await send(p, 'vera@signers.example');
  assert.equal((await p.c.post(`/envelopes/${gone}/void`, { reason: 'Sent by mistake' })).status, 200);
  assert.deepEqual(await sees(gone, 'vera@signers.example'), { finish: 0, done: null });
  // Marking "seen" before finishing changes nothing: the first time is still shown after Finish.
  const e3 = await send(p, 'early@signers.example');
  assert.equal((await new Client().post(`/sign/${tokenFor(e3, 'early@signers.example')}/impact/seen`)).status, 200);
  assert.equal((await signAll(e3, 'early@signers.example')).status, 200);
  assert.equal((await sees(e3, 'early@signers.example')).done.celebrate, true);
  // Another account cannot read an envelope's numbers, and a signed-out caller is refused.
  const other = await person('Stranger');
  assert.equal((await other.c.get(`/envelopes/${eid}/impact`)).status, 404);
  assert.equal((await other.c.post(`/envelopes/${eid}/impact/seen`)).status, 404);
  assert.equal((await new Client().get(`/envelopes/${eid}/impact`)).status, 401);
});

// ---- The sender ----------------------------------------------------------------------------------------------------

test('the first envelope an account ever sends: the picture once, for the person who sent it, within the hour', async () => {
  const p = await person('First');
  const e1 = await send(p, 'f1@signers.example');
  const a = (await p.c.get(`/envelopes/${e1}/impact`)).data.sent;
  assert.deepEqual(a, { counted: 1, signers: 1, planted: 0, here: 0, sheets: 1, celebrate: true });
  assert.equal(senderWords(a).announce, 'Your first document is out. Every signature on it plants 5 trees with Treegens.', 'the trial plants trees too');
  assert.equal((await p.c.post(`/envelopes/${e1}/impact/seen`)).status, 200);
  assert.equal((await p.c.get(`/envelopes/${e1}/impact`)).data.sent.celebrate, false, 'shown once');
  const e2 = await send(p, 'f2@signers.example');
  assert.equal((await p.c.get(`/envelopes/${e2}/impact`)).data.sent.celebrate, false, 'the second envelope is not the first');

  // Not seen within the hour: it is not offered a day later.
  const late = await person('Late');
  const l1 = await send(late, 'l1@signers.example');
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', new Date(Date.now() - 2 * 3600_000).toISOString(), l1);
  assert.equal((await late.c.get(`/envelopes/${l1}/impact`)).data.sent.celebrate, false);

  // A draft has no moment at all, and asking "seen" for an envelope that has none marks nothing.
  const fresh = await person('Fresh');
  const d = await simple(fresh.c, 'd1@signers.example');
  assert.deepEqual((await fresh.c.get(`/envelopes/${d.id}/impact`)).data, { plus: true, sent: null });
  assert.equal((await fresh.c.post(`/envelopes/${d.id}/impact/seen`)).status, 200);
  assert.equal((await fresh.c.post(`/envelopes/${d.id}/send`)).status, 200);
  assert.equal((await fresh.c.get(`/envelopes/${d.id}/impact`)).data.sent.celebrate, true, 'the draft could not use up the first time');

  // With a paid month: the same promise.
  const paid = await person('Paidfirst');
  await subscribe(paid);
  const pe = await send(paid, 'pf@signers.example');
  const s = (await paid.c.get(`/envelopes/${pe}/impact`)).data.sent;
  assert.deepEqual([s.counted, s.signers, s.celebrate], [1, 1, true]);
  assert.equal(senderWords(s).promise, 'Every signature on it plants 5 trees with Treegens.');
});

test('the review step says "Plus: 5 trees" when every signature of the draft counts, the trial included', async () => {
  const trial = await person('Reviewtrial');
  const d1 = await simple(trial.c, 'r1@signers.example');
  assert.equal((await trial.c.get(`/envelopes/${d1.id}/impact`)).data.plus, true, 'a free trial signature plants trees too');

  const paid = await person('Reviewpaid');
  await subscribe(paid, 20);
  const d2 = await simple(paid.c, 'r2@signers.example');
  assert.equal((await paid.c.get(`/envelopes/${d2.id}/impact`)).data.plus, true);
  // Signing it yourself uses no signature: nothing is planted, nothing is said.
  const own = await simple(paid.c, paid.email, { recipients: [{ id: 'r', role: 'signer', name: paid.name, email: paid.email }] });
  assert.equal((await paid.c.get(`/envelopes/${own.id}/impact`)).data.plus, false);
  // Only a copy and an approver: nobody signs.
  const none = await simple(paid.c, 'r3@signers.example', { recipients: [{ id: 'r', role: 'approver', name: 'Abe', email: 'r3@signers.example' }], fields: [] });
  assert.equal((await paid.c.get(`/envelopes/${none.id}/impact`)).data.plus, false);

  // Whichever lot the signature comes out of (here the trial's, which ends first), it counts.
  const mixed = await person('Reviewmixed');
  await subscribe(mixed, 45);
  const d3 = await simple(mixed.c, 'r4@signers.example');
  assert.equal((await mixed.c.get(`/envelopes/${d3.id}/impact`)).data.plus, true);
  assert.equal((await mixed.c.post(`/envelopes/${d3.id}/send`)).status, 200);
  assert.equal((await mixed.c.get(`/envelopes/${d3.id}/impact`)).data.sent.counted, 1);
});

// ---- The signing record and its switch ---------------------------------------------------------------------------

test('"Trees on the signing record": on by default, only admins switch it, and off leaves the box off the record', async () => {
  const p = await person('Gov');
  assert.deepEqual((await p.c.get('/account/impact-record')).data, { on: true });
  // A member reads it and cannot change it.
  assert.equal((await p.c.post('/account/invites', { email: 'member@trees.example', role: 'member' })).status, 200);
  const m = new Client();
  m.ip = '198.51.78.9';
  const inv = db.get('SELECT token FROM invites WHERE email=? ORDER BY created_at DESC', 'member@trees.example').token;
  assert.equal((await m.post('/auth/signup', { name: 'Mem Ber', email: 'member@trees.example', password: 'correct horse battery', invite: inv })).status, 200);
  const refused = await m.put('/account/impact-record', { on: false });
  assert.equal(refused.status, 403);
  assert.deepEqual((await p.c.get('/account/impact-record')).data, { on: true });
  // A body that is not a yes or no is refused in words, and nothing changes.
  const bad = await p.c.put('/account/impact-record', { on: 'no' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'Send "on" as true or false. Nothing was changed.');

  const before = await send(p, 'g1@signers.example');
  assert.equal((await signAll(before, 'g1@signers.example')).status, 200);
  assert.match(await record(p, before), /Signed without paper/);

  assert.deepEqual((await p.c.put('/account/impact-record', { on: false })).data, { on: false });
  const logged = db.all("SELECT kind, details FROM security_events WHERE account_id=? AND kind='settings.changed'", p.id);
  assert.ok(logged.some((l: any) => /trees_on_signing_record/.test(String(l.details))), 'the change is in the security record');
  const after = await send(p, 'g2@signers.example');
  assert.equal((await signAll(after, 'g2@signers.example')).status, 200);
  const rec = await record(p, after);
  assert.doesNotMatch(rec, /Signed without paper|mangrove|plant \d+ trees|sheets of paper|Treegens/);
  assert.match(rec, /Certificate|Signing record|Envelope/i, 'the rest of the record is there');
  // Screens are not changed by it: the signer's finished screen still has its numbers.
  assert.equal((await sees(after, 'g2@signers.example')).done.sheets, 1);
  // Another account is not touched.
  const q = await person('Biz');
  assert.deepEqual((await q.c.get('/account/impact-record')).data, { on: true });
  assert.deepEqual((await p.c.put('/account/impact-record', { on: true })).data, { on: true });
});

// ---- Totals, and the claims on the pages ------------------------------------------------------------------------

test('totals are hidden until they mean something, and no share of a tree is shown anywhere', () => {
  assert.deepEqual(TOTALS_FROM, { sheets: 1000, treesPlanted: 10 });
  assert.equal(totalWorthShowing(999), false);
  assert.equal(totalWorthShowing(1000), true);
  const view = read('src/components/ImpactView.tsx');
  assert.match(view, /if \(!paper && !planted\) return null;/);
  assert.match(read('src/components/Public.tsx'), /if \(!i \|\| \(!paper && !planted\)\) return null;/);
  assert.match(read('src/app/app/reports/page.tsx'), /\{totalWorthShowing\(r\.impact\.sheets\) && <div className="stat green">/);
  for (const f of ['src/components/ImpactView.tsx', 'src/components/Public.tsx', 'src/app/impact/page.tsx', 'src/app/app/impact/page.tsx', 'src/app/app/envelopes/[id]/page.tsx', 'src/components/sign/parts.tsx',
    'src/components/impact/SignerTrees.tsx', 'src/components/impact/SenderTrees.tsx', 'src/server/pdf.ts', 'src/app/app/reports/page.tsx'])
    assert.doesNotMatch(read(f), /fmtTrees|\} of a tree|Trees left standing|'…'/, f);
});

test('green claims: nothing generic, no carbon figure or claim anywhere, estimates called estimates, the consent screen left alone', () => {
  const mine = ['src/lib/impactwords.ts', 'src/components/impact/SignerTrees.tsx', 'src/components/impact/SenderTrees.tsx', 'src/components/impact/Mangroves.tsx', 'src/components/settings/TreesOnRecord.tsx',
    'src/server/impact.ts', 'src/server/routes-impact.ts', 'src/app/styles/impact.css'];
  for (const f of mine) assert.doesNotMatch(read(f), /\u2014/, `${f}: no em dash`);
  const strip = (s: string) => s.replace(/(?<!:)\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//g, '');
  const GENERIC = /eco.?friendly|planet.?friendly|environmentally friendly|sustainab|carbon.?neutral|climate.?positive|net.?zero|\boffsets?\b|CO2 removal/i;
  for (const f of [...mine.slice(0, 5), 'src/app/impact/page.tsx', 'src/app/app/impact/page.tsx', 'src/components/Public.tsx']) assert.doesNotMatch(strip(read(f)), GENERIC, f);
  // /impact names those words once, in the paragraph that says we do not claim them.
  const view = strip(read('src/components/ImpactView.tsx'));
  const [, rest] = view.split('What we do not claim');
  assert.ok(rest, 'the page says what is not claimed');
  assert.doesNotMatch(view.split('What we do not claim')[0], GENERIC);
  assert.match(rest, /We do not say that signing here offsets anything/);
  // The owner dropped the CO2 figure: no CO2 or carbon word anywhere on /impact, not even to deny it.
  assert.doesNotMatch(view, /CO2|carbon/i);
  assert.doesNotMatch(read('src/lib/impact.ts'), /co2|carbon/i, 'no CO2 constant or field left');
  // Estimates are called estimates where a figure about paper stands, with a source or the link to the working.
  assert.match(view, /Sheets of paper not used, estimated/);
  assert.match(view, /Water not used, estimated/);
  assert.match(view, /Van Oel and Hoekstra/);
  assert.match(view, /conservatree\.org/);
  assert.match(view, /href=\{TREEGENS_URL\}/);
  assert.match(read('src/components/impact/SignerTrees.tsx'), /An estimate: one paper copy of every page[\s\S]*Where these numbers come from/);
  // Trees are decided by the server and only drawn by the page: no page works out who is paid.
  for (const f of ['src/components/impact/SignerTrees.tsx', 'src/components/impact/SenderTrees.tsx']) assert.doesNotMatch(read(f), /@\/server|paidSignatureFor/, f);
  // The signing page: the line on the first screen (since the 5 trees rule), one line by Finish in each bar, and the card on the finished screen.
  const page = read('src/app/sign/[token]/page.tsx');
  assert.equal((page.match(/<TreeLine base=\{base\} show=\{acts && !hasNext\} \/>/g) || []).length, 2, 'the toolbar and the phone bar');
  assert.match(page, /<span className="sg-wide"><TreeLine /, 'the toolbar line is hidden where the phone bar shows its own');
  assert.equal((page.match(/<SignerDone /g) || []).length, 1);
  const consent = page.slice(page.indexOf("if (stage === 'consent')"), page.indexOf("if (stage === 'done')") > page.indexOf("if (stage === 'consent')") ? page.indexOf("if (stage === 'done')") : undefined);
  assert.equal((consent.match(/<OpenTrees base=\{base\}/g) || []).length, 1, 'the first screen says it once, through ConsentTop');
  assert.doesNotMatch(consent.split('// ---- The document')[0], /<TreeLine|<SignerDone/);
  // The picture: decoration to a screen reader, still under "reduce motion", and nothing faster than a slow rise.
  const css = read('src/app/styles/impact.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s+\.imp-pic\.imp-go \.imp-tree, \.imp-pic\.imp-go \.imp-leaf, \.imp-pic\.imp-go \.imp-sun \{ animation: none; \}/);
  assert.doesNotMatch(css, /infinite|blink|flash/);
  assert.match(read('src/components/impact/Mangroves.tsx'), /aria-hidden="true"/);
  const done = read('src/components/impact/SignerTrees.tsx');
  assert.match(done, /<div role="status" aria-live="polite">\{said && <h2 className="serif" id="imp-h">\{w\.title\}<\/h2>\}<\/div>/, 'one sentence, said once the region exists');
  assert.doesNotMatch(done, /w\.soft|SOFT_LINE/, 'nothing about plans on a screen a signer reads');
  assert.match(done, /e\.key === 'Escape'/);
  assert.match(done, />Close<\/button>/);
  assert.match(done, /\{w\.under && <p>\{w\.under\}<\/p>\}/, 'under the title: who plants, and the paper');
  // After Close the focus lands on the small card, and a keyboard user sees it there.
  assert.match(css, /\.imp-small:focus-visible \{ outline: 3px solid/);
  assert.doesNotMatch(done, /role="dialog"\s|<dialog|aria-modal/, 'a card in the page, never a dialog to close');
});

// ---- Repairs after the skeptic's and the simplicity reviewer's probes -------------------------------------------

test('a finished signature is counted by Finish itself: nobody has to open a screen, the switch can be off, and a later cancel does not lose it', async () => {
  const p = await person('Counted');
  await subscribe(p);
  assert.deepEqual((await p.c.put('/account/impact-record', { on: false })).data, { on: false });
  const e1 = await send(p, 'quiet1@signers.example');
  const e2 = await send(p, 'quiet2@signers.example');
  assert.equal((await signAll(e1, 'quiet1@signers.example')).status, 200);
  assert.equal((await signAll(e2, 'quiet2@signers.example')).status, 200);
  // Nobody asked /impact and no record was drawn with the box on: the rows are there all the same.
  const rows = db.all('SELECT trees FROM impact_signed WHERE account_id=?', p.id);
  assert.deepEqual(rows.map((r: any) => r.trees), [5, 5]);
  assert.equal(impact.treesOfAccount(p.id), 10);
  // A signature finished on an envelope that is cancelled afterwards stays counted.
  const made = await p.c.post('/envelopes', {
    subject: 'Two people', documents: [{ id: 'd', file_id: (await upload(p.c, 1)).id }],
    recipients: [{ id: 'a', role: 'signer', name: 'First One', email: 'v1@signers.example', routing_order: 1 }, { id: 'b', role: 'signer', name: 'Second One', email: 'v2@signers.example', routing_order: 1 }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e3 = made.data.envelope.id;
  assert.equal((await p.c.post(`/envelopes/${e3}/send`)).status, 200);
  assert.equal((await signAll(e3, 'v1@signers.example')).status, 200);
  assert.equal((await p.c.post(`/envelopes/${e3}/void`, { reason: 'Wrong draft' })).status, 200);
  assert.equal(db.all('SELECT 1 FROM impact_signed WHERE envelope_id=?', e3).length, 1, 'written at Finish, before the cancel');
  // The row is there with its 5 trees, and the account's total has it.
  assert.equal(impact.treesOnEnvelope(e3), 5);
  assert.equal(impact.treesOfAccount(p.id), 15);
  // Counting never stops a Finish: a row that cannot be read is simply not counted here.
  assert.doesNotThrow(() => impact.noteFinished('no-such-recipient'));
});

test('people who sign in person at one desk are never added together, and the host is told who plants', async () => {
  const p = await person('Desk');
  await subscribe(p);
  const walkIn = (name: string) => ({ recipients: [{ id: 'r', role: 'inperson', name, email: p.email }] });
  const one = await simple(p.c, p.email, walkIn('Walk-in One'));
  assert.equal((await p.c.post(`/envelopes/${one.id}/send`)).status, 200);
  // The email goes to the host: it names the person who signs, and does not tell the host "when you finish".
  const mail = textOf(mailTo(p.email).filter((m: any) => /Walk-in One/.test(m.html)).at(-1)!.html);
  assert.match(mail, /5 trees will be planted with Treegens when Walk-in One finishes\./);
  assert.doesNotMatch(mail, /when you finish/);
  assert.equal((await signAll(one.id, p.email)).status, 200);
  const a = (await sees(one.id, p.email)).done;
  assert.deepEqual([a.trees, a.first, a.celebrate, a.total], [5, true, true, 5]);
  await new Client().post(`/sign/${tokenFor(one.id, p.email)}/impact/seen`);

  // A second walk-in, a different person, under the same host address: their own first time, and only their own 5.
  const two = await simple(p.c, p.email, walkIn('Walk-in Two'));
  assert.equal((await p.c.post(`/envelopes/${two.id}/send`)).status, 200);
  assert.equal((await signAll(two.id, p.email)).status, 200);
  const b = (await sees(two.id, p.email)).done;
  assert.deepEqual([b.trees, b.first, b.celebrate, b.total], [5, true, true, 5]);
  assert.doesNotMatch(Object.values(signerWords(b)).join(' '), /more|10 trees|so far/);
  // Nothing of them is kept under the host's address, so the host's own later signature elsewhere inherits nothing.
  assert.equal(db.all('SELECT 1 FROM impact_signed WHERE account_id=? AND who IS NOT NULL', p.id).length, 0);
  const q = await person('Elsewhere');
  await subscribe(q);
  const e3 = await send(q, p.email);
  assert.equal((await signAll(e3, p.email)).status, 200);
  const c = (await sees(e3, p.email)).done;
  assert.deepEqual([c.trees, c.first, c.total], [5, true, 5], 'the host signing for themselves starts their own count');
  // The account's count has both walk-ins.
  assert.equal(impact.treesOfAccount(p.id), 10);
});

test('a first signature that plants, after one that planted none: never "5 more", and the seedlings are shown once for it', async () => {
  // The only signature that plants none is a sender's own. Mona signs her own document first.
  const mona = await person('Mona');
  const e1 = await simple(mona.c, mona.email, { recipients: [{ id: 'r', role: 'signer', name: mona.name, email: mona.email }] });
  assert.equal((await mona.c.post(`/envelopes/${e1.id}/send`)).status, 200);
  assert.equal((await signAll(e1.id, mona.email)).status, 200);
  const own = (await sees(e1.id, mona.email)).done;
  assert.deepEqual([own.trees, own.celebrate], [0, true]);
  await new Client().post(`/sign/${tokenFor(e1.id, mona.email)}/impact/seen`);
  assert.equal((await sees(e1.id, mona.email)).done.celebrate, false);

  // Then somebody else asks her to sign, with a free trial signature of theirs: her first that plants.
  const asker = await person('Asker');
  const e2 = await send(asker, mona.email);
  assert.equal((await signAll(e2, mona.email)).status, 200);
  const d = (await sees(e2, mona.email)).done;
  assert.deepEqual(d, { trees: 5, first: false, celebrate: true, total: 5, sheets: 1 });
  const w = signerWords(d);
  assert.equal(w.title, 'Your signature plants 5 trees');
  assert.doesNotMatch(`${w.line} ${w.count}`, /more/, 'none came before, so none are "more"');
  await new Client().post(`/sign/${tokenFor(e2, mona.email)}/impact/seen`);
  assert.equal((await sees(e2, mona.email)).done.celebrate, false, 'once');
  // Her own one, opened again later, does not bring the picture back either.
  assert.equal((await sees(e1.id, mona.email)).done.celebrate, false);
  // And the third time is an ordinary later time.
  const e3 = await send(asker, mona.email);
  assert.equal((await signAll(e3, mona.email)).status, 200);
  const third = (await sees(e3, mona.email)).done;
  assert.deepEqual([third.celebrate, third.total], [false, 10]);
  assert.equal(signerWords(third).line, 'Your signature plants 5 more trees. You saved 1 page of paper from a tree.');
});

test('"Every signature" is said to a sender only when every person who signs counts: not when the sender signs too', async () => {
  const p = await person('Cosign');
  await subscribe(p);
  const made = await p.c.post('/envelopes', {
    subject: 'We both sign', documents: [{ id: 'd', file_id: (await upload(p.c, 1)).id }],
    recipients: [{ id: 'me', role: 'signer', name: p.name, email: p.email, routing_order: 1 }, { id: 'o', role: 'signer', name: 'Out Sider', email: 'outsider@signers.example', routing_order: 1 }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'me', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'o', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const eid = made.data.envelope.id;
  assert.equal((await p.c.post(`/envelopes/${eid}/send`)).status, 200);
  const s = (await p.c.get(`/envelopes/${eid}/impact`)).data.sent;
  assert.deepEqual([s.counted, s.signers], [1, 2], 'two signatures on it, one of them the sender\'s own, which plants nothing');
  assert.equal(senderWords(s).promise, 'Each person you asked to sign plants 5 trees with Treegens.');
});

test('the sender\'s screens: the first-send picture inside the "Sent." card, started and marked only when on screen, and no card of its own', () => {
  const sender = read('src/components/impact/SenderTrees.tsx');
  // Marked as shown only from the observer's start, like the signer's picture: never at mount, below the fold.
  const head = sender.slice(sender.indexOf('export function SentHead'), sender.indexOf('export function SenderTrees'));
  assert.match(head, /const start = \(\) => \{\s+setGo\(true\);\s+api\(`\/envelopes\/\$\{envelopeId\}\/impact\/seen`, \{ method: 'POST' \}\)/);
  assert.match(head, /new IntersectionObserver\(/);
  assert.equal((sender.match(/impact\/seen/g) || []).length, 1, '"seen" is posted from one place');
  assert.match(head, /<Mangroves trees=\{[^}]+\} go=\{go\} \/>/, 'the picture waits for go');
  // Nothing to close, so no button under a toast and no choice added to the first send.
  assert.doesNotMatch(sender, /<button|className="card/);
  assert.doesNotMatch(sender, /SOFT_LINE|\.soft\b/, 'nothing about plans on the sender\'s screens');
  // It lives in the card that says "Sent.", at the top of the page; the paper line is a sentence of the waiting card.
  assert.match(read('src/components/sender/AfterSend.tsx'), /<SentHead envelopeId=\{envelope\.id\} id="sn-sent-h" \/>/);
  const page = read('src/app/app/envelopes/[id]/page.tsx');
  assert.equal((page.match(/<SenderTrees /g) || []).length, 2);
  assert.match(page, /<SenderTrees envelopeId=\{e\.id\} status=\{e\.status\} line \/>/);
  assert.doesNotMatch(page, /\{out && <SenderTrees/);
  assert.doesNotMatch(read('src/app/styles/impact.css'), /\.imp-sender\b/);
});

test('the setting says itself in one line, and /impact says what a reader cannot check yet', () => {
  const setting = read('src/components/settings/TreesOnRecord.tsx');
  const hint = setting.match(/id="trees-record-hint"[^>]*>([^<]+)</)![1];
  assert.equal(hint, 'Adds the paper saved and the trees planted to the last page of documents completed from now on. Saves by itself.');
  assert.ok(words(hint) <= 22, `${words(hint)} words under the switch`);
  assert.match(setting, /role="switch"/);
  const view = read('src/components/ImpactView.tsx');
  // Nothing is said about how Treegens checks plantings that nobody here has read on Treegens' own pages.
  assert.doesNotMatch(view, /on video|checked before they count/);
  assert.match(view, /we have not checked plantings ourselves/);
  assert.match(view, /we do not publish receipts for the money sent to Treegens/);
  // That line was about the CO2 figure, which the owner dropped: it goes with it.
  assert.doesNotMatch(view, /working assumption of ours/);
  assert.match(view, /toward the upper end of published figures/);
});

test('the API description and the README say what was built', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  for (const path of ['/sign/{token}/impact', '/envelopes/{id}/impact', '/account/impact-record']) assert.ok(spec.paths[path], `${path} is described`);
  assert.ok(spec.paths['/account/impact-record'].put);
  const readme = read('README.md');
  assert.match(readme, /tests\/impact\.test\.ts/);
  assert.match(readme, /Trees on the signing record/);
});
