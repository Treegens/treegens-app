// What happens around the certificate when a document is disputed: the words of /verify and /security, what is kept
// after a deletion, the lookup by envelope ID, the record of the completed copy, closed copies that cannot pass for
// signed ones, "this was not me", the evidence pack and the page that explains a certificate.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, signAll, mailTo, tokenFor, type Server } from './helpers.ts';
import { MATCH_MEANS, NO_MATCH_CAUSES, CHAIN_TRUTH } from '../src/lib/evidence.ts';
import { sha256 } from '../src/server/util.ts';

let db: Server['db'];
let env: Server['env'];
let cron: Server['cron'];
before(async () => {
  ({ db, env, cron } = await boot());
});

let n = 0;
const ip = () => `10.77.${++n % 250}.${1 + Math.floor(n / 250)}`;
const person = (name: string, email: string) => signUp(name, email, ip());
const from = () => Object.assign(new Client(), { ip: ip() });
const src = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const auditOf = (envelopeId: string) => db.all('SELECT actor, action, detail, ip, user_agent FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const PW = 'correct horse battery';
// A file dropped on /verify by someone with no account.
async function verify(bytes: Uint8Array, name = 'signed.pdf') {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  return from().call('POST', '/public/verify', f);
}

// One envelope, sent and signed by Sam, so it is completed.
async function completed(sender: Client, email: string, over: any = {}) {
  const e = await simple(sender, email, over);
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, email)).status, 200);
  return db.get('SELECT * FROM envelopes WHERE id=?', e.id);
}

// ---- A. What /verify, /security and the home page promise ---------------------------------------------------

test('A: the pages say what a match shows and what it does not, list the causes of "no match", and say how far the chain goes', () => {
  const verify = src('src/app/verify/page.tsx');
  assert.doesNotMatch(verify, /Authentic/, '"authentic" reads as "these people really signed"');
  assert.match(verify, /Unchanged since signing finished/);
  assert.match(verify, /\{MATCH_MEANS\}/);
  assert.match(MATCH_MEANS, /does not show who was behind each signature/);
  assert.match(verify, /NO_MATCH_CAUSES\.map/);
  for (const cause of [/changed after signing/, /saved again by a PDF viewer/, /printout or a scan/, /deleted it/, /never completed here/]) assert.ok(NO_MATCH_CAUSES.some((c) => cause.test(c)), String(cause));
  assert.doesNotMatch(verify, /is not a completed document from this service, or it was changed after signing/);

  const security = src('src/app/security/page.tsx');
  assert.doesNotMatch(security, /who signed, when, from where/);
  assert.doesNotMatch(security, /Changing or removing an old entry breaks the chain, and the app shows that it is broken/);
  assert.match(security, /\{CHAIN_TRUTH\}/);
  assert.match(security, /\{WHO_WHEN_WHERE\}/);
  assert.match(CHAIN_TRUTH, /no secret key/);
  assert.match(CHAIN_TRUTH, /whoever can write to that database/);
  assert.match(CHAIN_TRUTH, /chain head printed on the certificate/);
  assert.match(CHAIN_TRUTH, /browser description stored with a line is not part of its fingerprint/);
  assert.match(src('src/app/page.tsx'), /Every completed envelope gets a certificate of completion/);
  assert.doesNotMatch(src('README.md'), /Editing any past event breaks the chain, and the app shows it\./);
});

test('A: what the chain text says is what verifyChain does: a careless edit shows, a recomputed rewrite does not, and the browser string is outside it', async () => {
  const sender = await person('Chain Sender', 'chain@disputes.example');
  const e = await completed(sender, 'chain-signer@disputes.example');
  assert.equal(env.verifyChain(e.id).ok, true);
  const rows = db.all('SELECT * FROM audit WHERE envelope_id=? ORDER BY seq', e.id);
  // The browser description is stored but not hashed: changing it leaves the chain intact.
  db.run("UPDATE audit SET user_agent='Changed browser' WHERE seq=?", rows[0].seq);
  assert.equal(env.verifyChain(e.id).ok, true);
  // A careless edit of one line breaks it.
  db.run("UPDATE audit SET detail='edited' WHERE seq=?", rows[1].seq);
  assert.equal(env.verifyChain(e.id).ok, false);
  // Someone with the database who recomputes every later hash is not caught by the app.
  let prev = rows[0].hash;
  for (const a of db.all('SELECT * FROM audit WHERE envelope_id=? AND seq>? ORDER BY seq', e.id, rows[0].seq)) {
    const h = sha256(JSON.stringify([prev, e.id, a.at, a.actor, a.action, a.detail, a.ip || '']));
    db.run('UPDATE audit SET prev_hash=?, hash=? WHERE seq=?', prev, h, a.seq);
    prev = h;
  }
  assert.equal(env.verifyChain(e.id).ok, true, 'which is why the pages say so');
});

// ---- B. What is kept after a deletion --------------------------------------------------------------------------

