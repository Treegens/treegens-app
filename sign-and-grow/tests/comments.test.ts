// Questions and comments on a document while it is out (src/server/comments.ts, src/server/routes-comments.ts):
// who reads which thread, who is emailed and how often, the rules that guard an email in the sender's name, the
// record, the limits, the person who signs in person on the sender's device, and the API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, Client, signUp, upload, signAll, mailTo, tokenFor, type Server } from './helpers.ts';
import { COMMENT_MAX_CHARS, COMMENTS_PER_PERSON, COMMENT_BURST, COMMENTS_NOT_SIGNED } from '../src/lib/policy.ts';
import { pinWords } from '../src/lib/comments.ts';

let db: Server['db'];
let cron: Server['cron'];
let flush: () => Promise<{ mailed: number; held: number }>;
before(async () => {
  ({ db, cron } = await boot());
  flush = (await import('../src/server/routes-comments.ts')).flushComments;
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.77.${++n}.9`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const auditOf = (eid: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const later = () => db.run("UPDATE comment_news SET mailed_at=? WHERE mailed_at IS NOT NULL", new Date(Date.now() - 11 * 60_000).toISOString());
const withKey = (key: string) => {
  const c = browser();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};

// Two people who sign at the same time. `tag` keeps every envelope's addresses apart.
async function out(c: Client, tag: string, over: any = {}) {
  const file = await upload(c, 2);
  const r = await c.post('/envelopes', {
    subject: `Lease ${tag}`, send: true,
    documents: [{ id: 'd', file_id: file.id, name: 'Lease' }],
    recipients: [
      { id: 'a', role: 'signer', name: 'Ada Tenant', email: `ada.${tag}@example.com` },
      { id: 'b', role: 'signer', name: 'Ben Landlord', email: `ben.${tag}@example.com` },
    ],
    fields: [
      { id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
    ],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  assert.equal(e.status, 'sent');
  const rid = (email: string) => e.recipients.find((x: any) => x.email === email)?.id;
  return { e, doc: e.documents[0].id, ada: tokenFor(e.id, `ada.${tag}@example.com`), ben: tokenFor(e.id, `ben.${tag}@example.com`), adaId: rid(`ada.${tag}@example.com`), benId: rid(`ben.${tag}@example.com`) };
}

// ---- 1. Who reads what ---------------------------------------------------------------------------------------

test('a question is private to the sender unless the person chooses everyone, and nobody reads a private thread they are not in', async () => {
  const s = await person('Sal Sender', 'sal@comments.example');
  const { e, doc, ada, ben } = await out(s, 'p1');
  const A = browser(), B = browser();
  const q = await A.post(`/sign/${ada}/comments`, { text: 'Is the deposit in clause 4 refundable?' });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.deepEqual([q.data.threads.length, q.data.threads[0].private, q.data.threads[0].mine, q.data.waiting], [1, true, true, 1], 'private is the usual, and it waits for an answer');
  const pub = await B.post(`/sign/${ben}/comments`, { text: 'I have initialled page 2 already.', for: 'everyone', pin: { document_id: doc, page: 1, x: 0.8, y: 0.1 } });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));

  // Ben reads his own thread for everyone and nothing of Ada's question; Ada reads both.
  const byBen = (await B.get(`/sign/${ben}/comments`)).data;
  assert.deepEqual(byBen.threads.map((t: any) => t.private), [false]);
  assert.equal(JSON.stringify(byBen).includes('deposit'), false);
  assert.equal(byBen.threads[0].pin_words, 'page 2, near the top on the right');
  const byAda = (await A.get(`/sign/${ada}/comments`)).data;
  assert.deepEqual(byAda.threads.map((t: any) => [t.private, t.mine]), [[true, true], [false, false]]);
  assert.equal(byAda.threads[0].with, null, 'a signing page is not told who else a private thread could be with');

  // The sender's side reads every thread, knows who the private one is with, and who waits for an answer.
  const all = (await s.get(`/envelopes/${e.id}/comments`)).data;
  assert.equal(all.threads.length, 2);
  assert.deepEqual(all.threads[0].with.name, 'Ada Tenant');
  assert.deepEqual(all.waiting.map((w: any) => w.name), ['Ada Tenant', 'Ben Landlord']);
  assert.equal(all.threads[0].comments[0].email, 'ada.p1@example.com');

  // Ben cannot reach Ada's thread by its id. It is answered exactly like a thread that does not exist.
  const sneak = await B.post(`/sign/${ben}/comments`, { text: 'Let me in', thread_id: q.data.thread_id });
  const none = await B.post(`/sign/${ben}/comments`, { text: 'Let me in', thread_id: 'thr_nothing' });
  assert.deepEqual([sneak.status, none.status], [404, 404]);
  assert.equal(sneak.data.error, none.data.error);
  assert.equal((await B.post(`/sign/${ben}/comments/${q.data.thread_id}/settle`)).status, 404);
  assert.equal(db.get('SELECT COUNT(*) n FROM comments WHERE thread_id=?', q.data.thread_id).n, 1, 'nothing was added to it');

  // No email to Ben carries Ada's words, and the audit trail carries nobody's words.
  assert.ok(mailTo('ben.p1@example.com').every((m: any) => !m.html.includes('deposit')));
  const lines = auditOf(e.id).filter((a: any) => a.action === 'Comment');
  assert.deepEqual(lines.map((a: any) => a.detail.split('.')[0]), ['Ada Tenant wrote a comment', 'Ben Landlord wrote a comment']);
  assert.ok(lines[0].actor.startsWith('Ada Tenant <ada.p1@example.com>'), 'by whom');
  assert.ok(auditOf(e.id).every((a: any) => !/deposit|initialled/.test(a.detail)), 'never what it says');
});

test('a private thread stays with the person: when their place passes to someone else, the next one never reads it or is emailed about it', async () => {
  const s = await person('Pam Sender', 'pam@comments.example');
  const { e, ada, adaId } = await out(s, 'p2');
  const A = browser();
  const q = await A.post(`/sign/${ada}/comments`, { text: 'Between us: can the rent be lower?' });
  assert.equal(q.status, 200);
  assert.equal((await A.post(`/sign/${ada}/reassign`, { name: 'Carl Cousin', email: 'carl.p2@example.com', reason: 'He is the tenant' })).status, 200);
  const carl = tokenFor(e.id, 'carl.p2@example.com');
  const C = browser();
  const seen = (await C.get(`/sign/${carl}/comments`)).data;
  assert.deepEqual(seen.threads, []);
  assert.equal((await C.post(`/sign/${carl}/comments`, { text: 'Hello?', thread_id: q.data.thread_id })).status, 404);
  // The sender answers Ada's question: it is not emailed to Carl, and the sender is told why.
  const a = await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.data.thread_id, text: 'Lower rent is possible after a year.' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data.told.map((t: any) => [t.to, t.mailed_at, t.not_emailed]), [['Ada Tenant', null, 'Someone else has their place on the document now.']]);
  assert.ok(mailTo('carl.p2@example.com').every((m: any) => !/rent/.test(m.html)));
  // A private thread started on that place now is with Carl, as a new person.
  const w = await s.post(`/envelopes/${e.id}/comments`, { for: adaId, text: 'Welcome, Carl.' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.deepEqual((await C.get(`/sign/${carl}/comments`)).data.threads.map((t: any) => t.comments[0].body), ['Welcome, Carl.']);
});

test('"Ask the sender a question" is a private comment now: one way to ask, answered where it was asked', async () => {
  const s = await person('Quin Sender', 'quin@comments.example');
  const { e, ada, ben } = await out(s, 'p3');
  const A = browser();
  const asked = await A.post(`/sign/${ada}/ask`, { message: 'Can I sign on paper instead?' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.deepEqual(asked.data.threads.map((t: any) => [t.private, t.comments[0].body]), [[true, 'Can I sign on paper instead?']]);
  assert.deepEqual((await browser().get(`/sign/${ben}/comments`)).data.threads, []);
  const mail = mailTo('quin@comments.example').filter((m: any) => m.subject === 'Questions and comments: Lease p3');
  assert.equal(mail.length, 1);
  assert.match(text(mail[0].html), /Ada Tenant, privately: Can I sign on paper instead\?/);
  assert.match(text(mail[0].html), /Answer on the document's page\. They see your answer on their signing page, and we email it to them\./);
  // Writing the question again is not a second way in: it lands in the same list.
  assert.equal((await s.get(`/envelopes/${e.id}/comments`)).data.threads.length, 1);
});

test('a visitor of a public form writes to the form\'s owner only: they typed their own name, and the others on it did not choose them', async () => {
  const s = await person('Fay Former', 'fay@comments.example');
  const tpl = await (async () => {
    const file = await upload(s, 1);
    const r = await s.post('/envelopes', { kind: 'template', subject: 'Volunteer form', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'v', role: 'signer', role_name: 'Volunteer' }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'v', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.envelope;
  })();
  const form = await s.post('/powerforms', { template_id: tpl.id, name: 'Volunteers' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  const slug = form.data.powerform?.slug || db.get('SELECT slug FROM powerforms WHERE template_id=?', tpl.id).slug;
  const v = browser();
  const start = await v.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walkin.v1@example.com' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const tok = String(start.data.url).split('/sign/')[1];
  const page = (await v.get(`/sign/${tok}/comments`)).data;
  assert.equal(page.for_everyone, false);
  const all = await v.post(`/sign/${tok}/comments`, { text: 'Hello everyone', for: 'everyone' });
  assert.equal(all.status, 403);
  assert.equal(all.data.error, 'On a public form, what you write here goes to Fay Former only. Send it to them instead. Nothing was sent.');
  assert.equal((await v.post(`/sign/${tok}/comments`, { text: 'Can I bring a friend?' })).status, 200);
});

test('in a signing group, a private thread is with the member who wrote it, also once they have taken the document on', async () => {
  const s = await person('Gus Sender', 'gus@comments.example');
  const members = [{ name: 'Maya Lopez', email: 'maya.c1@hr.example' }, { name: 'Bo Ortiz', email: 'bo.c1@hr.example' }];
  const group = await s.post('/groups', { name: 'HR team', members });
  assert.equal(group.status, 200, JSON.stringify(group.data));
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', { subject: 'Handbook', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'g', role: 'signer', group_id: group.data.group.id }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  const link = (email: string) => db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', e.id, email).token;
  const M = browser(), B = browser();
  const q = await M.post(`/sign/${link('maya.c1@hr.example')}/comments`, { text: 'Only for you: is section 3 final?' });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.deepEqual((await B.get(`/sign/${link('bo.c1@hr.example')}/comments`)).data.threads, [], 'a colleague in the group does not read it');
  // The sender cannot write privately to a group nobody has taken on: there is no one person yet.
  const gid = e.recipients[0].id;
  const dm = await s.post(`/envelopes/${e.id}/comments`, { for: gid, text: 'To the group' });
  assert.equal(dm.status, 409);
  assert.match(dm.data.error, /Nobody in HR team has taken the document on yet/);
  // The sender answers Maya: she alone is emailed, with her own link.
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.data.thread_id, text: 'Yes, final.' })).status, 200);
  const toMaya = mailTo('maya.c1@hr.example').filter((m: any) => /wrote to you about/.test(m.subject));
  assert.equal(toMaya.length, 1);
  assert.equal(toMaya[0].link, `http://test.local/sign/${link('maya.c1@hr.example')}`);
  assert.ok(mailTo('bo.c1@hr.example').every((m: any) => !m.html.includes('section 3')));
  // Maya takes the document on: her thread is still hers.
  assert.equal((await M.post(`/sign/${link('maya.c1@hr.example')}/consent`)).status, 200);
  const hers = (await M.get(`/sign/${link('maya.c1@hr.example')}/comments`)).data;
  assert.deepEqual(hers.threads.map((t: any) => t.comments.length), [2]);
});

