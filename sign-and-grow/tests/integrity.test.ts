// What people sign is what they saw. Tests for everything a sender can do to an envelope after it went out, seen
// from the side of the people who sign it: what they are shown, what can change under a signature, what happens to a
// signing screen that is already open, what the record says afterwards, and what a replaced person inherits.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, draft, simple, upload, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';

let db: Server['db'];
let env: Server['env'];
let cron: Server['cron'];
let jo: Client;
let ipn = 20;
const nextIp = () => `198.51.100.${ipn++}`;
before(async () => {
  ({ db, env, cron } = await boot());
  jo = await signUp('Jo Sender', 'jo@example.com', nextIp());
});

const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
// The editor sends back the whole envelope. This builds that body from what the server returns, as a copy.
const asBody = (e: any): any => JSON.parse(JSON.stringify({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields }));
const current = async (id: string) => asBody((await full(jo, id)).envelope);
const person = (body: any, email: string) => body.recipients.find((r: any) => r.email === email);
const statusOf = (id: string, email: string) => db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', id, email)?.status;
const audits = async (id: string, action: string): Promise<string[]> => (await full(jo, id)).audit.filter((a: any) => a.action === action).map((a: any) => a.detail);
const pdfText = async (id: string) => (await import('../src/server/text.ts')).extractText((await jo.get(`/envelopes/${id}/download`)).data);
const codeIn = (html: string) => /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(html)?.[1];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

async function uploadNamed(c: Client, text: string, pages = 2) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`${text} page ${i + 1}`, { x: 72, y: 700 });
  const f = new FormData();
  f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), `${text}.pdf`);
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

// A signer with the page open: consent given and the document loaded, as a browser would have it.
async function open(id: string, email: string, code?: string) {
  const c = new Client();
  const tok = tokenFor(id, email);
  if (code) assert.equal((await c.post(`/sign/${tok}/unlock`, { code })).status, 200);
  await c.post(`/sign/${tok}/consent`);
  const view = (await c.get(`/sign/${tok}`)).data;
  const answers = (extra: Record<string, string> = {}) => {
    const values: Record<string, string> = { ...extra };
    for (const f of view.fields || []) if (!(f.id in values) && !f.readonly) values[f.id] = f.type === 'text' ? 'filled in' : '1';
    return values;
  };
  return { c, tok, view, finish: (over: any = {}) => c.post(`/sign/${tok}/complete`, { values: answers(), signature_png: PNG, initials_png: PNG, version: view.version, ...over }) };
}
const benSigns = async (id: string, email = 'ben@example.com') => (await open(id, email, '4242')).finish();

// ---- 1. Every signer sees everything the sender wrote --------------------------------------------------------

