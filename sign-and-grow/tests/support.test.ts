// Help requests as real tickets: every request has an owner, a thread, a state the customer can see and a time by
// which a person will have answered, and the product holds itself to that time. Each test here fails without the
// work it describes: the whole life of a request from both sides, the published response times and what happens
// when we are late, reopening, the link that works without a login, who may see what, the operator queue and who
// may work it, the alerts the payment code files, the real median, the limits on the link, and deleting an account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, mailTo, type Server } from './helpers.ts';
// Only here so the payment code can raise one of its own alerts without reaching the network. It stands in for
// api.stripe.com and passes every other call on.
import './stripe-fake.ts';
import { supportFirstReplyHours, supportUrgentReplyHours, supportReachable, supportWarning, SUPPORT_TOPICS, SUPPORT_URGENT_TOPICS, SUPPORT_REOPEN_DAYS, SUPPORT_MEDIAN_MIN, SUPPORT_REPLIES_PER_REQUEST, SUPPORT_REPLIES_PER_ADDRESS, SUPPORT_OTHERS_PER_ADDRESS } from '../src/lib/policy.ts';
import { whenText, standing, replyPromise, spanText, firstName } from '../src/lib/support.ts';

let db: Server['db'];
let cron: Server['cron'];
let billing: Server['billing'];
let maya: Client; // the two people who answer
let ravi: Client;
const realFetch = globalThis.fetch;