test('what anyone writes is shown as text: markup in a comment is never run or rendered, in an email or on a page', async () => {
  const s = await person('Esc Sender', 'esc@comments.example');
  const { e, ada } = await out(s, 'x1');
  const evil = '<img src=x onerror=alert(1)> <b>bold</b> & <a href="http://evil.example">click</a>';
  assert.equal((await browser().post(`/sign/${ada}/comments`, { text: evil })).status, 200);
  const mail = mailTo('esc@comments.example').filter((m: any) => m.subject === 'Questions and comments: Lease x1')[0];
  assert.doesNotMatch(mail.html, /<img src=x|<a href="http:\/\/evil/);
  assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal((await s.get(`/envelopes/${e.id}/comments`)).data.threads[0].comments[0].body, evil, 'kept exactly as typed; the pages print it as text');
});

// ---- 2. Telling people ---------------------------------------------------------------------------------------

test('the sender gets one email for new comments, at most one every ten minutes for each envelope, with the comments in it', async () => {
  const s = await person('Mia Sender', 'mia@comments.example');
  const { e, ada, ben } = await out(s, 'm1');
  const A = browser(), B = browser();
  const digests = () => mailTo('mia@comments.example').filter((m: any) => m.subject === 'Questions and comments: Lease m1');
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'First question about the rent.' })).status, 200);
  assert.equal(digests().length, 1, 'the first one goes at once');
  const first = text(digests()[0].html);
  assert.match(first, /Ada Tenant wrote about "Lease m1"/);
  assert.match(first, /First question about the rent\./);
  assert.ok(first.includes(COMMENTS_NOT_SIGNED));
  // One author with an address: replying writes to them, and the email says that reply is not kept.
  const payload = JSON.parse(db.get('SELECT payload FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', 'mia@comments.example').payload);
  assert.equal(payload.replyTo, 'ada.m1@example.com');
  assert.match(first, /Replying to this email writes to Ada Tenant \(ada\.m1@example\.com\) directly, and that reply is not kept with the document\./);

  assert.equal((await B.post(`/sign/${ben}/comments`, { text: 'Second, from Ben.', for: 'everyone' })).status, 200);
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Third, from Ada again.' })).status, 200);
  await flush();
  assert.equal(digests().length, 1, 'nothing more inside ten minutes');
  later();
  // The timer sends what waited, in one email.
  await cron.tick();
  assert.equal(digests().length, 2);
  const second = text(digests()[1].html);
  assert.match(second, /Ben Landlord and Ada Tenant wrote about "Lease m1"/, 'in the order they wrote');
  assert.match(second, /Ben Landlord, for everyone on the document: Second, from Ben\./);
  assert.match(second, /Third, from Ada again\./);
  assert.doesNotMatch(second, /First question/);
  assert.doesNotMatch(second, /Replying to this email writes/, 'two people: no single reply address');
  await flush();
  assert.equal(digests().length, 2, 'each comment is in one email only');
});

