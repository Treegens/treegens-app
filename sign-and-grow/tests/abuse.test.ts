// Keeping scammers and strangers out: the filter for fake payment notices, the daily limit, the pause, reports,
// who may read a support message, access codes, public forms, and reporting an email with its security code.
// Every test here pins down a way round one of those rules that an audit found. Each failed before its fix.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, upload, simple, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';

let db: Server['db'];
let cron: Server['cron'];
let op: Client; // one of the people who run the service
before(async () => {
  ({ db, cron } = await boot());
  op = await person('Olive Operator', 'olive@signgrow.test');
});

// Sign-ups, public forms and reports are limited per address, so everyone here comes from their own.
let n = 0;
const ip = () => `198.${18 + (++n >> 8)}.${n & 255}.7`;
const from = (address: string) => Object.assign(new Client(), { ip: address });
const visitor = () => from(ip());
const person = (name: string, email: string) => signUp(name, email, ip());
const accountOf = async (c: Client): Promise<string> => (await c.get('/me')).data.account.id;
const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
// The editor sends back the whole envelope; this builds that body from what the server returns.
const asBody = (e: any) => ({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields });
const asOperator = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.OPERATOR_EMAILS = 'olive@signgrow.test';
  try {
    return await fn();
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
};
const slugOf = async (c: Client) => (await c.get('/powerforms')).data.powerforms[0].slug;
const envelopeOf = (url: string) => db.get('SELECT envelope_id e FROM recipients WHERE token=?', url.split('/sign/')[1]).e as string;
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

const LURE = 'Your payment of $499.00 was charged. To cancel call +1 (888) 555-0142 now.';
const FORM_CLOSED = 'This form cannot take new signatures right now. Please contact whoever gave you the link.';

