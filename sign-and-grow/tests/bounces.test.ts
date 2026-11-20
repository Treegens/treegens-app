// Knowing when an email did not arrive: the ids every email carries, POST /mail/events and what each kind of news
// does (src/server/mail.ts, src/server/bounces.ts, src/server/routes-bounces.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, Client, simple, signUp, mailTo, tokenFor, signAll, type Server } from './helpers.ts';

let db: Server['db'];
let env: Server['env'];
let handle: (req: Request) => Promise<Response>;
const g = globalThis as any;
const TOKEN = 'bounce-test-secret-7f3a9c1e';
const PW = 'correct horse battery';

// A stand-in for a customer's webhook endpoint, so envelope.updated has somewhere to go. Nothing leaves this machine.
const hookServer = http.createServer((req, res) => (req.resume(), req.on('end', () => res.end('ok'))));
let hookUrl = '';

before(async () => {
  ({ db, env } = await boot());
  handle = (await import('../src/server/router.ts')).handle;
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as any).port}/hook`;
});
after(() => {
  delete process.env.MAIL_EVENTS_TOKEN;
  hookServer.close();
});

let n = 0;
const ip = () => `10.${150 + Math.floor(++n / 250)}.${n % 250}.7`;
const person = (name: string, email: string) => signUp(name, email, ip());
const me = async (c: Client) => (await c.get('/me')).data;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const actions = (eid: string) => db.all('SELECT action FROM audit WHERE envelope_id=? ORDER BY seq', eid).map((a: any) => a.action);
const auditLine = (eid: string, action: string) => db.get('SELECT actor, detail FROM audit WHERE envelope_id=? AND action=? ORDER BY seq DESC', eid, action);
const lastMail = (to: string, eid?: string) => db.get(`SELECT * FROM emails WHERE lower(to_email)=lower(?)${eid ? ' AND envelope_id=?' : ''} ORDER BY id DESC LIMIT 1`, ...(eid ? [to, eid] : [to]));
const rec = (eid: string, email: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND lower(email)=lower(?)', eid, email);
const subjects = (to: string) => mailTo(to).map((m: any) => m.subject);
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
// The 6 digits of the newest "get our emails again" code sent to this address.
const codeIn = (to: string) => /(\d{6}) is your code/.exec(mailTo(to).filter((m: any) => m.subject === 'Your code to get our emails again').pop()?.html || '')?.[1] || '';

// POST /mail/events as the mail provider does it: no cookie, the secret in the address unless told otherwise.
async function events(body: any, o: { auth?: string | null; headers?: Record<string, string>; raw?: any } = {}) {
  const q = o.auth === undefined ? `?token=${encodeURIComponent(TOKEN)}` : o.auth === null ? '' : o.auth;
  const init: any = { method: 'POST', body: o.raw ?? JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20', ...o.headers } };
  if (o.raw instanceof ReadableStream) init.duplex = 'half';
  const res = await handle(new Request(`http://test.local/api/mail/events${q}`, init));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = async (body: any) => {
  const r = await events(body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

// An envelope with one signer, sent. Answers its id and the signer's recipient id.
async function out(sender: Client, to: string, over: any = {}) {
  const e = await simple(sender, to, over);
  const r = await sender.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { eid: e.id as string, rid: e.recipients[0].id as string };
}

// One realistic sample of each provider's hard bounce, for the address `to`, naming our email `m` the way that
// provider does (some hand back our ids, some only the address).
const SAMPLES: Record<string, (to: string, m: any) => any> = {
  postmark: (to, m) => ({
    RecordType: 'Bounce', MessageStream: 'outbound', ID: 4323372036854775807, Type: 'HardBounce', TypeCode: 1, Name: 'Hard bounce', Tag: '',
    MessageID: '883953f4-6105-42a2-a16a-77a8eac79483', Metadata: { 'sg-mail': String(m.id) }, ServerID: 23,
    Description: 'The server was unable to deliver your message (ex: unknown user, mailbox not found).',
    Details: 'smtp;550 5.1.1 The email account that you tried to reach does not exist.', Email: to, From: 'sign@test.local',
    BouncedAt: new Date().toISOString(), DumpAvailable: true, Inactive: true, CanActivate: true, Subject: m.subject,
  }),
  sendgrid: (to, m) => [
    { email: to, timestamp: Math.floor(Date.now() / 1000) - 20, 'smtp-id': `<${m.message_id}>`, event: 'processed', sg_event_id: 'p1', sg_message_id: 'sgm.1', sg_mail: String(m.id) },
    { email: to, timestamp: Math.floor(Date.now() / 1000), 'smtp-id': `<${m.message_id}>`, event: 'bounce', category: [], sg_event_id: 'b1', sg_message_id: 'sgm.1',
      reason: '550 5.1.1 The email account that you tried to reach does not exist', status: '5.1.1', type: 'bounce', sg_mail: String(m.id) },
  ],
  mailgun: (to, m) => ({
    signature: { timestamp: '1529006854', token: 'a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0', signature: 'd2271d12299f6592d9d44cd9d250f0704e4674c30d79d07c47a66f95ce71cf55' },
    'event-data': {
      id: 'G9Bn5sl1TC6nu79C8C0bwg', timestamp: Date.now() / 1000, 'log-level': 'error', event: 'failed', severity: 'permanent', reason: 'bounce',
      recipient: to, 'recipient-domain': to.split('@')[1], 'user-variables': { sg_mail: String(m.id) },
      'delivery-status': { 'attempt-no': 1, code: 550, message: '5.1.1 The email account that you tried to reach does not exist.', description: '', 'mx-host': 'mx.example.com', 'session-seconds': 0.1 },
      message: { headers: { to, 'message-id': m.message_id, from: 'sign@test.local', subject: m.subject }, attachments: [], size: 111 },
      flags: { 'is-routed': false, 'is-authenticated': true, 'is-system-test': false, 'is-test-mode': false },
    },
  }),
  // Resend hands back neither of our ids, so the email is found by its address.
  resend: (to) => ({
    type: 'email.bounced', created_at: new Date().toISOString(),
    data: { created_at: new Date().toISOString(), email_id: '56761188-7520-42d8-8898-ff6fc54ce618', from: 'GrowSigning <sign@test.local>', to: [to], subject: 'Simple agreement',
      bounce: { type: 'Permanent', subType: 'General', message: "550 5.1.1 The recipient's email address does not exist." } },
  }),
  ses: (to, m) => ({
    Type: 'Notification', MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324', TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events', Subject: 'Amazon SES Email Event Notification',
    Timestamp: new Date().toISOString(), SignatureVersion: '1', Signature: 'EXAMPLE', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem', UnsubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe',
    Message: JSON.stringify({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bounceSubType: 'General', feedbackId: '0100abc', timestamp: new Date().toISOString(), reportingMTA: 'dsn; a1-1.smtp-out.amazonses.com',
        bouncedRecipients: [{ emailAddress: to, action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] },
      mail: { timestamp: new Date().toISOString(), source: 'sign@test.local', messageId: '0100018c-ses', destination: [to], headersTruncated: false,
        headers: [{ name: 'X-SG-Mail', value: String(m.id) }, { name: 'Message-ID', value: `<${m.message_id}>` }], commonHeaders: { messageId: `<${m.message_id}>`, subject: m.subject } },
    }),
  }),
  plain: (to) => ({ type: 'bounce', email: to, reason: '550 5.1.1 user unknown' }),
};

// ---- 1. The ids ------------------------------------------------------------------------------------------------

test('every email goes out with a Message-ID of ours and the number of its row, the same on every try', async () => {
  const { sendMail, mailHeaders, retryMail } = await import('../src/server/mail.ts');
  const seen: any[] = [];
  let fail = true;
  process.env.SMTP_URL = 'smtp://user:pw@smtp.postmarkapp.com:587';
  g.__tsmail = { sendMail: async (o: any) => { seen.push(o); if (fail) throw new Error('421 try later'); } };
  try {
    assert.equal(await sendMail({ to: 'ids@example.com', subject: 'Ids', heading: 'Ids', lines: ['x'] }), 'failed');
    db.run("UPDATE emails SET next_try_at=? WHERE to_email='ids@example.com'", daysAgo(0.001));
    fail = false;
    await retryMail();
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
  }
  const row = db.get("SELECT id, message_id, status FROM emails WHERE to_email='ids@example.com'");
  assert.equal(row.status, 'sent');
  assert.match(row.message_id, /^sg-[0-9a-f]{32}@test\.local$/);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.messageId, `<${row.message_id}>`);
    assert.equal(s.headers['X-SG-Mail'], String(row.id));
    assert.equal(s.headers['X-PM-Metadata-sg-mail'], String(row.id));
  }
  // A header made for one provider is never sent through another.
  assert.deepEqual(Object.keys(mailHeaders(5, 'smtp://u:p@smtp.example.net:587')), ['X-SG-Mail']);
  assert.equal(JSON.parse(mailHeaders(5, 'smtps://apikey:x@smtp.sendgrid.net:465')['X-SMTPAPI']).unique_args.sg_mail, '5');
  assert.equal(JSON.parse(mailHeaders(5, 'smtp://postmaster%40mg.example.com:p@smtp.mailgun.org:587')['X-Mailgun-Variables']).sg_mail, '5');
  assert.equal(mailHeaders(5, 'not a url')['X-SG-Mail'], '5');
  // Two emails never share one.
  await sendMail({ to: 'ids@example.com', subject: 'Ids 2', heading: 'Ids', lines: ['x'] });
  assert.equal(db.get("SELECT COUNT(DISTINCT message_id) n FROM emails WHERE to_email='ids@example.com'").n, 2);
});

// ---- 2. The address and its secret ---------------------------------------------------------------------------

