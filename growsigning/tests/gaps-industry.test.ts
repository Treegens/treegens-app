// What agents, clinics, contractors, HR teams and small firms ran into (research/gaps-partial.json, "industry"):
// pages that promised more than the code does, a bulk send whose price showed up after the Send button, two people
// finishing at the same moment, "filled everything in and never pressed Finish", templates nobody can find among
// fifty, wording that has to be struck out, and money that is due at signing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, signUp, upload, draft, simple, signAll, tokenFor, mailTo, Client, PNG, type Server } from './helpers.ts';
import * as policy from '../src/lib/policy.ts';
import { resolver, specialAddress } from '../src/server/paydns.ts';
import { payPrint } from '../src/server/paydrop.ts';
import { checkPayUrl, PAY_SHORTENERS } from '../src/lib/paylink.ts';
import { englishIf } from './words.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.100.${++n}`;
// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const days = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

// ---- A. What the pages say, and what the code does -------------------------------------------------------

test('the security page no longer says "only the right people": a signing link opens the document for whoever holds it', async () => {
  const page = read('src/app/security/page.tsx');
  assert.doesNotMatch(page, /Only the right people can open a document/);
  assert.match(page, /A signing link opens the document for whoever holds it/);
  assert.match(policy.WHO_CAN_SEE[0].who, /anyone they pass their link to/);
  assert.match(policy.WHO_CAN_SEE[0].what, /access code/);
  assert.match(policy.WHO_CAN_SEE[0].what, /one-time code/);

  // The sentence is true: a stranger's browser, from another address, with nothing but the link.
  const c = await signUp('Lia Link', 'lia-link@example.com', ip());
  const e = await draft(c, { ordered: true });
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const stranger = new Client();
  stranger.ip = '192.0.2.77';
  const open = await stranger.get(`/sign/${tokenFor(e.id, 'ada@example.com')}`);
  assert.equal(open.status, 200);
  assert.equal(open.data.documents.length, 1, 'whoever holds the link gets the document');
  assert.equal(open.data.recipient.name, 'Ada Signer');
  // Which is why access codes exist: Ben's link opens nothing without his code, and not before his turn either.
  const early = await stranger.get(`/sign/${tokenFor(e.id, 'ben@example.com')}`);
  assert.ok(!early.data.documents?.length, 'not before their turn');
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  const locked = await stranger.get(`/sign/${tokenFor(e.id, 'ben@example.com')}`);
  assert.equal(locked.data.locked, true, 'an access code stands between the link and the document');
  assert.ok(!locked.data.documents?.length);
});

test('what the people who run the server see in the app is what "Who can see your documents" says, and no document', async () => {
  const sender = await signUp('Rae Reported', 'rae-reported@example.com', ip());
  const e = await simple(sender, 'pat-reporter@example.com', { subject: 'Listing agreement', message: 'Please sign today.', send: true });
  const signer = new Client();
  const tok = tokenFor(e.id, 'pat-reporter@example.com');
  assert.equal((await signer.post(`/sign/${tok}/report`, { reason: 'not-for-me', detail: 'I do not know this person.' })).status, 200);

  process.env.OPERATOR_EMAILS = 'olly-operator@example.com';
  const op = await signUp('Olly Operator', 'olly-operator@example.com', ip());
  const q = await op.get('/operator/queue');
  assert.equal(q.status, 200);
  const report = q.data.reports.find((r: any) => r.envelope_id === e.id);
  assert.ok(report, 'the report is in the queue');
  // Named on the page: the subject, the sender's message, the sender's name and address, who reported it.
  assert.equal(report.subject, 'Listing agreement');
  assert.equal(report.message, 'Please sign today.');
  assert.equal(report.sender_email, 'rae-reported@example.com');
  // Not on the page, and not in the answer: a document, a file, a field, an answer, a signature, an audit trail.
  const text = JSON.stringify(q.data);
  for (const word of ['documents', 'file_id', 'fields', 'signature_png', 'audit', 'sha256', '"token"'])
    assert.ok(!text.includes(word), `the operator queue carries no "${word}"`);
  // An operator is an ordinary login everywhere else: somebody else's envelope, PDF and audit trail are not theirs.
  assert.equal((await op.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await op.get(`/envelopes/${e.id}/download`)).status, 404);
  assert.equal((await op.get(`/envelopes?q=Listing`)).data.envelopes.length, 0);
  // And nobody who is not named as an operator gets the queue at all.
  assert.equal((await sender.get('/operator/queue')).status, 404);

  const who = policy.WHO_CAN_SEE.map((w) => w.who);
  assert.deepEqual(who, ['The people it was sent to, and anyone they pass their link to.', 'The person who sent it.', 'The owner and the admins of the sender\'s account.', 'Addresses the sender\'s account sends copies of its emails to.', 'The people who run this server.', 'The companies that carry it.', 'Nobody else.']);
  const operator = policy.WHO_CAN_SEE[4].what;
  assert.match(operator, /no screen and no function that opens a document/);
  assert.match(operator, /encrypts at most part of the database/, 'and it says that the disk is another matter');
  assert.match(operator, /promise by the people who run the server/, 'a rule the software cannot enforce is called a promise');
  // Every fact the operator's account views return is named: the queue, a help request and the card dispute list.
  const theirs = (await sender.get('/me')).data.account;
  s.db.run('UPDATE accounts SET dispute_at=? WHERE id=?', new Date().toISOString(), theirs.id);
  const disputed = (await op.get('/operator/billing/disputed')).data.accounts.find((a: any) => a.id === theirs.id);
  assert.deepEqual(Object.keys(disputed).sort(), ['admins', 'dispute_at', 'free_with', 'id', 'name', 'plan', 'signatures'], 'if this list grows, the sentence has to grow with it');
  for (const [field, words] of [['plan', /its plan/], ['free_with', /a free code it uses/], ['dispute_at', /a card dispute/], ['signatures', /how many signatures it has left/], ['admins', /names and addresses of its owner and admins/], ['trusted_at', /marked as trusted/], ['suspended_at', /paused/], ['last_payment', /its last payment/], ['renews_at', /renews or ends and when/]] as [string, RegExp][])
    assert.match(operator, words, `the page names ${field}`);
  const nobody = policy.WHO_CAN_SEE[6].what;
  for (const re of [/no advertising/, /sold/, /AI service/]) assert.match(nobody, re);
  // The block is printed from the one list, on the security page.
  const page = read('src/app/security/page.tsx');
  assert.match(page, /id="who" title="Who can see your documents"/);
  assert.match(page, /WHO_CAN_SEE\.map/);
  assert.match(page, /href="#who"/);
});

test('on a team, the owner and admins can open what a member sends, and a member cannot open theirs', async () => {
  const owner = await signUp('Una Owner', 'una-owner@example.com', ip());
  assert.equal((await owner.post('/account/invites', { email: 'mel-member@example.com', role: 'member' })).status, 200);
  const invite = s.db.get('SELECT token FROM invites WHERE email=?', 'mel-member@example.com').token;
  const member = new Client();
  member.ip = ip();
  const joined = await member.post('/auth/signup', { name: 'Mel Member', email: 'mel-member@example.com', password: 'correct horse battery', invite });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const theirs = await simple(member, 'client-of-mel@example.com', { send: true });
  const hers = await simple(owner, 'client-of-una@example.com', { send: true });
  assert.equal((await owner.get(`/envelopes/${theirs.id}`)).status, 200, 'the owner opens a member\'s envelope');
  assert.equal((await member.get(`/envelopes/${hers.id}`)).status, 404, 'a member does not open the owner\'s');
  assert.match(policy.WHO_CAN_SEE[2].what, /its admins can read what you send/);
});

test('public forms are not sold for consent forms any more, and the missing health agreement is said in three places from one text', () => {
  // The feature list moved from the home page to /features on 21 November 2026 (simplify-public).
  const landing = read('src/app/features/page.tsx') + read('src/app/pricing/page.tsx');
  assert.doesNotMatch(landing, /consent forms/i);
  assert.match(landing, /Not for patient forms/);
  // One text, kept once.
  assert.equal(policy.NO_BAA_TITLE, 'Not for patient information.');
  assert.match(policy.NO_BAA_TEXT, /There is no HIPAA business associate agreement \(BAA\) for GrowSigning/);
  assert.match(policy.NO_BAA_TEXT, /Nobody can sign one with us, on any plan, at any price/);
  assert.match(policy.NO_BAA_TEXT, /do not put protected health information through GrowSigning/);
  assert.match(policy.NO_BAA_TEXT, /no patient intake forms, no consent forms that name a patient/);
  assert.equal(policy.NO_BAA_FIRST.length, 4, 'what would have to be true first');
  assert.match(policy.NO_BAA_FIRST.join(' '), /written by a lawyer/);
  assert.match(policy.NO_BAA_FIRST.join(' '), /mail provider/);
  assert.match(policy.NO_BAA_FIRST.join(' '), /encrypted by the software itself/);
  assert.match(policy.NO_BAA_AFTER, /None of that exists today/);
  // It never says a signature or the service "is compliant", and it is not advice.
  for (const t of [policy.NO_BAA_TEXT, policy.NO_BAA_AFTER, ...policy.NO_BAA_FIRST]) assert.doesNotMatch(t, /compliant|is valid|will hold up|\u2014/i);
  // Printed from that text: /security under "What this is not", the landing page under the pricing rules, /help as a question.
  const security = read('src/app/security/page.tsx');
  assert.match(security, /<Point title=\{NO_BAA_TITLE\}>\{NO_BAA_TEXT\}/);
  assert.ok(security.indexOf('NO_BAA_TITLE}>') > security.indexOf('id="not"'), 'inside the block "What this is not"');
  assert.match(landing, /<li id="not-for-patients"><b>\{NO_BAA_TITLE\}<\/b> \{NO_BAA_TEXT\}/);
  assert.ok(landing.indexOf('not-for-patients') > landing.indexOf('<h3>The rules</h3>'), 'under the pricing rules');
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<QA id="patient-information" q="Can I use it for patient forms or other health information\?">/);
  assert.match(help, /\{NO_BAA_TITLE\}<\/b> \{NO_BAA_TEXT\}/);
  assert.match(help, /NO_BAA_FIRST\.map/);
  // No click-through agreement anywhere: no route and no page offers one.
  for (const f of ['src/server/routes-account.ts', 'src/server/routes-envelopes.ts', 'src/server/openapi.ts', 'src/app/app/settings/page.tsx'])
    assert.doesNotMatch(read(f), /business associate|\bBAA\b/i, `${f} offers no agreement`);
});

test('bulk send is no longer "on every plan, including free" without its price', () => {
  // The feature list is on /features and the rules are on /pricing since 21 November 2026 (simplify-public).
  const landing = read('src/app/features/page.tsx') + read('src/app/pricing/page.tsx');
  assert.doesNotMatch(landing, /Every plan, including free/);
  assert.match(landing, /Send one template to hundreds of people from a spreadsheet\. \$\{BULK_COST_NOTE\}/);
  assert.match(landing, /<li id="bulk-cost"><b>What Send to many costs\.<\/b> \{BULK_COST_NOTE\}/);
  assert.match(policy.BULK_COST_NOTE, /Each person who signs uses one signature/);
  assert.match(policy.BULK_COST_NOTE, /only goes out when all of its signatures are already in your balance/);
  assert.match(read('src/app/help/page.tsx'), /<b>Send to many:<\/b> \{BULK_COST_NOTE\}/);
  assert.match(read('README.md'), /a batch only goes\s+out when all of its signatures are already in the balance/);
});

test('"automatic nudges" is true: a new account reminds every 3 days, says so, and the sender can switch it off', async () => {
  assert.equal(policy.DEFAULT_REMINDER_DAYS, 3);
  const c = await signUp('Nia Nudge', 'nia-nudge@example.com', ip());
  assert.equal((await c.get('/me')).data.account.default_reminder_days, 3, 'a new account starts with reminders on');
  const e = await simple(c, 'slow-signer@example.com', { send: true });
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.reminder_days, 3, 'and so does its first envelope, without anyone setting it');

  const reminders = () => mailTo('slow-signer@example.com').filter((m) => m.subject.startsWith('Reminder: ')).length;
  s.db.run('UPDATE envelopes SET sent_at=? WHERE id=?', days(2), e.id);
  await s.env.cronTick();
  assert.equal(reminders(), 0, 'not after two days');
  s.db.run('UPDATE envelopes SET sent_at=? WHERE id=?', days(3.01), e.id);
  await s.env.cronTick();
  assert.equal(reminders(), 1, 'after three days the signer is reminded, with nobody pressing anything');
  await s.env.cronTick();
  assert.equal(reminders(), 1, 'and not again until three more days have passed');
  s.db.run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', days(3.01), e.id);
  await s.env.cronTick();
  assert.equal(reminders(), 2);

  // The sender's choice at send time wins: 0 means nobody is reminded.
  const quiet = await simple(c, 'left-alone@example.com', { reminder_days: 0, send: true });
  s.db.run('UPDATE envelopes SET sent_at=? WHERE id=?', days(10), quiet.id);
  await s.env.cronTick();
  assert.equal(mailTo('left-alone@example.com').filter((m) => m.subject.startsWith('Reminder: ')).length, 0);

  // An admin changes what new envelopes start with, and an account that has 0 stays at 0.
  assert.equal((await c.call('PATCH', '/account', { default_reminder_days: 0 })).status, 200);
  assert.equal((await simple(c, 'later@example.com')).reminder_days, 0);

  // Said in full sentences where the sender decides and where they look afterwards.
  assert.match(policy.reminderText(3), /^Automatic reminders are on: whoever has not finished is emailed again every 3 days, until they finish or the deadline passes\./);
  assert.match(policy.reminderText(1), /every day,/);
  assert.match(policy.reminderText(0), /^Automatic reminders are off: nobody is reminded unless you send a reminder yourself\.$/);
  // (simplify-editor: reminders are asked once, under More options of the step with the Send button, and what is set stands next to that button.)
  assert.match(read('src/components/editor/StepReview.tsx'), /<ReviewMore ed=\{ed\} closed=\{!!closed\} \/>/, 'the choice is on the step with the Send button');
  assert.match(read('src/components/editor/ReviewParts.tsx'), /<ReminderChoice days=\{env\.reminder_days\}/);
  // (repair-simplify-editor: the line next to the closed More options is built in src/lib/editorux.ts reviewSummary. It always
  // says the reminders, except when the sender signs alone and nobody is invited.)
  assert.match(read('src/lib/editorux.ts'), /if \(!o\.signNow\) said\.push\(o\.reminderDays > 0 \? `Reminder every \$\{days\(Math\.round\(o\.reminderDays\)\)\}` : 'No automatic reminders'\);/);
  assert.match(read('src/components/editor/ReviewParts.tsx'), /reminderDays: env\.reminder_days,/);
  assert.match(read('src/components/editor/ReminderChoice.tsx'), /reminderText\(n\)/);
  assert.match(read('src/app/app/envelopes/[id]/page.tsx'), /id="sn-reminders">\{reminderText\(e\.reminder_days\)\}/, 'and on the envelope');
  assert.match(read('src/components/settings/SendingDefaults.tsx'), /id="set-reminders"><b>New documents start like this\.<\/b> \{reminderWords\(T, reminders \?\? a\.default_reminder_days\)\}/, 'and under Settings, Sending (reminderText in the screen\'s language, lang-sender-rest)');
  const landing = read('src/app/features/page.tsx');
  assert.doesNotMatch(landing, /Automatic nudges/);
  assert.match(landing, /A new account reminds whoever has not finished by email every \$\{DEFAULT_REMINDER_DAYS\} days/);
  // In-person signing says that it needs a connection.
  assert.match(landing, /\['In-person signing', `[^`]*standing next to you\.[^`]*\$\{IN_PERSON_ONLINE\}`\]/);
  assert.match(policy.IN_PERSON_ONLINE, /needs an internet connection from opening the document to pressing Finish/);
});