const PW = 'correct horse battery';
// Sign-ups, the help form and the link are limited per device address, so everybody here arrives from their own.
let n = 0;
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const row = (ref: string) => db.get('SELECT * FROM support_requests WHERE ref=?', ref);
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const near = (iso: string, hours: number) => Math.abs(Date.parse(iso) - (Date.now() + hours * 3600_000)) < 120_000;
const mails = (email: string, ref: string) => mailTo(email).filter((m) => m.subject.includes(ref));
const ask = async (body: any, c: Client = from()) => {
  const r = await c.post('/public/support', { message: 'Something is wrong and I need a person to look at it.', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as { reference: string; priority: string; due_at: string | null; reply_hours: number | null };
};
// The private link, read from the latest email about the request, as its owner would.
const link = (email: string, ref: string) => {
  const m = mails(email, ref).filter((x) => (x.link || '').includes('/help/request/')).at(-1);
  assert.ok(m, `an email to ${email} about ${ref} carries the link`);
  const [, id, key] = /\/help\/request\/([^/]+)\/([^/?#]+)/.exec(m!.link)!;
  return { id, key, api: `/public/support/ticket/${id}/${key}` };
};
const seen = async (api: string) => (await from().get(api)).data.request;
const act = (op: Client, id: string, body: any) => op.post(`/operator/support/${id}`, body);
const opView = async (op: Client, id: string) => (await op.get(`/operator/support/${id}`)).data.request;
const queue = async (op: Client, filter = '') => (await op.get(`/operator/support${filter ? `?filter=${filter}` : ''}`)).data;

before(async () => {
  ({ db, cron, billing } = await boot());
  delete process.env.SUPPORT_EMAIL;
  process.env.OPERATOR_EMAILS = 'maya@ops.test, Ravi@ops.test';
  maya = await person('Maya Okafor', 'maya@ops.test');
  ravi = await person('Ravi Desk', 'ravi@ops.test');
});
after(() => {
  globalThis.fetch = realFetch;
});

// ---- 5. Honest numbers (first, while the database holds no other requests) ------------------------------------

test('the help page gets the real median time to a first answer, and only when it covers enough requests', async () => {
  const info = async () => (await from().get('/public/support')).data;
  assert.equal((await info()).median, null, 'nothing answered yet: the target only');
  const minutes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const ids: string[] = [];
  for (let i = 0; i < minutes.length; i++) {
    const t = await ask({ email: `stat${i}@cust.test` });
    const id = row(t.reference).id;
    ids.push(id);
    assert.equal((await act(maya, id, { action: 'answer', text: 'Here is how to do that.' })).status, 200);
    // Move the clock: this one was written so many minutes before it was answered.
    db.run('UPDATE support_requests SET at=? WHERE id=?', new Date(Date.parse(db.get('SELECT first_reply_at f FROM support_requests WHERE id=?', id).f) - minutes[i] * 60_000).toISOString(), id);
    if (i === SUPPORT_MEDIAN_MIN - 2) assert.equal((await info()).median, null, `${SUPPORT_MEDIAN_MIN - 1} requests are too few to publish a number`);
  }
  assert.deepEqual((await info()).median, { minutes: 55, count: 10, days: 30, late_now: 0 });
  // A first answer from more than 30 days ago does not count any more, and neither does a request nobody answered.
  db.run('UPDATE support_requests SET first_reply_at=? WHERE id=?', new Date(Date.now() - 31 * 864e5).toISOString(), ids[0]);
  assert.equal((await info()).median, null);
  db.run('UPDATE support_requests SET first_reply_at=? WHERE id=?', new Date().toISOString(), ids[0]);
  await ask({ email: 'stat-open@cust.test' });
  assert.equal((await info()).median.count, 10);
  // An internal note and taking a request are not an answer to the customer.
  const quiet = row((await ask({ email: 'stat-note@cust.test' })).reference).id;
  await act(maya, quiet, { action: 'take' });
  await act(maya, quiet, { action: 'note', text: 'Looked at it, nothing sent yet.' });
  assert.equal(db.get('SELECT first_reply_at f FROM support_requests WHERE id=?', quiet).f, null);
  assert.equal(spanText(55), '55 minutes');
  assert.equal(spanText(200), '3 hours');
});

// ---- 1 to 4. The life of a request ----------------------------------------------------------------------------

test('the whole life of a request, from both sides: asked, taken, a question back, answered, solved', async () => {
  // Lena cannot sign in, so she has no login to read anything with. She writes without one.
  const asked = await ask({ email: 'lena@cust.test', name: 'Lena Locked', topic: 'cannot-log-in', message: 'I cannot get in and my renewal is tomorrow. PRIVATE-WORDS', tz: 'Europe/Berlin' });
  assert.deepEqual(Object.keys(asked).sort(), ['due_at', 'priority', 'reference', 'reply_hours'], 'the answer to the form carries no link: that goes to the mailbox only');
  assert.equal(asked.priority, 'urgent', 'being locked out is urgent');
  assert.ok(near(asked.due_at!, 8) && asked.reply_hours === 8);
  const t = row(asked.reference);
  assert.equal(t.status, 'open');

  // The acknowledgement: the reference, the actual time a person will have answered by in her own time zone, the
  // private link, and plainly that replying by email is not how to add something.
  const ack = mails('lena@cust.test', asked.reference).at(-1)!;
  assert.equal(ack.subject, `We got your message (${asked.reference})`);
  const said = text(ack.html);
  assert.ok(said.includes(`A person will have answered by ${whenText(asked.due_at!, 'Europe/Berlin')}`), said);
  assert.match(said, /by \w+day \d{1,2} \w+, \d\d:\d\d \(Europe\/Berlin time\)/);
  assert.match(said, /within 8 hours of your message, counted in real hours: nights and weekends count too/);
  assert.match(said, /do not reply to this email: a reply does not reach your request/);
  assert.ok(!said.includes('PRIVATE-WORDS'), 'anyone can type any address, so her words are not mailed back');
  assert.doesNotMatch(said, /every dollar plants/, 'and someone who may only have come to sign is sold nothing');
  const l = link('lena@cust.test', asked.reference);
  // The people who answer were told, with the time that was promised. No support address is set, so that is them.
  for (const op of ['maya@ops.test', 'ravi@ops.test']) assert.match(text(mails(op, asked.reference).at(-1)!.html), /Help request .* From Lena Locked <lena@cust\.test>, not logged in\. Urgent\. The customer was told a person will have answered by/);

  // Her view through the link, with no login: where it stands and by when.
  let v = await seen(l.api);
  assert.deepEqual([v.reference, v.status, v.priority, v.owner, v.due_at, v.late], [asked.reference, 'open', 'urgent', null, asked.due_at, false]);
  assert.equal(standing(v, (iso) => whenText(iso)).title, 'Waiting for a person to pick this up');
  assert.deepEqual([v.held, v.thread[0].body], [true, ''], 'the words of a first message from nobody we know are not shown back until a person has read them');

  // Maya takes it. Lena sees a first name and nothing more of her.
  const mine = await act(maya, t.id, { action: 'take' });
  assert.equal(mine.data.request.owner.name, 'Maya Okafor');
  v = await seen(l.api);
  assert.equal(v.owner, 'Maya');
  assert.equal(standing(v, (iso) => whenText(iso)).title, 'Maya is looking at this');
  assert.ok(!JSON.stringify(v).includes('Okafor') && !JSON.stringify(v).includes('ops.test'));

  // An internal note is for operators only.
  assert.equal((await act(maya, t.id, { action: 'note', text: 'INTERNAL-NOTE: card on file ends 4242, do not mention.' })).status, 200);
  assert.ok(!JSON.stringify(await seen(l.api)).includes('INTERNAL-NOTE'));

  // Maya asks something. That is emailed in full, the request waits for Lena, and the clock stops.
  const before = mailTo('lena@cust.test').length;
  assert.equal((await act(maya, t.id, { action: 'ask', text: 'Which address did you sign up with? QUESTION-IN-FULL' })).data.request.status, 'waiting');
  const q = mailTo('lena@cust.test').at(-1)!;
  assert.equal(mailTo('lena@cust.test').length, before + 1);
  assert.equal(q.subject, `We have a question about your request (${asked.reference})`);
  assert.match(text(q.html), /Maya needs one thing from you .*QUESTION-IN-FULL.*the time we promised is paused until we have it.*do not reply to this email/);
  assert.ok(q.link.endsWith(`/help/request/${l.id}/${l.key}`), 'every email about a request carries the same link');
  v = await seen(l.api);
  assert.deepEqual([v.status, v.due_at, v.late, v.held], ['waiting', null, false, false]);
  assert.equal(v.thread[0].body, 'I cannot get in and my renewal is tomorrow. PRIVATE-WORDS', 'a person has read it and written back, so her own words are shown to her now');
  assert.deepEqual(v.thread.at(-1), { from: 'us', kind: 'question', name: 'Maya', at: v.thread.at(-1).at, body: 'Which address did you sign up with? QUESTION-IN-FULL' });
  assert.equal(standing(v, (iso) => whenText(iso)).title, 'Maya asked you a question');

  // Lena answers through the link. The request is ours again with a new time, and its owner is told once.
  const opMails = () => [mailTo('maya@ops.test').length, mailTo('ravi@ops.test').length];
  const [m0, r0] = opMails();
  const replied = await from().post(`${l.api}/reply`, { message: 'It was lena@old-job.test. REPLY-ONE' });
  assert.equal(replied.status, 200);
  assert.equal(replied.data.request.status, 'open');
  assert.ok(near(replied.data.request.due_at, 8), 'her reply starts a new 8 hours');
  assert.deepEqual(opMails(), [m0 + 1, r0], 'the reply goes to whoever has the request');
  assert.match(text(mailTo('maya@ops.test').at(-1)!.html), /Lena Locked replied on request .* From Lena Locked <lena@cust\.test>\. It was lena@old-job\.test\. REPLY-ONE/);
  // More from her while it is waiting for us is added, sends nothing more, and does not move the promised time.
  const again = await from().post(`${l.api}/reply`, { message: 'I also tried the reset link.' });
  assert.equal(again.data.request.due_at, replied.data.request.due_at);
  assert.deepEqual(opMails(), [m0 + 1, r0]);

  // Maya answers. The answer is emailed in full, so nobody has to sign in to read it.
  assert.equal((await act(maya, t.id, { action: 'answer', text: 'I have sent a reset link to lena@old-job.test and to this address. ANSWER-IN-FULL' })).data.request.status, 'answered');
  const a = mailTo('lena@cust.test').at(-1)!;
  assert.equal(a.subject, `An answer to your request (${asked.reference})`);
  assert.match(text(a.html), /Maya answered your request .*ANSWER-IN-FULL.*do not reply to this email.*use the button below\. It works without signing in/);
  v = await seen(l.api);
  assert.deepEqual([v.status, v.due_at], ['answered', null]);
  assert.deepEqual(v.thread.map((m: any) => [m.from, m.kind]), [['you', 'message'], ['us', 'question'], ['you', 'message'], ['you', 'message'], ['us', 'message']]);

  // Lena says it is solved, from the link.
  const done = await from().post(`${l.api}/solved`);
  assert.deepEqual([done.data.request.status, done.data.request.closed_how], ['closed', 'solved']);
  assert.equal(standing(done.data.request, (iso) => whenText(iso)).title, 'Solved');

  // The operators' record: every message, the note, and everything that was done, each with who and when.
  const full = await opView(maya, t.id);
  assert.deepEqual(full.thread.map((m: any) => [m.kind, m.by]), [
    ['customer', 'Lena Locked'], ['event', 'Maya Okafor'], ['note', 'Maya Okafor'], ['question', 'Maya Okafor'], ['customer', 'Lena Locked'], ['event', 'Lena Locked'],
    ['customer', 'Lena Locked'], ['answer', 'Maya Okafor'], ['event', 'Lena Locked']]);
  assert.deepEqual(full.thread.filter((m: any) => m.kind === 'event').map((m: any) => m.body), ['Took it', 'The customer answered our question. The clock runs again', 'The customer marked it as solved']);
  assert.ok(full.thread.every((m: any) => m.by && !Number.isNaN(Date.parse(m.at))));
  assert.deepEqual([full.thread[0].via, full.thread[4].via], ['form', 'link'], 'and how each of her messages came: typed into the form, then through the link from her mailbox');
  assert.equal(full.written, 'not_signed_in');
  assert.ok(full.first_reply_at, 'the first time a person wrote back is kept');
});

test('response times are published, settable and counted in real hours, and a time is in UTC and says so when the zone is unknown', async () => {
  assert.deepEqual([supportFirstReplyHours({}), supportUrgentReplyHours({})], [24, 8]);
  assert.deepEqual([supportFirstReplyHours({ SUPPORT_FIRST_REPLY_HOURS: '12' }), supportUrgentReplyHours({ SUPPORT_URGENT_REPLY_HOURS: '2' })], [12, 2]);
  assert.deepEqual([supportFirstReplyHours({ SUPPORT_FIRST_REPLY_HOURS: 'soon' }), supportFirstReplyHours({ SUPPORT_FIRST_REPLY_HOURS: '-3' })], [24, 24], 'nonsense falls back to the default');
  assert.equal(supportUrgentReplyHours({ SUPPORT_FIRST_REPLY_HOURS: '4' }), 4, 'urgent is never slower than everything else');
  assert.equal(replyPromise(24, 8), 'A person answers within 24 hours, and within 8 hours when you cannot log in, were charged wrongly, or a document is stuck or a deadline is near. These are real hours, counted from the moment you write: nights and weekends count too.');

  const info = (await from().get('/public/support')).data;
  assert.deepEqual(info.reply, { hours: 24, urgent_hours: 8 });
  assert.deepEqual(info.topics, SUPPORT_TOPICS);
  assert.deepEqual(info.urgent_topics, ['cannot-log-in', 'charged-wrongly', 'stuck']);
  // The topic decides: locked out, charged wrongly, a stuck document or a near deadline are urgent. The rest is not.
  for (const topic of SUPPORT_TOPICS) {
    const t = await ask({ email: `topic-${topic}@cust.test`, topic });
    const urgent = SUPPORT_URGENT_TOPICS.includes(topic);
    assert.deepEqual([t.priority, t.reply_hours, near(t.due_at!, urgent ? 8 : 24)], [urgent ? 'urgent' : 'normal', urgent ? 8 : 24, true], topic);
  }
  assert.equal((await ask({ email: 'topic-made-up@cust.test', topic: 'urgent-please' })).priority, 'normal', 'an unknown topic is not a way to jump the queue');

  // No time zone known: the email gives the time in UTC and says that it does.
  const utc = await ask({ email: 'nozone@cust.test' });
  const said = text(mails('nozone@cust.test', utc.reference).at(-1)!.html);
  assert.ok(said.includes(`by ${whenText(utc.due_at!, null)}`));
  assert.match(said, /, \d\d:\d\d UTC \(we do not know your time zone, so this is UTC\)\. That is within 24 hours/);
  assert.equal((await ask({ email: 'badzone@cust.test', tz: 'Mars/Olympus"><script>' })).due_at !== null, true);
  assert.match(text(mailTo('badzone@cust.test').at(-1)!.html), /UTC \(we do not know your time zone/, 'a made-up zone is not printed, it is not known');

  // Someone signed in under their own confirmed address: their zone is the one their browser reported, and they get
  // their own words back, because we know who wrote them.
  const kim = await person('Kim Known', 'kim@cust.test');
  await kim.call('GET', '/me', undefined, { 'x-tz': 'America/New_York' });
  const k = await ask({ topic: 'billing', message: 'Please check my last payment. MY-OWN-WORDS' }, kim);
  const kimSaid = text(mails('kim@cust.test', k.reference).at(-1)!.html);
  assert.match(kimSaid, /\(America\/New York time\)/);
  assert.match(kimSaid, /What you sent us: Please check my last payment\. MY-OWN-WORDS/);

  // The setting changes what is promised from then on, on the page, in the email and on the request.
  process.env.SUPPORT_FIRST_REPLY_HOURS = '48';
  process.env.SUPPORT_URGENT_REPLY_HOURS = '1';
  try {
    assert.deepEqual((await from().get('/public/support')).data.reply, { hours: 48, urgent_hours: 1 });
    const slow = await ask({ email: 'slow@cust.test' });
    assert.ok(near(slow.due_at!, 48));
    assert.match(text(mailTo('slow@cust.test').at(-1)!.html), /within 48 hours of your message/);
    const fast = await ask({ email: 'fast@cust.test', topic: 'stuck' });
    assert.ok(near(fast.due_at!, 1));
    assert.match(text(mailTo('fast@cust.test').at(-1)!.html), /within 1 hour of your message/);
  } finally {
    delete process.env.SUPPORT_FIRST_REPLY_HOURS;
    delete process.env.SUPPORT_URGENT_REPLY_HOURS;
  }
});

test('with nobody to reach, no response time is promised anywhere', async () => {
  const ops = process.env.OPERATOR_EMAILS;
  delete process.env.OPERATOR_EMAILS;
  try {
    assert.equal(supportReachable(), false);
    assert.deepEqual([supportReachable({ SUPPORT_EMAIL: 'help@example.com' }), supportReachable({ OPERATOR_EMAILS: ' , ops@example.com' }), supportReachable({ SUPPORT_EMAIL: 'not an address', OPERATOR_EMAILS: ',' })], [true, true, false]);
    const info = (await from().get('/public/support')).data;
    assert.deepEqual([info.reply, info.median], [null, null]);
    const t = await ask({ email: 'nobody-home@cust.test', topic: 'cannot-log-in' });
    assert.deepEqual([t.due_at, t.reply_hours], [null, null]);
    const said = text(mails('nobody-home@cust.test', t.reference).at(-1)!.html);
    assert.doesNotMatch(said, /will have answered by|within \d+ hours?/);
    assert.match(said, /A person will reply to you Your reference is/);
    const v = await seen(link('nobody-home@cust.test', t.reference).api);
    assert.deepEqual([v.due_at, v.late], [null, false]);
    assert.equal(standing(v, (iso) => whenText(iso)).text, 'A person will read it and answer by email. The answer is shown here too.');
    // Nothing was promised, so nothing is late.
    db.run('UPDATE support_requests SET at=? WHERE ref=?', new Date(Date.now() - 5 * 864e5).toISOString(), t.reference);
    assert.equal((await cron.tick()).support.late, 0);
  } finally {
    process.env.OPERATOR_EMAILS = ops;
  }
  assert.match(supportWarning({ NODE_ENV: 'production' })!, /nobody is emailed when a help request arrives.*No response time is promised/s);
  assert.match(supportWarning({ NODE_ENV: 'production', OPERATOR_EMAILS: 'ops@example.com' })!, /Help requests are emailed to the people in OPERATOR_EMAILS and shown in the operator queue/);
});

test('a late request says so to the customer, the operators are emailed once for it, and the queue shows it first', async () => {
  process.env.SUPPORT_EMAIL = 'help@ops.test';
  try {
    const late = await ask({ email: 'late@cust.test', name: 'Lars Late', topic: 'billing', tz: 'Asia/Tokyo' });
    const urgent = await ask({ email: 'urgent@cust.test', topic: 'charged-wrongly' });
    const normal = await ask({ email: 'normal@cust.test', topic: 'other' });
    const id = row(late.reference).id;
    assert.equal(mails('help@ops.test', late.reference).length, 1, 'with a support address set, a new request is announced there');
    assert.equal(mails('maya@ops.test', late.reference).length, 0);

    // Move the clock: the time a person should have answered by passed an hour ago.
    const due = new Date(Date.now() - 3600_000).toISOString();
    db.run('UPDATE support_requests SET due_at=? WHERE id=?', due, id);
    const l = link('late@cust.test', late.reference);
    let v = await seen(l.api);
    assert.deepEqual([v.late, v.passed_on], [true, false]);
    let says = standing(v, (iso) => whenText(iso));
    assert.equal(says.title, 'We are late with this. Sorry.');
    assert.match(says.text, /We said a person would have answered by .*, and that has not happened\. It is being passed to everyone on the support team\. You do not need to write again\./);

    // The queue: the late one leads, then by the time each is due (urgent ones are due sooner), and both are marked.
    const q = await queue(maya);
    const mineOf = [late.reference, urgent.reference, normal.reference];
    const order = q.requests.filter((r: any) => mineOf.includes(r.reference)).map((r: any) => [r.reference, r.late, r.priority]);
    assert.deepEqual(order, [[late.reference, true, 'normal'], [urgent.reference, false, 'urgent'], [normal.reference, false, 'normal']]);
    assert.equal(q.requests[0].reference, late.reference, 'before everything else in the queue');
    assert.equal(q.counts.late, 1);
    const dues = q.requests.filter((r: any) => r.due_at).map((r: any) => r.due_at);
    assert.deepEqual(dues, [...dues].sort(), 'sorted by the time a person should have answered by');

    // The timer escalates: everyone who answers is emailed, once, and the customer is told plainly.
    assert.equal((await cron.tick()).support.late, 1);
    for (const to of ['help@ops.test', 'maya@ops.test', 'ravi@ops.test']) {
      const m = mails(to, late.reference).filter((x) => x.subject === `Late: help request ${late.reference} has no answer`);
      assert.equal(m.length, 1, to);
      assert.match(text(m[0].html), /From Lars Late <late@cust\.test>, about "Billing or a refund"\. A person should have answered by .* Nobody has taken it\. The customer has been told that we are late/);
    }
    const sorry = mails('late@cust.test', late.reference).at(-1)!;
    assert.equal(sorry.subject, `We are late with your request (${late.reference})`);
    assert.ok(text(sorry.html).includes(`We said a person would have answered by ${whenText(due, 'Asia/Tokyo')}, and that has not happened. Your request has been passed to everyone on the support team and is at the top of their list.`));
    assert.match(text(sorry.html), /You do not need to write again, and you keep your place\. Please do not reply to this email/);
    v = await seen(l.api);
    assert.equal(v.passed_on, true);
    assert.match(standing(v, (iso) => whenText(iso)).text, /It has been passed to everyone on the support team and is at the top of their list\./);
    assert.equal((await from().get('/public/support')).data.median?.late_now ?? 1, 1);

    // Once for each time it is late: the next runs of the timer send nothing.
    const count = () => db.get('SELECT COUNT(*) n FROM emails').n;
    const sent = count();
    assert.equal((await cron.tick()).support.late, 0);
    assert.equal((await cron.tick()).support.late, 0);
    assert.equal(count(), sent);
    assert.ok((await opView(maya, id)).thread.some((m: any) => m.kind === 'event' && m.by === 'Sign&Grow' && /^Late: no answer by the time we promised\. Everyone who answers was emailed \(3\), and the customer was told/.test(m.body)));

    // Somebody has it: the customer is told who, in both places.
    await act(ravi, id, { action: 'take' });
    assert.match(standing(await seen(l.api), (iso) => whenText(iso)).text, /top of their list, and Ravi still has it\./);

    // Answered, then the customer writes back and we are late again: that is a new lateness and is told again.
    await act(ravi, id, { action: 'answer', text: 'Sorry for the wait. Here is the answer.' });
    assert.deepEqual([(await seen(l.api)).late, (await queue(maya)).counts.late], [false, 0]);
    await from().post(`${l.api}/reply`, { message: 'That did not help.' });
    db.run('UPDATE support_requests SET due_at=? WHERE id=?', new Date(Date.now() - 60_000).toISOString(), id);
    assert.equal((await cron.tick()).support.late, 1);
    assert.equal(mails('maya@ops.test', late.reference).filter((x) => x.subject.startsWith('Late:')).length, 2);
    assert.match(text(mails('maya@ops.test', late.reference).at(-1)!.html), /Ravi Desk has it\./);
    assert.match(text(mails('late@cust.test', late.reference).at(-1)!.html), /top of their list\. Ravi still has it\./);
    await act(ravi, id, { action: 'close', text: 'Second answer, and closing.' });
  } finally {
    delete process.env.SUPPORT_EMAIL;
  }
});

test('a reply reopens an answered or closed request, and after 30 days it starts a new one that names the old', async () => {
  const t = await ask({ email: 'reo@cust.test', name: 'Reo Pen', topic: 'sending' });
  const id = row(t.reference).id;
  const l = link('reo@cust.test', t.reference);

  // Nobody closes a request without a written answer, and closing sends that answer.
  const bare = await act(maya, id, { action: 'close' });
  assert.equal(bare.status, 400);
  assert.match(bare.data.error, /Write the answer this request is closed with\. It is emailed to the customer, and nobody closes a request without one\./);
  assert.equal((await act(maya, id, { status: 'closed' })).status, 400, 'the old way of closing is held to the same rule');
  assert.equal(row(t.reference).status, 'open');
  assert.equal((await act(maya, id, { action: 'close', text: 'You can resend from the envelope page. CLOSING-ANSWER' })).data.request.status, 'closed');
  const closed = mails('reo@cust.test', t.reference).at(-1)!;
  assert.equal(closed.subject, `Your request ${t.reference} is closed`);
  assert.match(text(closed.html), /Maya closed your request .*CLOSING-ANSWER.*write back within 30 days: this same request opens again\. After that, what you write there starts a new request that is linked to this one\. Please do not reply to this email/);
  let v = await seen(l.api);
  assert.deepEqual([v.status, v.closed_how, v.thread.at(-1).body], ['closed', 'answered', 'You can resend from the envelope page. CLOSING-ANSWER']);
  assert.ok(near(v.reopen_until, SUPPORT_REOPEN_DAYS * 24));
  assert.match(standing(v, (iso) => whenText(iso)).text, /^Not solved after all\? Reply before .* and this same request opens again\.$/);
  // Once closed, an operator reopens before writing more.
  assert.match((await act(maya, id, { action: 'answer', text: 'One more thing.' })).data.error, /This request is closed\. Reopen it first\./);

  // Within the 30 days a reply opens the same request again, with a new time to answer by.
  db.run('UPDATE support_requests SET closed_at=? WHERE id=?', new Date(Date.now() - 29 * 864e5).toISOString(), id);
  const back = await from().post(`${l.api}/reply`, { message: 'It still does not work.' });
  assert.deepEqual([back.data.request.status, back.data.request.reference, back.data.request.closed_at], ['open', t.reference, null]);
  assert.ok(near(back.data.request.due_at, 24));
  assert.ok((await opView(maya, id)).thread.some((m: any) => m.kind === 'event' && m.body === 'The customer wrote back, so the request is open again (it was closed)'));

  // An answer, then closing it with no new text: the answer already given goes out again with the closing.
  await act(maya, id, { action: 'answer', text: 'Try the copy link button. GIVEN-ANSWER' });
  assert.equal((await act(maya, id, { action: 'close' })).status, 200);
  assert.match(text(mails('reo@cust.test', t.reference).at(-1)!.html), /Maya closed your request Our answer was: Try the copy link button\. GIVEN-ANSWER/);

  // More than 30 days after closing, a reply starts a new request. The old one stays closed and the new one names it.
  db.run('UPDATE support_requests SET closed_at=? WHERE id=?', new Date(Date.now() - 31 * 864e5).toISOString(), id);
  v = await seen(l.api);
  assert.match(standing(v, (iso) => whenText(iso)).text, /closed more than 30 days ago, so a reply now starts a new request that is linked to this one\./);
  const moved = await from().post(`${l.api}/reply`, { message: 'The same problem is back. FOLLOW-UP-WORDS' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.moved, true);
  assert.notEqual(moved.data.reference, t.reference);
  assert.equal(row(t.reference).status, 'closed');
  const fresh = row(moved.data.reference);
  assert.deepEqual([fresh.status, fresh.follows, fresh.email, fresh.topic], ['open', id, 'reo@cust.test', 'sending']);
  // The page is handed the new request's own link, and the mailbox gets it too.
  const nv = (await from().get(moved.data.url.replace('/help/request/', '/public/support/ticket/'))).data.request;
  assert.deepEqual([nv.reference, nv.follows, nv.held, nv.thread[0].body], [moved.data.reference, t.reference, false, 'The same problem is back. FOLLOW-UP-WORDS']);
  assert.match(text(mails('reo@cust.test', moved.data.reference).at(-1)!.html), new RegExp(`Your earlier request ${t.reference} was closed more than 30 days ago, so this is a new one\\. It is linked to the old one`));
  assert.equal(link('reo@cust.test', moved.data.reference).id, fresh.id);
  const op = await opView(maya, fresh.id);
  assert.deepEqual(op.follows, { id, reference: t.reference });
  assert.match(text(mails('maya@ops.test', moved.data.reference).at(-1)!.html), new RegExp(`This continues request ${t.reference}, which was closed on`));

  // Someone signed in under their confirmed address reads the thread and replies under Help, without any link.
  const sia = await person('Sia Signed', 'sia@cust.test');
  const s = await ask({ topic: 'other', message: 'How do I rename a template?' }, sia);
  const sid = row(s.reference).id;
  await act(ravi, sid, { action: 'answer', text: 'Open it and choose Rename. IN-APP-ANSWER' });
  let listed = (await sia.get('/support/mine')).data.requests;
  assert.deepEqual([listed[0].reference, listed[0].status, listed[0].owner, listed[0].can_reply, listed[0].thread.at(-1).body], [s.reference, 'answered', 'Ravi', true, 'Open it and choose Rename. IN-APP-ANSWER']);
  assert.equal((await sia.post(`/support/mine/${sid}/reply`, { message: 'There is no Rename for me.' })).status, 200);
  listed = (await sia.get('/support/mine')).data.requests;
  assert.deepEqual([listed[0].status, near(listed[0].due_at, 24), listed[0].thread.length], ['open', true, 3]);
  assert.equal((await sia.post(`/support/mine/${sid}/solved`)).status, 200);
  assert.deepEqual([row(s.reference).status, row(s.reference).closed_how], ['closed', 'solved']);
});

// ---- 3 and 6. The link, and who sees what ---------------------------------------------------------------------

test('the private link opens one request with the right secret, and nothing with a wrong one or with another request\'s', async () => {
  const a = await ask({ email: 'ann@cust.test', name: 'Ann One', message: 'ANN-WORDS: my template lost its fields.' });
  const b = await ask({ email: 'bob@cust.test', name: 'Bob Two', message: 'BOB-WORDS: I was charged twice.' });
  const la = link('ann@cust.test', a.reference);
  const lb = link('bob@cust.test', b.reference);
  assert.notEqual(la.key, lb.key);

  // Only a fingerprint of the secret is stored. The secret itself is nowhere on the request.
  const stored = db.get('SELECT * FROM support_requests WHERE id=?', la.id);
  assert.equal(stored.secret_hash, crypto.createHash('sha256').update(la.key).digest('hex'));
  assert.ok(!Object.values(stored).includes(la.key));

  assert.equal((await from().get(la.api)).status, 200);
  // A wrong secret, another request's secret, and a request that does not exist all get the same answer.
  const wrong = await from().get(`/public/support/ticket/${la.id}/${la.key.slice(0, -1)}x`);
  const other = await from().get(`/public/support/ticket/${la.id}/${lb.key}`);
  const none = await from().get(`/public/support/ticket/sup_doesnotexist0000/${la.key}`);
  const byRef = await from().get(`/public/support/ticket/${a.reference}/${la.key}`);
  for (const r of [wrong, other, none, byRef]) {
    assert.equal(r.status, 404);
    assert.equal(r.data.error, wrong.data.error);
    assert.equal(r.data.request, undefined);
  }
  assert.match(wrong.data.error, /This link does not open a request\..*open it again from our latest email about your request\. If that does not help, write to us on the help page and give your reference\./);
  // Nor can a wrong secret write to a request or close it.
  assert.equal((await from().post(`/public/support/ticket/${la.id}/${lb.key}/reply`, { message: 'Bob writing into Ann\'s request.' })).status, 404);
  assert.equal((await from().post(`/public/support/ticket/${la.id}/${lb.key}/solved`)).status, 404);
  assert.deepEqual([stored.status, db.get('SELECT COUNT(*) n FROM support_messages WHERE request_id=?', la.id).n], ['open', 0]);

  // The link shows the request and nothing else: no address, no name, no account, no id of anything.
  await act(maya, la.id, { action: 'note', text: 'NOTE-FOR-OPERATORS' });
  await act(maya, la.id, { action: 'answer', text: 'They are back now.' });
  const v = (await from().get(la.api)).data.request;
  assert.deepEqual(Object.keys(v).sort(), ['at', 'closed_at', 'closed_how', 'due_at', 'follows', 'held', 'late', 'owner', 'passed_on', 'priority', 'reference', 'reopen_until', 'status', 'thread', 'topic', 'updated_at']);
  const shown = JSON.stringify(v);
  for (const secret of ['ann@cust.test', 'Ann One', 'NOTE-FOR-OPERATORS', 'Okafor', 'maya@ops.test', la.id, 'BOB-WORDS', 'Took it']) assert.ok(!shown.includes(secret), secret);
  assert.ok(shown.includes('ANN-WORDS'));

  // Someone at the address who never wrote can say so with one click. Nothing more is sent to them.
  const typed = await ask({ email: 'victim@cust.test', message: 'Your refund is waiting. Call +1 888 555 0142 today.' });
  const lv = link('victim@cust.test', typed.reference);
  assert.ok(!JSON.stringify((await from().get(lv.api)).data.request).includes('555'), 'the stranger\'s words are not put on our page for them');
  const no = await from().post(`${lv.api}/solved`, { not_mine: true });
  assert.deepEqual([no.data.request.status, no.data.request.closed_how], ['closed', 'disowned']);
  assert.equal(standing(no.data.request, (iso) => whenText(iso)).title, 'Closed: you told us you did not write this');
  assert.ok((await opView(maya, lv.id)).thread.some((m: any) => m.body === 'The person at this address said they did not write this. Closed, and nothing more is sent to them'));
});

test('a customer never sees internal notes or another customer\'s request, and answers go only to the mailbox they were written to', async () => {
  const amy = await person('Amy First', 'amy@cust.test');
  const ben = await person('Ben Second', 'ben@cust.test');
  const a = await ask({ topic: 'billing', message: 'AMY-WORDS: please look at my invoice.' }, amy);
  const b = await ask({ topic: 'other', message: 'BEN-WORDS: how do folders work?' }, ben);
  const aid = row(a.reference).id;
  await act(maya, aid, { action: 'note', text: 'AMY-NOTE: she is on a free code.' });
  await act(maya, aid, { action: 'answer', text: 'AMY-ANSWER: the invoice is correct.' });

  const amys = JSON.stringify((await amy.get('/support/mine')).data);
  const bens = JSON.stringify((await ben.get('/support/mine')).data);
  assert.ok(amys.includes('AMY-WORDS') && amys.includes('AMY-ANSWER') && !amys.includes('AMY-NOTE') && !amys.includes('BEN-WORDS'));
  assert.ok(bens.includes('BEN-WORDS') && !bens.includes('AMY-'));
  assert.deepEqual((await ben.get('/support/mine')).data.requests.map((r: any) => r.reference), [b.reference]);
  // Ben cannot write into Amy's request or close it, and is told the same as for a request that does not exist.
  const poke = await ben.post(`/support/mine/${aid}/reply`, { message: 'Ben in Amy\'s thread.' });
  assert.equal(poke.status, 404);
  assert.equal(poke.data.error, (await ben.post('/support/mine/sup_nothing/reply', { message: 'Ben in nobody\'s thread.' })).data.error);
  assert.equal((await ben.post(`/support/mine/${aid}/solved`)).status, 404);
  assert.equal(row(a.reference).status, 'answered');
  assert.equal((await from().get('/support/mine')).status, 401);

  // Signed in, but writing under somebody else's address. The answer is written to that mailbox, so the writer is
  // shown what they wrote and where it stands, and nothing of the answer. They cannot carry the thread on either.
  const eve = await person('Eve Typist', 'eve@cust.test');
  const forged = await ask({ email: 'amy@cust.test', topic: 'cannot-log-in', message: 'EVE-WORDS: I am Amy, what card is on my account?' }, eve);
  const fid = row(forged.reference).id;
  assert.equal((await opView(maya, fid)).written, 'signed_in_other', 'the operator is told the writer was not signed in under this address');
  await act(maya, fid, { action: 'answer', text: 'FOR-AMY-ONLY: we never give that out. Use the reset link.' });
  const eves = (await eve.get('/support/mine')).data.requests.find((r: any) => r.reference === forged.reference);
  assert.deepEqual([eves.message, eves.thread, eves.can_reply, eves.status], ['EVE-WORDS: I am Amy, what card is on my account?', null, false, 'answered']);
  assert.ok(!JSON.stringify((await eve.get('/support/mine')).data).includes('FOR-AMY-ONLY'));
  assert.equal((await eve.post(`/support/mine/${fid}/reply`, { message: 'Then send it to eve@cust.test.' })).status, 404);
  // Amy, whose mailbox it is, got the answer by email and sees the request under her own address.
  assert.match(text(mailTo('amy@cust.test').at(-1)!.html), /FOR-AMY-ONLY/);
  assert.ok(JSON.stringify((await amy.get('/support/mine')).data).includes('FOR-AMY-ONLY'));

  // Signing up with somebody's address without confirming it shows nothing that was written to that mailbox.
  const typed = await ask({ email: 'squat@cust.test', message: 'SQUAT-TARGET-WORDS: a question from the real owner.' });
  await act(maya, row(typed.reference).id, { action: 'answer', text: 'SQUAT-ANSWER' });
  const squatter = from();
  assert.equal((await squatter.post('/auth/signup', { name: 'Not Them', email: 'squat@cust.test', password: PW })).status, 200);
  assert.deepEqual((await squatter.get('/support/mine')).data.requests, []);
  assert.equal((await squatter.post(`/support/mine/${row(typed.reference).id}/reply`, { message: 'Let me in.' })).status, 404);
});

// ---- 4. The people who answer ---------------------------------------------------------------------------------

test('the operator routes refuse everyone who is not an operator, and every API key', async () => {
  const t = await ask({ email: 'guarded@cust.test', message: 'GUARDED-WORDS: nobody else should read this.' });
  const id = row(t.reference).id;
  const calls: [string, string, any?][] = [['GET', '/operator/support'], ['GET', `/operator/support/${id}`], ['POST', `/operator/support/${id}`, { action: 'take' }], ['POST', `/operator/support/${id}`, { action: 'close', text: 'Closed by someone who should not.' }], ['POST', `/operator/support/${id}`, { status: 'closed' }]];

  const stranger = await person('Sam Stranger', 'sam@cust.test');
  // Listed as an operator but the address was never confirmed: signing up with a staff address proves nothing.
  const unconfirmed = from();
  process.env.OPERATOR_EMAILS += ',fake-staff@ops.test';
  assert.equal((await unconfirmed.post('/auth/signup', { name: 'Fake Staff', email: 'fake-staff@ops.test', password: PW })).status, 200);
  for (const [method, path, body] of calls) {
    assert.equal((await from().call(method, path, body)).status, 401, `${method} ${path} without a login`);
    for (const who of [stranger, unconfirmed]) {
      const r = await who.call(method, path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.ok(!JSON.stringify(r.data).includes('GUARDED-WORDS'));
    }
  }
  // An operator's own API keys, of either scope, cannot work the queue. That takes a person who is signed in.
  for (const scope of ['send', 'admin']) {
    const key = (await maya.post('/api-keys', { name: `ops ${scope}`, scope })).data.key;
    assert.equal((await new Client().call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` })).status, 200, 'the key itself works');
    for (const [method, path, body] of calls) {
      const r = await Object.assign(new Client(), { ip: ip() }).call(method, path, body, { authorization: `Bearer ${key}` });
      assert.equal(r.status, 403, `${scope} key: ${method} ${path}`);
      assert.match(r.data.error, /An API key cannot work the operator queue\. That needs a person signed in to the app\./);
    }
  }
  // Nor can a customer's key read or answer their own requests: the support routes are for people.
  const key = (await stranger.post('/api-keys', { name: 'integration' })).data.key;
  const mineId = row((await ask({ topic: 'other', message: 'A request of my own, long enough.' }, stranger)).reference).id;
  for (const [method, path, body] of [['GET', '/support/mine'], ['POST', `/support/mine/${mineId}/reply`, { message: 'From a key.' }], ['POST', `/support/mine/${mineId}/solved`, {}]] as [string, string, any?][]) {
    const r = await new Client().call(method, path, body, { authorization: `Bearer ${key}` });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.data.error, /An API key cannot read or answer help requests/);
  }
  const untouched = row(t.reference);
  assert.deepEqual([untouched.status, untouched.owner_id, db.get('SELECT COUNT(*) n FROM support_messages WHERE request_id=?', id).n], ['open', null, 0]);
  process.env.OPERATOR_EMAILS = 'maya@ops.test, Ravi@ops.test';
});

test('the queue: mine, nobody\'s, waiting and all, taking and handing over, and the account next to the request', async () => {
  const pat = await person('Pat Payer', 'pat@cust.test');
  const acc = (await pat.get('/me')).data.account.id;
  const t = await ask({ topic: 'charged-wrongly', message: 'I was charged after I cancelled.' }, pat);
  const id = row(t.reference).id;
  const inFilter = async (op: Client, filter: string) => (await queue(op, filter)).requests.some((r: any) => r.id === id);

  assert.deepEqual([await inFilter(maya, 'open'), await inFilter(maya, 'unowned'), await inFilter(maya, 'mine'), await inFilter(maya, 'waiting'), await inFilter(maya, 'all')], [true, true, false, false, true]);
  const counts = (await queue(maya)).counts;
  await act(maya, id, { action: 'take' });
  assert.deepEqual([await inFilter(maya, 'mine'), await inFilter(maya, 'unowned'), await inFilter(ravi, 'mine')], [true, false, false]);
  assert.deepEqual([(await queue(maya)).counts.mine, (await queue(maya)).counts.unowned], [counts.mine + 1, counts.unowned - 1]);
  assert.deepEqual((await queue(ravi)).operators, [{ id: (await maya.get('/me')).data.user.id, name: 'Maya Okafor', me: false }, { id: (await ravi.get('/me')).data.user.id, name: 'Ravi Desk', me: true }]);

  // Handing over: only to someone who works the queue, and that person is told.
  const raviId = (await ravi.get('/me')).data.user.id;
  const notOp = await act(maya, id, { action: 'assign', to: (await pat.get('/me')).data.user.id });
  assert.equal(notOp.status, 400);
  assert.match(notOp.data.error, /Choose one of the people who work this queue/);
  const handed = await act(maya, id, { action: 'assign', to: raviId, text: 'You know billing better.' });
  assert.equal(handed.data.request.owner.name, 'Ravi Desk');
  const told = mails('ravi@ops.test', t.reference).at(-1)!;
  assert.equal(told.subject, `Request ${t.reference} was handed to you`);
  assert.match(text(told.html), /Maya Okafor handed you request .* It is from Pat Payer <pat@cust\.test>\. A person should have answered by .* Maya Okafor wrote: You know billing better\./);
  assert.deepEqual([await inFilter(ravi, 'mine'), await inFilter(maya, 'mine')], [true, false]);
  assert.equal((await pat.get('/support/mine')).data.requests[0].owner, 'Ravi');

  // Waiting for the customer: out of "waiting for us", into "waiting", still Ravi's.
  await act(ravi, id, { action: 'ask', text: 'On which date was the charge?' });
  assert.deepEqual([await inFilter(ravi, 'open'), await inFilter(ravi, 'waiting'), await inFilter(ravi, 'mine')], [false, true, true]);

  // The account facts, read-only: plan, paused or not, and the last payment.
  let facts = await opView(ravi, id);
  assert.deepEqual([facts.account.id, facts.account.name, facts.account.plan, facts.account.suspended_at, facts.account.last_payment, facts.account.via], [acc, (await pat.get('/me')).data.account.name, 'seedling', null, null, 'written_from']);
  assert.deepEqual([facts.login.name, facts.login.confirmed, facts.written], ['Pat Payer', true, 'own']);
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits) VALUES ('in_old_pat', ?, 900, 'usd', ?, 'plan', 9)", acc, new Date(Date.now() - 40 * 864e5).toISOString());
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits, refunded_cents) VALUES ('in_new_pat', ?, 300, 'usd', ?, 'topup', 3, 100)", acc, new Date().toISOString());
  db.run("UPDATE accounts SET plan='grove', suspended_at=?, suspended_reason='Reports from recipients' WHERE id=?", new Date().toISOString(), acc);
  facts = await opView(ravi, id);
  assert.deepEqual([facts.account.plan, !!facts.account.suspended_at, facts.account.suspended_reason], ['grove', true, 'Reports from recipients']);
  assert.deepEqual([facts.account.last_payment.amount_cents, facts.account.last_payment.kind, facts.account.last_payment.refunded_cents], [300, 'topup', 100]);
  // Put the account back as it was, so the timer in later tests has no made-up payments to act on.
  db.run("UPDATE accounts SET plan='seedling', suspended_at=NULL, suspended_reason=NULL WHERE id=?", acc);
  db.run("DELETE FROM payments WHERE id IN ('in_old_pat', 'in_new_pat')");
  // A request from an address with no login has no account next to it.
  const lone = await opView(ravi, row((await ask({ email: 'no-login@cust.test' })).reference).id);
  assert.deepEqual([lone.login, lone.account], [null, null]);

  // Marking a request urgent can bring the promised time forward. It never moves one later.
  const calm = await ask({ email: 'calm@cust.test', topic: 'other' });
  const cid = row(calm.reference).id;
  const up = await act(maya, cid, { action: 'priority', priority: 'urgent' });
  assert.ok(up.data.request.priority === 'urgent' && near(up.data.request.due_at, 8));
  const down = await act(maya, cid, { action: 'priority', priority: 'normal' });
  assert.deepEqual([down.data.request.priority, down.data.request.due_at], ['normal', up.data.request.due_at]);

  // Someone who stops being an operator has no requests any more: theirs show as nobody's, to both sides.
  process.env.OPERATOR_EMAILS = 'maya@ops.test';
  assert.equal((await opView(maya, id)).owner, null);
  assert.equal((await pat.get('/support/mine')).data.requests[0].owner, null);
  assert.equal((await ravi.get('/operator/support')).status, 404);
  process.env.OPERATOR_EMAILS = 'maya@ops.test, Ravi@ops.test';
  assert.equal((await opView(maya, id)).owner.name, 'Ravi Desk');

  // Every action is in the history with who and when.
  const history = (await opView(maya, id)).thread.filter((m: any) => m.kind === 'event').map((m: any) => [m.by, m.body]);
  assert.deepEqual(history, [['Maya Okafor', 'Took it'], ['Maya Okafor', 'Handed it to Ravi Desk']]);
  const unknown = await act(maya, id, { action: 'delete' });
  assert.equal(unknown.status, 400);
});

test('closing without an answer is only for a request nobody at the address wrote, and even then the address is told', async () => {
  const spam = await ask({ email: 'target@cust.test', message: 'You have won. Call +1 888 555 0199 to claim your prize.' });
  const id = row(spam.reference).id;
  const l = link('target@cust.test', spam.reference);
  const before = mailTo('target@cust.test').length;
  const r = await act(maya, id, { action: 'spam' });
  assert.deepEqual([r.data.request.status, r.data.request.closed_how], ['closed', 'spam']);
  // Not closed without a word: one short note says what happened and how to open it again, and repeats nothing typed.
  assert.equal(mailTo('target@cust.test').length, before + 1);
  const note = mailTo('target@cust.test').at(-1)!;
  assert.equal(note.subject, `We closed request ${spam.reference} without an answer`);
  assert.match(text(note.html), /thought someone else had typed your address, so it was closed without an answer\. If you did not write to us, there is nothing to do\. We will not write to you about it again\. If you did write it, we are sorry\. Use the button below and tell us: the request opens again/);
  assert.ok(!note.html.includes('555') && !note.html.includes('prize'), 'the stranger\'s words reach nobody');
  assert.ok(note.link.endsWith(`/help/request/${l.id}/${l.key}`));
  assert.ok(r.data.request.thread.some((m: any) => m.by === 'Maya Okafor' && m.body === 'Closed as not written by the owner of the address. They were told so, without the text, and how to open it again'));
  // If the address owner did write it after all, they are told what happened and how to open it again.
  const v = await seen(l.api);
  assert.equal(standing(v, (iso) => whenText(iso)).title, 'Closed: this did not look like it came from you');
  assert.ok(!JSON.stringify(v).includes('555'));
  assert.equal((await from().post(`${l.api}/reply`, { message: 'That was really me, sorry for the odd wording.' })).data.request.status, 'open');
  // Now it is known to come from the mailbox, so it cannot be closed without a word again.
  const again = await act(maya, id, { action: 'spam' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /known to come from the owner of the address.*Close it with an answer instead\./);
  // The same for someone who was signed in under their own address.
  const real = await person('Rea Real', 'rea@cust.test');
  const mineId = row((await ask({ topic: 'other', message: 'A real question from a real person.' }, real)).reference).id;
  assert.equal((await act(maya, mineId, { action: 'spam' })).status, 400);
  // Empty answers, questions and notes are refused with what to do.
  for (const action of ['answer', 'ask', 'note']) assert.match((await act(maya, mineId, { action, text: ' ' })).data.error, /^Write the (answer|question|note) first\./);
});

test('the payment problems the software files itself still appear in the queue, and are closed with a note, not an email', async () => {
  // A payment that names an account this server never had: the payment code tells the operators (tellOperators).
  await billing.applyStripeEvent({ type: 'invoice.paid', data: { object: { id: 'in_support_test', customer: 'cus_support', subscription: 'sub_support', amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_grove' }, metadata: { sg_account: 'acc_from_another_server' } }] } } } });
  const filed = db.get("SELECT * FROM support_requests WHERE topic='billing' AND message LIKE '%in_support_test%'");
  assert.ok(filed, 'the alert was filed as a request');
  const q = await queue(maya);
  const listed = q.requests.find((r: any) => r.id === filed.id);
  assert.ok(listed, 'and is in the queue');
  assert.deepEqual([listed.alert, listed.status, listed.due_at, listed.late, listed.name], [true, 'open', null, false, 'Sign&Grow (automatic alert)']);
  assert.match(listed.message, /could not be matched/);
  assert.ok((await queue(maya, 'unowned')).requests.some((r: any) => r.id === filed.id) && (await queue(maya, 'all')).requests.some((r: any) => r.id === filed.id));
  // It comes after the requests a time was promised for, and is never late: no customer is waiting on it.
  const firstNoDue = q.requests.findIndex((r: any) => !r.due_at);
  assert.ok(q.requests.slice(firstNoDue).every((r: any) => !r.due_at));
  db.run('UPDATE support_requests SET at=? WHERE id=?', new Date(Date.now() - 9 * 864e5).toISOString(), filed.id);
  assert.equal((await cron.tick()).support.late, 0);

  // Nobody is emailed "an answer" to an alert, and it is not somebody's request under Help.
  const emails = db.get('SELECT COUNT(*) n FROM emails').n;
  for (const action of ['answer', 'ask', 'spam']) assert.match((await act(maya, filed.id, { action, text: 'Dear alert' })).data.error, /an alert the software filed by itself\. Nobody is waiting for an email about it/);
  assert.deepEqual((await maya.get('/support/mine')).data.requests.filter((r: any) => r.topic === 'billing' && /could not be matched/.test(r.message)), []);
  assert.equal((await from().get(`/public/support/ticket/${filed.id}/anything`)).status, 404);
  // Take it, note what was found, close it with a note that says what was done.
  assert.equal((await act(maya, filed.id, { action: 'take' })).data.request.owner.name, 'Maya Okafor');
  assert.match((await act(maya, filed.id, { action: 'close' })).data.error, /Write a note that says what was done about this alert/);
  const closed = await act(maya, filed.id, { action: 'close', text: 'Belongs to the staging server. Refunded by hand there.' });
  assert.deepEqual([closed.data.request.status, closed.data.request.thread.at(-2).kind, closed.data.request.thread.at(-2).body], ['closed', 'note', 'Belongs to the staging server. Refunded by hand there.']);
  assert.equal(db.get('SELECT COUNT(*) n FROM emails').n, emails);
  assert.ok(!(await queue(maya)).requests.some((r: any) => r.id === filed.id) && (await queue(maya, 'all')).requests.some((r: any) => r.id === filed.id));
  // Typing the alert's name into the form does not make a customer's request an alert.
  const posing = await ask({ email: 'poser@cust.test', name: 'Sign&Grow (automatic alert)', topic: 'billing' });
  assert.equal((await opView(maya, row(posing.reference).id)).alert, false);
  // The old queue call still lists what is waiting, for anything that reads it.
  assert.ok((await maya.get('/operator/queue')).data.support.some((s: any) => s.ref === posing.reference));
});

// ---- 6. Limits and privacy ------------------------------------------------------------------------------------

test('the link cannot be used to flood the people who answer: a limit for each request and for each address', async () => {
  const t = await ask({ email: 'flood@cust.test', message: 'The first message, which is long enough.' });
  const l = link('flood@cust.test', t.reference);
  await act(maya, row(t.reference).id, { action: 'answer', text: 'An answer, so the next reply reopens it.' });
  const opMails = mailTo('maya@ops.test').length;
  for (let i = 0; i < SUPPORT_REPLIES_PER_REQUEST; i++) assert.equal((await from().post(`${l.api}/reply`, { message: `Reply number ${i + 1}.` })).status, 200, `reply ${i + 1}`);
  const over = await from().post(`${l.api}/reply`, { message: 'One too many.' });
  assert.equal(over.status, 429);
  assert.match(over.data.error, /You have added 10 messages to this request in the last 24 hours, and we have them all\. A person reads everything you sent\. You can add more tomorrow\./);
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE request_id=? AND kind='customer'", l.id).n, SUPPORT_REPLIES_PER_REQUEST);
  assert.equal(mailTo('maya@ops.test').length, opMails + 1, 'ten replies, one email to the operator who has it: the request was already back on the list');
  // A day later there is room again.
  db.run("UPDATE support_messages SET at=? WHERE request_id=? AND kind='customer'", new Date(Date.now() - 25 * 3600_000).toISOString(), l.id);
  db.run('UPDATE support_requests SET at=? WHERE id=?', new Date(Date.now() - 26 * 3600_000).toISOString(), l.id);
  assert.equal((await from().post(`${l.api}/reply`, { message: 'The next day.' })).status, 200);
  assert.equal((await from().post(`${l.api}/reply`, { message: '' })).status, 400);

  // Across requests typed by people who are not signed in under the address: a small allowance for each address,
  // whichever device they come from, so the form cannot fill a stranger's inbox. (Changed on purpose: this used to
  // be 30 a day shared with the owner of the address, which let a stranger shut the owner out. See the tests about
  // strangers further down.)
  let made = 0;
  for (;;) {
    const r = await from().post('/public/support', { email: 'Bomb@cust.test', message: 'Another request to the same address.' });
    if (r.status !== 200) {
      assert.deepEqual([r.status, r.data.code], [429, 'others_limit']);
      assert.match(r.data.error, /If this is your address, you can still reach us: open the link in our email to this address/);
      break;
    }
    assert.ok(++made <= SUPPORT_OTHERS_PER_ADDRESS, 'the limit holds');
  }
  assert.equal(made, SUPPORT_OTHERS_PER_ADDRESS);
  assert.equal(mailTo('Bomb@cust.test').length, SUPPORT_OTHERS_PER_ADDRESS, 'and no more acknowledgements than that reach the address');
  // Whoever holds our email is the owner, and is never stopped by what others typed.
  const any = db.get("SELECT ref FROM support_requests WHERE email='Bomb@cust.test' LIMIT 1").ref;
  assert.equal((await from().post(`${link('Bomb@cust.test', any).api}/reply`, { message: 'A reply instead.' })).status, 200);
  // The owner has a limit of their own: 30 messages a day from the address, new requests and replies together.
  const busy = await person('Busy Owner', 'busy@cust.test');
  for (let i = 0; i < SUPPORT_REPLIES_PER_ADDRESS; i++) {
    busy.ip = ip();
    assert.equal((await busy.post('/public/support', { message: `My own request number ${i + 1}, signed in.` })).status, 200);
  }
  busy.ip = ip();
  const stop = await busy.post('/public/support', { message: 'One more of my own.' });
  assert.equal(stop.status, 429);
  assert.match(stop.data.error, /We already have a lot of messages from this address in the last 24 hours/);
  // One device hammering the form is stopped long before that.
  const one = from();
  let ok = 0;
  for (let i = 0; i < 12; i++) if ((await one.post('/public/support', { email: `many${i}@cust.test`, message: 'From one device, many addresses.' })).status === 200) ok++;
  assert.equal(ok, 8);
});

test('deleting an account removes its requests with their threads, and one still waiting for an answer goes once it has it', async () => {
  const gal = await person('Gal Going', 'gal@cust.test');
  const done = await ask({ topic: 'other', message: 'DONE-WORDS: an old question.' }, gal);
  const open = await ask({ topic: 'billing', message: 'OPEN-WORDS: please refund my last payment before I go.' }, gal);
  const waiting = await ask({ topic: 'sending', message: 'WAITING-WORDS: why was my send refused?' }, gal);
  const [did, oid, wid] = [done, open, waiting].map((t) => row(t.reference).id);
  await act(maya, did, { action: 'note', text: 'DONE-NOTE' });
  await act(maya, did, { action: 'answer', text: 'DONE-ANSWER' });
  assert.equal((await gal.post(`/support/mine/${did}/reply`, { message: 'DONE-REPLY' })).status, 200);
  await act(maya, did, { action: 'close', text: 'DONE-CLOSING' });
  await act(maya, oid, { action: 'take' });
  await act(maya, oid, { action: 'note', text: 'OPEN-NOTE' });
  assert.equal((await gal.post(`/support/mine/${oid}/reply`, { message: 'OPEN-MORE: it was 9 dollars.' })).status, 200);
  await act(maya, wid, { action: 'ask', text: 'WAITING-QUESTION: which envelope?' });
  const thread = (id: string) => db.get('SELECT COUNT(*) n FROM support_messages WHERE request_id=?', id).n;
  assert.ok(thread(did) >= 5 && thread(oid) >= 3 && thread(wid) >= 1);
  const openLink = link('gal@cust.test', open.reference);

  assert.equal((await gal.post('/me/delete', { password: PW, now: true })).data.closed, 'now');

  // The answered one is gone, and its whole thread with it: messages both ways, the note, the history.
  assert.equal(db.get('SELECT COUNT(*) n FROM support_requests WHERE id=?', did).n, 0);
  assert.equal(thread(did), 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE body LIKE 'DONE-%'").n, 0);
  // The one nobody has answered, and the one where we asked something and wait, are kept so the answer is not lost,
  // cut loose from the login and the account that no longer exist.
  for (const id of [oid, wid]) assert.deepEqual({ ...db.get('SELECT forget, user_id, account_id FROM support_requests WHERE id=?', id) }, { forget: 1, user_id: null, account_id: null });
  assert.deepEqual([row(open.reference).status, row(waiting.reference).status], ['open', 'waiting']);
  assert.ok(thread(oid) >= 3);
  assert.equal((await opView(maya, oid)).forget, true);
  // Our stored copies of the emails about them went with the account.
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE lower(to_email)='gal@cust.test' AND subject LIKE ?", `%${done.reference}%`).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE html LIKE '%gal@cust.test%' AND subject LIKE '[%'").n, 0, 'also the ones that told the operators about her');

  // Answering the open one sends the answer in full, says that the request is now deleted, and deletes it.
  const answered = await act(maya, oid, { action: 'answer', text: 'OPEN-ANSWER: your 9 dollars are on their way back.' });
  // The answer also says what the mail server did with the email (no mail server here, so it is in the outbox).
  assert.deepEqual(answered.data, { ok: true, deleted: true, mail: 'outbox' });
  const last = mailTo('gal@cust.test').at(-1)!;
  assert.match(text(last.html), /OPEN-ANSWER: your 9 dollars are on their way back\. You closed your Sign&Grow account while this request was open\. Now that it is answered we have deleted it, as we said we would, and the link in our earlier email no longer opens it\./);
  assert.equal(last.link, null, 'the email carries no link, because there is nothing left to open');
  assert.deepEqual([db.get('SELECT COUNT(*) n FROM support_requests WHERE id=?', oid).n, thread(oid)], [0, 0]);
  assert.equal((await from().get(openLink.api)).status, 404);
  assert.equal((await opView(maya, oid)), undefined);

  // The one waiting for her reply is kept for the time a closed request can be reopened, then it goes too.
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM support_requests WHERE id=?', wid).n, 1);
  db.run('UPDATE support_requests SET updated_at=? WHERE id=?', new Date(Date.now() - (SUPPORT_REOPEN_DAYS + 1) * 864e5).toISOString(), wid);
  await cron.tick();
  assert.deepEqual([db.get('SELECT COUNT(*) n FROM support_requests WHERE id=?', wid).n, thread(wid)], [0, 0]);
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE body LIKE 'OPEN-%' OR body LIKE 'WAITING-%'").n, 0);
  assert.equal(firstName('  Maya   Okafor '), 'Maya');
  assert.ok(hoursFromNow(1) > new Date().toISOString());
});

// ---- What a skeptic proved broken, and what stops it now -----------------------------------------------------
// Each test below reproduces a finding of the review in research/verify-new.json ("verify:support") and fails
// without its fix. The probes that found them are in tests/out/verify-support/.

test('a stranger who types somebody\'s address can neither fill their inbox nor shut them out of support', async () => {
  const amy = await person('Amy Real', 'amy.real@cust.test');
  const mine = await ask({ topic: 'charged-wrongly', message: 'AMY: I was charged twice, please help.' }, amy);
  const amyRow = row(mine.reference);
  await act(maya, amyRow.id, { action: 'ask', text: 'Which card was it?' });
  const l = link('amy.real@cust.test', mine.reference);
  const inbox = mailTo('amy.real@cust.test').length;
  // A stranger, from five devices, eight tries each, with nothing but Amy's address.
  let made = 0;
  const refused: any[] = [];
  for (let d = 0; d < 5; d++) {
    const dev = from();
    for (let i = 0; i < 8; i++) {
      const r = await dev.post('/public/support', { email: 'amy.real@cust.test', message: 'filler filler filler filler' });
      if (r.status === 200) made++;
      else refused.push(r);
    }
  }
  assert.equal(made, SUPPORT_OTHERS_PER_ADDRESS);
  assert.ok(refused.every((r) => r.status === 429 && r.data.code === 'others_limit'), JSON.stringify(refused[0]?.data));
  assert.equal(mailTo('amy.real@cust.test').length - inbox, SUPPORT_OTHERS_PER_ADDRESS, 'one acknowledgement for each, and nothing more reaches her');
  // The refusal names no number, so it does not count for the stranger what was written under the address.
  assert.doesNotMatch(refused[0].data.error, /\d/);
  // Amy is not shut out by any of it: her answer to our question through the link, a reply while signed in, and a
  // new request while signed in all reach us.
  assert.equal((await from().post(`${l.api}/reply`, { message: 'It was the card ending 4242.' })).status, 200);
  assert.equal(row(mine.reference).status, 'open');
  assert.equal((await amy.post(`/support/mine/${amyRow.id}/reply`, { message: 'And it happened on the 3rd.' })).status, 200);
  assert.equal((await amy.post('/public/support', { topic: 'cannot-log-in', message: 'AMY: this is really me and I need help now.' })).status, 200);

  // The allowance also counts what is still open from unknown writers, so it cannot be built up over days. Once a
  // person on our side has closed those, there is room again.
  db.run("UPDATE support_requests SET at=? WHERE email='amy.real@cust.test' AND verified=0", new Date(Date.now() - 2 * 864e5).toISOString());
  assert.equal((await from().post('/public/support', { email: 'amy.real@cust.test', message: 'filler filler filler filler' })).data.code, 'others_limit');
  for (const t of db.all("SELECT id FROM support_requests WHERE email='amy.real@cust.test' AND verified=0")) assert.equal((await act(maya, t.id, { action: 'spam' })).status, 200);
  assert.equal((await from().post('/public/support', { email: 'amy.real@cust.test', message: 'Not signed in this time, but it is me.' })).status, 200);
});

test('what the owner of an address wrote today is never told to a stranger by the limit', async () => {
  // Quinn writes a lot while signed in: six requests and six replies.
  const own = await person('Quiet Owner', 'quinn@cust.test');
  for (let i = 0; i < 6; i++) {
    own.ip = ip();
    assert.equal((await own.post('/public/support', { topic: 'other', message: `My own request number ${i}.` })).status, 200);
  }
  const first = db.get("SELECT id FROM support_requests WHERE email='quinn@cust.test' ORDER BY at LIMIT 1").id;
  for (let i = 0; i < 6; i++) assert.equal((await own.post(`/support/mine/${first}/reply`, { message: `More, number ${i}.` })).status, 200);
  // A stranger is stopped after exactly the same number of tries as at an address nobody ever wrote from.
  const tries = async (email: string) => {
    let ok = 0;
    for (let i = 0; i < 10; i++) if ((await from().post('/public/support', { email, message: 'probing probing probing' })).status === 200) ok++;
    return ok;
  };
  assert.equal(await tries('quinn@cust.test'), SUPPORT_OTHERS_PER_ADDRESS);
  assert.equal(await tries('nobody-ever@cust.test'), SUPPORT_OTHERS_PER_ADDRESS);
});

test('the answer to a question of ours is always taken, and replies to a request closed long ago go to one follow-up', async () => {
  const t = await ask({ email: 'tara@cust.test', name: 'Tara', message: 'TARA: my document is not where it should be.' });
  const id = row(t.reference).id;
  await act(maya, id, { action: 'answer', text: 'Try the Completed tab.' });
  const l = link('tara@cust.test', t.reference);
  for (let i = 0; i < SUPPORT_REPLIES_PER_REQUEST; i++) assert.equal((await from().post(`${l.api}/reply`, { message: `Still lost, try ${i}.` })).status, 200);
  assert.equal((await from().post(`${l.api}/reply`, { message: 'One more.' })).status, 429);
  // We ask her something. Her answer is taken although she used up today's messages: we wait for it.
  await act(maya, id, { action: 'ask', text: 'What is the title of the document?' });
  const answer = await from().post(`${l.api}/reply`, { message: 'It is called Lease 2026.' });
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  assert.equal(row(t.reference).status, 'open');
  assert.equal((await from().post(`${l.api}/reply`, { message: 'And another thing.' })).status, 429, 'after that, the limit for the day holds again');

  // Closed more than 30 days ago: the first reply starts a follow-up, and the next ones are added to it instead of
  // each starting another (each new one would email everyone who answers).
  await act(maya, id, { action: 'close', text: 'Found it for you.' });
  db.run('UPDATE support_requests SET closed_at=? WHERE id=?', new Date(Date.now() - (SUPPORT_REOPEN_DAYS + 1) * 864e5).toISOString(), id);
  db.run("UPDATE support_messages SET at=? WHERE request_id=? AND kind='customer'", new Date(Date.now() - 2 * 864e5).toISOString(), id);
  const ops = mailTo('maya@ops.test').length + mailTo('ravi@ops.test').length;
  const a = await from().post(`${l.api}/reply`, { message: 'Lost again, sorry.' });
  const b = await from().post(`${l.api}/reply`, { message: 'Still lost.' });
  const c = await from().post(`${l.api}/reply`, { message: 'Hello?' });
  assert.ok(a.data.moved && b.data.moved && c.data.moved);
  assert.equal(new Set([a.data.reference, b.data.reference, c.data.reference]).size, 1, 'one follow-up');
  assert.equal(db.get('SELECT COUNT(*) n FROM support_requests WHERE follows=?', id).n, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages m JOIN support_requests s ON s.id=m.request_id WHERE s.follows=? AND m.kind='customer'", id).n, 2);
  assert.equal(mailTo('maya@ops.test').length + mailTo('ravi@ops.test').length - ops, 2, 'the people who answer were told once, about the follow-up');
});

// A mail server that takes its time, as real ones do (a few hundred milliseconds a message). It stands in for the
// mail library's transport inside mail.ts, so nothing leaves this machine, and everything is put back afterwards.
const slowMail = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  const g = globalThis as any;
  const was = { url: process.env.SMTP_URL, transport: g.__tsmail };
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  g.__tsmail = { sendMail: () => new Promise((r) => setTimeout(() => r({}), ms)) };
  try {
    return await fn();
  } finally {
    if (was.url === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = was.url;
    g.__tsmail = was.transport;
  }
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('"send me the links again" answers as fast for an address that wrote to us as for one that never did', async () => {
  for (let i = 0; i < 3; i++) await ask({ email: `wrote${i}@cust.test`, message: 'I wrote to you, long enough.' });
  await slowMail(250, async () => {
    const time = async (email: string) => {
      const t0 = performance.now();
      const r = await from().post('/public/support/find', { email });
      assert.deepEqual([r.status, r.data], [200, { ok: true }]);
      return performance.now() - t0;
    };
    const wrote: number[] = [];
    const never: number[] = [];
    for (let i = 0; i < 3; i++) (wrote.push(await time(`wrote${i}@cust.test`)), never.push(await time(`never${i}@cust.test`)));
    // Before, an address that had written answered only once the mail server had taken the email: 250 ms or more.
    assert.ok(Math.max(...wrote) < 150, `answered in ${wrote.map(Math.round)} ms, not after the mail server`);
    assert.ok(Math.max(...never) < 150);
    // Wait (while the stand-in is still in place) until the mail server has had every one of them.
    const pending = () => db.get("SELECT COUNT(*) n FROM emails WHERE to_email LIKE 'wrote_@cust.test' AND subject LIKE 'Your requests to%' AND status='queued'").n;
    for (let i = 0; i < 50 && pending(); i++) await settle(100);
  });
  // The email still goes, a moment later, and only to the addresses that wrote.
  for (let i = 0; i < 3; i++) assert.equal(db.get("SELECT status FROM emails WHERE to_email=? AND subject LIKE 'Your requests to%'", `wrote${i}@cust.test`)?.status, 'sent');
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email LIKE 'never_@cust.test'").n, 0);
});

test('the links sent again leave out what the address disowned or we closed as not theirs, and help emails say nothing about signing', async () => {
  const keep = await ask({ email: 'fay@cust.test', topic: 'billing', message: 'FAY-ONE: billing words here.' });
  const disown = await ask({ email: 'fay@cust.test', topic: 'other', message: 'Another one, which she did not write.' });
  const spam = await ask({ email: 'fay@cust.test', topic: 'other', message: 'Win a prize, call 555 0100 now.' });
  const dl = link('fay@cust.test', disown.reference);
  assert.equal((await from().post(`${dl.api}/solved`, { not_mine: true })).data.request.closed_how, 'disowned');
  assert.equal((await act(maya, row(spam.reference).id, { action: 'spam' })).status, 200);
  const before = db.get('SELECT MAX(id) m FROM emails').m;
  assert.equal((await from().post('/public/support/find', { email: 'fay@cust.test' })).status, 200);
  await settle(50);
  const sent = db.all('SELECT subject, html FROM emails WHERE id > ?', before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /the link again$/, 'one request left to send');
  assert.ok(sent[0].html.includes(keep.reference) && !sent[0].html.includes(disown.reference) && !sent[0].html.includes(spam.reference));
  // Every email about a help request ends with where it came from, and not with a line about signing documents.
  for (const m of mailTo('fay@cust.test')) {
    assert.doesNotMatch(text(m.html), /Signed digitally|every dollar plants/, m.subject);
    assert.match(text(m.html), /Sent by the people who answer help requests at Sign&Grow\./);
  }
});

test('an API key, or a post from another site that carries a session, cannot file a request as the owner of an address', async () => {
  const dev = await person('Dev Owner', 'dev.owner@cust.test');
  const key = (await dev.post('/api-keys', { name: 'integration', scope: 'send' })).data.key;
  const count = () => db.get("SELECT COUNT(*) n FROM support_requests WHERE email='dev.owner@cust.test'").n;
  const inbox = mailTo('dev.owner@cust.test').length;
  const keyed = await from().call('POST', '/public/support', { topic: 'billing', message: 'KEY-WORDS: please move my plan to another card.' }, { authorization: `Bearer ${key}` });
  assert.equal(keyed.status, 403);
  assert.match(keyed.data.error, /An API key cannot write help requests/);
  // A page on another site, posting with the customer's session (text/plain, so the browser asks nobody first).
  const body = { topic: 'billing', message: 'CROSS-SITE: change the email on my account to thief@evil.example' };
  for (const origin of ['https://evil.example', 'null']) {
    const r = await dev.call('POST', '/public/support', body, { origin, 'content-type': 'text/plain' });
    assert.deepEqual([r.status, r.data.error], [403, 'Cross-site request blocked.'], origin);
  }
  assert.equal(count(), 0, 'nothing was filed');
  assert.equal(mailTo('dev.owner@cust.test').length, inbox, 'and nothing mailed back');
  // From our own page it works as before, and is marked as written by the signed-in owner.
  const own = await dev.call('POST', '/public/support', body, { origin: 'http://test.local' });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  const t = row(own.data.reference);
  assert.deepEqual([t.verified, t.came_by], [1, 'signed_in']);
  const v = await opView(maya, t.id);
  assert.deepEqual([v.written, v.thread[0].via], ['own', 'app']);
  // Without a key and without a session, anyone may still write, as anyone.
  assert.equal((await from().post('/public/support', { email: 'dev.owner@cust.test', message: 'Typed by anyone, long enough.' })).status, 200);
  assert.equal(row(db.get("SELECT ref FROM support_requests WHERE email='dev.owner@cust.test' ORDER BY at DESC LIMIT 1").ref).verified, 0);
});

test('a follow-up written through the private link is shown to the operator as coming through the link', async () => {
  const t = await ask({ email: 'rex@cust.test', name: 'Rex', topic: 'sending', message: 'REX: first message here.' });
  const id = row(t.reference).id;
  await act(maya, id, { action: 'close', text: 'Closing answer.' });
  const l = link('rex@cust.test', t.reference);
  db.run('UPDATE support_requests SET closed_at=? WHERE id=?', new Date(Date.now() - 31 * 864e5).toISOString(), id);
  const moved = await from().post(`${l.api}/reply`, { message: 'Writing again much later.' });
  assert.ok(moved.data.moved);
  const fresh = row(moved.data.reference);
  assert.deepEqual([fresh.verified, fresh.came_by], [1, 'link']);
  const v = await opView(maya, fresh.id);
  assert.deepEqual([v.written, v.thread[0].via], ['link', 'link'], 'not "signed in" and not "typed into the form"');
  // Known to be from the mailbox, so it cannot be closed as "nobody at this address wrote this".
  assert.equal((await act(maya, fresh.id, { action: 'spam' })).status, 400);
});

test('an alert is shown with the account it names, never with the account of the operator it is filed under', async () => {
  // A paid invoice that names an account we do not have: the payment code files an alert with no account.
  await billing.applyStripeEvent({ type: 'invoice.paid', data: { object: { id: 'in_repair_c', customer: 'cus_repair_c', subscription: 'sub_repair_c', amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_grove' }, metadata: { sg_account: 'acc_nowhere' } }] } } } });
  const filed = db.get("SELECT * FROM support_requests WHERE message LIKE '%in_repair_c%'");
  assert.ok(filed, 'the alert is in the queue');
  assert.equal(filed.email, 'maya@ops.test', 'filed under the first operator address');
  const v = await opView(maya, filed.id);
  assert.equal(v.alert, true);
  assert.equal(v.account, null, 'not Maya\'s own workspace');
  assert.equal(v.login, null, 'and not her login');
  // An alert that names an account shows that one, said to be the account the alert is about.
  const cust = await person('Alerted Customer', 'alerted@cust.test');
  const acc = (await cust.get('/me')).data.account.id;
  db.run("INSERT INTO support_requests (id, email, name, topic, message, account_id, status, at) VALUES ('sup_repairalert01', 'maya@ops.test', 'Sign&Grow (automatic alert)', 'billing', 'A refund failed for this account.', ?, 'open', ?)", acc, new Date().toISOString());
  const w = await opView(maya, 'sup_repairalert01');
  assert.deepEqual([w.account.id, w.account.via, w.login], [acc, 'alert', null]);
});

test('deleting a login leaves a request it wrote under somebody else\'s address to that mailbox, and never tells its owner they closed an account', async () => {
  const eve = await person('Eve Typist', 'eve.typist@cust.test');
  // Eve writes twice under Bea's address: once giving a name, once leaving the name empty (her own name is used).
  const r = await ask({ email: 'bea.mailbox@cust.test', name: 'Bea', topic: 'billing', message: 'EVE-WORDS: typed under the address of Bea.' }, eve);
  const nameless = await ask({ email: 'bea.mailbox@cust.test', topic: 'other', message: 'EVE-WORDS again, with no name typed.' }, eve);
  const t = row(r.reference);
  assert.equal(row(nameless.reference).name, 'Eve Typist');
  await act(maya, t.id, { action: 'ask', text: 'Did you write this, Bea?' });
  const l = link('bea.mailbox@cust.test', r.reference);
  assert.equal((await from().post(`${l.api}/reply`, { message: 'BEA-WORDS: yes, it is about my invoice. I never had an account.' })).status, 200);
  assert.equal((await eve.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  // Both stay with Bea's address, cut loose from Eve's login and account, and not marked to be forgotten.
  assert.deepEqual({ ...db.get('SELECT forget, user_id, account_id, name FROM support_requests WHERE id=?', t.id) }, { forget: 0, user_id: null, account_id: null, name: 'Bea' });
  assert.deepEqual({ ...db.get('SELECT forget, user_id, name FROM support_requests WHERE ref=?', nameless.reference) }, { forget: 0, user_id: null, name: null }, 'Eve\'s name went with her login');
  // An answer reaches Bea as an ordinary answer, and her link keeps working.
  const ans = await act(maya, t.id, { action: 'answer', text: 'Here is the answer about your invoice.' });
  assert.equal(ans.data.request.status, 'answered');
  const last = text(mailTo('bea.mailbox@cust.test').at(-1)!.html);
  assert.doesNotMatch(last, /You closed your Sign&Grow account/);
  assert.equal((await from().get(l.api)).status, 200);
});

test('when the first operator deletes their own login, the alerts filed under their address stay in the queue as they were', async () => {
  const was = process.env.OPERATOR_EMAILS;
  process.env.OPERATOR_EMAILS = `zed.first@ops.test, ${was}`;
  try {
    const zed = await person('Zed First', 'zed.first@ops.test');
    for (const n of ['1', '2']) await billing.applyStripeEvent({ type: 'invoice.paid', data: { object: { id: `in_repair_d${n}`, customer: `cus_repair_d${n}`, subscription: `sub_repair_d${n}`, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_grove' }, metadata: { sg_account: `acc_nowhere_d${n}` } }] } } } });
    const a1 = db.get("SELECT * FROM support_requests WHERE message LIKE '%in_repair_d1%'");
    const a2 = db.get("SELECT * FROM support_requests WHERE message LIKE '%in_repair_d2%'");
    assert.deepEqual([a1.email, a2.email], ['zed.first@ops.test', 'zed.first@ops.test']);
    assert.equal((await act(maya, a1.id, { action: 'close', text: 'Refunded by hand.' })).status, 200);
    assert.equal((await zed.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    assert.deepEqual({ ...db.get('SELECT status, forget FROM support_requests WHERE id=?', a1.id) }, { status: 'closed', forget: 0 }, 'the handled alert and its note are still there');
    assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE request_id=? AND body='Refunded by hand.'", a1.id).n, 1);
    assert.deepEqual({ ...db.get('SELECT status, forget FROM support_requests WHERE id=?', a2.id) }, { status: 'open', forget: 0 }, 'the open one is not taken for a customer who closed their account');
    assert.equal((await opView(maya, a2.id)).forget, false);
  } finally {
    process.env.OPERATOR_EMAILS = was;
  }
});

// A mail server that answers as told: refuse (as for a mistyped address) or take the email. Same stand-in as above.
const mailServer = { refuse: false };
const standInMail = async <T>(fn: () => Promise<T>): Promise<T> => {
  const g = globalThis as any;
  const was = { url: process.env.SMTP_URL, transport: g.__tsmail };
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  g.__tsmail = { sendMail: async () => { if (mailServer.refuse) throw new Error('550 5.1.1 no such user'); return {}; } };
  try {
    return await fn();
  } finally {
    if (was.url === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = was.url;
    g.__tsmail = was.transport;
    mailServer.refuse = false;
  }
};

test('when the mail server refuses an answer, the operator is told so, and is told again when it is given up', async () => {
  const { retryMail } = await import('../src/server/mail.ts');
  const again = (to: string) => db.run("UPDATE emails SET next_try_at=? WHERE to_email=? AND status='failed'", new Date(Date.now() - 1000).toISOString(), to);
  await standInMail(async () => {
    const t = await ask({ email: 'typo@cust.tset', name: 'Ty Po', topic: 'other', message: 'I mistyped my address, long enough.' });
    const id = row(t.reference).id;
    await act(maya, id, { action: 'take' });
    mailServer.refuse = true;
    const a = await act(maya, id, { action: 'answer', text: 'ANSWER that the mail server refuses.' });
    assert.equal(a.status, 200);
    assert.equal(a.data.mail, 'failed', 'the screen is told what the mail server said');
    assert.ok(a.data.request.thread.some((m: any) => m.kind === 'event' && /The mail server did not take our email "An answer to your request \(\w+\)" to typo@cust\.tset\. It said: 550 5\.1\.1 no such user/.test(m.body)));
    assert.deepEqual([a.data.request.mail.status, a.data.request.mail.retrying], ['failed', true]);
    assert.equal(a.data.request.email, 'typo@cust.tset');
    // Every later try fails as well, until there are no more: whoever has the request is emailed.
    const mayaMails = mailTo('maya@ops.test').length;
    db.run("UPDATE emails SET tries=? WHERE to_email='typo@cust.tset' AND status='failed'", 5);
    again('typo@cust.tset');
    await retryMail();
    const v = await opView(maya, id);
    assert.ok(v.thread.some((m: any) => m.kind === 'event' && /^Not delivered: our email "An answer to your request/.test(m.body)));
    assert.equal(v.mail.retrying, false);
    const told = mailTo('maya@ops.test').slice(mayaMails);
    assert.equal(told.length, 1);
    assert.equal(told[0].subject, `Not delivered: our email about request ${t.reference}`);
    assert.match(text(told[0].html), /could not be delivered, and nobody tries again\. It said: 550 5\.1\.1 no such user/);

    // A question that goes through: the screen says the mail server took it, nothing more.
    mailServer.refuse = false;
    const ok = await act(maya, id, { action: 'ask', text: 'Is there another address we can use?' });
    assert.equal(ok.data.mail, 'sent');
  });
});

test('a request kept after its writer deleted their account is deleted only once its answer has left', async () => {
  const { retryMail } = await import('../src/server/mail.ts');
  await standInMail(async () => {
    const hal = await person('Hal Going', 'hal.going@cust.test');
    const ho = await ask({ topic: 'billing', message: 'HALWORDS: please refund my last payment before I go.' }, hal);
    assert.equal((await hal.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    const id = row(ho.reference).id;
    mailServer.refuse = true;
    const a = await act(maya, id, { action: 'answer', text: 'HAL-ANSWER: your refund is on its way.' });
    assert.equal(a.status, 200);
    assert.equal(a.data.deleted, undefined, 'not deleted while the answer has not left');
    assert.equal(a.data.mail, 'failed');
    assert.ok(row(ho.reference), 'the request is still there');
    // The next try goes through: the request goes now, as promised.
    mailServer.refuse = false;
    db.run("UPDATE emails SET next_try_at=? WHERE to_email='hal.going@cust.test' AND status='failed'", new Date(Date.now() - 1000).toISOString());
    const r = await retryMail();
    assert.ok(r.sent >= 1);
    assert.equal(row(ho.reference), null);
    assert.equal(db.get("SELECT status FROM emails WHERE to_email='hal.going@cust.test' AND subject LIKE 'An answer to your request%'"), null, 'and our copy of the email went with it');
  });
  // One whose answer is never taken is deleted by the timer after the same 30 days as an unanswered question.
  const kept = await person('Kim Kept', 'kim.kept@cust.test');
  const k = await ask({ topic: 'billing', message: 'KIMWORDS: refund please, I am going.' }, kept);
  await kept.post('/me/delete', { password: PW, now: true });
  db.run("UPDATE support_requests SET status='answered', updated_at=? WHERE ref=?", new Date(Date.now() - (SUPPORT_REOPEN_DAYS + 1) * 864e5).toISOString(), k.reference);
  await cron.tick();
  assert.equal(row(k.reference), null);
});

test('requests from before this work are filled in once: the owner\'s own are theirs, and a one-click close is not called an answer', async () => {
  const olga = await person('Olga Old', 'olga.old@cust.test');
  const me = (await olga.get('/me')).data;
  const at = new Date(Date.now() - 400 * 864e5).toISOString();
  // Exactly the columns the old code wrote.
  db.run("INSERT INTO support_requests (id, ref, email, name, topic, message, user_id, account_id, status, at) VALUES ('sup_oldopen0000001', 'OLDOPEN1', 'olga.old@cust.test', 'Olga Old', 'billing', 'OLD-OPEN: please refund me', ?, ?, 'open', ?)", me.user.id, me.account.id, at);
  db.run("INSERT INTO support_requests (id, ref, email, name, topic, message, user_id, account_id, status, at) VALUES ('sup_oldclosed00001', 'OLDCLSD1', 'olga.old@cust.test', 'Olga Old', 'other', 'OLD-CLOSED: marked as answered with one click', ?, ?, 'closed', ?)", me.user.id, me.account.id, at);
  db.run("INSERT INTO support_requests (id, ref, email, name, topic, message, status, at) VALUES ('sup_oldanon0000001', NULL, 'anon.old@cust.test', NULL, 'cannot-log-in', 'OLD-ANON: locked out since last week', 'open', ?)", at);
  db.run("UPDATE support_requests SET came_by=NULL WHERE id IN ('sup_oldopen0000001', 'sup_oldclosed00001', 'sup_oldanon0000001')");
  const fresh = await ask({ email: 'not-old@cust.test', message: 'Written today, by anyone.' });
  const filled = (db as any).fillOldSupport();
  assert.ok(filled >= 3);
  assert.equal(row(fresh.reference).came_by, 'form', 'a request of today is left as it is');
  // Olga wrote it while signed in under her confirmed address: hers, and not to be closed as somebody else's.
  assert.deepEqual({ ...db.get("SELECT verified, came_by FROM support_requests WHERE id='sup_oldopen0000001'") }, { verified: 1, came_by: 'signed_in' });
  assert.equal((await opView(maya, 'sup_oldopen0000001')).written, 'own');
  assert.equal((await act(maya, 'sup_oldopen0000001', { action: 'spam' })).status, 400);
  // Nobody wrote an answer on the one closed with the old button. It is not called "closed with an answer", and it
  // has a closing time, so a reply 400 days later starts a new request instead of opening it with a new promise.
  const closed = (await olga.get('/support/mine')).data.requests.find((r: any) => r.reference === 'OLDCLSD1');
  assert.deepEqual([closed.closed_how, closed.closed_at], ['before', at]);
  const s = standing(closed, (iso) => iso);
  assert.equal(s.title, 'Closed');
  assert.match(s.text, /closed before every request kept its answer in writing/);
  const rep = await olga.post('/support/mine/sup_oldclosed00001/reply', { message: 'Is anyone there?' });
  assert.equal(rep.data.moved, true);
  assert.equal(db.get("SELECT status FROM support_requests WHERE id='sup_oldclosed00001'").status, 'closed');
  // Written without signing in: anyone's, as before.
  assert.deepEqual({ ...db.get("SELECT verified, came_by FROM support_requests WHERE id='sup_oldanon0000001'") }, { verified: 0, came_by: 'form' });
  assert.equal((await opView(maya, 'sup_oldanon0000001')).written, 'not_signed_in');
});

test('only words close a request: text that is an object, a list or a number is refused and nothing is emailed', async () => {
  const t = await ask({ email: 'nora2@cust.test', message: 'A second request, long enough.' });
  const id = row(t.reference).id;
  const inbox = mailTo('nora2@cust.test').length;
  for (const bad of [{ a: 1 }, {}, [], ['an', 'answer'], 12345, true]) {
    for (const action of ['close', 'answer', 'ask', 'note']) {
      const r = await act(maya, id, { action, text: bad });
      assert.equal(r.status, 400, `${action} with ${JSON.stringify(bad)}`);
    }
    assert.equal((await act(maya, id, { action: 'close', answer: bad })).status, 400);
  }
  assert.equal(row(t.reference).status, 'open');
  assert.equal(mailTo('nora2@cust.test').length, inbox);
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE request_id=? AND body LIKE '%object%'", id).n, 0);
  // Words still work.
  assert.equal((await act(maya, id, { action: 'close', text: 'Here is the answer, in words.' })).data.request.status, 'closed');
});

test('odd input gets a plain answer, never "something went wrong on our side"', async () => {
  for (const f of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'nope']) {
    const r = await maya.get(`/operator/support?filter=${f}`);
    assert.deepEqual([r.status, r.data.filter], [200, 'open'], f);
  }
  // A link cut short in the middle of an encoded character: the same answer as any link that opens nothing.
  for (const path of ['/public/support/ticket/%E0%A4%A/x', '/public/support/ticket/sup_x/%E0%A4%A', '/public/support/ticket/%/%']) {
    const r = await from().get(path);
    assert.equal(r.status, 404, path);
    assert.match(r.data.error, /^This link does not open a request\. It may have been cut short on the way/);
  }
  assert.equal((await from().post('/public/support/ticket/%E0%A4%A/x/reply', { message: 'hello there' })).status, 404);
});

test('a reply after the promised time keeps the lateness on record, and the published number says a question counts', async () => {
  const t = await ask({ email: 'late.record@cust.test', topic: 'other', message: 'Waiting for a long time now.' });
  const id = row(t.reference).id;
  db.run('UPDATE support_requests SET due_at=? WHERE id=?', new Date(Date.now() - 3 * 3600_000).toISOString(), id);
  const q = await act(maya, id, { action: 'ask', text: '??' });
  assert.deepEqual([q.data.request.status, q.data.request.late], ['waiting', false], 'the wait for us is over');
  assert.ok(q.data.request.thread.some((m: any) => m.kind === 'event' && m.body === 'This reply came 3 hours after the time we promised'), 'and the lateness stays in the history');
  // On time, nothing is added.
  const ok = await ask({ email: 'on.time@cust.test', topic: 'other', message: 'A question answered in time.' });
  const a = await act(maya, row(ok.reference).id, { action: 'answer', text: 'In time.' });
  assert.ok(!a.data.request.thread.some((m: any) => /after the time we promised/.test(m.body)));
  // The help page says what the number counts: a first reply from a person, a question back included.
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../src/app/help/tools.tsx', import.meta.url), 'utf8'), /got their first reply from a person in that time \(an answer, or a question back to the writer\)/);
});

test('a closed request that belongs to no login is deleted 90 days after closing; a login\'s requests and alerts stay', async () => {
  const { SUPPORT_KEEP_DAYS } = await import('../src/lib/policy.ts');
  const days = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
  const nobody = await ask({ email: 'once.signer@cust.test', name: 'Once Signer', message: 'ONCE-WORDS: I signed once and asked once.' });
  const recent = await ask({ email: 'recent.signer@cust.test', message: 'Closed not so long ago.' });
  const open = await ask({ email: 'still.open@cust.test', message: 'Nobody has answered this yet.' });
  const holder = await person('Login Holder', 'login.holder@cust.test');
  const theirs = await ask({ email: 'login.holder@cust.test', message: 'Typed under a confirmed login address.' });
  for (const r of [nobody, recent, theirs]) await act(maya, row(r.reference).id, { action: 'close', text: 'Answered and closed.' });
  const l = link('once.signer@cust.test', nobody.reference);
  db.run('UPDATE support_requests SET closed_at=? WHERE ref IN (?, ?)', days(SUPPORT_KEEP_DAYS + 1), nobody.reference, theirs.reference);
  db.run('UPDATE support_requests SET closed_at=? WHERE ref=?', days(SUPPORT_KEEP_DAYS - 1), recent.reference);
  db.run('UPDATE support_requests SET at=? WHERE ref=?', days(400), open.reference);
  db.run("INSERT INTO support_requests (id, email, name, topic, message, status, at, closed_at) VALUES ('sup_oldalert000001', 'maya@ops.test', 'Sign&Grow (automatic alert)', 'billing', 'An old handled alert.', 'closed', ?, ?)", days(400), days(400));
  // Our copy of an email the mail server took goes with it (in tests there is none, so make one look taken).
  db.run("UPDATE emails SET status='sent' WHERE to_email='once.signer@cust.test'");
  await cron.tick();
  assert.equal(row(nobody.reference), null, 'gone, with its thread');
  assert.equal(db.get("SELECT COUNT(*) n FROM support_messages WHERE body LIKE 'ONCE-%'").n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='once.signer@cust.test'").n, 0, 'and our copies of the emails with the link');
  assert.equal((await from().get(l.api)).status, 404);
  assert.ok(row(recent.reference), 'closed 89 days ago: kept');
  assert.ok(row(open.reference), 'open: kept until it is answered');
  assert.ok(row(theirs.reference), 'under the confirmed address of a login: goes with the login');
  assert.ok(db.get("SELECT 1 x FROM support_requests WHERE id='sup_oldalert000001'"), 'alerts stay');
  void holder;
});

test('someone signed in can say "I did not write to you" about a request a stranger typed their address into, and dates read alike', async () => {
  const pat = await person('Pat Signed', 'pat.signed@cust.test');
  const typed = await ask({ email: 'pat.signed@cust.test', message: 'Typed by somebody else under the address of Pat.' });
  const listed = (await pat.get('/support/mine')).data.requests.find((r: any) => r.reference === typed.reference);
  assert.deepEqual([listed.held, listed.can_reply], [true, true]);
  assert.equal((await pat.post(`/support/mine/${listed.id}/solved`, { not_mine: true })).status, 200);
  assert.equal(row(typed.reference).closed_how, 'disowned');
  // The screens: the button is offered wherever the first message came from someone we do not know, not only on
  // the page behind the link; and "Your requests" writes the day as every other support screen does.
  const fs = await import('node:fs');
  const view = fs.readFileSync(new URL('../src/app/help/RequestView.tsx', import.meta.url), 'utf8');
  assert.match(view, /\{solved && !closed && r\.held && <button[^>]*>|\{solved && !closed && r\.held && <button/);
  assert.doesNotMatch(view, /linked && r\.held/);
  const tools = fs.readFileSync(new URL('../src/app/help/tools.tsx', import.meta.url), 'utf8');
  assert.match(tools, /· sent \{whenText\(r\.at\)\}/);
  assert.doesNotMatch(tools, /\{billDay\(r\.at\)\}/);
});

test('a line break typed into the form never reaches a subject line, and a request that reaches nobody is logged loudly', async () => {
  const r = await ask({ email: 'crlf@cust.test', name: 'Evil\r\nBcc: x@y.z', message: 'line1\r\nBcc: victim@x.test\r\nmore words here' });
  const subject = mailTo('maya@ops.test').filter((m) => m.subject.includes(r.reference)).at(-1)!.subject;
  assert.doesNotMatch(subject, /[\r\n]/);
  assert.equal(subject, `[other] ${r.reference}: line1 Bcc: victim@x.test more words here`);
  // Nobody set up to answer: the server log says so for every request.
  const was = process.env.OPERATOR_EMAILS;
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: any[]) => void logged.push(a.join(' '));
  try {
    process.env.OPERATOR_EMAILS = '';
    const n = await ask({ email: 'unheard@cust.test', message: 'Is anybody there at all?' });
    assert.ok(logged.some((l) => l.includes(`HELP REQUEST ${n.reference} ARRIVED AND NOBODY WAS TOLD`)), logged.join('\n'));
  } finally {
    console.error = error;
    process.env.OPERATOR_EMAILS = was;
  }
});

test('the queue lets a long name and address wrap, and prints the whole address in the opened request; old dates carry their year', async () => {
  const longEmail = `maximiliana.alexandrina.wolfeschlegelsteinhausenbergerdorff@${'subdomain.'.repeat(6)}example.co.uk`;
  const t = await ask({ email: longEmail, name: 'Maximiliana-Alexandrina Wolfeschlegelsteinhausenbergerdorff' });
  assert.equal((await opView(maya, row(t.reference).id)).email, longEmail, 'the whole address, for the screen to print');
  // The screen (looked at in a browser at 390 and 1280 wide: tests/out/repair-support/drive.cjs and shots/).
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/app/styles/support.css', import.meta.url), 'utf8');
  assert.match(css, /\.tk-line > span \{ min-width: 0; \}/);
  assert.match(css, /\.tk-line b, \.tk-facts > div \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /\.tk input\[type='search'\][^{]*\{ min-height: 44px; \}|\.tk input\[type='search'\],/);
  assert.match(fs.readFileSync(new URL('../src/app/app/operator/tickets.tsx', import.meta.url), 'utf8'), /Answers go to <b>\{t\.email\}<\/b>/);
  // A request from more than half a year ago says which year; today's and next week's do not need to.
  const old = new Date(Date.now() - 400 * 864e5).toISOString();
  assert.match(whenText(old, 'UTC'), new RegExp(`^\\w+day \\d{1,2} \\w+ ${new Date(old).getUTCFullYear()}, \\d\\d:\\d\\d`));
  assert.match(whenText(hoursFromNow(30), 'UTC'), /^\w+day \d{1,2} \w+, \d\d:\d\d/);
});