test('B: after the account is deleted, /verify still knows the signed file by its fingerprint, its id and its day, and nothing else, for a year', async () => {
  const sender = await person('Gone Sender', 'gone-sender@disputes.example');
  const e = await completed(sender, 'kept-signer@disputes.example', { subject: 'Lease for Flat 3' });
  const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  const live = await verify(pdf);
  assert.equal(live.data.match, true);
  assert.equal(live.data.deleted, undefined);

  // A file that was never completed here is still no match, with no deleted document behind it.
  const other = await verify(Buffer.concat([Buffer.from(pdf), Buffer.from('\n')]));
  assert.equal(other.data.match, false);
  assert.equal(other.data.deleted, null);

  assert.equal((await sender.post('/me/delete', { password: PW, now: true })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', e.id).n, 0);
  const kept = db.all('SELECT * FROM forgotten_files WHERE envelope_id=?', e.id);
  assert.equal(kept.length, 1);
  assert.deepEqual(Object.keys(kept[0]).sort(), ['at', 'completed_at', 'envelope_id', 'file_sha256']);
  assert.equal(kept[0].completed_at, e.completed_at.slice(0, 10), 'the day, as the policy says, not the moment');
  for (const gone of ['Lease', 'Flat 3', 'Gone Sender', 'disputes.example', 'Sam Signer']) assert.ok(!JSON.stringify(kept).includes(gone), `${gone} is not kept`);

  const after = await verify(pdf);
  assert.equal(after.status, 200);
  assert.equal(after.data.match, false, 'match is for a document we still hold');
  assert.equal(after.data.deleted.envelope_id, e.id);
  assert.equal(after.data.deleted.completed_at, e.completed_at.slice(0, 10));
  assert.ok(after.data.deleted.kept_until > after.data.deleted.deleted_at);
  assert.ok(!/Lease|Gone Sender|Sam Signer|disputes\.example/.test(JSON.stringify(after.data)), 'nothing about who or what');
  // The page says so, and the pages that list what stays after a deletion say it too.
  assert.match(src('src/app/verify/page.tsx'), /res\.deleted && /);
  assert.match(src('src/app/verify/page.tsx'), /Its sender has since deleted it/);
  const { KEPT_AFTER_DELETION } = await import('../src/lib/policy.ts');
  assert.ok(KEPT_AFTER_DELETION.some((l) => /fingerprint \(SHA-256\) of its signed PDF, its envelope ID and the day it was completed, for one year/.test(l)));

  // A year later that goes too, and the file is no match like any other.
  db.run('UPDATE forgotten_files SET at=? WHERE envelope_id=?', ago(366), e.id);
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM forgotten_files WHERE envelope_id=?', e.id).n, 0);
  assert.equal((await verify(pdf)).data.deleted, null);
});

test('B: a draft, a voided envelope and a closed one nobody completed leave no fingerprint when their account goes', async () => {
  const sender = await person('Never Done', 'never-done@disputes.example');
  const draft = await simple(sender, 'd@disputes.example', { subject: 'Draft only' });
  const voided = await simple(sender, 'v@disputes.example', { subject: 'Voided one' });
  assert.equal((await sender.post(`/envelopes/${voided.id}/send`)).status, 200);
  assert.equal((await sender.post(`/envelopes/${voided.id}/void`, { reason: 'Wrong file' })).status, 200);
  assert.equal((await sender.post('/me/delete', { password: PW, now: true })).status, 200);
  for (const id of [draft.id, voided.id]) assert.equal(db.get('SELECT COUNT(*) n FROM forgotten_files WHERE envelope_id=?', id).n, 0);
});

// ---- C. Looking a document up by its envelope ID -------------------------------------------------------------

test('C: the envelope ID on a printed copy leads to its status, day, pages, signers and fingerprint, never to a name, an address or the title', async () => {
  const sender = await person('Lookup Sender', 'lookup@disputes.example');
  const e = await completed(sender, 'lookup-signer@disputes.example', { subject: 'Private loan between friends' });
  const anon = from();
  const r = await anon.get(`/public/verify/${e.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'completed');
  assert.equal(r.data.completed_at, e.completed_at);
  assert.equal(r.data.sha256, e.final_sha256);
  assert.equal(r.data.pages.documents, 1);
  const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  const { PDFDocument } = await import('pdf-lib');
  assert.equal(r.data.pages.signed_file, (await PDFDocument.load(pdf)).getPageCount(), 'the pages of the signed file, certificate included');
  assert.equal(db.get('SELECT final_pages n FROM envelopes WHERE id=?', e.id).n, r.data.pages.signed_file, 'counted once and kept');
  assert.equal(r.data.signers, 1);
  assert.equal(r.data.signed, 1);
  assert.equal(r.data.disputed_at, null);
  for (const secret of ['Private loan', 'Lookup Sender', 'lookup@', 'lookup-signer', 'Sam Signer', 'disputes.example']) assert.ok(!JSON.stringify(r.data).includes(secret), `${secret} is not given out`);

  // Still out, voided: said as what they are, with no fingerprint because there is no signed file.
  const out = await simple(sender, 'out@disputes.example');
  assert.equal((await sender.post(`/envelopes/${out.id}/send`)).status, 200);
  const o = (await anon.get(`/public/verify/${out.id}`)).data;
  assert.equal(o.status, 'sent');
  assert.equal(o.sha256, null);
  assert.equal(o.signed, 0);
  const v = await simple(sender, 'voided@disputes.example');
  assert.equal((await sender.post(`/envelopes/${v.id}/send`)).status, 200);
  assert.equal((await sender.post(`/envelopes/${v.id}/void`, { reason: 'Wrong amount in it' })).status, 200);
  const vo = (await anon.get(`/public/verify/${v.id}`)).data;
  assert.equal(vo.status, 'voided');
  assert.ok(vo.closed_at);
  assert.ok(!JSON.stringify(vo).includes('Wrong amount'), 'not the reason either');

  // A draft and a template are not found; something that is not an ID is told what an ID looks like.
  const draft = await simple(sender, 'draft@disputes.example');
  assert.equal((await anon.get(`/public/verify/${draft.id}`)).status, 404);
  const bad = await anon.get('/public/verify/not-an-id');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /starts with env_ and stands at the foot of every page/);
  const unknown = await anon.get('/public/verify/env_AAAAAAAAAAAAAAAA');
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.error, /Check that you typed it exactly as printed/);

  // After the account is deleted, the ID still says completed on that day, deleted since, with the fingerprint.
  assert.equal((await sender.post('/me/delete', { password: PW, now: true })).status, 200);
  const gone = (await anon.get(`/public/verify/${e.id}`)).data;
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.completed_at, e.completed_at.slice(0, 10));
  assert.equal(gone.sha256, e.final_sha256);
  assert.equal((await anon.get(`/public/verify/${out.id}`)).status, 404, 'one that was never completed leaves nothing');
});

test('C: the lookup is limited per connection, and the completion email carries the fingerprint of the file it sends', async () => {
  const sender = await person('Print Sender', 'print@disputes.example');
  const e = await completed(sender, 'print-signer@disputes.example');
  const done = mailTo('print-signer@disputes.example').filter((m: any) => m.subject.startsWith('Completed:')).pop();
  assert.ok(done);
  assert.match(text(done.html), new RegExp(`SHA-256 fingerprint: ${e.final_sha256}\\. Keep it with your copy\\.`));
  assert.match(text(done.html), new RegExp(`look the document up there by its envelope ID, ${e.id}`));
  const own = mailTo('print@disputes.example').filter((m: any) => m.subject.startsWith('Completed:')).pop();
  assert.match(text(own.html), new RegExp(e.final_sha256), 'the sender\'s too');

  const one = from();
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await one.get(`/public/verify/${e.id}`)).status;
  assert.equal(last, 429);
  assert.equal((await from().get(`/public/verify/${e.id}`)).status, 200, 'another connection is not held up');
});

test('C: /verify offers the lookup by ID with "Choose the file to compare" beside it, and opens /verify?id= looked up', () => {
  const page = src('src/app/verify/page.tsx');
  assert.match(page, /<ById \/>/);
  const byId = src('src/app/verify/ById.tsx');
  assert.match(byId, /api\(`\/public\/verify\/\$\{encodeURIComponent\(clean\)\}`\)/);
  assert.match(byId, /get\('id'\)/);
  assert.match(byId, /Choose the file to compare/);
  assert.match(byId, /crypto\.subtle\.digest\('SHA-256'/, 'compared in the browser, so the file stays on the device');
  assert.match(byId, /never shows names, addresses or the title/);
});

// ---- D. What happens after signing is in the record ----------------------------------------------------------

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('D: the completed copy handed to the mail server is a line for each person, and with no mail server the record says no email went out', async () => {
  const sender = await person('Copy Sender', 'copy@disputes.example');
  // No mail server: nothing went out, and the record says so for the signer and for the sender.
  const quiet = await completed(sender, 'copy-signer@disputes.example');
  const q = auditOf(quiet.id).filter((a: any) => a.action === 'Completed copy not emailed');
  assert.equal(q.length, 2, JSON.stringify(auditOf(quiet.id).map((a: any) => a.action)));
  assert.ok(q.some((a: any) => /To Sam Signer <copy-signer@disputes\.example>: no mail server is set up/.test(a.detail)));
  assert.ok(q.some((a: any) => /To the sender, Copy Sender <copy@disputes\.example>/.test(a.detail)));
  assert.ok(!auditOf(quiet.id).some((a: any) => a.action === 'Completed copy sent'), 'never called sent when it was not');

  // A mail server that takes it: "sent", with the PDF attached, and never more than the hand-over.
  const g = globalThis as any;
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  const taken: any[] = [];
  g.__tsmail = { sendMail: async (m: any) => void taken.push(m) };
  try {
    const e = await completed(sender, 'copy-signer2@disputes.example');
    const lines = auditOf(e.id).filter((a: any) => a.action === 'Completed copy sent');
    assert.equal(lines.length, 2);
    assert.ok(lines.some((a: any) => /To Sam Signer <copy-signer2@disputes\.example>: handed to the mail server with the signed PDF attached\. Whether it arrived is not known at this point\./.test(a.detail)));
    assert.ok(taken.some((m: any) => m.to === 'copy-signer2@disputes.example' && m.attachments?.length === 1));
    // The certificate was sealed before: those lines come after "Envelope completed".
    const actions = auditOf(e.id).map((a: any) => a.action);
    assert.ok(actions.indexOf('Completed copy sent') > actions.indexOf('Envelope completed'));
    assert.equal(env.verifyChain(e.id).ok, true);
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
  }
});

test('D: the first time each person opens or downloads the completed copy is a line with their address and browser, once', async () => {
  const sender = await person('Open Sender', 'open@disputes.example');
  const e = await completed(sender, 'open-signer@disputes.example');
  const tok = tokenFor(e.id, 'open-signer@disputes.example');
  const phone = Object.assign(from(), { ip: '198.51.100.23' });
  const call = (u: string) => phone.call('GET', u, undefined, { 'user-agent': UA });
  assert.equal((await call(`/sign/${tok}/download?inline=1`)).status, 200);
  assert.equal((await call(`/sign/${tok}/download`)).status, 200);
  assert.equal((await call(`/sign/${tok}/download`)).status, 200);
  const opened = auditOf(e.id).filter((a: any) => a.action === 'Completed copy opened');
  assert.equal(opened.length, 1, 'the first time only');
  assert.equal(opened[0].ip, '198.51.100.23');
  assert.equal(opened[0].user_agent, UA, 'the browser string is kept with the line');
  assert.match(opened[0].detail, /Sam Signer opened the completed document on screen for the first time, in Safari on an iPhone\./);
  // The sender's own download is not a recipient opening their copy.
  assert.equal((await sender.get(`/envelopes/${e.id}/download`)).status, 200);
  assert.equal(auditOf(e.id).filter((a: any) => a.action === 'Completed copy opened').length, 1);
  // Before everything is finished, a download is not the completed copy and is not written down as one.
  const open = await simple(sender, 'early@disputes.example');
  assert.equal((await sender.post(`/envelopes/${open.id}/send`)).status, 200);
  const early = tokenFor(open.id, 'early@disputes.example');
  await from().post(`/sign/${early}/consent`);
  assert.equal((await from().get(`/sign/${early}/download`)).status, 200);
  assert.ok(!auditOf(open.id).some((a: any) => a.action === 'Completed copy opened'));
});

test('D: visits after the first open are written down at most once a day for each person', async () => {
  const sender = await person('Visit Sender', 'visit@disputes.example');
  const e = await simple(sender, 'visit-signer@disputes.example');
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'visit-signer@disputes.example');
  const c = Object.assign(from(), { ip: '198.51.100.44' });
  const look = () => c.call('GET', `/sign/${tok}`, undefined, { 'user-agent': UA });
  await look();
  await look();
  await look();
  const count = (action: string) => auditOf(e.id).filter((a: any) => a.action === action).length;
  assert.equal(count('Viewed'), 1);
  assert.equal(count('Opened again'), 0, 'a reload on the same day says nothing');
  // The next day it does, once.
  db.run('UPDATE recipients SET viewed_at=? WHERE envelope_id=?', ago(1.1), e.id);
  await look();
  await look();
  assert.equal(count('Opened again'), 1);
  const line = auditOf(e.id).find((a: any) => a.action === 'Opened again');
  assert.equal(line.ip, '198.51.100.44');
  assert.match(line.detail, /Sam Signer opened the envelope again, in Safari on an iPhone\. Later visits on the same day are not written down\./);
  db.run('UPDATE recipients SET visit_noted_at=? WHERE envelope_id=?', ago(1.1), e.id);
  await look();
  assert.equal(count('Opened again'), 2, 'and again the day after');
  // After signing too: coming back to a completed document is a visit.
  await signAll(e.id, 'visit-signer@disputes.example');
  db.run('UPDATE recipients SET visit_noted_at=? WHERE envelope_id=?', ago(1.1), e.id);
  await look();
  assert.equal(count('Opened again'), 3);
  assert.equal(env.verifyChain(e.id).ok, true);
  // The security page no longer says every step is recorded, and says what is not.
  const security = src('src/app/security/page.tsx');
  assert.doesNotMatch(security, /Every step is recorded/);
  assert.match(security, /Not written down: whether an email was opened in the mailbox/);
});

// ---- E. A closed envelope's copy can never pass for a signed one ---------------------------------------------

const pagesOf = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractPages(bytes);

// Two signers in order. The first signs, then the envelope is closed with their signature on it.
async function halfSigned(sender: Client, tag: string) {
  const { draft } = await import('./helpers.ts');
  const e = await draft(sender, { recipients: [
    { id: 'r1', role: 'signer', name: 'Ada Signer', email: `ada-${tag}@disputes.example`, routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Ben Signer', email: `ben-${tag}@disputes.example`, routing_order: 2 },
  ], fields: [
    { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
    { id: 'f4', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
  ] });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `ada-${tag}@disputes.example`)).status, 200);
  return e;
}

test('E: the sender\'s download of a voided, declined or expired envelope opens with the notice and is marked large across every page', async () => {
  const sender = await person('Closed Sender', 'closed@disputes.example');
  const v = await halfSigned(sender, 'void');
  assert.equal((await sender.post(`/envelopes/${v.id}/void`, { reason: 'Terms changed' })).status, 200);
  const pdf = (await sender.get(`/envelopes/${v.id}/download`)).data as Uint8Array;
  const pages = await pagesOf(pdf);
  assert.equal(pages.length, 3, 'the notice, then the two pages of the document');
  assert.match(pages[0], /Not completed by everyone/);
  assert.match(pages[0], /Closed Sender cancelled \(voided\) it/);
  assert.match(pages[0], /Terms changed/);
  assert.match(pages[0], /This is the sender's copy/);
  assert.match(pages[0], new RegExp(`/verify with its envelope ID, ${v.id}`));
  for (const p of pages.slice(1)) {
    assert.match(p, /VOIDED/);
    assert.match(p, /NOT A SIGNED DOCUMENT/);
    assert.match(p, /NOT COMPLETED BY EVERYONE, see the first page/);
  }
  // The signer's own copy of the same envelope carries the large mark too.
  const ada = tokenFor(v.id, 'ada-void@disputes.example');
  const theirs = await pagesOf((await from().get(`/sign/${ada}/download`)).data);
  assert.match(theirs[0], /This copy is for Ada Signer/);
  for (const p of theirs.slice(1)) assert.match(p, /VOIDED.*NOT A SIGNED DOCUMENT|NOT A SIGNED DOCUMENT.*VOIDED/s);

  // Declined, and run out of time: their own word across the page.
  const d = await halfSigned(sender, 'decl');
  const ben = tokenFor(d.id, 'ben-decl@disputes.example');
  await from().post(`/sign/${ben}/consent`);
  assert.equal((await from().post(`/sign/${ben}/decline`, { reason: 'Not mine to sign' })).status, 200);
  const dp = await pagesOf((await sender.get(`/envelopes/${d.id}/download`)).data);
  assert.match(dp[0], /Ben Signer declined to sign/);
  assert.match(dp[1], /DECLINED/);
  const x = await halfSigned(sender, 'exp');
  db.run("UPDATE envelopes SET status='expired' WHERE id=?", x.id);
  assert.match((await pagesOf((await sender.get(`/envelopes/${x.id}/download`)).data))[1], /EXPIRED/);

  // A completed document and one still out are not marked.
  const done = await completed(sender, 'fine@disputes.example');
  const dpdf = await pagesOf((await sender.get(`/envelopes/${done.id}/download`)).data);
  assert.ok(!dpdf.some((p) => /NOT A SIGNED DOCUMENT/.test(p)));
});

test('E: the copy of what someone signed before a change is marked across every page as well', async () => {
  const { withNotice } = await import('../src/server/pdf.ts');
  const { samplePdf } = await import('./helpers.ts');
  const out = await withNotice(await samplePdf(2), 'env_test', { title: 'Signed before the document was changed', lines: ['A line.'] }, 'Signed before a change');
  const pages = await pagesOf(out);
  assert.equal(pages.length, 3);
  for (const p of pages.slice(1)) assert.match(p, /SIGNED BEFORE A CHANGE/), assert.match(p, /NOT THE CURRENT DOCUMENT/);
  const closed = await pagesOf(await withNotice(await samplePdf(1), 'env_test', { title: 'Not completed by everyone', lines: ['A line.'] }, 'Not completed by everyone'));
  assert.match(closed[1], /NOT A SIGNED DOCUMENT/);
});

// ---- F. "I did not sign this, or this was not me" ------------------------------------------------------------

const codeOf = (envelopeId: string, email: string) => db.get('SELECT check_code c FROM recipients WHERE envelope_id=? AND email=?', envelopeId, email).c as string;

test('F: with the security code, a person named on a completed document disputes it: marked, on record, sender and operators told, nothing deleted', async () => {
  process.env.OPERATOR_EMAILS = 'ops-disputes@disputes.example';
  try {
    const sender = await person('Dispute Sender', 'dsender@disputes.example');
    const e = await completed(sender, 'denies@disputes.example', { subject: 'Car sale' });
    const before = db.get('SELECT final_sha256, status FROM envelopes WHERE id=?', e.id);
    const anon = from();
    const r = await anon.post('/public/check/dispute', { code: codeOf(e.id, 'denies@disputes.example'), detail: 'I was abroad that day and never saw this.' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.already, false);
    const after = db.get('SELECT * FROM envelopes WHERE id=?', e.id);
    assert.ok(after.disputed_at);
    assert.equal(after.final_sha256, before.final_sha256, 'nothing about the signed file changes');
    assert.equal(after.status, 'completed');
    const line = auditOf(e.id).find((a: any) => a.action === 'Disputed');
    assert.match(line.detail, /Someone holding the email we sent to Sam Signer <denies@disputes\.example> said that Sam Signer did not sign this, or that it was not them\. Nothing was changed or deleted/);
    assert.doesNotMatch(line.detail, /abroad/, 'what they wrote is not in the record the sender reads');
    assert.equal(env.verifyChain(e.id).ok, true);

    // The sender is told, with the person's own words (the owner's decision: see "Repair 3"); the operators too, and
    // it is in their queue.
    const told = mailTo('dsender@disputes.example').filter((m: any) => m.subject === 'Disputed: Car sale');
    assert.equal(told.length, 1);
    assert.match(text(told[0].html), /Nothing was changed or deleted/);
    assert.match(text(told[0].html), /We do not decide who is right/);
    assert.match(text(told[0].html), /word for word\. We have not checked any of it, so do not call a number or open a link in it: "I was abroad that day and never saw this\."/);
    const ops = mailTo('ops-disputes@disputes.example').filter((m: any) => m.subject === `Disputed: envelope ${e.id}`);
    assert.equal(ops.length, 1);
    assert.match(text(ops[0].html), /They wrote: I was abroad that day and never saw this\./);
    const queued = db.get("SELECT * FROM support_requests WHERE envelope_id=? AND topic='not-me'", e.id);
    assert.equal(queued.name, 'Sign&Grow (automatic alert)');
    assert.equal(queued.status, 'open');

    // It shows where people look: the envelope (and so its page), /verify by file and by ID.
    assert.ok((await sender.get(`/envelopes/${e.id}`)).data.envelope.disputed_at);
    const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
    assert.ok((await verify(pdf)).data.envelope.disputed_at);
    const looked = (await from().get(`/public/verify/${e.id}`)).data;
    assert.ok(looked.disputed_at);
    assert.equal(looked.disputes, 1);

    // Saying it again changes nothing and tells nobody again.
    const again = await anon.post('/public/check/dispute', { code: codeOf(e.id, 'denies@disputes.example') });
    assert.equal(again.data.already, true);
    assert.equal(auditOf(e.id).filter((a: any) => a.action === 'Disputed').length, 1);
    assert.equal(mailTo('dsender@disputes.example').filter((m: any) => m.subject === 'Disputed: Car sale').length, 1);
    // The signer can still download what they have.
    assert.equal((await from().get(`/sign/${tokenFor(e.id, 'denies@disputes.example')}/download`)).status, 200);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('F: from the signing link too, also behind an access code; and only for something done in that person\'s name', async () => {
  const sender = await person('Link Dispute', 'ldsender@disputes.example');
  // Signed behind an access code by whoever had the code. The person named can still say it was not them.
  const e = await simple(sender, 'coded@disputes.example', { recipients: [{ id: 'r', role: 'signer', name: 'Cody Coded', email: 'coded@disputes.example', access_code: '7777' }] });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'coded@disputes.example');
  const holder = from();
  assert.equal((await holder.post(`/sign/${tok}/unlock`, { code: '7777' })).status, 200);
  await holder.post(`/sign/${tok}/consent`);
  const v = (await holder.get(`/sign/${tok}`)).data;
  assert.equal((await holder.post(`/sign/${tok}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: (await import('./helpers.ts')).PNG })).status, 200);
  const stranger = from();
  const r = await stranger.post(`/sign/${tok}/dispute`, { detail: 'Not me' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(auditOf(e.id).find((a: any) => a.action === 'Disputed').detail, /Someone using the signing link of Cody Coded <coded@disputes\.example>/);

  // Nothing done in their name yet: told to report instead. A copy-only recipient has nothing to dispute.
  const open = await simple(sender, 'notyet@disputes.example');
  assert.equal((await sender.post(`/envelopes/${open.id}/send`)).status, 200);
  const early = await from().post('/public/check/dispute', { code: codeOf(open.id, 'notyet@disputes.example') });
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'nothing_signed');
  assert.match(early.data.error, /Nothing has been signed, approved or declined in Sam Signer's name on this document so far.*report it instead/);
  assert.ok(!db.get('SELECT disputed_at FROM envelopes WHERE id=?', open.id).disputed_at);
  const cc = await simple(sender, 'signs@disputes.example', { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'signs@disputes.example' }, { id: 'c', role: 'cc', name: 'Cee Copy', email: 'copy-only@disputes.example' }] });
  assert.equal((await sender.post(`/envelopes/${cc.id}/send`)).status, 200);
  await signAll(cc.id, 'signs@disputes.example');
  const copy = await from().post('/public/check/dispute', { code: codeOf(cc.id, 'copy-only@disputes.example') });
  assert.equal(copy.status, 409);
  assert.match(copy.data.error, /only sent a copy/);

  // A code we never issued, or a garbled one, is told so; and the route is limited per connection.
  assert.equal((await from().post('/public/check/dispute', { code: 'AAAA-BBBB-CCCC' })).status, 404);
  assert.equal((await from().post('/public/check/dispute', { code: 'ABC' })).status, 400);
  const busy = from();
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await busy.post('/public/check/dispute', { code: 'AAAA-BBBB-CCCC' })).status;
  assert.equal(last, 429);
});