test('a person on the envelope is emailed when the sender answers them, and only then', async () => {
  const s = await person('Ned Sender', 'ned@comments.example');
  const { e, ada, ben, benId } = await out(s, 'a1');
  const A = browser(), B = browser();
  const qa = (await A.post(`/sign/${ada}/comments`, { text: 'Is parking included?' })).data;
  const qb = (await B.post(`/sign/${ben}/comments`, { text: 'Who pays for repairs?', for: 'everyone' })).data;
  const answers = (who: string) => mailTo(who).filter((m: any) => m.subject === 'Ned Sender wrote to you about: Lease a1');

  // A private answer goes to Ada alone, with her own link and the security code of her emails.
  const r1 = await s.post(`/envelopes/${e.id}/comments`, { thread_id: qa.thread_id, text: 'Yes, one space is included.' });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(answers('ada.a1@example.com').length, 1);
  const mail = answers('ada.a1@example.com')[0];
  assert.match(text(mail.html), /Ned Sender, privately: Yes, one space is included\./);
  assert.equal(mail.link, `http://test.local/sign/${ada}`);
  assert.match(mail.html, /\/check/);
  assert.equal(answers('ben.a1@example.com').length, 0);
  assert.ok(mailTo('ben.a1@example.com').every((m: any) => !m.html.includes('parking')));
  // Ada reads it on her page, and her question no longer waits.
  const page = (await A.get(`/sign/${ada}/comments`)).data;
  assert.deepEqual([page.threads[0].comments.length, page.threads[0].waiting, page.waiting], [2, false, 0]);

  // An answer in Ben's thread for everyone goes to Ben, who wrote in it. Ada did not, and is not emailed.
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: qb.thread_id, text: 'Repairs are on us.' })).status, 200);
  assert.equal(answers('ben.a1@example.com').length, 1);
  assert.equal(answers('ada.a1@example.com').length, 1);
  // A second answer to Ben inside ten minutes waits for the next email.
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: qb.thread_id, text: 'And the boiler too.' })).status, 200);
  assert.equal(answers('ben.a1@example.com').length, 1);
  later();
  await flush();
  assert.equal(answers('ben.a1@example.com').length, 2);
  assert.match(text(answers('ben.a1@example.com')[1].html), /And the boiler too\./);

  // A new comment for everyone emails nobody, and the sender is told so in words.
  const all = await s.post(`/envelopes/${e.id}/comments`, { for: 'everyone', text: 'The keys are with the neighbour.' });
  assert.equal(all.status, 200);
  assert.match(all.data.message, /Nobody is emailed about a new comment for everyone: each person sees it when they open the document\./);
  assert.deepEqual(all.data.told, []);
  assert.equal(answers('ada.a1@example.com').length, 1);
  // A private word to Ben, started by the sender, is for him and reaches him.
  later();
  const dm = await s.post(`/envelopes/${e.id}/comments`, { for: benId, text: 'Can you call me?' });
  assert.equal(dm.status, 200, JSON.stringify(dm.data));
  assert.equal(answers('ben.a1@example.com').length, 3);
  assert.equal(JSON.stringify((await A.get(`/sign/${ada}/comments`)).data).includes('Can you call me'), false);
});

