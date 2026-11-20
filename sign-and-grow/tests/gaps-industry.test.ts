// What agents, clinics, contractors, HR teams and small firms ran into (research/gaps-partial.json, "industry"):
// pages that promised more than the code does, a bulk send whose price showed up after the Send button, two people
// finishing at the same moment, "filled everything in and never pressed Finish", templates nobody can find among
// fifty, wording that has to be struck out, and money that is due at signing.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, signUp, upload, draft, simple, signAll, tokenFor, mailTo, Client, PNG, type Server } from './helpers.ts';
import * as policy from '../src/lib/policy.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.100.${++n}`;
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
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
  assert.deepEqual(who, ['The people it was sent to, and anyone they pass their link to.', 'The person who sent it.', 'The owner and the admins of the sender\'s account.', 'The people who run this server.', 'The companies that carry it.', 'Nobody else.']);
  const operator = policy.WHO_CAN_SEE[3].what;
  assert.match(operator, /no screen and no function that opens a document/);
  assert.match(operator, /adds no encryption of its own/, 'and it says that the disk is another matter');
  assert.match(operator, /promise by the people who run the server/, 'a rule the software cannot enforce is called a promise');
  const nobody = policy.WHO_CAN_SEE[5].what;
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
  const landing = read('src/app/page.tsx');
  assert.doesNotMatch(landing, /consent forms/i);
  assert.match(landing, /Not for patient forms/);
  // One text, kept once.
  assert.equal(policy.NO_BAA_TITLE, 'Not for patient information.');
  assert.match(policy.NO_BAA_TEXT, /There is no HIPAA business associate agreement \(BAA\) for Sign&Grow/);
  assert.match(policy.NO_BAA_TEXT, /Nobody can sign one with us, on any plan, at any price/);
  assert.match(policy.NO_BAA_TEXT, /do not put protected health information through Sign&Grow/);
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
  const landing = read('src/app/page.tsx');
  assert.doesNotMatch(landing, /Every plan, including free/);
  assert.match(landing, /Send one template to hundreds of people from a spreadsheet\. \$\{BULK_COST_NOTE\}/);
  assert.match(landing, /<li id="bulk-cost"><b>What a bulk send costs\.<\/b> \{BULK_COST_NOTE\}/);
  assert.match(policy.BULK_COST_NOTE, /Each person who signs uses one signature/);
  assert.match(policy.BULK_COST_NOTE, /only goes out when all of its signatures are already in your balance/);
  assert.match(read('src/app/help/page.tsx'), /<b>Bulk send:<\/b> \{BULK_COST_NOTE\}/);
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
  assert.match(read('src/components/editor/StepReview.tsx'), /<ReminderChoice days=\{env\.reminder_days\}/, 'the choice is on the step with the Send button');
  assert.match(read('src/components/editor/ReminderChoice.tsx'), /reminderText\(n\)/);
  assert.match(read('src/app/app/envelopes/[id]/page.tsx'), /id="sn-reminders">\{reminderText\(e\.reminder_days\)\}/, 'and on the envelope');
  assert.match(read('src/app/app/settings/page.tsx'), /id="set-reminders"><b>New envelopes start like this\.<\/b> \{reminderText\(f\.default_reminder_days\)\}/, 'and under Settings');
  const landing = read('src/app/page.tsx');
  assert.doesNotMatch(landing, /Automatic nudges/);
  assert.match(landing, /A new account reminds whoever has not finished by email every \$\{DEFAULT_REMINDER_DAYS\} days/);
  // In-person signing says that it needs a connection.
  assert.match(landing, /standing next to you\. \$\{IN_PERSON_ONLINE\}/);
  assert.match(policy.IN_PERSON_ONLINE, /needs an internet connection from opening the document to pressing Finish/);
});