test('the filter for fake payment notices reads everything a recipient reads, however it is spelled', async () => {
  // The brand is in the names the email goes out under, not in the subject.
  const posing = await person('PayPal Billing', 'b@scam.test');
  const b = await simple(posing, 'victim-b@example.com', { subject: 'Invoice #4471', message: LURE });
  const refused = await posing.post(`/envelopes/${b.id}/send`);
  assert.equal(refused.status, 422);
  assert.match(refused.data.error, /reads like PayPal/);
  assert.match(refused.data.error, /contact form at http:\/\/test\.local\/help/, 'and says how to reach a person');
  assert.equal(mailTo('victim-b@example.com').length, 0);

  const bea = await person('Bea Honest', 'bea@honest.test');
  const ordinary = await simple(bea, 'client-bea@example.com');
  assert.equal((await bea.call('PATCH', '/account', { name: 'Microsoft Support' })).status, 200);
  const underBrand = await bea.post(`/envelopes/${ordinary.id}/send`);
  assert.equal(underBrand.status, 422, 'an account named after a brand is posing, whatever the document says');
  assert.match(underBrand.data.error, /reads like Microsoft/);
  assert.equal((await bea.call('PATCH', '/account', { name: 'Apple Tree Nursery' })).status, 200);
  assert.equal((await bea.post(`/envelopes/${ordinary.id}/send`)).status, 200, 'a brand that is also an everyday word is fine beside other words');
  const norton = await person('Norton Smith', 'norton@honest.test');
  const fromNorton = await simple(norton, 'client-norton@example.com');
  assert.equal((await norton.post(`/envelopes/${fromNorton.id}/send`)).status, 200, 'and so is a family name');

  // The lure is in the note to one recipient, which the email prints.
  const carl = await person('Carl Con', 'c@scam.test');
  const inNote = await simple(carl, 'victim-c@example.com', { subject: 'Account notice', recipients: [{ id: 'r', role: 'signer', name: 'Vic', email: 'victim-c@example.com', note: `PayPal invoice: ${LURE}` }] });
  assert.equal((await carl.post(`/envelopes/${inNote.id}/send`)).status, 422);

  // Full-width letters with a zero-width space, spaced letters, Cyrillic letters and a digit, a capital I for an l.
  for (const subject of ['Ｐａｙ​Ｐａｌ invoice', 'P a y - P a l invoice', 'PаyPа1 invoice', 'PayPaI invoice', 'Micr0soft invoice', 'GEEK-SQUAD invoice']) {
    const x = await simple(carl, 'victim-c2@example.com', { subject, message: LURE });
    assert.equal((await carl.post(`/envelopes/${x.id}/send`)).status, 422, subject);
  }
  for (const [subject, message] of [['Invoice 12 for garden work', 'Thanks. Questions? Call +1 (415) 555-0199.'], ['Pineapple order confirmation', 'Your payment arrived. Call +1 (415) 555-0199.']]) {
    const x = await simple(carl, 'client-c@example.com', { subject, message });
    assert.equal((await carl.post(`/envelopes/${x.id}/send`)).status, 200, `ordinary: ${subject}`);
  }

  // Something clean is sent, then corrected into the lure and pointed at a new address.
  const dana = await person('Dana Drift', 'd@scam.test');
  const d = await simple(dana, 'first-d@example.com', { subject: 'Hello', message: 'Please sign.' });
  assert.equal((await dana.post(`/envelopes/${d.id}/send`)).status, 200);
  const body = asBody((await full(dana, d.id)).envelope);
  const into = await dana.put(`/envelopes/${d.id}`, { ...body, subject: 'PayPal invoice #4471', message: LURE, recipients: [{ ...body.recipients[0], email: 'victim-d@example.com' }] });
  assert.equal(into.status, 422);
  assert.equal(mailTo('victim-d@example.com').length, 0);
  assert.equal((await full(dana, d.id)).envelope.subject, 'Hello', 'nothing of the refused correction was kept');
  assert.equal((await dana.put(`/envelopes/${d.id}`, { ...body, message: `PayPal invoice. ${LURE}` })).status, 422, 'also when nobody new is added');
  // Or the sender takes a brand's name afterwards and nudges the people who already have it.
  assert.equal((await dana.call('PATCH', '/me', { name: 'Venmo Payments' })).status, 200);
  const before = mailTo('first-d@example.com').length;
  assert.equal((await dana.post(`/envelopes/${d.id}/remind`)).status, 422);
  assert.equal((await dana.post(`/envelopes/${d.id}/correct`, { recipient_id: body.recipients[0].id, email: 'victim-d2@example.com' })).status, 422);
  assert.equal(mailTo('first-d@example.com').length, before);
  assert.equal(mailTo('victim-d2@example.com').length, 0);
  // The reason for voiding is emailed to everyone on the envelope, so it is read too. Voiding itself is never refused.
  assert.equal((await dana.post(`/envelopes/${d.id}/void`, { reason: `PayPal invoice cancelled. ${LURE}` })).status, 422);
  assert.equal(mailTo('first-d@example.com').length, before);
  assert.equal((await dana.post(`/envelopes/${d.id}/void`, { reason: 'Sent by mistake' })).status, 200);

  // In bulk and through a public form.
  const tpl = await simple(carl, '', { kind: 'template', subject: 'PayPal invoice', message: `PayPal: ${LURE}`, recipients: [{ id: 'r', role: 'signer', role_name: 'Payer' }] });
  const bulk = await carl.post('/bulk', { template_id: tpl.id, rows: [{ Payer: { name: 'Vic', email: 'victim-e@example.com' } }] });
  assert.equal(bulk.status, 422);
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', await accountOf(carl)).n, 0, 'refused as a whole, before anything was written');
  await carl.post('/powerforms', { template_id: tpl.id, name: 'Pay here' });
  const walkIn = await visitor().post(`/public/powerforms/${await slugOf(carl)}/start`, { name: 'Walk In', email: 'victim-f@example.com' });
  assert.equal(walkIn.status, 503);
  assert.equal(walkIn.data.error, FORM_CLOSED, 'the visitor is not told the owner\'s business');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL AND account_id=?', await accountOf(carl)).n, 0, 'and nothing of theirs is kept');
  assert.ok(mailTo('c@scam.test').some((m) => m.subject.includes('could not take a signature') && /payment notice/.test(m.html)), 'the owner is told the real reason');

  // Age does not lift the filter. A payment that was kept does.
  const hal = await person('Hal Old', 'h@scam.test');
  const hacc = await accountOf(hal);
  db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(400), hacc);
  const h = await simple(hal, 'victim-h@example.com', { subject: 'PayPal invoice #4471', message: LURE });
  assert.equal((await hal.post(`/envelopes/${h.id}/send`)).status, 422, 'a free account is checked however old it is');
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, refunded_cents) VALUES ('pay_hal', ?, 900, 'usd', ?, 900)", hacc, ago(1));
  assert.equal((await hal.post(`/envelopes/${h.id}/send`)).status, 422, 'a payment that was refunded in full is not a payment');
  db.run("UPDATE payments SET refunded_cents=0 WHERE id='pay_hal'");
  assert.equal((await hal.post(`/envelopes/${h.id}/send`)).status, 200);
});