test('what the sender writes follows the rules of every email in their name: refused when it reads like a fake payment notice, held while paused', async () => {
  const s = await person('Ora Sender', 'ora@comments.example');
  const accountId = (await s.get('/me')).data.account.id;
  const { e, ada } = await out(s, 'g1');
  const A = browser();
  const q = (await A.post(`/sign/${ada}/comments`, { text: 'When do I pay?' })).data;
  const before = db.get('SELECT COUNT(*) n FROM comments WHERE envelope_id=?', e.id).n;
  const lure = await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'PayPal invoice: your payment of $499.00 was charged. To cancel call +1 (888) 555-0142 now.' });
  assert.equal(lure.status, 422);
  assert.match(lure.data.error, /payment notice.*Nothing was sent\.$/);
  assert.equal(db.get('SELECT COUNT(*) n FROM comments WHERE envelope_id=?', e.id).n, before, 'nothing was saved');
  assert.ok(mailTo('ada.g1@example.com').every((m: any) => !m.html.includes('555-0142')));

  // While sending is paused the answer is saved and shown, and its email waits until the pause is lifted.
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports from recipients' WHERE id=?", new Date().toISOString(), accountId);
  const held = await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'In a week, by bank transfer.' });
  assert.equal(held.status, 200, JSON.stringify(held.data));
  assert.match(held.data.message, /It is not emailed while sending is paused, and goes out by itself once the pause is lifted\./);
  assert.deepEqual(held.data.told.map((t: any) => [t.mailed_at, t.not_emailed]), [[null, null]]);
  const ans = () => mailTo('ada.g1@example.com').filter((m: any) => /wrote to you about/.test(m.subject));
  assert.equal(ans().length, 0);
  assert.ok((await A.get(`/sign/${ada}/comments`)).data.threads[0].comments.some((c: any) => c.body === 'In a week, by bank transfer.'), 'shown on the page meanwhile');
  assert.equal((await flush()).held, 1);
  assert.equal(ans().length, 0);
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', accountId);
  await flush();
  assert.equal(ans().length, 1);
  assert.match(text(ans()[0].html), /In a week, by bank transfer\./);
});

