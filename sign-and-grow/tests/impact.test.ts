// Trees (research/briefs.json "impact"): who is told that mangroves are planted and who is not, the first time and
// every later time, the counts, the line in the email, the signing record and its switch, and the words themselves.
// The payment provider is the stand-in of the billing tests (tests/stripe-fake.ts): nothing here reaches the network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, mailTo, simple, signAll, upload, tokenFor, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { finishLine, mailLine, signerWords, senderWords, reviewPlus, recordLines, SOFT_LINE, TREES_PER_SIGNATURE } from '../src/lib/impactwords.ts';
import { TOTALS_FROM, totalWorthShowing } from '../src/lib/impact.ts';

let db: Server['db'];
let billing: Server['billing'];
let impact: typeof import('../src/server/impact.ts');

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
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

test('the words: 10 mangroves only for a paid signature, the soft line for a free one, never a figure under one tree', () => {
  assert.equal(TREES_PER_SIGNATURE, 10);
  assert.equal(finishLine(10), '10 mangroves will be planted when you finish.');
  assert.equal(finishLine(0), '');
  assert.equal(finishLine(0.4), '', 'nothing under one tree is ever said');
  assert.equal(mailLine(10), '10 mangroves will be planted with Treegens when you finish.');
  assert.equal(mailLine(0), '');

  const first = signerWords({ trees: 10, first: true, total: 10, sheets: 15 });
  assert.equal(first.title, 'You just planted 10 mangroves');
  assert.equal(first.line, 'You saved 15 pages of paper from a tree, and 10 mangroves are being planted.');
  assert.equal(first.count, '', 'the running count says nothing this signature did not already say');
  assert.equal(first.soft, '');
  assert.equal(first.announce, 'You just planted 10 mangroves.', 'one sentence for a screen reader');

  const later = signerWords({ trees: 10, first: false, total: 40, sheets: 1 });
  assert.equal(later.line, '10 more mangroves. You saved 1 page of paper from a tree.');
  assert.equal(later.count, 'You have planted 40 mangroves by signing on GrowSigning.');

  const free = signerWords({ trees: 0, first: true, total: 0, sheets: 6 });
  assert.equal(free.title, 'You signed your first GrowSigning');
  assert.equal(free.line, 'You saved 6 pages of paper from a tree.');
  assert.equal(free.soft, SOFT_LINE);
  assert.equal(free.count, '');
  assert.doesNotMatch(`${free.title} ${free.line} ${free.announce}`, /planted \d|10 mangroves/, 'a free signature is never said to plant anything');
  // Free, but this person planted with earlier paid signatures: the count is true and is said.
  assert.equal(signerWords({ trees: 0, first: false, total: 20, sheets: 2 }).count, 'You have planted 20 mangroves by signing on GrowSigning.');

  assert.equal(senderWords({ paid: 2, signers: 2, planted: 0, sheets: 15 }).promise, 'Every signature on it plants 10 mangroves with Treegens.');
  assert.equal(senderWords({ paid: 1, signers: 3, planted: 0, sheets: 15 }).promise, 'Each paid signature on it plants 10 mangroves with Treegens.');
  const trial = senderWords({ paid: 0, signers: 2, planted: 0, sheets: 15 });
  assert.equal(trial.promise, SOFT_LINE);
  assert.equal(trial.title, 'Your first GrowSigning is out.');
  assert.equal(trial.saving, 'This saves 15 pages of paper from a tree.');
  assert.equal(trial.count, '');
  assert.equal(reviewPlus(true), 'Plus: 10 mangroves are planted for each person who signs.');
  assert.equal(reviewPlus(false), '');

  const paidRecord = recordLines({ sheets: 15, litresWater: 150, kgCo2: 0.0675, trees: 20, site: 'https://sign.example' });
  assert.deepEqual(paidRecord, ['An estimate: about 15 sheets of paper, 150 litres of water and 0.07 kg of CO2e were not used.', 'The signatures paid for on this document fund 20 mangroves, planted by Treegens. How we count: https://sign.example/impact']);
  assert.equal(recordLines({ sheets: 1, litresWater: 10, kgCo2: 0.0045, trees: 0, site: 'https://sign.example' })[1], `${SOFT_LINE} How we count: https://sign.example/impact`);

  // Every sentence above: no em dash, no generic claim, no carbon claim, no share of a tree, no money word.
  const all = [finishLine(10), mailLine(10), SOFT_LINE, reviewPlus(true), ...paidRecord, ...Object.values(first), ...Object.values(later), ...Object.values(free), ...Object.values(trial)].join(' ');
  assert.doesNotMatch(all, /\u2014|eco.?friendly|\bgreen\b|sustainab|planet|carbon neutral|climate|offset|\d of a tree|0\.\d+ tree/i);
  assert.doesNotMatch([finishLine(10), ...Object.values(first), ...Object.values(later), ...Object.values(free)].join(' '), /\$|dollar|pays?\b|paid|price|plan\b/i, 'no money words where a signer reads');
});