test('the daily limit counts every person newly emailed, and an account that has not paid keeps one after its first week', async () => {
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '5';
  process.env.UNPAID_DAILY_RECIPIENTS = '8';
  try {
    const eve = await person('Eve Many', 'eve@many.test');
    const acc = await accountOf(eve);
    const file = await upload(eve, 1);
    const viewers = (tag: string, k: number) => Array.from({ length: k }, (_, i) => ({ id: `v${i}`, role: 'viewer', name: `P ${i}`, email: `${tag}${i}@example.com` }));
    const make = async (recipients: any[], fields: any[] = []) => (await eve.post('/envelopes', { subject: 'Newsletter', documents: [{ id: 'd', file_id: file.id }], recipients, fields })).data.envelope;
    // Four viewers and Eve herself as the signer: five people.
    const first = await make([...viewers('first', 4), { id: 's', role: 'signer', name: 'Eve Many', email: 'eve@many.test' }], [{ id: 'f', document_id: 'd', recipient_id: 's', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }]);
    assert.equal((await eve.post(`/envelopes/${first.id}/send`)).status, 200);
    const sixth = await simple(eve, 'sixth@example.com');
    const no = await eve.post(`/envelopes/${sixth.id}/send`);
    assert.equal(no.status, 429);
    assert.match(no.data.error, /^In its first week, an account that has not paid can send to 5 people a day\./, 'the number');
    assert.match(no.data.error, /has sent to 5 in the last 24 hours and this would add 1\./);
    assert.match(no.data.error, /room for this again in about 24 hours/, 'when it resets');
    assert.match(no.data.error, /To lift the limit, use the contact form at http:\/\/test\.local\/help and a person can lift it for you\./, 'how to lift it');
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.match((await eve.post(`/envelopes/${sixth.id}/send`)).data.error, /pay for anything on the Plan page/, 'with paying switched on, that is the other way');
    delete process.env.STRIPE_SECRET_KEY;

    // Changing the addresses on the envelope that is out, adding a person, the quick correct: all new people.
    const cur = (await full(eve, first.id)).envelope;
    const swapped = await eve.put(`/envelopes/${first.id}`, { ...asBody(cur), recipients: cur.recipients.map((r: any, i: number) => (r.role === 'viewer' ? { ...r, email: `second${i}@example.com` } : r)) });
    assert.equal(swapped.status, 429);
    assert.equal((await eve.put(`/envelopes/${first.id}`, { ...asBody(cur), recipients: [...cur.recipients, { id: 'extra', role: 'viewer', name: 'Extra', email: 'extra@example.com' }] })).status, 429);
    assert.equal((await eve.post(`/envelopes/${first.id}/correct`, { recipient_id: cur.recipients.find((r: any) => r.role === 'viewer').id, email: 'quick@example.com' })).status, 429);
    // Passing your own request on to someone else is one more person in the sender's name.
    const handed = await visitor().post(`/sign/${tokenFor(first.id, 'eve@many.test')}/reassign`, { name: 'Vic Tim', email: 'handed@example.com' });
    assert.equal(handed.status, 403);
    assert.match(handed.data.error, /cannot be passed on to someone else right now/);
    assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email LIKE 'second%' OR to_email IN ('extra@example.com','quick@example.com','handed@example.com','sixth@example.com')").n, 0, 'nobody over the limit was emailed');
    // Writing again to someone already reached today is never refused.
    const again = await simple(eve, 'first0@example.com');
    assert.equal((await eve.post(`/envelopes/${again.id}/send`)).status, 200);
    // Voiding and deleting the envelope does not hand the day's allowance back.
    assert.equal((await eve.post(`/envelopes/${first.id}/void`, { reason: 'Sent by mistake' })).status, 200);
    assert.equal((await eve.call('DELETE', `/envelopes/${first.id}`)).status, 200);
    assert.equal((await eve.post(`/envelopes/${sixth.id}/send`)).status, 429);

    // After the first week the limit is higher, and still there.
    db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(8), acc);
    assert.equal((await eve.post(`/envelopes/${sixth.id}/send`)).status, 200);
    const three = await make(viewers('late', 3));
    const late = await eve.post(`/envelopes/${three.id}/send`);
    assert.equal(late.status, 429);
    assert.match(late.data.error, /^An account that has not paid can send to 8 people a day\. This account has sent to 6 in the last 24 hours and this would add 3\./);

    // Bulk is refused as a whole. A public form counts its visitors, and tells them nothing about the owner.
    const tpl = await simple(eve, '', { kind: 'template', subject: 'Batch', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
    const bulk = await eve.post('/bulk', { template_id: tpl.id, rows: [1, 2, 3].map((i) => ({ Member: { name: `M ${i}`, email: `bulk${i}@example.com` } })) });
    assert.equal(bulk.status, 429);
    assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', acc).n, 0);
    await eve.post('/powerforms', { template_id: tpl.id, name: 'Join us' });
    const start = async (i: number) => visitor().post(`/public/powerforms/${await slugOf(eve)}/start`, { name: `Walk In ${i}`, email: `walkin${i}@example.com` });
    assert.equal((await start(1)).status, 200);
    assert.equal((await start(2)).status, 200);
    const ninth = await start(3);
    assert.equal(ninth.status, 503);
    assert.equal(ninth.data.error, FORM_CLOSED);
    assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND status='draft' AND powerform_id IS NOT NULL", acc).n, 0);
    const told = mailTo('eve@many.test').filter((m) => m.subject.includes('could not take a signature'));
    assert.equal(told.length, 1);
    assert.match(told[0].html, /can send to 8 people a day/);

    // Paying for anything lifts it. A payment refunded in full does not.
    db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at) VALUES ('pay_eve', ?, 900, 'usd', ?)", acc, ago(0));
    assert.equal((await eve.post(`/envelopes/${three.id}/send`)).status, 200);
    db.run("UPDATE payments SET refunded_cents=amount_cents WHERE id='pay_eve'");
    const more = await make(viewers('more', 2));
    assert.equal((await eve.post(`/envelopes/${more.id}/send`)).status, 429);

    // Or a person lifts it: the tool the refusal promises. The request stands next to the account it is about.
    assert.equal((await eve.post('/public/support', { topic: 'sending', message: 'Please lift my daily limit, I run a school.' })).status, 200);
    await asOperator(async () => {
      const asked = (await op.get('/operator/queue')).data.support.find((s: any) => s.email === 'eve@many.test');
      assert.equal(asked.about_account, acc);
      assert.equal(asked.account_plan, 'seedling');
      assert.equal(asked.account_created_at.slice(0, 10), ago(8).slice(0, 10));
      assert.equal(asked.account_trusted_at, null);
      assert.deepEqual((await op.post(`/operator/accounts/${acc}`, { trusted: true })).data, { trusted: true });
      assert.ok((await op.get('/operator/queue')).data.support.find((s: any) => s.email === 'eve@many.test').account_trusted_at, 'the queue shows it is trusted now');
    });
    assert.ok(mailTo('eve@many.test').some((m) => m.subject === 'A person has cleared your Sign&Grow account'), 'and the account is told');
    assert.equal((await eve.post(`/envelopes/${more.id}/send`)).status, 200, 'a trusted account skips the daily limit');
    const notice = await simple(eve, 'client-eve@example.com', { subject: 'PayPal invoice #4471', message: LURE });
    assert.equal((await eve.post(`/envelopes/${notice.id}/send`)).status, 200, 'and the filter');
    await asOperator(() => op.post(`/operator/accounts/${acc}`, { trusted: false }));
    assert.equal((await eve.get('/me')).data.account.paused, null, 'trusting and untrusting never pauses or unpauses');
    const afterwards = await simple(eve, 'afterwards@example.com');
    assert.equal((await eve.post(`/envelopes/${afterwards.id}/send`)).status, 429, 'without the trust the limit is back');
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
    delete process.env.UNPAID_DAILY_RECIPIENTS;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('a paused account emails nobody new by any path, is told the real reason, and its recipients can still sign', async () => {
  const fay = await person('Fay Paused', 'fay@paused.test');
  const acc = await accountOf(fay);
  const out = await simple(fay, 'first-f@example.com', { subject: 'Before the pause', reminder_days: 1 });
  const old = await simple(fay, 'old-f@example.com', { subject: 'Ran out of time' });
  for (const e of [out, old]) assert.equal((await fay.post(`/envelopes/${e.id}/send`)).status, 200);
  db.run("UPDATE envelopes SET status='expired' WHERE id=?", old.id);
  const tpl = await simple(fay, '', { kind: 'template', subject: 'Form', recipients: [{ id: 'r', role: 'signer', role_name: 'Walker' }] });
  await fay.post('/powerforms', { template_id: tpl.id, name: 'Public form' });

  assert.equal((await asOperator(() => op.post(`/operator/accounts/${acc}`, { paused: true, reason: 'Card testing from this account.' }))).status, 200);
  assert.match(mailTo('fay@paused.test').at(-1)!.html, /Reason: Card testing from this account\./);
  const blocked = await simple(fay, 'new-f@example.com');
  const send = await fay.post(`/envelopes/${blocked.id}/send`);
  assert.equal(send.status, 403);
  assert.match(send.data.error, /Reason: Card testing from this account\./, 'the reason the pause was really given for');
  assert.doesNotMatch(send.data.error, /report from a recipient/);

  const cur = (await full(fay, out.id)).envelope;
  const body = asBody(cur);
  const rid = cur.recipients[0].id;
  assert.equal((await fay.put(`/envelopes/${out.id}`, { ...body, recipients: [{ ...body.recipients[0], email: 'victim-f@example.com' }] })).status, 403, 'a correction that changes an address');
  assert.equal((await fay.put(`/envelopes/${out.id}`, { ...body, recipients: [...body.recipients, { id: 'extra', role: 'viewer', name: 'Extra', email: 'victim-f2@example.com' }] })).status, 403, 'a correction that adds a person');
  assert.equal((await fay.post(`/envelopes/${out.id}/correct`, { recipient_id: rid, email: 'victim-f3@example.com' })).status, 403, 'the quick correct');
  const remind = await fay.post(`/envelopes/${out.id}/remind`);
  assert.equal(remind.status, 403, 'a reminder');
  assert.match(remind.data.error, /People who already have a document can still open, sign and download it/);
  assert.equal((await fay.post(`/envelopes/${out.id}/extend`, { days: 10 })).status, 403, 'more time');
  assert.equal((await fay.post(`/envelopes/${old.id}/extend`, { days: 10 })).status, 403, 'reopening');
  assert.equal((await fay.post('/bulk', { template_id: tpl.id, rows: [{ Walker: { name: 'B', email: 'bulk-f@example.com' } }] })).status, 403, 'a bulk send');
  // The timer does not remind for a paused sender either.
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(3), out.id);
  await cron.tick();
  for (const who of ['victim-f', 'victim-f2', 'victim-f3', 'new-f', 'bulk-f']) assert.equal(mailTo(`${who}@example.com`).length, 0, who);
  assert.equal(mailTo('first-f@example.com').length, 1, 'only the first request ever went out');
  assert.equal(mailTo('old-f@example.com').length, 1);

  // A visitor to the account's public form is not told about the review, and nothing of theirs is kept.
  assert.equal((await visitor().get(`/public/powerforms/${await slugOf(fay)}`)).data.closed, true, 'the form says so before anyone types into it');
  const walkIn = await visitor().post(`/public/powerforms/${await slugOf(fay)}/start`, { name: 'Walk In', email: 'walkin-f@example.com' });
  assert.equal(walkIn.status, 503);
  assert.equal(walkIn.data.error, FORM_CLOSED);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL AND account_id=?', acc).n, 0);
  // The same for a form whose owner never confirmed their address.
  const una = visitor();
  assert.equal((await una.post('/auth/signup', { name: 'Una Confirmed', email: 'una@paused.test', password: 'correct horse battery' })).status, 200);
  const unaTpl = await simple(una, '', { kind: 'template', subject: 'Form', recipients: [{ id: 'r', role: 'signer', role_name: 'Walker' }] });
  await una.post('/powerforms', { template_id: unaTpl.id, name: 'Too early' });
  const early = await visitor().post(`/public/powerforms/${await slugOf(una)}/start`, { name: 'Walk In', email: 'walkin-u@example.com' });
  assert.equal(early.status, 503);
  assert.equal(early.data.error, FORM_CLOSED);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL AND account_id=?', await accountOf(una)).n, 0);

  // What still works: a typo in a name, signing what is out, downloading it.
  assert.equal((await fay.post(`/envelopes/${out.id}/correct`, { recipient_id: rid, name: 'Sam S. Signer' })).status, 200);
  assert.equal((await signAll(out.id, 'first-f@example.com')).status, 200, 'people who already have a document can still sign it');
  assert.equal((await fay.get(`/envelopes/${out.id}/download`)).status, 200);
  assert.equal((await asOperator(() => op.post(`/operator/accounts/${acc}`, { paused: false }))).status, 200);
  assert.equal((await fay.post(`/envelopes/${blocked.id}/send`)).status, 200);
});

test('reports an operator confirms as abuse still count towards the automatic pause', async () => {
  const trudy = await person('Trudy', 'trudy@reports.test');
  const acc = await accountOf(trudy);
  const reported = async (victim: string) => {
    const x = await simple(trudy, victim, { subject: 'Hello' });
    assert.equal((await trudy.post(`/envelopes/${x.id}/send`)).status, 200);
    assert.equal((await visitor().post(`/sign/${tokenFor(x.id, victim)}/report`, { reason: 'phishing' })).status, 200);
  };
  await reported('t1@example.com');
  await reported('t2@example.com');
  await asOperator(async () => {
    const mine = (await op.get('/operator/queue')).data.reports.filter((r: any) => r.sender_email === 'trudy@reports.test');
    assert.equal(mine.length, 2);
    assert.equal(mine[0].about_account, acc);
    assert.equal(mine[0].account_plan, 'seedling', 'the plan stands next to the report');
    assert.ok(mine[0].account_created_at, 'and when the account was created');
    assert.equal(mine[0].account_trusted_at, null, 'and whether it is trusted');
    for (const r of mine) assert.equal((await op.post(`/operator/reports/${r.id}`, { status: 'upheld' })).status, 200);
  });
  await reported('t3@example.com');
  assert.ok((await trudy.get('/me')).data.account.paused, 'two confirmed reports and a new one pause the account');
  // Lifting the pause means a person has looked at those. One new report does not pause it again at once.
  await asOperator(() => op.post(`/operator/accounts/${acc}`, { paused: false }));
  await reported('t4@example.com');
  assert.equal((await trudy.get('/me')).data.account.paused, null);
});

test('a support message is shown only to the person who wrote it, and the form mails a stranger\'s words to nobody', async () => {
  const typed = 'My card ending 4242 was charged twice on 3 November.';
  const sent = await visitor().post('/public/support', { email: 'victim@support.test', name: 'Vic', topic: 'billing', message: typed });
  assert.equal(sent.status, 200);
  const ack = mailTo('victim@support.test').at(-1)!;
  assert.ok(ack.subject.includes(sent.data.reference), 'the acknowledgement gives the reference');
  assert.match(ack.html, /A person will reply to you/);
  assert.ok(!ack.html.includes('4242'), 'and does not repeat what was typed to an address nobody confirmed');

  // Someone registers that address without confirming it.
  const squatter = visitor();
  assert.equal((await squatter.post('/auth/signup', { name: 'Not Vic', email: 'victim@support.test', password: 'correct horse battery' })).status, 200);
  assert.deepEqual((await squatter.get('/support/mine')).data.requests, [], 'an unconfirmed address shows nothing');
  assert.equal((await squatter.post('/public/support', { topic: 'other', message: 'This one I wrote myself while signed in.' })).status, 200);
  assert.deepEqual((await squatter.get('/support/mine')).data.requests.map((r: any) => r.message), ['This one I wrote myself while signed in.'], 'except what they filed themselves');
  // Whoever really owns the mailbox confirms it, and then sees what was sent from it.
  assert.equal((await new Client().post('/auth/verify', { token: db.get("SELECT verify_token t FROM users WHERE email='victim@support.test'").t })).status, 200);
  assert.equal((await squatter.get('/support/mine')).data.requests.length, 2);

  // Signed in and writing from your own confirmed address: you get your copy.
  const jo = await person('Jo Known', 'jo@support.test');
  await jo.post('/public/support', { topic: 'sending', message: 'Please copy this back to me, thanks.' });
  assert.match(mailTo('jo@support.test').at(-1)!.html, /Please copy this back to me/);
  // Signed in but typing another address: that address gets the reference and nothing else.
  await jo.post('/public/support', { email: 'target@support.test', topic: 'other', message: 'Your refund is waiting. Call +1 888 555 0142 today.' });
  assert.ok(!mailTo('target@support.test').at(-1)!.html.includes('555'));
});

test('access codes: at least 4 characters, only wrong tries count, and ten of them freeze the code until the sender sets a new one', async () => {
  const cody = await person('Cody Sender', 'cody@codes.test');
  const coded = (email: string, code: string) => simple(cody, email, { recipients: [{ id: 'r', role: 'signer', name: 'Coded Signer', email, access_code: code }] });
  const short = await coded('short@example.com', '4');
  const refused = await cody.post(`/envelopes/${short.id}/send`);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /The access code for Coded Signer is too short\. Use at least 4 characters/);
  const e = await coded('code@example.com', '4242');
  assert.equal((await cody.post(`/envelopes/${e.id}/send`)).status, 200);
  const cur = (await full(cody, e.id)).envelope;
  const rid = cur.recipients[0].id;
  const correct = (patch: any) => cody.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, ...patch });
  assert.equal((await correct({ access_code: '12' })).status, 400, 'the quick correct');
  assert.equal((await cody.put(`/envelopes/${e.id}`, { ...asBody(cur), recipients: [{ ...cur.recipients[0], access_code: '7' }] })).status, 400, 'a correction in the editor or through the API');
  assert.equal(db.get('SELECT access_code c FROM recipients WHERE id=?', rid).c, '4242');

  // A stranger with the link gets it wrong five times and has to wait. The signer, on another device, is not held up.
  const tok = tokenFor(e.id, 'code@example.com');
  const unlock = (c: Client, code: string) => c.post(`/sign/${tok}/unlock`, { code });
  const stranger = visitor();
  for (let i = 0; i < 5; i++) assert.equal((await unlock(stranger, `x${i}`)).status, 401);
  const held = await unlock(stranger, '4242');
  assert.equal(held.status, 429);
  assert.match(held.data.error, /Wait 15 minutes and try again, or ask Cody Sender for the code/);
  const signer = visitor();
  assert.equal((await unlock(signer, '4242')).status, 200, 'the right code from another device opens it');
  assert.equal((await signer.get(`/sign/${tok}`)).data.locked, false);

  // Ten wrong tries in total freeze the code for everyone who is not in yet, and the sender is told.
  const second = visitor();
  for (let i = 0; i < 3; i++) assert.equal((await unlock(second, `y${i}`)).status, 401);
  assert.match((await unlock(second, 'y3')).data.error, /After 1 more wrong try the code is frozen until Cody Sender sets a new one/);
  const tenth = await unlock(second, 'y4');
  assert.equal(tenth.status, 423);
  assert.match(tenth.data.error, /entered wrongly 10 times, so it is frozen.*Cody Sender has been told and can set a new code/);
  const third = visitor();
  assert.equal((await unlock(third, '4242')).status, 423, 'frozen also for the right code, or it could still be guessed');
  assert.equal((await third.get(`/sign/${tok}`)).data.code_frozen, true, 'the signing screen is told, so it can say so');
  assert.equal((await signer.get(`/sign/${tok}`)).data.locked, false, 'someone who was already in stays in');
  const told = mailTo('cody@codes.test').filter((m) => m.subject.startsWith('Access code frozen:'));
  assert.equal(told.length, 1);
  assert.match(told[0].html, /choose Correct next to their name and type a new access code of at least 4 characters/);
  // "Ask the sender" works from the locked screen, without the code.
  assert.equal((await third.post(`/sign/${tok}/ask-code`)).status, 200);
  assert.ok(mailTo('cody@codes.test').some((m) => m.subject.startsWith('Access code needed:')));

  // The same code again does not open it. A new one does, and starts with a clean count.
  assert.equal((await correct({ access_code: '4242' })).status, 200);
  assert.equal((await unlock(third, '4242')).status, 423);
  assert.equal((await correct({ access_code: 'new-code-77' })).status, 200);
  assert.equal((await third.get(`/sign/${tok}`)).data.code_frozen, false);
  assert.equal((await unlock(third, 'new-code-77')).status, 200);
  assert.equal(db.get('SELECT code_fails n FROM recipients WHERE id=?', rid).n, 0);
});

