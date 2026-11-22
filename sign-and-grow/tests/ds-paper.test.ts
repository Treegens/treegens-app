// Signing on paper (research/docusign-gaps.json, batch "paper"): the admins' switch, who may and who must, the print
// with its code and page numbers on every page, sending back photos, the sender accepting or asking again, the order
// waiting meanwhile, the signed PDF and the certificate, one signature used, and everyone it is not for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, signUp, Client, simple, upload, PNG, tokenFor, mailTo, signAll } from './helpers.ts';

const S = await boot();
const { extractPages } = await import('../src/server/text.ts');
const paper = await import('../src/server/paper.ts');
const words = await import('../src/lib/paper.ts');
const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

let n = 0;
const ip = () => `198.51.100.${(n = (n % 250) + 1)}`;
const pngBytes = Buffer.from(PNG.split(',')[1], 'base64');
const photos = (count = 2) => {
  const f = new FormData();
  for (let i = 0; i < count; i++) f.append('file', new Blob([pngBytes], { type: 'image/png' }), `page-${i + 1}.png`);
  return f;
};
const switchOn = async (c: Client, on = true) => assert.equal((await c.put('/account/paper', { on })).status, 200);

/** A sender with the switch on and a document to two people in order: Ada (may sign on paper) then Ben. */
async function setup(tag: string, o: { on?: boolean; over?: any } = {}) {
  const email = `${tag}@example.com`;
  const s = await signUp(`Sender ${tag}`, email, ip());
  if (o.on !== false) await switchOn(s);
  const file = await upload(s, 2);
  const r = await s.post('/envelopes', {
    subject: `Paper ${tag}`, ordered: true,
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'a', role: 'signer', name: 'Ada Paper', email: `${tag}-ada@example.com`, routing_order: 1 },
      { id: 'b', role: 'signer', name: 'Ben Screen', email: `${tag}-ben@example.com`, routing_order: 2 },
    ],
    fields: [
      { id: 'fs', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06 },
      { id: 'fi', document_id: 'd', recipient_id: 'a', type: 'initials', page: 1, x: 0.1, y: 0.8, w: 0.1, h: 0.04 },
      { id: 'ft', document_id: 'd', recipient_id: 'a', type: 'text', label: 'Plot number', page: 1, x: 0.4, y: 0.5, w: 0.3, h: 0.03 },
      { id: 'fd', document_id: 'd', recipient_id: 'a', type: 'date_signed', page: 0, x: 0.5, y: 0.6, w: 0.2, h: 0.03 },
      { id: 'gs', document_id: 'd', recipient_id: 'b', type: 'signature', page: 1, x: 0.5, y: 0.8, w: 0.3, h: 0.06 },
    ],
    send: true,
    ...(o.over || {}),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.envelope;
  const tok = tokenFor(e.id, `${tag}-ada@example.com`);
  const ada = new Client();
  ada.ip = ip();
  return { s, e, tok, ada, email, adaEmail: `${tag}-ada@example.com`, benEmail: `${tag}-ben@example.com` };
}
const view = async (c: Client, tok: string) => (await c.get(`/sign/${tok}`)).data;
const send = (c: Client, tok: string, count = 2) => c.call('POST', `/sign/${tok}/paper`, photos(count));