test('someone with no address, and someone who marked our email as spam, are never emailed an answer, and the sender is told why', async () => {
  const s = await person('Lou Sender', 'lou@comments.example');
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', {
    subject: 'Shared by hand', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'w', role: 'signer', name: 'Wanjiru Kamau', email: '', link_by_sender: true }, { id: 'x', role: 'signer', name: 'Xia Spam', email: 'xia.h1@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'w', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'x', type: 'signature', page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  const w = db.get('SELECT token FROM recipients WHERE envelope_id=? AND name=?', e.id, 'Wanjiru Kamau').token;
  const W = browser();
  const q = (await W.post(`/sign/${w}/comments`, { text: 'Can I pay in cash?' })).data;
  const digest = mailTo('lou@comments.example').filter((m: any) => m.subject === 'Questions and comments: Shared by hand').at(-1)!;
  assert.match(text(digest.html), /Wanjiru Kamau has no email address here, so they are not emailed your answer\. They see it when they open their link again\./);
  assert.equal(JSON.parse(db.get('SELECT payload FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', 'lou@comments.example').payload).replyTo, null, 'no reply address that would go nowhere');
  const a = await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Yes, cash is fine.' });
  assert.deepEqual(a.data.told.map((t: any) => t.not_emailed), ['They have no email address here. They see it when they open their link again.']);
  assert.ok((await W.get(`/sign/${w}/comments`)).data.threads[0].comments.some((c: any) => c.body === 'Yes, cash is fine.'));

  const x = tokenFor(e.id, 'xia.h1@example.com');
  const X = browser();
  const qx = (await X.post(`/sign/${x}/comments`, { text: 'Is this real?' })).data;
  db.run('UPDATE recipients SET complained_at=? WHERE envelope_id=? AND email=?', new Date().toISOString(), e.id, 'xia.h1@example.com');
  const before = mailTo('xia.h1@example.com').length;
  const b = await s.post(`/envelopes/${e.id}/comments`, { thread_id: qx.thread_id, text: 'It is.' });
  assert.match(b.data.told[0].not_emailed, /marked an email about this document as spam/);
  assert.equal(mailTo('xia.h1@example.com').length, before);
});

// ---- 3. Before Finish --------------------------------------------------------------------------------------------

test('a question that waits for an answer is counted for the Finish step, and settling it is up to the person who asked or the sender', async () => {
  const s = await person('Ivy Sender', 'ivy@comments.example');
  const { e, ada, ben } = await out(s, 'f1');
  const A = browser(), B = browser();
  const q = (await A.post(`/sign/${ada}/comments`, { text: 'Is the end date right?', for: 'everyone' })).data;
  assert.equal(q.waiting, 1);
  assert.equal((await B.get(`/sign/${ben}/comments`)).data.waiting, 0, 'someone else\'s question is not theirs to wait for');
  // Ben may answer in it, but not settle it: it is Ada's question.
  assert.equal((await B.post(`/sign/${ben}/comments`, { thread_id: q.thread_id, text: 'Looks right to me.' })).status, 200);
  const no = await B.post(`/sign/${ben}/comments/${q.thread_id}/settle`);
  assert.equal(no.status, 403);
  assert.match(no.data.error, /Only the person who started this conversation, or the sender, can mark it as settled\./);
  assert.equal((await A.get(`/sign/${ada}/comments`)).data.waiting, 0, 'the last word is Ben\'s, not hers');
  assert.deepEqual((await s.get(`/envelopes/${e.id}/comments`)).data.waiting.map((w: any) => w.name), ['Ben Landlord']);
  const done = await A.post(`/sign/${ada}/comments/${q.thread_id}/settle`);
  assert.equal(done.status, 200);
  assert.ok(done.data.threads[0].settled_at);
  assert.deepEqual((await s.get(`/envelopes/${e.id}/comments`)).data.waiting, []);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Comment settled' && a.detail === 'Ada Tenant marked a conversation in the comments as settled.'));
  // A new word opens it again; the sender can settle it and open it once more.
  assert.equal((await A.post(`/sign/${ada}/comments`, { thread_id: q.thread_id, text: 'One more thing.' })).data.threads[0].settled_at, null);
  assert.ok((await s.post(`/envelopes/${e.id}/comments/${q.thread_id}/settle`)).data.threads[0].settled_at);
  assert.equal((await s.post(`/envelopes/${e.id}/comments/${q.thread_id}/settle`, { settled: false })).data.threads[0].settled_at, null);
});