test('the address for mail events exists only with its secret, and takes it in three ways', async () => {
  const body = { type: 'delivered', email: 'nobody.here@example.com' };
  const { openapi } = await import('../src/server/openapi.ts');
  assert.ok(openapi().paths['/mail/events'], 'described where it exists');
  try {
    delete process.env.MAIL_EVENTS_TOKEN;
    assert.equal((await events(body)).status, 404);
    // Without the setting, the API description does not mention the address either.
    assert.equal((openapi().paths as any)['/mail/events'], undefined);
    assert.ok((openapi().paths as any)['/envelopes/{id}/try-again']);
    // Too short to be a secret: the same as not set.
    process.env.MAIL_EVENTS_TOKEN = 'short';
    assert.equal((await events(body, { auth: '?token=short' })).status, 404);
  } finally {
    process.env.MAIL_EVENTS_TOKEN = TOKEN;
  }
  assert.equal((await events(body)).status, 200);
  assert.equal((await events(body, { auth: null, headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await events(body, { auth: null, headers: { authorization: `Basic ${Buffer.from(`sendgrid:${TOKEN}`).toString('base64')}` } })).status, 200);
  // A password with a colon in it is read in full.
  process.env.MAIL_EVENTS_TOKEN = `${TOKEN}:more`;
  assert.equal((await events(body, { auth: null, headers: { authorization: `Basic ${Buffer.from(`u:${TOKEN}:more`).toString('base64')}` } })).status, 200);
  process.env.MAIL_EVENTS_TOKEN = TOKEN;
  for (const wrong of [{ auth: `?token=${TOKEN.slice(0, -1)}X` }, { auth: null }, { auth: null, headers: { authorization: `Bearer ${TOKEN}x` } },
    { auth: null, headers: { authorization: `Basic ${Buffer.from(`${TOKEN}:nope`).toString('base64')}` } }]) {
    const r = await events(body, wrong);
    assert.equal(r.status, 401, JSON.stringify(wrong));
    assert.match(r.data.error, /MAIL_EVENTS_TOKEN/);
  }
  // A signed-in browser is no secret either.
  const someone = await person('Cookie Holder', 'cookie.holder@example.com');
  assert.equal((await someone.post('/mail/events', body)).status, 401);
  // Guessing is slowed down, and the right secret still works from elsewhere.
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await events(body, { auth: '?token=guess-guess-guess-guess', headers: { 'x-forwarded-for': '198.51.100.99' } })).status;
  assert.equal(last, 429);
  assert.equal((await events(body)).status, 200);
});

// ---- 3 and 8. Every provider's shape does what our own shape does ----------------------------------------------

test('each provider reads into our own shape', async () => {
  const { readEvents } = await import('../src/server/bounces.ts');
  const m = { id: 77, message_id: 'sg-abc@test.local', subject: 'S' };
  for (const [name, make] of Object.entries(SAMPLES)) {
    const read = readEvents(make('Who@Example.com', m));
    assert.ok(read, name);
    assert.deepEqual(read!.events.map((e) => [e.type, e.email]), [['bounce', 'who@example.com']], name);
  }
  // The other kinds of news, one realistic sample each.
  const kinds = (x: any) => readEvents(x)!.events.map((e) => e.type);
  assert.deepEqual(kinds({ RecordType: 'Delivery', ServerID: 23, MessageStream: 'outbound', MessageID: 'x', Recipient: 'a@example.com', Tag: '', DeliveredAt: new Date().toISOString(), Details: 'Test delivery webhook details', Metadata: {} }), ['delivered']);
  assert.deepEqual(kinds({ RecordType: 'SpamComplaint', ID: 1, Type: 'SpamComplaint', TypeCode: 512, Email: 'a@example.com', BouncedAt: new Date().toISOString(), Metadata: {} }), ['complaint']);
  assert.deepEqual(kinds({ RecordType: 'Bounce', Type: 'SoftBounce', TypeCode: 4096, Email: 'a@example.com', Details: 'mailbox full' }), ['soft_bounce']);
  assert.deepEqual(kinds({ RecordType: 'Open', Recipient: 'a@example.com' }), []); // opened: not ours to act on, and never "read"
  assert.deepEqual(kinds([{ email: 'a@example.com', timestamp: 1, event: 'delivered', sg_event_id: 'd', response: '250 OK' }, { email: 'a@example.com', timestamp: 1, event: 'spamreport', sg_event_id: 's' },
    { email: 'a@example.com', timestamp: 1, event: 'deferred', sg_event_id: 'f', response: '450 mailbox full' }, { email: 'a@example.com', timestamp: 1, event: 'open', sg_event_id: 'o' }]), ['delivered', 'complaint', 'soft_bounce']);
  assert.deepEqual(kinds({ signature: {}, 'event-data': { event: 'failed', severity: 'temporary', recipient: 'a@example.com', 'delivery-status': { code: 452, message: 'mailbox full' } } }), ['soft_bounce']);
  assert.deepEqual(kinds({ signature: {}, 'event-data': { event: 'complained', recipient: 'a@example.com' } }), ['complaint']);
  assert.deepEqual(kinds({ type: 'email.delivered', created_at: new Date().toISOString(), data: { to: ['a@example.com', 'b@example.com'] } }), ['delivered', 'delivered']);
  assert.deepEqual(kinds({ type: 'email.complained', created_at: new Date().toISOString(), data: { to: ['a@example.com'] } }), ['complaint']);
  assert.deepEqual(kinds({ Type: 'Notification', TopicArn: 'arn:x', Message: JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'a@example.com' }], complaintFeedbackType: 'abuse', timestamp: new Date().toISOString() }, mail: { headers: [] } }) }), ['complaint']);
  assert.deepEqual(kinds({ Type: 'Notification', TopicArn: 'arn:x', Message: JSON.stringify({ eventType: 'Delivery', delivery: { recipients: ['a@example.com'], timestamp: new Date().toISOString(), smtpResponse: '250 ok' }, mail: { commonHeaders: {} } }) }), ['delivered']);
  // A Notification whose Message is words, not JSON, is understood and holds nothing.
  assert.deepEqual(readEvents({ Type: 'Notification', TopicArn: 'arn:x', Message: 'Successfully validated SNS topic for Amazon SES event publishing.' }), { events: [] });
});

test('a hard bounce from each provider leaves the same marks as one in our own shape', async () => {
  const outcome = (eid: string, to: string, sender: string) => {
    const r = rec(eid, to);
    return {
      marked: !!r.bounced_at, reason: r.bounce_reason, on: lastMail(to, eid).bounce_kind,
      record: auditLine(eid, 'Email could not be delivered')?.detail.replace(to, 'X').replace(/Sam Signer/, 'S'),
      told: subjects(sender).filter((s: string) => s.startsWith('Could not be delivered')).length,
      listed: !!db.get('SELECT 1 x FROM bounced_addresses WHERE email=?', to),
    };
  };
  const seen: Record<string, any> = {};
  for (const [name, make] of Object.entries(SAMPLES)) {
    const sender = `sender.${name}@bounce.example`;
    const c = await person(`Sender ${name}`, sender);
    const to = `gone.${name}@nowhere.example`;
    const { eid } = await out(c, to);
    const m = lastMail(to, eid);
    const r = await ok(make(to, m));
    assert.equal(r.applied, 1, `${name}: ${JSON.stringify(r)}`);
    seen[name] = outcome(eid, to, sender);
  }
  // The same marks everywhere. The record quotes each mail server's own words, so only its first sentence is compared.
  const head = (o: any) => ({ ...o, record: o.record.split('. ')[0] });
  for (const name of Object.keys(SAMPLES)) assert.deepEqual(head(seen[name]), head(seen.plain), name);
  assert.deepEqual(head(seen.plain), { marked: true, reason: 'no such mailbox', on: 'hard', told: 1, listed: true, record: 'Email to S <X> could not be delivered: no such mailbox' });
});

// ---- Matching ----------------------------------------------------------------------------------------------------

test('news is matched by our ids when it carries them, and by the address only among recent emails that left', async () => {
  const c = await person('Match Maker', 'match.maker@example.com');
  const a = await out(c, 'match.a@example.com');
  const b = await out(c, 'match.b@example.com');
  const ma = lastMail('match.a@example.com', a.eid);
  // Our number with somebody else's address is not that email: a number that happens to exist is not enough.
  let r = await ok({ type: 'bounce', email: 'stranger@example.com', mail_id: String(ma.id) });
  assert.equal(r.unmatched, 1);
  assert.equal(rec(a.eid, 'match.a@example.com').bounced_at, null);
  // By Message-ID, in angle brackets and another case, as providers quote it.
  r = await ok({ type: 'delivered', email: 'MATCH.A@example.com', message_id: `<${ma.message_id.toUpperCase()}>` });
  assert.equal(r.applied, 1);
  assert.ok(db.get('SELECT delivered_at FROM emails WHERE id=?', ma.id).delivered_at);
  // By the address alone, within the last days: the email to b.
  r = await ok({ type: 'bounce', email: 'match.b@example.com', reason: 'user unknown' });
  assert.equal(r.applied, 1);
  assert.ok(rec(b.eid, 'match.b@example.com').bounced_at);
  // An address we wrote to longer ago than that is not matched: the news is about something else.
  const old = await out(c, 'match.old@example.com');
  db.run('UPDATE emails SET at=?, tried_at=? WHERE to_email=?', daysAgo(4), daysAgo(4), 'match.old@example.com');
  r = await ok({ type: 'bounce', email: 'match.old@example.com' });
  assert.equal(r.unmatched, 1);
  assert.equal(rec(old.eid, 'match.old@example.com').bounced_at, null);
  // An email that never left (no mail server took it) has no news.
  db.run("UPDATE emails SET status='failed', at=?, tried_at=? WHERE to_email=?", daysAgo(0), daysAgo(0), 'match.old@example.com');
  assert.equal((await ok({ type: 'bounce', email: 'match.old@example.com' })).unmatched, 1);
  // News about mails we never sent changes nothing and is still answered 200, so the provider does not resend it.
  r = await ok([{ type: 'bounce', email: 'never.mailed@example.com' }, { type: 'complaint', email: 'never2@example.com', mail_id: '999999999' }]);
  assert.deepEqual([r.events, r.unmatched, r.applied], [2, 2, 0]);
});