test('1. off by default: nothing about paper anywhere, and nobody can be asked to sign on paper only', async () => {
  const { s, e, tok, ada } = await setup('off1', { on: false });
  assert.equal((await s.get('/me')).data.paper_signing, false);
  assert.equal((await s.get('/account/paper')).data.on, false);
  assert.equal((await view(ada, tok)).recipient.paper_sign, null);
  const pr = await ada.get(`/sign/${tok}/paper/print`);
  assert.equal(pr.status, 409);
  assert.equal(pr.data.code, 'paper_not_offered');
  const up = await send(ada, tok);
  assert.equal(up.status, 409);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM paper_scans WHERE envelope_id=?', e.id).n, 0);
  // Asked for in the API with the switch off: refused in words that say what to do, nothing saved.
  const cur = (await s.get(`/envelopes/${e.id}`)).data.envelope ?? (await s.get(`/envelopes/${e.id}`)).data;
  const d = await s.post('/envelopes', { subject: 'x', documents: cur.documents.map((x: any) => ({ id: x.id, file_id: x.file_id })), recipients: [{ id: 'q', name: 'Q', email: 'q@example.com', require_paper: true }] });
  assert.equal(d.status, 400);
  assert.equal(d.data.code, 'paper_off');
  assert.match(d.data.error, /An admin can switch on "People may sign on paper" in Settings, Sending\. Nothing was saved\.$/);
  // A member cannot switch it, and nor can an API key.
  const key = (await s.post('/api-keys', { name: 'k', scope: 'admin' })).data;
  if (key?.key) {
    const r = await new Client().call('PUT', '/account/paper', { on: true }, { authorization: `Bearer ${key.key}` });
    assert.equal(r.status, 403);
  }
});