test('a signer is shown what the sender wrote in another signer\'s part before they sign, in the same words as the final PDF', async () => {
  const file = await upload(jo, 1);
  const made = await jo.post('/envelopes', {
    subject: 'Fee agreement', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Ada Signer', email: 'ada@example.com' }, { id: 'b', role: 'signer', name: 'Ben Signer', email: 'ben@example.com' }],
    fields: [
      { id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.6, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'ft', document_id: 'd', recipient_id: 'b', type: 'text', readonly: true, required: false, value: 'Ada also owes a fee of 5000 dollars', page: 0, x: 0.1, y: 0.4, w: 0.6, h: 0.03 },
      { id: 'fp', document_id: 'd', recipient_id: 'b', type: 'text', label: 'Payment terms', required: false, value: 'Net 30 days', page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.03 },
      { id: 'fn', document_id: 'd', type: 'note', value: 'Clause 9 does not apply', page: 0, x: 0.1, y: 0.3, w: 0.5, h: 0.03 },
    ],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.envelope.id;

  // Ada opens the document for the first time. Nothing of Ben's is hers to fill in, and all of it is shown to her.
  const ada = await open(id, 'ada@example.com');
  const shown = (view: any, text: string) => view.others.find((o: any) => o.value === text);
  assert.deepEqual(ada.view.fields.map((f: any) => f.type), ['signature']);
  assert.equal(shown(ada.view, 'Ada also owes a fee of 5000 dollars')?.from, 'sender', 'the sender\'s fixed wording in Ben\'s part');
  assert.equal(shown(ada.view, 'Ada also owes a fee of 5000 dollars').by, 'Ben Signer');
  assert.equal(shown(ada.view, 'Net 30 days')?.from, 'start', 'a value the sender filled in that Ben may still change');
  assert.equal(shown(ada.view, 'Clause 9 does not apply')?.from, 'sender', 'a note');

  // Ben is half way: he has changed the terms but not finished. That is his draft, and Ada still sees the sender's words.
  const ben = await open(id, 'ben@example.com');
  const terms = ben.view.fields.find((f: any) => f.label === 'Payment terms').id;
  assert.equal((await ben.c.post(`/sign/${ben.tok}/save`, { values: { [terms]: 'Net 90 days' }, version: ben.view.version })).status, 200);
  const again = (await ada.c.get(`/sign/${ada.tok}`)).data;
  assert.ok(shown(again, 'Net 30 days'), 'a draft answer of another signer is not shown');
  assert.equal(shown(again, 'Net 90 days'), undefined);
  // The copy Ada can download or print before signing says the same as her screen, and Ben's copy has his own draft.
  const { extractText } = await import('../src/server/text.ts');
  const adaCopy = await extractText((await ada.c.get(`/sign/${ada.tok}/download`)).data);
  assert.ok(adaCopy.includes('Ada also owes a fee of 5000 dollars') && adaCopy.includes('Net 30 days') && adaCopy.includes('Clause 9 does not apply'), adaCopy);
  assert.equal(adaCopy.includes('Net 90 days'), false);
  assert.ok((await extractText((await ben.c.get(`/sign/${ben.tok}/download`)).data)).includes('Net 90 days'));

  // The sender rewrites the sentence in Ben's part. Ada is told, because it is on the page she is asked to sign.
  const body = await current(id);
  body.fields.find((f: any) => f.readonly && f.type === 'text').value = 'Ada also owes a fee of 7000 dollars';
  const mails = mailTo('ada@example.com').length;
  assert.equal((await jo.put(`/envelopes/${id}`, body)).status, 200);
  const told = mailTo('ada@example.com').slice(mails);
  assert.equal(told.length, 1);
  assert.match(told[0].subject, /^Updated:/);
  assert.match(told[0].html, /7000 dollars/, 'and the email says what changed');

  // Ben finishes. Now his answer is on the page for Ada, as his.
  const ben2 = await open(id, 'ben@example.com');
  assert.equal((await ben2.finish({ values: { ...Object.fromEntries(ben2.view.fields.filter((f: any) => f.type === 'signature').map((f: any) => [f.id, '1'])), [terms]: 'Net 90 days' } })).status, 200);
  const ada2 = await open(id, 'ada@example.com');
  assert.equal(shown(ada2.view, 'Net 90 days')?.from, 'signer');
  assert.ok(shown(ada2.view, 'Ada also owes a fee of 7000 dollars'));
  assert.equal((await ada2.finish()).data.envelope_status, 'completed');
  const text = await pdfText(id);
  for (const words of ['7000 dollars', 'Net 90 days', 'Clause 9 does not apply']) assert.ok(text.includes(words), `the signed PDF carries "${words}", which Ada was shown`);
});

// ---- 2. After a signature: locked, unless the sender asks for it to be signed again --------------------------

test('once someone has signed, nothing printed on the pages changes unless the sender asks them to sign again', async () => {
  const e0 = await draft(jo, { ordered: false, subject: 'Price agreement' });
  assert.equal((await jo.post(`/envelopes/${e0.id}/send`)).status, 200);
  assert.equal((await signAll(e0.id, 'ada@example.com')).status, 200);
  const firstSigned = db.get('SELECT completed_at t FROM recipients WHERE envelope_id=? AND email=?', e0.id, 'ada@example.com').t;
  const start = await current(e0.id);
  const ben = person(start, 'ben@example.com').id;
  const adaSig = start.fields.find((f: any) => f.type === 'signature' && f.recipient_id !== ben);
  const words = { id: 'over1', document_id: adaSig.document_id, recipient_id: ben, type: 'text', readonly: true, required: false, value: 'The price is changed to 1 dollar', page: adaSig.page, x: adaSig.x, y: adaSig.y - 0.05, w: 0.5, h: 0.03 };

  // New words above Ada's signature, as a read-only field for Ben. Refused, with a reason a person can act on.
  const adaMails = mailTo('ada@example.com').length;
  const refused = await jo.put(`/envelopes/${e0.id}`, { ...start, fields: [...start.fields, words] });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'sign_again');
  assert.deepEqual(refused.data.sign_again, ['Ada Signer']);
  assert.match(refused.data.error, /Ada Signer has already finished/);
  assert.match(refused.data.error, /The price is changed to 1 dollar/, 'the refusal says what would change');
  assert.match(refused.data.error, /"resign": true/);
  assert.equal((await full(jo, e0.id)).envelope.fields.length, start.fields.length, 'nothing was saved');
  assert.equal(mailTo('ada@example.com').length, adaMails);

  // The same holds for every other way of changing what is printed on those pages.
  const tries: [string, (b: any) => void][] = [
    ['a new empty field for Ben', (b) => b.fields.push({ id: 'extra1', document_id: adaSig.document_id, recipient_id: ben, type: 'text', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 })],
    ['a field of Ben\'s moved', (b) => (b.fields.find((f: any) => f.recipient_id === ben && f.type === 'checkbox').x = 0.5)],
    ['a field of Ben\'s removed', (b) => (b.fields = b.fields.filter((f: any) => !(f.recipient_id === ben && f.type === 'checkbox')))],
    ['a value filled in by the sender', (b) => (b.fields.find((f: any) => f.recipient_id === ben && f.type === 'checkbox').value = '1')],
    ['a note', (b) => b.fields.push({ id: 'note1', document_id: adaSig.document_id, type: 'note', value: 'Clause 9 is deleted', page: 0, x: 0.3, y: 0.3, w: 0.3, h: 0.03 })],
    ['Ada\'s own signature moved', (b) => (b.fields.find((f: any) => f.id === adaSig.id).y = 0.1)],
    ['the document taken out', (b) => ((b.documents = []), (b.fields = []))],
  ];
  for (const [what, change] of tries) {
    const body = await current(e0.id);
    change(body);
    const r = await jo.put(`/envelopes/${e0.id}`, body);
    assert.equal(r.status === 409 || (what === 'the document taken out' && r.status === 400), true, `${what}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  assert.equal(JSON.stringify(await current(e0.id)), JSON.stringify(start), 'every refused correction left the envelope exactly as it was');

  // What does not touch the pages can still change for the people who are left, and Ada hears nothing.
  const free = await current(e0.id);
  person(free, 'ben@example.com').name = 'Benjamin Signer';
  free.subject = 'Price agreement, corrected';
  free.fields.find((f: any) => f.recipient_id === ben && f.type === 'checkbox').label = 'I have read the price list';
  assert.equal((await jo.put(`/envelopes/${e0.id}`, free)).status, 200);
  assert.equal(statusOf(e0.id, 'ada@example.com'), 'completed');
  assert.equal(mailTo('ada@example.com').length, adaMails);

  // The sender chooses: the same change with "resign": true. Ada goes back to "needs to sign" and is told why.
  const cur = await current(e0.id);
  const ok = await jo.put(`/envelopes/${e0.id}`, { ...cur, fields: [...cur.fields, words], resign: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(statusOf(e0.id, 'ada@example.com'), 'sent');
  const mail = mailTo('ada@example.com').at(-1)!;
  assert.match(mail.subject, /^Changed after you finished: Price agreement, corrected/);
  assert.match(mail.html, /Jo Sender changed this document after you signed it/);
  assert.match(mail.html, /look at the document again and sign again/);
  assert.match(mail.html, /The price is changed to 1 dollar/, 'the email says what changed');
  assert.equal(tokenFor(e0.id, 'ada@example.com'), mail.link.split('/sign/')[1], 'she keeps the link she had');

  // The record says exactly what happened, and the first signature is kept.
  const corrected = (await audits(e0.id, 'Envelope corrected')).at(-1)!;
  assert.match(corrected, /New wording from the sender on page 1, in the part for Benjamin Signer: "The price is changed to 1 dollar"/);
  assert.match(corrected, /Ada Signer had already signed and is asked to sign again/);
  const aside = (await audits(e0.id, 'Asked to sign again'))[0];
  assert.ok(aside.includes(`Ada Signer <ada@example.com> signed on ${firstSigned.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`), aside);
  assert.match(aside, /Trees pledged on page 1: "filled in"/, 'with what she had entered');
  assert.match(aside, /signature image whose SHA-256 is [0-9a-f]{64}/);
  const kept = db.get('SELECT * FROM earlier_signatures WHERE envelope_id=?', e0.id);
  assert.equal(kept.completed_at, firstSigned);
  assert.equal(kept.signature_png, PNG, 'the signature itself is kept, not only its fingerprint');

  // Her screen: the answer she typed is still there to check, the signature has to be placed again, and it says why.
  const ada = await open(e0.id, 'ada@example.com');
  assert.equal(ada.view.recipient.signed_before, firstSigned);
  assert.match(ada.view.changed, /The price is changed to 1 dollar/);
  assert.equal(ada.view.fields.find((f: any) => f.type === 'text').value, 'filled in');
  assert.equal(ada.view.fields.find((f: any) => f.type === 'signature').value, null);
  assert.ok(ada.view.others.some((o: any) => o.value === 'The price is changed to 1 dollar'), 'and she is shown the new words before she signs');
  assert.equal((await ada.finish()).status, 200);
  assert.deepEqual((await full(jo, e0.id)).audit.map((a: any) => a.action).filter((a: string) => /^Signed/.test(a)), ['Signed', 'Signed again']);

  // Ben signs, and the certificate shows both of Ada's times.
  assert.equal((await benSigns(e0.id)).data.envelope_status, 'completed');
  const text = await pdfText(e0.id);
  assert.match(text, /First completed/);
  assert.match(text, /Completed again/);
  assert.ok(text.includes(firstSigned.slice(0, 10)));
  assert.match(text, /The price is changed to 1 dollar/);
  assert.equal((await full(jo, e0.id)).chain.ok, true);
});

test('what a signer does in their own field is never mistaken for a change by the sender', async () => {
  const file = await upload(jo, 1);
  const made = await jo.post('/envelopes', {
    subject: 'Terms', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Ada Signer', email: 'ada@example.com' }, { id: 'b', role: 'signer', name: 'Ben Signer', email: 'ben@example.com' }],
    fields: [
      { id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.6, y: 0.8, w: 0.25, h: 0.06 },
      { id: 'fp', document_id: 'd', recipient_id: 'b', type: 'text', label: 'Payment terms', required: false, value: 'Net 30 days', page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.03 },
    ],
  });
  const id = made.data.envelope.id;
  assert.equal((await (await open(id, 'ada@example.com')).finish()).status, 200);
  const terms = async () => (await full(jo, id)).envelope.fields.find((f: any) => f.label === 'Payment terms');
  const rename = async (name: string, from: any) => {
    person(from, 'ben@example.com').name = name;
    return jo.put(`/envelopes/${id}`, from);
  };

  // Ben writes his own terms. The sender's editor, opened before that, saves a new name for Ben: Ben's words stay.
  const early = await current(id);
  const ben = await open(id, 'ben@example.com');
  const field = ben.view.fields.find((f: any) => f.label === 'Payment terms').id;
  await ben.c.post(`/sign/${ben.tok}/save`, { values: { [field]: 'Net 90 days' }, version: ben.view.version });
  assert.equal((await rename('Ben S. Signer', early)).status, 200);
  assert.equal((await terms()).value, 'Net 90 days');

  // Ben empties the field. The sender saves again from what is on the server: nothing printed has changed, so Ada
  // is not asked for anything, and the words the sender first put there are still on record as the sender's.
  await ben.c.post(`/sign/${ben.tok}/save`, { values: { [field]: '' }, version: ben.view.version });
  assert.equal((await rename('Benjamin Signer', await current(id))).status, 200);
  assert.deepEqual([(await terms()).value, (await terms()).prefill], [null, 'Net 30 days']);
  assert.equal(statusOf(id, 'ada@example.com'), 'completed');

  // The sender putting different words into that field is a change to the pages Ada signed.
  const body = await current(id);
  body.fields.find((f: any) => f.label === 'Payment terms').value = 'Net 60 days';
  const r = await jo.put(`/envelopes/${id}`, body);
  assert.equal([r.status, r.data.code].join(), '409,sign_again');
  assert.match(r.data.error, /Wording from the sender on page 1, in the part for Benjamin Signer, changed from "Net 30 days" to "Net 60 days"/);
});

test('signing again never uses a second signature, and never holds one', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  try {
    const pay = await signUp('Pat Payer', 'pat@example.com', nextIp());
    const acc = (await pay.get('/me')).data.account.id;
    const bal = async () => (await pay.get('/billing')).data.signatures;
    const e0 = await draft(pay, { ordered: false, subject: 'Paid for once' });
    assert.equal((await pay.post(`/envelopes/${e0.id}/send`)).status, 200);
    assert.equal((await signAll(e0.id, 'ada@example.com')).status, 200);
    assert.deepEqual([(await bal()).balance, (await bal()).held], [2, 1], 'one used by Ada, one held for Ben');

    const body = asBody((await full(pay, e0.id)).envelope);
    body.fields.push({ id: 'n1', document_id: body.documents[0].id, type: 'note', value: 'Delivery in May', page: 0, x: 0.3, y: 0.3, w: 0.3, h: 0.03 });
    assert.equal((await pay.put(`/envelopes/${e0.id}`, { ...body, resign: true })).status, 200);
    assert.equal(statusOf(e0.id, 'ada@example.com'), 'sent');
    assert.deepEqual([(await bal()).balance, (await bal()).held], [2, 1], 'asking Ada again holds nothing more');
    assert.equal((await (await open(e0.id, 'ada@example.com')).finish()).status, 200);
    assert.deepEqual([(await bal()).balance, (await bal()).held], [2, 1]);
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", acc).n, 1, 'one line in the ledger for Ada, whatever she signs again');
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

// ---- 3. A signing screen that is already open ------------------------------------------------------------------

test('a signer cannot finish on a page that shows the document as it was before the sender changed it', async () => {
  const e0 = await simple(jo, 'open@example.com', { subject: 'Swapped' });
  await jo.post(`/envelopes/${e0.id}/send`);
  const s = await open(e0.id, 'open@example.com');
  assert.equal(s.view.version, 1);

  // The sender swaps in a different contract and moves the signature while that page is open.
  const other = await uploadNamed(jo, 'A completely different contract', 1);
  const body = await current(e0.id);
  body.documents[0].file_id = other.id;
  body.fields[0].y = 0.2;
  assert.equal((await jo.put(`/envelopes/${e0.id}`, body)).status, 200);
  assert.equal((await full(jo, e0.id)).envelope.content_version, 2);

  // Finish from the page that is still showing version one.
  const stale = await s.finish();
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'changed');
  assert.match(stale.data.error, /The sender changed this document while you had it open\. Look at it again before you finish\./);
  // A screen that sends no version at all is held to the one the server last gave it.
  const silent = await s.finish({ version: undefined });
  assert.equal(silent.status, 409);
  assert.equal(silent.data.code, 'changed');
  // Saving from the old page is not applied either, so the page finds out as soon as something is typed.
  const save = await s.c.post(`/sign/${s.tok}/save`, { values: { [s.view.fields[0].id]: '1' }, version: 1 });
  assert.equal([save.status, save.data.code].join(), '409,changed');
  assert.equal(statusOf(e0.id, 'open@example.com'), 'viewed', 'nothing was signed');
  assert.deepEqual(await audits(e0.id, 'Signed'), []);

  // The page loads the document again: the new version, the moved field, and what changed in words.
  const fresh = (await s.c.get(`/sign/${s.tok}`)).data;
  assert.equal(fresh.version, 2);
  assert.equal(fresh.fields[0].y, 0.2);
  assert.match(fresh.changed, /The file of document .* was replaced/);
  const done = await s.c.post(`/sign/${s.tok}/complete`, { values: { [fresh.fields[0].id]: '1' }, signature_png: PNG, version: fresh.version });
  assert.equal(done.data.envelope_status, 'completed');

  // A correction that changes nothing a signer sees leaves the version alone, so nobody is sent round for nothing.
  const e1 = await simple(jo, 'calm@example.com', { subject: 'Calm' });
  await jo.post(`/envelopes/${e1.id}/send`);
  const calm = await open(e1.id, 'calm@example.com');
  const b1 = await current(e1.id);
  b1.subject = 'Calm, renamed';
  b1.recipients[0].name = 'Sam S. Signer';
  assert.equal((await jo.put(`/envelopes/${e1.id}`, b1)).status, 200);
  assert.equal((await full(jo, e1.id)).envelope.content_version, 1);
  assert.equal((await calm.finish()).status, 200);

  // The check is part of the one statement that claims the signature: a correction that lands after the envelope
  // was read, but before the claim, is caught too.
  const e2 = await simple(jo, 'race@example.com', { subject: 'Race' });
  await jo.post(`/envelopes/${e2.id}/send`);
  const r = await open(e2.id, 'race@example.com');
  const copy = env.loadEnvelope(e2.id); // read before the correction
  const b2 = await current(e2.id);
  b2.fields[0].x = 0.5;
  assert.equal((await jo.put(`/envelopes/${e2.id}`, b2)).status, 200);
  await assert.rejects(env.completeRecipient(copy, copy.recipients[0], { values: { [r.view.fields[0].id]: '1' }, signature_png: PNG, version: 1 }, { name: 'Sam Signer <race@example.com>' }),
    (err: any) => err.status === 409 && err.data?.code === 'changed');
  assert.equal(statusOf(e2.id, 'race@example.com'), 'viewed');
});

// ---- 4. The record says what a correction changed ---------------------------------------------------------------

test('the audit trail says what a correction changed, in words', async () => {
  const e0 = await draft(jo, { ordered: true, subject: 'What changed' });
  await jo.post(`/envelopes/${e0.id}/send`);
  const before = (await full(jo, e0.id)).envelope;
  const oldSha = before.documents[0].sha256;
  const v2 = await uploadNamed(jo, 'Version two of the agreement');
  const newSha = db.get('SELECT sha256 s FROM files WHERE id=?', v2.id).s;

  const body = asBody(before);
  const ada = person(body, 'ada@example.com'), ben = person(body, 'ben@example.com'), cee = person(body, 'cee@example.com');
  body.documents[0].file_id = v2.id; // the file is replaced
  ben.name = 'Benjamin Signer'; // Ben is replaced by someone at another address, and moves up
  ben.email = 'benjamin@example.com';
  ben.routing_order = 1;
  ada.routing_order = 2;
  cee.role = 'viewer'; // the copy recipient is asked to view instead
  body.recipients.push({ id: 'new1', role: 'approver', name: 'Dee New', email: 'dee@example.com', routing_order: 3 });
  body.fields.find((f: any) => f.recipient_id === ada.id && f.type === 'text').x = 0.5; // moved
  body.fields = body.fields.filter((f: any) => !(f.recipient_id === ben.id && f.type === 'checkbox')); // removed
  body.fields.push({ id: 'nf', document_id: body.documents[0].id, recipient_id: ada.id, type: 'initials', page: 1, x: 0.6, y: 0.2, w: 0.1, h: 0.05 }); // added
  assert.equal((await jo.put(`/envelopes/${e0.id}`, body)).status, 200);

  const line = (await audits(e0.id, 'Envelope corrected')).at(-1)!;
  assert.ok(line.includes('Ben Signer <ben@example.com> was replaced by Benjamin Signer <benjamin@example.com>: the email address changed from ben@example.com to benjamin@example.com.'), line);
  assert.match(line, /Benjamin Signer <benjamin@example\.com>: place in the signing order changed from 2 to 1\./);
  assert.match(line, /Ada Signer <ada@example\.com>: place in the signing order changed from 1 to 2\./);
  assert.match(line, /Cee Copy <cee@example\.com>: role changed from copy recipient to viewer\./);
  assert.match(line, /Dee New <dee@example\.com> added as approver, place 3 in the signing order\./);
  assert.ok(line.includes(`The file of document "Agreement" was replaced. Before: 2 pages, SHA-256 ${oldSha}. Now: 2 pages, SHA-256 ${newSha}.`), line);
  assert.match(line, /Fields for Ada Signer: added initials on page 2; moved or resized "Trees pledged" text on page 1\./);
  assert.match(line, /Fields for Benjamin Signer: removed checkbox on page 2\./);
  assert.doesNotMatch(line, /Now \d+ recipients/, 'no more counts in place of facts');

  // A save that changes nothing leaves no line. The quick fix for one address says what it did to the link.
  const n = (await audits(e0.id, 'Envelope corrected')).length;
  assert.equal((await jo.put(`/envelopes/${e0.id}`, await current(e0.id))).status, 200);
  assert.equal((await audits(e0.id, 'Envelope corrected')).length, n);
  const dee = (await full(jo, e0.id)).envelope.recipients.find((r: any) => r.email === 'dee@example.com').id;
  assert.equal((await jo.post(`/envelopes/${e0.id}/correct`, { recipient_id: dee, name: 'Dee Newer', email: 'dee.newer@example.com' })).status, 200);
  assert.match((await audits(e0.id, 'Recipient corrected')).at(-1)!, /Dee New <dee@example\.com> is now Dee Newer <dee\.newer@example\.com>\. The link sent to dee@example\.com stopped working/);

  // All of it is on the certificate, which is where a judge would read it.
  const e1 = await simple(jo, 'cert@example.com', { subject: 'Certificate' });
  await jo.post(`/envelopes/${e1.id}/send`);
  const b1 = await current(e1.id);
  b1.fields[0].x = 0.55;
  assert.equal((await jo.put(`/envelopes/${e1.id}`, b1)).status, 200);
  assert.equal((await (await open(e1.id, 'cert@example.com')).finish()).data.envelope_status, 'completed');
  assert.match((await pdfText(e1.id)).replace(/\s+/g, ' '), /Envelope corrected · Fields for Sam Signer: moved or resized signature on page 1\./);
});

// ---- 5. A different person starts with empty fields ----------------------------------------------------------

test('someone who takes over a request inherits none of the first person\'s answers or signature', async () => {
  const withDefault = { fields: [
    { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
    { id: 'f2', document_id: 'd1', recipient_id: 'r1', type: 'text', label: 'Trees pledged', page: 0, x: 0.1, y: 0.7, w: 0.25, h: 0.03 },
    { id: 'f6', document_id: 'd1', recipient_id: 'r1', type: 'text', label: 'City', value: 'Addis Ababa', required: false, page: 0, x: 0.5, y: 0.7, w: 0.25, h: 0.03 },
    { id: 'f7', document_id: 'd1', recipient_id: 'r1', type: 'text', label: 'Clause', value: 'Fixed by the sender', readonly: true, required: false, page: 0, x: 0.5, y: 0.6, w: 0.25, h: 0.03 },
    { id: 'f8', document_id: 'd1', recipient_id: 'r1', type: 'checkbox', required: false, page: 0, x: 0.5, y: 0.5, w: 0.03, h: 0.02 },
    { id: 'f4', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.25, h: 0.06 },
  ] };
  // The first person fills things in and adopts a signature, without finishing.
  const start = async (subject: string) => {
    const e = await draft(jo, { ordered: false, subject, ...withDefault });
    assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
    const ada = await open(e.id, 'ada@example.com');
    const by = (label: string) => ada.view.fields.find((f: any) => f.label === label).id;
    const values = { [by('Trees pledged')]: 'my private number 12345', [by('City')]: 'Somewhere else', [ada.view.fields.find((f: any) => f.type === 'checkbox').id]: '1', [ada.view.fields.find((f: any) => f.type === 'signature').id]: '1' };
    assert.equal((await ada.c.post(`/sign/${ada.tok}/save`, { values, signature_png: PNG, version: ada.view.version })).status, 200);
    return { id: e.id, ada };
  };
  const clean = async (id: string, email: string, how: string) => {
    const v = (await new Client().get(`/sign/${tokenFor(id, email)}`)).data;
    const by = (label: string) => v.fields.find((f: any) => f.label === label);
    assert.equal(v.recipient.signature_png, null, `${how}: no signature image is handed on`);
    assert.equal(v.recipient.consented, false, `${how}: the new person agrees for themselves`);
    assert.equal(by('Trees pledged').value, null, `${how}: what the first person typed is gone`);
    assert.equal(v.fields.find((f: any) => f.type === 'signature').value, null, `${how}: no field is marked as signed`);
    assert.equal(v.fields.find((f: any) => f.type === 'checkbox').value, null, `${how}: nothing is ticked`);
    assert.equal(by('City').value, 'Addis Ababa', `${how}: a field goes back to what the sender put there`);
    assert.equal(by('Clause').value, 'Fixed by the sender', `${how}: the sender's read-only wording stays`);
    assert.equal(JSON.stringify(v).includes('12345'), false);
  };

  // Passed on by the signer.
  const a = await start('Handed over');
  assert.equal((await a.ada.c.post(`/sign/${a.ada.tok}/reassign`, { name: 'Dee Deputy', email: 'dee.deputy@example.com' })).status, 200);
  await clean(a.id, 'dee.deputy@example.com', 'assigned to someone else');

  // The sender fixes the address with the quick correction.
  const b = await start('Wrong person');
  const rid = (await full(jo, b.id)).envelope.recipients.find((r: any) => r.email === 'ada@example.com').id;
  assert.equal((await jo.post(`/envelopes/${b.id}/correct`, { recipient_id: rid, name: 'Right Person', email: 'right@example.com' })).status, 200);
  await clean(b.id, 'right@example.com', 'address corrected');

  // The sender changes the address in the editor.
  const c = await start('Wrong person, editor');
  const body = await current(c.id);
  Object.assign(person(body, 'ada@example.com'), { name: 'Other Person', email: 'other@example.com' });
  assert.equal((await jo.put(`/envelopes/${c.id}`, body)).status, 200);
  await clean(c.id, 'other@example.com', 'address changed in the editor');

  // A name fix for the same person at the same address keeps everything they did.
  const d = await start('Same person');
  const rid2 = (await full(jo, d.id)).envelope.recipients.find((r: any) => r.email === 'ada@example.com').id;
  assert.equal((await jo.post(`/envelopes/${d.id}/correct`, { recipient_id: rid2, name: 'Ada S. Signer' })).status, 200);
  const same = (await new Client().get(`/sign/${a.ada.tok === '' ? '' : tokenFor(d.id, 'ada@example.com')}`)).data;
  assert.equal(same.fields.find((f: any) => f.label === 'Trees pledged').value, 'my private number 12345');
  assert.equal(same.recipient.signature_png, PNG);
});

// ---- 6. Two people editing the same template --------------------------------------------------------------------

test('a save from an older copy is refused with who saved and when, and nothing of theirs is lost', async () => {
  const ann = await signUp('Ann Admin', 'ann@example.com', nextIp());
  await ann.post('/account/invites', { email: 'bob@example.com', role: 'member' });
  const bob = new Client();
  bob.ip = nextIp();
  assert.equal((await bob.post('/auth/signup', { name: 'Bob Member', email: 'bob@example.com', password: 'correct horse battery', invite: db.get("SELECT token FROM invites WHERE email='bob@example.com'").token })).status, 200);
  const file = await upload(ann, 1);
  const tpl = (await ann.post('/envelopes', { kind: 'template', subject: 'Shared', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const load = async (c: Client) => (await c.get(`/envelopes/${tpl.id}`)).data.envelope;
  const body = (e: any) => ({ ...asBody(e), edit_version: e.edit_version });

  // Both open the template. Ann adds five fields and saves.
  const a = body(await load(ann)), b = body(await load(bob));
  for (let i = 0; i < 5; i++) a.fields.push({ document_id: a.documents[0].id, recipient_id: a.recipients[0].id, type: 'text', page: 0, x: 0.1, y: 0.1 + i * 0.05, w: 0.2, h: 0.03 });
  const saved = await ann.put(`/envelopes/${tpl.id}`, a);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.envelope.edit_version, a.edit_version + 1, 'every save counts up');

  // Bob's editor, loaded earlier, saves a renamed subject.
  b.subject = 'Shared (Bob renamed it)';
  const refused = await bob.put(`/envelopes/${tpl.id}`, b);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'stale');
  assert.match(refused.data.error, /^Ann Admin saved this template on \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC, after you opened it\./);
  assert.match(refused.data.error, /nothing of theirs is lost/);
  assert.equal(refused.data.edited_by, 'Ann Admin');
  const now = await load(ann);
  assert.equal(now.fields.length, 6, 'Ann\'s fields are all still there');
  assert.equal(now.subject, 'Shared');

  // Bob can keep his version as a copy (a new template made from what he has), or load Ann's and save on top of it.
  const { edit_version: _v, ...mine } = b;
  const copy = await bob.post('/envelopes', { ...mine, kind: 'template', subject: 'Shared (my copy)' });
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.equal(copy.data.envelope.fields.length, 1);
  const theirs = body(await load(bob));
  theirs.subject = 'Shared (Bob renamed it)';
  assert.equal((await bob.put(`/envelopes/${tpl.id}`, theirs)).status, 200);
  assert.equal((await load(ann)).fields.length, 6);

  // The same for a second tab on a draft, and for two people correcting an envelope that is out.
  const d = await simple(ann, 'tabs@example.com');
  const tab1 = body((await full(ann, d.id)).envelope), tab2 = body((await full(ann, d.id)).envelope);
  assert.equal((await ann.put(`/envelopes/${d.id}`, { ...tab1, subject: 'From tab one' })).status, 200);
  assert.equal((await ann.put(`/envelopes/${d.id}`, { ...tab2, subject: 'From tab two' })).data.code, 'stale');
  assert.equal((await ann.post(`/envelopes/${d.id}/send`)).status, 200);
  const out1 = body((await full(ann, d.id)).envelope), out2 = body((await full(ann, d.id)).envelope);
  assert.equal((await ann.put(`/envelopes/${d.id}`, { ...out1, subject: 'Corrected once' })).status, 200);
  const late = await ann.put(`/envelopes/${d.id}`, { ...out2, subject: 'Corrected from an older copy' });
  assert.equal([late.status, late.data.code].join(), '409,stale');
  assert.equal((await full(ann, d.id)).envelope.subject, 'Corrected once');

  // A caller that sends no version is not checked, as before.
  const { edit_version: _w, ...unversioned } = out2;
  assert.equal((await ann.put(`/envelopes/${d.id}`, { ...unversioned, subject: 'No version sent' })).status, 200);
});

// ---- 7. A genuine email stays genuine --------------------------------------------------------------------------

test('the security code of a replaced link still says the email was genuine, and what to do', async () => {
  const anon = new Client();
  anon.ip = nextIp();
  const check = async (code: string) => (await anon.post('/public/check', { code })).data;

  // The sender corrects the address with the quick fix.
  const e = await simple(jo, 'old-i@example.com', { subject: 'Real contract' });
  await jo.post(`/envelopes/${e.id}/send`);
  const first = codeIn(mailTo('old-i@example.com').at(-1)!.html)!;
  assert.equal((await check(first)).genuine, true);
  const rid = (await full(jo, e.id)).envelope.recipients[0].id;
  assert.equal((await jo.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, email: 'new-i@example.com' })).status, 200);
  const after = await check(first);
  assert.equal(after.genuine, true, 'a code we really sent is never called fake');
  assert.equal(after.replaced, true);
  assert.equal(after.why, 'address');
  assert.equal(after.sender.email, 'jo@example.com');
  assert.equal(after.subject, 'Real contract');
  assert.equal(after.for_name, 'Sam Signer');
  assert.equal(after.url, undefined, 'the old link is not handed out again');
  const fresh = await check(codeIn(mailTo('new-i@example.com').at(-1)!.html)!);
  assert.equal([fresh.genuine, !!fresh.replaced].join(), 'true,false');
  assert.match(fresh.url, /\/sign\//);

  // The same for a role changed in the editor, a hand-over by the signer, and a person taken off the envelope.
  const d = await draft(jo, { ordered: false, subject: 'Three ways' });
  await jo.post(`/envelopes/${d.id}/send`);
  const codeFor = (email: string) => codeIn(mailTo(email).filter((m) => m.subject === 'Three ways').at(-1)!.html)!;
  const ada = codeFor('ada@example.com'), ben = codeFor('ben@example.com');
  const adaTok = tokenFor(d.id, 'ada@example.com');
  assert.equal((await new Client().post(`/sign/${adaTok}/reassign`, { name: 'Dee Deputy', email: 'dee.three@example.com' })).status, 200);
  assert.equal((await check(ada)).why, 'handed');
  const body = await current(d.id);
  const b = person(body, 'ben@example.com');
  b.role = 'approver';
  body.fields = body.fields.filter((f: any) => f.recipient_id !== b.id);
  assert.equal((await jo.put(`/envelopes/${d.id}`, body)).status, 200);
  assert.equal((await check(ben)).why, 'role');
  const body2 = await current(d.id);
  const dee = person(body2, 'dee.three@example.com');
  const deeCode = codeFor('dee.three@example.com');
  body2.recipients = body2.recipients.filter((r: any) => r.id !== dee.id);
  body2.fields = body2.fields.filter((f: any) => f.recipient_id !== dee.id);
  body2.recipients.push({ id: 'x1', role: 'signer', name: 'Eve Extra', email: 'eve.three@example.com', routing_order: 1 });
  body2.fields.push({ id: 'xf', document_id: body2.documents[0].id, recipient_id: 'x1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 });
  assert.equal((await jo.put(`/envelopes/${d.id}`, body2)).status, 200);
  const gone = await check(deeCode);
  assert.equal([gone.genuine, gone.replaced, gone.why].join(), 'true,true,removed');
  assert.equal((await check('AAAA-BBBB-CCCC')).genuine, false, 'a code we never sent is still not recognised');
});

// ---- 8. A changed signing order is enforced ------------------------------------------------------------------

test('moving someone who has the document behind a person who has not finished takes their turn back', async () => {
  const e0 = await draft(jo, { ordered: true, subject: 'New order' });
  await jo.post(`/envelopes/${e0.id}/send`);
  assert.deepEqual([statusOf(e0.id, 'ada@example.com'), statusOf(e0.id, 'ben@example.com')], ['sent', 'pending']);
  const ada = await open(e0.id, 'ada@example.com');
  const typed = ada.view.fields.find((f: any) => f.type === 'text').id;
  await ada.c.post(`/sign/${ada.tok}/save`, { values: { [typed]: '400 seedlings' }, version: ada.view.version });

  const body = await current(e0.id);
  person(body, 'ada@example.com').routing_order = 2;
  person(body, 'ben@example.com').routing_order = 1;
  const adaMails = mailTo('ada@example.com').length;
  assert.equal((await jo.put(`/envelopes/${e0.id}`, body)).status, 200);
  assert.deepEqual([statusOf(e0.id, 'ada@example.com'), statusOf(e0.id, 'ben@example.com')], ['pending', 'sent'], 'Ben has it now, and Ada waits');
  const told = mailTo('ada@example.com').slice(adaMails);
  assert.deepEqual(told.map((m) => m.subject), ['Not your turn yet: New order']);
  assert.match(told[0].html, /someone who signs before you now has to finish first/);
  assert.match(told[0].html, /We will email you as soon as it is your turn/);
  assert.match((await audits(e0.id, 'Envelope corrected')).at(-1)!, /Ada Signer had the document and now waits, because someone before them in the signing order has not finished\./);

  // The link she has says so, and cannot be used to sign first.
  assert.equal((await ada.c.get(`/sign/${ada.tok}`)).data.recipient.status, 'pending');
  assert.equal((await ada.c.get(`/sign/${ada.tok}`)).data.documents, undefined);
  const early = await ada.finish();
  assert.equal(early.status, 400);
  assert.match(early.data.error, /not your turn/);

  // Ben signs. Ada is asked again on the same link, with what she typed still there, and then the copy goes out.
  assert.equal((await benSigns(e0.id)).status, 200);
  assert.equal(statusOf(e0.id, 'ada@example.com'), 'sent');
  assert.equal(tokenFor(e0.id, 'ada@example.com'), ada.tok);
  const back = await open(e0.id, 'ada@example.com');
  assert.equal(back.view.fields.find((f: any) => f.id === typed).value, '400 seedlings');
  assert.equal((await back.finish({ values: { ...Object.fromEntries(back.view.fields.map((f: any) => [f.id, f.type === 'text' ? '400 seedlings' : '1'])) } })).data.envelope_status, 'completed');

  // Someone who only gets a copy holds nobody up when they are put at the front.
  const e1 = await draft(jo, { ordered: true, subject: 'Copy first' });
  await jo.post(`/envelopes/${e1.id}/send`);
  const b1 = await current(e1.id);
  person(b1, 'cee@example.com').routing_order = 1;
  person(b1, 'ada@example.com').routing_order = 2;
  person(b1, 'ben@example.com').routing_order = 3;
  assert.equal((await jo.put(`/envelopes/${e1.id}`, b1)).status, 200);
  assert.deepEqual([statusOf(e1.id, 'cee@example.com'), statusOf(e1.id, 'ada@example.com')], ['completed', 'sent']);
});

// ---- 9. Nothing in a request is ignored without a word --------------------------------------------------------

test('a request that cannot be carried out in full is refused with the reason, not half applied', async () => {
  const file = await upload(jo, 1);
  const base = { subject: 'Typo', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'A', email: 'a@example.com' }] };
  const good = { document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 };
  const drafts = () => db.get("SELECT COUNT(*) n FROM envelopes WHERE subject='Typo'").n;

  // A field for a recipient who is not on the envelope, of a type that does not exist, or on a document that is not there.
  const cases: [any, RegExp][] = [
    [{ ...good, recipient_id: 'rr', type: 'text', label: 'Amount' }, /^Field 2 \("Amount"\), a text field, is for the recipient "rr", who is not on this envelope\./],
    [{ ...good, type: 'textbox' }, /^Field 2 has the type "textbox", which does not exist\. Use one of: signature, /],
    [{ ...good, document_id: 'dd' }, /^Field 2, a signature field, points at the document "dd", which is not in this envelope\./],
    [{ ...good, recipient_id: undefined, type: 'text' }, /^Field 2, a text field, has no recipient_id\./],
  ];
  for (const [bad, says] of cases) {
    const r = await jo.post('/envelopes', { ...base, fields: [good, bad] });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, says);
  }
  const role = await jo.post('/envelopes', { ...base, recipients: [{ id: 'r', role: 'signatory', name: 'A', email: 'a@example.com' }], fields: [good] });
  assert.equal(role.status, 400);
  assert.match(role.data.error, /^Recipient 1 \(A\) has the role "signatory", which does not exist\. Use one of: signer, approver, cc, viewer, inperson\./);
  assert.equal(drafts(), 0, 'a refused request leaves no half-made draft behind');

  // The same when saving a draft that exists: refused, and the draft keeps what it had.
  const made = await jo.post('/envelopes', { ...base, fields: [good] });
  assert.equal(made.status, 200);
  const put = await jo.put(`/envelopes/${made.data.envelope.id}`, { ...base, fields: [good, { ...good, recipient_id: 'rr' }] });
  assert.equal(put.status, 400);
  assert.equal((await full(jo, made.data.envelope.id)).envelope.fields.length, 1);

  // Changing someone who has finished is refused out loud, where it used to answer 200 and do nothing.
  const e0 = await draft(jo, { ordered: false, subject: 'Finished person' });
  await jo.post(`/envelopes/${e0.id}/send`);
  await signAll(e0.id, 'ada@example.com');
  for (const change of [{ email: 'ada2@example.com' }, { name: 'Ada Lovelace' }, { role: 'approver' }, { routing_order: 5 }]) {
    const body = await current(e0.id);
    Object.assign(person(body, 'ada@example.com'), change);
    const r = await jo.put(`/envelopes/${e0.id}`, body);
    assert.equal(r.status, 409, JSON.stringify(change));
    assert.equal(r.data.code, 'sign_again');
    assert.match(r.data.error, /^Ada Signer has already finished, so their name, email address, role and place in the order can no longer be changed\. Nothing was saved\./);
  }
  const gone = await current(e0.id);
  const adaId = person(gone, 'ada@example.com').id;
  gone.recipients = gone.recipients.filter((r: any) => r.id !== adaId);
  gone.fields = gone.fields.filter((f: any) => f.recipient_id !== adaId);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, gone)).status, 409, 'nor can they be taken off');
  const ada = (await full(jo, e0.id)).envelope.recipients.find((r: any) => r.id === adaId);
  assert.deepEqual([ada.name, ada.email, ada.role, ada.routing_order, ada.status], ['Ada Signer', 'ada@example.com', 'signer', 1, 'completed']);

  // With the sender's choice to have them sign again, a misspelled name can be put right after all.
  const fix = await current(e0.id);
  person(fix, 'ada@example.com').name = 'Ada Lovelace';
  assert.equal((await jo.put(`/envelopes/${e0.id}`, { ...fix, resign: true })).status, 200);
  const renamed = (await full(jo, e0.id)).envelope.recipients.find((r: any) => r.id === adaId);
  assert.deepEqual([renamed.name, renamed.status], ['Ada Lovelace', 'sent']);
  assert.match(mailTo('ada@example.com').at(-1)!.subject, /^Changed after you finished:/);
  assert.match((await audits(e0.id, 'Envelope corrected')).at(-1)!, /Ada Lovelace <ada@example\.com>: name changed from "Ada Signer" to "Ada Lovelace"\. Ada Signer had already signed and is asked to sign again\./);
});

