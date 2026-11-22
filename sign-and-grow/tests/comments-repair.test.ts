// Repairs to questions and comments after a skeptic's report (research/verify-new.json "verify:comments"): two people
// signing in person on one device, the fake-payment-notice filter across comments and names, what happens to an
// answer the filter refuses, a public form's stranger, settling and opening again, the webhook log after deleting,
// and the smaller things (refused requests and the burst, who is really emailed, the admin's read of a removed
// envelope, the same comment twice).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, signAll, mailTo, tokenFor, PNG, type Server } from './helpers.ts';

let db: Server['db'];
let cron: Server['cron'];
let flush: (envelopeId?: string) => Promise<{ mailed: number; held: number; dropped: number }>;
before(async () => {
  ({ db, cron } = await boot());
  flush = (await import('../src/server/routes-comments.ts')).flushComments;
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.79.${++n}.11`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const later = () => db.run('UPDATE comment_news SET mailed_at=? WHERE mailed_at IS NOT NULL', new Date(Date.now() - 11 * 60_000).toISOString());

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
  const rid = (email: string) => e.recipients.find((x: any) => x.email === email)?.id;
  return { e, doc: e.documents[0].id, ada: tokenFor(e.id, `ada.${tag}@example.com`), ben: tokenFor(e.id, `ben.${tag}@example.com`), adaId: rid(`ada.${tag}@example.com`), benId: rid(`ben.${tag}@example.com`) };
}

// Two people who sign in person, one after the other, on the host's device.
async function desk(s: Client, tag: string) {
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', {
    subject: `Desk ${tag}`, send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'p', role: 'inperson', name: 'Pat Present', email: `pat.${tag}@example.com` }, { id: 'q', role: 'inperson', name: 'Quinn Second', email: `quinn.${tag}@example.com` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'q', type: 'signature', page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  return { e, pat: tokenFor(e.id, `pat.${tag}@example.com`), quinn: tokenFor(e.id, `quinn.${tag}@example.com`) };
}
const finish = async (c: Client, tok: string) => {
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  const done = await c.post(`/sign/${tok}/complete`, { values: Object.fromEntries((v.fields || []).map((f: any) => [f.id, '1'])), signature_png: PNG, initials_png: PNG });
  assert.equal(done.status, 200, JSON.stringify(done.data));
};

// ---- 1. Signing in person, one person after the other, on one device (decision 1) -------------------------------

test('on the host\'s laptop, the next person signing in person never reads the earlier one\'s private thread, also through Back and after they finished', async () => {
  const s = await person('Hal Host', 'hal@cr.example');
  const { e, pat, quinn } = await desk(s, 'd1');
  // The host clicks "Host signing now" for Pat: the account locks in this browser, and Pat asks privately.
  assert.equal((await s.get(`/sign/${pat}`)).status, 200);
  const pq = await s.post(`/sign/${pat}/comments`, { text: 'Pat private: can I sublet without Quinn knowing?' });
  assert.equal(pq.status, 200, JSON.stringify(pq.data));
  const phone = browser();
  assert.equal((await phone.post('/auth/login', { email: 'hal@cr.example', password: PW })).status, 200);
  assert.equal((await phone.post(`/envelopes/${e.id}/comments`, { thread_id: pq.data.thread_id, text: 'HOST ANSWER: yes, quietly.' })).status, 200);
  const mine = (await s.get(`/sign/${pat}/comments`)).data;
  assert.ok(JSON.stringify(mine).includes('quietly'), 'Pat reads her own thread while she holds the device');
  assert.equal(mine.away, null);
  await finish(s, pat);

  // The host types the password and hands the laptop to Quinn. Quinn goes Back to Pat's page.
  assert.equal((await s.post('/auth/unlock', { password: PW })).status, 200);
  assert.equal((await s.get(`/sign/${quinn}`)).status, 200);
  assert.equal((await s.get(`/sign/${pat}`)).status, 200);
  const back = await s.get(`/sign/${pat}/comments`);
  assert.equal(back.status, 200);
  assert.equal(JSON.stringify(back.data).includes('sublet') || JSON.stringify(back.data).includes('quietly'), false, 'neither Pat\'s words nor the host\'s answer');
  assert.equal(back.data.may_write, false);
  assert.match(back.data.away, /^This is the signing page of Pat Present, and this device has been handed to someone else since\. So Pat Present's private questions are not shown here/);

  // Quinn's own private thread works as usual.
  const qq = await s.post(`/sign/${quinn}/comments`, { text: 'Quinn private question' });
  assert.equal(qq.status, 200, JSON.stringify(qq.data));
  assert.deepEqual(qq.data.threads.map((t: any) => t.comments[0].body), ['Quinn private question']);
});

test('Back to an earlier in-person page that is not finished shows no private thread and writes nothing in that person\'s name', async () => {
  const s = await person('Hil Host', 'hil@cr.example');
  const { pat, quinn } = await desk(s, 'd2');
  assert.equal((await s.get(`/sign/${pat}`)).status, 200);
  const pq = (await s.post(`/sign/${pat}/comments`, { text: 'PAT ONLY words' })).data;
  // Pat steps away without finishing. The host unlocks and hands the laptop to Quinn.
  assert.equal((await s.post('/auth/unlock', { password: PW })).status, 200);
  assert.equal(s.cookies.ts_hand, '', 'typing the password clears who held the device');
  assert.equal((await s.get(`/sign/${quinn}`)).status, 200);
  assert.equal((await s.get(`/sign/${pat}`)).status, 200, 'Back to Pat\'s page in the locked browser');
  const page = (await s.get(`/sign/${pat}/comments`)).data;
  assert.equal(JSON.stringify(page).includes('PAT ONLY'), false);
  const into = await s.post(`/sign/${pat}/comments`, { thread_id: pq.thread_id, text: 'Quinn writing as Pat' });
  assert.equal(into.status, 403);
  assert.equal(into.data.code, 'handed_on');
  assert.match(into.data.error, /nothing can be written here in their name\..*Nothing was sent\.$/);
  assert.equal((await s.post(`/sign/${pat}/comments`, { text: 'New, as Pat', for: 'everyone' })).status, 403);
  assert.equal((await s.post(`/sign/${pat}/ask`, { message: 'Old way, as Pat' })).status, 403);
  assert.equal((await s.post(`/sign/${pat}/comments/${pq.thread_id}/settle`)).status, 403);
  assert.equal(db.get("SELECT COUNT(*) n FROM comments WHERE thread_id=?", pq.thread_id).n, 1);
  // A cookie that we did not write counts as none, and in the host's locked browser that shows nothing private.
  const forged = Object.assign(browser(), { cookies: { ...s.cookies, ts_hand: `${db.get('SELECT id FROM recipients WHERE token=?', pat).id}.0*abc` } });
  assert.equal(JSON.stringify((await forged.get(`/sign/${pat}/comments`)).data).includes('PAT ONLY'), false);
  // The host hands the laptop to Pat again on purpose: she reads and writes as before.
  assert.equal((await s.post('/auth/unlock', { password: PW })).status, 200);
  assert.equal((await s.get(`/sign/${pat}`)).status, 200);
  assert.ok(JSON.stringify((await s.get(`/sign/${pat}/comments`)).data).includes('PAT ONLY'));
  assert.equal((await s.get(`/sign/${quinn}/comments`)).data.away !== null, true, 'and now Quinn\'s page is the one away');
});

test('on a device that is not signed in to the host\'s account, Back never makes an earlier person the one holding it; a signer\'s own phone reads their thread', async () => {
  const s = await person('Tab Host', 'tab@cr.example');
  const { pat, quinn } = await desk(s, 'd3');
  const tablet = browser();
  assert.equal((await tablet.get(`/sign/${pat}`)).status, 200);
  assert.equal((await tablet.post(`/sign/${pat}/comments`, { text: 'PAT TABLET words' })).status, 200);
  assert.ok(JSON.stringify((await tablet.get(`/sign/${pat}/comments`)).data).includes('PAT TABLET'));
  assert.equal((await tablet.get(`/sign/${quinn}`)).status, 200);
  assert.equal((await tablet.get(`/sign/${pat}`)).status, 200, 'Back');
  assert.equal(JSON.stringify((await tablet.get(`/sign/${pat}/comments`)).data).includes('PAT TABLET'), false);
  assert.equal((await tablet.post(`/sign/${quinn}/comments`, { text: 'Quinn on the tablet' })).status, 200);
  // Pat scans her link on her own phone: there it is hers.
  const own = browser();
  assert.equal((await own.get(`/sign/${pat}`)).status, 200);
  assert.ok(JSON.stringify((await own.get(`/sign/${pat}/comments`)).data).includes('PAT TABLET'));
});

// ---- 2. The fake-payment-notice filter reads a day of words and the names beside them (decision 2) -------------

const PARTS = ['PayPal invoice INV-2231 attached.', 'Your payment of $499.00 was charged today.', 'To cancel it call +1 (888) 555-0142 now.'];
const answersTo = (email: string) => mailTo(email).filter((m: any) => /wrote to you about/.test(m.subject));

test('a notice split over several answers from the sender\'s side is refused when the last part comes, whoever on that side writes the parts', async () => {
  const s = await person('Spl Sender', 'spl@cr.example');
  const { e, ada, adaId, benId } = await out(s, 's1');
  const q = (await browser().post(`/sign/${ada}/comments`, { text: 'When is it due?' })).data;
  const st: number[] = [];
  for (const p of PARTS) st.push((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: p })).status);
  assert.deepEqual(st, [200, 200, 422]);
  const page = (await browser().get(`/sign/${ada}/comments`)).data;
  assert.equal(JSON.stringify(page).includes('555-0142'), false, 'the part that completes it is not shown');
  later();
  await flush();
  assert.ok(answersTo('ada.s1@example.com').every((m: any) => !m.html.includes('555-0142')));

  // The same person writing the parts to different people: what one person wrote on the envelope in a day is read together.
  const { e: e2, adaId: a2, benId: b2 } = await out(s, 's2');
  assert.equal((await s.post(`/envelopes/${e2.id}/comments`, { for: a2, text: PARTS[0] })).status, 200);
  assert.equal((await s.post(`/envelopes/${e2.id}/comments`, { for: b2, text: PARTS[1] })).status, 200);
  const third = await s.post(`/envelopes/${e2.id}/comments`, { for: 'everyone', text: PARTS[2] });
  assert.equal(third.status, 422);
  assert.match(third.data.error, /payment notice.*PayPal.*Nothing was sent\.$/);
  assert.ok(adaId && benId);
});

test('two people on the sender\'s side splitting a notice for one reader are refused; words no one person reads together are not', async () => {
  const owner = await person('Own Er', 'own@cr.example');
  const join = async (email: string, name: string) => {
    assert.equal((await owner.post('/account/invites', { email, role: 'admin' })).status, 200);
    const c = browser();
    assert.equal((await c.post('/auth/signup', { name, email, password: PW, invite: db.get('SELECT token FROM invites WHERE email=?', email).token })).status, 200);
    const t = db.get('SELECT verify_token t FROM users WHERE email=?', email)?.t;
    if (t) await c.post('/auth/verify', { token: t });
    return c;
  };
  const a = await join('adm1@cr.example', 'Ann Admin'), b = await join('adm2@cr.example', 'Bob Admin');
  const { e, ada, adaId, benId } = await out(owner, 't1');
  const q = (await browser().post(`/sign/${ada}/comments`, { text: 'Question' })).data;
  assert.equal((await a.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: PARTS[0] })).status, 200);
  assert.equal((await b.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: PARTS[1] })).status, 200);
  assert.equal((await owner.post(`/envelopes/${e.id}/comments`, { for: 'everyone', text: PARTS[2] })).status, 422, 'Ada would read all three');

  // An honest office: one admin says PayPal is fine to Ada, another gives Ben the deposit and a number to call.
  const { e: e2, adaId: a2, benId: b2 } = await out(owner, 't2');
  assert.equal((await a.post(`/envelopes/${e2.id}/comments`, { for: a2, text: 'PayPal is fine for us.' })).status, 200);
  assert.equal((await b.post(`/envelopes/${e2.id}/comments`, { for: b2, text: 'The deposit is $1,200. Call me on +1 (888) 555-0142 with questions.' })).status, 200);
  assert.ok(adaId && benId);
});

test('an admin\'s own name is read with their words, and the email names who wrote it and for whom', async () => {
  const owner = await person('Own Er', 'own2@cr.example');
  const join = async (email: string, name: string) => {
    await owner.post('/account/invites', { email, role: 'admin' });
    const c = browser();
    assert.equal((await c.post('/auth/signup', { name, email, password: PW, invite: db.get('SELECT token FROM invites WHERE email=?', email).token })).status, 200);
    const t = db.get('SELECT verify_token t FROM users WHERE email=?', email)?.t;
    if (t) await c.post('/auth/verify', { token: t });
    return c;
  };
  const brand = await join('brand@cr.example', 'PayPal Resolution Center');
  const { e, ada } = await out(owner, 'n1');
  const q = (await browser().post(`/sign/${ada}/comments`, { text: 'Question' })).data;
  const w = await brand.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Your invoice of $499.00 is overdue. Call +1 (888) 555-0142 today.' });
  assert.equal(w.status, 422);
  assert.match(w.data.error, /PayPal/);
  assert.equal(answersTo('ada.n1@example.com').length, 0);

  const kind = await join('kind@cr.example', 'Kim Helper');
  assert.equal((await kind.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'It is due on the first.' })).status, 200);
  const m = answersTo('ada.n1@example.com')[0];
  assert.equal(m.subject, 'Kim Helper wrote to you about: Lease n1');
  assert.match(text(m.html), /Kim Helper, for Own Er, wrote to you about "Lease n1"/);
  assert.match(text(m.html), /Sent for Own Er \(own2@cr\.example\)\./);
});

test('what someone on the document writes for everyone is read for the notice, with their name; privately to the sender it is theirs to ask', async () => {
  const s = await person('Pub Sender', 'pub@cr.example');
  const { e, ada, ben } = await out(s, 'r1');
  const A = browser();
  const lure = await A.post(`/sign/${ada}/comments`, { for: 'everyone', text: 'PayPal: your payment of $499.00 was charged. To cancel call +1 (888) 555-0142.' });
  assert.equal(lure.status, 422);
  assert.match(lure.data.error, /so we do not pass it on to the other people on this document\. What set it off.*To ask Pub Sender about a payment, choose "Only Pub Sender" instead: that goes to them alone\. Nothing was sent\.$/);
  // In two parts for everyone: the second is refused.
  assert.equal((await A.post(`/sign/${ada}/comments`, { for: 'everyone', text: 'PayPal charged $499.00 today.' })).status, 200);
  assert.equal((await A.post(`/sign/${ada}/comments`, { for: 'everyone', text: 'Call +1 (888) 555-0142 to cancel.' })).status, 422);
  assert.equal(JSON.stringify((await browser().get(`/sign/${ben}/comments`)).data).includes('555-0142'), false);
  // A tenant asking the sender alone about paying by PayPal, with their number, is asked as written.
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Can I pay the $499.00 by PayPal? Call me on +1 (888) 555-0142.' })).status, 200);
  assert.ok(e);
});

test('a public form\'s visitor: their words and their name are read together, a reply in a conversation for everyone is refused, and the owner\'s email comes from us with no reply address', async () => {
  const s = await person('Fay Former', 'fay@cr.example');
  const file = await upload(s, 1);
  const tpl = (await s.post('/envelopes', { kind: 'template', subject: 'Volunteer form', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'v', role: 'signer', role_name: 'Volunteer' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'v', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const form = await s.post('/powerforms', { template_id: tpl.id, name: 'Volunteers' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  const slug = form.data.powerform?.slug || db.get('SELECT slug FROM powerforms WHERE template_id=?', tpl.id).slug;
  const start = async (name: string, email: string) => {
    const v = browser();
    const r = await v.post(`/public/powerforms/${slug}/start`, { name, email });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { v, tok: String(r.data.url).split('/sign/')[1] };
  };
  const p = await start('PayPal Billing', 'billing@paypa1-support.example');
  const w = await p.v.post(`/sign/${p.tok}/comments`, { text: 'Your PayPal payment of $499.00 was charged. Not you? Call +1 (888) 555-0142 or log in at http://paypa1-secure.example/login' });
  assert.equal(w.status, 422);
  assert.match(w.data.error, /so we do not pass it on\. What set it off, in what you wrote here today and your name: the name PayPal/);
  // Part of the notice in the name.
  const n = await start('PayPal Billing +1 (888) 555-0142', 'b2@paypa1-support.example');
  assert.equal((await n.v.post(`/sign/${n.tok}/comments`, { text: 'Your payment of $499.00 was charged.' })).status, 422);
  assert.ok(mailTo('fay@cr.example').every((m: any) => !m.html.includes('555-0142')));

  // An honest visitor: the owner's email names them, comes from us and has no reply address they typed.
  const h = await start('Walk In', 'walkin@example.com');
  assert.equal((await h.v.post(`/sign/${h.tok}/comments`, { text: 'Can I bring a friend?' })).status, 200);
  const row = db.get("SELECT subject, html, payload FROM emails WHERE to_email='fay@cr.example' ORDER BY id DESC LIMIT 1");
  const pl = JSON.parse(row.payload);
  assert.equal(row.subject, 'Questions and comments: Volunteers');
  assert.doesNotMatch(String(pl.from), /Walk In/);
  assert.notEqual(pl.replyTo, 'walkin@example.com');
  assert.match(text(row.html), /Walk In came through your public form and typed that name and address themselves\. We have not checked them, so this email does not come from them and has no reply address\./);
  assert.doesNotMatch(text(row.html), /Replying to this email writes to/);
  // The owner starts a conversation for everyone on that envelope: the visitor may read it, and not answer in it.
  const eid = db.get('SELECT envelope_id e FROM recipients WHERE token=?', h.tok).e;
  const all = await s.post(`/envelopes/${eid}/comments`, { for: 'everyone', text: 'Thanks for helping.' });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const into = await h.v.post(`/sign/${h.tok}/comments`, { thread_id: all.data.thread_id, text: 'Hello all' });
  assert.equal(into.status, 403);
  assert.match(into.data.error, /^On a public form, what you write here goes to Fay Former only, and everyone on the document reads this conversation\./);
});

// ---- 3. An answer the filter turns down at the moment of sending is dropped, not held for ever (decision 3) -------

test('answers that read like a notice when they are about to be emailed are dropped with a note to the sender, and a later answer still goes', async () => {
  const s = await person('Held Sender', 'held@cr.example');
  const accountId = (await s.get('/me')).data.account.id;
  const { e, ada } = await out(s, 'b1');
  const q = (await browser().post(`/sign/${ada}/comments`, { text: 'Question' })).data;
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'First answer, emailed at once.' })).status, 200);
  assert.equal(answersTo('ada.b1@example.com').length, 1);
  // A person had cleared the account when these were written; they wait for the next email. Then that is taken back.
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), accountId);
  for (const p of PARTS) assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: p })).status, 200);
  db.run('UPDATE accounts SET trusted_at=NULL WHERE id=?', accountId);
  later();
  assert.deepEqual(await flush(e.id), { mailed: 0, held: 0, dropped: 1 });
  assert.equal(answersTo('ada.b1@example.com').length, 1, 'not emailed');
  const view = (await s.get(`/envelopes/${e.id}/comments`)).data;
  const news = view.threads[0].comments.filter((c: any) => c.by_sender).slice(1).map((c: any) => c.news[0]);
  assert.ok(news.every((n: any) => n.mailed_at === null && /comments with words like these are not emailed\..*Later answers are emailed as usual\./.test(n.not_emailed)), JSON.stringify(news));
  const note = mailTo('held@cr.example').filter((m: any) => m.subject === 'Not emailed to Ada Tenant: comments on Lease b1');
  assert.equal(note.length, 1);
  assert.match(text(note[0].html), /Comments with words like these are not emailed\. Ada Tenant still sees them on their signing page\. Later answers are emailed as usual\./);
  // Nothing waits behind them: the timer has nothing more to do, and a harmless answer goes as usual.
  await cron.tick();
  assert.deepEqual(await flush(e.id), { mailed: 0, held: 0, dropped: 0 });
  assert.equal(db.get('SELECT COUNT(*) n FROM comment_news WHERE envelope_id=? AND mailed_at IS NULL AND dropped IS NULL', e.id).n, 0);
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Ignore the above, see you Monday.' })).status, 200);
  later();
  await flush();
  assert.equal(answersTo('ada.b1@example.com').length, 2);
  assert.match(text(answersTo('ada.b1@example.com')[1].html), /see you Monday/);
  assert.doesNotMatch(answersTo('ada.b1@example.com')[1].html, /555-0142/);
});

// ---- 4. Settled and open again: limited, and at most one line in the record an hour (decision 5) ----------------

test('marking a conversation as settled and open again is limited, writes one line in the record an hour, and cannot fill the certificate', async () => {
  const s = await person('Tog Sender', 'tog@cr.example');
  const { e, ada } = await out(s, 'g1');
  const A = browser();
  const q = (await A.post(`/sign/${ada}/comments`, { text: 'Toggle me' })).data;
  const lines = () => db.all("SELECT action FROM audit WHERE envelope_id=? AND action IN ('Comment settled','Comment opened again')", e.id).length;
  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) {
    const X = Object.assign(browser(), { cookies: A.cookies }); // a new address each time
    statuses.push((await X.post(`/sign/${ada}/comments/${q.thread_id}/settle`, { settled: i % 2 === 0 })).status);
  }
  // After ten changes a change is refused; asking for the state it already has (open) changes nothing and is fine.
  assert.deepEqual(statuses, [...Array(10).fill(200), 429, 200, 429, 200]);
  const no = await A.post(`/sign/${ada}/comments/${q.thread_id}/settle`, { settled: true });
  assert.match(no.data.error, /^That conversation was marked as settled or open again 10 times in the last hour, which is as often as we take\. Nothing was changed\. Try again in \d+ minutes?, or write in it instead\.$/);
  // Asking for the state it already has changes nothing and is not counted.
  const now = (await A.get(`/sign/${ada}/comments`)).data.threads[0].settled_at;
  assert.equal((await A.post(`/sign/${ada}/comments/${q.thread_id}/settle`, { settled: !!now === false ? false : true })).status, 200);
  // The sender's side has a limit of its own, also ten changes an hour.
  let changes = 0, refused = 0, was = db.get('SELECT settled_at s FROM comment_threads WHERE id=?', q.thread_id).s;
  for (let i = 0; i < 30; i++) {
    const r = await s.post(`/envelopes/${e.id}/comments/${q.thread_id}/settle`, { settled: !was });
    if (r.status === 429) refused++;
    const is = db.get('SELECT settled_at s FROM comment_threads WHERE id=?', q.thread_id).s;
    if (!!is !== !!was) changes++;
    was = is;
  }
  assert.deepEqual([changes, refused], [10, 20]);
  assert.equal(lines(), 1, 'one line for this conversation in the hour');
  // An hour later the next change is written again.
  const { noteSettle } = await import('../src/server/commentrules.ts');
  assert.equal(noteSettle(q.thread_id), false, 'still inside the hour');
  db.run('UPDATE comment_threads SET settle_noted_at=? WHERE id=?', new Date(Date.now() - 61 * 60_000).toISOString(), q.thread_id);
  assert.equal(noteSettle(q.thread_id), true, 'an hour later the next change is written again');
  assert.equal(noteSettle(q.thread_id), false, 'and only that one');
  assert.equal((await signAll(e.id, 'ada.g1@example.com')).status, 200);
  assert.equal((await signAll(e.id, 'ben.g1@example.com')).status, 200);
  const { PDFDocument } = await import('pdf-lib');
  const pages = (await PDFDocument.load((await s.get(`/envelopes/${e.id}/download`)).data)).getPageCount();
  assert.ok(pages <= 5, `a 2-page document with its certificate, not ${pages} pages`);
});

// ---- 5. Deleting an envelope takes the comments out of the webhook log too (decision 6) ---------------------------

test('after an envelope is deleted, its comment deliveries in the webhook log hold no words and no name, and sending one again sends none', async () => {
  const http = await import('node:http');
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => (hits.push(b), res.end('ok')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const s = await person('Hook Sender', 'hook@cr.example');
    assert.equal((await s.post('/webhooks', { url: `http://127.0.0.1:${(server.address() as any).port}/h`, events: ['comment.created'] })).status, 200);
    const { e, ada } = await out(s, 'w1');
    assert.equal((await browser().post(`/sign/${ada}/comments`, { text: 'My HIV status is positive, does clause 9 apply?' })).status, 200);
    for (let i = 0; i < 100 && !hits.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(hits[0]?.includes('HIV'), 'the account\'s own system got it while the envelope was there');
    for (let i = 0; i < 100 && !db.get('SELECT done FROM webhook_deliveries WHERE envelope_id=?', e.id)?.done; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await s.post(`/envelopes/${e.id}/void`, { reason: 'Wrong' })).status, 200);
    assert.equal((await s.call('DELETE', `/envelopes/${e.id}`)).status, 200);
    const left = db.all('SELECT id, body FROM webhook_deliveries WHERE envelope_id=?', e.id);
    assert.equal(left.length, 1);
    assert.doesNotMatch(left[0].body, /HIV|Ada Tenant/);
    const kept = JSON.parse(left[0].body);
    assert.deepEqual([kept.event, kept.comment.text, kept.comment.name, !!kept.comment.id], ['comment.created', null, null, true]);
    const listed = (await s.get('/webhooks')).data.deliveries.find((d: any) => d.envelope_id === e.id);
    assert.equal(listed.can_redeliver, true);
    const n = hits.length;
    assert.equal((await s.post(`/webhooks/deliveries/${listed.id}/redeliver`)).status, 200);
    for (let i = 0; i < 100 && hits.length === n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hits.length, n + 1);
    assert.doesNotMatch(hits.at(-1)!, /HIV|Ada Tenant/);
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    server.close();
  }
});