test('one person opening their link very often never blocks a colleague at the same address', async () => {
  const jo = await person('Office Sender', 'office@codes.test');
  const mine = await simple(jo, 'many@example.com');
  const theirs = await simple(jo, 'colleague@example.com');
  for (const e of [mine, theirs]) assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  const office = ip();
  const one = from(office);
  let last = 0;
  for (let i = 0; i < 601; i++) last = (await one.get(`/sign/${tokenFor(mine.id, 'many@example.com')}`)).status;
  assert.equal(last, 429, 'the link itself is limited');
  assert.equal((await from(office).get(`/sign/${tokenFor(theirs.id, 'colleague@example.com')}`)).status, 200, 'another link from the same address is not');
});

test('a public form never hands a visitor someone else\'s unfinished document', async () => {
  const fern = await person('Fern Forms', 'fern@forms.test');
  const file = await upload(fern, 1);
  const tpl = (await fern.post('/envelopes', { kind: 'template', subject: 'Patient intake', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Patient' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 't', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Date of birth and medication', page: 0, x: 0.1, y: 0.3, w: 0.5, h: 0.03 }] })).data.envelope;
  await fern.post('/powerforms', { template_id: tpl.id, name: 'Patient intake form' });
  const slug = await slugOf(fern);
  const start = (c: Client, name: string, email: string) => c.post(`/public/powerforms/${slug}/start`, { name, email });
  const answers = async (c: Client, url: string) => (await c.get(`/sign/${url.split('/sign/')[1]}`)).data;

  // Vera starts, types something private and stops for now.
  const vera = visitor();
  const hers = await start(vera, 'Vera Victim', 'vera@example.com');
  const tok = hers.data.url.split('/sign/')[1];
  await vera.post(`/sign/${tok}/consent`);
  const dob = (await answers(vera, hers.data.url)).fields.find((f: any) => f.type === 'text').id;
  assert.equal((await vera.post(`/sign/${tok}/save`, { values: { [dob]: '1980-02-03, insulin' } })).status, 200);

  // Someone else, somewhere else, types Vera's address into the same form.
  const stranger = visitor();
  const theirs = await start(stranger, 'Not Vera', 'VERA@example.com');
  assert.equal(theirs.status, 200);
  assert.notEqual(theirs.data.url, hers.data.url, 'never Vera\'s link');
  assert.equal(theirs.data.resumed, undefined);
  const seen = await answers(stranger, theirs.data.url);
  assert.equal(seen.recipient.name, 'Not Vera');
  assert.equal(seen.recipient.consented, false);
  assert.ok(seen.fields.every((f: any) => !f.value), 'a fresh, empty document');

  // Vera, in the browser she started in, gets her own start back with what she typed.
  const back = await start(vera, 'Vera Victim', 'vera@example.com');
  assert.equal(back.data.url, hers.data.url);
  assert.equal(back.data.resumed, true);
  assert.equal((await answers(vera, back.data.url)).fields.find((f: any) => f.id === dob).value, '1980-02-03, insulin');
  // A second person at the same address, even in the same browser, gets a document of their own.
  const blair = await start(vera, 'Blair Victim', 'vera@example.com');
  assert.notEqual(blair.data.url, hers.data.url);
  assert.equal((await answers(vera, blair.data.url)).recipient.name, 'Blair Victim');
});