// ---- 3. Hard bounce of an email to a recipient ----------------------------------------------------------------

test('a hard bounce marks the recipient, tells the sender at once, stops reminders until "Try again", and fires envelope.updated', async () => {
  const sender = 'hard.sender@example.com';
  const c = await person('Hana Hard', sender);
  const accountId = (await me(c)).account.id;
  db.run("INSERT INTO webhooks (id, account_id, url, secret, events, active, created_at) VALUES ('wh_bounce', ?, ?, 'whsec_x', '*', 1, ?)", accountId, hookUrl, new Date().toISOString());
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const to = 'no.such.person@example.com';
    const { eid, rid } = await out(c, to, { reminder_days: 1 });
    const m = lastMail(to, eid);
    const r = await ok({ type: 'bounce', email: to, mail_id: String(m.id), reason: 'smtp; 550 5.1.1 <no.such.person@example.com>: Recipient address rejected: User unknown' });
    assert.equal(r.applied, 1);
    const row = rec(eid, to);
    assert.ok(row.bounced_at);
    assert.equal(row.bounce_reason, 'no such mailbox');
    // The record, in our own words only: what the mail server wrote is for the people who run the server.
    assert.equal(auditLine(eid, 'Email could not be delivered').detail, 'Email to Sam Signer <no.such.person@example.com> could not be delivered: no such mailbox. The email was "Simple agreement". Reminders to this address are stopped until the address is corrected or the sender chooses to try again.');
    // The sender, at once, with the ways to fix it.
    const told = mailTo(sender).filter((x: any) => x.subject === 'Could not be delivered: Simple agreement');
    assert.equal(told.length, 1);
    assert.match(text(told[0].html), /could not be delivered: no such mailbox/);
    assert.match(text(told[0].html), /choose Correct next to Sam Signer/);
    assert.match(text(told[0].html), /"Try again"/);
    // The envelope page and the list.
    const page = (await c.get(`/envelopes/${eid}`)).data;
    assert.ok(page.envelope.recipients.find((x: any) => x.id === rid).bounced_at);
    assert.equal(page.envelope.recipients.find((x: any) => x.id === rid).bounce_reason, 'no such mailbox');
    assert.equal(page.deliveries.find((d: any) => d.to_email === to).bounce_kind, 'hard');
    const listed = (await c.get('/envelopes')).data.envelopes.find((e: any) => e.id === eid);
    assert.ok(listed.recipients[0].bounced_at);
    // The webhook.
    const hook = db.get("SELECT body FROM webhook_deliveries WHERE envelope_id=? AND event='envelope.updated'", eid);
    assert.equal(JSON.parse(hook.body).change, 'email_bounced');
    assert.equal(JSON.parse(hook.body).recipient_id, rid);
    // The same news again changes nothing and tells nobody twice.
    assert.equal((await ok({ type: 'bounce', email: to, mail_id: String(m.id) })).repeat, 1);
    assert.equal(mailTo(sender).filter((x: any) => x.subject.startsWith('Could not be delivered')).length, 1);

    // Reminders stop: by hand (in words that say why) and by the timer. "Not opened yet" does not also fire.
    const one = await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid });
    assert.equal(one.status, 409);
    assert.equal(one.data.code, 'email_bounced');
    assert.match(one.data.error, /could not be delivered: no such mailbox\. No reminder was sent\. Correct the address, or choose "Try again"/);
    const all = await c.post(`/envelopes/${eid}/remind`, {});
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.not_reminded, [{ recipient_id: rid, name: 'Sam Signer', why: 'email_bounced' }]);
    const mails = () => mailTo(to).length;
    const before = mails();
    db.run('UPDATE recipients SET sent_at=? WHERE id=?', daysAgo(3), rid);
    db.run('UPDATE envelopes SET sent_at=?, last_reminder_at=NULL, expires_at=? WHERE id=?', daysAgo(3), new Date(Date.now() + 2 * 864e5).toISOString(), eid);
    await env.cronTick();
    assert.equal(mails(), before, 'no reminder and no "expires soon" to an address that bounced');
    assert.equal(subjects(sender).filter((s: string) => s.startsWith('Not opened yet')).length, 0);

    // "Try again": the mark goes, the request is emailed again at once, and the timer reminds again.
    const again = await c.post(`/envelopes/${eid}/try-again`, { recipient_id: rid });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.delivery, 'outbox');
    assert.equal(rec(eid, to).bounced_at, null);
    assert.equal(mails(), before + 1);
    assert.ok(actions(eid).includes('Email tried again'));
    assert.ok(!db.get('SELECT 1 x FROM bounced_addresses WHERE email=?', to));
    db.run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', daysAgo(2), eid);
    await env.cronTick();
    assert.equal(mails(), before + 2, 'reminders go out again');
    // Nothing to try again on someone whose email did not come back.
    const twice = await c.post(`/envelopes/${eid}/try-again`, { recipient_id: rid });
    assert.equal(twice.status, 409);
    assert.match(twice.data.error, /nothing to try again/);
    // Another account cannot use it.
    const other = await person('Oscar Other', 'oscar.other@example.com');
    assert.equal((await other.post(`/envelopes/${eid}/try-again`, { recipient_id: rid })).status, 404);
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  }
});

test('correcting the address clears the mark, and a bounce of a closed envelope says there is nothing to send again', async () => {
  const sender = 'fix.sender@example.com';
  const c = await person('Fiona Fix', sender);
  const { eid, rid } = await out(c, 'typo@exmaple.com');
  await ok({ type: 'bounce', email: 'typo@exmaple.com', reason: 'Host or domain name not found. Name service error for name=exmaple.com type=A: Host not found' });
  assert.equal(rec(eid, 'typo@exmaple.com').bounce_reason, 'the domain does not exist or takes no email');
  assert.equal((await c.post(`/envelopes/${eid}/correct`, { recipient_id: rid, email: 'typo@example.com' })).status, 200);
  const fixed = rec(eid, 'typo@example.com');
  assert.equal(fixed.bounced_at, null);
  assert.ok(mailTo('typo@example.com').length >= 1);
  // A completed envelope: the sender is told how to get the copy to them instead.
  const done = await out(c, 'done.signer@example.com');
  assert.equal((await signAll(done.eid, 'done.signer@example.com')).status, 200);
  await ok({ type: 'bounce', email: 'done.signer@example.com', mail_id: String(lastMail('done.signer@example.com', done.eid).id) });
  const said = mailTo(sender).filter((x: any) => x.subject === 'Could not be delivered: Simple agreement').pop();
  assert.match(text(said.html), /The envelope is completed, so there is nothing to send again from here/);
  assert.doesNotMatch(text(said.html), /No reminders go to this address/);
});

// ---- Soft bounces ---------------------------------------------------------------------------------------------

test('a soft bounce is noted and stops nothing, until the same address said "try later" on three separate days', async () => {
  const c = await person('Sofia Soft', 'sofia.soft@example.com');
  const to = 'full.box@example.com';
  const { eid, rid } = await out(c, to);
  const m = lastMail(to, eid);
  let r = await ok({ type: 'soft_bounce', email: to, mail_id: String(m.id), reason: '452 4.2.2 The email account that you tried to reach is over quota', at: daysAgo(2) });
  assert.equal(r.applied, 1);
  assert.equal(db.get('SELECT bounce_kind FROM emails WHERE id=?', m.id).bounce_kind, 'soft');
  assert.equal(rec(eid, to).bounced_at, null);
  assert.match(auditLine(eid, 'Email not delivered yet').detail, /has not arrived yet: the mailbox is full\..*Nothing was stopped/);
  assert.equal(subjects('sofia.soft@example.com').filter((s: string) => s.startsWith('Could not be delivered')).length, 0);
  assert.equal((await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid })).status, 200, 'reminders go on');
  // Twice on the same day is one day.
  await ok({ type: 'soft_bounce', email: to, mail_id: String(m.id), reason: 'mailbox full', at: daysAgo(2) });
  await ok({ type: 'soft_bounce', email: to, mail_id: String(m.id), reason: 'mailbox full', at: daysAgo(1) });
  assert.equal(rec(eid, to).bounced_at, null);
  r = await ok({ type: 'soft_bounce', email: to, mail_id: String(m.id), reason: 'mailbox full' });
  assert.equal(r.applied, 1);
  const row = rec(eid, to);
  assert.ok(row.bounced_at, 'the third day counts as an address that does not work');
  assert.equal(row.bounce_reason, 'the mailbox is full, on 3 separate days');
  assert.equal(subjects('sofia.soft@example.com').filter((s: string) => s.startsWith('Could not be delivered')).length, 1);
});

// ---- 4. Complaint ------------------------------------------------------------------------------------------------