test('F: the screens offer it, and the help topic "I am named on a document I did not sign" is never passed on to the sender', async () => {
  const dialogs = src('src/components/sign/dialogs.tsx');
  assert.match(dialogs, /\['not-me', 'I did not sign this, or this was not me'/);
  assert.match(dialogs, /api\(`\$\{base\}\/dispute`/);
  const check = src('src/app/check/CheckForm.tsx');
  assert.match(check, /\['not-me', 'I did not sign this, or this was not me'\]/);
  assert.match(check, /api\('\/public\/check\/dispute'/);
  assert.match(src('src/app/app/envelopes/[id]/page.tsx'), /<Disputed envelope=\{e\} audit=\{data\.audit\} \/>/);
  assert.match(src('src/app/verify/page.tsx'), /res\.envelope\.disputed_at/);
  const help = src('src/app/help/page.tsx');
  assert.match(help, /<QA id="not-me" q="I am named on a document I did not sign"><NotMeAnswer \/><\/QA>/);
  const answer = src('src/app/help/NotMe.tsx');
  for (const who of ['Anyone with the envelope ID', 'Anyone with the signed file itself', 'Anyone holding an email we sent about it', 'The sender, and the owner and admins', 'The people who run Sign&amp;Grow']) assert.ok(answer.includes(who), who);
  assert.match(answer, /It is not passed on to the sender/);

  // A message under that topic about a document whose recipient writes it is not passed to the sender.
  const { SUPPORT_TOPICS } = await import('../src/lib/policy.ts');
  const { TOPIC_LABEL } = await import('../src/lib/support.ts');
  assert.ok(SUPPORT_TOPICS.includes('not-me'));
  assert.equal(TOPIC_LABEL['not-me'], 'I am named on a document I did not sign');
  const sender = await person('Help Sender', 'hsender@disputes.example');
  const e = await simple(sender, 'helper@disputes.example', { subject: 'Help topic test' });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const r = await from().post('/public/support', { email: 'helper@disputes.example', name: 'Sam Signer', topic: 'not-me', message: 'My name is on this and I never signed it.', code: codeOf(e.id, 'helper@disputes.example') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(mailTo('hsender@disputes.example').filter((m: any) => /Problem signing/.test(m.subject)).length, 0);
  assert.ok(!auditOf(e.id).some((a: any) => a.action === 'Help requested'));
  assert.equal(db.get("SELECT topic FROM support_requests WHERE email='helper@disputes.example'").topic, 'not-me');
});

// ---- G. The evidence pack ----------------------------------------------------------------------------------------

// The entries of a ZIP the app made (stored, not compressed), as tests/encrypt.test.ts reads them.
function unzip(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    out[name] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

test('G: the evidence pack holds the signed PDF, the certificate alone, the trail as text and JSON with its chain, every email with its result, the consent words and a README', async () => {
  const sender = await person('Pack Sender', 'pack@disputes.example');
  const e = await completed(sender, 'pack-signer@disputes.example', { subject: 'Garden lease' });
  const res = await sender.get(`/envelopes/${e.id}/evidence`);
  assert.equal(res.status, 200);
  const zip = unzip(res.data);
  const names = Object.keys(zip);
  for (const want of ['signed.pdf', 'certificate.pdf', 'audit-trail.txt', 'audit-trail.json', 'emails/index.csv', 'consent.txt', 'README.txt']) assert.ok(names.includes(want), `${want} in ${names.join(', ')}`);
  assert.equal(sha256(zip['signed.pdf']), e.final_sha256, 'the stored file, byte for byte');
  const cert = await pagesOf(zip['certificate.pdf']);
  assert.ok(cert.length >= 1);
  assert.match(cert[0], /Certificate of Completion/);
  assert.ok(!cert.some((p) => /Agreement page/.test(p)), 'only the certificate');

  const json = JSON.parse(zip['audit-trail.json'].toString());
  assert.equal(json.chain.ok, true);
  assert.match(json.chain.how, /SHA-256 of JSON\.stringify\(\[prev_hash, envelope_id, at, actor, action, detail, ip or ""\]\)/);
  // Anyone can recompute the chain from the JSON alone.
  let prev = '';
  for (const a of json.events) {
    assert.equal(a.prev_hash, prev);
    assert.equal(a.hash, sha256(JSON.stringify([prev, e.id, a.at, a.actor, a.action, a.detail, a.ip || ''])));
    prev = a.hash;
  }
  assert.ok(json.events.every((a: any) => 'user_agent' in a));
  assert.match(zip['audit-trail.txt'].toString(), /Record intact/);
  assert.match(zip['audit-trail.txt'].toString(), /Envelope completed/);

  // Every stored email, with what became of it, and nothing in it that would still open the document.
  const stored = db.all('SELECT html, to_email FROM emails WHERE envelope_id=? ORDER BY id', e.id);
  const mails = names.filter((n) => n.startsWith('emails/') && n.endsWith('.html'));
  assert.equal(mails.length, stored.length);
  const index = zip['emails/index.csv'].toString();
  assert.match(index, /mail_server/);
  assert.match(index, /none set up, not sent/);
  for (const s of stored) assert.ok(index.includes(sha256(s.html)), 'the fingerprint of each email as stored');
  const tok = tokenFor(e.id, 'pack-signer@disputes.example');
  const code = codeOf(e.id, 'pack-signer@disputes.example');
  const all = mails.map((n) => zip[n].toString()).join('\n');
  assert.ok(stored.some((s: any) => s.html.includes(tok)), 'the stored emails do hold the link');
  assert.ok(!all.includes(tok), 'the copies do not');
  assert.ok(!all.includes(code) && !all.includes(code.replace(/(.{4})(?=.)/g, '$1-')), 'nor the security code');
  assert.match(all, /\/sign\/\[link removed\]/);

  const consent = zip['consent.txt'].toString();
  assert.match(consent, /Sam Signer <pack-signer@disputes\.example>/);
  assert.match(consent, /Wording 2026-11/);
  assert.match(consent, /I agree to use electronic records and signatures\./);
  const readme = zip['README.txt'].toString();
  for (const f of ['signed.pdf', 'certificate.pdf', 'audit-trail.txt', 'audit-trail.json', 'emails/', 'consent.txt']) assert.ok(readme.includes(f), f);
  assert.match(readme, /no secret key/);
  assert.match(readme, /does not say that a signature is valid/);
});

test('G: a voided envelope\'s pack carries its marked copy; a draft has none; another member cannot take one; the page offers it', async () => {
  const sender = await person('Pack Void', 'packvoid@disputes.example');
  const v = await halfSigned(sender, 'pack');
  assert.equal((await sender.post(`/envelopes/${v.id}/void`, { reason: 'Changed my mind' })).status, 200);
  const zip = unzip((await sender.get(`/envelopes/${v.id}/evidence`)).data);
  assert.ok(zip['document-not-completed.pdf']);
  assert.ok(!zip['signed.pdf'] && !zip['certificate.pdf']);
  assert.match((await pagesOf(zip['document-not-completed.pdf']))[1], /VOIDED/);
  const draft = await simple(sender, 'pdraft@disputes.example');
  const d = await sender.get(`/envelopes/${draft.id}/evidence`);
  assert.equal(d.status, 400);
  assert.match(d.data.error, /has not been sent/);
  const stranger = await person('Not Theirs', 'stranger@disputes.example');
  assert.equal((await stranger.get(`/envelopes/${v.id}/evidence`)).status, 404);
  assert.equal((await from().get(`/envelopes/${v.id}/evidence`)).status, 401);
  assert.match(src('src/app/app/envelopes/[id]/page.tsx'), /href=\{`\/api\/envelopes\/\$\{e\.id\}\/evidence`\}/);
  assert.match(src('src/app/app/envelopes/[id]/page.tsx'), /Download evidence pack/);
});

// ---- H. How to read a certificate --------------------------------------------------------------------------------

test('H: the public page explains every line the certificate prints, is dated, and is linked from where people need it', async () => {
  const page = src('src/app/security/certificate/page.tsx');
  const { CERTIFICATE_PAGE_VERSION } = await import('../src/lib/evidence.ts');
  assert.match(CERTIFICATE_PAGE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(page, /Version of this page: \{CERTIFICATE_PAGE_VERSION\}/);
  // Every label drawCertificate prints has a block here. When the certificate changes, this fails until the page is
  // revised too: that is on purpose.
  const pdf = src('src/server/pdf.ts');
  const body = pdf.slice(pdf.indexOf('async function drawCertificate'), pdf.indexOf('// ---- Fillable forms'));
  const labels = new Set([...body.matchAll(/s\.(?:kv|h2)\('([^']+)'/g)].map((m) => m[1]));
  for (const m of body.matchAll(/\? '([^']+)' : '([^']+)', certGroup/g)) (labels.add(m[1]), labels.add(m[2]));
  assert.ok(labels.size >= 20, `found ${labels.size} labels`);
  const covered = (l: string) => page.toLowerCase().includes(l.toLowerCase()) || (/their time$/.test(l) && /times in their own zone/.test(page)) || (l === 'Recipients' && page.includes('<h2>Recipients</h2>'));
  for (const l of labels) assert.ok(covered(l), `the certificate prints "${l}" and /security/certificate does not explain it: revise the page and CERTIFICATE_PAGE_VERSION`);
  for (const l of ['Signed via Sign&Grow', 'Sign&Grow Envelope ID at the foot of every page', 'Signed without paper', 'Characters this PDF could not print']) assert.ok(page.includes(l), l);
  assert.match(page, /\{CHAIN_TRUTH\}/);
  assert.match(page, /\{WHO_WHEN_WHERE\}/);
  assert.match(page, /not a sworn statement, and not legal advice/);
  assert.match(page, /depends on the country and on the kind of document/);
  // Linked from the security page, /verify and the help answer.
  assert.match(src('src/app/security/page.tsx'), /href="\/security\/certificate"/);
  assert.match(src('src/app/verify/page.tsx'), /href="\/security\/certificate"/);
  assert.match(src('src/app/help/NotMe.tsx'), /href="\/security\/certificate"/);
});

test('F: a group member\'s code disputes only what that member did, and an in-person signer\'s code is said to be in the sender\'s emails too', async () => {
  const sender = await person('Group Dispute', 'gdsender@disputes.example');
  const members = [{ name: 'Maya Lopez', email: 'maya@hr-disputes.example' }, { name: 'Ben Ortiz', email: 'ben@hr-disputes.example' }];
  const group = (await sender.post('/groups', { name: 'HR team', members })).data.group;
  const { upload, PNG } = await import('./helpers.ts');
  const file = await upload(sender, 1);
  const e = (await sender.post('/envelopes', { subject: 'Staff handbook', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'g', role: 'signer', group_id: group.id }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const member = (email: string) => db.get('SELECT token, check_code FROM recipient_members WHERE envelope_id=? AND email=?', e.id, email);
  const maya = from();
  await maya.post(`/sign/${member('maya@hr-disputes.example').token}/consent`);
  const v = (await maya.get(`/sign/${member('maya@hr-disputes.example').token}`)).data;
  assert.equal((await maya.post(`/sign/${member('maya@hr-disputes.example').token}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: PNG })).status, 200);
  const ben = await from().post('/public/check/dispute', { code: member('ben@hr-disputes.example').check_code });
  assert.equal(ben.status, 409, JSON.stringify(ben.data));
  assert.match(ben.data.error, /HR team acted on this document through another member, Maya Lopez, so nothing was signed in your name/);
  const mine = await from().post('/public/check/dispute', { code: member('maya@hr-disputes.example').check_code });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.match(auditOf(e.id).find((a: any) => a.action === 'Disputed').detail, /Someone holding the email we sent to Maya Lopez <maya@hr-disputes\.example> said that Maya Lopez did not sign this/);

  // In person: the code is in the host's emails as well as in the signer's completed copy, and the record says so.
  const ip = await simple(sender, 'walkin@disputes.example', { recipients: [{ id: 'r', role: 'inperson', name: 'Walk In', email: 'walkin@disputes.example' }] });
  assert.equal((await sender.post(`/envelopes/${ip.id}/send`)).status, 200);
  assert.equal((await signAll(ip.id, 'walkin@disputes.example')).status, 200);
  assert.equal((await from().post('/public/check/dispute', { code: codeOf(ip.id, 'walkin@disputes.example') })).status, 200);
  assert.match(auditOf(ip.id).find((a: any) => a.action === 'Disputed').detail, /Someone holding the security code of Walk In <walkin@disputes\.example>, which is in our emails to the sender who hosted the signing/);
});

// ---- Repairs after the skeptic's report (research/verify-new.json, "verify:disputes") -----------------------------

test('Repair 1: the person named can dispute after the sender put another address under their name, with the code of our first email', async () => {
  const sender = await person('Mallory Sender', 'mallory@disputes.example');
  const e = await simple(sender, 'alice@disputes.example', { recipients: [{ id: 'r', role: 'signer', name: 'Alice Real', email: 'alice@disputes.example' }] });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const alice = codeOf(e.id, 'alice@disputes.example');
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', e.id).id;
  assert.equal((await sender.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, email: 'mallory-alt@disputes.example' })).status, 200);
  // Before anything is done in that place there is nothing to dispute, and the same code keeps working for later.
  const early = await from().post('/public/check/dispute', { code: alice });
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.equal(early.data.code, 'nothing_signed');
  assert.match(early.data.error, /come back with the same code/);
  assert.equal((await signAll(e.id, 'mallory-alt@disputes.example')).status, 200);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
  // Whoever holds the place now disputes first: that does not use up Alice's own dispute.
  assert.equal((await from().post(`/sign/${tokenFor(e.id, 'mallory-alt@disputes.example')}/dispute`, { detail: 'pre-empting' })).status, 200);
  const r = await from().post('/public/check/dispute', { code: alice, detail: 'The sender signed in my name.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.already, false);
  const lines = auditOf(e.id).filter((a: any) => a.action === 'Disputed');
  assert.equal(lines.length, 2);
  assert.match(lines[1].detail, /^Someone holding the email we sent to Alice Real <alice@disputes\.example>, before the address for that place on the document was changed, said that Alice Real did not sign this, or that it was not them\./);
  assert.equal(lines[1].actor, 'Someone holding the email sent to alice@disputes.example');
  assert.equal(db.get('SELECT COUNT(*) n FROM disputes WHERE envelope_id=?', e.id).n, 2);
  assert.equal((await from().get(`/public/verify/${e.id}`)).data.disputes, 2);
  // Saying it again with the same code changes nothing.
  assert.equal((await from().post('/public/check/dispute', { code: alice })).data.already, true);
  assert.equal(auditOf(e.id).filter((a: any) => a.action === 'Disputed').length, 2);
  assert.equal(env.verifyChain(e.id).ok, true);
});

test('Repair 1: after someone passed the document on through the person\'s link, both the code and the old link dispute it, once', async () => {
  const sender = await person('Handed Sender', 'handed@disputes.example');
  const e = await simple(sender, 'alice2@disputes.example', { recipients: [{ id: 'r', role: 'signer', name: 'Alice Two', email: 'alice2@disputes.example' }] });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const code = codeOf(e.id, 'alice2@disputes.example');
  const tok = tokenFor(e.id, 'alice2@disputes.example');
  const thief = from();
  await thief.post(`/sign/${tok}/consent`);
  assert.equal((await thief.post(`/sign/${tok}/reassign`, { name: 'Accomplice', email: 'accomplice@disputes.example', reason: 'Not mine' })).status, 200);
  assert.equal((await signAll(e.id, 'accomplice@disputes.example')).status, 200);
  const r = await from().post('/public/check/dispute', { code, detail: 'I never passed this on.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(auditOf(e.id).find((a: any) => a.action === 'Disputed').detail, /Someone holding the email we sent to Alice Two <alice2@disputes\.example>, before the document was passed on to someone else through its link, said that Alice Two did not pass this document on to someone else/);
  const byLink = await from().post(`/sign/${tok}/dispute`, {});
  assert.equal(byLink.status, 200, 'a replaced link is not a dead end for this');
  assert.equal(byLink.data.already, true, 'the code and the link of one email are one person');
  // A replaced link where nothing was done in that place is told so, and a link we never made is still 404.
  const later = await simple(sender, 'bob@disputes.example');
  assert.equal((await sender.post(`/envelopes/${later.id}/send`)).status, 200);
  const old = tokenFor(later.id, 'bob@disputes.example');
  assert.equal((await sender.post(`/envelopes/${later.id}/correct`, { recipient_id: db.get('SELECT id FROM recipients WHERE envelope_id=?', later.id).id, email: 'bob2@disputes.example' })).status, 200);
  assert.equal((await from().post(`/sign/${old}/dispute`, {})).status, 409);
  assert.equal((await from().post('/sign/nosuchtokenatall123/dispute', {})).status, 404);
  // The replaced-link screen says where to go.
  assert.match(src('src/components/sign/deadEnds.tsx'), /I did not sign this, or this was not me/);
});

test('Repair 1: a person taken off after they had signed can still dispute with their code; one taken off before anything was done cannot', async () => {
  const sender = await person('Removing Sender', 'removing@disputes.example');
  const { draft } = await import('./helpers.ts');
  const e = await draft(sender, { recipients: [
    { id: 'r1', role: 'signer', name: 'First Person', email: 'first@disputes.example', routing_order: 1 },
    { id: 'r2', role: 'signer', name: 'Second Person', email: 'second@disputes.example', routing_order: 1 },
    { id: 'r3', role: 'signer', name: 'Third Person', email: 'third@disputes.example', routing_order: 2 },
  ], fields: [
    { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
    { id: 'f2', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.25, h: 0.06 },
    { id: 'f3', document_id: 'd1', recipient_id: 'r3', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
  ] });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const first = codeOf(e.id, 'first@disputes.example');
  const third = codeOf(e.id, 'third@disputes.example');
  assert.equal((await signAll(e.id, 'first@disputes.example')).status, 200);
  // The sender takes the first person (who signed) and the third (who has done nothing) off.
  const now = (await sender.get(`/envelopes/${e.id}`)).data.envelope;
  const keep = now.recipients.filter((x: any) => x.email === 'second@disputes.example');
  const put = await sender.call('PUT', `/envelopes/${e.id}`, { ...now, recipients: keep, fields: now.fields.filter((f: any) => keep.some((k: any) => k.id === f.recipient_id)), resign: true });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const r = await from().post('/public/check/dispute', { code: first });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(auditOf(e.id).find((a: any) => a.action === 'Disputed').detail, /before that person was taken off the document, said that First Person did not sign this/);
  const t = await from().post('/public/check/dispute', { code: third });
  assert.equal(t.status, 409);
  assert.equal(t.data.code, 'nothing_signed');
});

test('Repair 3: the sender gets the person\'s words and the time, never their internet address or browser; the operators get both', async () => {
  process.env.OPERATOR_EMAILS = 'ops-r3@disputes.example';
  try {
    const sender = await person('Words Sender', 'words@disputes.example');
    const e = await completed(sender, 'words-signer@disputes.example', { subject: 'Loan' });
    const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const disputer = Object.assign(from(), { ip: '198.51.100.77' });
    const r = await disputer.call('POST', '/public/check/dispute', { code: codeOf(e.id, 'words-signer@disputes.example'), detail: 'He signed for me.' }, { 'user-agent': WIN });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // The record the sender reads, on the page and in the pack: no address, no browser.
    const view = (await sender.get(`/envelopes/${e.id}`)).data;
    const line = view.audit.find((a: any) => a.action === 'Disputed');
    assert.equal(line.ip, null);
    assert.equal(db.get("SELECT user_agent u FROM audit WHERE envelope_id=? AND action='Disputed'", e.id).u, null);
    assert.equal(env.verifyChain(e.id).ok, true);
    const zip = unzip((await sender.get(`/envelopes/${e.id}/evidence`)).data);
    const pl = JSON.parse(zip['audit-trail.json'].toString()).events.find((a: any) => a.action === 'Disputed');
    assert.equal(pl.ip, null);
    assert.equal(pl.user_agent, null);
    assert.match(zip['disputes.txt'].toString(), /They wrote: He signed for me\./);
    assert.match(zip['README.txt'].toString(), /disputes\.txt/);
    for (const f of Object.values(zip)) assert.ok(!f.toString('latin1').includes('198.51.100.77'), 'nowhere in the pack');
    // The words, on the envelope page: the disputes, without address or browser. Not for another account.
    const listed = await sender.get(`/envelopes/${e.id}/disputes`);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.disputes.length, 1);
    assert.equal(listed.data.disputes[0].detail, 'He signed for me.');
    assert.deepEqual(Object.keys(listed.data.disputes[0]).sort(), ['at', 'closed_at', 'closed_how', 'detail', 'name', 'via']);
    assert.equal((await (await person('Other Account', 'other-r3@disputes.example')).get(`/envelopes/${e.id}/disputes`)).status, 404);
    // The sender's email: the words and the time, and nothing of where it came from.
    const told = text(mailTo('words@disputes.example').filter((m: any) => m.subject === 'Disputed: Loan').pop().html);
    assert.match(told, /He signed for me\./);
    assert.match(told, /told us on \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.ok(!told.includes('198.51.100.77') && !/Chrome|Windows/.test(told));
    // The operators: the address and the browser, said to be theirs alone.
    const ops = text(mailTo('ops-r3@disputes.example').pop().html);
    assert.match(ops, /It came from internet address 198\.51\.100\.77, in Chrome on a Windows computer/);
    assert.match(ops, /Only you see this: the sender does not\./);
    assert.match(db.get("SELECT message FROM support_requests WHERE envelope_id=? AND topic='not-me'", e.id).message, /198\.51\.100\.77/);
    assert.equal(db.get('SELECT ip FROM disputes WHERE envelope_id=?', e.id).ip, '198.51.100.77');
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('Repair 3: every screen says, before it is sent, exactly what the sender will get, and the report line no longer says "not to the sender"', async () => {
  const { disputeSenderSees, DISPUTE_DOES } = await import('../src/lib/evidence.ts');
  const sees = disputeSenderSees('Demo Sender');
  assert.match(sees, /Demo Sender will see that you dispute it, the date and time, which email or link was used \(by the name and address it was sent to\), and what you write below, word for word\./);
  assert.match(sees, /will not see your internet address or which browser or device you use: those go only to the people who run Sign&Grow/);
  const dialogs = src('src/components/sign/dialogs.tsx');
  assert.match(dialogs, /reason === 'not-me' \? 'A dispute goes to the sender and to the Sign&Grow team\./);
  assert.match(dialogs, /\{disputeSenderSees\(sender\?\.name \|\| 'The sender'\)\}/);
  assert.match(dialogs, /\{DISPUTE_DOES\}/);
  assert.doesNotMatch(dialogs, /The sender is told that you dispute it, not what you write below/);
  const check = src('src/app/check/CheckForm.tsx');
  assert.match(check, /A dispute goes to the sender and to the people who run Sign&Grow, and it does not pause anyone\\'s account\./);
  assert.match(check, /\{disputeSenderSees\(sender \|\| 'The sender'\)\}/);
  assert.match(check, /dispute=\{false\}/, 'a document deleted before any dispute offers no dispute');
  assert.doesNotMatch(check, /the sender is not shown what you wrote/);
  const help = src('src/app/help/NotMe.tsx');
  assert.match(help, /what you wrote with the dispute, word for word\. Not the internet address or the browser you disputed from/);
  assert.match(help, /including the internet address and the browser a dispute came from/);
  assert.match(DISPUTE_DOES, /Nothing is changed, held or deleted/);
  assert.match(src('src/components/sender/Disputed.tsx'), /\/envelopes\/\$\{envelope\.id\}\/disputes/);
});

test('Repair 5: on a database from before first opens were written, the first open after the upgrade is not called the first', async () => {
  const sender = await person('Old Opens', 'old-opens@disputes.example');
  const e = await completed(sender, 'old-opener@disputes.example');
  const tok = tokenFor(e.id, 'old-opener@disputes.example');
  // The database as it was: no opens_noted_from, and copy_opened_at empty for everyone, whatever they did before.
  db.run('UPDATE recipients SET copy_opened_at=NULL WHERE envelope_id=?', e.id);
  db.run('ALTER TABLE envelopes DROP COLUMN opens_noted_from');
  const g = globalThis as any;
  g.__tsdb.close();
  g.__tsdb = undefined; // the next query opens the same file again and runs the upgrade, as a restart does
  assert.ok(db.get('SELECT opens_noted_from f FROM envelopes WHERE id=?', e.id).f, 'set for what was completed before');
  await from().call('GET', `/sign/${tok}/download`, undefined, { 'user-agent': UA });
  const line = auditOf(e.id).filter((a: any) => a.action === 'Completed copy opened');
  assert.equal(line.length, 1);
  assert.match(line[0].detail, /^Sam Signer downloaded the completed document, in Safari on an iPhone\. That is the first time since we began writing this down on \d{4}-\d\d-\d\d; they may have opened it before that\.$/);
  assert.doesNotMatch(line[0].detail, /for the first time/);
  // An envelope completed after the upgrade is written as before.
  const fresh = await completed(sender, 'new-opener@disputes.example');
  assert.equal(db.get('SELECT opens_noted_from f FROM envelopes WHERE id=?', fresh.id).f, null);
  await from().call('GET', `/sign/${tokenFor(fresh.id, 'new-opener@disputes.example')}/download`, undefined, { 'user-agent': UA });
  assert.match(auditOf(fresh.id).find((a: any) => a.action === 'Completed copy opened').detail, /downloaded the completed document for the first time, in Safari on an iPhone\./);
});

// A declined envelope: the named person declined (or someone did in their name), and disputes it.
async function declinedAndDisputed(sender: Client, email: string, subject: string) {
  const e = await simple(sender, email, { subject });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const c = from();
  const tok = tokenFor(e.id, email);
  await c.post(`/sign/${tok}/consent`);
  assert.equal((await c.post(`/sign/${tok}/decline`, { reason: 'Somebody declined in my name' })).status, 200);
  assert.equal((await from().post('/public/check/dispute', { code: codeOf(e.id, email), detail: 'I never declined anything.' })).status, 200);
  return e;
}

test('Repair 2: while a dispute is open its sender cannot delete the envelope for good, only take it out of their lists', async () => {
  const sender = await person('Eraser Sender', 'eraser@disputes.example');
  const e = await declinedAndDisputed(sender, 'erased@disputes.example', 'Declined one');
  assert.equal((await sender.get(`/envelopes/${e.id}`)).data.kept_on_delete, true, 'the dialog is told before');
  const del = await sender.call('DELETE', `/envelopes/${e.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.kept_for_recipients, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', e.id).n, 1, 'still there');
  assert.ok(db.get('SELECT hidden_at h FROM envelopes WHERE id=?', e.id).h);
  assert.equal(db.get('SELECT COUNT(*) n FROM disputes WHERE envelope_id=?', e.id).n, 1);
  assert.match(auditOf(e.id).find((a: any) => a.action === 'Removed from the sender\'s lists').detail, /It is kept, because a person named on it disputes it and Sign&Grow has not closed that dispute yet/);
  const look = (await from().get(`/public/verify/${e.id}`)).data;
  assert.equal(look.status, 'declined');
  assert.ok(look.disputed_at);
  assert.equal(look.disputes_open, 1);
  assert.match(src('src/app/app/envelopes/[id]/page.tsx'), /keptForDispute \? 'Deleted from your account\. It is kept while the dispute about it is open\.'/);
  // Once a person at Sign&Grow has closed it, the next one like it can be deleted for good, as before.
  process.env.OPERATOR_EMAILS = 'ops-r2@disputes.example';
  try {
    const ops = await person('Olga Operator', 'ops-r2@disputes.example');
    const other = await declinedAndDisputed(sender, 'erased2@disputes.example', 'Declined two');
    assert.equal((await sender.post(`/operator/disputes/${other.id}`, { how: 'handled', note: 'x' })).status, 404, 'operators only');
    assert.equal((await ops.post(`/operator/disputes/${other.id}`, { how: 'maybe', note: 'Looked at it.' })).status, 400);
    assert.equal((await ops.post(`/operator/disputes/${other.id}`, { how: 'handled', note: '' })).status, 400);
    const closed = await ops.post(`/operator/disputes/${other.id}`, { how: 'handled', note: 'Spoke to both; they settled it.' });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.match(auditOf(other.id).find((a: any) => a.action === 'Dispute closed').detail, /does not decide who is right: the envelope stays marked as disputed/);
    assert.equal(db.get("SELECT status FROM support_requests WHERE envelope_id=? AND topic='not-me'", other.id).status, 'closed', 'its alert closes with it');
    assert.equal((await ops.post(`/operator/disputes/${other.id}`, { how: 'handled', note: 'again' })).status, 404, 'nothing left open');
    assert.equal((await sender.get(`/envelopes/${other.id}`)).data.kept_on_delete, false);
    const gone = await sender.call('DELETE', `/envelopes/${other.id}`);
    assert.equal(gone.status, 200);
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', other.id).n, 0);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('Repair 2: deleting the account keeps the dispute (id, fingerprint, day, state, no names) until a person closes it, and /verify keeps saying it', async () => {
  process.env.OPERATOR_EMAILS = 'ops-r2b@disputes.example';
  try {
    const ops = await person('Omar Operator', 'ops-r2b@disputes.example');
    const sender = await person('Paula Fivesender', 'paula@disputes.example');
    const e = await completed(sender, 'settled@disputes.example', { subject: 'Secret settlement' });
    const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
    assert.equal((await from().post('/public/check/dispute', { code: codeOf(e.id, 'settled@disputes.example'), detail: 'I never signed the secret settlement, my ex did.' })).status, 200);
    const declined = await declinedAndDisputed(sender, 'declined-gone@disputes.example', 'Declined and gone');
    assert.equal((await sender.post('/me/delete', { password: PW, now: true })).status, 200);
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id IN (?,?)', e.id, declined.id).n, 0);
    // What is kept: those columns, and none of the names, addresses, title or words.
    const kept = db.all('SELECT * FROM forgotten_disputes WHERE envelope_id IN (?,?) ORDER BY status', e.id, declined.id);
    assert.equal(kept.length, 2);
    assert.deepEqual(Object.keys(kept[0]).sort(), ['at', 'disputed_on', 'envelope_id', 'file_sha256', 'status']);
    assert.match(kept[0].disputed_on, /^\d{4}-\d\d-\d\d$/);
    for (const word of ['Secret', 'settlement', 'Paula', 'disputes.example', 'Sam Signer', 'my ex']) assert.ok(!JSON.stringify(kept).includes(word), word);
    // /verify by file and the lookup by ID still say it is disputed, also for the one that was never completed.
    const v = (await verify(pdf)).data;
    assert.equal(v.deleted.envelope_id, e.id);
    assert.equal(v.deleted.disputed_on, kept.find((k: any) => k.envelope_id === e.id).disputed_on);
    assert.equal(v.deleted.dispute_open, true);
    const look = (await from().get(`/public/verify/${e.id}`)).data;
    assert.equal(look.status, 'deleted');
    assert.ok(look.disputed_at);
    const never = (await from().get(`/public/verify/${declined.id}`)).data;
    assert.equal(never.status, 'deleted');
    assert.equal(never.was, 'declined');
    assert.equal(never.completed_at, null);
    assert.ok(never.disputed_at);
    for (const res of [v, look, never]) assert.ok(!/Secret|Paula|disputes\.example|my ex/.test(JSON.stringify(res)));
    assert.match(src('src/app/verify/page.tsx'), /res\.deleted\.disputed_on &&/);
    assert.match(src('src/app/verify/ById.tsx'), /Never completed, deleted since/);
    // The alert follows the support rules for deletion: kept while open (with nothing tying it to the account),
    // then forgotten. Closing it in the queue closes the dispute, and what was kept of it goes.
    const alert = db.get("SELECT * FROM support_requests WHERE envelope_id=? AND topic='not-me'", e.id);
    assert.equal(alert.status, 'open');
    assert.equal(alert.forget, 1);
    assert.equal(alert.account_id, null);
    const close = await ops.post(`/operator/support/${alert.id}`, { action: 'close', text: 'Told the person the account is gone; nothing more we can do.' });
    assert.equal(close.status, 200, JSON.stringify(close.data));
    assert.equal(db.get('SELECT COUNT(*) n FROM forgotten_disputes WHERE envelope_id=?', e.id).n, 0);
    assert.equal((await verify(pdf)).data.deleted.disputed_on, null);
    assert.equal((await from().get(`/public/verify/${e.id}`)).data.disputed_at, null);
    // The never-completed one is closed from the operator route, and then nothing about it is left at all.
    assert.equal((await ops.post(`/operator/disputes/${declined.id}`, { how: 'handled', note: 'Account gone.' })).status, 200);
    assert.equal((await from().get(`/public/verify/${declined.id}`)).status, 404);
    db.run("UPDATE support_requests SET updated_at=? WHERE envelope_id IN (?,?) AND topic='not-me'", ago(31), e.id, declined.id);
    await cron.tick();
    assert.equal(db.get("SELECT COUNT(*) n FROM support_requests WHERE envelope_id IN (?,?) AND topic='not-me'", e.id, declined.id).n, 0, 'then forgotten');
    // The pages that list what stays after a deletion say it.
    const { KEPT_AFTER_DELETION } = await import('../src/lib/policy.ts');
    assert.ok(KEPT_AFTER_DELETION.some((l) => /For a document someone named on it disputes, while a person at Sign&Grow has not closed that dispute: its envelope ID, the fingerprint of its signed file, the day of the dispute and the state the document was in, with no names and no addresses/.test(l)));
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('Repair 2: a dispute closed as filed in error is said next to the mark, which stays', async () => {
  process.env.OPERATOR_EMAILS = 'ops-r2c@disputes.example';
  try {
    const ops = await person('Ida Operator', 'ops-r2c@disputes.example');
    const sender = await person('Honest Sender', 'honest@disputes.example');
    const e = await completed(sender, 'forwarded@disputes.example', { subject: 'Honest sale' });
    assert.equal((await from().post('/public/check/dispute', { code: codeOf(e.id, 'forwarded@disputes.example') })).status, 200);
    assert.equal((await ops.post(`/operator/disputes/${e.id}`, { how: 'in_error', note: 'The signer says a colleague used the forwarded email.' })).status, 200);
    const look = (await from().get(`/public/verify/${e.id}`)).data;
    assert.ok(look.disputed_at, 'the mark stays');
    assert.equal(look.disputes_open, 0);
    assert.match(look.dispute_in_error_on, /^\d{4}-\d\d-\d\d$/);
    const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
    assert.match((await verify(pdf)).data.envelope.dispute_in_error_on, /^\d{4}-\d\d-\d\d$/);
    assert.match(auditOf(e.id).find((a: any) => a.action === 'Dispute closed').detail, /found that it was filed in error/);
    assert.equal(env.verifyChain(e.id).ok, true);
    assert.match(src('src/app/verify/ById.tsx'), /res\.dispute_in_error_on/);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('Repair 4: the mark covers every corner of a page, survives a black-and-white copy, and labels each signature', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { drawStamp, markFields, stampFor } = await import('../src/server/stamp.ts');
  for (const [w, h, rotation] of [[612, 792, 0], [842, 595, 0], [595, 842, 90]] as const) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([w, h]);
    if (rotation) page.setRotation((await import('pdf-lib')).degrees(rotation));
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const drawn: any[] = [];
    const real = page.drawText.bind(page);
    page.drawText = ((text: string, o: any) => (drawn.push({ text, ...o }), real(text, o))) as any;
    drawStamp(page, font, stampFor('voided'));
    // What a copier in black-and-white text mode keeps: ink over white darker than half-grey.
    const grey = (o: any) => 255 * (1 - (o.opacity ?? 1)) + (o.opacity ?? 1) * 255 * (0.2126 * o.color.red + 0.7152 * o.color.green + 0.0722 * o.color.blue);
    const kept = drawn.filter((o) => grey(o) < 128);
    assert.ok(kept.length >= 30, `${kept.length} dark words`);
    // Every one of the sixteen squares of a four-by-four grid over the page holds dark words, corners included.
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const inside = kept.some((o) => o.x >= (i * w) / 4 - 40 && o.x < ((i + 1) * w) / 4 && o.y >= (j * h) / 4 - 40 && o.y < ((j + 1) * h) / 4);
      assert.ok(inside, `square ${i},${j} of a ${w}x${h} page turned ${rotation}`);
    }
    // A signature in the lower right is framed and labelled.
    const before = drawn.length;
    markFields([page], [{ page: 0, type: 'signature', value: '1', x: 0.6, y: 0.84, w: 0.3, h: 0.07 }, { page: 0, type: 'text', value: 'x', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], font, stampFor('voided'));
    assert.equal(drawn.slice(before).length, 1, 'the word in the signature only');
    assert.equal(drawn[before].text, 'VOIDED');
    assert.ok(grey(drawn[before]) < 128);
  }
});

test('Repair 4: a copy made while the envelope is still out says so on every page; the completed one and the kept earlier copy carry no such mark', async () => {
  const sender = await person('Early Sender', 'early-copy@disputes.example');
  const v = await halfSigned(sender, 'early');
  const pages = await pagesOf((await sender.get(`/envelopes/${v.id}/download`)).data);
  assert.equal(pages.length, 2);
  for (const p of pages) {
    assert.match(p, /NOT COMPLETED YET: not everyone has signed/);
    assert.ok((p.match(/NOT COMPLETED YET · NOT EVERYONE HAS SIGNED/g) || []).length >= 20, 'across the whole page');
  }
  // Ada's own copy, downloaded after she signed while Ben has not.
  const ada = await pagesOf((await from().get(`/sign/${tokenFor(v.id, 'ada-early@disputes.example')}/download`)).data);
  for (const p of ada) assert.match(p, /NOT COMPLETED YET/);
  // The evidence pack's copy of the document so far as well.
  assert.match((await pagesOf(unzip((await sender.get(`/envelopes/${v.id}/evidence`)).data)['document-so-far.pdf']))[0], /NOT COMPLETED YET/);
  // Voided afterwards: a fresh copy says voided, with the signature labelled.
  assert.equal((await sender.post(`/envelopes/${v.id}/void`, { reason: 'Terms changed' })).status, 200);
  const closed = await pagesOf((await sender.get(`/envelopes/${v.id}/download`)).data);
  assert.ok((closed[1].match(/VOIDED · NOT A SIGNED DOCUMENT/g) || []).length >= 20);
  assert.match(closed[1], /VOIDED: NOT A SIGNED DOCUMENT/, 'at the bottom as well as the top');
  // The finished document is the signed file itself, unmarked.
  const done = await completed(sender, 'early-done@disputes.example');
  assert.ok(!(await pagesOf((await sender.get(`/envelopes/${done.id}/download`)).data)).some((p) => /NOT COMPLETED|NOT A SIGNED/.test(p)));
  // What someone signed before a change is kept unmarked and marked once, as such, when it is handed out.
  const { buildPdf } = await import('../src/server/envelopes.ts');
  const out = await simple(sender, 'kept-copy@disputes.example');
  assert.equal((await sender.post(`/envelopes/${out.id}/send`)).status, 200);
  const e = env.loadEnvelope(out.id);
  assert.ok(!(await pagesOf(await buildPdf(e, false, e.recipients[0].id, undefined, false))).some((p) => /NOT COMPLETED/.test(p)));
  assert.ok((await pagesOf(await buildPdf(e, false))).every((p) => /NOT COMPLETED YET/.test(p)), 'marked unless the caller says otherwise');
});