// ---- D. What a bulk send holds, before the Send button ---------------------------------------------------

// Signatures are only counted while a payment provider is connected. Nothing here pays or reaches the network.
async function counting<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_gaps_industry';
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = was;
  }
}
async function waiver(c: Client, recipients: any[]) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject: 'Offer letter', documents: [{ id: 'd', file_id: file.id }], recipients,
    fields: recipients.filter((x) => x.role === 'signer').map((x) => ({ document_id: 'd', recipient_id: x.id, type: 'signature', page: 0, x: 0.1, y: 0.2 + 0.1 * recipients.indexOf(x), w: 0.3, h: 0.06 })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const hires = (tag: string, count: number, role = 'Hire') => Array.from({ length: count }, (_, i) => ({ [role]: { name: `${tag} ${i + 1}`, email: `${tag}${i + 1}@example.com` } }));

test('the bulk page is told what a batch holds, what is there, what is missing and what that costs, in the numbers the send is held to', async () => {
  await counting(async () => {
    const c = await signUp('Hana Hiring', 'hana-hiring@example.com', ip());
    const me = (await c.get('/me')).data;
    const tpl = await waiver(c, [{ id: 'r', role: 'signer', role_name: 'Hire' }, { id: 'me', role: 'signer', name: 'Hana Hiring', email: 'hana-hiring@example.com' }, { id: 'cc', role: 'cc', name: 'Files', email: 'files@example.com' }]);
    const check = async (rows: any[]) => (await c.post('/bulk/check', { template_id: tpl.id, rows })).data;

    // A list that fits: 2 of the 3 welcome signatures. The sender's own signature and the copy cost nothing.
    const fits = await check(hires('fit', 2));
    assert.deepEqual({ counted: fits.counted, rows: fits.rows, per: fits.signers_per_row, need: fits.need, have: fits.have, short: fits.short, cost: fits.cost, refusal: fits.refusal },
      { counted: true, rows: 2, per: 1, need: 2, have: 3, short: 0, cost: null, refusal: null });

    // The research's case: an offer letter to 40 people. On the free plan a top-up needs the monthly plan first.
    const forty = await check(hires('forty', 40));
    assert.equal(forty.need, 40);
    assert.equal(forty.have, 3);
    assert.equal(forty.short, 37);
    assert.equal(forty.plan, 'seedling');
    assert.deepEqual(forty.cost, { usd: 9 + 28, plan_usd: 9, plan_signatures: 9, top_up: 28, top_up_usd: 28 });
    // The send itself answers with the same two numbers, and sends nothing.
    const refused = await c.post('/bulk', { template_id: tpl.id, rows: hires('forty', 40) });
    assert.equal(refused.status, 402);
    assert.match(refused.data.error, /^This needs 40 signatures and you have 3 left\./);
    assert.equal(mailTo('forty1@example.com').length, 0);
    assert.equal(s.db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', me.account.id).n, 0);

    // On the monthly plan the missing ones are a top-up at the price of one signature each.
    s.db.run("UPDATE accounts SET plan='grove' WHERE id=?", me.account.id);
    const onPlan = await check(hires('forty', 40));
    assert.deepEqual(onPlan.cost, { usd: 37, plan_usd: 0, plan_signatures: 0, top_up: 37, top_up_usd: 37 });
    s.db.run("UPDATE accounts SET plan='seedling' WHERE id=?", me.account.id);

    // What is out counts: after a batch of 2 is sent, 2 are held and 1 is free to send with.
    const sent = await c.post('/bulk', { template_id: tpl.id, rows: hires('fit', 2) });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.sent, 2);
    const after = await check(hires('next', 2));
    assert.equal(after.have, 1);
    assert.equal(after.short, 1);
    assert.deepEqual(after.cost, { usd: 9, plan_usd: 9, plan_signatures: 9, top_up: 0, top_up_usd: 0 }, 'one monthly payment covers a small gap');

    // The daily limit on people newly emailed is said before the button as well, in the words of the refusal.
    const many = hires('many', 60);
    const over = await check(many);
    assert.equal(over.refusal?.status, 429);
    const sendOver = await c.post('/bulk', { template_id: tpl.id, rows: many });
    assert.equal(sendOver.status, 429);
    assert.equal(over.refusal.message, sendOver.data.error, 'the same sentence the send answers with');

    // Asking sends nothing and writes nothing.
    assert.equal(mailTo('many1@example.com').length + mailTo('next1@example.com').length, 0);
    assert.equal(s.db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', me.account.id).n, 1);
    // Somebody else's template is not theirs to ask about.
    const other = await signUp('Otto Other', 'otto-other@example.com', ip());
    assert.equal((await other.post('/bulk/check', { template_id: tpl.id, rows: hires('x', 1) })).status, 404);
  });
});

test('the count is the server\'s: two signers on a row, and a client entered under the sender\'s own address, each hold a signature', async () => {
  await counting(async () => {
    const c = await signUp('Cleo Couples', 'cleo-couples@example.com', ip());
    // Two open roles, and a client who has no address of their own and is entered under the sender's.
    const tpl = await waiver(c, [{ id: 'a', role: 'signer', role_name: 'Buyer' }, { id: 'b', role: 'signer', role_name: 'Co-buyer' }, { id: 'k', role: 'signer', name: 'Grandpa Client', email: 'cleo-couples@example.com' }]);
    const rows = [{ Buyer: { name: 'Bo Buyer', email: 'bo-buyer@example.com' }, 'Co-buyer': { name: 'Di Buyer', email: 'bo-buyer@example.com' } }];
    const one = (await c.post('/bulk/check', { template_id: tpl.id, rows })).data;
    assert.equal(one.signers_per_row, 3, 'both buyers and the client under the sender\'s address');
    assert.equal(one.need, 3);
    assert.equal(one.short, 0);
    const two = (await c.post('/bulk/check', { template_id: tpl.id, rows: [...rows, ...rows] })).data;
    assert.equal(two.need, 6);
    assert.equal(two.short, 3);
    assert.equal((await c.post('/bulk', { template_id: tpl.id, rows: [...rows, { Buyer: { name: 'Al Buyer', email: 'al-buyer@example.com' }, 'Co-buyer': { name: 'Em Buyer', email: 'em-buyer@example.com' } }] })).status, 402, 'and the send agrees');
  });
});

test('with no payment provider nothing is counted, and the page that shows the count asks the server for it', async () => {
  const c = await signUp('Nora Nocount', 'nora-nocount@example.com', ip());
  const tpl = await waiver(c, [{ id: 'r', role: 'signer', role_name: 'Hire' }]);
  const r = (await c.post('/bulk/check', { template_id: tpl.id, rows: hires('free', 20) })).data;
  assert.equal(r.counted, false);
  assert.equal(r.short, 0);
  assert.equal(r.cost, null);

  const page = read('src/app/app/bulk/page.tsx');
  const cost = read('src/app/app/bulk/BatchCost.tsx');
  assert.match(cost, /api<BatchCheck>\('\/bulk\/check'/, 'the numbers come from the server');
  assert.ok(page.indexOf('<BatchCost check={check}') > 0 && page.indexOf('<BatchCost check={check}') < page.indexOf('onClick={() => setConfirming(ready)}'), 'and they stand before the Send button');
  assert.match(page, /\{listOk && <BatchCost/, 'for every list, not only one that is too long');
  // The words are in the catalogue since lang-sender-rest: the same sentences, from the same numbers.
  assert.match(cost, /This batch holds \{count, plural, one \{# signature\} other \{# signatures\}\} and you have \{c\.have\} ready, so \{short, plural/);
  assert.match(fs.readFileSync(new URL('../src/app/app/bulk/BatchCost.tsx', import.meta.url), 'utf8'), /T\('bulk\.cost\.short', \{ count: c\.need, have: c\.have, short: c\.short \}\)/);
  assert.match(cost, /Top up \{count, plural, one \{# signature\} other \{# signatures\}\} for \{usd\(cost\.top_up_usd\)\}/);
  assert.match(page, /batchLine\(check, T\.lang\)/, 'and the confirm dialog says it once more');
});

// ---- E. Two signers finishing at the same moment ----------------------------------------------------------

// A couple signing side by side, each on their own device: both save and both press Finish in the same instant.
// Nothing either of them did may be lost, and the envelope is completed exactly once.
async function finishTogether(tag: string, emails: [string, string]) {
  const c = await signUp(`Rhea ${tag}`, `rhea-${tag}@example.com`, ip());
  const file = await upload(c, 1);
  const people = [{ id: 'a', name: `Ana ${tag}`, email: emails[0] }, { id: 'b', name: `Bob ${tag}`, email: emails[1] }];
  const made = await c.post('/envelopes', {
    subject: `Purchase agreement ${tag}`, ordered: false, documents: [{ id: 'd', file_id: file.id, name: 'Agreement' }],
    recipients: people.map((p) => ({ ...p, role: 'signer' })),
    fields: people.flatMap((p, i) => [
      { id: `sig-${p.id}`, document_id: 'd', recipient_id: p.id, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.3, w: 0.3, h: 0.06 },
      { id: `ini-${p.id}`, document_id: 'd', recipient_id: p.id, type: 'initials', page: 0, x: 0.5, y: 0.2 + i * 0.3, w: 0.1, h: 0.05 },
      { id: `txt-${p.id}`, document_id: 'd', recipient_id: p.id, type: 'text', label: `Address of ${p.name}`, page: 0, x: 0.1, y: 0.3 + i * 0.3, w: 0.5, h: 0.03 },
      { id: `chk-${p.id}`, document_id: 'd', recipient_id: p.id, type: 'checkbox', label: 'I have read it', page: 0, x: 0.1, y: 0.36 + i * 0.3, w: 0.03, h: 0.02 },
    ]),
    send: true,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  const rcp = (name: string) => e.recipients.find((r: any) => r.name === name);
  const fieldsOf = (r: any) => Object.fromEntries(e.fields.filter((f: any) => f.recipient_id === r.id).map((f: any) => [f.type, f.id]));
  // Each on a device of their own: separate cookies, separate addresses on the network.
  const signers = people.map((p, i) => {
    const r = rcp(p.name);
    const client = new Client();
    client.ip = `192.0.2.${100 + i}`;
    const f = fieldsOf(r);
    return { p, r, client, token: s.db.get('SELECT token FROM recipients WHERE id=?', r.id).token as string, values: { [f.signature]: '1', [f.initials]: '1', [f.text]: `${p.name} lives at ${i + 1} Mangrove Lane`, [f.checkbox]: '1' }, f };
  });
  assert.notEqual(signers[0].token, signers[1].token, 'each has a link of their own, also at one address');
  for (const x of signers) {
    assert.equal((await x.client.get(`/sign/${x.token}`)).status, 200);
    assert.equal((await x.client.post(`/sign/${x.token}/consent`)).status, 200);
  }
  // Both save what they typed in the same instant, then both press Finish in the same instant.
  const saves = await Promise.all(signers.map((x) => x.client.post(`/sign/${x.token}/save`, { values: x.values, signature_png: PNG, initials_png: PNG })));
  assert.deepEqual(saves.map((r) => r.status), [200, 200], JSON.stringify(saves.map((r) => r.data)));
  const done = await Promise.all(signers.map((x) => x.client.post(`/sign/${x.token}/complete`, { values: x.values, signature_png: PNG, initials_png: PNG })));
  assert.deepEqual(done.map((r) => r.status), [200, 200], JSON.stringify(done.map((r) => r.data)));

  const after = (await c.get(`/envelopes/${e.id}`)).data;
  assert.equal(after.envelope.status, 'completed');
  for (const x of signers) {
    const row = s.db.get('SELECT status, signature_png, initials_png, completed_at FROM recipients WHERE id=?', x.r.id);
    assert.equal(row.status, 'completed', `${x.p.name} is recorded as finished`);
    assert.equal(row.signature_png, PNG, `the signature of ${x.p.name} is kept`);
    assert.equal(row.initials_png, PNG, `the initials of ${x.p.name} are kept`);
    const kept = Object.fromEntries(s.db.all('SELECT id, value FROM fields WHERE recipient_id=?', x.r.id).map((f: any) => [f.id, f.value]));
    assert.equal(kept[x.f.text], x.values[x.f.text], `what ${x.p.name} typed is kept`);
    assert.equal(kept[x.f.checkbox], '1');
    assert.equal(kept[x.f.signature], '1');
    assert.equal(kept[x.f.initials], '1');
  }
  // The record: each person signed once, the envelope was completed once, and nothing in the chain is out of place.
  const trail = after.audit as any[];
  assert.equal(trail.filter((a) => a.action === 'Signed').length, 2);
  assert.deepEqual(trail.filter((a) => a.action === 'Signed').map((a) => a.detail).sort(), signers.map((x) => `${x.p.name} <${x.p.email}>`).sort());
  assert.equal(trail.filter((a) => a.action === 'Envelope completed').length, 1, 'completed once');
  assert.equal(after.chain.ok, true, 'the audit chain is intact');
  assert.equal(new Set(trail.map((a) => a.seq)).size, trail.length, 'no line of it carries a number twice');
  assert.deepEqual(trail.map((a) => a.seq), [...trail.map((a) => a.seq)].sort((x, y) => x - y), 'and the lines stand in the order they were written');
  for (let i = 1; i < trail.length; i++) assert.equal(trail[i].prev_hash, trail[i - 1].hash, 'each line is chained to the one before it');
  // The signed copy was built once, and holds what both of them typed.
  const sha = s.db.get('SELECT final_sha256 h FROM envelopes WHERE id=?', e.id).h;
  assert.match(sha, /^[0-9a-f]{64}$/);
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages(pdf.data)).join(' ').replace(/\s+/g, ' ');
  for (const x of signers) assert.ok(text.includes(x.values[x.f.text]), `the signed PDF prints what ${x.p.name} typed`);
  return { e, signers, sender: c };
}

test('two signers of one envelope finish at the same moment on two addresses, and nothing of either is lost', async () => {
  const { e, signers, sender } = await finishTogether('twoaddr', ['ana-twoaddr@example.com', 'bob-twoaddr@example.com']);
  // Each gets one completion email, with their own link.
  for (const x of signers) {
    const mails = mailTo(x.p.email).filter((m) => m.subject.startsWith('Completed: '));
    assert.equal(mails.length, 1, `${x.p.name} gets one completion email`);
    assert.ok(mails[0].link.endsWith(`/sign/${x.token}`), 'with their own link');
  }
  assert.equal(mailTo('rhea-twoaddr@example.com').filter((m) => m.subject.startsWith('Completed: ')).length, 1, 'and the sender is told once');
  assert.equal(e.recipients.length, 2);
  assert.equal((await sender.get(`/envelopes/${e.id}`)).data.envelope.recipients.every((r: any) => r.status === 'completed'), true);
});

test('two people who share one email address finish at the same moment, each with their own link, signature and copy', async () => {
  const { signers } = await finishTogether('shared', ['family-shared@example.com', 'family-shared@example.com']);
  const mails = mailTo('family-shared@example.com').filter((m) => m.subject.startsWith('Completed: '));
  assert.equal(mails.length, 2, 'one completion email for each of them, at the one address');
  assert.deepEqual(mails.map((m) => m.link.split('/sign/')[1]).sort(), signers.map((x) => x.token).sort(), 'each with that person\'s own link');
  for (const x of signers) assert.ok(mails.some((m) => m.html.includes(`For ${x.p.name}`)), `one of them says it is for ${x.p.name}`);
});

test('when signatures are counted, two people finishing together use one each: never two for one, never one for two', async () => {
  await counting(async () => {
    const { e, signers } = await finishTogether('ledger', ['ana-ledger@example.com', 'ana-ledger@example.com']);
    const used = s.db.all("SELECT ref, delta FROM credits WHERE account_id=? AND reason='signature' ORDER BY ref", e.account_id ?? s.db.get('SELECT account_id a FROM envelopes WHERE id=?', e.id).a);
    assert.equal(used.length, 2);
    assert.deepEqual(used.map((u: any) => u.delta), [-1, -1]);
    assert.deepEqual(used.map((u: any) => u.ref).sort(), signers.map((x) => `${x.r.id}|${x.p.email}`).sort());
    const acct = s.db.get('SELECT account_id a FROM envelopes WHERE id=?', e.id).a;
    assert.equal(s.db.get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', acct).n, 1, '3 to start with, 2 used');
  });
});

test('a late autosave from one of them that crosses both Finish requests changes nothing that was signed', async () => {
  const c = await signUp('Rhea Crossing', 'rhea-crossing@example.com', ip());
  const file = await upload(c, 1);
  const made = await c.post('/envelopes', {
    subject: 'Listing agreement', ordered: false, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Ana Crossing', email: 'ana-crossing@example.com' }, { id: 'b', role: 'signer', name: 'Bob Crossing', email: 'bob-crossing@example.com' }],
    fields: ['a', 'b'].flatMap((p, i) => [
      { id: `sig-${p}`, document_id: 'd', recipient_id: p, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.3, w: 0.3, h: 0.06 },
      { id: `txt-${p}`, document_id: 'd', recipient_id: p, type: 'text', label: 'Price', page: 0, x: 0.1, y: 0.3 + i * 0.3, w: 0.5, h: 0.03 },
    ]),
    send: true,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  const who = (email: string) => {
    const r = e.recipients.find((x: any) => x.email === email);
    const f = Object.fromEntries(e.fields.filter((x: any) => x.recipient_id === r.id).map((x: any) => [x.type, x.id]));
    return { r, f, token: tokenFor(e.id, email), client: new Client() };
  };
  const ana = who('ana-crossing@example.com'), bob = who('bob-crossing@example.com');
  for (const x of [ana, bob]) await x.client.post(`/sign/${x.token}/consent`);
  const finish = (x: any, price: string) => x.client.post(`/sign/${x.token}/complete`, { values: { [x.f.signature]: '1', [x.f.text]: price }, signature_png: PNG });
  const autosave = (x: any, price: string) => x.client.post(`/sign/${x.token}/save`, { values: { [x.f.signature]: '', [x.f.text]: price } });
  // Ana's page saves an older answer (and an empty signature) just as she presses Finish. Bob's does the same.
  const [aDone, aLate, bDone, bLate] = await Promise.all([finish(ana, '410,000'), autosave(ana, '400,000'), finish(bob, '410,000'), autosave(bob, '')]);
  assert.equal(aDone.status, 200, JSON.stringify(aDone.data));
  assert.equal(bDone.status, 200, JSON.stringify(bDone.data));
  for (const late of [aLate, bLate]) assert.notEqual(late.status, 200, 'the save that came second is refused');
  for (const x of [ana, bob]) {
    const kept = Object.fromEntries(s.db.all('SELECT id, value FROM fields WHERE recipient_id=?', x.r.id).map((f: any) => [f.id, f.value]));
    assert.equal(kept[x.f.text], '410,000', 'what was signed stands');
    assert.equal(kept[x.f.signature], '1');
    assert.equal(s.db.get('SELECT signature_png p FROM recipients WHERE id=?', x.r.id).p, PNG);
  }
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.status, 'completed');
});

// ---- F. Filled everything in, never pressed Finish ------------------------------------------------------

test('the sender is shown who filled in everything but has not pressed Finish, and the reminder to that person says one button is left', async () => {
  const c = await signUp('Faye Finish', 'faye-finish@example.com', ip());
  const file = await upload(c, 1);
  const made = await c.post('/envelopes', {
    subject: 'Seller disclosure', ordered: false, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'a', role: 'signer', name: 'Abe Almost', email: 'abe-almost@example.com' },
      { id: 'h', role: 'signer', name: 'Hal Halfway', email: 'hal-halfway@example.com' },
      { id: 'o', role: 'signer', name: 'Opal Optional', email: 'opal-optional@example.com' },
      { id: 'v', role: 'approver', name: 'Vera Approver', email: 'vera-approver@example.com' },
    ],
    fields: [
      ...['a', 'h'].flatMap((p, i) => [
        { id: `sig-${p}`, document_id: 'd', recipient_id: p, type: 'signature', page: 0, x: 0.1, y: 0.1 + i * 0.25, w: 0.3, h: 0.06 },
        { id: `txt-${p}`, document_id: 'd', recipient_id: p, type: 'text', label: 'Year built', page: 0, x: 0.1, y: 0.18 + i * 0.25, w: 0.3, h: 0.03 },
        { id: `yes-${p}`, document_id: 'd', recipient_id: p, type: 'radio', group_name: 'Flooded', label: 'Yes', page: 0, x: 0.5, y: 0.1 + i * 0.25, w: 0.03, h: 0.02 },
        { id: `no-${p}`, document_id: 'd', recipient_id: p, type: 'radio', group_name: 'Flooded', label: 'No', page: 0, x: 0.6, y: 0.1 + i * 0.25, w: 0.03, h: 0.02 },
        { id: `opt-${p}`, document_id: 'd', recipient_id: p, type: 'text', label: 'Anything else', required: false, page: 0, x: 0.5, y: 0.18 + i * 0.25, w: 0.3, h: 0.03 },
      ]),
      { id: 'opt-o', document_id: 'd', recipient_id: 'o', type: 'checkbox', label: 'Send me news', required: false, page: 0, x: 0.1, y: 0.7, w: 0.03, h: 0.02 },
    ],
    send: true,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  const person = (email: string) => {
    const r = e.recipients.find((x: any) => x.email === email);
    const f = Object.fromEntries(e.fields.filter((x: any) => x.recipient_id === r.id).map((x: any) => [`${x.type}:${x.label || ''}`, x.id]));
    return { r, f, token: tokenFor(e.id, email), client: new Client() };
  };
  const abe = person('abe-almost@example.com'), hal = person('hal-halfway@example.com'), opal = person('opal-optional@example.com'), vera = person('vera-approver@example.com');
  const progress = async (x: any) => (await c.get(`/envelopes/${e.id}`)).data.envelope.recipients.find((r: any) => r.id === x.r.id).progress;
  const open = async (x: any) => {
    assert.equal((await x.client.get(`/sign/${x.token}`)).status, 200);
    assert.equal((await x.client.post(`/sign/${x.token}/consent`)).status, 200);
  };

  // Nobody has opened anything: nobody is "ready".
  assert.equal((await progress(abe)).ready, false);
  for (const x of [abe, hal, opal, vera]) await open(x);
  assert.deepEqual(await progress(abe), { fields: 4, filled: 0, required_left: 3, ready: false }, 'opened, nothing filled in');

  // Abe fills in everything that is required, his signature included, and closes the tab. The page saved as he went.
  const all = { [abe.f['signature:']]: '1', [abe.f['text:Year built']]: '1987', [abe.f['radio:No']]: '1' };
  assert.equal((await abe.client.post(`/sign/${abe.token}/save`, { values: all, signature_png: PNG })).status, 200);
  assert.deepEqual(await progress(abe), { fields: 4, filled: 3, required_left: 0, ready: true }, 'everything required is in, and the optional field does not matter');
  // Hal stops half way. Opal has nothing required. Vera approves and has no fields. None of them is "ready".
  assert.equal((await hal.client.post(`/sign/${hal.token}/save`, { values: { [hal.f['text:Year built']]: '2001' } })).status, 200);
  assert.equal((await progress(hal)).ready, false);
  assert.equal((await progress(hal)).required_left, 2);
  assert.equal((await opal.client.post(`/sign/${opal.token}/save`, { values: { [opal.f['checkbox:Send me news']]: '1' } })).status, 200);
  assert.equal((await progress(opal)).ready, false, 'with nothing required there is no "everything" to have filled in');
  assert.equal((await progress(vera)).ready, false);
  assert.equal(s.db.get('SELECT status FROM recipients WHERE id=?', abe.r.id).status, 'viewed', 'and Abe has not signed: saving is not finishing');

  // The reminder to Abe says that one button is left. The one to Hal does not.
  const nudge = (x: any) => c.post(`/envelopes/${e.id}/remind`, { recipient_id: x.r.id });
  assert.equal((await nudge(abe)).data.reminded, 1);
  assert.equal((await nudge(hal)).data.reminded, 1);
  const reminderTo = (email: string) => mailTo(email).filter((m) => m.subject === 'Reminder: Seller disclosure').at(-1)!;
  assert.match(reminderTo('abe-almost@example.com').html, /You filled in everything, and what you filled in is saved\. One step is left: open the document and press Finish\. Until you do, it is not signed and Faye Finish has not received it\./);
  assert.doesNotMatch(reminderTo('hal-halfway@example.com').html, /You filled in everything/);
  // The automatic reminder, three days on, says the same without anybody pressing anything.
  s.db.run('UPDATE envelopes SET sent_at=?, last_reminder_at=? WHERE id=?', days(3.1), days(3.1), e.id);
  const before = mailTo('abe-almost@example.com').length;
  await s.env.cronTick();
  const auto = mailTo('abe-almost@example.com');
  assert.equal(auto.length, before + 1);
  assert.match(auto.at(-1)!.html, /One step is left: open the document and press Finish/);

  // Once he changes an answer so that something required is empty again, it is no longer said.
  assert.equal((await abe.client.post(`/sign/${abe.token}/save`, { values: { ...all, [abe.f['text:Year built']]: '' } })).status, 200);
  assert.equal((await progress(abe)).ready, false);
  assert.equal((await abe.client.post(`/sign/${abe.token}/save`, { values: all })).status, 200);
  // And once he presses Finish it is over.
  assert.equal((await abe.client.post(`/sign/${abe.token}/complete`, { values: all, signature_png: PNG })).status, 200);
  assert.equal((await progress(abe)).ready, false);
  assert.equal(s.db.get('SELECT status FROM recipients WHERE id=?', abe.r.id).status, 'completed');
});

test('the screens say it: Finish asks to be pressed once everything is filled in, and the envelope page names who has not pressed it', async () => {
  const page = read('src/app/sign/[token]/page.tsx');
  // (simplify-signing: no dialog opens by itself any more, research/ux-charter.md P9. Once nothing required is left
  // the main button is Finish, it asks to be pressed once, the line above the pages says what it does, and Finish
  // then signs without a second step unless something needs a look.)
  assert.match(page, /const ready = stage === 'sign' && acts && required\.length > 0 && left\.length === 0 &&(?: also\.left === 0 &&)? allShown;/, 'when nothing required is left');
  assert.match(page, /className=\{`btn go finish\$\{big \? ' sg-big' : ''\}\$\{ready \? ' sg-ready' : ''\}`\}/);
  assert.match(read('src/app/styles/simplesign.css'), /\.btn\.go\.finish\.sg-ready \{ animation: sg-ready/);
  assert.equal((await import('../src/components/sign/actions.ts')).GUIDE_FINISH, 'Everything needed is filled in. Choose Finish to sign and send it.');
  const people = read('src/components/sender/Recipients.tsx');
  assert.match(people, /r\.progress\?\.ready\) return \{ s: 'expired', label: 'Filled in, not finished' \}/);
  assert.match(people, /<b>Filled in everything but has not pressed Finish\.<\/b>/);
  assert.match(read('src/app/app/envelopes/[id]/page.tsx'), /id="sn-almost">.*filled in everything but .* not pressed Finish/);
});

// ---- G. Finding one template among many ---------------------------------------------------------------

test('templates can be searched by any words of their name, role, folder or document, filtered by folder and moved', async () => {
  const owner = await signUp('Tess Templates', 'tess-templates@example.com', ip());
  assert.equal((await owner.post('/account/invites', { email: 'mo-member@example.com', role: 'member' })).status, 200);
  const invite = s.db.get('SELECT token FROM invites WHERE email=?', 'mo-member@example.com').token;
  const member = new Client();
  member.ip = ip();
  assert.equal((await member.post('/auth/signup', { name: 'Mo Member', email: 'mo-member@example.com', password: 'correct horse battery', invite })).status, 200);

  const make = async (c: Client, subject: string, role: string) => {
    const file = await upload(c, 1);
    const r = await c.post('/envelopes', { kind: 'template', subject, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: role }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.envelope;
  };
  const texas = await make(owner, 'Texas, conditional waiver, progress payment', 'Subcontractor');
  const texasFinal = await make(owner, 'Texas, unconditional waiver, final payment', 'Subcontractor');
  const ohio = await make(owner, 'Ohio, conditional waiver, progress payment', 'Supplier');
  const members = await make(member, 'Change order', 'Homeowner');
  const find = async (c: Client, q = '', folder = '') => (await c.get(`/envelopes?kind=template&q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}&limit=200`)).data;
  const names = (d: any) => d.envelopes.map((e: any) => e.subject).sort();

  // One search away: the words in any order, with whatever stands between them.
  assert.deepEqual(names(await find(owner, 'texas progress')), ['Texas, conditional waiver, progress payment']);
  assert.deepEqual(names(await find(owner, 'progress conditional')), ['Ohio, conditional waiver, progress payment', 'Texas, conditional waiver, progress payment']);
  assert.deepEqual(names(await find(owner, 'TEXAS')), ['Texas, conditional waiver, progress payment', 'Texas, unconditional waiver, final payment']);
  assert.deepEqual(names(await find(owner, 'supplier')), ['Ohio, conditional waiver, progress payment'], 'by the name of a role');
  assert.deepEqual(names(await find(owner, 'agreement page')), names(await find(owner)), 'by the words inside the document');
  assert.deepEqual(names(await find(owner, 'texas nowhere')), [], 'every word has to be found');
  assert.equal((await find(owner, texas.id)).envelopes[0].id, texas.id, 'and by its id');
  assert.equal((await find(owner)).envelopes.length, 4, 'templates are the team\'s: the member\'s is listed too');

  // Folders: one for each state. Moving is a change, so it is for the person a template belongs to and for admins.
  assert.equal((await owner.call('PATCH', `/envelopes/${texas.id}`, { folder: 'Texas' })).status, 200);
  assert.equal((await owner.call('PATCH', `/envelopes/${texasFinal.id}`, { folder: ' Texas ' })).status, 200);
  assert.equal((await owner.call('PATCH', `/envelopes/${ohio.id}`, { folder: 'Ohio' })).status, 200);
  assert.equal((await member.call('PATCH', `/envelopes/${ohio.id}`, { folder: 'Mine' })).status, 403, 'a member does not move a colleague\'s template');
  assert.equal((await member.call('PATCH', `/envelopes/${members.id}`, { folder: 'Change orders' })).status, 200, 'and moves their own');
  assert.equal((await owner.call('PATCH', `/envelopes/${members.id}`, { folder: 'Change orders' })).status, 200, 'an admin moves anybody\'s');
  const all = await find(member);
  assert.deepEqual([...all.folders].sort(), ['Change orders', 'Ohio', 'Texas'], 'the folders of templates are shared with the team');
  assert.deepEqual(names(await find(member, '', 'Texas')), ['Texas, conditional waiver, progress payment', 'Texas, unconditional waiver, final payment']);
  assert.deepEqual(names(await find(member, 'final', 'Texas')), ['Texas, unconditional waiver, final payment'], 'search inside a folder');
  assert.deepEqual(names(await find(member, 'ohio')), ['Ohio, conditional waiver, progress payment'], 'the name of a folder is searched too');
  assert.equal(all.envelopes.find((e: any) => e.id === ohio.id).may_change, false);
  assert.equal(all.envelopes.find((e: any) => e.id === members.id).may_change, true);
  // Out of its folder again, and a folder with nothing left in it is gone.
  assert.equal((await owner.call('PATCH', `/envelopes/${ohio.id}`, { folder: '' })).status, 200);
  assert.deepEqual([...(await find(owner)).folders].sort(), ['Change orders', 'Texas']);
  // Folders of templates and folders of envelopes are two lists: an envelope's folder does not show up here.
  const e = await simple(owner, 'client-of-tess@example.com');
  assert.equal((await owner.call('PATCH', `/envelopes/${e.id}`, { folder: 'Clients 2026' })).status, 200);
  assert.deepEqual([...(await find(owner)).folders].sort(), ['Change orders', 'Texas']);
  // The envelope list is searched the same way: every word, in any order.
  const env = (await owner.get(`/envelopes?q=${encodeURIComponent('agreement simple')}`)).data.envelopes;
  assert.deepEqual(env.map((x: any) => x.id), [e.id]);

  const page = read('src/app/app/templates/page.tsx');
  assert.match(page, /aria-label="Search templates"/);
  assert.match(page, /\/envelopes\?kind=template&q=\$\{encodeURIComponent\(view\.q\)\}&folder=\$\{encodeURIComponent\(view\.folder\)\}/, 'the page asks the server, so a search reaches every template and not only the ones on screen');
  assert.match(page, /aria-label="Folder"/);
  assert.match(page, /aria-label=\{`Move \$\{name\} to a folder`\}/);
  assert.match(page, /t\.may_change !== false && <button className="btn sm ghost" onClick=\{\(\) => setMoving\(t\)\}/, 'Move is offered to those who may');
});

// ---- H. Striking out wording --------------------------------------------------------------------------

// Every straight line stroked on a page of a PDF, as [x1, y1, x2, y2] in points from the bottom left corner.
async function strokedLines(bytes: Uint8Array, pageIndex: number): Promise<number[][]> {
  const { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFContentStream, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  const node = doc.getPage(pageIndex).node;
  const contents = node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r: any) => doc.context.lookup(r)) : [contents];
  let text = '';
  for (const st of streams) {
    if (st instanceof PDFRawStream) text += `${Buffer.from(decodePDFRawStream(st).decode()).toString('latin1')}\n`;
    else if (st instanceof PDFContentStream) text += `${Buffer.from((st as any).getUnencodedContents()).toString('latin1')}\n`;
  }
  return [...text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g)].map((m) => m.slice(1, 5).map(Number));
}
const hasLine = (lines: number[][], want: number[]) => lines.some((l) => l.every((v, i) => Math.abs(v - want[i]) < 0.05));

async function withStrike(c: Client, over: any = {}) {
  const file = await upload(c, 1);
  const body = {
    subject: 'Purchase agreement', ordered: false, documents: [{ id: 'd1', file_id: file.id, name: 'Agreement' }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Ada Signer', email: 'ada-strike@example.com' }, { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'ben-strike@example.com' }],
    fields: [
      { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'f2', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.25, h: 0.06 },
      // Given a recipient and marked required on purpose: a strike-out belongs to nobody, whatever a caller sends.
      { id: 's1', document_id: 'd1', recipient_id: 'r1', type: 'strike', required: true, page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
    ],
    ...over,
  };
  const r = await c.post('/envelopes', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

test('the sender can strike out wording: it is shown to every signer, drawn into the signed PDF and written to the audit trail', async () => {
  const c = await signUp('Sol Strike', 'sol-strike@example.com', ip());
  const e = await withStrike(c);
  const strike = e.fields.find((f: any) => f.type === 'strike');
  assert.equal(strike.recipient_id, null, 'it belongs to no recipient');
  assert.equal(strike.readonly, 1, 'and nobody can fill it in');
  assert.ok(!strike.value);
  // It holds no words of its own, and a caller that sends some is told why in a true sentence.
  const worded = await c.put(`/envelopes/${e.id}`, { ...e, fields: e.fields.map((f: any) => (f.id === strike.id ? { ...f, value: 'and the curtains' } : f)) });
  assert.equal(worded.status, 400);
  assert.match(worded.data.error, /a strike field, was sent with a value\. A strike-out is a line through what is printed and holds no words of its own\. Leave "value" out\./);

  // The preview shows the line before anything is sent: one line through the middle of the box.
  const preview = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(preview.status, 200);
  assert.ok(hasLine(await strokedLines(preview.data, 0), [61.2, 625.68, 244.8, 625.68]), 'the preview PDF carries the line');

  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const trail = (await c.get(`/envelopes/${e.id}`)).data.audit;
  const line = trail.find((a: any) => a.action === 'Wording struck out');
  assert.equal(line?.detail, 'The sender struck out wording on page 1 of "Agreement".');

  // Every signer is shown it from the first look, as the sender's mark, whoever they are.
  for (const email of ['ada-strike@example.com', 'ben-strike@example.com']) {
    const seen = (await new Client().get(`/sign/${tokenFor(e.id, email)}`)).data;
    const mark = seen.others.find((f: any) => f.type === 'strike');
    assert.ok(mark, `${email} is shown the strike-out`);
    assert.deepEqual([mark.page, mark.x, mark.y, mark.w, mark.h, mark.from], [0, 0.1, 0.2, 0.3, 0.02, 'sender']);
    assert.equal(seen.fields.some((f: any) => f.type === 'strike'), false, 'and it is not theirs to fill in');
  }
  // It does not count as something a signer has to do.
  const progress = (await c.get(`/envelopes/${e.id}`)).data.envelope.recipients[0].progress;
  assert.deepEqual([progress.fields, progress.required_left], [1, 1]);

  assert.equal((await signAll(e.id, 'ada-strike@example.com')).status, 200);
  assert.equal((await signAll(e.id, 'ben-strike@example.com')).status, 200);
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  assert.ok(hasLine(await strokedLines(pdf.data, 0), [61.2, 625.68, 244.8, 625.68]), 'the signed PDF carries the line');
  // It is a line through the words, not a deletion: the words under it are still in the file.
  const { extractPages } = await import('../src/server/text.ts');
  assert.match((await extractPages(pdf.data))[0], /Agreement page 1/);
});

test('a box over more than one line is crossed out corner to corner, the same on the screen and in the PDF', async () => {
  const { strikeLines, strikeIsCross, strikeClass, strikeSays } = await import('../src/lib/strike.ts');
  assert.deepEqual(strikeLines({ h: 0.02 }), [[0, 0.5, 1, 0.5]]);
  assert.deepEqual(strikeLines({ h: 0.06 }), [[0, 0, 1, 1], [0, 1, 1, 0]]);
  assert.equal(strikeIsCross({ h: 0.035 }), false);
  assert.equal(strikeClass({ type: 'strike', h: 0.02 }), ' strike');
  assert.equal(strikeClass({ type: 'strike', h: 0.06 }), ' strike cross');
  assert.equal(strikeClass({ type: 'note', h: 0.06 }), '');
  const c = await signUp('Xena Cross', 'xena-cross@example.com', ip());
  const e = await withStrike(c, { fields: [
    { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
    { id: 'f2', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.25, h: 0.06 },
    { id: 's1', document_id: 'd1', type: 'strike', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.06 },
  ] });
  const lines = await strokedLines((await c.get(`/envelopes/${e.id}/download`)).data, 0);
  assert.ok(hasLine(lines, [61.2, 633.6, 244.8, 586.08]), 'from the top left to the bottom right');
  assert.ok(hasLine(lines, [61.2, 586.08, 244.8, 633.6]), 'and from the bottom left to the top right');
  // What someone who cannot see the line is told: who drew it and at which printed line, never a guess at the words.
  assert.equal(strikeSays('Sol Strike', 'The seller will leave the garden shed and the curtains.'),
    'Sol Strike struck out wording on this page, at the line that reads: "The seller will leave the garden shed and the curtains.". Which words are struck shows only on the page itself, in the Document view and in the PDF. If you cannot see that, ask Sol Strike which words are meant before you sign.');
  assert.match(strikeSays('Sol Strike'), /^Sol Strike struck out wording on this page\. Which words are struck shows only on the page itself/);
  // The screens draw it from the same rule.
  assert.match(read('src/app/sign/[token]/page.tsx'), /className=\{`field other\$\{isBox\(f\) \? ' box' : ''\}\$\{strikeClass\(f\)\}`\}/);
  assert.match(read('src/components/sign/TextFields.tsx'), /<b>Struck out:<\/b> \{strikeSays\(senderName, near\?\.\(f\)\)\}/);
  assert.match(read('src/components/editor/StepFields.tsx'), /\$\{strikeClass\(f\)\}/);
  assert.match(read('src/components/editor/shared.ts'), /\['strike', 'Strike out', 0\.3, 0\.02\]/);
  assert.match(read('src/app/globals.css'), /\.field\.strike \{/);
  assert.match(read('src/server/pdf.ts'), /for \(const \[x1, y1, x2, y2\] of strikeLines\(f\)\)/);
});

test('a strike-out is printed wording: once someone has signed it is only added, moved or removed if they are asked to sign again', async () => {
  const c = await signUp('Rule Strike', 'rule-strike@example.com', ip());
  // Before anyone has finished, striking out more is a correction like any other: saved, and everyone is told.
  const e = await withStrike(c);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const cur = async () => (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const body = async (fields: (f: any[]) => any[], over: any = {}) => {
    const x = await cur();
    return { subject: x.subject, message: x.message, ordered: x.ordered, documents: x.documents, recipients: x.recipients, fields: fields(x.fields), ...over };
  };
  const more = { id: 's2', document_id: 'd1', type: 'strike', page: 0, x: 0.1, y: 0.3, w: 0.4, h: 0.02 };
  const first = await c.put(`/envelopes/${e.id}`, await body((f) => [...f, { ...more, document_id: f[0].document_id }]));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const told = mailTo('ada-strike@example.com').filter((m) => m.subject.startsWith('Updated: ')).at(-1);
  assert.ok(told, 'a signer who had the document is told');
  assert.match(told!.html, /The sender struck out wording on page 1\./);
  assert.ok((await c.get(`/envelopes/${e.id}`)).data.audit.some((a: any) => /The sender struck out wording on page 1\./.test(a.detail)), 'and the audit trail says what the correction did');

  // Ada finishes. From here every change to a strike-out is a change to what she signed.
  assert.equal((await signAll(e.id, 'ada-strike@example.com')).status, 200);
  const strikes = (await cur()).fields.filter((f: any) => f.type === 'strike');
  assert.equal(strikes.length, 2);
  const tries: [string, (f: any[]) => any[], RegExp][] = [
    ['a new strike-out', (f) => [...f, { id: 's3', document_id: f[0].document_id, type: 'strike', page: 0, x: 0.1, y: 0.4, w: 0.2, h: 0.02 }], /The sender struck out wording on page 1\./],
    ['moving one', (f) => f.map((x) => (x.id === strikes[0].id ? { ...x, y: 0.25 } : x)), /A strike-out was moved or resized on page 1, so other wording is struck out now\./],
    ['making one longer', (f) => f.map((x) => (x.id === strikes[0].id ? { ...x, w: 0.6 } : x)), /A strike-out was moved or resized on page 1/],
    ['removing one', (f) => f.filter((x) => x.id !== strikes[1].id), /A strike-out was removed from page 1, so the wording under it stands again\./],
  ];
  for (const [what, change, says] of tries) {
    const refused = await c.put(`/envelopes/${e.id}`, await body(change));
    assert.equal([refused.status, refused.data.code].join(), '409,sign_again', `${what} is refused without the choice`);
    assert.deepEqual(refused.data.sign_again, ['Ada Signer']);
    assert.match(refused.data.error, says, `${what}: the refusal says what would change`);
  }
  const same = await cur();
  assert.deepEqual(same.fields.filter((f: any) => f.type === 'strike').map((f: any) => [f.id, f.x, f.y, f.w, f.h]), strikes.map((f: any) => [f.id, f.x, f.y, f.w, f.h]), 'nothing was saved');
  assert.equal(same.recipients.find((r: any) => r.email === 'ada-strike@example.com').status, 'completed');

  // With the choice made, it is saved, Ada is asked to sign again and told what changed.
  const again = await c.put(`/envelopes/${e.id}`, await body(tries[3][1], { resign: true }));
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const after = await cur();
  assert.equal(after.fields.filter((f: any) => f.type === 'strike').length, 1);
  assert.notEqual(after.recipients.find((r: any) => r.email === 'ada-strike@example.com').status, 'completed');
  const asked = mailTo('ada-strike@example.com').at(-1)!;
  assert.match(asked.subject, /^Changed after you finished: /);
  assert.match(asked.html, /A strike-out was removed from page 1, so the wording under it stands again\./);
});

test('a strike-out travels with a template, and needs no signer to be placed', async () => {
  const c = await signUp('Tia Template', 'tia-template@example.com', ip());
  const file = await upload(c, 1);
  const tpl = await c.post('/envelopes', {
    kind: 'template', subject: 'Standard lease', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant' }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }, { document_id: 'd', type: 'strike', page: 0, x: 0.2, y: 0.4, w: 0.5, h: 0.02 }],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const made = await c.post('/envelopes', { template_id: tpl.data.envelope.id, recipients: { [tpl.data.envelope.recipients[0].id]: { name: 'Tom Tenant', email: 'tom-tenant@example.com' } } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const strike = made.data.envelope.fields.find((f: any) => f.type === 'strike');
  assert.deepEqual([strike.recipient_id, strike.x, strike.y, strike.w, strike.h], [null, 0.2, 0.4, 0.5, 0.02]);
  // The developer documentation lists the type, and a type that does not exist still names the ones that do.
  const { FIELD_TYPES } = await import('../src/server/envelopes.ts');
  assert.ok(FIELD_TYPES.includes('strike'));
  const bad = await c.post('/envelopes', { subject: 'x', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'A', email: 'a-strike@example.com' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'strikethrough', page: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.02 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /strike/);
});

// ---- I. A link to the sender's own payment page, after Finish --------------------------------------------

// Where the names these tests use lead. The server asks the DNS when a link is saved and when it is shown
// (src/server/paydns.ts), and these tests never reach the network: a name of theirs is answered here, from DNS when it
// is listed and with a public address when it is under one of their own domains. Any other name is handed to the real
// lookup untouched, and none is asked. Put back after the file.
const realLookup = resolver.lookup;
const PUBLIC = '93.184.215.14';
const DNS: Record<string, string[] | 'ENOTFOUND' | 'EAI_AGAIN'> = {};
const ours = (h: string) => /(^|\.)(example\.(com|net|org)|stripe\.com|paypal\.me|square\.link|xn--pypal-4ve\.com)$/.test(h);
before(() => {
  resolver.lookup = async (host: string) => {
    const a = DNS[host] ?? (ours(host) ? [PUBLIC] : null);
    if (!a) return realLookup(host);
    if (typeof a === 'string') throw Object.assign(new Error(a), { code: a });
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
});
after(() => {
  resolver.lookup = realLookup;
});

const trust = async (c: Client) => {
  const a = (await c.get('/me')).data.account;
  s.db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), a.id);
  return a;
};
const payment = (accountId: string, daysAgo: number) =>
  s.db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, applied_at) VALUES (?,?,?,?,?,'plan',?)", `pay_gi_${accountId}_${daysAgo}`, accountId, 900, 'usd', days(daysAgo), days(daysAgo));
async function deal(c: Client, tag: string, over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: `Kitchen refit ${tag}`, ordered: false, documents: [{ id: 'd', file_id: file.id, name: 'Quote' }],
    recipients: [
      { id: 'a', role: 'signer', name: `Ana ${tag}`, email: `ana-${tag}@example.com` },
      { id: 'b', role: 'signer', name: `Bo ${tag}`, email: `bo-${tag}@example.com` },
      { id: 'v', role: 'approver', name: `Vi ${tag}`, email: `vi-${tag}@example.com` },
      { id: 'k', role: 'cc', name: `Kit ${tag}`, email: `kit-${tag}@example.com` },
    ],
    fields: ['a', 'b'].map((p, i) => ({ document_id: 'd', recipient_id: p, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.2, w: 0.3, h: 0.06 })),
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const payOf = async (envelopeId: string, email: string, client = new Client()) => (await client.get(`/sign/${tokenFor(envelopeId, email)}/pay`)).data.pay;

test('a payment link is offered only to an account that has earned trust, and only for an https address of a real site', async () => {
  const c = await signUp('Pia Plumber', 'pia-plumber@example.com', ip());
  const e = await deal(c, 'trust');
  const acct = (await c.get('/me')).data.account;
  const set = (url: string, kind?: string) => c.put(`/envelopes/${e.id}/pay-link`, { url, kind });
  // A new account that has not paid: not offered, and the API refuses it with the reason and the way to get it.
  const first = (await c.get(`/envelopes/${e.id}/pay-link`)).data;
  assert.deepEqual([first.pay_link, first.may], [null, false]);
  assert.match(first.why, /once your account has a payment for the plan or a top-up that is at least 14 days old .* or once a person on the GrowSigning team has cleared it/);
  const refused = await set('https://buy.stripe.com/test_deposit');
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /what scammers want\. Nothing was saved\.$/);
  // Paying yesterday is not enough: nine dollars must not buy a Pay button for a day.
  payment(acct.id, 3);
  assert.equal((await set('https://buy.stripe.com/test_deposit')).status, 403);
  payment(acct.id, 15);
  assert.equal((await c.get(`/envelopes/${e.id}/pay-link`)).data.may, true);

  // Every address that hides where it goes, or goes nowhere a signer can reach, is refused in a sentence.
  const was = process.env.APP_URL;
  process.env.APP_URL = 'https://sign.example.org';
  try {
    const bad: [string, RegExp][] = [
      ['http://pay.example.com/deposit', /has to start with https:\/\//],
      ['javascript:alert(1)', /has to start with https:\/\//],
      ['data:text/html,<b>pay</b>', /has to start with https:\/\//],
      ['pay.example.com/deposit', /is not a web address/],
      ['https://www.paypal.com@pay-me.example.net/x', /a name or a password in front of the @ sign/],
      ['https://203.0.113.5/pay', /a number instead of a name/],
      ['https://localhost/pay', /not a site on the public internet/],
      ['https://intranet/pay', /not a site on the public internet/],
      ['https://pay.example.com:8443/x', /names a port \(:8443\)/],
      ['https://pay.example.com/a b', /a space or an invisible character/],
      ['https://pay.example.com/\u200bx', /a space or an invisible character/],
      [`https://pay.example.com/${'x'.repeat(500)}`, /the most that fits is 500/],
      ['https://sign.example.org/sign/abc', /leads to GrowSigning itself/],
      ['https://pay.example.c0m/x', /does not end in a real domain ending/],
      ['', /Paste the address of your own payment page/],
    ];
    for (const [url, says] of bad) {
      const r = await set(url || ' ');
      assert.equal(r.status, url ? 400 : 200, `${url}: ${JSON.stringify(r.data)}`);
      if (url) assert.match(r.data.error, says, url);
      if (url) assert.match(r.data.error, /Nothing was saved\.$/);
    }
    assert.equal((await set('https://pay.example.com/x', 'invoice')).status, 400, 'the button is one of the fixed few');
  } finally {
    if (was === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = was;
  }
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', e.id).u, null, 'nothing refused was saved');
  // A host in another alphabet is kept, and shown, the way the browser will really open it.
  const look = await set('https://p\u0430ypal.com/deposit', 'retainer');
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.deepEqual([look.data.pay_link.host, look.data.pay_link.label], ['xn--pypal-4ve.com', 'Pay the retainer']);
  const ok = await set('  https://buy.stripe.com/test_deposit  ');
  assert.deepEqual([ok.status, ok.data.pay_link.url, ok.data.pay_link.label], [200, 'https://buy.stripe.com/test_deposit', 'Pay the retainer'], 'the button stays what it was when only the address changes');
  const trail = (await c.get(`/envelopes/${e.id}`)).data.audit.filter((a: any) => /^Payment link/.test(a.action));
  assert.deepEqual(trail.map((a: any) => a.action), ['Payment link added', 'Payment link changed']);
  // The audit trail goes into the certificate, which is emailed: it names each address by a fingerprint, never itself.
  assert.equal(trail[1].detail, `"Pay the retainer" now leads to another payment page Pia Plumber gave (address fingerprint ${payPrint('https://buy.stripe.com/test_deposit')}, before ${payPrint('https://xn--pypal-4ve.com/deposit')}). The address is on the envelope page. It is shown to each person who signs, after they finish, and never put in an email, a certificate or an export. GrowSigning takes no part in the payment.`);
  // Somebody else's envelope is not theirs to set a link on, or to read.
  const other = await signUp('Oz Other', 'oz-other-pay@example.com', ip());
  assert.equal((await other.put(`/envelopes/${e.id}/pay-link`, { url: 'https://evil.example.net/pay' })).status, 404);
  assert.equal((await other.get(`/envelopes/${e.id}/pay-link`)).status, 404);
});

test('the link is shown after Finish, to each person who signs, with the sender\'s name and the full address, and never in an email', async () => {
  const c = await signUp('Gus Builder', 'gus-builder@example.com', ip());
  await trust(c);
  const e = await deal(c, 'shown');
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://buy.stripe.com/gus_deposit', kind: 'deposit' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const ana = 'ana-shown@example.com';
  // Before Finish there is nothing: not in the answer for the pay button, and not anywhere in the signing page's data.
  const before = new Client();
  assert.equal(await payOf(e.id, ana, before), null);
  assert.ok(!JSON.stringify((await before.get(`/sign/${tokenFor(e.id, ana)}`)).data).includes('buy.stripe.com'), 'the signing page does not carry it');
  assert.equal((await signAll(e.id, ana)).status, 200);
  const shown = await payOf(e.id, ana);
  assert.deepEqual(shown, { url: 'https://buy.stripe.com/gus_deposit', host: 'buy.stripe.com', kind: 'deposit', label: 'Pay the deposit', sender: { name: 'Gus Builder', email: 'gus-builder@example.com' }, account: (await c.get('/me')).data.account.name });
  // The tab was closed: the same link, on another device, shows it again. The record says it was shown, once.
  assert.deepEqual(await payOf(e.id, ana), shown);
  const shownLines = (await c.get(`/envelopes/${e.id}`)).data.audit.filter((a: any) => a.action === 'Shown the payment link');
  assert.deepEqual(shownLines.map((a: any) => a.detail), [`Ana shown was shown "Pay the deposit" after finishing (address fingerprint ${payPrint('https://buy.stripe.com/gus_deposit')}).`]);
  // Bo has not finished. The approver and the copy never sign, so they are never asked to pay.
  assert.equal(await payOf(e.id, 'bo-shown@example.com'), null);
  assert.equal((await signAll(e.id, 'vi-shown@example.com')).status, 200);
  assert.equal(await payOf(e.id, 'vi-shown@example.com'), null);
  assert.equal(await payOf(e.id, 'kit-shown@example.com'), null);

  // Pressing it is written down once, and the line says that nobody here knows whether it was paid.
  const press = () => new Client().post(`/sign/${tokenFor(e.id, ana)}/pay-opened`);
  assert.equal((await press()).data.recorded, true);
  assert.equal((await press()).data.recorded, false);
  const opened = (await c.get(`/envelopes/${e.id}`)).data.audit.filter((a: any) => a.action === 'Opened the payment link');
  assert.equal(opened.length, 1);
  assert.match(opened[0].detail, /Whether a payment was made is not known to GrowSigning\.$/);
  assert.equal((await new Client().post(`/sign/${tokenFor(e.id, 'bo-shown@example.com')}/pay-opened`)).data.recorded, false, 'not before they finished');
  // The sender sees who was shown it and who pressed it.
  const seen = (await c.get(`/envelopes/${e.id}/pay-link`)).data.people;
  assert.equal(seen.length, 2, 'the two who sign, not the approver or the copy');
  const anaRow = seen.find((p: any) => p.name === 'Ana shown');
  assert.ok(anaRow.shown_at && anaRow.opened_at);
  assert.deepEqual([seen.find((p: any) => p.name === 'Bo shown').shown_at, seen.find((p: any) => p.name === 'Bo shown').opened_at], [null, null]);

  // Everyone finishes: still there for both of them, and no email about this envelope ever carried the address.
  assert.equal((await signAll(e.id, 'bo-shown@example.com')).status, 200);
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.status, 'completed');
  assert.equal((await payOf(e.id, 'bo-shown@example.com'))?.url, 'https://buy.stripe.com/gus_deposit');
  const mails = s.db.all("SELECT subject, html FROM emails WHERE envelope_id=? OR to_email IN ('gus-builder@example.com')", e.id);
  assert.ok(mails.length >= 6, 'invitations, completions and the sender\'s own emails were written');
  for (const m of mails) assert.ok(!m.html.includes('buy.stripe.com') && !m.html.includes('Pay the deposit'), `"${m.subject}" carries no payment link`);
});

test('trust that goes away takes the link off every screen, a closed envelope asks nobody for money, and a finished one can only lose its link', async () => {
  const c = await signUp('Lou Lawyer', 'lou-lawyer@example.com', ip());
  const acct = await trust(c);
  const e = await deal(c, 'gone');
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://pay.example.com/retainer', kind: 'retainer' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'ana-gone@example.com')).status, 200);
  assert.equal((await payOf(e.id, 'ana-gone@example.com'))?.label, 'Pay the retainer');
  // A person takes the trusted mark away: the link is gone from the signer's screen at once, and the sender is told why.
  s.db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', acct.id);
  assert.equal(await payOf(e.id, 'ana-gone@example.com'), null);
  const why = (await c.get(`/envelopes/${e.id}/pay-link`)).data;
  assert.equal(why.may, false);
  assert.ok(why.pay_link, 'the sender still sees what they set');
  assert.equal((await new Client().post(`/sign/${tokenFor(e.id, 'ana-gone@example.com')}/pay-opened`)).data.recorded, false);
  // A pause, and a disputed card, do the same.
  s.db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acct.id);
  s.db.run("UPDATE accounts SET suspended_at=?, suspended_reason='checking a report' WHERE id=?", new Date().toISOString(), acct.id);
  assert.equal(await payOf(e.id, 'ana-gone@example.com'), null);
  assert.match((await c.get(`/envelopes/${e.id}/pay-link`)).data.why, /^Sending is paused on this account, so its payment links are shown to nobody/);
  s.db.run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL, dispute_at=? WHERE id=?', new Date().toISOString(), acct.id);
  assert.equal(await payOf(e.id, 'ana-gone@example.com'), null);
  s.db.run('UPDATE accounts SET dispute_at=NULL WHERE id=?', acct.id);
  assert.ok(await payOf(e.id, 'ana-gone@example.com'), 'and it is back when the account is in good standing again');

  // Voided after Ana signed: the deal is off, so nobody is asked to pay for it.
  assert.equal((await c.post(`/envelopes/${e.id}/void`, { reason: 'The client chose another firm.' })).status, 200);
  assert.equal(await payOf(e.id, 'ana-gone@example.com'), null);
  // Closed, it can no longer be changed to another address. It can be taken off.
  const change = await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://pay.example.com/other' });
  assert.equal(change.status, 409);
  assert.match(change.data.error, /^This envelope is voided, so its payment link can only be removed now, not added or changed\. Nothing was saved\.$/);
  const off = await c.put(`/envelopes/${e.id}/pay-link`, { url: '' });
  assert.equal(off.status, 200);
  assert.equal(off.data.pay_link, null);
  assert.ok((await c.get(`/envelopes/${e.id}`)).data.audit.some((a: any) => a.action === 'Payment link removed' && a.detail === `"Pay the retainer" (address fingerprint ${payPrint('https://pay.example.com/retainer')}) is no longer shown to anyone.`));
  // Taking a link off is always allowed, also for an account that may not add one: a paused account can clean up.
  s.db.run("UPDATE accounts SET suspended_at=?, suspended_reason='x' WHERE id=?", new Date().toISOString(), acct.id);
  const e2 = await deal(c, 'gone2');
  s.db.run("UPDATE envelopes SET pay_url='https://pay.example.com/old', pay_kind='fee' WHERE id=?", e2.id);
  assert.equal((await c.put(`/envelopes/${e2.id}/pay-link`, { url: 'https://pay.example.com/new' })).status, 403);
  assert.equal((await c.put(`/envelopes/${e2.id}/pay-link`, { url: '' })).status, 200);
});

test('a template\'s link goes with every envelope made from it, and only its owner or an admin changes it', async () => {
  const owner = await signUp('Tom Tutor', 'tom-tutor@example.com', ip());
  await trust(owner);
  assert.equal((await owner.post('/account/invites', { email: 'mia-tutor@example.com', role: 'member' })).status, 200);
  const member = new Client();
  member.ip = ip();
  assert.equal((await member.post('/auth/signup', { name: 'Mia Tutor', email: 'mia-tutor@example.com', password: 'correct horse battery', invite: s.db.get('SELECT token FROM invites WHERE email=?', 'mia-tutor@example.com').token })).status, 200);
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Term enrolment', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Parent' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  assert.equal((await owner.put(`/envelopes/${tpl.id}/pay-link`, { url: 'https://pay.example.com/term-fee', kind: 'fee' })).status, 200);
  assert.equal((await member.put(`/envelopes/${tpl.id}/pay-link`, { url: 'https://pay.example.com/mine' })).status, 403, 'a member does not change a colleague\'s template');
  assert.equal((await member.put(`/envelopes/${tpl.id}/pay-link`, { url: '' })).status, 403, 'or take its link off');
  // A member sending from it: the envelope has the template's link, and its parent is shown it after Finish.
  const made = await member.post('/envelopes', { template_id: tpl.id, recipients: { [tpl.recipients[0].id]: { name: 'Pat Parent', email: 'pat-parent@example.com' } } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const env = made.data.envelope;
  assert.deepEqual([env.pay_url, env.pay_kind], ['https://pay.example.com/term-fee', 'fee']);
  assert.equal((await member.post(`/envelopes/${env.id}/send`)).status, 200);
  assert.equal((await signAll(env.id, 'pat-parent@example.com')).status, 200);
  assert.equal((await payOf(env.id, 'pat-parent@example.com'))?.label, 'Pay the fee');
  // The page it opens is Tom's, who set it on his template, so Tom is the one named as asking (repair: it said Mia).
  assert.equal((await payOf(env.id, 'pat-parent@example.com'))?.sender.name, 'Tom Tutor', 'the person whose payment page it is is named');
});

test('the screens show the payment link only where the rules say, and every page tells the truth about it', async () => {
  const pl = await import('../src/lib/paylink.ts');
  // The signer's screen: after Finish only, for those who sign, with the full address and a button that hands the
  // payment site nothing of the signing link.
  const sign = read('src/app/sign/[token]/page.tsx');
  const done = sign.slice(sign.indexOf("if (stage === 'done')"), sign.indexOf("if (stage === 'pending')"));
  assert.match(done, /\{acts && <PayLink base=\{base\} \/>\}/, 'on the last screen, for someone who signs');
  assert.equal(sign.split('<PayLink ').length, 2, 'and nowhere else on the signing page');
  const card = read('src/components/sign/PayLink.tsx');
  assert.match(card, /api<Answer>\(`\$\{base\}\/pay`\)/, 'the server decides whether there is one');
  assert.match(card, /rel="noopener noreferrer" referrerPolicy="no-referrer"/);
  assert.match(card, /<code id="sg-pay-url"[^>]*>\{pay\.url\}<\/code>/, 'the whole address, before the button');
  assert.match(card, /\{pay\.label\} on \{pay\.host\}/);
  assert.match(card, /payForSigner\(pay\.sender\.name\)/);
  assert.match(card, /payNotUs\(pay\.sender\.name\)/);
  assert.match(pl.payForSigner('Gus'), /your signature does not depend on this payment, and it stays signed whether you pay now, later or not at all/);
  assert.match(pl.payNotUs('Gus'), /^GrowSigning takes no part in this payment\. We do not see what you pay, cannot confirm that it was paid and cannot refund it\./);
  assert.match(pl.payNotUs('Gus'), /If you did not expect to pay Gus anything, do not pay/);
  // The sender's screens: next to the Send button, absent for an account that may not show one, and on the envelope.
  // Not offered on an envelope whose template wording is locked: the link is part of that wording (tests/templates.test.ts).
  // (simplify-editor: the payment link is under More options of the last step, which is absent once the envelope is closed.)
  assert.match(read('src/components/editor/ReviewParts.tsx'), /if \(closed\) return null;/);
  assert.match(read('src/components/editor/ReviewParts.tsx'), /\{!ed\.wording && <PayLinkChoice envelopeId=\{env\.id\} isTpl=\{isTpl\} onChange=/);
  const choice = read('src/components/editor/PayLinkChoice.tsx');
  assert.match(choice, /if \(!envelopeId \|\| !st \|\| \(!st\.may && !st\.pay_link\)\) return null;/, 'no dead control for an account that may not');
  assert.match(choice, /<span>Address of your own payment page<\/span>/);
  assert.match(choice, /<span>The button says<\/span>/);
  assert.match(read('src/app/app/envelopes/[id]/page.tsx'), /<PayLinkNote envelopeId=\{e\.id\} closed=\{/);
  assert.match(read('src/components/sender/PayLinkNote.tsx'), /cannot tell you whether anyone paid/);
  // The pages: /help says when it is offered and what a signer should do, /security lists it under what this is not.
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<QA id="payment-link" q="Can someone pay a deposit when they sign\?">/);
  assert.match(help, /\{payNotYet\(PAID_TRUST_DAYS\)\}/);
  assert.match(read('src/app/security/page.tsx'), /<Point title="No money passes through us\.">GrowSigning never takes money for a sender\./);
  const readme = read('README.md');
  assert.doesNotMatch(readme, /payments collected during signing/, 'the README no longer lists it as missing');
  assert.match(readme, /GrowSigning never holds money: a trusted account can\s+show a link to its own payment page after Finish/);
  // Plain words: no em dash, and no promise about the law.
  for (const t of [pl.payForSigner('X'), pl.payNotUs('X'), pl.PAY_FOR_SENDER, pl.payNotYet(14), ...Object.values(pl.PAY_KINDS), card, choice, read('src/server/routes-paylink.ts')])
    assert.doesNotMatch(t, /\u2014|is valid|will hold up|guarantee/i);
  // The API description lists both calls.
  const { openapi } = await import('../src/server/openapi.ts');
  const p = (openapi() as any).paths['/envelopes/{id}/pay-link'];
  assert.ok(p.get && p.put);
  assert.match(p.put.description, /never put in an email/);
});

// ---- Repairs after the skeptic's report (research/verify-new.json, "verify:industry") ---------------------------

const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);
const flat = (t: string) => t.replace(/\s+/g, '');
const payLines = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data.audit.filter((a: any) => /payment link/i.test(a.action));
const press = (envelopeId: string, email: string, body: any = {}) => new Client().post(`/sign/${tokenFor(envelopeId, email)}/pay-opened`, body);
async function member(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const m = new Client();
  m.ip = ip();
  const j = await m.post('/auth/signup', { name, email, password: 'correct horse battery', invite: s.db.get('SELECT token FROM invites WHERE email=?', email).token });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  return m;
}
async function template(c: Client, subject: string, recipients: any[] = [{ id: 'r', role: 'signer', role_name: 'Client' }]) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', { kind: 'template', subject, documents: [{ id: 'd', file_id: file.id }], recipients,
    fields: recipients.map((x, i) => ({ document_id: 'd', recipient_id: x.id, type: 'signature', page: 0, x: 0.1, y: 0.3 + i * 0.2, w: 0.3, h: 0.06 })) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

test('the payment address is in no email, attached certificate, export or evidence pack: the record names it by a fingerprint', async () => {
  const c = await signUp('Cal Carpenter', 'cal-carpenter@example.com', ip());
  await trust(c);
  const e = await deal(c, 'cert');
  const old = 'https://buy.stripe.com/cal_old_link', url = 'https://buy.stripe.com/cal_cert_deposit';
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: old })).status, 200);
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  // Ana is shown it and presses it before the others finish, so every kind of line is in the certificate.
  assert.equal((await signAll(e.id, 'ana-cert@example.com')).status, 200);
  assert.equal((await payOf(e.id, 'ana-cert@example.com'))?.url, url);
  assert.equal((await press(e.id, 'ana-cert@example.com', { url })).data.recorded, true);
  assert.equal((await signAll(e.id, 'vi-cert@example.com')).status, 200);
  // The completion writes the "Completed" emails with the signed PDF attached. Attachments are kept only with a mail
  // server, so one is named here: a closed port on this machine, which refuses at once and is never reached.
  const was = process.env.SMTP_URL;
  process.env.SMTP_URL = 'smtp://127.0.0.1:9';
  try {
    assert.equal((await signAll(e.id, 'bo-cert@example.com')).status, 200);
  } finally {
    if (was === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = was;
    delete (globalThis as any).__tsmail;
  }
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.status, 'completed');

  // Every line about it in the record, which the certificate prints, names the address by its fingerprint only.
  const lines = await payLines(c, e.id);
  assert.deepEqual(lines.map((a: any) => a.action), ['Payment link added', 'Payment link changed', 'Shown the payment link', 'Opened the payment link']);
  for (const a of lines) assert.doesNotMatch(a.detail, /https?:|stripe|cal_/, a.action);
  for (const a of lines.slice(1)) assert.match(a.detail, new RegExp(`fingerprint ${payPrint(url)}`), a.action);
  assert.equal((await c.get(`/envelopes/${e.id}/pay-link`)).data.pay_link.fingerprint, payPrint(url), 'the envelope page shows the same fingerprint with the address');

  // The attachment of each "Completed" email: to the signers, the approver, the copy and the sender.
  const done = s.db.all("SELECT to_email, payload, html FROM emails WHERE envelope_id=? AND subject LIKE 'Completed%'", e.id);
  assert.deepEqual(done.map((m: any) => m.to_email).sort(), ['ana-cert@example.com', 'bo-cert@example.com', 'cal-carpenter@example.com', 'kit-cert@example.com', 'vi-cert@example.com']);
  const { readBlob } = await import('../src/server/db.ts');
  for (const m of done) {
    const att = JSON.parse(m.payload).attachments;
    assert.equal(att.length, 1, `${m.to_email} got the signed PDF`);
    const t = flat(await pdfText(readBlob(att[0].sha256)));
    assert.match(t, /Paymentlinkadded/, 'the certificate has the lines');
    assert.match(t, new RegExp(payPrint(url)));
    assert.doesNotMatch(t, /stripe|cal_cert|cal_old/, `${m.to_email}: the attached certificate carries no payment address`);
    assert.doesNotMatch(m.html, /stripe/);
  }
  // The copy the cc downloads, the export of the account and the evidence pack (both stored, not compressed).
  assert.doesNotMatch(flat(await pdfText((await new Client().get(`/sign/${tokenFor(e.id, 'kit-cert@example.com')}/download`)).data)), /stripe/);
  const zip = await c.get('/export');
  assert.equal(zip.status, 200);
  assert.ok(Buffer.from(zip.data).includes(payPrint(url)), 'the export has the audit trail');
  assert.ok(!Buffer.from(zip.data).includes('buy.stripe.com'), 'and no payment address');
  const pack = await c.get(`/envelopes/${e.id}/evidence`);
  assert.equal(pack.status, 200);
  assert.ok(Buffer.from(pack.data).includes(payPrint(url)) && !Buffer.from(pack.data).includes('buy.stripe.com'), 'the evidence pack names it by its fingerprint only');
  for (const m of s.db.all('SELECT html FROM emails WHERE envelope_id=? OR to_email=?', e.id, 'cal-carpenter@example.com')) assert.ok(!m.html.includes('stripe'));

  // A line written the way it was before this repair, with the address in it, stays in the record as it was (the
  // chain of hashes holds it), and the certificate that is emailed still leaves the address out.
  const { payLineForPrint } = await import('../src/lib/paylink.ts');
  assert.equal(payLineForPrint('Shown the payment link', 'Ana was shown "Pay", which opens https://buy.stripe.com/x?a=1.'), 'Ana was shown "Pay", which opens [the address, kept on the document page].');
  assert.equal(payLineForPrint('Signed', 'see https://example.com/x'), 'see https://example.com/x', 'other lines are printed as they are');
  const old2 = await simple(c, 'leg-acy@example.com', { send: true });
  const { audit } = await import('../src/server/envelopes.ts');
  audit(old2.id, { name: 'Cal Carpenter' }, 'Payment link changed', '"Pay the deposit" opens https://buy.stripe.com/cal_legacy (it opened https://buy.stripe.com/cal_older before). It is shown to each person who signs.');
  assert.equal((await signAll(old2.id, 'leg-acy@example.com')).status, 200);
  const legacy = flat(await pdfText((await new Client().get(`/sign/${tokenFor(old2.id, 'leg-acy@example.com')}/download`)).data));
  assert.match(legacy, /opens\[theaddress,keptonthedocumentpage\]\(itopened\[theaddress,keptonthedocumentpage\]before\)/);
  assert.doesNotMatch(legacy, /stripe|cal_legacy/);
});

test('a payment link belongs to the person who set it: it goes when they leave the team, the envelope page says so, and the signer sees whose page it is', async () => {
  const owner = await signUp('Olga Owner', 'olga-owner-pay@example.com', ip());
  await trust(owner);
  const max = await member(owner, 'Max Member', 'max-member-pay@example.com');
  const lee = await member(owner, 'Lee Leaver', 'lee-leaver-pay@example.com');
  // Max: a link to his own PayPal on an envelope he sends, and on a template of his, which Olga sends from.
  const e8 = await deal(max, 'hand');
  assert.equal((await max.put(`/envelopes/${e8.id}/pay-link`, { url: 'https://paypal.me/maxpersonal' })).status, 200);
  assert.equal((await max.post(`/envelopes/${e8.id}/send`)).status, 200);
  const maxTpl = await template(max, 'Max booking');
  assert.equal((await max.put(`/envelopes/${maxTpl.id}/pay-link`, { url: 'https://paypal.me/maxtemplate' })).status, 200);
  const fromMax = await owner.post('/envelopes', { template_id: maxTpl.id, recipients: { [maxTpl.recipients[0].id]: { name: 'Fay Frommax', email: 'fay-frommax@example.com' } } });
  assert.equal(fromMax.status, 200, JSON.stringify(fromMax.data));
  assert.equal(fromMax.data.envelope.pay_url, 'https://paypal.me/maxtemplate');
  // Olga's template with her own link, which Max sends from: that page is hers, so it stays when he goes.
  const olgaTpl = await template(owner, 'Olga booking');
  assert.equal((await owner.put(`/envelopes/${olgaTpl.id}/pay-link`, { url: 'https://buy.stripe.com/olga_fee', kind: 'fee' })).status, 200);
  const fromOlga = (await max.post('/envelopes', { template_id: olgaTpl.id, recipients: { [olgaTpl.recipients[0].id]: { name: 'Pat Payer', email: 'pat-payer@example.com' } } })).data.envelope;
  assert.equal((await max.post(`/envelopes/${fromOlga.id}/send`)).status, 200);

  const maxId = (await max.get('/me')).data.user.id;
  assert.equal((await owner.call('DELETE', `/account/members/${maxId}`)).status, 200);
  // His envelope, now Olga's: the signer finishes and is asked for nothing, and nobody is asked under Olga's name.
  assert.equal((await signAll(e8.id, 'ana-hand@example.com')).status, 200);
  assert.equal(await payOf(e8.id, 'ana-hand@example.com'), null);
  const view = (await owner.get(`/envelopes/${e8.id}/pay-link`)).data;
  assert.equal(view.pay_link, null);
  assert.equal(view.gone.note, 'The payment link Max Member set was taken off: Max Member was removed from the team, and a payment link belongs to the person who set it. Nobody is shown it any more.');
  const gone = (await payLines(owner, e8.id)).find((a: any) => a.action === 'Payment link taken off');
  assert.ok(gone, 'the audit trail says so');
  assert.match(gone.detail, new RegExp(`^"Pay the deposit" \\(address fingerprint ${payPrint('https://paypal.me/maxpersonal')}\\) is no longer shown to anyone\\. The payment link Max Member set`));
  assert.doesNotMatch(gone.detail, /paypal/);
  // His template and the envelope Olga made from it lose it too.
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', maxTpl.id).u, null);
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', fromMax.data.envelope.id).u, null);
  // Olga's link on the envelope Max sent from her template stays, and the signer is told it is Olga who asks.
  assert.equal((await signAll(fromOlga.id, 'pat-payer@example.com')).status, 200);
  const p = await payOf(fromOlga.id, 'pat-payer@example.com');
  assert.deepEqual([p?.url, p?.label, p?.sender.name], ['https://buy.stripe.com/olga_fee', 'Pay the fee', 'Olga Owner']);

  // Leaving by oneself does the same.
  const e9 = await deal(lee, 'lee');
  assert.equal((await lee.put(`/envelopes/${e9.id}/pay-link`, { url: 'https://paypal.me/leeleaver' })).status, 200);
  assert.equal((await lee.post(`/envelopes/${e9.id}/send`)).status, 200);
  assert.equal((await lee.post('/account/leave', {})).status, 200);
  assert.match((await owner.get(`/envelopes/${e9.id}/pay-link`)).data.gone.note, /^The payment link Lee Leaver set was taken off: Lee Leaver left the team, and a payment link belongs/);
  // Even where a path forgot to take it off, nobody is asked for money for someone who left.
  s.db.run("UPDATE envelopes SET pay_url='https://paypal.me/leeleaver', pay_kind='deposit' WHERE id=?", e9.id);
  assert.equal((await signAll(e9.id, 'ana-lee@example.com')).status, 200);
  assert.equal(await payOf(e9.id, 'ana-lee@example.com'), null);
  // The envelope page and the editor print the reason.
  assert.match(read('src/components/sender/PayLinkNote.tsx'), /\{st\.gone\.note\}/);
  assert.match(read('src/components/editor/PayLinkChoice.tsx'), /\{st\.gone\.note\}/);
});

test('a link shortener or a forwarding page is refused and says why, and both sides read that the button opens exactly the address shown', async () => {
  for (const u of ['https://bit.ly/3abcdEF', 'https://tinyurl.com/pay-now', 'https://t.co/abc', 'https://go.bit.ly/x', 'https://www.google.com/url?q=https://evil.example.net/pay',
    'https://www.google.co.uk/url?q=x', 'https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example.net', 'https://nam12.safelinks.protection.outlook.com/?url=x', 'https://www.youtube.com/redirect?q=x']) {
    const r: any = checkPayUrl(u, 'sign.example.org');
    assert.match(r.error || '', /is a link shortener or a forwarding page: it shows one name and sends people on to another, so a signer could not see where they would pay\. Use the full address of the payment page itself/, u);
  }
  assert.ok(PAY_SHORTENERS.includes('bit.ly') && PAY_SHORTENERS.includes('tinyurl.com'));
  // A payment provider's own short links lead to its own pages and stay allowed, and so does an ordinary page.
  for (const u of ['https://square.link/u/AbC123', 'https://paypal.me/gusbuilder/50', 'https://buy.stripe.com/test_deposit', 'https://www.google.com/maps/place/x']) assert.ok(!('error' in checkPayUrl(u)), u);
  // Through the API, nothing is saved.
  const c = await signUp('Sid Shortener', 'sid-shortener@example.com', ip());
  await trust(c);
  const e = await deal(c, 'short');
  const r = await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://bit.ly/3abcdEF' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^"bit\.ly" is a link shortener/);
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', e.id).u, null);
  // The length refusal no longer sends anyone to a short link.
  assert.doesNotMatch((checkPayUrl(`https://pay.example.com/${'x'.repeat(600)}`) as any).error, /short link/);
  // An open redirect on the payer's own site cannot be seen from here, so both sides are told what is and is not checked.
  const pl = await import('../src/lib/paylink.ts');
  assert.match(pl.PAY_FOR_SENDER, /The button opens exactly this address, and GrowSigning does not check where that page sends people next, so give the address of the payment page itself, not a short link\./);
  assert.equal(pl.payWhere('Gus'), 'The button opens exactly this address. GrowSigning does not check where that site sends you after that: before you pay, check that the page asking for money belongs to Gus.');
  assert.match(read('src/components/sign/PayLink.tsx'), /<p className="small" id="sg-pay-where"[^>]*>\{payWhere\(pay\.sender\.name\)\}<\/p>/);
  assert.match(read('src/components/sender/PayLinkNote.tsx'), /The button opens exactly this address: GrowSigning does not check where that page sends people next\./);
});

test('a host on a private network or at a special address is refused when the link is saved, and again each time it would be shown', async () => {
  // By name: names kept for private networks, and services that answer with the address written in the name.
  for (const u of ['https://192.168.1.1.nip.io/admin', 'https://127.0.0.1.sslip.io/', 'https://localtest.me/', 'https://app.lvh.me/', 'https://localhost.localdomain/pay', 'https://router.home.arpa/', 'https://nas.alt/', 'https://files.private/'])
    assert.match((checkPayUrl(u) as any).error || '', /is not a site on the public internet/, u);
  for (const u of ['https://*.example.com/', 'https://pay_page.example.com/', 'https://-pay.example.com/']) assert.match((checkPayUrl(u) as any).error || '', /is not a name a site can have/, u);
  // Every special range, and ordinary public addresses.
  for (const a of ['10.1.2.3', '172.16.0.1', '192.168.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:c0a8:101::1', '64:ff9b::a00:1', '::ffff:192.168.1.1', 'not an address']) assert.equal(specialAddress(a), true, a);
  for (const a of [PUBLIC, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) assert.equal(specialAddress(a), false, a);

  // By where the name leads, when it is saved.
  const c = await signUp('Dee Dns', 'dee-dns@example.com', ip());
  await trust(c);
  const e = await deal(c, 'dns');
  Object.assign(DNS, { 'admin.example.net': ['192.168.1.1'], 'meta.example.net': ['169.254.169.254'], 'v6.example.net': ['fd00::5'], 'mixed.example.net': [PUBLIC, '10.0.0.7'],
    'mapped.example.net': ['::ffff:127.0.0.1'], 'gone.example.net': 'ENOTFOUND', 'slow.example.net': 'EAI_AGAIN' });
  const cases: [string, RegExp][] = [
    ['admin.example.net', /^"admin\.example\.net" leads to 192\.168\.1\.1, which is an address inside a private network or kept for special uses, not a site on the public internet\./],
    ['meta.example.net', /leads to 169\.254\.169\.254/], ['v6.example.net', /leads to fd00::5/], ['mixed.example.net', /leads to 10\.0\.0\.7/, ], ['mapped.example.net', /leads to ::ffff:127\.0\.0\.1/],
    ['gone.example.net', /^No site answers at "gone\.example\.net" right now, so a signer could not open it\./], ['slow.example.net', /^We could not check where "slow\.example\.net" leads just now\. Try again in a minute\./],
  ];
  for (const [h, says] of cases) {
    const r = await c.put(`/envelopes/${e.id}/pay-link`, { url: `https://${h}/pay` });
    assert.equal(r.status, 400, h);
    assert.match(r.data.error, says, h);
    assert.match(r.data.error, /Nothing was saved\.$/, h);
  }
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', e.id).u, null);

  // When it would be shown: a name that led to a public site when it was saved, and leads home by now.
  DNS['shift.example.net'] = [PUBLIC];
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://shift.example.net/deposit' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'ana-dns@example.com')).status, 200);
  const mails = () => mailTo('dee-dns@example.com').filter((m: any) => /payment link/i.test(m.subject));
  DNS['shift.example.net'] = ['127.0.0.1'];
  assert.equal(await payOf(e.id, 'ana-dns@example.com'), null, 'not shown');
  assert.equal(await payOf(e.id, 'ana-dns@example.com'), null);
  assert.equal((await press(e.id, 'ana-dns@example.com')).data.recorded, false, 'and pressing records nothing');
  assert.ok(!(await payLines(c, e.id)).some((a: any) => a.action === 'Shown the payment link'));
  assert.match((await c.get(`/envelopes/${e.id}/pay-link`)).data.host_why, /^"shift\.example\.net" leads to 127\.0\.0\.1/, 'the sender sees why on the envelope page');
  // The sender hears it once, in an email without the address or even its host.
  assert.equal(mails().length, 1);
  assert.equal(mails()[0].subject, 'Your payment link is not being shown: Kitchen refit dns');
  assert.match(mails()[0].html, /Its address leads to 127\.0\.0\.1/);
  assert.doesNotMatch(mails()[0].html, /shift\.example|\/deposit/);
  // It leads to a public site again: shown. A later failure is news again.
  DNS['shift.example.net'] = [PUBLIC];
  assert.equal((await payOf(e.id, 'ana-dns@example.com'))?.url, 'https://shift.example.net/deposit');
  DNS['shift.example.net'] = ['10.0.0.1'];
  assert.equal(await payOf(e.id, 'ana-dns@example.com'), null);
  assert.equal(mails().length, 2);
  // A lookup that fails for a moment: not shown, and the signer is told to come back, without anyone being emailed.
  DNS['shift.example.net'] = 'EAI_AGAIN';
  const later = (await new Client().get(`/sign/${tokenFor(e.id, 'ana-dns@example.com')}/pay`)).data;
  assert.equal(later.pay, null);
  assert.equal(later.later, 'Dee Dns also asks for a payment after signing, on their own payment page. We could not check where that page leads just now, so it is not shown yet. Open this page again in a few minutes. You have already finished, and your signature does not depend on it.');
  assert.equal(mails().length, 2);
  DNS['shift.example.net'] = [PUBLIC];
  assert.match(read('src/components/sign/PayLink.tsx'), /if \(!pay\) return got\?\.later \? <p className="notice" role="status">\{got\.later\}<\/p> : null;/);
});

test('after the link changes, the sender sees who was shown and pressed which address, and a press counts only for an address that person was shown', async () => {
  const c = await signUp('Cy Changer', 'cy-changer@example.com', ip());
  await trust(c);
  const e = await deal(c, 'chg');
  const old = 'https://buy.stripe.com/old_link', neu = 'https://pay.example.com/new_link';
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: old })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'ana-chg@example.com')).status, 200);
  assert.equal((await payOf(e.id, 'ana-chg@example.com'))?.url, old);
  assert.equal((await press(e.id, 'ana-chg@example.com', { url: old })).data.recorded, true);
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: neu })).status, 200);
  const view = async () => (await c.get(`/envelopes/${e.id}/pay-link`)).data.people;
  const ana = async () => (await view()).find((p: any) => p.name === 'Ana chg');
  // The new address has not been shown to Ana: her times for the old one stay with the old one.
  let a = await ana();
  assert.deepEqual([a.shown_at, a.opened_at], [null, null]);
  assert.equal(a.earlier.length, 1);
  assert.deepEqual([a.earlier[0].url, a.earlier[0].fingerprint, !!a.earlier[0].shown_at, !!a.earlier[0].opened_at], [old, payPrint(old), true, true]);
  // She comes back and is shown the new one: a new line, with its own fingerprint. She has not pressed it.
  assert.equal((await payOf(e.id, 'ana-chg@example.com'))?.url, neu);
  a = await ana();
  assert.ok(a.shown_at);
  assert.equal(a.opened_at, null);
  assert.equal(s.db.get("SELECT pay_shown_url u FROM recipients WHERE envelope_id=? AND email='ana-chg@example.com'", e.id).u, neu, 'the row says the address she was shown last');
  // A tab left open on the old address records nothing new; an address she was never shown records nothing; the new one does.
  assert.equal((await press(e.id, 'ana-chg@example.com', { url: old })).data.recorded, false);
  assert.equal((await press(e.id, 'ana-chg@example.com', { url: 'https://made-up.example.net/' })).data.recorded, false);
  assert.equal((await press(e.id, 'ana-chg@example.com', { url: neu })).data.recorded, true);
  assert.ok((await ana()).opened_at);
  const shown = (await payLines(c, e.id)).filter((x: any) => x.action === 'Shown the payment link').map((x: any) => x.detail);
  assert.deepEqual(shown, [old, neu].map((u) => `Ana chg was shown "Pay the deposit" after finishing (address fingerprint ${payPrint(u)}).`));
  // Bo presses without ever having been shown it (a request made by hand): nothing is recorded, and his line says so.
  assert.equal((await signAll(e.id, 'bo-chg@example.com')).status, 200);
  assert.equal((await press(e.id, 'bo-chg@example.com')).data.recorded, false);
  const bo = (await view()).find((p: any) => p.name === 'Bo chg');
  assert.deepEqual([bo.shown_at, bo.opened_at, bo.earlier], [null, null, []]);
  await payOf(e.id, 'bo-chg@example.com');
  assert.equal((await press(e.id, 'bo-chg@example.com')).data.recorded, true);
  // Pressed is only what the page could see: the page never says "not pressed", and a middle click counts too.
  const note = read('src/components/sender/PayLinkNote.tsx');
  assert.match(note, /'not recorded as pressed'/);
  assert.doesNotMatch(note, /not pressed yet/);
  assert.match(note, / Earlier shown \$\{x\.url\} \(fingerprint \$\{x\.fingerprint\}\)/);
  assert.match(read('src/components/sign/PayLink.tsx'), /onClick=\{opened\} onAuxClick=\{opened\}/);
});

test('a completed envelope its sender deleted, or one that was voided, asks nobody for money and records no press', async () => {
  const c = await signUp('Del Deleter', 'del-deleter@example.com', ip());
  await trust(c);
  const e = await deal(c, 'del');
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://buy.stripe.com/del_dep' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  for (const who of ['ana-del', 'bo-del', 'vi-del']) assert.equal((await signAll(e.id, `${who}@example.com`)).status, 200);
  assert.ok(await payOf(e.id, 'ana-del@example.com'));
  const del = await c.call('DELETE', `/envelopes/${e.id}`);
  assert.equal(del.data.kept_for_recipients, true, 'the signers keep their copy');
  assert.equal(await payOf(e.id, 'ana-del@example.com'), null);
  assert.equal(await payOf(e.id, 'bo-del@example.com'), null);
  assert.equal((await press(e.id, 'ana-del@example.com')).data.recorded, false);
  // Voided after someone was shown it, from a tab left open: the press is not written down either.
  const v = await deal(c, 'vd');
  assert.equal((await c.put(`/envelopes/${v.id}/pay-link`, { url: 'https://buy.stripe.com/void_dep' })).status, 200);
  assert.equal((await c.post(`/envelopes/${v.id}/send`)).status, 200);
  assert.equal((await signAll(v.id, 'ana-vd@example.com')).status, 200);
  assert.ok(await payOf(v.id, 'ana-vd@example.com'));
  assert.equal((await c.post(`/envelopes/${v.id}/void`, { reason: 'Deal is off' })).status, 200);
  assert.equal((await press(v.id, 'ana-vd@example.com')).data.recorded, false);
  assert.ok(!(await payLines(c, v.id)).some((a: any) => a.action === 'Opened the payment link'));
});

test('the sender, and anyone on the sender\'s team, is never asked to pay: not on their own envelope and not as the countersigner of a public form', async () => {
  const gus = await signUp('Gus Selfsign', 'gus-selfsign@example.com', ip());
  await trust(gus);
  const cleo = await member(gus, 'Cleo Colleague', 'cleo-colleague@example.com');
  assert.ok(cleo);
  const e = await deal(gus, 'self', {
    recipients: [{ id: 'a', role: 'signer', name: 'Ana self', email: 'ana-self@example.com' }, { id: 'g', role: 'signer', name: 'Gus Selfsign', email: 'gus-selfsign@example.com' },
      { id: 'c', role: 'signer', name: 'Cleo Colleague', email: 'CLEO-colleague@example.com' }],
    fields: ['a', 'g', 'c'].map((p, i) => ({ document_id: 'd', recipient_id: p, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.2, w: 0.3, h: 0.06 })),
  });
  assert.equal((await gus.put(`/envelopes/${e.id}/pay-link`, { url: 'https://buy.stripe.com/self_dep' })).status, 200);
  assert.equal((await gus.post(`/envelopes/${e.id}/send`)).status, 200);
  for (const w of ['gus-selfsign', 'cleo-colleague', 'ana-self']) assert.equal((await signAll(e.id, `${w}@example.com`)).status, 200);
  assert.equal(await payOf(e.id, 'gus-selfsign@example.com'), null, 'not the sender');
  assert.equal(await payOf(e.id, 'cleo-colleague@example.com'), null, 'not a colleague, whatever the capital letters');
  assert.equal((await payOf(e.id, 'ana-self@example.com'))?.url, 'https://buy.stripe.com/self_dep', 'the client is');
  assert.deepEqual((await payLines(gus, e.id)).filter((a: any) => a.action === 'Shown the payment link').map((a: any) => a.detail.split(' was ')[0]), ['Ana self']);
  const people = (await gus.get(`/envelopes/${e.id}/pay-link`)).data.people;
  assert.deepEqual(people.map((p: any) => [p.name, p.on_team]), [['Ana self', false], ['Gus Selfsign', true], ['Cleo Colleague', true]]);
  assert.match(read('src/components/sender/PayLinkNote.tsx'), /'not asked, because they are on your team\.'/);

  // A public form whose template has the owner sign for the office: the visitor is shown the link, the owner is not.
  const tpl = await template(gus, 'Booking form', [{ id: 'v', role: 'signer', role_name: 'Client' }, { id: 'o', role: 'signer', role_name: 'Office', name: 'Gus Selfsign', email: 'gus-selfsign@example.com' }]);
  assert.equal((await gus.put(`/envelopes/${tpl.id}/pay-link`, { url: 'https://buy.stripe.com/booking' })).status, 200);
  assert.equal((await gus.post('/powerforms', { template_id: tpl.id, name: 'Book now' })).status, 200);
  const slug = (await gus.get('/powerforms')).data.powerforms.find((p: any) => p.name === 'Book now').slug;
  const vis = new Client();
  vis.ip = ip();
  const st = await vis.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walk-in-pay@example.com' });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const tok = st.data.url.split('/sign/')[1];
  const eid = s.db.get('SELECT envelope_id FROM recipients WHERE token=?', tok).envelope_id;
  assert.equal((await signAll(eid, 'walk-in-pay@example.com')).status, 200);
  assert.equal((await vis.get(`/sign/${tok}/pay`)).data.pay?.url, 'https://buy.stripe.com/booking');
  assert.equal((await signAll(eid, 'gus-selfsign@example.com')).status, 200);
  assert.equal(await payOf(eid, 'gus-selfsign@example.com'), null);
});

test('changing only the button keeps the address, a removal has to be asked for, and the 500 characters are counted as the address is stored', async () => {
  const c = await signUp('Kit Kinder', 'kit-kinder@example.com', ip());
  await trust(c);
  const e = await deal(c, 'kind');
  const put = (b: any) => c.put(`/envelopes/${e.id}/pay-link`, b);
  const none = await put({ kind: 'fee' });
  assert.equal(none.status, 400, 'nothing to change the button of yet');
  assert.match(none.data.error, /^There is no payment link on this envelope to change\. Send "url" with the address of your own payment page\. Nothing was saved\.$/);
  assert.equal((await put({ url: 'https://buy.stripe.com/kind_dep', kind: 'deposit' })).status, 200);
  const k = await put({ kind: 'fee' });
  assert.equal(k.status, 200);
  assert.deepEqual([k.data.pay_link.url, k.data.pay_link.label], ['https://buy.stripe.com/kind_dep', 'Pay the fee']);
  assert.equal((await payLines(c, e.id)).at(-1).detail, `The button now says "Pay the fee" (it said "Pay the deposit"). The address stays the same (fingerprint ${payPrint('https://buy.stripe.com/kind_dep')}).`);
  assert.equal(s.db.get('SELECT pay_set_by FROM envelopes WHERE id=?', e.id).pay_set_by, (await c.get('/me')).data.user.id);
  assert.equal((await put({ url: null })).data.pay_link, null, 'null takes it off, as asked');
  assert.equal(s.db.get('SELECT pay_url u FROM envelopes WHERE id=?', e.id).u, null);
  // 470 Cyrillic letters are 494 typed characters and 2844 as the browser opens them: refused, with the real count.
  const long: any = checkPayUrl(`https://pay.example.com/${'ж'.repeat(470)}`);
  assert.match(long.error, /^Written out the way a browser opens it, that address is 2844 characters long \(a letter outside the basic Latin alphabet takes up to 6\), and the most that fits is 500\./);
  assert.ok(!('error' in checkPayUrl(`https://pay.example.com/${'ж'.repeat(40)}`)), 'a short address in another alphabet still fits');
});

test('when an account may no longer show its links, its owner and admins are told once, without the address, and again only after one was shown', async () => {
  const c = await signUp('Rae Refund', 'rae-refund-pay@example.com', ip());
  const acct = (await c.get('/me')).data.account;
  const adm = await member(c, 'Ada Admin', 'ada-admin-pay@example.com', 'admin');
  assert.ok(adm);
  s.db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, applied_at) VALUES ('pay_rf_gi', ?, 900, 'usd', ?, 'plan', ?)", acct.id, days(40), days(40));
  const e = await deal(c, 'refund');
  assert.equal((await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://buy.stripe.com/rf' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'ana-refund@example.com')).status, 200);
  assert.ok(await payOf(e.id, 'ana-refund@example.com'));
  const told = (email: string) => mailTo(email).filter((m: any) => m.subject.startsWith('Your payment links are not being shown'));
  // Two unused signatures are refunded from the payment that earned the trust (what routes-billing.ts writes).
  s.db.run('UPDATE payments SET refunded_at=?, refunded_cents=200, credits_refunded=2 WHERE id=?', new Date().toISOString(), 'pay_rf_gi');
  assert.equal(await payOf(e.id, 'ana-refund@example.com'), null);
  for (const who of ['rae-refund-pay@example.com', 'ada-admin-pay@example.com']) {
    assert.equal(told(who).length, 1, who);
    assert.equal(told(who)[0].subject, `Your payment links are not being shown: ${acct.name}`);
    assert.match(told(who)[0].html, /Someone who signed &quot;Kitchen refit refund&quot; was not shown its payment link just now|Someone who signed "Kitchen refit refund" was not shown its payment link just now/);
    assert.match(told(who)[0].html, /at least 14 days old and was not refunded or disputed/);
    assert.doesNotMatch(told(who)[0].html, /stripe/);
  }
  assert.equal(await payOf(e.id, 'ana-refund@example.com'), null);
  assert.equal((await signAll(e.id, 'bo-refund@example.com')).status, 200);
  assert.equal(await payOf(e.id, 'bo-refund@example.com'), null);
  assert.equal(told('rae-refund-pay@example.com').length, 1, 'once, not for every signer');
  // A person clears the account, a link is shown again, and the next time it stops is news again.
  s.db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acct.id);
  assert.ok(await payOf(e.id, 'ana-refund@example.com'));
  s.db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', acct.id);
  assert.equal(await payOf(e.id, 'ana-refund@example.com'), null);
  assert.equal(told('rae-refund-pay@example.com').length, 2);
});

test('bulk sends and public forms say whether people are reminded, and a % or _ typed into the template search is that character', async () => {
  // An account from before reminders were on by default, and a template it made: the batch says reminders are off.
  const old = await signUp('Old Timer', 'old-timer-gi@example.com', ip());
  s.db.run('UPDATE accounts SET default_reminder_days=0 WHERE id=?', (await old.get('/me')).data.account.id);
  const oldTpl = await template(old, 'Old tpl');
  const off = (await old.post('/bulk/check', { template_id: oldTpl.id, rows: [{ Client: { name: 'C one', email: 'c-one-gi@example.com' } }] })).data;
  assert.deepEqual([off.reminder_days, off.reminders], [0, policy.reminderText(0)]);
  const now = await signUp('New Comer', 'new-comer-gi@example.com', ip());
  const tpl = await template(now, 'New tpl');
  const on = (await now.post('/bulk/check', { template_id: tpl.id, rows: [] })).data;
  assert.deepEqual([on.reminder_days, on.reminders], [3, policy.reminderText(3)]);
  // A list longer than a batch takes is counted as it is and refused in the words POST /bulk uses, not counted as 500.
  const big = (await now.post('/bulk/check', { template_id: tpl.id, rows: Array.from({ length: 600 }, (_, i) => ({ Client: { name: `R ${i}`, email: `r-${i}-gi@example.com` } })) })).data;
  assert.equal(big.rows, 600);
  assert.deepEqual(big.refusal, { status: 400, message: 'Send up to 500 envelopes per batch.' });
  assert.equal((await now.post('/bulk', { template_id: tpl.id, rows: Array.from({ length: 600 }, (_, i) => ({ Client: { name: `R ${i}`, email: `r-${i}-gi@example.com` } })) })).data.error, big.refusal.message);
  const bulk = read('src/app/app/bulk/page.tsx');
  assert.match(bulk, /\{listOk && <p className="muted small" id="sn-batch-reminders">\{reminderText\(loaded\.reminder_days\)\}/);
  assert.match(bulk, /aria-describedby=\{listOk \? 'sn-batch-cost sn-batch-reminders' : undefined\}/);
  // A public form: its list says what the envelope each visitor starts does.
  assert.equal((await old.post('/powerforms', { template_id: oldTpl.id, name: 'Old form' })).status, 200);
  assert.equal((await old.get('/powerforms')).data.powerforms[0].reminders, policy.reminderText(0));
  assert.match(read('src/app/app/powerforms/page.tsx'), /\{p\.reminders && <div className="muted small">\{p\.reminders\} That comes from the template\.<\/div>\}/);

  // Template search: % and _ are characters, not "anything".
  const sue = await signUp('Sue Search', 'sue-search-gi@example.com', ip());
  for (const name of ['Texas lien waiver', 'Discount 50% offer', 'Under_score plan']) await template(sue, name);
  const search = async (q: string) => (await sue.get(`/envelopes?kind=template&q=${encodeURIComponent(q)}`)).data.envelopes.map((e: any) => e.subject);
  assert.deepEqual(await search('%'), ['Discount 50% offer']);
  assert.deepEqual(await search('_'), ['Under_score plan']);
  assert.deepEqual(await search('50%'), ['Discount 50% offer']);
  assert.deepEqual(await search('TEXAS'), ['Texas lien waiver']);
  assert.deepEqual(await search('\\'), []);
});

test('"Who can see your documents" names the text message provider where this server sends texts, and the screens hold a long payment address', () => {
  const carries = policy.WHO_CAN_SEE.find((w) => w.who === policy.WHO_CARRIES);
  assert.ok(carries, 'the item is still there');
  assert.match(policy.WHO_CARRIES_TEXTS, /the text message provider carries it too\. That is a one-time code, or a message with the signing link in it, which opens the document for whoever holds it/);
  const page = read('src/app/security/page.tsx');
  assert.match(page, /\{w\.what\}\{textsOn && w\.who === WHO_CARRIES \? WHO_CARRIES_TEXTS : ''\}/, 'said only where texts are on');
  // A host of 150 characters wraps inside the button instead of pushing the signing page sideways on a phone.
  assert.match(read('src/components/sign/PayLink.tsx'), /style=\{\{ whiteSpace: 'normal', minHeight: 44, textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' \}\}/);
  assert.match(read('src/components/sender/PayLinkNote.tsx'), /<ul className="small" style=\{\{ paddingLeft: 18, overflowWrap: 'anywhere' \}\}>/);
});
