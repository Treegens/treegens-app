// Keeping scammers and strangers out: the filter for fake payment notices, the daily limit, the pause, reports,
// who may read a support message, access codes, public forms, and reporting an email with its security code.
// Every test here pins down a way round one of those rules that an audit found. Each failed before its fix.
// Days in sentences read 20 Nov 2026 since 21 November 2026 (simplify-public).
import { dayText } from '../src/lib/dates.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, upload, simple, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';

let db: Server['db'];
let cron: Server['cron'];
let op: Client; // one of the people who run the service
before(async () => {
  ({ db, cron } = await boot());
  op = await person('Olive Operator', 'olive@growsigning.test');
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
  process.env.OPERATOR_EMAILS = 'olive@growsigning.test';
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
  // A brand's name is refused where it is set, and where it got in some other way it is refused again at the send.
  const renamed = await bea.call('PATCH', '/account', { name: 'Microsoft Support' });
  assert.equal(renamed.status, 422);
  assert.match(renamed.data.error, /reads like Microsoft.*Nothing was changed\./);
  db.run("UPDATE accounts SET name='Microsoft Support' WHERE id=?", await accountOf(bea));
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
  // The reason for voiding is emailed to everyone on the envelope, so it is read too. Voiding itself is never refused.
  const before = mailTo('first-d@example.com').length;
  assert.equal((await dana.post(`/envelopes/${d.id}/void`, { reason: `PayPal invoice cancelled. ${LURE}` })).status, 422);
  assert.equal(mailTo('first-d@example.com').length, before);
  // Or the sender takes a brand's name afterwards and nudges the people who already have it. The name is refused
  // where it is set. One that got in before the rule (set here in the database) stops every email in its name.
  assert.equal((await dana.call('PATCH', '/me', { name: 'Venmo Payments' })).status, 422);
  assert.equal((await dana.get('/me')).data.user.name, 'Dana Drift');
  db.run("UPDATE users SET name='Venmo Payments' WHERE email='d@scam.test'");
  assert.equal((await dana.post(`/envelopes/${d.id}/remind`)).status, 422);
  assert.equal((await dana.post(`/envelopes/${d.id}/correct`, { recipient_id: body.recipients[0].id, email: 'victim-d2@example.com' })).status, 422);
  assert.equal(mailTo('first-d@example.com').length, before);
  assert.equal(mailTo('victim-d2@example.com').length, 0);
  // It can still be voided, and the notice then carries none of the sender's words and neither of their names.
  assert.equal((await dana.post(`/envelopes/${d.id}/void`, { reason: 'Sent by mistake' })).status, 200);
  const voided = db.get("SELECT subject, html, payload FROM emails WHERE to_email='first-d@example.com' ORDER BY id DESC LIMIT 1");
  assert.equal(voided.subject, 'Voided: a document you were sent');
  assert.ok(!/Venmo|Sent by mistake|Hello/.test(voided.html + voided.payload));

  // In bulk and through a public form.
  const tpl = await simple(carl, '', { kind: 'template', subject: 'PayPal invoice', message: `PayPal: ${LURE}`, recipients: [{ id: 'r', role: 'signer', role_name: 'Payer' }] });
  const bulk = await carl.post('/bulk', { template_id: tpl.id, rows: [{ Payer: { name: 'Vic', email: 'victim-e@example.com' } }] });
  assert.equal(bulk.status, 422);
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', await accountOf(carl)).n, 0, 'refused as a whole, before anything was written');
  // A public form of it is refused where it is made, with the reason, so the owner does not learn it from a visitor.
  const made = await carl.post('/powerforms', { template_id: tpl.id, name: 'Pay here' });
  assert.equal(made.status, 422);
  assert.match(made.data.error, /What set this off: the name PayPal.* The form was not made\.$/);
  assert.equal((await carl.get('/powerforms')).data.powerforms.length, 0);
  // One made before that rule (written to the database here) still takes nobody.
  db.run("INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at) VALUES ('pwf_carl', ?, ?, 'carl-pay-here', 'Pay here', ?)", await accountOf(carl), tpl.id, ago(30));
  const walkIn = await visitor().post(`/public/powerforms/${await slugOf(carl)}/start`, { name: 'Walk In', email: 'victim-f@example.com' });
  assert.equal(walkIn.status, 503);
  assert.equal(walkIn.data.error, FORM_CLOSED, 'the visitor is not told the owner\'s business');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL AND account_id=?', await accountOf(carl)).n, 0, 'and nothing of theirs is kept');
  assert.ok(mailTo('c@scam.test').some((m) => m.subject.includes('could not take a signature') && /payment notice/.test(m.html)), 'the owner is told the real reason');

  // Age does not lift the filter. A payment that was kept, and has stood long enough, does (see the test on paying).
  const hal = await person('Hal Old', 'h@scam.test');
  const hacc = await accountOf(hal);
  db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(400), hacc);
  const h = await simple(hal, 'victim-h@example.com', { subject: 'PayPal invoice #4471', message: LURE });
  assert.equal((await hal.post(`/envelopes/${h.id}/send`)).status, 422, 'a free account is checked however old it is');
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, applied_at, refunded_cents) VALUES ('pay_hal', ?, 900, 'usd', ?, ?, 900)", hacc, ago(20), ago(20));
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

    // Bulk is refused as a whole.
    const tpl = await simple(eve, '', { kind: 'template', subject: 'Batch', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
    const bulk = await eve.post('/bulk', { template_id: tpl.id, rows: [1, 2, 3].map((i) => ({ Member: { name: `M ${i}`, email: `bulk${i}@example.com` } })) });
    assert.equal(bulk.status, 429);
    assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', acc).n, 0);
    // A public form counts the people who start it for the form alone. A stranger with made-up addresses can fill
    // the form's day, and never uses up what the owner may send to the people the owner chose.
    await eve.post('/powerforms', { template_id: tpl.id, name: 'Join us' });
    const start = async (i: number) => visitor().post(`/public/powerforms/${await slugOf(eve)}/start`, { name: `Walk In ${i}`, email: `walkin${i}@example.com` });
    for (let i = 1; i <= 8; i++) assert.equal((await start(i)).status, 200, `start ${i}`);
    const ninth = await start(9);
    assert.equal(ninth.status, 503);
    assert.equal(ninth.data.error, FORM_CLOSED, 'the visitor is told nothing about the owner');
    assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND status='draft' AND powerform_id IS NOT NULL", acc).n, 0);
    const told = mailTo('eve@many.test').filter((m) => m.subject.includes('could not take a signature'));
    assert.equal(told.length, 1);
    assert.match(told[0].html, /This public form has been started by 8 people in the last 24 hours\. An account that has not paid can take 8 new people a day on each public form\. They are counted for the form alone, so this does not use up what you can send yourself\./);
    const two = await make(viewers('own', 2));
    assert.equal((await eve.post(`/envelopes/${two.id}/send`)).status, 200, 'eight strangers on the form took nothing from the owner: 6 sent, room for 2');

    // A payment lifts the limit once it has stood for 14 days (see the test on paying). One refunded in full never does.
    db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, applied_at) VALUES ('pay_eve', ?, 900, 'usd', ?, ?)", acc, ago(15), ago(15));
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
    assert.ok(mailTo('eve@many.test').some((m) => m.subject === 'A person has cleared your GrowSigning account'), 'and the account is told');
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
  assert.equal((await fay.post(`/envelopes/${old.id}/extend`, { days: 10 })).status, 403, 'reopening');
  // More time for an envelope that is still open emails nobody, so a review that takes days costs no signer their deadline.
  assert.equal((await fay.post(`/envelopes/${out.id}/extend`, { days: 10 })).status, 200, 'more time');
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
  // The acknowledgement promises a person only where someone reads requests (repair-open-platform).
  assert.match(ack.html, process.env.SUPPORT_EMAIL || process.env.OPERATOR_EMAILS ? /A person will reply to you/ : /We got your message/);
  assert.ok(!ack.html.includes('4242'), 'and does not repeat what was typed to an address nobody confirmed');

  // Someone registers that address without confirming it.
  const squatter = visitor();
  assert.equal((await squatter.post('/auth/signup', { name: 'Not Vic', email: 'victim@support.test', password: 'correct horse battery' })).status, 200);
  assert.deepEqual((await squatter.get('/support/mine')).data.requests, [], 'an unconfirmed address shows nothing');
  assert.equal((await squatter.post('/public/support', { topic: 'other', message: 'This one I wrote myself while signed in.' })).status, 200);
  assert.deepEqual((await squatter.get('/support/mine')).data.requests.map((r: any) => r.message), ['This one I wrote myself while signed in.'], 'except what they filed themselves');
  // The owner of the mailbox gets the confirmation email and clicks its link out of habit. That confirms nothing:
  // their browser is not signed in to the login, and they do not know the password the squatter chose.
  const link = { token: db.get("SELECT verify_token t FROM users WHERE email='victim@support.test'").t };
  const clicked = await visitor().post('/auth/verify', link);
  assert.equal(clicked.status, 401);
  assert.equal(clicked.data.code, 'password_needed');
  assert.match(clicked.data.error, /type the password you chose when you signed up\. If you did not sign up for GrowSigning, close this page: nothing was confirmed\./);
  assert.equal((await visitor().post('/auth/verify', { ...link, password: 'a guess at it' })).status, 401);
  assert.equal((await op.post('/auth/verify', link)).status, 401, 'a browser that is signed in to some other login is not signed in to this one');
  assert.equal(db.get("SELECT email_verified v FROM users WHERE email='victim@support.test'").v, 0);
  assert.equal((await squatter.get('/support/mine')).data.requests.length, 1, 'so the squatter still sees only their own');
  // Someone who made the login and reads the mailbox is the person the address belongs to: the link in their own
  // browser, or the link with the password anywhere else. Then they see what was sent from the address.
  assert.equal((await visitor().post('/auth/verify', { ...link, password: 'correct horse battery' })).status, 200);
  assert.equal((await squatter.get('/support/mine')).data.requests.length, 2);
  assert.match(mailTo('victim@support.test').find((m) => m.subject === 'Confirm your email for GrowSigning')!.html, /Did not sign up\? Ignore this email\. Without it, that login cannot send or see what was sent to you\./);
  assert.ok(!mailTo('victim@support.test').find((m) => m.subject === 'Confirm your email for GrowSigning')!.html.includes('Not Vic'), 'and the email does not repeat a name a stranger typed');

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
  assert.match(held.data.error, /^That makes 5 wrong codes from your internet connection in a quarter of an hour\. Wait 15 minutes and try again, or ask Cody Sender for the code/, 'said as it is counted: per connection, not "in a row" and not per device');
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

  // The same code again does not open it, and saving it is not answered "ok". A new one does, and starts with a clean count.
  const same = await correct({ access_code: '4242' });
  assert.equal(same.status, 400);
  assert.match(same.data.error, /The access code for Coded Signer is frozen after 10 wrong tries, and saving the same code again does not open it\. Type a different code of at least 4 characters/);
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
  // With no mail server nothing was emailed, so the message does not point at an email.
  assert.match(fourth.data.error, /Finish one of those first: use the page that opened when you started it\./);
  process.env.SMTP_URL = 'smtp://localhost:1';
  const mailed = await start(from(here), 'd');
  delete process.env.SMTP_URL;
  assert.match(mailed.data.error, /Finish one of those first: the link is in the email we sent each time\./);
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

// ---- What a second look found. Each test below failed before its fix. -------------------------------------------

const codeOf = (mail: any) => /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(mail.html)![1];
const sig = (recipient: string, x = 0.1) => ({ id: `f-${recipient}`, document_id: 'd', recipient_id: recipient, type: 'signature', page: 0, x, y: 0.5, w: 0.3, h: 0.06 });
// A simple envelope, made and sent: the envelope and the answer to the send.
const sent = async (c: Client, to: string, over: any = {}) => {
  const e = await simple(c, to, over);
  return { e, r: await c.post(`/envelopes/${e.id}/send`) };
};

test('the filter reads glued words, any word about money, a phone number however it is written and look-alike letters, and leaves honest senders alone', async () => {
  const ned = await person('Ned Tries', 'ned@spell.test');
  const tried = async (subject: string, message = LURE) => (await sent(ned, 'victim-spell@example.com', { subject, message })).r;
  // A brand glued to another word, in front of it or behind it.
  for (const subject of ['PayPalInvoice #4471', 'MyPayPal invoice #4471', 'Microsoft365 notice']) assert.equal((await tried(subject)).status, 422, subject);
  // Any word about money, in any form or look-alike spelling, or no such word at all and only an amount.
  for (const [subject, message] of [['Your PayPal invoices', 'Two invoices are overdue. Call +1 (888) 555-0142.'], ['PayPal notice', 'You were billed for Bitcoin. Not you? Call +1 (888) 555-0142.'],
    ['PayPal receipt', 'Thank you for your purchase. Not you? Call +1 (888) 555-0142.'], ['PayPal inv0ice #4471', 'Call +1 (888) 555-0142.'], ['PayPal', 'A charge will appear on your statement. Call +1 (888) 555-0142 to stop it.'], ['PayPal', '$499.00. Call +1 (888) 555-0142.']])
    assert.equal((await tried(subject, message)).status, 422, `${subject} / ${message}`);
  // Naming a program is not posing as its maker, but the program's own billing is the maker's notice again.
  assert.equal((await tried('Microsoft Teams subscription', 'Your plan was charged $399. Call +1 (888) 555-0142 now.')).status, 422, 'Microsoft Teams subscription');
  // A phone number as a word processor or a scammer writes it: an en dash, another hyphen, slashes, bullets, a
  // letter O for a zero, seven digits, underscores.
  for (const phone of ['888–555–0142', '888‐555‐0142', '888/555/0142', '888•555•0142', '888 555 O142', '555-0142', '888_555_0142'])
    assert.equal((await tried('PayPal invoice #4471', `Your payment was charged. To cancel call ${phone} now.`)).status, 422, phone);
  // Letters that look like ours: a Latin alpha, a palochka, a dotless i, "rn" for an m, an Armenian o, small
  // capitals, and a letter we have no look-alike for in the middle of an otherwise plain word.
  for (const brand of ['PɑyPɑl', 'PayPaӏ', 'Mıcrosoft', 'Rnicrosoft', 'Micrօsoft', 'ᴘᴀʏᴘᴀʟ', 'Micrꙩsoft']) assert.equal((await tried(`${brand} invoice #4471`)).status, 422, brand);
  // And in the names an email goes out under.
  for (const name of ['PayPalBilling', 'PayPalSupport', 'McAfeeSupport']) {
    const c = await person(name, `${name.toLowerCase()}@spell.test`);
    const no = (await sent(c, 'victim-spell2@example.com')).r;
    assert.equal(no.status, 422, name);
    assert.match(no.data.error, /reads like (PayPal|McAfee)/);
  }
  assert.equal(mailTo('victim-spell@example.com').length + mailTo('victim-spell2@example.com').length, 0);
  // The refusal says which words set it off, so an honest sender can see what to change, and when the check ends.
  const why = (await tried('PayPal invoice #4471')).data.error;
  assert.match(why, /What set this off: the name PayPal, words about money \("invoice"\) and what looks like a phone number \(\+1 \(888\) 555-0142\)/);
  assert.match(why, /These checks stop applying once the account has a payment that is at least 14 days old and was not refunded or disputed, or once a person on our team has cleared it\./);

  // Honest senders: a family name, digits that happen to be look-alikes of letters, a street, a program, a way to
  // pay, a date. None of them is posing as anyone.
  const honest: [string, string, string][] = [['Sarah McAfee', 'Lease agreement', 'Please sign the lease. Payment by bank transfer. Call me on 555 123 4567.'], ['Honest Plumber', 'Invoice 1042', 'Invoice for the boiler repair. Questions? Call 231-135-5550.'],
    ['Honest Quoter', 'Quote', 'Payment due on completion: $2,311.30. Our office: 020 7946 0991.'], ['Honest Landlord', 'Lease renewal', 'Renewal for the flat at 12 Apple Street. Call me on 555 123 4567 with questions.'],
    ['Honest Agent', 'Subscription agreement', 'The Microsoft Word original is attached. Any questions, ring 555 123 4567.'], ['Honest Tutor', 'Invoice 7', 'Join the Microsoft Teams call or ring 555 123 4567. Payment in 30 days.'], ['Honest Trader', 'Invoice 12', 'You can pay by Zelle to 555 123 4567, or by cheque.'], ['Honest Dater', 'PayPal agreement', 'Payment is due on 12/11/2026.']];
  for (const [name, subject, message] of honest) {
    const c = await person(name, `${name.toLowerCase().replace(/\W/g, '')}@honest.test`);
    const { r } = await sent(c, 'client-honest@example.com', { subject, message });
    assert.equal(r.status, 200, `${name}, ${subject}: ${r.data?.error}`);
  }
});

test('everything an email prints is read wherever an email is written, also when it changes after the send', async () => {
  // Words on the page. A correction that adds a note is told to the people who have the document in its own words,
  // and the label of a field is quoted there too.
  const una = await person('Una Notes', 'una@paths.test');
  const { e } = await sent(una, 'victim-note@example.com', { subject: 'Account statement' });
  const cur = (await full(una, e.id)).envelope;
  const note = { id: 'note1', document_id: cur.documents[0].id, type: 'note', page: 0, x: 0.1, y: 0.1, w: 0.6, h: 0.1, value: `PayPal: ${LURE}` };
  const label = { id: 'lab1', document_id: cur.documents[0].id, recipient_id: cur.recipients[0].id, type: 'text', label: 'PayPal refund $499 call 888 555 0142', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03 };
  for (const field of [note, label]) assert.equal((await una.put(`/envelopes/${e.id}`, { ...asBody(cur), fields: [...cur.fields, field] })).status, 422, field.id);
  assert.equal(mailTo('victim-note@example.com').length, 1, 'only the first request ever arrived');
  const inDraft = await sent(una, 'victim-note2@example.com', { subject: 'Statement', fields: [sig('r'), { id: 'n', document_id: 'd', type: 'note', page: 0, x: 0.1, y: 0.1, w: 0.6, h: 0.1, value: `PayPal: ${LURE}` }] });
  assert.equal(inDraft.r.status, 422, 'and at the first send');

  // Two people at one address: the heading of each email prints the name it is for.
  const file = await upload(una, 1);
  const names = await una.post('/envelopes', { subject: 'Notice', send: true, documents: [{ id: 'd', file_id: file.id }], fields: [],
    recipients: [{ id: 'a', role: 'viewer', name: 'PayPal: payment of $499 charged, call +1 (888) 555-0142', email: 'victim-names@example.com' }, { id: 'b', role: 'viewer', name: 'Other', email: 'victim-names@example.com' }] });
  assert.equal(names.status, 422);
  assert.equal(mailTo('victim-names@example.com').length, 0);
  // A supplier who writes to a company is not posing as it: a recipient's name that no email prints for anyone else is not read.
  const supplier = await sent(una, 'ap@amazon.example', { subject: 'Invoice 7', message: 'Payment in 30 days. Questions? Call 555 123 4567.', recipients: [{ id: 'r', role: 'signer', name: 'Amazon Accounts Payable', email: 'ap@amazon.example' }] });
  assert.equal(supplier.r.status, 200, supplier.r.data?.error);

  // The reason for voiding is printed under the subject, so the two are read together.
  const split = await sent(una, 'victim-void@example.com', { subject: 'PayPal invoice #4471 - payment charged' });
  assert.equal(split.r.status, 200, 'no phone number, so not the lure yet');
  const voided = await una.post(`/envelopes/${split.e.id}/void`, { reason: 'To cancel this charge call +1 (888) 555-0142 now.' });
  assert.equal(voided.status, 422);
  assert.match(voided.data.error, /That reason, read together with the subject it would be emailed under, reads like a payment notice/);
  assert.equal(mailTo('victim-void@example.com').length, 1);
  assert.equal((await una.post(`/envelopes/${split.e.id}/void`, { reason: 'Sent by mistake' })).status, 200, 'a plain reason voids it');
  assert.match(mailTo('victim-void@example.com').at(-1)!.html, /Reason: Sent by mistake/);

  // A name that changes under an envelope that is out. Signed in order: the sender first, then the victim.
  const jo = await person('Jo Plain', 'jo@paths.test');
  const jf = await upload(jo, 1);
  const ordered = (await jo.post('/envelopes', { subject: 'Invoice #4471', message: 'Amount $499.00 was charged. To cancel call +1 (888) 555-0142 now.', ordered: true, send: true, documents: [{ id: 'd', file_id: jf.id }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Jo Plain', email: 'jo@paths.test', routing_order: 1 }, { id: 'r2', role: 'signer', name: 'Vic Tim', email: 'victim-order@example.com', routing_order: 2 }], fields: [sig('r1'), sig('r2', 0.5)] })).data.envelope;
  assert.equal((await jo.call('PATCH', '/me', { name: 'PayPal Billing' })).status, 422, 'the name is refused where it is set');
  assert.equal((await jo.call('PATCH', '/account', { name: 'PayPal' })).status, 422);
  assert.equal((await jo.call('PATCH', '/me', { name: 'Jo P. Plain', title: 'Owner' })).status, 200, 'an ordinary change is not');
  // A name that got in some other way (here: written to the database) is caught where the next email is written.
  db.run("UPDATE users SET name='PayPal Billing' WHERE email='jo@paths.test'");
  assert.equal((await signAll(ordered.id, 'jo@paths.test')).status, 200);
  assert.equal(mailTo('victim-order@example.com').length, 0, 'the next person is not asked under that name');
  assert.equal(db.get("SELECT status FROM recipients WHERE envelope_id=? AND email='victim-order@example.com'", ordered.id).status, 'pending');
  assert.ok((await full(jo, ordered.id)).audit.some((a: any) => a.action === 'Held back' && /^Not emailed yet: Vic Tim\./.test(a.detail)), 'the record says so');
  const told = mailTo('jo@paths.test').filter((m) => m.subject === 'Held back: Invoice #4471');
  assert.equal(told.length, 1, 'and so is the sender');
  assert.match(told[0].html, /Not emailed yet: Vic Tim\./);
  assert.match(told[0].html, /reads like PayPal/);
  // Once the name is put right, the timer sends what was held back.
  db.run("UPDATE users SET name='Jo Plain' WHERE email='jo@paths.test'");
  await cron.tick();
  assert.equal(mailTo('victim-order@example.com').length, 1);
  assert.equal(db.get('SELECT held_at h FROM envelopes WHERE id=?', ordered.id).h, null);

  // The notice that someone declined names them to everyone else. A sender who puts themselves on an envelope under
  // a name that completes the lure, and declines, gets a notice without the name.
  const dee = await person('Dee Cliner', 'dee@paths.test');
  const df = await upload(dee, 1);
  const both = await dee.post('/envelopes', { subject: 'Refund of $499: call +1 (888) 555-0142', send: true, documents: [{ id: 'd', file_id: df.id }],
    recipients: [{ id: 'me', role: 'signer', name: 'PayPal Refunds', email: 'dee@paths.test' }, { id: 'v', role: 'signer', name: 'Vic', email: 'victim-decline@example.com' }], fields: [sig('me'), sig('v', 0.5)] });
  assert.equal(both.status, 200);
  assert.equal((await visitor().post(`/sign/${tokenFor(both.data.envelope.id, 'dee@paths.test')}/decline`, { reason: 'No' })).status, 200);
  const declined = mailTo('victim-decline@example.com').at(-1)!;
  assert.match(declined.html, /One of the people asked to sign declined to sign, so the envelope is closed\./);
  assert.ok(!declined.html.includes('PayPal'));
});

test('paying does not lift the checks at once: a payment has to stand for 14 days, not refunded and not disputed', async () => {
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '3';
  try {
    const pat = await person('Pat Payer', 'pat@paid.test');
    const acc = await accountOf(pat);
    const file = await upload(pat, 1);
    const blast = () => pat.post('/envelopes', { subject: 'News', send: true, documents: [{ id: 'd', file_id: file.id }], fields: [], recipients: [0, 1, 2, 3].map((i) => ({ id: `v${i}`, role: 'viewer', name: `P ${i}`, email: `blast${i}@example.com` })) });
    // Minutes after paying for the monthly plan.
    db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, applied_at, kind) VALUES ('pay_pat', ?, 900, 'usd', ?, ?, 'plan')", acc, ago(0), ago(0));
    db.run("UPDATE accounts SET plan='grove' WHERE id=?", acc);
    const lure = await sent(pat, 'victim-paid@example.com', { subject: 'PayPal invoice #4471', message: LURE });
    assert.equal(lure.r.status, 422, 'what a paying account sends on its first day is still read');
    const many = await blast();
    assert.equal(many.status, 429, 'and still counted');
    assert.match(many.data.error, /^An account whose first payment is less than 14 days old can send to 3 people a day\./);
    assert.ok(many.data.error.includes(`Your payment was made on ${dayText(ago(0))}, so the limit goes on ${dayText(ago(-14))}, provided the payment is not refunded or disputed.`), many.data.error);
    assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email LIKE 'blast%' OR to_email='victim-paid@example.com'").n, 0);
    // One day short of the 14 it still holds. After them the payment has earned it.
    db.run("UPDATE payments SET at=? WHERE id='pay_pat'", ago(13));
    assert.equal((await blast()).status, 429);
    db.run("UPDATE payments SET at=? WHERE id='pay_pat'", ago(14.1));
    assert.equal((await blast()).status, 200);
    assert.equal((await pat.post(`/envelopes/${lure.e.id}/send`)).status, 200, 'the filter goes with the limit');
    // A payment that was refunded, in part or in full, or disputed, or never applied to the account, earns nothing.
    for (const state of ['refunded_cents=100', "refunded_cents=0, disputed='open'", "disputed='won'", 'disputed=NULL, applied_at=NULL', "applied_at=at, kind='unknown'"]) {
      db.run(`UPDATE payments SET ${state} WHERE id='pay_pat'`);
      assert.equal((await sent(pat, 'victim-paid2@example.com', { subject: 'PayPal invoice #4471', message: LURE })).r.status, 422, state);
    }
    assert.equal(mailTo('victim-paid2@example.com').length, 0);
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
  }
});

test('while an account is paused nothing its sender starts is emailed: not to the next in a signing order, not about a change, not the reason for voiding, not an invitation', async () => {
  const pam = await person('Pam Paused', 'pam@held.test');
  const acc = await accountOf(pam);
  const file = await upload(pam, 1);
  // Signed in order: Pam first, then a viewer and a copy who have not been emailed yet.
  const queued = (await pam.post('/envelopes', { subject: 'Your account statement', ordered: true, send: true, documents: [{ id: 'd', file_id: file.id }], fields: [sig('r1')],
    recipients: [{ id: 'r1', role: 'signer', name: 'Pam Paused', email: 'pam@held.test', routing_order: 1 }, { id: 'r2', role: 'viewer', name: 'Vic One', email: 'held1@example.com', routing_order: 2 }, { id: 'r3', role: 'cc', name: 'Vic Two', email: 'held2@example.com', routing_order: 2 }] })).data.envelope;
  const out = await sent(pam, 'has-it@example.com', { subject: 'Agreement' });
  const roles = (await pam.post('/envelopes', { subject: 'Roles', send: true, documents: [{ id: 'd', file_id: file.id }], fields: [sig('s')],
    recipients: [{ id: 's', role: 'signer', name: 'Sig', email: 'sig@held.example' }, { id: 'c', role: 'cc', name: 'Copy', email: 'copy@held.example' }] })).data.envelope;
  assert.equal(mailTo('copy@held.example').length, 1);
  assert.equal((await asOperator(() => op.post(`/operator/accounts/${acc}`, { paused: true, reason: 'Looks like phishing.' }))).status, 200);

  // Pam signs her own part. The two behind her were queued before the pause and are not released by it.
  assert.equal((await signAll(queued.id, 'pam@held.test')).status, 200);
  assert.equal(mailTo('held1@example.com').length + mailTo('held2@example.com').length, 0);
  assert.ok((await full(pam, queued.id)).audit.some((a: any) => a.action === 'Held back' && /Not emailed yet: Vic One, Vic Two\. Sending is paused on the account\./.test(a.detail)));
  const told = mailTo('pam@held.test').filter((m) => m.subject === 'Held back: Your account statement');
  assert.equal(told.length, 1);
  assert.match(told[0].html, /Reason: Looks like phishing\./);

  // A correction that changes no person is saved, and nobody is emailed about it: its wording is the sender's.
  const cur = (await full(pam, out.e.id)).envelope;
  const note = { id: 'n1', document_id: cur.documents[0].id, type: 'note', page: 0, x: 0.1, y: 0.1, w: 0.6, h: 0.1, value: 'Read this first: the terms have changed.' };
  assert.equal((await pam.put(`/envelopes/${out.e.id}`, { ...asBody(cur), fields: [...cur.fields, note] })).status, 200);
  assert.equal(mailTo('has-it@example.com').length, 1, 'no "Updated" email');
  assert.ok((await full(pam, out.e.id)).audit.some((a: any) => a.action === 'Change not emailed' && /Sending is paused on the account, so nobody was emailed about this change: Sam Signer\./.test(a.detail)));
  // Someone who had a copy is made a signer: a new request, so not now.
  const rc = (await full(pam, roles.id)).envelope;
  const copy = rc.recipients.find((r: any) => r.role === 'cc');
  const promoted = await pam.put(`/envelopes/${roles.id}`, { ...asBody(rc), recipients: rc.recipients.map((r: any) => (r.id === copy.id ? { ...r, role: 'signer' } : r)), fields: [...rc.fields, { id: 'f2', document_id: rc.documents[0].id, recipient_id: copy.id, type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(promoted.status, 200);
  assert.equal(mailTo('copy@held.example').length, 1, 'only the copy from before the pause');

  // Voiding always works. The reason is read for every paused account, whatever it has paid, and is not emailed.
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', ago(1), acc);
  assert.equal((await pam.post(`/envelopes/${out.e.id}/void`, { reason: 'PayPal refund department: call +1 (888) 555-0142 about your payment.' })).status, 422);
  assert.equal((await pam.post(`/envelopes/${out.e.id}/void`, { reason: 'See my new offer at example.org' })).status, 200);
  const notice = mailTo('has-it@example.com').at(-1)!;
  assert.equal(notice.subject, 'Voided: Agreement');
  assert.ok(!notice.html.includes('new offer') && !notice.html.includes('Reason:'), 'the people on it are told it was voided, without the sender\'s words');
  db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', acc);

  // Team invitations are emails to strangers too.
  const invite = await pam.post('/account/invites', { email: 'invited@held.example' });
  assert.equal(invite.status, 403);
  assert.match(invite.data.error, /Reason: Looks like phishing\./);
  assert.match(invite.data.error, /no reminders, no reopening, no team invitations, no email about a change to a document, and nobody who is waiting further down a signing order is asked\./, 'the refusal lists what is really held back');
  assert.equal(mailTo('invited@held.example').length, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM invites WHERE account_id=?', acc).n, 0);

  // When a person lifts the pause, everyone who was held back is asked at once.
  assert.equal((await asOperator(() => op.post(`/operator/accounts/${acc}`, { paused: false }))).status, 200);
  assert.equal(mailTo('held1@example.com').length, 1);
  assert.equal(mailTo('held2@example.com').length, 1);
  assert.equal(mailTo('copy@held.example').length, 2, 'the new signer gets their request');
  assert.equal((await pam.post('/account/invites', { email: 'invited@held.example' })).status, 200);
});

test('team invitations need a confirmed address, are read for names that pose, and have a daily limit of their own', async () => {
  // A login one minute old that never confirmed its address could invite anyone, under any name.
  const raw = visitor();
  assert.equal((await raw.post('/auth/signup', { name: 'PayPal Billing', email: 'never@invite.test', password: 'correct horse battery' })).status, 200);
  const early = await raw.post('/account/invites', { email: 'target0@invite.example' });
  assert.equal(early.status, 403);
  assert.match(early.data.error, /^Confirm your email address before you invite anyone\./);
  // Confirmed, but the invitation would print a name that reads like a brand, or names that read like the notice.
  const posing = await person('PayPal Billing', 'pp@invite.test');
  const refused = await posing.post('/account/invites', { email: 'target1@invite.example' });
  assert.equal(refused.status, 422);
  assert.match(refused.data.error, /The name "PayPal Billing" reads like PayPal/);
  const liz = await person('Liz Clean', 'liz@invite.test');
  db.run('UPDATE accounts SET name=? WHERE id=?', 'Zelle payment of $499.00 sent. Not you? Call +1 (888) 555-0142', await accountOf(liz));
  const notice = await liz.post('/account/invites', { email: 'target2@invite.example' });
  assert.equal(notice.status, 422);
  assert.match(notice.data.error, /^These names read like a payment notice from a well-known brand with a phone number to call/);
  for (const k of [0, 1, 2]) assert.equal(mailTo(`target${k}@invite.example`).length, 0);

  // Twenty people a day, counted as people: asking the same person again is free, and cancelling hands nothing back.
  const tia = await person('Tia Team', 'tia@invite.test');
  const tacc = await accountOf(tia);
  for (let i = 0; i < 20; i++) assert.equal((await tia.post('/account/invites', { email: `mate${i}@invite.example` })).status, 200, `invitation ${i + 1}`);
  assert.equal((await tia.post('/account/invites', { email: 'MATE3@invite.example' })).status, 200, 'inviting someone again is not one more person');
  const over = await tia.post('/account/invites', { email: 'mate20@invite.example' });
  assert.equal(over.status, 429);
  assert.match(over.data.error, /^A team can invite 20 people a day, and this one has invited 20 in the last 24 hours\. There is room for this again in about 24 hours/);
  assert.match(over.data.error, /use the contact form at http:\/\/test\.local\/help and a person can lift the limit for you\.$/);
  for (const inv of (await tia.get('/account/members')).data.invites.slice(0, 5)) await tia.call('DELETE', `/account/invites/${inv.id}`);
  assert.equal((await tia.post('/account/invites', { email: 'mate21@invite.example' })).status, 429);
  assert.equal(mailTo('mate20@invite.example').length + mailTo('mate21@invite.example').length, 0);
  // Invitations and envelopes are counted apart, and a person lifts the limit by clearing the account.
  assert.equal((await sent(tia, 'client-tia@example.com')).r.status, 200);
  await asOperator(() => op.post(`/operator/accounts/${tacc}`, { trusted: true }));
  assert.equal((await tia.post('/account/invites', { email: 'mate20@invite.example' })).status, 200);
});

test('a stranger on a public form cannot pause its owner with made-up reporters', async () => {
  const fred = await person('Fred Forms', 'fred@formrep.test');
  const acc = await accountOf(fred);
  const tpl = await simple(fred, '', { kind: 'template', subject: 'Gym waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Guest' }] });
  await fred.post('/powerforms', { template_id: tpl.id, name: 'Gym waiver' });
  const slug = await slugOf(fred);
  // One stranger at one address: three made-up visitors, three reports from the links the form hands out.
  const here = ip();
  for (const k of [1, 2, 3]) {
    const started = await from(here).post(`/public/powerforms/${slug}/start`, { name: `Nobody ${k}`, email: `nobody${k}@made-up.example` });
    assert.equal(started.status, 200);
    assert.equal((await from(here).post(`/sign/${started.data.url.split('/sign/')[1]}/report`, { reason: 'phishing' })).status, 200);
  }
  // And a fourth, reported with the security code of the email the form sent.
  assert.equal((await visitor().post(`/public/powerforms/${slug}/start`, { name: 'Nobody 4', email: 'nobody4@made-up.example' })).status, 200);
  assert.equal((await visitor().post('/public/check/report', { code: codeOf(mailTo('nobody4@made-up.example').at(-1)!), reason: 'spam' })).status, 200);
  assert.equal((await fred.get('/me')).data.account.paused, null, 'four made-up visitors are not three recipients');
  assert.equal((await sent(fred, 'client-fred@example.com')).r.status, 200, 'the owner can still send');
  // The reports are kept and a person sees them, marked for what they are.
  await asOperator(async () => {
    const mine = (await op.get('/operator/queue')).data.reports.filter((r: any) => r.about_account === acc);
    assert.equal(mine.length, 4);
    assert.ok(mine.every((r: any) => r.via_form === true));
  });
  // Reports from people the owner chose to write to count as before, and the form's reports do not make up the number.
  const reported = async (victim: string) => {
    const x = await sent(fred, victim);
    assert.equal(x.r.status, 200);
    assert.equal((await visitor().post(`/sign/${tokenFor(x.e.id, victim)}/report`, { reason: 'phishing' })).status, 200);
  };
  await reported('fr1@example.com');
  await reported('fr2@example.com');
  assert.equal((await fred.get('/me')).data.account.paused, null, 'two recipients and four form visitors: not three recipients');
  await reported('fr3@example.com');
  assert.ok((await fred.get('/me')).data.account.paused);
});

test('voiding and deleting what was sent does not put a sender out of reach of reports', async () => {
  const eva = await person('Eva Eraser', 'eva@erase.test');
  const acc = await accountOf(eva);
  const erase = async (id: string) => {
    assert.equal((await eva.post(`/envelopes/${id}/void`, { reason: 'cleanup' })).status, 200);
    assert.equal((await eva.call('DELETE', `/envelopes/${id}`)).status, 200);
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', id).n, 0);
  };
  // Two recipients report. The sender deletes what they reported.
  const codes: string[] = [];
  for (const k of [1, 2]) {
    const x = await sent(eva, `er${k}@example.com`);
    codes.push(codeOf(mailTo(`er${k}@example.com`).at(-1)!));
    assert.equal((await visitor().post('/public/check/report', { code: codes.at(-1), reason: 'phishing' })).status, 200);
    await erase(x.e.id);
  }
  // A person still sees both reports, with the account they are about.
  await asOperator(async () => {
    const mine = (await op.get('/operator/queue')).data.reports.filter((r: any) => r.about_account === acc);
    assert.equal(mine.length, 2, 'deleting the envelopes does not hide the reports');
    assert.ok(mine.every((r: any) => r.envelope_deleted === true && r.subject === null && r.account_name === "Eva Eraser's workspace"));
  });
  // The third envelope is sent, voided and deleted before anyone can report it. Whoever holds its email still can.
  const third = await sent(eva, 'er3@example.com');
  const code = codeOf(mailTo('er3@example.com').at(-1)!);
  await erase(third.e.id);
  // Someone who reported before the document was deleted, and reports again with the same code, is still one person.
  assert.equal((await visitor().post('/public/check/report', { code: codes[0], reason: 'phishing' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE account_id=?', acc).n, 2);
  assert.equal((await eva.get('/me')).data.account.paused, null);
  const late = await visitor().post('/public/check/report', { code, reason: 'phishing', detail: 'It asked me to call a number.' });
  assert.equal(late.status, 200);
  assert.deepEqual(late.data, { ok: true, deleted: true });
  assert.ok((await eva.get('/me')).data.account.paused, 'three different people, all about documents that are gone');
  await asOperator(async () => {
    const mine = (await op.get('/operator/queue')).data.reports.filter((r: any) => r.about_account === acc);
    assert.equal(mine.length, 3);
    assert.ok(mine.some((r: any) => /holder of an email about a deleted document/.test(r.reporter) && r.detail === 'It asked me to call a number.'));
  });
});

test('the operator route does only what it is told, and the email about removed trust states the limit that applies', async () => {
  const ola = await person('Ola Paused', 'ola@oper.test');
  const acc = await accountOf(ola);
  const x = await sent(ola, 'reporter-ola@example.com');
  assert.equal((await visitor().post(`/sign/${tokenFor(x.e.id, 'reporter-ola@example.com')}/report`, { reason: 'spam' })).status, 200);
  await asOperator(async () => {
    assert.equal((await op.post(`/operator/accounts/${acc}`, { paused: true, reason: 'Looks like phishing' })).status, 200);
    // A body that says nothing used to lift the pause, dismiss every open report and tell the owner they could send again.
    for (const body of [{}, { paused: 'no' }, { trusted: 1 }, { reason: 'typo' }]) {
      const empty = await op.post(`/operator/accounts/${acc}`, body);
      assert.equal(empty.status, 400, JSON.stringify(body));
      assert.match(empty.data.error, /^Say what to change: "paused": true \(with a "reason"\) or false, or "trusted": true or false\. Nothing was changed\.$/);
    }
  });
  assert.ok((await ola.get('/me')).data.account.paused, 'still paused');
  assert.equal(db.get("SELECT status FROM abuse_reports WHERE account_id=?", acc).status, 'open', 'and the report is still open');
  assert.ok(!mailTo('ola@oper.test').some((m) => m.subject.startsWith('Sending is back on')));
  // In its first week the limit that comes back is the first-week one, and the email says that number.
  await asOperator(async () => {
    await op.post(`/operator/accounts/${acc}`, { paused: false });
    await op.post(`/operator/accounts/${acc}`, { trusted: true });
    await op.post(`/operator/accounts/${acc}`, { trusted: false });
  });
  const again = () => mailTo('ola@oper.test').filter((m) => m.subject === 'The sending limits apply to your GrowSigning account again').at(-1)!;
  assert.match(again().html, /Until the account has a payment that is at least 14 days old and was not refunded or disputed, it can send to at most 50 people a day \(200 a day after its first week\) and is checked for fake payment notices again\./);
  // With no support address set, a reply goes to the no-reply sender and reaches nobody: only the contact form is offered.
  assert.ok(!again().html.includes('reply to this email'));
  assert.match(again().html, /If this is a mistake, use the contact form at http:\/\/test\.local\/help and a person will review it\./);
  db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(30), acc);
  process.env.SUPPORT_EMAIL = 'help@growsigning.test';
  try {
    await asOperator(async () => {
      await op.post(`/operator/accounts/${acc}`, { trusted: true });
      await op.post(`/operator/accounts/${acc}`, { trusted: false });
    });
  } finally {
    delete process.env.SUPPORT_EMAIL;
  }
  assert.match(again().html, /it can send to at most 200 people a day and is checked/);
  assert.match(again().html, /If this is a mistake, reply to this email or use the contact form/, 'where replies reach a person, it says so');
});

test('an honest free account keeps its reminders, and a reminder the filter holds back is said out loud, once', async () => {
  // An account from long before the rules, on the free plan, with a family name that is also a brand and a street
  // named after a fruit.
  const sarah = await person('Sarah McAfee', 'sarah@old.test');
  db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(730), await accountOf(sarah));
  const { e, r } = await sent(sarah, 'tenant@example.com', { subject: 'Lease renewal', message: 'Renewal for the flat at 12 Apple Street. Call me on 555 123 4567 with questions.', reminder_days: 1 });
  assert.equal(r.status, 200, r.data?.error);
  const reminders = () => mailTo('tenant@example.com').filter((m) => m.subject === 'Reminder: Lease renewal').length;
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(3), e.id);
  await cron.tick();
  assert.equal(reminders(), 1, 'the timer reminds');
  assert.equal((await sarah.post(`/envelopes/${e.id}/remind`)).status, 200);
  assert.equal((await sarah.post(`/envelopes/${e.id}/extend`, { days: 7 })).status, 200);
  assert.equal(reminders(), 2);
  // When the filter does hold a reminder back (the name was changed to a brand's, here in the database), the
  // sender is told once and the record says why. It is not dropped without a word, run after run.
  db.run("UPDATE users SET name='Zelle Payments' WHERE email='sarah@old.test'");
  db.run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', ago(2), e.id);
  await cron.tick();
  await cron.tick();
  assert.equal(reminders(), 2);
  const told = mailTo('sarah@old.test').filter((m) => m.subject === 'Held back: Lease renewal');
  assert.equal(told.length, 1);
  assert.match(told[0].html, /The automatic reminder was not sent\./);
  assert.match(told[0].html, /The name &quot;Zelle Payments&quot; reads like Zelle/);
  assert.equal((await full(sarah, e.id)).audit.filter((a: any) => a.action === 'Held back').length, 1);
  // With the name put right the reminders start again by themselves.
  db.run("UPDATE users SET name='Sarah McAfee' WHERE email='sarah@old.test'");
  await cron.tick();
  await cron.tick();
  assert.equal(reminders(), 3);
});

// ---- What a third look found. -----------------------------------------------------------------------------------

test('a public form\'s page never prints a fake payment notice, and its owner hears why it is closed', async () => {
  const gil = await person('Gil Gym', 'gil@formname.test');
  const acc = await accountOf(gil);
  const tpl = await simple(gil, '', { kind: 'template', subject: 'Gym waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Guest' }] });
  const NOTICE = 'PayPal invoice: payment of $499 charged, call +1 (888) 555-0142';
  // The form's name is the notice. Its page would print it, phone number and all, to anyone with the link, on our
  // address, while every start is refused. So it is refused where it is made.
  const made = await gil.post('/powerforms', { template_id: tpl.id, name: NOTICE });
  assert.equal(made.status, 422);
  assert.match(made.data.error, /^This reads like a payment notice .*What set this off: the name PayPal, words about money \("\w+"\) and what looks like a phone number/);
  // A name that mentions a way to pay is not a notice.
  assert.equal((await gil.post('/powerforms', { template_id: tpl.id, name: 'Gym waiver (pay by PayPal at the desk)' })).status, 200);
  const fine = await visitor().get(`/public/powerforms/${await slugOf(gil)}`);
  assert.deepEqual([fine.data.closed, fine.data.name, fine.data.brand.name], [false, 'Gym waiver (pay by PayPal at the desk)', "Gil Gym's workspace"]);
  // A form that got such a name before the rule (written to the database here) is closed and prints nothing of it.
  db.run("INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at) VALUES ('pwf_gil', ?, ?, 'gil-notice', ?, ?)", acc, tpl.id, NOTICE, ago(30));
  for (let i = 0; i < 3; i++) {
    const page = await visitor().get('/public/powerforms/gil-notice');
    assert.equal(page.status, 200);
    assert.equal(page.data.closed, true, 'said before anyone types a thing');
    assert.equal(page.data.name, null);
    assert.equal(page.data.brand, null);
    assert.ok(!JSON.stringify(page.data).includes('555'));
  }
  assert.equal((await visitor().post('/public/powerforms/gil-notice/start', { name: 'Walk In', email: 'walkin-gil@example.com' })).data.error, FORM_CLOSED);
  assert.equal(mailTo('walkin-gil@example.com').length, 0);
  // Nobody starts a closed form, so the owner would never hear why. They are told, once a day however often it is opened.
  const told = mailTo('gil@formname.test').filter((m) => m.subject.includes('could not take a signature'));
  assert.equal(told.length, 1);
  assert.match(told[0].html, /The name of this public form reads like a payment notice/);
  // Cleared by a person, it is a form like any other.
  await asOperator(() => op.post(`/operator/accounts/${acc}`, { trusted: true }));
  assert.equal((await visitor().get('/public/powerforms/gil-notice')).data.closed, false);
});

test('someone who has forgotten the password they just chose confirms with a new one, and nobody else stays in that login', async () => {
  const laptop = visitor();
  assert.equal((await laptop.post('/auth/signup', { name: 'Rosa Forgets', email: 'rosa@forgot.test', password: 'a password I forgot' })).status, 200);
  const link = { token: db.get("SELECT verify_token t FROM users WHERE email='rosa@forgot.test'").t };
  // She opens the email on her phone, which is not signed in, and cannot remember the password.
  const phone = visitor();
  assert.equal((await phone.post('/auth/verify', link)).data.code, 'password_needed');
  // The confirm page offers "Choose a new password". That link goes to the same mailbox, so it shows the same thing.
  assert.equal((await phone.post('/auth/forgot', { email: 'rosa@forgot.test' })).status, 200);
  const reset = mailTo('rosa@forgot.test').find((m) => m.subject === 'Reset your GrowSigning password')!;
  const t = /reset\?token=([\w-]+)/.exec(reset.html)![1];
  assert.equal((await phone.post('/auth/reset', { token: t, password: 'a new one I will keep' })).status, 200);
  assert.equal(db.get("SELECT email_verified v FROM users WHERE email='rosa@forgot.test'").v, 1, 'the address is confirmed');
  assert.equal((await laptop.get('/me')).data.user, null, 'every browser that was signed in to the login is signed out, so a stranger who made it is put out');
  assert.equal((await phone.post('/auth/verify', link)).status, 200, 'and the link in the first email now simply says it is done');
});