// ---- 5. The record -----------------------------------------------------------------------------------------------

function unzip(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    out[b.subarray(i + 30, i + 30 + nameLen).toString('utf8')] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

test('comments are not on the signed document, the record says who and when and never what, the sender\'s export and evidence pack hold them, and once done they can be read and not changed', async () => {
  const s = await person('Rex Sender', 'rex@comments.example');
  const { e, ada, adaId } = await out(s, 'r1');
  const A = browser();
  const q = (await A.post(`/sign/${ada}/comments`, { text: 'Zanzibar clause question' })).data;
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Quokka answer here' })).status, 200);
  assert.equal((await signAll(e.id, 'ada.r1@example.com')).status, 200);
  assert.equal((await signAll(e.id, 'ben.r1@example.com')).status, 200);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');

  const { extractPages } = await import('../src/server/text.ts');
  const signed = (await extractPages((await s.get(`/envelopes/${e.id}/download`)).data)).join('\n');
  assert.match(signed, /wrote a comment/, 'the certificate\'s audit trail says a comment was written');
  assert.doesNotMatch(signed, /Zanzibar|Quokka/, 'and never what it says');

  // Read-only on both sides from now on, and still readable.
  const late = await A.post(`/sign/${ada}/comments`, { text: 'Too late?' });
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'read_only');
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Also too late' })).data.code, 'read_only');
  assert.equal((await s.post(`/envelopes/${e.id}/comments/${q.thread_id}/settle`)).status, 409);
  const kept = (await A.get(`/sign/${ada}/comments`)).data;
  assert.deepEqual([kept.may_write, kept.threads[0].comments.length], [false, 2]);
  assert.equal((await s.get(`/envelopes/${e.id}/comments`)).data.may_write, false);

  // The sender's export and evidence pack carry the threads in full.
  const zip = unzip((await s.get('/export')).data);
  const file = Object.keys(zip).find((k) => k.startsWith('comments/') && k.includes('Lease r1'))!;
  assert.ok(file, Object.keys(zip).join(', '));
  assert.match(zip[file].toString(), /private between the sender's side and Ada Tenant/);
  assert.match(zip[file].toString(), /Zanzibar clause question[\s\S]*Quokka answer here/);
  assert.match(zip['README.txt'].toString(), /comments\/ +the questions and comments/);
  const pack = unzip((await s.get(`/envelopes/${e.id}/evidence`)).data);
  assert.match(pack['comments.txt'].toString(), /Quokka answer here/);
  assert.equal(JSON.parse(pack['comments.json'].toString()).threads[0].with.recipient_id, adaId);
  assert.match(pack['README.txt'].toString(), /comments\.txt +the questions and comments/);
});

test('comments go with the envelope, and a draft has none', async () => {
  const s = await person('Del Sender', 'del@comments.example');
  const { e, ada } = await out(s, 'd1');
  await browser().post(`/sign/${ada}/comments`, { text: 'Something to delete.' });
  assert.equal((await s.post(`/envelopes/${e.id}/void`, { reason: 'Wrong flat' })).status, 200);
  // Closed: the signer no longer reads them, the sender still does.
  assert.equal((await browser().get(`/sign/${ada}/comments`)).data.code, 'closed');
  assert.equal((await s.get(`/envelopes/${e.id}/comments`)).data.threads.length, 1);
  assert.equal((await s.call('DELETE', `/envelopes/${e.id}`)).status, 200);
  assert.deepEqual([db.get('SELECT COUNT(*) n FROM comments WHERE envelope_id=?', e.id).n, db.get('SELECT COUNT(*) n FROM comment_threads WHERE envelope_id=?', e.id).n, db.get('SELECT COUNT(*) n FROM comment_news WHERE envelope_id=?', e.id).n], [0, 0, 0]);
  const file = await upload(s, 1);
  const d = (await s.post('/envelopes', { subject: 'Draft', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'X', email: 'x.d1@example.com' }] })).data.envelope;
  assert.equal((await s.get(`/envelopes/${d.id}/comments`)).data.code, 'draft');
});

// ---- 6. Limits -----------------------------------------------------------------------------------------------------