// ---- Free signatures ----------------------------------------------------------------------------------------------

test('a free signature (the trial): nobody is told a tree is planted, the first time is still marked, and it is shown once', async () => {
  const p = await person('Trial');
  const eid = await send(p, 'una@signers.example');
  assert.doesNotMatch(textOf(lastInvite('una@signers.example').html), /mangrove|planted/i, 'no tree line in the email for a free signature');
  assert.deepEqual(await sees(eid, 'una@signers.example'), { finish: 0, done: null });
  assert.equal((await signAll(eid, 'una@signers.example')).status, 200);
  const done = (await sees(eid, 'una@signers.example')).done;
  assert.deepEqual(done, { trees: 0, first: true, celebrate: true, total: 0, sheets: 1 });
  // Shown: the server remembers, on any device.
  assert.equal((await new Client().post(`/sign/${tokenFor(eid, 'una@signers.example')}/impact/seen`)).status, 200);
  assert.deepEqual((await sees(eid, 'una@signers.example')).done, { ...done, celebrate: false });
  // The signing record says the soft line and claims no tree for this document.
  const rec = await record(p, eid);
  assert.match(rec, /Signed without paper/);
  assert.match(rec, /An estimate: about 1 sheet of paper, 10 litres of water and 0 kg of CO2e were not used\./);
  assert.ok(rec.includes(SOFT_LINE));
  assert.doesNotMatch(rec, /fund \d+ mangroves|of a tree|Every dollar/);
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
  assert.equal((await p.c.get(`/envelopes/${e.id}/impact`)).data.sent.paid, 0);
});

test('a server that takes no payments says nothing about planting anywhere', async () => {
  const p = await person('Nopay');
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const eid = await send(p, 'zed@signers.example');
    assert.equal((await sees(eid, 'zed@signers.example')).finish, 0);
    assert.doesNotMatch(textOf(lastInvite('zed@signers.example').html), /mangrove/i);
    const d = (await p.c.get(`/envelopes/${eid}/impact`)).data;
    assert.equal(d.sent.paid, 0);
    assert.equal(senderWords(d.sent).promise, SOFT_LINE);
    const draft = await simple(p.c, 'zed2@signers.example');
    assert.equal((await p.c.get(`/envelopes/${draft.id}/impact`)).data.plus, false);
  } finally {
    process.env.STRIPE_SECRET_KEY = key;
  }
});

// ---- Paid signatures ----------------------------------------------------------------------------------------------