test('a complaint stops every email about that envelope, tells the sender only the recipient can undo it, and counts as a report', async () => {
  const sender = 'spam.sender@example.com';
  const c = await person('Sam Spammed', sender);
  const to = 'annoyed@example.com';
  const { eid, rid } = await out(c, to);
  const r = await ok({ type: 'complaint', email: to, mail_id: String(lastMail(to, eid).id) });
  assert.equal(r.applied, 1);
  assert.ok(rec(eid, to).complained_at);
  assert.ok(actions(eid).includes('Marked as spam'));
  const report = db.get('SELECT reason, reporter, detail FROM abuse_reports WHERE envelope_id=?', eid);
  assert.deepEqual([report.reason, report.reporter], ['spam', to]);
  assert.match(report.detail, /Reported by the mail provider/);
  const told = mailTo(sender).find((x: any) => x.subject === 'Marked as spam: Simple agreement');
  assert.ok(told);
  assert.match(text(told.html), /Only Sam Signer can undo that/);
  assert.match(text(told.html), /counts as one report against your account/);
  // Nothing more by email, whoever asks.
  let before = mailTo(to).length;
  const remind = await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid });
  assert.equal(remind.status, 409);
  assert.equal(remind.data.code, 'marked_as_spam');
  const retry = await c.post(`/envelopes/${eid}/try-again`, { recipient_id: rid });
  assert.equal(retry.status, 409);
  assert.equal(retry.data.code, 'marked_as_spam');
  // A repeat counts once.
  assert.equal((await ok({ type: 'complaint', email: to })).repeat, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM abuse_reports WHERE envelope_id=?', eid).n, 1);
  // The person themselves sees it on their signing page and can start the emails again.
  const t = tokenFor(eid, to);
  // The sender holds the link too (Copy link), but cannot undo the complaint for them.
  const asSender = await c.post(`/sign/${t}/mail-again`);
  assert.equal(asSender.status, 403);
  assert.match(asSender.data.error, /Only Sam Signer can ask/);
  assert.ok(rec(eid, to).complained_at);
  const signer = new Client();
  assert.equal((await signer.get(`/sign/${t}`)).data.recipient.mail_stopped, true);
  // Holding the link is not enough: a code goes to their mailbox, and typing it undoes the complaint.
  const asked = await signer.post(`/sign/${t}/mail-again`);
  assert.deepEqual([asked.data.code_sent, asked.data.sent_to], [true, to]);
  assert.ok(rec(eid, to).complained_at, 'nothing changes before the code is typed');
  assert.equal((await signer.post(`/sign/${t}/mail-again`, { code: codeIn(to) })).data.changed, true);
  assert.equal(rec(eid, to).complained_at, null);
  before += 1; // the email with the code
  assert.equal((await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid })).status, 200);
  assert.equal(mailTo(to).length, before + 1);
});

test('complaints from three different recipients pause the sending account, as three reports do', async () => {
  const c = await person('Paula Paused', 'paula.paused@example.com');
  for (const who of ['one', 'two', 'three']) {
    const to = `complainer.${who}@example.com`;
    const { eid } = await out(c, to);
    await ok({ type: 'complaint', email: to, mail_id: String(lastMail(to, eid).id) });
  }
  assert.ok((await me(c)).account.paused);
  assert.ok(subjects('paula.paused@example.com').includes('Sending is paused on your GrowSigning account'));
});

// ---- 6. Delivered ---------------------------------------------------------------------------------------------

test('"delivered" is kept on the email, and an email that arrives later takes an older bounce away', async () => {
  const c = await person('Dora Delivered', 'dora.delivered@example.com');
  const to = 'arrives@example.com';
  const { eid, rid } = await out(c, to);
  const first = lastMail(to, eid);
  assert.equal((await c.get(`/envelopes/${eid}`)).data.deliveries[0].delivered_at, null, 'without news the page says what it said before');
  await ok({ type: 'delivered', email: to, mail_id: String(first.id), reason: '250 2.0.0 OK' });
  const d = (await c.get(`/envelopes/${eid}`)).data.deliveries.find((x: any) => x.to_email === to);
  assert.ok(d.delivered_at);
  assert.equal(d.bounce_kind, null);
  // A second envelope to the same address comes back.
  const second = await out(c, to);
  await ok({ type: 'bounce', email: to, mail_id: String(lastMail(to, second.eid).id), reason: 'mailbox unavailable' });
  assert.ok(rec(second.eid, to).bounced_at);
  // News that the email from before the bounce arrived proves nothing and clears nothing.
  db.run('UPDATE emails SET delivered_at=NULL WHERE id=?', first.id);
  await ok({ type: 'delivered', email: to, mail_id: String(first.id) });
  assert.ok(rec(second.eid, to).bounced_at);
  assert.ok(db.get('SELECT 1 x FROM bounced_addresses WHERE email=?', to));
  // An email sent after the bounce that arrives is the proof that the address works: every mark of it goes.
  db.run('UPDATE recipients SET bounced_at=? WHERE envelope_id=?', daysAgo(0.01), second.eid);
  db.run('UPDATE bounced_addresses SET at=? WHERE email=?', daysAgo(0.01), to);
  const third = await simple(c, to, { subject: 'Later' });
  assert.equal((await c.call('POST', `/envelopes/${third.id}/send`, { send_anyway: true })).status, 200);
  await ok({ type: 'delivered', email: to, mail_id: String(lastMail(to, third.id).id) });
  assert.ok(!db.get('SELECT 1 x FROM bounced_addresses WHERE email=?', to));
  assert.equal(rec(second.eid, to).bounced_at, null);
  assert.match(auditLine(second.eid, 'Address works again').detail, /reached their mail server, so the address works\. Reminders to it are on again\./);
  assert.equal((await c.post(`/envelopes/${second.eid}/remind`, { recipient_id: second.rid })).status, 200);
  assert.equal((await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid })).status, 200);
});

// ---- 5. The do-not-mail list ---------------------------------------------------------------------------------