test('a finished signer is replaced or taken off only by that choice, and the signature they gave is set aside on record', async () => {
  const e0 = await draft(jo, { ordered: false, subject: 'Set aside' });
  await jo.post(`/envelopes/${e0.id}/send`);
  assert.equal((await signAll(e0.id, 'ada@example.com')).status, 200);
  const adaTok = tokenFor(e0.id, 'ada@example.com');

  // Ada's place goes to someone at another address. That is a different person, who starts from nothing.
  const body = await current(e0.id);
  Object.assign(person(body, 'ada@example.com'), { name: 'Zed Other', email: 'zed@example.com' });
  assert.equal((await jo.put(`/envelopes/${e0.id}`, body)).status, 409);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, { ...body, resign: true })).status, 200);
  assert.equal(statusOf(e0.id, 'zed@example.com'), 'sent');
  assert.equal(mailTo('zed@example.com').at(-1)!.subject, 'Set aside', 'an ordinary request, not "sign again"');
  const zed = (await new Client().get(`/sign/${tokenFor(e0.id, 'zed@example.com')}`)).data;
  assert.equal(zed.recipient.signed_before, null);
  assert.deepEqual(zed.fields.filter((f: any) => f.type !== 'date_signed').map((f: any) => f.value), [null, null], 'none of Ada\'s answers');
  assert.equal(zed.recipient.signature_png, null);
  assert.equal((await new Client().get(`/sign/${adaTok}`)).status, 410);
  const aside = (await audits(e0.id, 'Earlier signature set aside'))[0];
  assert.match(aside, /^Ada Signer <ada@example\.com> signed on .* UTC/);
  assert.match(aside, /What they had entered: Trees pledged on page 1: "filled in"\. Their place on the envelope went to Zed Other <zed@example\.com>\.$/);

  // Ben signs and is then taken off. He is told, and what he signed is on record too.
  assert.equal((await benSigns(e0.id)).status, 200);
  const off = await current(e0.id);
  const ben = person(off, 'ben@example.com').id;
  off.recipients = off.recipients.filter((r: any) => r.id !== ben);
  off.fields = off.fields.filter((f: any) => f.recipient_id !== ben);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, off)).status, 409);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, { ...off, resign: true })).status, 200);
  const bye = mailTo('ben@example.com').at(-1)!;
  assert.equal(bye.subject, 'No longer needed: Set aside');
  assert.match(bye.html, /took you off it\. What you signed on .* UTC is no longer part of it/);
  assert.match((await audits(e0.id, 'Earlier signature set aside'))[1], /^Ben Signer <ben@example\.com> signed on .* They were taken off the envelope\.$/);
  assert.equal(db.get('SELECT COUNT(*) n FROM earlier_signatures WHERE envelope_id=?', e0.id).n, 2);
  assert.equal((await full(jo, e0.id)).chain.ok, true);
});

