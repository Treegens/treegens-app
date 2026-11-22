// More kinds of field, and how filled-in text looks (src/lib/fieldkinds.ts, src/server/fieldkinds.ts): first and last
// name taken from the person's name, a drawing that is never a signature, Approve and Decline buttons on the page,
// fields that share an answer, dates worked out from other dates, text style, and saved fields. The shared rules, the
// server, the PDF, templates, bulk and the API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { boot, Client, signUp, upload, tokenFor, PNG, type Server } from './helpers.ts';
import {
  namePart, NAME_CHECK, isDrawingValue, buttonWords, linkedTo, spreadLinked, settleLinked, addToDay, dayOf, dateFromValue, dateFromWords,
  lookOf, lookProblem, lookFor, lookHex, lookCss, lookWords, savedKey, DATE_FROM_NOTE, colorsFor,
} from '../src/lib/fieldkinds.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.93.${++n}.7`);

async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}

const box = (id: string, rid: string, type: string, y: number, extra: any = {}) => ({ id, document_id: 'd', recipient_id: rid, type, page: 0, x: 0.1, y, w: 0.3, h: 0.03, required: false, ...extra });

async function envelope(s: Client, fields: any[], extra: any = {}, people?: any[]) {
  const file = await upload(s, 1);
  const k = ++n;
  return s.post('/envelopes', {
    subject: 'Kinds', documents: [{ id: 'd', file_id: file.id }],
    recipients: people || [
      { id: 'r1', role: 'signer', name: 'Mary Ann van Dijk', email: `mary${k}@kinds.example`, routing_order: 1 },
      { id: 'r2', role: 'approver', name: 'Paul Approver', email: `paul${k}@kinds.example`, routing_order: 2 },
    ],
    ordered: true,
    fields,
    ...extra,
  });
}
const emailOf = (eid: string, rid: string) => db.get('SELECT email FROM recipients WHERE envelope_id=? AND routing_order=?', eid, Number(rid.slice(1))).email;
async function signer(eid: string, email: string) {
  const c = new Client();
  c.ip = `10.94.${++n}.1`;
  const tok = tokenFor(eid, email);
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  return { c, tok, v, done: (values: Record<string, any>, extra: any = {}) => c.post(`/sign/${tok}/complete`, { values, ...extra }) };
}
const row = (eid: string, label: string) => db.get('SELECT * FROM fields WHERE envelope_id=? AND label=?', eid, label);

// ---- 1. First and last name ----------------------------------------------------------------------------------------

test('first and last name: the first word and the last word of the name, said as a rule', () => {
  assert.equal(namePart('Mary Ann van Dijk', 'first_name'), 'Mary');
  assert.equal(namePart('Mary Ann van Dijk', 'last_name'), 'Dijk');
  assert.equal(namePart('  Madonna ', 'first_name'), 'Madonna');
  assert.equal(namePart('  Madonna ', 'last_name'), 'Madonna', 'one word is both');
  assert.equal(namePart('', 'first_name'), '');
  assert.equal(namePart('Zoë   Ó Briain', 'last_name'), 'Briain');
  assert.equal(NAME_CHECK.first_name, 'Check your first name');
});

test('first and last name: shown filled in from their name, the signer can change it, and their name stays as it was', async () => {
  const s = await person('Sue Sender', 'sue1@kinds.example');
  const r = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('fn', 'r1', 'first_name', 0.1, { label: 'First', required: true }), box('ln', 'r1', 'last_name', 0.2, { label: 'Last', required: true })], { send: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const a = await signer(eid, emailOf(eid, 'r1'));
  const fn = a.v.fields.find((f: any) => f.type === 'first_name');
  const ln = a.v.fields.find((f: any) => f.type === 'last_name');
  assert.equal(fn.value, 'Mary');
  assert.equal(fn.name_check, 'Check your first name');
  assert.equal(ln.value, 'Dijk');
  const done = await a.done({ [fn.id]: 'Marianne', [a.v.fields.find((f: any) => f.type === 'signature').id]: '1' }, { signature_png: PNG });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(row(eid, 'First').value, 'Marianne', 'their change is that field\'s value');
  assert.equal(row(eid, 'Last').value, 'Dijk', 'a field nobody sent keeps what was taken from their name');
  assert.equal(db.get("SELECT name FROM recipients WHERE envelope_id=? AND role='signer'", eid).name, 'Mary Ann van Dijk', 'their name is not changed');
});

// ---- 2. Drawing ----------------------------------------------------------------------------------------------------