test('a new envelope to an address that bounced warns first in plain words, and goes out when the sender says so', async () => {
  const c = await person('Will Warned', 'will.warned@example.com');
  const to = 'bounced.before@example.com';
  const first = await out(c, to);
  await ok({ type: 'bounce', email: to, mail_id: String(lastMail(to, first.eid).id), reason: '550 5.1.1 user unknown' });
  const day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const e = await simple(c, to);
  const no = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(no.status, 409);
  assert.equal(no.data.code, 'bounced_address');
  assert.ok(no.data.error.startsWith(`${to} bounced on ${day}: no such mailbox. Check the address. Nothing was sent.`), no.data.error);
  assert.match(no.data.error, /"Send anyway"/);
  assert.deepEqual(no.data.bounced.map((b: any) => [b.email, b.reason]), [[to, 'no such mailbox']]);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'draft', 'nothing went out and nothing was dropped quietly');
  const before = mailTo(to).length;
  const yes = await c.call('POST', `/envelopes/${e.id}/send`, { send_anyway: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(mailTo(to).length, before + 1);
  assert.match(auditLine(e.id, 'Sent to an address that bounced before').detail, /The sender was shown this and chose to send anyway/);
  // Create and send in one call: refused the same way, nothing left behind, and "send_anyway" sends it.
  const drafts = () => db.get("SELECT COUNT(*) n FROM envelopes WHERE sender_id=(SELECT id FROM users WHERE email='will.warned@example.com')").n;
  const had = drafts();
  const body = (extra: any) => ({ subject: 'One call', documents: [{ id: 'd', file_id: db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id }], recipients: [{ id: 'r', role: 'signer', name: 'Bo', email: to.toUpperCase() }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true, ...extra });
  const one = await c.post('/envelopes', body({}));
  assert.equal(one.status, 409);
  assert.equal(drafts(), had);
  assert.equal((await c.post('/envelopes', body({ send_anyway: true }))).status, 200);
  // Another account is not warned about this account's address.
  const other = await person('Una Unwarned', 'una.unwarned@example.com');
  await out(other, to);
  // After 30 days the address is off the list.
  db.run('UPDATE bounced_addresses SET at=? WHERE email=?', daysAgo(31), to);
  await out(c, to);
});

// ---- 3. A login whose own address does not work --------------------------------------------------------------

test('a login whose emails come back sees it on every page until the address changes or they say it works again, and the other admins hear it', async () => {
  const owner = await person('Olga Owner', 'olga.owner@bounce.example');
  assert.equal((await owner.post('/account/invites', { email: 'adam.admin@bounce.example', role: 'admin' })).status, 200);
  const adam = Object.assign(new Client(), { ip: ip() });
  const invite = db.get("SELECT token FROM invites WHERE email='adam.admin@bounce.example' AND accepted_at IS NULL").token;
  assert.equal((await adam.post('/auth/signup', { name: 'Adam Admin', email: 'adam.admin@bounce.example', password: PW, invite })).status, 200);
  assert.equal((await me(adam)).email_problem, null);
  // Our last email to Adam about his own login comes back. (His invitation is about Olga, who wrote it, and says
  // nothing about his mailbox: a test below shows that its bounce leaves him alone.)
  assert.equal((await new Client().post('/auth/forgot', { email: 'adam.admin@bounce.example' })).status, 200);
  const m = lastMail('adam.admin@bounce.example');
  assert.match(m.subject, /password/i);
  assert.equal((await ok({ type: 'bounce', email: 'adam.admin@bounce.example', mail_id: String(m.id), reason: 'mailbox unavailable: account disabled' })).applied, 1);
  const p = (await me(adam)).email_problem;
  assert.deepEqual([p.address, p.reason], ['adam.admin@bounce.example', 'the mailbox is switched off']);
  assert.ok(p.since);
  const olga = mailTo('olga.owner@bounce.example').filter((x: any) => x.subject === 'Our emails to Adam Admin are not arriving');
  assert.equal(olga.length, 1);
  assert.match(text(olga[0].html), /renewal reminders, receipts/);
  // Not told twice, and Adam himself is not emailed about it (it would come back too).
  await ok({ type: 'bounce', email: 'adam.admin@bounce.example' });
  assert.equal(mailTo('olga.owner@bounce.example').filter((x: any) => x.subject === 'Our emails to Adam Admin are not arriving').length, 1);
  // "It works now, try again": the mark goes and one email goes out to try it.
  const before = mailTo('adam.admin@bounce.example').length;
  const w = await adam.post('/me/email-works');
  assert.equal(w.status, 200);
  assert.equal(w.data.cleared, true);
  assert.equal((await me(adam)).email_problem, null);
  assert.equal(mailTo('adam.admin@bounce.example').length, before + 1);
  // If that one comes back too, the mark is back.
  await ok({ type: 'bounce', email: 'adam.admin@bounce.example', mail_id: String(lastMail('adam.admin@bounce.example').id) });
  assert.ok((await me(adam)).email_problem);
  // Moving the login to an address that works: a link to the new address, opened in this login.
  const wrongPw = await adam.post('/me/email', { email: 'adam.new@bounce.example', password: 'not it' });
  assert.equal(wrongPw.status, 403);
  const asked = await adam.post('/me/email', { email: 'adam.new@bounce.example', password: PW });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const link = lastMail('adam.new@bounce.example').link as string;
  const t = new URL(link).searchParams.get('token');
  assert.match(new URL(link).pathname, /^\/change-email$/);
  // Somebody else's browser cannot use it.
  assert.equal((await owner.post('/me/email/confirm', { token: t })).status, 403);
  const done = await adam.post('/me/email/confirm', { token: t });
  assert.equal(done.status, 200);
  const now = await me(adam);
  assert.equal(now.user.email, 'adam.new@bounce.example');
  assert.equal(now.email_problem, null);
  assert.equal((await adam.post('/me/email/confirm', { token: t })).status, 410, 'the link works once');
  assert.ok(subjects('adam.admin@bounce.example').includes('The email address of your GrowSigning login was changed'));
  // An address another login has is refused in words.
  const taken = await adam.post('/me/email', { email: 'olga.owner@bounce.example', password: PW });
  assert.equal(taken.status, 409);
  // A login with no other admins: nobody else to tell, and nothing breaks.
  const solo = await person('Solo Sam', 'solo.sam@bounce.example');
  await ok({ type: 'bounce', email: 'solo.sam@bounce.example', mail_id: String(lastMail('solo.sam@bounce.example').id) });
  assert.ok((await me(solo)).email_problem);
  // Pressing "It works now, try again" again and again sends one email, and is then slowed down.
  const had = mailTo('solo.sam@bounce.example').length;
  const presses: number[] = [];
  for (let i = 0; i < 7; i++) presses.push((await solo.post('/me/email-works')).status);
  assert.deepEqual(presses, [200, 200, 200, 200, 200, 200, 429]);
  assert.equal(mailTo('solo.sam@bounce.example').length, had + 1);
  // A key cannot say it works or move the address.
  const key = (await solo.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  const viaKey = await new Client().call('POST', '/me/email-works', {}, { authorization: `Bearer ${key}` });
  assert.equal(viaKey.status, 403);
});

test('the timer forgets addresses that bounced, and "try later" days, after 30 days, as the data summary says', async () => {
  const { tick } = await import('../src/server/cron.ts');
  const c = await person('Tim Timer', 'tim.timer@example.com');
  const acc = (await me(c)).account.id;
  const put = (email: string, at: string) => db.run('INSERT OR REPLACE INTO bounced_addresses (account_id, email, reason, at) VALUES (?,?,?,?)', acc, email, 'no such mailbox', at);
  put('old.bounce@example.com', daysAgo(31));
  put('new.bounce@example.com', daysAgo(29));
  db.run('INSERT OR IGNORE INTO soft_bounce_days (address_hash, day) VALUES (?,?)', 'h-old', daysAgo(31).slice(0, 10));
  db.run('INSERT OR IGNORE INTO soft_bounce_days (address_hash, day) VALUES (?,?)', 'h-new', daysAgo(1).slice(0, 10));
  await tick();
  assert.ok(!db.get("SELECT 1 x FROM bounced_addresses WHERE email='old.bounce@example.com'"));
  assert.ok(db.get("SELECT 1 x FROM bounced_addresses WHERE email='new.bounce@example.com'"));
  assert.ok(!db.get("SELECT 1 x FROM soft_bounce_days WHERE address_hash='h-old'"));
  assert.ok(db.get("SELECT 1 x FROM soft_bounce_days WHERE address_hash='h-new'"));
});

// ---- 7. The mail log -----------------------------------------------------------------------------------------

test('the dev outbox shows what the mail provider said about each email', async () => {
  const c = await person('Otto Outbox', 'otto.outbox@example.com');
  const { eid } = await out(c, 'outbox.check@example.com');
  await ok({ type: 'bounce', email: 'outbox.check@example.com', mail_id: String(lastMail('outbox.check@example.com', eid).id), reason: 'no such user' });
  const row = (await new Client().get('/dev/outbox')).data.emails.find((x: any) => x.to_email === 'outbox.check@example.com');
  assert.equal(row.bounce_kind, 'hard');
  assert.match(row.bounce_reason, /no such mailbox/);
  assert.ok('delivered_at' in row && 'complained_at' in row);
});

// ---- Bodies nobody should send ------------------------------------------------------------------------------

test('a huge, malformed or unknown body is answered without a 500 and logged once', async () => {
  const big = JSON.stringify([{ type: 'bounce', email: 'x@example.com', reason: 'y'.repeat(1_100_000) }]);
  assert.equal((await events(null, { raw: big })).status, 413);
  // Without a length up front, read only as far as the limit.
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(ctrl) { if (sent > 3_000_000) return ctrl.close(); sent += 65536; ctrl.enqueue(new Uint8Array(65536).fill(32)); } });
  assert.equal((await events(null, { raw: stream })).status, 413);
  assert.ok(sent < 3_000_000, 'it stopped reading');
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: any[]) => void logged.push(a.join(' '));
  try {
    for (const raw of ['this is not json', '{"type": "bounce", "email": ', '']) {
      const r = await events(null, { raw });
      assert.equal(r.status, 202, raw);
      assert.equal(r.data.understood, false);
    }
    for (const body of [{ hello: 'world' }, [1, 2, 3], 42, 'text', null, { type: 'bounce', email: 12 }, { RecordType: 7 }, [{ event: 'bounce' }]]) {
      const r = await events(body);
      assert.equal(r.status, 202, JSON.stringify(body));
      assert.equal(r.data.understood, false);
    }
  } finally {
    console.error = err;
  }
  assert.equal(logged.filter((l) => l.includes('[mail events]')).length, 1, logged.join('\n'));
  assert.doesNotMatch(logged.join('\n'), /world/, 'what a field holds is never logged');
  // Strange values inside a known shape are passed over, never a 500.
  const odd = await events([{ type: 'bounce', email: 'not an address' }, { type: 'bounce', email: 'a@example.com', mail_id: '9'.repeat(40), message_id: { x: 1 }, reason: ['x'], at: 'yesterday' }, { type: 'delivered', email: 'a@example.com', at: 1e20 }]);
  assert.equal(odd.status, 200, JSON.stringify(odd.data));
  // A reason with a link or control characters in it is never passed on as it came.
  const { bounceWhy } = await import('../src/server/bounces.ts');
  assert.equal(bounceWhy('550 go to https://evil.example/fix now\u0000\u0007', true).raw, '550 go to now');
  assert.ok(bounceWhy('x'.repeat(5000), true).raw.length <= 240);
});

test('what a mail server said is put in plain words, and an answer nobody recognises is not guessed at', async () => {
  const { bounceWhy } = await import('../src/server/bounces.ts');
  const plain = (s: string, hard = true) => bounceWhy(s, hard).plain;
  assert.equal(plain('550 5.1.1 <a@b.c>: Recipient address rejected: User unknown in virtual mailbox table'), 'no such mailbox');
  assert.equal(plain('550 5.1.2 The domain does not exist'), 'the domain does not exist or takes no email');
  assert.equal(plain('Domain does not exist'), 'the domain does not exist or takes no email');
  assert.equal(plain('452 4.2.2 over quota', false), 'the mailbox is full');
  assert.equal(plain('554 5.7.1 rejected by policy'), 'the mail server refused the email');
  assert.equal(plain('something nobody wrote down before'), 'the mail server will not take email for this address');
  assert.equal(plain('', false), 'the mail server did not take it yet');
  assert.equal(bounceWhy('550 5.1.1 user unknown', true).full, 'no such mailbox (550 5.1.1 user unknown)');
});

// ---- Amazon SNS ------------------------------------------------------------------------------------------------