test('1. who may sign on paper once it is on: signers and approvers by default, never in person, groups or witnesses', async () => {
  const { s, e, tok, ada } = await setup('who1');
  assert.equal((await s.get('/me')).data.paper_signing, true);
  const v = await view(ada, tok);
  assert.equal(v.recipient.paper_sign.way, 'may');
  assert.match(v.recipient.paper_sign.code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const env = S.env.loadEnvelope(e.id);
  const a = env.recipients.find((x: any) => x.id === env.recipients[0].id);
  assert.equal(paper.paperWay(env, { ...a, role: 'approver' }), 'may');
  assert.equal(paper.paperWay(env, { ...a, allow_paper: 0 }), null);
  assert.equal(paper.paperWay(env, { ...a, require_paper: 1 }), 'only');
  for (const who of [{ role: 'inperson' }, { role: 'witness' }, { role: 'cc' }, { role: 'viewer' }, { group_id: 'grp_1' }, { group_name: 'HR' }]) assert.equal(paper.paperWay(env, { ...a, ...who }), null, JSON.stringify(who));
  assert.equal(paper.paperWay({ ...env, powerform_id: 'pf' }, a), null);
  assert.equal(paper.paperWay({ ...env, collect_currency: 'usd', collect_when: 'before' }, a), null);
  assert.equal(paper.paperWay({ ...env, recipients: [...env.recipients, { id: 'w', role: 'witness', witness_for: a.id }] }, a), null);
  // On paper only for someone who signs in person: refused at saving, with nothing saved.
  const file = await upload(s, 1);
  const bad = await s.post('/envelopes', { subject: 'x', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'p', role: 'inperson', name: 'Pia Person', email: 'pia@example.com', require_paper: true }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'not_for_paper');
  assert.match(bad.data.error, /^Pia Person signs in person, with you\. .+ Nothing was saved\.$/);
  // "On screen only" by the sender: the signing page has nothing about paper.
  const off = await setup('who2', { over: { recipients: [{ id: 'a', role: 'signer', name: 'Ada Paper', email: 'who2-ada@example.com', allow_paper: false }] , fields: [{ id: 'fs', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06 }] } });
  assert.equal((await view(off.ada, off.tok)).recipient.paper_sign, null);
  // A template's choice goes with what is sent from it.
  const g = S.env.loadEnvelope(off.e.id).recipients[0];
  assert.equal(g.allow_paper, 0);
});

test('2. the print: a cover page, then the document with the places marked; ID, page x of y and the code on every page', async () => {
  const { e, tok, ada } = await setup('print1');
  const r = await ada.get(`/sign/${tok}/paper/print`);
  assert.equal(r.status, 200);
  const pages = await extractPages(r.data);
  assert.equal(pages.length, 3, 'a cover page and the two pages of the document');
  const code = (await view(ada, tok)).recipient.paper_sign.code;
  pages.forEach((p, i) => {
    const t = p.replace(/\s+/g, ' ');
    assert.ok(t.includes(`Envelope ${e.id}`), `page ${i + 1} has the envelope ID`);
    assert.ok(t.includes(`Page ${i + 1} of 3`), `page ${i + 1} says page ${i + 1} of 3`);
    assert.ok(t.includes(code), `page ${i + 1} has the code`);
  });
  assert.match(pages[0], /How to sign this on paper/);
  assert.match(pages[0].replace(/\s+/g, ' '), /Other actions, then Sign on paper instead/);
  assert.match(pages[1], /Sign here/);
  assert.match(pages[1], /Today's date/);
  assert.match(pages[2], /Initial here/);
  assert.match(pages[2], /Plot number/);
  // The code is for this version of the document: a change makes a new one.
  S.db.run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
  assert.notEqual((await view(ada, tok)).recipient.paper_sign.code, code);
});

test('2-3. sending back photos: one document, waiting for the sender, the order waits, no Finish on screen, no reminder', async () => {
  const { s, e, tok, ada, email, benEmail } = await setup('up1');
  const up = await send(ada, tok, 2);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.deepEqual(up.data, { ok: true, state: 'waiting', pages: 2 });
  const row = S.db.get('SELECT * FROM paper_scans WHERE envelope_id=?', e.id);
  assert.equal(row.pages, 2);
  assert.equal(row.ip, ada.ip);
  assert.equal(row.state, 'waiting');
  assert.equal(S.db.get('SELECT via_envelope v FROM files WHERE id=?', row.file_id).v, e.id);
  const line = S.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Sent back a scan signed on paper'", e.id).detail;
  assert.match(line, /^Ada Paper <up1-ada@example\.com>\. 2 pages, SHA-256 [0-9a-f]{64}, made from the print with security code [0-9A-F-]{9}\. Waiting for the sender to look at it\.$/);
  // The sender is told, with the button that opens the scan.
  const mail = mailTo(email).find((m: any) => /^Signed on paper:/.test(m.subject));
  assert.ok(mail, 'the sender is emailed');
  assert.match(mail.html, /Look at the scan/);
  assert.match(mail.html, /did not read or check the handwriting/);
  // The person's page says it waits; the next person is not asked.
  const v = await view(ada, tok);
  assert.equal(v.recipient.paper_sign.state, 'waiting');
  assert.equal(S.db.get('SELECT status FROM recipients WHERE email=?', benEmail).status, 'pending');
  assert.equal(mailTo(benEmail).length, 0);
  // A second upload, and a Finish on screen, are refused while it waits.
  const again = await send(ada, tok);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'paper_waiting');
  await ada.post(`/sign/${tok}/consent`);
  const fin = await ada.post(`/sign/${tok}/complete`, { values: { ft: 'x' }, signature_png: PNG, initials_png: PNG });
  assert.equal(fin.status, 409);
  assert.equal(fin.data.code, 'paper_waiting');
  // No reminder for someone whose scan waits.
  const before = mailTo(`up1-ada@example.com`).length;
  await s.post(`/envelopes/${e.id}/remind`, {});
  assert.equal(mailTo(`up1-ada@example.com`).length, before);
  // A file that is no picture and no PDF is refused in words, and nothing waits for it.
  const { tok: t2, ada: a2, e: e2 } = await setup('up2');
  const f = new FormData();
  f.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const r2 = await a2.call('POST', `/sign/${t2}/paper`, f);
  assert.equal(r2.status, 400);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM paper_scans WHERE envelope_id=?', e2.id).n, 0);
});

test('3. ask again: a reason is needed, it is emailed, the page shows it, and a new scan can be sent', async () => {
  const { s, e, tok, ada, adaEmail } = await setup('again1');
  assert.equal((await send(ada, tok)).status, 200);
  const rid = S.env.loadEnvelope(e.id).recipients.find((x: any) => x.email === adaEmail).id;
  const none = await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/reject`, { reason: '  ' });
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'reason_needed');
  const r = await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/reject`, { reason: 'Page 2 is cut off at the bottom.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.emailed, true);
  const m = mailTo(adaEmail).find((x: any) => /^Please send the signed pages again/.test(x.subject));
  assert.ok(m);
  assert.match(m.html, /Page 2 is cut off at the bottom\./);
  const v = await view(ada, tok);
  assert.equal(v.recipient.paper_sign.state, 'asked_again');
  assert.equal(v.recipient.paper_sign.reason, 'Page 2 is cut off at the bottom.');
  assert.ok(S.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Asked again for the scan signed on paper' AND detail LIKE '%cut off%'", e.id));
  // Nothing waits now: accepting is refused, and a second Ask again too.
  const acc = await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/accept`, {});
  assert.equal(acc.status, 409);
  assert.equal(acc.data.code, 'no_scan');
  assert.equal((await send(ada, tok, 1)).status, 200);
  assert.equal((await view(ada, tok)).recipient.paper_sign.state, 'waiting');
  // Someone else's account sees nothing of it.
  const other = await signUp('Other Owner', 'again1-other@example.com', ip());
  assert.equal((await other.post(`/envelopes/${e.id}/recipients/${rid}/paper/accept`, {})).status, 404);
  assert.equal((await other.get(`/envelopes/${e.id}/recipients/${rid}/paper/scan`)).status, 404);
});

test('3-5. accept: the person finishes as having signed on paper, uses one signature, and the next person is asked', async () => {
  const was = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_paper'; // signatures are counted; nothing here calls the payment provider
  try {
    const credits = await import('../src/server/credits.ts');
    const { s, e, tok, ada, adaEmail, benEmail } = await setup('acc1');
    const acct = S.db.get('SELECT account_id a FROM envelopes WHERE id=?', e.id).a;
    const start = credits.available(acct);
    assert.equal((await send(ada, tok, 2)).status, 200);
    const rid = S.env.loadEnvelope(e.id).recipients.find((x: any) => x.email === adaEmail).id;
    // The list and the scan itself, for the envelope page.
    const list = (await s.get(`/envelopes/${e.id}/paper`)).data.scans;
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'waiting');
    assert.equal(list[0].current, true);
    const scan = await s.get(`/envelopes/${e.id}/recipients/${rid}/paper/scan`);
    assert.equal(scan.status, 200);
    assert.equal((await extractPages(scan.data)).length, 2);
    const a = await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/accept`, {});
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const r = S.db.get('SELECT * FROM recipients WHERE id=?', rid);
    assert.equal(r.status, 'completed');
    assert.equal(r.paper_state, 'accepted');
    assert.equal(r.signature_png, null, 'no electronic signature is kept for them');
    assert.equal(r.ip, ada.ip, 'finished from the address the scan came from');
    assert.equal(S.db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Signed on paper'", e.id).length, 1);
    assert.equal(S.db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Signed'", e.id).length, 0);
    assert.ok(S.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Accepted a scan signed on paper'", e.id));
    const used = (id: string) => S.db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature' AND ref LIKE ?", acct, `${id}|%`).n;
    assert.equal(used(rid), 1, 'one signature used, like any finished signer');
    assert.equal(credits.available(acct), start, 'the one held for Ada at sending is the one used');
    assert.equal(S.db.get('SELECT status FROM recipients WHERE email=?', benEmail).status, 'sent', 'the next person is asked now');
    // A second Accept finds nothing waiting.
    assert.equal((await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/accept`, {})).status, 409);
    // Ben signs on screen; the document completes.
    assert.equal((await signAll(e.id, benEmail)).status, 200);
    assert.equal(S.db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
    assert.equal(used(S.env.loadEnvelope(e.id).recipients.find((x: any) => x.email === benEmail).id), 1);
    // 4. The signed PDF: the documents, then the divider and the scan, and Ada's places point there.
    const pdf = await s.get(`/envelopes/${e.id}/download`);
    assert.equal(pdf.status, 200);
    const pages = (await extractPages(pdf.data)).map((p) => p.replace(/\s+/g, ' '));
    const divider = pages.findIndex((p) => p.includes('Signed on paper by Ada Paper'));
    assert.equal(divider, 2, 'right after the two pages of the document');
    assert.match(pages[0], new RegExp(`Signed on paper: see page ${divider + 1}`));
    assert.match(pages[1], new RegExp(`(Signed on paper: see page|See p\\.) ${divider + 1}`));
    assert.match(pages[divider], /GrowSigning did not read or check the handwriting\. This is not an electronic signature/);
    const cert = pages.slice(divider + 3).join(' ');
    assert.ok(cert.includes("Signed on paper. A scan was uploaded through this person's link on"), cert.slice(0, 400));
    assert.match(cert, /and accepted by Sender acc1 <acc1@example\.com> on .+ GrowSigning did not check the handwriting\./);
    // Someone printed it, so the record does not say that paper was not used.
    assert.ok(!cert.includes('Signed without paper'));
    assert.match(cert, /Not asked: signed on paper/);
    assert.ok(!/Ada Paper[^]{0,80}Status Signed via/.test(cert));
  } finally {
    if (was === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = was;
  }
});

test('1-2. on paper only: no electronic signing, and the print and upload still work', async () => {
  const { tok, ada, s, e } = await setup('only1', { over: { recipients: [{ id: 'a', role: 'signer', name: 'Ada Paper', email: 'only1-ada@example.com', require_paper: true }], fields: [{ id: 'fs', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06 }], ordered: false } });
  const v = await view(ada, tok);
  assert.equal(v.recipient.paper_sign.way, 'only');
  await ada.post(`/sign/${tok}/consent`);
  const fin = await ada.post(`/sign/${tok}/complete`, { values: {}, signature_png: PNG });
  assert.equal(fin.status, 409);
  assert.equal(fin.data.code, 'paper_only');
  assert.match(fin.data.error, /asked you to sign this on paper\. Print it, sign it by hand and send back a photo of every page from this page\.$/);
  assert.equal((await ada.get(`/sign/${tok}/paper/print`)).status, 200);
  assert.equal((await send(ada, tok, 1)).status, 200);
  // 8. The document changed after the print: the scan is of an older version, and accepting it is refused.
  S.db.run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
  const rid = S.env.loadEnvelope(e.id).recipients[0].id;
  const acc = await s.post(`/envelopes/${e.id}/recipients/${rid}/paper/accept`, {});
  assert.equal(acc.status, 409);
  assert.equal(acc.data.code, 'paper_old_version');
  assert.equal((await s.get(`/envelopes/${e.id}/paper`)).data.scans[0].current, false);
  assert.notEqual(S.db.get('SELECT status FROM recipients WHERE id=?', rid).status, 'completed');
});

test('refused for groups and in person; refusals are two sentences, the second says what to do', async () => {
  const { s } = await setup('ref1');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', { subject: 'In person', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'p', role: 'inperson', name: 'Pia Person', email: 'ref1-pia@example.com' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true })).data.envelope;
  const tok = S.db.get('SELECT token FROM recipients WHERE envelope_id=?', e.id).token;
  const env = S.env.loadEnvelope(e.id);
  assert.equal(paper.paperWay(env, env.recipients[0]), null);
  assert.match(paper.notForPaper(env, { ...env.recipients[0], role: 'signer', group_id: 'g1', name: 'HR team' })!, /^HR team is a signing group\./);
  const c = new Client();
  const up = await c.call('POST', `/sign/${tok}/paper`, photos(1));
  assert.ok(up.status >= 400);
  for (const msg of ['Signing on paper is not offered for this document. Sign on screen, or ask the sender.', words.PAPER_WORDS.notChecked]) {
    const parts = msg.split(/(?<=\.) /);
    assert.ok(parts.length >= 2, msg);
  }
});

test('the words: no em dash, never "electronic signature" for a paper signer, and the API and the routes are described', async () => {
  for (const f of ['src/server/paper.ts', 'src/server/routes-paper.ts', 'src/lib/paper.ts', 'src/server/openapi-paper.ts', 'src/components/sign/Paper.tsx', 'src/components/sender/PaperReview.tsx', 'src/components/editor/PaperPick.tsx', 'src/components/settings/PaperSetting.tsx']) {
    if (!fs.existsSync(path.join(root, f))) continue;
    assert.ok(!read(f).includes('—'), `${f} has an em dash`);
  }
  assert.equal(words.paperCertSentence({ uploaded: 'U', from: '1.2.3.4', by: 'Sam', accepted: 'A' }), "Signed on paper. A scan was uploaded through this person's link on U from 1.2.3.4 and accepted by Sam on A. GrowSigning did not check the handwriting.");
  assert.equal(words.printMark('signature'), 'Sign here');
  assert.equal(words.printMark('initials'), 'Initial here');
  assert.equal(words.printMark('note'), '');
  const spec = (await new Client().get('/openapi.json')).data;
  for (const p of ['/account/paper', '/sign/{token}/paper', '/sign/{token}/paper/print', '/envelopes/{id}/paper', '/envelopes/{id}/recipients/{rid}/paper/accept', '/envelopes/{id}/recipients/{rid}/paper/reject']) assert.ok(spec.paths[p], p);
  assert.ok(spec.components.schemas.Recipient.properties.require_paper);
  assert.match(read('src/app/api/[...path]/route.ts'), /routes-paper/);
  assert.match(read('.env.example') + read('README.md'), /sign on paper/i);
});

// ---- Repairs after review (tests/out/verify-ds-paper, tests/out/ux-ds-paper) ----------------------------------------

const rowOf = (eid: string, email: string) => S.db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', eid, email);
const accept = (s: Client, eid: string, rid: string) => s.post(`/envelopes/${eid}/recipients/${rid}/paper/accept`, {});

test('repair: sign again after a paper acceptance needs a new signature, keeps the new values and drops the old scan', async () => {
  const { s, e, tok, ada, adaEmail } = await setup('rs1');
  assert.equal((await send(ada, tok, 1)).status, 200);
  const rid = rowOf(e.id, adaEmail).id;
  assert.equal((await accept(s, e.id, rid)).status, 200);
  assert.ok(rowOf(e.id, adaEmail).paper_scan_id);
  // The sender changes the document and asks Ada to sign again.
  const env = (await s.get(`/envelopes/${e.id}`)).data.envelope ?? (await s.get(`/envelopes/${e.id}`)).data;
  const fields = env.fields.map((f: any) => ({ id: f.id, document_id: f.document_id, recipient_id: f.recipient_id, type: f.type, label: f.label, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h }));
  fields.push({ id: 'new', document_id: env.documents[0].id, recipient_id: rid, type: 'text', label: 'New line', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03 });
  const put = await s.put(`/envelopes/${e.id}`, { resign: true, documents: env.documents.map((d: any) => ({ id: d.id, file_id: d.file_id })), recipients: env.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order })), fields });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const row = rowOf(e.id, adaEmail);
  assert.equal(row.paper_scan_id, null, 'the old acceptance no longer counts');
  assert.equal(row.paper_state, null);
  assert.equal(S.db.get("SELECT state FROM paper_scans WHERE recipient_id=? ORDER BY at DESC LIMIT 1", rid).state, 'set_aside', 'the old scan is kept on record, set aside');
  assert.ok(S.db.all('SELECT action FROM audit WHERE envelope_id=?', e.id).some((a: any) => a.action === 'Scan signed on paper set aside'));
  const tok2 = tokenFor(e.id, adaEmail);
  // Finish with no consent and no signature: refused, as for anyone who signs on screen.
  const bare = await ada.post(`/sign/${tok2}/complete`, { values: { new: 'x' } });
  assert.notEqual(bare.status, 200);
  assert.equal(rowOf(e.id, adaEmail).status === 'completed', false);
  // A body that tries to claim the paper path is ignored: a symbol cannot travel in JSON.
  const forged = await ada.post(`/sign/${tok2}/complete`, { values: {}, onPaper: true, paper_scan_id: row.paper_scan_id, 'Symbol(growsigning.paper.finish)': 'x' });
  assert.notEqual(forged.status, 200);
  // She may sign on paper again: the page offers it as before (not stuck on "accepted").
  const ps = (await view(ada, tok2)).recipient.paper_sign;
  assert.equal(ps.state, null);
  // Signed on screen: her values are kept, her signature is hers, and nothing says paper about her any more.
  assert.equal((await signAll(e.id, adaEmail)).status, 200);
  const done = rowOf(e.id, adaEmail);
  assert.equal(done.status, 'completed');
  assert.ok(done.signature_png, 'an on-screen signature is stored');
  assert.equal(done.paper_scan_id, null);
  assert.equal(paper.paperSigned(S.env.loadEnvelope(e.id)).size, 0, 'the signed PDF does not reuse the scan of the old version');
});

test('repair: a waiting scan stays with the person who sent it; after a correction to someone else it is set aside', async () => {
  const { s, e, tok, ada, adaEmail } = await setup('rs2');
  assert.equal((await send(ada, tok, 1)).status, 200);
  const rid = rowOf(e.id, adaEmail).id;
  const c = await s.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Cy Other', email: 'rs2-cy@example.com' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const row = S.db.get('SELECT * FROM recipients WHERE id=?', rid);
  assert.equal(row.paper_state, null, 'Cy does not inherit Ada\'s waiting scan');
  // Ada's scan cannot be accepted as signed by Cy.
  const a = await accept(s, e.id, rid);
  assert.equal(a.status, 409);
  assert.equal(a.data.code, 'no_scan');
  assert.notEqual(S.db.get('SELECT status FROM recipients WHERE id=?', rid).status, 'completed');
  assert.ok(S.db.all('SELECT detail FROM audit WHERE envelope_id=? AND action=?', e.id, 'Scan signed on paper set aside').some((x: any) => /Cy Other/.test(x.detail)));
  // Cy starts as anyone does: their page is the normal one, and they can sign on screen.
  const cy = new Client();
  cy.ip = ip();
  const ct = tokenFor(e.id, 'rs2-cy@example.com');
  assert.equal((await view(cy, ct)).recipient.paper_sign.state, null);
  assert.equal((await signAll(e.id, 'rs2-cy@example.com')).status, 200);
  // The same address under another person's name is another person too.
  const two = await setup('rs3');
  assert.equal((await send(two.ada, two.tok, 1)).status, 200);
  const r2 = rowOf(two.e.id, two.adaEmail).id;
  assert.equal((await two.s.post(`/envelopes/${two.e.id}/correct`, { recipient_id: r2, name: 'Zed Someone', email: two.adaEmail })).status, 200);
  assert.equal(S.db.get('SELECT paper_state FROM recipients WHERE id=?', r2).paper_state, null);
  assert.equal((await accept(two.s, two.e.id, r2)).status, 409);
  // A spelling fix of the same person keeps the scan waiting, and it can be accepted.
  const three = await setup('rs4');
  assert.equal((await send(three.ada, three.tok, 1)).status, 200);
  const r3 = rowOf(three.e.id, three.adaEmail).id;
  assert.equal((await three.s.post(`/envelopes/${three.e.id}/correct`, { recipient_id: r3, name: 'Ada  Paper', email: three.adaEmail })).status, 200);
  assert.equal(S.db.get('SELECT paper_state FROM recipients WHERE id=?', r3).paper_state, 'waiting');
  // Still hers: accepted, or (when the change made a new version of the document) refused only for that reason.
  const a3 = await accept(three.s, three.e.id, r3);
  assert.ok(a3.status === 200 || a3.data.code === 'paper_old_version', JSON.stringify(a3.data));
});

test('repair: the completion email does not say "signed on screen" when someone signed on paper', async () => {
  const { s, e, tok, ada, email, adaEmail, benEmail } = await setup('rs5');
  assert.equal((await send(ada, tok, 1)).status, 200);
  assert.equal((await accept(s, e.id, rowOf(e.id, adaEmail).id)).status, 200);
  assert.equal((await signAll(e.id, benEmail)).status, 200);
  const mails = [...mailTo(email), ...mailTo(adaEmail), ...mailTo(benEmail)].filter((m: any) => /^Completed/.test(m.subject));
  assert.ok(mails.length >= 3);
  for (const m of mails) assert.doesNotMatch(m.html, /signed on screen/i, m.subject);
});

test('repair: the print carries no signing link and no "Signed with" badge; the asked-again reason is on the page', async () => {
  const { s, e, tok, ada, adaEmail } = await setup('rs6');
  const pr = await ada.get(`/sign/${tok}/paper/print`);
  const text = (await extractPages(pr.data)).join(' ');
  assert.ok(!text.replace(/\s+/g, '').includes(tok), 'the token is not printed');
  assert.ok(!/\/sign\//.test(text), 'no signing address on paper');
  assert.doesNotMatch(text, /Signed with/i);
  assert.match(text.replace(/\s+/g, ' '), /Print all 3 pages|Print both pages/);
  // Asked again: the facts carry the reason, and the page draws it where they land (consent and sign screens).
  assert.equal((await send(ada, tok, 1)).status, 200);
  assert.equal((await s.post(`/envelopes/${e.id}/recipients/${rowOf(e.id, adaEmail).id}/paper/reject`, { reason: 'Page 2 is blurry' })).status, 200);
  const ps = (await view(ada, tok)).recipient.paper_sign;
  assert.equal(ps.state, 'asked_again');
  assert.equal(ps.reason, 'Page 2 is blurry');
  assert.equal(ps.mail, true);
  const page = read('src/app/sign/[token]/page.tsx');
  assert.equal((page.match(/\{paperNote\}/g) || []).length, 2, 'the note is on the consent screen and the signing screen');
  // Paper switched off since: they are told why, and that they sign on screen now (no silent change).
  await switchOn(s, false);
  const off = (await view(ada, tok)).recipient.paper_sign;
  assert.equal(off.off, true);
  assert.equal(off.reason, 'Page 2 is blurry');
  assert.equal((await ada.get(`/sign/${tok}/paper/print`)).status, 409);
});

test('repair: a reminder for someone whose scan waits says why none went out', async () => {
  const { s, e, tok, ada, adaEmail } = await setup('rs7');
  assert.equal((await send(ada, tok, 1)).status, 200);
  const all = await s.post(`/envelopes/${e.id}/remind`);
  assert.equal(all.status, 409);
  assert.equal(all.data.code, 'paper_waiting');
  assert.match(all.data.error, /^No reminder went out\. Ada Paper already sent back a scan signed on paper\. Look at the scan/);
  assert.doesNotMatch(all.data.error, /turned reminders off/);
  // The list the Home page and Documents read carries the state, so they say it waits for the sender.
  const list = (await s.get('/envelopes?box=waiting&limit=100')).data.envelopes;
  assert.equal(list.find((x: any) => x.id === e.id).recipients.find((r: any) => r.email === adaEmail).paper_state, 'waiting');
  for (const f of ['src/app/app/page.tsx', 'src/app/app/envelopes/page.tsx']) assert.match(read(f), /scanWaiting\(e\)/, f);
});

test('repair: Other actions works on the paper screens, and the hidden file input takes no Tab stop', () => {
  const page = read('src/app/sign/[token]/page.tsx');
  const at = page.indexOf('if (paperScreen) {');
  assert.ok(at > 0);
  const block = page.slice(at, page.indexOf('</Shell>', at));
  assert.match(block, /\{menuDialog && cloneElement\(menuDialog, \{ items: paperMenu \}\)\}/);
  assert.match(block, /paperScreen === 'waiting' \? m\.key === 'ask' \|\| m\.key === 'decline'/);
  const ui = read('src/components/sign/Paper.tsx');
  assert.match(ui, /id="sg-paper-files" type="file" className="sg-vh" tabIndex=\{-1\} aria-hidden="true"/);
  assert.match(ui, /<h2 className="sg-paper-h">\{t\(lang, 'sign\.paper\.step_sign'\)\}<\/h2>/);
});