test('a drawing: only a picture of ours is kept, it is printed as a picture, listed as a drawing, and never counts as a signature', async () => {
  assert.ok(isDrawingValue(PNG));
  assert.ok(!isDrawingValue('data:image/svg+xml;base64,PHN2Zz4='), 'never an SVG');
  assert.ok(!isDrawingValue('https://example.org/x.png'));
  const s = await person('Sue Sender', 'sue2@kinds.example');
  const people = [{ id: 'r1', role: 'signer', name: 'Dora Drawer', email: 'dora@kinds.example' }];
  const r = await envelope(s, [box('dr', 'r1', 'drawing', 0.3, { label: 'Sketch of the plot', required: true, h: 0.15 })], { send: true }, people);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const a = await signer(eid, 'dora@kinds.example');
  const dr = a.v.fields[0];
  // Something that is not a picture of ours is not kept, so the required drawing is still empty.
  const no = await a.done({ [dr.id]: 'javascript:alert(1)' });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /required field is still empty: Sketch of the plot/);
  const big = await a.done({ [dr.id]: `data:image/png;base64,${'A'.repeat(800_000)}` });
  assert.equal(big.status, 400, 'a picture larger than a signature may be is not kept');
  const ok = await a.done({ [dr.id]: PNG });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(row(eid, 'Sketch of the plot').value, PNG);
  const rec = db.get('SELECT signature_png, status FROM recipients WHERE envelope_id=?', eid);
  assert.equal(rec.status, 'completed');
  assert.equal(rec.signature_png, null, 'a drawing is not a signature');
  const pdf = (await s.get(`/envelopes/${eid}/download`)).data as Uint8Array;
  const text = await pdfText(pdf);
  assert.match(text, /1 drawing made in a Drawing field\. A drawing is a picture on the page, not a signature\./);
  assert.ok(!text.includes('data:image'), 'its picture is never printed as words');
  const doc = await PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() >= 2);
});

// ---- 3. Approve and Decline on the page -----------------------------------------------------------------------------

test('Approve and Decline buttons: for someone who signs or approves, never required, holding no answer', async () => {
  assert.equal(buttonWords('approve', 'approver'), 'Approve');
  assert.equal(buttonWords('approve', 'signer'), 'Finish');
  assert.equal(buttonWords('decline', 'approver'), 'Decline to approve');
  assert.equal(buttonWords('decline', 'signer'), 'Decline to sign');
  const s = await person('Sue Sender', 'sue3@kinds.example');
  const cc = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06 }), box('a', 'r3', 'approve', 0.5)], {}, [
    { id: 'r1', role: 'signer', name: 'Ann Signer', email: 'ann3@kinds.example', routing_order: 1 },
    { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee3@kinds.example', routing_order: 2 },
  ]);
  assert.equal(cc.status, 400);
  assert.match(cc.data.error, /an Approve button for Cee Copy, who only gets a copy\. Give it to someone who signs or approves, or delete it\. Nothing was saved\./);
  const r = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('ap', 'r2', 'approve', 0.5, { required: true, value: '' }), box('de', 'r2', 'decline', 0.55, { required: true })], { send: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  assert.equal(db.get("SELECT COUNT(*) n FROM fields WHERE envelope_id=? AND type IN ('approve','decline') AND required=1", eid).n, 0);
  const a = await signer(eid, emailOf(eid, 'r1'));
  assert.equal((await a.done({ [a.v.fields[0].id]: '1' }, { signature_png: PNG })).status, 200);
  const p = await signer(eid, emailOf(eid, 'r2'));
  assert.deepEqual(p.v.fields.map((f: any) => f.type).sort(), ['approve', 'decline']);
  // Approve does what the Approve at the bottom does: the approver is done.
  const ok = await p.done({ [p.v.fields[0].id]: 'yes please' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.get("SELECT status FROM recipients WHERE envelope_id=? AND role='approver'", eid).status, 'completed');
  assert.equal(db.get("SELECT COUNT(*) n FROM fields WHERE envelope_id=? AND type IN ('approve','decline') AND value IS NOT NULL", eid).n, 0, 'a button holds no answer');
  const text = await pdfText((await s.get(`/envelopes/${eid}/download`)).data);
  assert.match(text, /Approved/);
});