// ---- 6. The smaller things ------------------------------------------------------------------------------------------

test('a refused request does not use up the burst: after ten mistakes the real question still goes', async () => {
  const s = await person('Fl Sender', 'fl@cr.example');
  const { e, doc, ada } = await out(s, 'f1');
  const A = browser();
  for (let i = 0; i < 4; i++) assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'x', thread_id: 'thr_none' })).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'x', pin: { document_id: doc, page: 9 } })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await A.post(`/sign/${ada}/comments`, { for: 'everyone', text: 'PayPal charged $499.00, call +1 (888) 555-0142' })).status, 422);
  const real = await A.post(`/sign/${ada}/comments`, { text: 'A real question' });
  assert.equal(real.status, 200, JSON.stringify(real.data));
  // The sender's side the same way.
  for (let i = 0; i < 31; i++) assert.equal((await s.post(`/envelopes/${e.id}/comments`, { text: 'x', thread_id: 'thr_none' })).status, 404);
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: real.data.thread_id, text: 'A real answer' })).status, 200);
});

test('the same comment sent twice at once, or again a moment later, is stored and emailed once', async () => {
  const s = await person('Twi Sender', 'twi@cr.example');
  const { e, ada } = await out(s, 'k1');
  const A = browser();
  const two = await Promise.all([1, 2].map(() => A.post(`/sign/${ada}/comments`, { text: 'Is the boiler included?' })));
  assert.deepEqual(two.map((x) => x.status), [200, 200]);
  assert.equal(two[0].data.thread_id, two[1].data.thread_id);
  assert.equal(db.get("SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND body='Is the boiler included?'", e.id).n, 1);
  const q = two[0].data;
  const ans = await Promise.all([1, 2].map(() => s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Same words twice' })));
  assert.deepEqual(ans.map((x) => x.status), [200, 200]);
  assert.equal(db.get("SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND body='Same words twice'", e.id).n, 1);
  assert.match(ans[1].data.message, /^This was already sent a moment ago, so it was not sent again\./);
  assert.equal(answersTo('ada.k1@example.com').length, 1);
  // Other words, or the same words a while later, are a new comment.
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Other words' })).status, 200);
  db.run("UPDATE comments SET at=? WHERE envelope_id=? AND body='Same words twice'", new Date(Date.now() - 60_000).toISOString(), e.id);
  assert.equal((await s.post(`/envelopes/${e.id}/comments`, { thread_id: q.thread_id, text: 'Same words twice' })).status, 200);
  assert.equal(db.get("SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND body='Same words twice'", e.id).n, 2);
  // Two new questions with the same words for different readers are two.
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Hello all', for: 'everyone' })).status, 200);
  assert.equal((await A.post(`/sign/${ada}/comments`, { text: 'Hello all' })).status, 200);
  assert.equal(db.get("SELECT COUNT(*) n FROM comments WHERE envelope_id=? AND body='Hello all'", e.id).n, 2);
});

test('screens and emails say who is really emailed: never for someone in person, without an address, who marked spam or whose address bounced', async () => {
  const s = await person('Spam Sender', 'spam@cr.example');
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', { subject: 'Reach', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'p', role: 'inperson', name: 'Pat Present', email: 'pat.m1@example.com' }, { id: 'a', role: 'signer', name: 'Ada Spam', email: 'ada.m1@example.com' }, { id: 'b', role: 'signer', name: 'Ben Bounce', email: 'ben.m1@example.com' }, { id: 'c', role: 'signer', name: 'Cat Fine', email: 'cat.m1@example.com' }],
    fields: ['p', 'a', 'b', 'c'].map((rid, i) => ({ id: `f${i}`, document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.1 + i * 0.2, w: 0.3, h: 0.06 })) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  db.run('UPDATE recipients SET complained_at=? WHERE envelope_id=? AND email=?', new Date().toISOString(), e.id, 'ada.m1@example.com');
  db.run('UPDATE recipients SET bounced_at=? WHERE envelope_id=? AND email=?', new Date().toISOString(), e.id, 'ben.m1@example.com');
  const view = (await s.get(`/envelopes/${e.id}/comments`)).data;
  assert.deepEqual(view.people.map((p: any) => [p.name, p.emailed]), [['Pat Present', false], ['Ada Spam', false], ['Ben Bounce', false], ['Cat Fine', true]]);
  assert.match(view.people[0].not_emailed, /sign in person on your device/);
  // The signing page of someone whose address bounced does not promise an email.
  const ben = tokenFor(e.id, 'ben.m1@example.com');
  assert.equal((await browser().get(`/sign/${ben}/comments`)).data.answers_to, null);
  assert.equal((await browser().get(`/sign/${tokenFor(e.id, 'cat.m1@example.com')}/comments`)).data.answers_to, 'cat.m1@example.com');
  // The digest about a question from someone who marked spam says they are not emailed, not that they are.
  await browser().post(`/sign/${tokenFor(e.id, 'ada.m1@example.com')}/comments`, { text: 'Spam-marker asks' });
  const d = text(mailTo('spam@cr.example').filter((m: any) => m.subject === 'Questions and comments: Reach').at(-1)!.html);
  assert.match(d, /Answer on the document's page\. They see your answer on their signing page\. Ada Spam marked an email about this document as spam, so they are not emailed your answer\./);
  assert.doesNotMatch(d, /we email it to them/);
  // A private thread on the card says whether that person is emailed.
  const t = (await s.get(`/envelopes/${e.id}/comments`)).data.threads[0];
  assert.deepEqual([t.with.name, t.with.emailed], ['Ada Spam', false]);
});

test('an admin can read the comments of a finished envelope its sender removed, as its evidence pack already carries them', async () => {
  const owner = await person('Own Er', 'own4@cr.example');
  const join = async (email: string, role: string, name: string) => {
    await owner.post('/account/invites', { email, role });
    const c = browser();
    assert.equal((await c.post('/auth/signup', { name, email, password: PW, invite: db.get('SELECT token FROM invites WHERE email=?', email).token })).status, 200);
    const vt = db.get('SELECT verify_token t FROM users WHERE email=?', email)?.t;
    if (vt) await c.post('/auth/verify', { token: vt });
    return c;
  };
  const adm = await join('adm4@cr.example', 'admin', 'Ad Min');
  // A member sends it and removes it once it is signed.
  const mem = await join('mem4@cr.example', 'member', 'Mem Ber');
  const file = await upload(mem, 1);
  const e = (await mem.post('/envelopes', { subject: 'Team', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', role: 'signer', name: 'Ada Tenant', email: 'ada.v4@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  await browser().post(`/sign/${tokenFor(e.id, 'ada.v4@example.com')}/comments`, { text: 'Owner-only question' });
  assert.equal((await signAll(e.id, 'ada.v4@example.com')).status, 200);
  assert.equal((await mem.call('DELETE', `/envelopes/${e.id}`)).status, 200);
  assert.ok(db.get('SELECT hidden_at FROM envelopes WHERE id=?', e.id)?.hidden_at, 'kept for the people who signed it');
  assert.equal((await mem.get(`/envelopes/${e.id}/comments`)).status, 404, 'gone for the sender');
  assert.equal((await adm.post(`/envelopes/${e.id}/comments`, { for: 'everyone', text: 'Late' })).status, 404, 'and nothing is written to it');
  const read = await adm.get(`/envelopes/${e.id}/comments`);
  assert.equal(read.status, 200);
  assert.equal(read.data.threads[0].comments[0].body, 'Owner-only question');
  assert.equal(read.data.may_write, false);
});