test('limits: the length with the count, 50 for each person, a burst limit for each link, control characters taken out, and nothing guessed', async () => {
  const s = await person('Lim Sender', 'lim@comments.example');
  const { e, doc, ada, ben } = await out(s, 'l1');
  const A = browser(), B = browser();
  const long = await A.post(`/sign/${ada}/comments`, { text: 'x'.repeat(COMMENT_MAX_CHARS + 1) });
  assert.equal(long.status, 400);
  assert.equal(long.data.error, `A comment can be up to ${COMMENT_MAX_CHARS} characters, and this one has ${COMMENT_MAX_CHARS + 1}. Make it shorter or split it in two. Nothing was sent.`);
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: '   \n ' })).data.error, 'Type your question or comment first. Nothing was sent.');
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: { evil: 1 } })).status, 400);
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Hi', for: 'all' })).status, 400, 'an unknown audience is not guessed');
  assert.match((await A.post(`/sign/${ada}/comments`, { text: 'Hi', pin: { document_id: doc, page: 2 } })).data.error, /"pin.page" counts from 0, and Lease has 2 pages/);
  assert.match((await A.post(`/sign/${ada}/comments`, { text: 'Hi', pin: { document_id: doc, page: 0, x: 0.5 } })).data.error, /both "pin.x" and "pin.y"/);
  assert.match((await A.post(`/sign/${ada}/comments`, { text: 'Hi', pin: { document_id: 'nope', page: 0 } })).data.error, /names no document on this envelope/);
  // Characters that print nothing, or turn the words round on someone else's screen, are taken out.
  const odd = await A.post(`/sign/${ada}/comments`, { text: 'Pay‮cash\u0007 now\r\nplease' });
  assert.equal(odd.data.threads.at(-1).comments[0].body, 'Paycash now\nplease');

  // A burst from one link: after COMMENT_BURST in ten minutes, the next is refused with what to do.
  for (let i = 0; i < COMMENT_BURST; i++) assert.equal((await B.post(`/sign/${ben}/comments`, { text: `Note ${i}` })).status, 200, `note ${i}`);
  const burst = await B.post(`/sign/${ben}/comments`, { text: 'One too many' });
  assert.equal(burst.status, 429);
  assert.match(burst.data.error, new RegExp(`That is ${COMMENT_BURST} comments in 10 minutes, which is as many as we take in that time\\. Nothing was sent\\. Wait \\d+ minutes? and send it again: what you typed is still in the box\\.`));
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Ada is not held up by Ben' })).status, 200);

  // Fifty for each person on one envelope, counted in the database.
  const adaAuthor = db.get('SELECT author FROM comments WHERE envelope_id=? AND name=? LIMIT 1', e.id, 'Ada Tenant').author;
  const have = db.get('SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND author=?', e.id, adaAuthor).n;
  const tid = db.get('SELECT thread_id t FROM comments WHERE author=? LIMIT 1', adaAuthor).t;
  for (let i = have; i < COMMENTS_PER_PERSON; i++) db.run('INSERT INTO comments (id, thread_id, envelope_id, author, name, body, at) VALUES (?,?,?,?,?,?,?)', `cmt_fill${i}`, tid, e.id, adaAuthor, 'Ada Tenant', 'filler', new Date().toISOString());
  const full = await A.post(`/sign/${ada}/comments`, { text: 'Number fifty-one' });
  assert.equal(full.status, 429);
  assert.match(full.data.error, new RegExp(`You have written ${COMMENTS_PER_PERSON} comments on this document, which is as many as one person can\\. Nothing was sent\\. If there is more to say, email Lim Sender \\(lim@comments\\.example\\)\\.`));
  assert.equal((await A.get(`/sign/${ada}/comments`)).data.left, 0);

  // The sender's side says who can read a new thread, every time.
  const unsaid = await s.post(`/envelopes/${e.id}/comments`, { text: 'Hello' });
  assert.equal(unsaid.status, 400);
  assert.match(unsaid.data.error, /^Say who can read it: "for": "everyone", or the id of one person on the envelope to write to them alone\. They are: .*Ada Tenant.*Nothing was sent\.$/);
});