test('unfinished starts on a public form are few per address, hold none of the owner\'s signatures, and are cleared after a quiet day', async () => {
  const quin = await person('Quin Forms', 'quin@forms.test');
  const tpl = await simple(quin, '', { kind: 'template', subject: 'Waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }] });
  await quin.post('/powerforms', { template_id: tpl.id, name: 'Sign the waiver' });
  const slug = await slugOf(quin);
  const start = (c: Client, who: string) => c.post(`/public/powerforms/${slug}/start`, { name: `Walk In ${who}`, email: `${who}@waiver.test` });

  // One address starts three times and finishes none.
  const here = ip();
  const urls: string[] = [];
  for (const who of ['a', 'b', 'c']) urls.push((await start(from(here), who)).data.url);
  const fourth = await start(from(here), 'd');
  assert.equal(fourth.status, 429);
  assert.match(fourth.data.error, /started 3 times from your internet connection and not finished yet\. Finish one of those first/);
  assert.equal((await start(visitor(), 'elsewhere')).status, 200, 'another address is not affected');
  assert.equal((await signAll(envelopeOf(urls[0]), 'a@waiver.test')).status, 200);
  assert.equal((await start(from(here), 'd')).status, 200, 'finishing one makes room');

  // With signatures counted: a start holds none of the owner's signatures. Anyone can start a form with a made-up
  // address, and that must not be a way to lock the owner out of sending. One is used when a visitor really signs.
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  try {
    const rae = await person('Rae Forms', 'rae@forms.test');
    const waiver = await simple(rae, '', { kind: 'template', subject: 'Waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }] });
    await rae.post('/powerforms', { template_id: waiver.id, name: 'Sign the waiver' });
    const form = await slugOf(rae);
    const begin = (c: Client, who: string) => c.post(`/public/powerforms/${form}/start`, { name: `Walk In ${who}`, email: `${who}@held.test` });
    const one = visitor();
    const started = [await begin(one, 'one'), await begin(visitor(), 'two'), await begin(visitor(), 'three')];
    for (const s of started) assert.equal(s.status, 200);
    assert.equal((await rae.get('/billing')).data.signatures.available, 3, 'three made-up starts hold nothing of the owner\'s');
    // Nor do they stand in anyone's way: a fourth person can start, however many walked away before them. Whether
    // a signature is there is decided when someone actually finishes (see tests/billing4.test.ts).
    const fourth = await begin(visitor(), 'four');
    assert.equal(fourth.status, 200);
    db.run("UPDATE envelopes SET status='voided' WHERE id=?", envelopeOf(fourth.data.url));
    // Nobody touches two of them for more than a day. The third was started just now.
    for (const s of started.slice(0, 2)) {
      db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(1.1), envelopeOf(s.data.url));
      db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(1.1), envelopeOf(s.data.url));
    }
    const mails = mailTo('rae@forms.test').length;
    await cron.tick();
    assert.deepEqual(started.map((s) => db.get('SELECT status FROM envelopes WHERE id=?', envelopeOf(s.data.url)).status), ['expired', 'expired', 'sent']);
    assert.equal((await rae.get('/billing')).data.signatures.available, 3, 'and the balance was never touched');
    assert.equal(mailTo('rae@forms.test').length, mails, 'and the owner is not emailed about every visitor who walked away');
    // The visitor can simply start again, also from the browser that still remembers the old start.
    const again = await begin(one, 'one');
    assert.equal(again.status, 200);
    assert.notEqual(again.data.url, started[0].data.url);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('an email can be reported with its security code, without opening the signing link', async () => {
  const mal = await person('Mal Sender', 'mal@report.test');
  const acc = await accountOf(mal);
  const codeIn = (mail: any) => /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(mail.html)![1];
  // Also the holder of an email whose link was replaced since: the sender moved the request to another address.
  const moved = await simple(mal, 'old@victims.test', { subject: 'Hello' });
  assert.equal((await mal.post(`/envelopes/${moved.id}/send`)).status, 200);
  const oldCode = codeIn(mailTo('old@victims.test').at(-1)!);
  assert.equal((await mal.post(`/envelopes/${moved.id}/correct`, { recipient_id: db.get('SELECT id FROM recipients WHERE envelope_id=?', moved.id).id, email: 'new@victims.test' })).status, 200);
  assert.equal((await visitor().post('/public/check/report', { code: oldCode, reason: 'spam' })).status, 200);
  assert.equal(db.get('SELECT reporter FROM abuse_reports WHERE envelope_id=?', moved.id).reporter, 'old@victims.test', 'reported under the address that email went to');
  for (const v of ['r1', 'r2']) {
    const x = await simple(mal, `${v}@victims.test`, { subject: 'Hello' });
    assert.equal((await mal.post(`/envelopes/${x.id}/send`)).status, 200);
    const mail = mailTo(`${v}@victims.test`).at(-1)!;
    const code = codeIn(mail);
    assert.match(mail.html, /Report this email/, 'the signing email itself offers it');
    assert.ok(mail.html.includes(`http://test.local/check?code=${code}&amp;report=1`), 'with a link to the check page, code filled in');
    const reported = await visitor().post('/public/check/report', { code: code.toLowerCase(), reason: 'phishing', detail: 'I never ordered this' });
    assert.equal(reported.status, 200);
    assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=?', x.id).status, 'sent', 'the document was never opened');
    assert.equal(db.get('SELECT reporter FROM abuse_reports WHERE envelope_id=?', x.id).reporter, `${v}@victims.test`);
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE account_id=?', acc).n, 3);
  assert.ok((await mal.get('/me')).data.account.paused, 'it counts like a report made on the signing screen');
  const unknown = await visitor().post('/public/check/report', { code: 'AAAA-BBBB-CCCC', reason: 'phishing' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.error, /contact form/);
});