// ---- 10. "Not opened yet" counts from the email that went to the new address ---------------------------------

test('after an address is corrected, the sender hears "not opened yet" two days after the new email, not before and not never', async () => {
  const alerts = async () => (await cron.tick()).unopened;
  const age = (id: string, h: number) => db.run('UPDATE recipients SET sent_at=? WHERE envelope_id=?', hoursAgo(h), id);
  const nudges = () => mailTo('jo@example.com').filter((m) => m.subject.startsWith('Not opened yet:')).length;

  // Quick correction on a request that has sat for more than two days without an alert having gone out yet.
  const a = await simple(jo, 'quiet@example.com', { subject: 'Quiet one' });
  await jo.post(`/envelopes/${a.id}/send`);
  age(a.id, 49);
  const rid = (await full(jo, a.id)).envelope.recipients[0].id;
  assert.equal((await jo.post(`/envelopes/${a.id}/correct`, { recipient_id: rid, email: 'quiet.new@example.com' })).status, 200);
  assert.equal(await alerts(), 0, 'the new address has had the email for a minute, not for two days');
  age(a.id, 49);
  assert.equal(await alerts(), 1, 'two days later the sender is told');

  // Corrected in the editor after the alert about the old address was already given.
  const b = await simple(jo, 'quiet2@example.com', { subject: 'Quiet two' });
  await jo.post(`/envelopes/${b.id}/send`);
  age(b.id, 49);
  assert.equal(await alerts(), 1);
  const body = await current(b.id);
  body.recipients[0].email = 'quiet2.new@example.com';
  assert.equal((await jo.put(`/envelopes/${b.id}`, body)).status, 200);
  assert.equal(await alerts(), 0);
  age(b.id, 49);
  const before = nudges();
  assert.equal(await alerts(), 1, 'the alert about the new address is not lost');
  assert.equal(nudges(), before + 1);

  // Handed over by the signer after the alert about them was given.
  const c = await simple(jo, 'quiet3@example.com', { subject: 'Quiet three' });
  await jo.post(`/envelopes/${c.id}/send`);
  age(c.id, 49);
  assert.equal(await alerts(), 1);
  assert.equal((await new Client().post(`/sign/${tokenFor(c.id, 'quiet3@example.com')}/reassign`, { name: 'Dee Deputy', email: 'quiet3.new@example.com' })).status, 200);
  assert.equal(await alerts(), 0);
  age(c.id, 49);
  assert.equal(await alerts(), 1);
});