test('someone whose turn has not come cannot read or write comments, and the sender cannot write to them privately yet', async () => {
  const s = await person('Tom Sender', 'tom@comments.example');
  const { e, ada, ben, benId } = await out(s, 't1', { ordered: true, recipients: [
    { id: 'a', role: 'signer', name: 'Ada Tenant', email: 'ada.t1@example.com', routing_order: 1 },
    { id: 'b', role: 'signer', name: 'Ben Landlord', email: 'ben.t1@example.com', routing_order: 2 },
  ] });
  const wait = await browser().get(`/sign/${ben}/comments`);
  assert.equal(wait.status, 403);
  assert.equal(wait.data.code, 'not_your_turn');
  assert.equal((await browser().post(`/sign/${ben}/comments`, { text: 'Early' })).status, 403);
  const dm = await s.post(`/envelopes/${e.id}/comments`, { for: benId, text: 'Hi Ben' });
  assert.equal(dm.status, 409);
  assert.match(dm.data.error, /It is not Ben Landlord's turn yet/);
  assert.deepEqual((await s.get(`/envelopes/${e.id}/comments`)).data.people.map((p: any) => p.name), ['Ada Tenant']);
  assert.equal((await browser().post(`/sign/${ada}/comments`, { text: 'Fine' })).status, 200);
});

test('a person who signs in person on the sender\'s device never sees the sender\'s private threads with other people', async () => {
  const s = await person('Hal Host', 'hal@comments.example');
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', {
    subject: 'Front desk', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'p', role: 'inperson', name: 'Pat Present', email: 'pat.i1@example.com' }, { id: 'a', role: 'signer', name: 'Ada Away', email: 'ada.i1@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  const ada = tokenFor(e.id, 'ada.i1@example.com');
  const pat = tokenFor(e.id, 'pat.i1@example.com');
  const q = (await browser().post(`/sign/${ada}/comments`, { text: 'Private salary question' })).data;
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Private salary answer' })).status, 200);
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { for: 'everyone', text: 'Welcome, everyone.' })).status, 200);

  // The host opens the in-person signing page in their own browser and hands the device over.
  assert.equal((await s.get(`/sign/${pat}`)).status, 200);
  const there = await s.get(`/sign/${pat}/comments`);
  assert.equal(there.status, 200);
  assert.deepEqual(there.data.threads.map((t: any) => t.comments[0].body), ['Welcome, everyone.']);
  assert.equal(JSON.stringify(there.data).includes('salary'), false);
  assert.equal(there.data.answers_to, null, 'nothing is emailed to someone who signs in person');
  // The host's own side of the comments is locked in that browser until the host types their password.
  assert.equal((await s.get(`/envelopes/${e.id}/comments`)).status, 401);
  // Pat asks: it reaches the host, and the host's answer is shown on the device, not emailed.
  const pq = (await s.post(`/sign/${pat}/comments`, { text: 'Can I take a copy home?' })).data;
  const desk = browser();
  assert.equal((await desk.post('/auth/login', { email: 'hal@comments.example', password: PW })).status, 200);
  const a = await desk.post(`/envelopes/${e.id}/comments`, { thread_id: pq.thread_id, text: 'Yes, it is emailed to you.' });
  assert.match(a.data.told[0].not_emailed, /sign in person on your device/);
});

// ---- 7. The API ----------------------------------------------------------------------------------------------------

test('an API key lists and writes the sender\'s side, it is described, and a webhook says when a comment is written', async () => {
  const hits: any[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => (hits.push(JSON.parse(b)), res.end('ok')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const s = await person('Kay Sender', 'kay@comments.example');
    assert.equal((await s.post('/webhooks', { url: `http://127.0.0.1:${(server.address() as any).port}/hook`, events: ['comment.created'] })).status, 200);
    const api = withKey((await s.post('/api-keys', { name: 'crm' })).data.key);
    const { e, ada } = await out(s, 'k1');
    const q = (await browser().post(`/sign/${ada}/comments`, { text: 'Question through the page' })).data;
    const listed = await api.get(`/envelopes/${e.id}/comments`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.threads.map((t: any) => [t.private, t.comments[0].body]), [[true, 'Question through the page']]);
    const w = await api.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Answer through the API' });
    assert.equal(w.status, 200, JSON.stringify(w.data));
    assert.equal(mailTo('ada.k1@example.com').filter((m: any) => m.subject === 'Kay Sender wrote to you about: Lease k1').length, 1);
    for (let i = 0; i < 100 && hits.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(hits.map((h) => [h.event, h.comment.by_sender, h.comment.private, h.comment.text]), [['comment.created', false, true, 'Question through the page'], ['comment.created', true, true, 'Answer through the API']]);
    assert.equal(hits[0].recipient_id, e.recipients.find((r: any) => r.email === 'ada.k1@example.com').id);
    // Another account's key finds nothing there.
    const other = withKey((await (await person('Oth Er', 'other@comments.example')).post('/api-keys', { name: 'x' })).data.key);
    assert.equal((await other.get(`/envelopes/${e.id}/comments`)).status, 404);
    assert.equal((await other.post(`/envelopes/${e.id}/comments`, { for: 'everyone', text: 'Hi' })).status, 404);
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    server.close();
  }
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.paths['/envelopes/{id}/comments'].get && spec.paths['/envelopes/{id}/comments'].post && spec.paths['/envelopes/{id}/comments/{thread}/settle'].post);
  assert.ok(spec.components.schemas.WebhookEvent.properties.event.enum.includes('comment.created'));
  assert.ok(String(spec.paths['/envelopes/{id}/comments'].post.description).includes(COMMENTS_NOT_SIGNED) || String(spec.paths['/envelopes/{id}/comments'].get.description).includes(COMMENTS_NOT_SIGNED));
});

test('the words for a pinned place', () => {
  assert.equal(pinWords({ document_id: 'd', document: 'Lease', page: 0 }), 'page 1');
  assert.equal(pinWords({ document_id: 'd', document: 'Lease', page: 2, x: 0.1, y: 0.9 }, 2), 'Lease, page 3, near the bottom on the left');
  assert.equal(pinWords({ document_id: 'd', document: 'Lease', page: 0, x: 0.5, y: 0.5 }), 'page 1, near the middle');
  assert.equal(pinWords(null), '');
});