test('an Amazon SNS subscription is confirmed by fetching its link only when that link leads to Amazon SNS', async () => {
  const real = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (/amazonaws\.com|evil\.example/.test(new URL(url).hostname)) {
      fetched.push(url);
      return new Response('<ConfirmSubscriptionResponse/>', { status: 200 });
    }
    return real(u, init);
  }) as any;
  try {
    const confirm = (SubscribeURL: string) => events({ Type: 'SubscriptionConfirmation', MessageId: 'm1', Token: 'tok', TopicArn: 'arn:aws:sns:eu-west-1:123456789012:ses', Message: 'You have chosen to subscribe...', SubscribeURL, Timestamp: new Date().toISOString() });
    const good = 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-west-1:123456789012:ses&Token=tok';
    const r = await confirm(good);
    assert.equal(r.status, 200);
    assert.equal(r.data.subscription, 'confirmed');
    assert.deepEqual(fetched, [good]);
    for (const bad of ['https://evil.example/?Action=ConfirmSubscription', 'http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription', 'https://sns.eu-west-1.amazonaws.com.evil.example/',
      'https://evilamazonaws.com/', 'https://user:pw@sns.eu-west-1.amazonaws.com/', 'https://sns.eu-west-1.amazonaws.com:8443/', 'not a link']) {
      const no = await confirm(bad);
      assert.equal(no.status, 200);
      assert.match(no.data.subscription, /^not confirmed/);
    }
    assert.deepEqual(fetched, [good], 'nothing else was fetched');
    // Without the secret nothing is fetched at all.
    assert.equal((await events({ Type: 'SubscriptionConfirmation', TopicArn: 'arn:x', SubscribeURL: good }, { auth: null })).status, 401);
    assert.equal(fetched.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- Repairs after the skeptic's report (research/verify-new.json, "verify:bounces") ---------------------------

// What was written to the log while `fn` ran.
async function logged(fn: () => Promise<any>): Promise<string[]> {
  const seen: string[] = [];
  const err = console.error;
  console.error = (...a: any[]) => void seen.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.error = err;
  }
  return seen;
}
const accountOf = async (c: Client) => (await me(c)).account.id as string;
const counted = (acc: string) => db.get("SELECT COUNT(*) n FROM abuse_reports WHERE account_id=? AND status IN ('open','upheld')", acc).n;
const listedFor = (acc: string, email: string) => !!db.get('SELECT 1 x FROM bounced_addresses WHERE account_id=? AND email=?', acc, email);
const mailsAbout = (eid: string, to: string) => db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=? AND lower(to_email)=lower(?)', eid, to).n;
async function voidAndDelete(c: Client, eid: string) {
  assert.equal((await c.post(`/envelopes/${eid}/void`, { reason: 'Sent by mistake' })).status, 200);
  assert.equal((await c.call('DELETE', `/envelopes/${eid}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=?', eid).n, 0, 'the emails went with it');
}
const postmarkSpam = (to: string, id: number) => ({ RecordType: 'SpamComplaint', ID: 1, Type: 'SpamComplaint', TypeCode: 512, Email: to, BouncedAt: new Date().toISOString(), Metadata: { 'sg-mail': String(id) } });
const resend = (to: string, type = 'email.complained', extra: any = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: 'r-1', to: [to], subject: 'Simple agreement', ...extra } });

test('news that names our id is never moved onto another email, and still counts against a sender who deleted the envelope', async () => {
  const quick = await person('Quick Deleter', 'quick.deleter@repair.example');
  const honest = await person('Late Honest', 'late.honest@repair.example');
  const to = 'p1@outlook.example';
  const sent = await out(quick, to);
  const id = lastMail(to, sent.eid).id;
  await voidAndDelete(quick, sent.eid);
  const h = await out(honest, to);
  // Postmark hands back our number. The complaint is about the deleted email: it counts against the deleter, once,
  // and never against the honest account that wrote to the same person afterwards.
  assert.equal((await ok(postmarkSpam(to, id))).applied, 1);
  assert.equal((await ok(postmarkSpam(to, id))).repeat, 1);
  assert.equal(counted(await accountOf(quick)), 1);
  assert.equal(counted(await accountOf(honest)), 0);
  assert.equal(rec(h.eid, to).complained_at, null);
  // What is kept of the deleted email names nobody: a number, the account and a keyed fingerprint of the address.
  const kept = db.get('SELECT * FROM mail_gone WHERE mail_id=?', id);
  assert.ok(kept && !JSON.stringify(kept).includes('p1') && !JSON.stringify(kept).includes('outlook'));
  // The deleter's next envelope to that person does not email them: the complaint was theirs to make, and stays.
  const next = await out(quick, to, { subject: 'Second go' });
  assert.ok(rec(next.eid, to).complained_at);
  assert.equal(mailsAbout(next.eid, to), 0);

  // A stranger's email to a customer, refused by the customer's mail filter after the stranger deleted the envelope:
  // no banner for the customer, no email to their team, and the address goes on the stranger's own list.
  const vic = await person('Vic Customer', 'vic.customer@repair.example');
  const boss = await person('Vic Boss', 'vic.boss@repair.example');
  assert.equal((await boss.post('/account/invites', { email: 'vic.customer@repair.example', role: 'admin' })).status, 200);
  assert.equal((await vic.post('/invites/accept', { token: db.get("SELECT token FROM invites WHERE email='vic.customer@repair.example' AND accepted_at IS NULL").token })).status, 200);
  const stranger = await person('Stan Stranger', 'stan.stranger@repair.example');
  const s = await out(stranger, 'vic.customer@repair.example');
  const sm = lastMail('vic.customer@repair.example', s.eid);
  await voidAndDelete(stranger, s.eid);
  const r = await ok({ RecordType: 'Bounce', Type: 'HardBounce', TypeCode: 1, Email: 'vic.customer@repair.example', Metadata: { 'sg-mail': String(sm.id) }, Details: '550 5.7.1 Message rejected: content policy', BouncedAt: new Date().toISOString() });
  assert.equal(r.applied, 1);
  assert.equal((await me(vic)).email_problem, null);
  assert.equal(subjects('vic.boss@repair.example').filter((x: string) => /not arriving/.test(x)).length, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='vic.customer@repair.example' AND bounce_kind IS NOT NULL").n, 0, 'no other email was marked');
  assert.ok(listedFor(await accountOf(stranger), 'vic.customer@repair.example'));
  // A stranger's invitation, refused the same way, is about the stranger's words, not about the customer's mailbox.
  assert.equal((await stranger.post('/account/invites', { email: 'vic.customer@repair.example', role: 'member' })).status, 200);
  const inv = lastMail('vic.customer@repair.example');
  assert.match(inv.subject, /invited you/);
  assert.equal((await ok({ type: 'bounce', email: 'vic.customer@repair.example', mail_id: String(inv.id), reason: '550 5.7.1 content policy' })).applied, 1);
  assert.equal((await me(vic)).email_problem, null);
  // An id that names no email here is logged and left alone, never guessed at by the address.
  const seen = await logged(async () => assert.equal((await ok({ type: 'bounce', email: to, mail_id: '987654321', reason: 'user unknown' })).unmatched, 1));
  assert.ok(seen.some((l) => /named an email of ours by its number or Message-ID, but no such email is here/.test(l)), seen.join('\n'));
  assert.equal(rec(h.eid, to).bounced_at, null);
  assert.equal((await ok({ type: 'complaint', email: to, message_id: 'sg-nothing@test.local' })).unmatched, 1);
  assert.equal(counted(await accountOf(honest)), 0);
});

test('news that names only an address touches only the one sender who wrote to it, never another account or a login', async () => {
  const spammer = await person('Spam Sender', 'spam.sender@repair.example');
  const honest = await person('Honest Hana', 'honest.hana@repair.example');
  await out(spammer, 'v1@yahoo.example');
  const hv = await out(honest, 'v1@yahoo.example');
  // Resend hands back no id of ours. Two accounts wrote to v1 in the last days, so whose email it was is unknown.
  const seen = await logged(async () => assert.equal((await ok(resend('v1@yahoo.example'))).unmatched, 1));
  assert.ok(seen.some((l) => /more than one sender here wrote to it/.test(l)), seen.join('\n'));
  assert.equal(counted(await accountOf(spammer)) + counted(await accountOf(honest)), 0);
  assert.equal(rec(hv.eid, 'v1@yahoo.example').complained_at, null);
  assert.equal(subjects('honest.hana@repair.example').filter((x: string) => /spam|paused/i.test(x)).length, 0);
  // One sender only: then it is that sender's email.
  const only = await out(honest, 'w1@yahoo.example');
  assert.equal((await ok(resend('w1@yahoo.example'))).applied, 1);
  assert.ok(rec(only.eid, 'w1@yahoo.example').complained_at);
  // A stranger's envelope and our own password reset to a customer: a bounce by address alone is nobody's.
  const vera = await person('Vera Victim', 'vera.victim@repair.example');
  const stranger = await person('Sid Stranger', 'sid.stranger@repair.example');
  const sv = await out(stranger, 'vera.victim@repair.example');
  assert.equal((await new Client().post('/auth/forgot', { email: 'vera.victim@repair.example' })).status, 200);
  const bounced = resend('vera.victim@repair.example', 'email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: '550 5.7.1 Message rejected due to content restrictions' } });
  assert.equal((await ok(bounced)).unmatched, 1);
  assert.equal((await me(vera)).email_problem, null);
  assert.equal(rec(sv.eid, 'vera.victim@repair.example').bounced_at, null);
  // Among one sender's emails, a bounce by address goes to one that has not arrived, not to one that has.
  const carl = await person('Carl Clash', 'carl.clash@repair.example');
  const one = await out(carl, 'shared@corp.example', { subject: 'First' });
  const two = await out(carl, 'shared@corp.example', { subject: 'Second' });
  await ok({ type: 'delivered', email: 'shared@corp.example', mail_id: String(lastMail('shared@corp.example', two.eid).id) });
  assert.equal((await ok({ type: 'bounce', email: 'shared@corp.example', reason: '550 5.1.1 user unknown' })).applied, 1);
  assert.ok(rec(one.eid, 'shared@corp.example').bounced_at);
  assert.equal(rec(two.eid, 'shared@corp.example').bounced_at, null);
});

test("a complaint is the person's own: a correction away and back, a new envelope or the copied link do not undo it", async () => {
  const c = await person('Pushy Sender', 'pushy.sender@repair.example');
  const acc = await accountOf(c);
  const to = 'please.stop@repair.example';
  const { eid, rid } = await out(c, to);
  await ok({ type: 'complaint', email: to, mail_id: String(lastMail(to, eid).id) });
  const before = mailTo(to).length;
  // Away: the new person is emailed like anyone else.
  assert.equal((await c.post(`/envelopes/${eid}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'someone.else@repair.example' })).status, 200);
  assert.equal(rec(eid, 'someone.else@repair.example').complained_at, null);
  // And back: the mark is back with the address, nothing goes to them, and the answer says so.
  const back = await c.post(`/envelopes/${eid}/correct`, { recipient_id: rid, name: 'Sam Signer', email: to });
  assert.equal(back.status, 200);
  assert.equal(back.data.not_emailed, 'marked_as_spam');
  assert.ok(rec(eid, to).complained_at);
  assert.equal(mailTo(to).length, before);
  assert.equal((await c.post(`/envelopes/${eid}/remind`, { recipient_id: rid })).data.code, 'marked_as_spam');
  assert.match(auditLine(eid, 'Not emailed').detail, /marked an earlier email from this account as spam/);
  // A new envelope of the same account goes out, without an email to them.
  const fresh = await out(c, to, { subject: 'Another try' });
  assert.ok(rec(fresh.eid, to).complained_at);
  assert.equal(mailTo(to).length, before);
  assert.match(auditLine(fresh.eid, 'Not emailed').detail, /from this account as spam/);
  // Another account is not bound by it.
  await out(await person('Other Sender', 'other.sender@repair.example'), to);
  assert.equal(mailTo(to).length, before + 1);
  // The copied link alone undoes nothing, also from a second login of the sender's that is not in the account: the
  // person's mailbox gets a code, and only typing it starts emails again.
  const alt = await person('Pushy Personal', 'pushy.personal@repair.example');
  const t = tokenFor(fresh.eid, to);
  const asked = await alt.post(`/sign/${t}/mail-again`);
  assert.deepEqual([asked.status, asked.data.code_sent, asked.data.sent_to], [200, true, to]);
  assert.equal(mailTo(to).length, before + 2, 'the code, and nothing else');
  assert.ok(rec(fresh.eid, to).complained_at);
  const wrongCode = codeIn(to) === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await alt.post(`/sign/${t}/mail-again`, { code: wrongCode })).status, 400);
  // After five wrong tries the code is spent, also for the right digits.
  const spent = await alt.post(`/sign/${t}/mail-again`, { code: codeIn(to) });
  assert.equal(spent.status, 429);
  assert.match(spent.data.error, /Ask for a new one/);
  // The person asks for a new one and types it: emails start again on every envelope of the account at that
  // address, and the report the mail provider made for them no longer counts towards a pause.
  const them = new Client();
  assert.equal((await them.post(`/sign/${t}/mail-again`)).data.code_sent, true);
  // A code that ran out is refused in words.
  db.run('UPDATE mail_again_codes SET expires_at=? WHERE recipient_id=?', daysAgo(0.01), rec(fresh.eid, to).id);
  assert.equal((await them.post(`/sign/${t}/mail-again`, { code: codeIn(to) })).status, 410);
  assert.equal((await them.post(`/sign/${t}/mail-again`)).data.code_sent, true);
  assert.equal((await them.post(`/sign/${t}/mail-again`, { code: codeIn(to) })).data.changed, true);
  assert.equal(rec(eid, to).complained_at, null);
  assert.equal(rec(fresh.eid, to).complained_at, null);
  assert.equal(counted(acc), 0);
  assert.equal(db.get('SELECT status FROM abuse_reports WHERE account_id=? AND reporter=?', acc, to).status, 'withdrawn');
  assert.equal((await c.post(`/envelopes/${fresh.eid}/remind`, { recipient_id: rec(fresh.eid, to).id })).status, 200);
  // At most three codes a day to one address, said in words, also across the links of several envelopes to it.
  const third = await out(c, 'daily.limit@repair.example');
  await ok({ type: 'complaint', email: 'daily.limit@repair.example', mail_id: String(lastMail('daily.limit@repair.example', third.eid).id) });
  const fourth = await out(c, 'daily.limit@repair.example', { subject: 'More' });
  const links = [third.eid, third.eid, fourth.eid, fourth.eid].map((x) => tokenFor(x, 'daily.limit@repair.example'));
  const tries: number[] = [];
  for (const l of links) tries.push((await new Client().post(`/sign/${l}/mail-again`)).status);
  assert.deepEqual(tries, [200, 200, 200, 429]);
  assert.equal(mailTo('daily.limit@repair.example').filter((x: any) => x.subject === 'Your code to get our emails again').length, 3);
});