test('a paid signature: the line by Finish and in the email for the signer only, the first time once, then "10 more" and the count', async () => {
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
  assert.ok(aboveButton(mail.html).includes('10 mangroves will be planted with Treegens when you finish.'), aboveButton(mail.html));
  assert.ok(words(aboveButton(mail.html)) <= 80, `${words(aboveButton(mail.html))} words above the button`);
  assert.doesNotMatch(textOf(mail.html), /\$|dollar|pays for/i, 'no money words to someone who only came to sign');
  for (const other of ['abe', 'vic', 'cee']) {
    assert.ok(mailTo(`${other}@signers.example`).length > 0, `${other} was emailed`);
    for (const m of mailTo(`${other}@signers.example`)) assert.doesNotMatch(textOf(m.html), /mangrove|planted/i, `${other} is not told they plant anything`);
  }

  // The signing page: the signer is told next to Finish, an approver, a viewer and a copy are told nothing.
  assert.deepEqual(await sees(eid, 'ada@signers.example'), { finish: 10, done: null });
  for (const other of ['abe', 'vic', 'cee']) assert.deepEqual(await sees(eid, `${other}@signers.example`), { finish: 0, done: null });

  for (const who of ['ada', 'abe', 'vic']) assert.equal((await signAll(eid, `${who}@signers.example`)).status, 200, who);
  for (const other of ['abe', 'vic', 'cee']) assert.deepEqual(await sees(eid, `${other}@signers.example`), { finish: 0, done: null }, `${other} after finishing`);
  // 3 pages for 4 people: 12 sheets. The first time: the picture, once.
  const first = (await sees(eid, 'ada@signers.example')).done;
  assert.deepEqual(first, { trees: 10, first: true, celebrate: true, total: 10, sheets: 12 });
  assert.equal(signerWords(first).title, 'You just planted 10 mangroves');
  await new Client().post(`/sign/${tokenFor(eid, 'ada@signers.example')}/impact/seen`);
  assert.equal((await sees(eid, 'ada@signers.example')).done.celebrate, false);

  // The same person signs again, for another account even: no picture, "10 more", and the count from real rows.
  const q = await person('Second');
  await subscribe(q);
  const e2 = await send(q, 'ADA@signers.example');
  assert.equal((await sees(e2, 'ADA@signers.example')).finish, 10);
  assert.equal((await signAll(e2, 'ADA@signers.example')).status, 200);
  const later = (await sees(e2, 'ADA@signers.example')).done;
  assert.deepEqual(later, { trees: 10, first: false, celebrate: false, total: 20, sheets: 1 });
  assert.equal(signerWords(later).line, '10 more mangroves. You saved 1 page of paper from a tree.');
  assert.equal(signerWords(later).count, 'You have planted 20 mangroves by signing on GrowSigning.');

  // What is kept: no address, only a keyed hash.
  const rows = db.all('SELECT * FROM impact_signed');
  assert.ok(rows.length >= 2);
  assert.doesNotMatch(JSON.stringify(rows), /@|signers\.example|Ada/i);
  assert.doesNotMatch(JSON.stringify(db.all('SELECT * FROM impact_seen')), /@|signers\.example/);

  // The sender's page: every signature on it is a paid one; the signing record names the trees of this document.
  const s = (await p.c.get(`/envelopes/${eid}/impact`)).data.sent;
  assert.deepEqual([s.paid, s.signers, s.planted, s.sheets], [1, 1, 10, 12]);
  const rec = await record(p, eid);
  assert.match(rec, /The signatures paid for on this document fund 10 mangroves, planted by Treegens\. How we count: http:\/\/test\.local\/impact/);
  assert.match(rec, /An estimate: about 12 sheets of paper, 120 litres of water and 0\.05 kg of CO2e were not used\./);
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
  assert.equal((await sees(e2, 'old@signers.example')).done.celebrate, false);
  // A row outlives its envelope: with both envelopes gone from the tables, a third signature is still not the first.
  db.run('DELETE FROM recipients WHERE envelope_id IN (?,?)', e1, e2);
  const e3 = await send(p, 'old@signers.example');
  assert.equal((await signAll(e3, 'old@signers.example')).status, 200);
  assert.equal((await sees(e3, 'old@signers.example')).done.first, false);
});

test('a payment that went back no longer counts: the trees of its signatures are not claimed afterwards', async () => {
  const p = await person('Refund');
  await subscribe(p);
  const eid = await send(p, 'rita@signers.example');
  assert.equal((await signAll(eid, 'rita@signers.example')).status, 200);
  assert.equal((await sees(eid, 'rita@signers.example')).done.total, 10);
  assert.equal(impact.treesOfAccount(p.id), 10);
  const ch = stripe.refundByHand(`ch_ini_${p.k}_1`, 900);
  await event('charge.refunded', { ...ch, id: `ch_ini_${p.k}_1` });
  const d = (await sees(eid, 'rita@signers.example')).done;
  assert.deepEqual([d.trees, d.total], [0, 0]);
  assert.equal(impact.treesOfAccount(p.id), 0);
  assert.equal(impact.treesOnEnvelope(eid), 0);
  assert.equal((await p.c.get(`/envelopes/${eid}/impact`)).data.sent.planted, 0);
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
  assert.deepEqual(a, { paid: 0, signers: 1, planted: 0, sheets: 1, celebrate: true });
  assert.equal(senderWords(a).announce, `Your first GrowSigning is out. ${SOFT_LINE}`, 'the trial plants nothing, so nothing is promised');
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
  assert.deepEqual((await fresh.c.get(`/envelopes/${d.id}/impact`)).data, { plus: false, sent: null });
  assert.equal((await fresh.c.post(`/envelopes/${d.id}/impact/seen`)).status, 200);
  assert.equal((await fresh.c.post(`/envelopes/${d.id}/send`)).status, 200);
  assert.equal((await fresh.c.get(`/envelopes/${d.id}/impact`)).data.sent.celebrate, true, 'the draft could not use up the first time');

  // With a paid month: the promise names the trees, because every signature on it is a paid one.
  const paid = await person('Paidfirst');
  await subscribe(paid);
  const pe = await send(paid, 'pf@signers.example');
  const s = (await paid.c.get(`/envelopes/${pe}/impact`)).data.sent;
  assert.deepEqual([s.paid, s.signers, s.celebrate], [1, 1, true]);
  assert.equal(senderWords(s).promise, 'Every signature on it plants 10 mangroves with Treegens.');
});