test('a Decline button on the page leads to the same decline as Other actions', async () => {
  const s = await person('Sue Sender', 'sue4@kinds.example');
  const r = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('de', 'r1', 'decline', 0.55)], { send: true }, [{ id: 'r1', role: 'signer', name: 'Ann Signer', email: 'ann4@kinds.example' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = await signer(r.data.envelope.id, 'ann4@kinds.example');
  const no = await a.c.post(`/sign/${a.tok}/decline`, { reason: 'Wrong address on page 1.' });
  assert.equal(no.status, 200, JSON.stringify(no.data));
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', r.data.envelope.id).status, 'declined');
});

// ---- 4. Same answer as ----------------------------------------------------------------------------------------------

test('same answer: typing in one fills the others of the same person and kind, never someone else\'s', () => {
  const fields = [
    { id: 'a', recipient_id: 'r1', type: 'text', link: 'Address' },
    { id: 'b', recipient_id: 'r1', type: 'text', link: ' address ' === 'x' ? '' : 'Address' },
    { id: 'c', recipient_id: 'r2', type: 'text', link: 'Address' },
    { id: 'd', recipient_id: 'r1', type: 'signature', link: 'Address' },
  ];
  assert.deepEqual(linkedTo(fields[0], fields).map((f) => f.id), ['b']);
  assert.deepEqual(spreadLinked(fields, {}, 'a', '1 Main St'), { a: '1 Main St', b: '1 Main St' });
  // The one that differs from what is stored is the one just typed, and it wins.
  const stored = fields.map((f) => ({ ...f, value: f.id === 'a' ? 'old' : 'old' }));
  assert.deepEqual(settleLinked(stored, { a: 'old', b: 'new' }), { a: 'new', b: 'new' });
});

test('same answer on the server: one answer whatever the browser sends, kinds must match, and only fields that can', async () => {
  const s = await person('Sue Sender', 'sue5@kinds.example');
  const mixed = await envelope(s, [box('a', 'r1', 'text', 0.1, { link: 'Ref' }), box('b', 'r1', 'number', 0.2, { link: 'Ref' })]);
  assert.equal(mixed.status, 400);
  assert.match(mixed.data.error, /share an answer, and they are different kinds of field\. Only fields of the same kind can share an answer\. Nothing was saved\./);
  const sig = await envelope(s, [box('a', 'r1', 'signature', 0.1, { link: 'Ref' })]);
  assert.match(sig.data.error, /cannot share an answer with another field/);
  const r = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('a', 'r1', 'text', 0.1, { label: 'Address 1', link: 'Address', required: true }), box('b', 'r1', 'text', 0.2, { label: 'Address 2', link: 'Address', required: true })], { send: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const e = (await s.get(`/envelopes/${eid}`)).data.envelope;
  assert.equal(e.fields.find((f: any) => f.label === 'Address 1').link, 'Address', 'the API gives the link back');
  const a = await signer(eid, emailOf(eid, 'r1'));
  const sid = a.v.fields.find((f: any) => f.type === 'signature').id;
  const one = a.v.fields.find((f: any) => f.label === 'Address 1').id;
  const two = a.v.fields.find((f: any) => f.label === 'Address 2').id;
  // Only one of them sent, and the other required one is not "still empty".
  const ok = await a.done({ [sid]: '1', [one]: '1 Main Street', [two]: '' }, { signature_png: PNG });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(row(eid, 'Address 1').value, '1 Main Street');
  assert.equal(row(eid, 'Address 2').value, '1 Main Street');
});

// ---- 5. Date from another date --------------------------------------------------------------------------------------

test('dates: days, weeks and months on the Gregorian calendar, with month ends held to the last day', () => {
  assert.equal(addToDay('2027-01-31', 1, 'months'), '2027-02-28');
  assert.equal(addToDay('2028-01-31', 1, 'months'), '2028-02-29', 'a leap year');
  assert.equal(addToDay('2027-03-31', -1, 'months'), '2027-02-28');
  assert.equal(addToDay('2027-12-15', 2, 'months'), '2028-02-15');
  assert.equal(addToDay('2027-01-15', -13, 'months'), '2025-12-15');
  assert.equal(addToDay('2027-12-25', 10, 'days'), '2028-01-04');
  assert.equal(addToDay('2027-03-01', -1, 'days'), '2027-02-28');
  assert.equal(addToDay('2027-01-01', 2, 'weeks'), '2027-01-15');
  assert.equal(addToDay('2027-02-30', 1, 'days'), '', 'not a real day');
  assert.equal(addToDay('next week', 1, 'days'), '');
  // The day someone signs is the calendar day where they are.
  assert.equal(dayOf('2027-01-31T23:30:00Z', 'Asia/Tokyo'), '2027-02-01');
  assert.equal(dayOf('2027-01-31T23:30:00Z', 'America/Los_Angeles'), '2027-01-31');
  assert.equal(dayOf('2027-01-31T23:30:00Z', null), '2027-01-31', 'UTC without a zone');
  const rule = { from: 's', add: 30, unit: 'days' as const };
  assert.equal(dateFromValue(rule, { id: 's', type: 'date', value: '2027-01-10' }, {}), '2027-02-09');
  assert.equal(dateFromValue(rule, { id: 's', type: 'date', value: '2027-01-10' }, { s: '2027-01-20' }), '2027-02-19', 'what is being typed counts');
  assert.equal(dateFromValue(rule, { id: 's', type: 'date_signed' }, {}, '2027-01-31'), '2027-03-02');
  assert.equal(dateFromWords(rule, 'Start date'), '30 days after Start date');
  assert.equal(dateFromWords({ from: 's', add: -1, unit: 'months' }, 'the date you sign'), '1 month before the date you sign');
  assert.ok(!/deadline/i.test(DATE_FROM_NOTE) && /does not track it or remind/.test(DATE_FROM_NOTE), 'never presented as a deadline we keep');
});

test('dates on the server: worked out from a date and from the day of signing in their zone, never taken from the browser, refused when it cannot work', async () => {
  const s = await person('Sue Sender', 'sue6@kinds.example');
  const text = await envelope(s, [box('a', 'r1', 'text', 0.1, { date_from: { from: 'b', add: 1, unit: 'days' } }), box('b', 'r1', 'date', 0.2)]);
  assert.match(text.data.error, /is not a date field\. Only a date field can be worked out from another date/);
  const other = await envelope(s, [box('s1', 'r1', 'signature', 0.8, { h: 0.06 }), box('s2', 'r2', 'signature', 0.8, { x: 0.5, h: 0.06 }), box('a', 'r1', 'date', 0.1, { date_from: { from: 'b', add: 1, unit: 'days' } }), box('b', 'r2', 'date', 0.2)], { send: true }, [
    { id: 'r1', role: 'signer', name: 'Ann One', email: 'ann6@kinds.example' }, { id: 'r2', role: 'signer', name: 'Ben Two', email: 'ben6@kinds.example' }]);
  assert.match(other.data.error, /belongs to Ann One, and the date field on page 1 belongs to Ben Two\. A date can only be worked out from a date of the same person|cannot count from the date chosen for it\. It must count from a Date or a Date signed field of the same person/);
  // A draft keeps a date that counts from nothing yet, as the editor saves while the sender works, and sending says what to do.
  const waiting = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06 }), box('a', 'r1', 'date', 0.1, { label: 'Renewal', date_from: { from: '', add: 30, unit: 'days' } })]);
  assert.equal(waiting.status, 200, JSON.stringify(waiting.data));
  assert.deepEqual((await s.get(`/envelopes/${waiting.data.envelope.id}`)).data.envelope.fields.find((f: any) => f.label === 'Renewal').date_from, { from: '', add: 30, unit: 'days' });
  const send = await s.post(`/envelopes/${waiting.data.envelope.id}/send`);
  assert.equal(send.status, 400);
  assert.equal(send.data.error, "'Renewal' on page 1 counts from a date you have not chosen yet. Open it in step 2 and choose one under Counted from, or delete it.");
  const unit = await envelope(s, [box('a', 'r1', 'date', 0.1, { date_from: { from: 'b', add: 1, unit: 'years' } }), box('b', 'r1', 'date', 0.2)]);
  assert.match(unit.data.error, /"unit" must be "days", "weeks" or "months"/);
  const r = await envelope(s, [
    box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }),
    box('start', 'r1', 'date', 0.1, { label: 'Start date', required: true }),
    box('end', 'r1', 'date', 0.15, { label: 'End date', required: true, value: '2030-01-01', date_from: { from: 'start', add: 1, unit: 'months' } }),
    box('ds', 'r1', 'date_signed', 0.2, { label: 'Signed on' }),
    box('rev', 'r1', 'date', 0.25, { label: 'Review', date_from: { from: 'ds', add: 1, unit: 'days' } }),
  ], { send: true, date_format: 'YYYY-MM-DD' }, [{ id: 'r1', role: 'signer', name: 'Dee Dates', email: 'dee@kinds.example' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const end = row(eid, 'End date');
  assert.equal(end.required, 0, 'never required: nobody types it');
  assert.equal(end.prefill, null, 'never the sender\'s words');
  const a = await signer(eid, 'dee@kinds.example');
  assert.equal(a.v.fields.find((f: any) => f.label === 'End date').date_note, '1 month after Start date. Counted on the calendar. GrowSigning does not track it or remind anyone of it.');
  assert.match(a.v.fields.find((f: any) => f.label === 'Review').date_note, /^1 day after Signed on\./);
  const sid = a.v.fields.find((f: any) => f.type === 'signature').id;
  const startId = a.v.fields.find((f: any) => f.label === 'Start date').id;
  const endId = a.v.fields.find((f: any) => f.label === 'End date').id;
  // Saved halfway: worked out at once from what they picked.
  assert.equal((await a.c.post(`/sign/${a.tok}/save`, { values: { [startId]: '2027-01-31', [endId]: '1999-01-01' } })).status, 200);
  assert.equal(row(eid, 'End date').value, '2027-02-28', 'the browser\'s value for it is not taken');
  db.run("UPDATE recipients SET tz='Pacific/Kiritimati' WHERE envelope_id=?", eid);
  const ok = await a.done({ [sid]: '1', [startId]: '2027-01-31', [endId]: '1999-01-01' }, { signature_png: PNG, tz: 'Pacific/Kiritimati' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const done = db.get('SELECT completed_at FROM recipients WHERE envelope_id=?', eid).completed_at;
  assert.equal(row(eid, 'Review').value, addToDay(dayOf(done, 'Pacific/Kiritimati'), 1, 'days'), 'the day of signing where they are, plus a day');
  const pdf = await pdfText((await s.get(`/envelopes/${eid}/download`)).data);
  assert.match(pdf, /2027-02-28/);
});

// ---- 6. Text style --------------------------------------------------------------------------------------------------

test('text style: fonts we have, 8 to 24 points, three colours, bold; refused in words otherwise', () => {
  assert.deepEqual(lookOf({ font: 'serif', size: 30, color: 'blue', bold: true }), { font: 'serif', size: 24, color: 'blue', bold: true });
  assert.deepEqual(lookOf({ size: 3 }), { size: 8 });
  assert.equal(lookOf({ font: 'comic' }), null);
  assert.equal(lookOf('not json'), null);
  assert.match(lookProblem({ font: 'comic' }), /is not one we have\. Use "sans" \(Sans\), "serif" \(Serif\), "mono" \(Typewriter\)/);
  assert.match(lookProblem({ size: 40 }), /from 8 to 24 points/);
  assert.match(lookProblem({ color: 'red' }), /Use "black", "blue" \(dark blue\) or "brand"/);
  assert.equal(lookProblem({ font: 'mono', size: 12 }), '');
  assert.equal(lookHex({ color: 'brand' }, '#aa3300'), '#aa3300');
  assert.equal(lookHex({ color: 'brand' }, 'javascript:'), '#1c2921', 'a brand colour that is not a colour is black');
  assert.deepEqual(lookCss({ font: 'serif', bold: true }, null), { fontFamily: '"Times New Roman", Times, serif', fontWeight: 700 });
  assert.equal(lookWords({ font: 'mono', size: 12, color: 'blue', bold: true }), 'Typewriter, 12 pt, dark blue, bold');
  assert.equal(lookFor({ type: 'signature', look: { bold: true } }), null, 'a picture has no text style');
  assert.deepEqual(lookFor({ type: 'text', look: { size: 14 } }, { font: 'serif', size: 10 }), { font: 'serif', size: 14 });
});

test('text style in the PDF: the standard serif font for Latin text, and the script\'s own font where it lacks a letter', async () => {
  const s = await person('Sue Sender', 'sue7@kinds.example');
  const bad = await envelope(s, [box('a', 'r1', 'text', 0.1, { look: { color: 'red' } })]);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Field 1: The colour "red" is not one we have/);
  const r = await envelope(s, [
    box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }),
    box('a', 'r1', 'text', 0.1, { label: 'Latin', look: { font: 'serif', size: 12, color: 'blue', bold: true } }),
    box('b', 'r1', 'text', 0.2, { label: 'Cyrillic', look: { font: 'mono', size: 10 } }),
  ], { send: true }, [{ id: 'r1', role: 'signer', name: 'Ivan Petrov', email: 'ivan@kinds.example' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  assert.deepEqual((await s.get(`/envelopes/${eid}`)).data.envelope.fields.find((f: any) => f.label === 'Latin').look, { font: 'serif', size: 12, color: 'blue', bold: true });
  const a = await signer(eid, 'ivan@kinds.example');
  const id = (l: string) => a.v.fields.find((f: any) => f.label === l).id;
  const ok = await a.done({ [a.v.fields.find((f: any) => f.type === 'signature').id]: '1', [id('Latin')]: 'Garden Lane', [id('Cyrillic')]: 'Иван' }, { signature_png: PNG });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const pdf = (await s.get(`/envelopes/${eid}/download`)).data as Uint8Array;
  const doc = await PDFDocument.load(pdf);
  const fonts = doc.context.enumerateIndirectObjects().map(([, o]: any) => (o?.get?.(PDFName.of('BaseFont')) ? String(o.get(PDFName.of('BaseFont'))) : '')).filter(Boolean);
  assert.ok(fonts.includes('/Times-Bold'), `the serif font, bold: ${fonts.join(' ')}`);
  assert.ok(!fonts.some((x) => /Courier/.test(x)), 'Typewriter lacks Cyrillic letters, so that text is printed in the usual font');
  const text = await pdfText(pdf);
  assert.match(text, /Garden Lane/);
  assert.match(text, /Иван/);
});

test('text style for the team: new fields start with it, fields already placed keep theirs', async () => {
  const s = await person('Sue Sender', 'sue8@kinds.example');
  const before = await envelope(s, [box('a', 'r1', 'text', 0.1, { label: 'Old' })]);
  const set = await s.put('/saved-fields/look', { field_look: { font: 'serif', size: 11 } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.match((await s.put('/saved-fields/look', { field_look: { size: 99 } })).data.error, /from 8 to 24 points/);
  const eid = before.data.envelope.id;
  const e = (await s.get(`/envelopes/${eid}`)).data.envelope;
  const kept = await s.put(`/envelopes/${eid}`, { fields: [...e.fields, box('n', e.recipients[0].id, 'text', 0.3, { label: 'New', document_id: e.documents[0].id }), box('p', e.recipients[0].id, 'signature', 0.5, { label: 'Pic', document_id: e.documents[0].id, h: 0.06 })], edit_version: e.edit_version });
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  assert.equal(row(eid, 'Old').look, null);
  assert.deepEqual(JSON.parse(row(eid, 'New').look), { font: 'serif', size: 11 });
  assert.equal(row(eid, 'Pic').look, null, 'a picture has no text style');
  // Sent with "look": null, a new field has none.
  const none = await envelope(s, [box('a', 'r1', 'text', 0.1, { label: 'Plain', look: null })]);
  assert.equal(row(none.data.envelope.id, 'Plain').look, null);
  assert.equal((await s.put('/saved-fields/look', { field_look: null })).data.field_look, null);
});

// ---- 7. Saved fields ------------------------------------------------------------------------------------------------

test('saved fields: admins save kind, label, checks, size and style under a name; the team reads them; never a value or a person', async () => {
  assert.equal(savedKey('  Post  Code '), 'post code');
  const boss = await person('Bea Boss', 'bea@kinds.example');
  const mem = await person('Max Member', 'max@kinds.example');
  assert.equal((await boss.post('/account/invites', { email: 'max@kinds.example', role: 'member' })).status, 200);
  assert.equal((await mem.post('/invites/accept', { token: db.get("SELECT token FROM invites WHERE email='max@kinds.example' AND accepted_at IS NULL").token })).status, 200);
  const field = { type: 'text', label: 'Postcode', required: true, validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' }, w: 0.12, h: 0.03, look: { font: 'mono' }, value: 'secret', recipient_id: 'r1', x: 0.5, page: 3 };
  const made = await boss.post('/saved-fields', { name: 'Postcode', field });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.deepEqual(Object.keys(made.data.saved_field.field).sort(), ['h', 'label', 'look', 'required', 'type', 'validation', 'w']);
  const list = (await mem.get('/saved-fields')).data;
  assert.equal(list.saved_fields.length, 1, 'the team sees it');
  assert.equal(list.saved_fields[0].name, 'Postcode');
  const no = await mem.post('/saved-fields', { name: 'Mine', field });
  assert.equal(no.status, 403, 'only admins save');
  assert.equal((await mem.call('DELETE', `/saved-fields/${list.saved_fields[0].id}`)).status, 403);
  // The same name again replaces it.
  await boss.post('/saved-fields', { name: ' postcode ', field: { ...field, label: 'Zip' } });
  const again = (await boss.get('/saved-fields')).data.saved_fields;
  assert.equal(again.length, 1);
  assert.equal(again[0].field.label, 'Zip');
  assert.match((await boss.post('/saved-fields', { name: 'Note', field: { type: 'note' } })).data.error, /cannot be saved for the team: it is your own wording on one document/);
  assert.match((await boss.post('/saved-fields', { name: '', field })).data.error, /Give the saved field a name/);
  assert.match((await boss.post('/saved-fields', { name: 'x'.repeat(61), field })).data.error, /at most 60 characters/);
  // Another team sees none of it.
  const other = await person('Ola Other', 'ola@kinds.example');
  assert.equal((await other.get('/saved-fields')).data.saved_fields.length, 0);
  assert.equal((await other.call('DELETE', `/saved-fields/${again[0].id}`)).status, 404, 'not theirs: it is not there for them');
  assert.equal((await boss.get('/saved-fields')).data.saved_fields.length, 1);
  assert.equal((await boss.call('DELETE', `/saved-fields/${again[0].id}`)).status, 200);
  assert.equal((await boss.call('DELETE', `/saved-fields/${again[0].id}`)).status, 404);
});

// ---- Templates, bulk and the API carry all of these -----------------------------------------------------------------

test('a template carries every new kind into what is made from it, with the date rule pointing at the copy\'s own field', async () => {
  const s = await person('Tom Template', 'tom@kinds.example');
  const file = await upload(s, 1);
  const tpl = await s.post('/envelopes', {
    kind: 'template', subject: 'Lease', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant' }, { id: 'p', role: 'approver', role_name: 'Manager' }],
    fields: [
      box('sig', 'r', 'signature', 0.85, { required: true, h: 0.06 }),
      box('fn', 'r', 'first_name', 0.05, { label: 'Given name' }),
      box('dr', 'r', 'drawing', 0.4, { label: 'Plot', h: 0.1 }),
      box('a1', 'r', 'text', 0.1, { label: 'A1', link: 'Addr', look: { font: 'serif' } }),
      box('a2', 'r', 'text', 0.15, { label: 'A2', link: 'Addr' }),
      box('st', 'r', 'date', 0.2, { label: 'Start' }),
      box('en', 'r', 'date', 0.25, { label: 'End', date_from: { from: 'st', add: 12, unit: 'months' } }),
      box('ok', 'p', 'approve', 0.6),
    ],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const used = await s.post('/envelopes', { template_id: tpl.data.envelope.id, recipients: { Tenant: { name: 'Tia Tenant', email: 'tia@kinds.example' }, Manager: { name: 'Mo Manager', email: 'mo@kinds.example' } } });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  const e = (await s.get(`/envelopes/${used.data.envelope.id}`)).data.envelope;
  const f = (l: string) => e.fields.find((x: any) => x.label === l);
  assert.equal(f('A1').link, 'Addr');
  assert.deepEqual(f('A1').look, { font: 'serif' });
  assert.equal(f('End').date_from.from, f('Start').id, 'the copy\'s own Start');
  assert.notEqual(f('End').date_from.from, 'st');
  assert.equal(f('Given name').type, 'first_name');
  assert.ok(e.fields.some((x: any) => x.type === 'approve'));
  const bulk = await s.post('/bulk', { template_id: tpl.data.envelope.id, rows: [{ Tenant: { name: 'Bo Bulk', email: 'bo@kinds.example' }, Manager: { name: 'Mo Manager', email: 'mo2@kinds.example' } }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  const be = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='bo@kinds.example'").id;
  assert.ok(db.get("SELECT date_from FROM fields WHERE envelope_id=? AND label='End'", be).date_from);
});

// ---- Repairs after review -------------------------------------------------------------------------------------------

test('repair: a saved field with an over-long check, a label that is not text or a kind that cannot be saved is refused in words', async () => {
  const boss = await person('Rae Repair', 'rae@kinds.example');
  const long = await boss.post('/saved-fields', { name: 'Long', field: { type: 'text', validation: { kind: 'pattern', pattern: 'a'.repeat(3000) } } });
  assert.equal(long.status, 400, JSON.stringify(long.data));
  assert.match(long.data.error, /too long to save\. Keep it under 2000 characters\. Nothing was saved\./);
  const obj = await boss.post('/saved-fields', { name: 'Obj', field: { type: 'text', label: { a: 1 } } });
  assert.equal(obj.status, 400);
  assert.match(obj.data.error, /"label" is text/);
  const ap = await boss.post('/saved-fields', { name: 'Ap', field: { type: 'approve' } });
  assert.match(ap.data.error, /^An Approve button cannot be saved for the team/);
  assert.match((await boss.post('/saved-fields', { name: 'St', field: { type: 'stamp' } })).data.error, /^A stamp cannot be saved/);
  const ok = await boss.post('/saved-fields', { name: 'Short', field: { type: 'text', validation: { kind: 'pattern', pattern: '[0-9]{4}' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.saved_field.field.validation, { kind: 'pattern', pattern: '[0-9]{4}' });
  assert.equal((await boss.get('/saved-fields')).data.saved_fields.length, 1, 'nothing of the refused ones was kept');
});

test('repair: a refused "finish later" save keeps no drawing', async () => {
  const s = await person('Sue Sender', 'sue20@kinds.example');
  const people = [{ id: 'r1', role: 'signer', name: 'Dora Drawer', email: 'dora20@kinds.example' }];
  const r = await envelope(s, [box('dr', 'r1', 'drawing', 0.3, { label: 'Plot', h: 0.15 }), box('dt', 'r1', 'date', 0.6, { label: 'When' })], { send: true }, people);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const a = await signer(eid, 'dora20@kinds.example');
  const dr = a.v.fields.find((f: any) => f.type === 'drawing').id;
  const dt = a.v.fields.find((f: any) => f.type === 'date').id;
  const no = await a.c.post(`/sign/${a.tok}/save`, { values: { [dr]: PNG, [dt]: 'next Tuesday' } });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Nothing was saved\./);
  assert.equal(row(eid, 'Plot').value, null, 'the drawing of a refused save is not stored');
  const yes = await a.c.post(`/sign/${a.tok}/save`, { values: { [dr]: PNG } });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(row(eid, 'Plot').value, PNG);
});

test('repair: a field sent back without "look" keeps its text style; "look": null clears it', async () => {
  const s = await person('Sue Sender', 'sue21@kinds.example');
  const r = await envelope(s, [box('a', 'r1', 'text', 0.1, { label: 'Styled', look: { font: 'serif', bold: true } })]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  let e = (await s.get(`/envelopes/${eid}`)).data.envelope;
  const bare = e.fields.map(({ look, ...f }: any) => f);
  const put = await s.put(`/envelopes/${eid}`, { fields: bare, edit_version: e.edit_version });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(JSON.parse(row(eid, 'Styled').look), { font: 'serif', bold: true });
  e = (await s.get(`/envelopes/${eid}`)).data.envelope;
  const cleared = await s.put(`/envelopes/${eid}`, { fields: e.fields.map((f: any) => ({ ...f, look: null })), edit_version: e.edit_version });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(row(eid, 'Styled').look, null);
});

test('repair: a date worked out from another date shares no answer, and an unchosen date is said as such at send', async () => {
  const s = await person('Sue Sender', 'sue22@kinds.example');
  const linked = await envelope(s, [box('st', 'r1', 'date', 0.1, { label: 'Start', link: 'D' }), box('en', 'r1', 'date', 0.2, { label: 'End', link: 'D', date_from: { from: 'st', add: 1, unit: 'months' } })]);
  assert.equal(linked.status, 400);
  assert.match(linked.data.error, /worked out from another date, so it cannot share an answer/);
  // On the page too: the worked-out date is never in a group.
  const fields = [{ id: 'a', recipient_id: 'r', type: 'date', link: 'D' }, { id: 'b', recipient_id: 'r', type: 'date', link: 'D', date_from: { from: 'a', add: 1, unit: 'days' } }];
  assert.deepEqual(linkedTo(fields[0], fields), []);
  assert.deepEqual(spreadLinked(fields, {}, 'a', '2027-01-31'), { a: '2027-01-31' });
  // A draft with a date that counts from nothing chosen yet: send says exactly that.
  const d = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('ds', 'r1', 'date_signed', 0.5), box('rn', 'r1', 'date', 0.2, { label: 'Renewal', date_from: { from: '', add: 30, unit: 'days' } })]);
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const sent = await s.post(`/envelopes/${d.data.envelope.id}/send`, {});
  assert.equal(sent.status, 400);
  assert.match(sent.data.error, /'Renewal' on page 1 counts from a date you have not chosen yet\. Open it in step 2 and choose one under Counted from, or delete it\./);
});

test('repair: "Your brand colour" is offered only when the account has one', async () => {
  const s = await person('Sue Sender', 'sue23@kinds.example');
  const g = (await s.get('/saved-fields')).data;
  assert.equal(g.brand_color, null);
  assert.deepEqual(colorsFor(g.brand_color).map((c) => c.key), ['black', 'blue']);
  assert.deepEqual(colorsFor(null, 'brand').map((c) => c.key), ['black', 'blue', 'brand'], 'a style that already uses it still shows it');
  assert.deepEqual(colorsFor('#123abc').map((c) => c.key), ['black', 'blue', 'brand']);
  db.run("UPDATE accounts SET brand_color='#123abc' WHERE id IN (SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='sue23@kinds.example')");
  assert.equal((await s.get('/saved-fields')).data.brand_color, '#123abc');
});

test('repair: a first or last name says "Check your first name" to the signing page while it is unchanged', async () => {
  const s = await person('Sue Sender', 'sue24@kinds.example');
  const r = await envelope(s, [box('s', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('fn', 'r1', 'first_name', 0.1, { label: 'First' })], { send: true });
  const eid = r.data.envelope.id;
  const a = await signer(eid, emailOf(eid, 'r1'));
  const fn = a.v.fields.find((f: any) => f.type === 'first_name');
  assert.equal(fn.from_name, 'Mary');
  assert.equal(fn.name_check, 'Check your first name');
});