test('an email waiting for another try is not delivered to someone who complained, or to an address that came back, since', async () => {
  const { retryMail } = await import('../src/server/mail.ts');
  const c = await person('Retry Sender', 'retry.sender@repair.example');
  const spam = await out(c, 'complains.later@repair.example');
  const dead = await out(c, 'dead.later@repair.example');
  const first = (to: string, eid: string) => db.get("SELECT id FROM emails WHERE envelope_id=? AND to_email=? AND status='outbox' ORDER BY id LIMIT 1", eid, to).id;
  const delivered: string[] = [];
  process.env.SMTP_URL = 'smtp://u:p@smtp.example.net:587';
  g.__tsmail = { sendMail: async () => { throw new Error('421 4.3.2 try later'); } };
  try {
    // Each reminder is refused by the mail server at first, and waits for the timer.
    for (const x of [spam, dead]) assert.equal((await c.post(`/envelopes/${x.eid}/remind`, { recipient_id: x.rid })).status, 200);
    const waiting = db.all("SELECT id FROM emails WHERE status='failed' AND next_try_at IS NOT NULL AND to_email IN ('complains.later@repair.example','dead.later@repair.example')");
    assert.equal(waiting.length, 2);
    await ok({ type: 'complaint', email: 'complains.later@repair.example', mail_id: String(first('complains.later@repair.example', spam.eid)) });
    await ok({ type: 'bounce', email: 'dead.later@repair.example', mail_id: String(first('dead.later@repair.example', dead.eid)), reason: '550 5.1.1 user unknown' });
    g.__tsmail = { sendMail: async (o: any) => void delivered.push(o.to) };
    for (const w of waiting) db.run('UPDATE emails SET next_try_at=? WHERE id=?', daysAgo(0.001), w.id);
    await retryMail();
    assert.deepEqual(delivered.filter((x) => x.endsWith('.later@repair.example')), []);
    const why = waiting.map((w: any) => db.get('SELECT status, next_try_at, error FROM emails WHERE id=?', w.id));
    assert.ok(why.every((w: any) => w.status === 'failed' && !w.next_try_at));
    const said = why.map((w: any) => w.error).join(' ');
    assert.match(said, /marked an earlier email as spam by then/);
    assert.match(said, /had come back for good by then/);
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
  }
});

test('"try later" counts for each sender apart, gives way to "delivered" in either order, and a third day that then arrives clears its marks', async () => {
  const other = await person('Other Account', 'other.account@repair.example');
  const hal = await person('Hal Honest', 'hal.honest@repair.example');
  const to = 'greylisted@corp.example';
  for (const d of [2, 1]) {
    const x = await out(other, to, { subject: `Earlier ${d}` });
    await ok({ type: 'soft_bounce', email: to, mail_id: String(lastMail(to, x.eid).id), reason: '451 4.7.1 greylisted, try later', at: daysAgo(d) });
  }
  const h = await out(hal, to);
  const hm = lastMail(to, h.eid);
  await ok({ type: 'soft_bounce', email: to, mail_id: String(hm.id), reason: '451 4.7.1 greylisted, try later', at: daysAgo(0.01) });
  assert.equal(rec(h.eid, to).bounced_at, null, "another account's days are not Hal's");
  assert.equal(subjects('hal.honest@repair.example').filter((x: string) => x.startsWith('Could not be delivered')).length, 0);
  assert.ok(!listedFor(await accountOf(hal), to));
  // Greylisting in order: "try later", then delivered. The page reads delivered, and the record says it arrived.
  await ok({ type: 'delivered', email: to, mail_id: String(hm.id), at: daysAgo(0.001) });
  const d = (await hal.get(`/envelopes/${h.eid}`)).data.deliveries.find((x: any) => x.to_email === to);
  assert.ok(d.delivered_at);
  assert.equal(d.bounce_kind, null);
  assert.match(auditLine(h.eid, 'Email delivered').detail, /reached their mail server after all/);
  // The other way round: a "try later" that arrives after "delivered" is old news and writes nothing.
  assert.equal((await ok({ type: 'soft_bounce', email: to, mail_id: String(hm.id), reason: '421 try later', at: daysAgo(0.005) })).repeat, 1);
  assert.equal(db.get('SELECT bounce_kind FROM emails WHERE id=?', hm.id).bounce_kind, null);
  assert.equal(actions(h.eid).filter((x: string) => x === 'Email not delivered yet').length, 1);
  // Three days of "mailbox full" from one sender mark the person and the address, and keep the email itself
  // "not delivered yet". When that same email arrives after all, every mark it set goes.
  const c = await person('Full Box', 'full.box.sender@repair.example');
  const box = 'nearly.full@corp.example';
  for (const dd of [2, 1]) {
    const x = await out(c, box, { subject: `Earlier ${dd}` });
    await ok({ type: 'soft_bounce', email: box, mail_id: String(lastMail(box, x.eid).id), reason: '452 4.2.2 mailbox full', at: daysAgo(dd) });
  }
  const today = await out(c, box, { subject: 'Today' });
  const m = lastMail(box, today.eid);
  await ok({ type: 'soft_bounce', email: box, mail_id: String(m.id), reason: '452 4.2.2 mailbox full' });
  assert.equal(rec(today.eid, box).bounce_reason, 'the mailbox is full, on 3 separate days');
  assert.ok(listedFor(await accountOf(c), box));
  assert.equal(db.get('SELECT bounce_kind FROM emails WHERE id=?', m.id).bounce_kind, 'soft');
  await ok({ type: 'delivered', email: box, mail_id: String(m.id) });
  assert.equal(rec(today.eid, box).bounced_at, null);
  assert.ok(!listedFor(await accountOf(c), box));
  assert.equal((await c.post(`/envelopes/${today.eid}/remind`, { recipient_id: today.rid })).status, 200);
});