test('the review step says "Plus: 10 mangroves" only when every signature of the draft would be a paid one', async () => {
  const trial = await person('Reviewtrial');
  const d1 = await simple(trial.c, 'r1@signers.example');
  assert.equal((await trial.c.get(`/envelopes/${d1.id}/impact`)).data.plus, false, 'the trial is free');

  const paid = await person('Reviewpaid');
  await subscribe(paid, 20); // ends before the trial: the paid month is used first
  const d2 = await simple(paid.c, 'r2@signers.example');
  assert.equal((await paid.c.get(`/envelopes/${d2.id}/impact`)).data.plus, true);
  // Signing it yourself uses no signature: nothing is planted, nothing is said.
  const own = await simple(paid.c, paid.email, { recipients: [{ id: 'r', role: 'signer', name: paid.name, email: paid.email }] });
  assert.equal((await paid.c.get(`/envelopes/${own.id}/impact`)).data.plus, false);
  // Only a copy and an approver: nobody signs.
  const none = await simple(paid.c, 'r3@signers.example', { recipients: [{ id: 'r', role: 'approver', name: 'Abe', email: 'r3@signers.example' }], fields: [] });
  assert.equal((await paid.c.get(`/envelopes/${none.id}/impact`)).data.plus, false);

  // The trial ends first here, so the next signature is a free one: not "all paid".
  const mixed = await person('Reviewmixed');
  await subscribe(mixed, 45);
  const d3 = await simple(mixed.c, 'r4@signers.example');
  assert.equal((await mixed.c.get(`/envelopes/${d3.id}/impact`)).data.plus, false);
  // And after sending, the truth is asked again: the held signature is the trial's.
  assert.equal((await mixed.c.post(`/envelopes/${d3.id}/send`)).status, 200);
  assert.equal((await mixed.c.get(`/envelopes/${d3.id}/impact`)).data.sent.paid, 0);
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
  assert.doesNotMatch(rec, /Signed without paper|mangrove|sheets of paper|Treegens/);
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

test('green claims: nothing generic, no carbon claim for the mangroves, estimates called estimates, the consent screen left alone', () => {
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
  assert.match(rest, /We do not say that signing here takes CO2 out of the air, offsets anything, or makes a document or a company carbon neutral/);
  // Estimates are called estimates where a figure about paper stands, with a source or the link to the working.
  assert.match(view, /Sheets of paper not used, estimated/);
  assert.match(view, /Water not used, estimated/);
  assert.match(view, /CO2e not emitted, estimated/);
  assert.match(view, /Van Oel and Hoekstra/);
  assert.match(view, /conservatree\.org/);
  assert.match(view, /href=\{TREEGENS_URL\}/);
  assert.match(read('src/components/impact/SignerTrees.tsx'), /An estimate: one paper copy of every page[\s\S]*Where these numbers come from/);
  // Trees are decided by the server and only drawn by the page: no page works out who is paid.
  for (const f of ['src/components/impact/SignerTrees.tsx', 'src/components/impact/SenderTrees.tsx']) assert.doesNotMatch(read(f), /@\/server|paidSignatureFor/, f);
  // The signing page: one line by Finish in each bar, the card on the finished screen, and nothing on the consent screen.
  const page = read('src/app/sign/[token]/page.tsx');
  assert.equal((page.match(/<TreeLine base=\{base\} show=\{acts && !hasNext\} \/>/g) || []).length, 2, 'the toolbar and the phone bar');
  assert.match(page, /<span className="sg-wide"><TreeLine /, 'the toolbar line is hidden where the phone bar shows its own');
  assert.equal((page.match(/<SignerDone /g) || []).length, 1);
  const consent = page.slice(page.indexOf("if (stage === 'consent')"), page.indexOf("if (stage === 'done')") > page.indexOf("if (stage === 'consent')") ? page.indexOf("if (stage === 'done')") : undefined);
  if (page.includes("if (stage === 'consent')")) assert.doesNotMatch(consent.split('// ---- The document')[0], /TreeLine|SignerDone|mangrove/);
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
  assert.doesNotMatch(done, /role="dialog"\s|<dialog|aria-modal/, 'a card in the page, never a dialog to close');
});

test('the API description and the README say what was built', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  for (const path of ['/sign/{token}/impact', '/envelopes/{id}/impact', '/account/impact-record']) assert.ok(spec.paths[path], `${path} is described`);
  assert.ok(spec.paths['/account/impact-record'].put);
  const readme = read('README.md');
  assert.match(readme, /tests\/impact\.test\.ts/);
  assert.match(readme, /Trees on the signing record/);
});