test('what a mail server wrote never reaches a customer: the sender, the record and the page get our own words', async () => {
  const c = await person('Honest Sender', 'honest.sender@repair.example');
  const to = 'ceo@typo-squat.example';
  const { eid } = await out(c, to);
  const evil = '550 5.1.1 GrowSigning security notice: your account is suspended. Restore it at www.growsigning-help.example/restore or call +1 800 555 0100';
  await ok({ type: 'bounce', email: to, mail_id: String(lastMail(to, eid).id), reason: evil });
  const told = mailTo('honest.sender@repair.example').find((x: any) => x.subject.startsWith('Could not be delivered'));
  const plainPart = JSON.parse(db.get("SELECT payload FROM emails WHERE to_email='honest.sender@repair.example' AND subject LIKE 'Could not be delivered%'").payload).text;
  for (const said of [text(told.html), plainPart, auditLine(eid, 'Email could not be delivered').detail, JSON.stringify((await c.get(`/envelopes/${eid}`)).data)])
    assert.doesNotMatch(said, /security notice|growsigning-help|800 555|mail server said/i);
  assert.match(text(told.html), /could not be delivered: no such mailbox\./);
  // The people who run the server see what it said, without anything that reads like a place to go.
  const row = (await new Client().get('/dev/outbox')).data.emails.find((x: any) => x.to_email === to);
  assert.equal(row.bounce_reason, 'no such mailbox');
  assert.match(row.bounce_said, /security notice/);
  assert.doesNotMatch(row.bounce_said, /www|growsigning-help\.example/);
  const { cleanReason, readEvents, bounceWhy } = await import('../src/server/bounces.ts');
  for (const s of ['hxxps://evil.example', 'HTTPS://EVIL.EXAMPLE/x', 'evil.example/login', 'https:/\\evil.example', 'ftp://evil.example', 'mailto:help@evil.example', 'javascript:alert(1)', 'data:text/html,hi', 'www.evil.example'])
    assert.equal(cleanReason(`550 ${s} now`), '550 now', s);
  assert.equal(cleanReason('a‮b​c⁦d'), 'abcd');
  // What each provider's own list means, in our words. SendGrid's "dropped" says why, and why decides.
  const plainOf = (x: any) => readEvents(x)!.events.map((e: any) => [e.type, bounceWhy(e.reason, true).plain]);
  const dropped = (reason: string) => plainOf([{ email: 'a@example.com', timestamp: 1700000000, event: 'dropped', sg_event_id: 'x', reason }]);
  assert.deepEqual(dropped('Bounced Address'), [['bounce', 'the mail provider no longer sends to this address, because earlier emails to it came back']]);
  assert.deepEqual(dropped('Invalid'), [['bounce', 'no such mailbox']]);
  assert.deepEqual(dropped('Spam Reporting Address'), [['bounce', 'the mail provider no longer sends to this address, because an email to it was marked as spam']]);
  for (const r of ['Unsubscribed Address', 'Invalid SMTPAPI header', 'Recipient List over Package Quota']) assert.equal(dropped(r)[0][0], 'not_sent', r);
  assert.deepEqual(plainOf({ signature: {}, 'event-data': { event: 'failed', severity: 'permanent', reason: 'suppress-complaint', recipient: 'a@example.com', 'delivery-status': { code: 607, description: 'Not delivering to a user who marked your messages as spam' } } }),
    [['bounce', 'the mail provider no longer sends to this address, because an email to it was marked as spam']]);
  // A list that does not say why is not guessed at.
  assert.deepEqual(plainOf({ RecordType: 'Bounce', Type: 'ManuallyDeactivated', Email: 'a@example.com', Details: '' }), [['bounce', 'the mail provider no longer sends to this address, after earlier emails to it came back or were marked as spam']]);
  // Not sent because of a setting on our side: nothing is marked, listed or emailed. The record says it, and the log.
  const q = await out(c, 'quota.hit@repair.example');
  const qm = lastMail('quota.hit@repair.example', q.eid);
  const told0 = subjects('honest.sender@repair.example').length;
  const seen = await logged(async () => assert.equal((await ok([{ email: 'quota.hit@repair.example', timestamp: Math.floor(Date.now() / 1000), event: 'dropped', sg_event_id: 'q', reason: 'Recipient List over Package Quota', sg_mail: String(qm.id) }])).applied, 1));
  assert.ok(seen.some((l) => /did not send email \d+, because of a setting there: "Recipient List over Package Quota"/.test(l)), seen.join('\n'));
  assert.equal(rec(q.eid, 'quota.hit@repair.example').bounced_at, null);
  assert.ok(!listedFor(await accountOf(c), 'quota.hit@repair.example'));
  assert.match(auditLine(q.eid, 'Email not delivered yet').detail, /was not sent: our mail provider did not send it, because of a setting on our side/);
  assert.equal(subjects('honest.sender@repair.example').length, told0);
  // The help page promises an email at once only to a sender who did not switch that notice off.
  const fs = await import('node:fs');
  const help = fs.readFileSync(new URL('../src/app/help/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(help, /We email you at once, and the envelope/);
  assert.match(help, /we email you at once unless you switched off &quot;When something needs you&quot;/);
});

test('a login that moved to another address and is then deleted takes our copies of the emails to the old address along', async () => {
  const old = 'mover.old@repair.example';
  const c = await person('Mia Mover', old);
  assert.equal((await c.post('/me/email', { email: 'mover.new@repair.example', password: PW })).status, 200);
  const t = new URL(lastMail('mover.new@repair.example').link).searchParams.get('token');
  assert.equal((await c.post('/me/email/confirm', { token: t })).status, 200);
  assert.ok(subjects(old).includes('The email address of your GrowSigning login was changed'));
  assert.equal((await c.post('/me/delete', { password: PW, now: true })).status, 200);
  assert.deepEqual(subjects(old), []);
});

test('Amazon SNS: only the confirmation of the topic itself is fetched, and shapes inside it nobody knows are logged', async () => {
  const real = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: any, init?: any) => {
    if (/amazonaws\.com(\.cn)?$/.test(new URL(String(u)).hostname)) return (fetched.push(String(u)), new Response('<ConfirmSubscriptionResponse/>', { status: 200 }));
    return real(u, init);
  }) as any;
  try {
    const topic = 'arn:aws:sns:eu-west-1:123456789012:ses';
    const confirm = (SubscribeURL: string, TopicArn = topic) => events({ Type: 'SubscriptionConfirmation', MessageId: 'm', Token: 't', TopicArn, Message: 'x', SubscribeURL });
    const q = (host: string, action = 'ConfirmSubscription', arn = topic) => `https://${host}/?Action=${action}&TopicArn=${arn}&Token=t`;
    for (const bad of [q('sns.s3.amazonaws.com'), q('sns.s3-accelerate.amazonaws.com'), q('sns.s3-us-west-2.amazonaws.com'), q('sns.eu-west-1.amazonaws.com', 'Unsubscribe'),
      q('sns.eu-west-1.amazonaws.com', 'ConfirmSubscription', 'arn:aws:sns:eu-west-1:999999999999:other'), 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription'])
      assert.match((await confirm(bad)).data.subscription, /^not confirmed/, bad);
    assert.deepEqual(fetched, []);
    for (const host of ['sns.eu-west-1.amazonaws.com', 'sns.cn-north-1.amazonaws.com.cn', 'sns.us-gov-west-1.amazonaws.com']) assert.equal((await confirm(q(host))).data.subscription, 'confirmed', host);
    assert.equal(fetched.length, 3);
  } finally {
    globalThis.fetch = real;
  }
  // JSON inside a Notification that no adapter knows is a shape this server does not know: 202. An unsubscribe is
  // logged every time, because from then on no news comes.
  delete g.__tsmailEventsUnknown;
  const seen = await logged(async () => {
    assert.equal((await events({ Type: 'Notification', TopicArn: 'arn:x', Message: JSON.stringify({ someNewShape: { recipients: ['a@example.com'] } }) })).status, 202);
    assert.equal((await events({ Type: 'UnsubscribeConfirmation', TopicArn: 'arn:x', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/' })).status, 200);
  });
  assert.ok(seen.some((l) => /shape this server does not know/.test(l)));
  assert.ok(seen.some((l) => /was unsubscribed from a topic/.test(l)));
});

test('a batch is read to its end or refused whole, and a slow mail server does not keep the provider waiting', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'delivered', email: `nobody${i}@batch.example` }));
  const r = await ok(many(2001));
  assert.deepEqual([r.events, r.unmatched], [2001, 2001]);
  const big = await events(many(5001));
  assert.equal(big.status, 413);
  assert.match(big.data.error, /none of it was read\. Send it in smaller batches/);
  // A mail server that takes a while for each email: the marks are made at once, the answer goes, and the sender
  // is told right after.
  const c = await person('Slow Server', 'slow.server@repair.example');
  const x = await out(c, 'gone.slow@repair.example');
  const m = lastMail('gone.slow@repair.example', x.eid);
  process.env.SMTP_URL = 'smtp://u:p@smtp.example.net:587';
  g.__tsmail = { sendMail: () => new Promise((res) => setTimeout(res, 400)) };
  g.__tsmailEventsAnswerMs = 50;
  try {
    const t0 = Date.now();
    const slow = await events({ type: 'bounce', email: 'gone.slow@repair.example', mail_id: String(m.id), reason: 'user unknown' });
    assert.equal(slow.status, 202);
    assert.ok(Date.now() - t0 < 350, 'answered before the mail server finished');
    assert.ok(rec(x.eid, 'gone.slow@repair.example').bounced_at, 'marked at once');
    await g.__tsmailEventsWork;
    assert.equal(subjects('slow.server@repair.example').filter((s: string) => s.startsWith('Could not be delivered')).length, 1);
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
    delete g.__tsmailEventsAnswerMs;
  }
});

test('a secret with "+" in it works pasted into the address as it is', async () => {
  try {
    process.env.MAIL_EVENTS_TOKEN = 'ab+cd/ef==gh+ij/kl==';
    assert.equal((await events({ type: 'delivered', email: 'n@example.com' }, { auth: `?token=${process.env.MAIL_EVENTS_TOKEN}` })).status, 200);
    assert.equal((await events({ type: 'delivered', email: 'n@example.com' }, { auth: `?token=${encodeURIComponent(process.env.MAIL_EVENTS_TOKEN)}` })).status, 200);
    assert.equal((await events({ type: 'delivered', email: 'n@example.com' }, { auth: '?token=ab cd/ef==gh+ij/kl==', headers: { 'x-forwarded-for': '198.51.100.31' } })).status, 401);
  } finally {
    process.env.MAIL_EVENTS_TOKEN = TOKEN;
  }
});

test('the code that starts emails again reaches only the mailbox: never the subject the sender sees, and not our stored copy', async () => {
  const c = await person('Nosy Sender', 'nosy.sender@repair.example');
  const to = 'only.mine@repair.example';
  const { eid } = await out(c, to);
  await ok({ type: 'complaint', email: to, mail_id: String(lastMail(to, eid).id) });
  const seen: any[] = [];
  process.env.SMTP_URL = 'smtp://u:p@smtp.example.net:587';
  g.__tsmail = { sendMail: async (o: any) => void seen.push(o) };
  try {
    assert.equal((await new Client().post(`/sign/${tokenFor(eid, to)}/mail-again`)).data.delivery, 'sent');
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
  }
  const code = /(\d{6}) is your code/.exec(seen.find((o) => o.to === to)?.html || '')?.[1];
  assert.ok(code, 'the mailbox got it');
  assert.doesNotMatch(JSON.stringify((await c.get(`/envelopes/${eid}`)).data), new RegExp(code!));
  const stored = db.get("SELECT subject, html, payload FROM emails WHERE to_email=? AND subject='Your code to get our emails again'", to);
  assert.doesNotMatch(stored.subject + stored.html + stored.payload, new RegExp(code!));
});
