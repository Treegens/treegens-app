// "Fill in" and "Your text" (src/lib/fieldkinds.ts section 8). A sender dropped a Note field expecting the signer to
// type there, and the signed document said "Note". The blank a signer types into is now called "Fill in" (type
// 'text'), the sender's own words are "Your text" (type 'note'), and a "Your text" box with no words in it reaches
// nobody: not the signing page, not the text view, not the signed PDF. The names, the shared rules and the server.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, upload, tokenFor, PNG, type Server } from './helpers.ts';
import {
  FILL_IN_NAME, YOUR_TEXT_NAME, KIND_HINT, KIND_SAYS, TYPE_HERE, YOUR_TEXT_EMPTY, OLD_NOTE_WORD,
  noteWords, isEmptyNote, isLeftoverNote, unwrittenNotes, noteValue, fillInTag,
} from '../src/lib/fieldkinds.ts';
import { LABEL, fieldName, buildItems } from '../src/components/sign/fields.ts';
import { HEARD_AS, unlabelled } from '../src/lib/phone.ts';
import { COMMON_FIELDS, paletteKinds } from '../src/lib/editorux.ts';
import { FIELD_TYPES } from '../src/server/envelopes.ts';
import { openapi } from '../src/server/openapi.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// The editor's list of kinds (src/components/editor/shared.ts) is a browser module, so it is read as text here.
const SHARED = read('src/components/editor/shared.ts');
const TYPES: [string, string][] = [...SHARED.slice(SHARED.indexOf('export const TYPES'), SHARED.indexOf('];', SHARED.indexOf('export const TYPES'))).matchAll(/\['([a-z_]+)', '([^']+)'/g)].map((m) => [m[1], m[2]]);
const TLABEL: Record<string, string> = Object.fromEntries(TYPES);
const EM = new RegExp(String.fromCharCode(0x2014)); // written this way so this file holds none itself
let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.97.${++n}.7`);

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
const box = (id: string, rid: string | null, type: string, y: number, extra: any = {}) => ({ id, document_id: 'd', recipient_id: rid, type, page: 0, x: 0.1, y, w: 0.3, h: 0.03, required: false, ...extra });
const NOTES = [
  box('n-none', null, 'note', 0.1),
  box('n-empty', null, 'note', 0.15, { value: '' }),
  box('n-spaces', null, 'note', 0.2, { value: '  \n \t ' }),
  box('n-words', null, 'note', 0.25, { value: 'Notices go to the address below.' }),
];
async function signer(eid: string, email: string) {
  const c = new Client();
  c.ip = `10.98.${++n}.1`;
  const tok = tokenFor(eid, email);
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  return { c, tok, v: (await c.get(`/sign/${tok}`)).data };
}

// ---- The names ----------------------------------------------------------------------------------------------------

test('the two kinds are named for who types, and the stored types are unchanged', () => {
  assert.equal(FILL_IN_NAME, 'Fill in');
  assert.equal(YOUR_TEXT_NAME, 'Your text');
  assert.equal(TLABEL.text, FILL_IN_NAME, 'the editor\'s list and the shared name agree');
  assert.equal(TLABEL.note, YOUR_TEXT_NAME);
  assert.ok(FIELD_TYPES.includes('text') && FIELD_TYPES.includes('note'), 'the API and the database keep their type names');
  assert.ok(TYPES.some((t) => t[0] === 'text') && TYPES.some((t) => t[0] === 'note'));
  // No kind in the editor is called "Note" or plain "Text" any more.
  assert.ok(!TYPES.some((t) => t[1] === 'Note' || t[1] === 'Text'), TYPES.map((t) => t[1]).join());
  assert.equal(KIND_HINT.text, 'They type here');
  assert.equal(KIND_HINT.note, 'You type, they read');
  assert.match(KIND_SAYS.text, /signer\. They type the answer when they sign/);
  assert.match(KIND_SAYS.note, /Your own words, printed on the page\. Nobody can type here when signing/);
  // Fill in is one of the six always on show. Your text and Email are one press away, under More fields.
  assert.ok(COMMON_FIELDS.includes('text'));
  const all = TYPES.map((t) => t[0]);
  assert.ok(!paletteKinds(all).includes('note') && !paletteKinds(all).includes('email'));
  assert.ok(paletteKinds(all, { open: true }).includes('note') && paletteKinds(all, { open: true }).includes('email'));
  assert.equal(TLABEL.email, 'Email');
  assert.match(KIND_HINT.email, /^Their email, filled in for them$/);
});

test('the hint is on the screen where the kind is chosen, and the names are the same in the editor, review, help, README and API description', () => {
  const step = read('src/components/editor/StepFields.tsx');
  assert.match(step, /<small id=\{`ed-kind-\$\{t\}`\}>\{KIND_HINT\[t\]\}<\/small>/, 'the one line under the name in the list of kinds');
  assert.match(step, /aria-label=\{KIND_HINT\[t\] \? label : undefined\} aria-describedby=\{KIND_HINT\[t\] \? `ed-kind-\$\{t\}` : undefined\}/, 'a screen reader hears the name, then the hint');
  assert.match(step, /tool === 'text' \? 'Click on the page where they should type\.' : tool === 'note' \? 'Click on the page where your words should go\.'/);
  assert.match(step, /id="ed-note-text"/);
  assert.doesNotMatch(step, />Text<\/span><textarea/, 'the box for your own words is no longer called Text');
  assert.match(read('src/components/editor/StepReview.tsx'), /\{!closed && <NoteCheck ed=\{ed\} \/>\}/);
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<QA id="fill-in" q="How do I let someone type something on the document\?">/);
  assert.match(help, /choose <b>Fill in<\/b>/);
  assert.match(help, /<b>Your text<\/b>, under More fields, is the other way round/);
  const readme = read('README.md');
  assert.match(readme, /\*\*Fill in\*\* \("They type here"\)/);
  assert.match(readme, /tests\/note-text\.test\.ts/);
  assert.equal(JSON.parse(read('src/locales/en.json'))['settings.fieldkind.text'], 'Fill in');
  const api = JSON.stringify(openapi());
  assert.match(api, /the editor calls it \\"Fill in\\"/);
  assert.match(api, /the editor calls it \\"Your text\\"/);
  assert.match(api, /is shown to nobody who signs and is not printed on the signed PDF/);
  // Checks before sending name the kinds the way the editor does.
  assert.match(read('src/components/editor/PrintCheck.tsx'), /f\.type === 'note' \? 'Your text' : f\.type === 'text' \? 'A fill in field'/);
  assert.match(read('src/server/pdftext.ts'), /f\.type === 'note' \? 'Your text' : f\.type === 'text' \? 'A fill in field'/);
});

test('none of the new words holds an em dash', () => {
  for (const f of ['src/components/editor/NoteCheck.tsx', 'tests/note-text.test.ts']) assert.doesNotMatch(read(f), EM, f);
  const lib = read('src/lib/fieldkinds.ts');
  assert.doesNotMatch(lib.slice(lib.indexOf('---- 8.')), EM);
  for (const w of [FILL_IN_NAME, YOUR_TEXT_NAME, TYPE_HERE, YOUR_TEXT_EMPTY, ...Object.values(KIND_HINT), ...Object.values(KIND_SAYS)]) assert.doesNotMatch(w, EM);
});

// ---- The shared rules -----------------------------------------------------------------------------------------------

test('a new "Your text" box starts empty: no word stands in for the sender\'s wording', () => {
  assert.match(SHARED, /label: '', value: '',/, 'every new field starts with no value');
  assert.doesNotMatch(SHARED, /value: type === 'note' \? 'Note'/);
  assert.ok(isEmptyNote({ type: 'note', value: '' }));
  // Dropped on the page, its settings open with the cursor in "Your words".
  const step = read('src/components/editor/StepFields.tsx');
  assert.match(step, /if \(type === 'note'\) \(setSheet\(true\), \(typeIn\.current = f\.id\)\);/);
  assert.match(step, /document\.getElementById\('ed-note-text'\) as HTMLTextAreaElement/);
  assert.match(step, /isEmptyNote\(f\) \? <i>\{YOUR_TEXT_EMPTY\}<\/i> : f\.value/, 'in the editor an empty box says so, in its own style');
});

test('what counts as empty, and what the review step brings up', () => {
  const f = (value: any, type = 'note') => ({ id: String(value), type, value });
  for (const v of [null, undefined, '', ' ', '\n\t  ']) assert.ok(isEmptyNote(f(v)), JSON.stringify(v));
  for (const v of ['x', ' a ', '0', 'Note']) assert.ok(!isEmptyNote(f(v)), v);
  assert.ok(!isEmptyNote(f('', 'text')), 'an empty Fill in field is a blank for the signer, not an empty box of the sender');
  assert.equal(noteWords(f('  Hello  ')), 'Hello');
  assert.equal(noteWords(f('Hello', 'text')), '');
  assert.ok(isLeftoverNote(f(OLD_NOTE_WORD)) && isLeftoverNote(f(' Note ')));
  assert.ok(!isLeftoverNote(f('Note: see page 2')) && !isLeftoverNote(f('Note', 'text')));
  const list = [f(''), f('Note'), f('Governed by the laws of Kenya.'), f('', 'text'), f('   ')];
  assert.deepEqual(unwrittenNotes(list).map((x) => x.value), ['', 'Note', '   ']);
  // What is saved: the words as typed, or nothing at all.
  assert.equal(noteValue('  kept as typed '), '  kept as typed ');
  for (const v of [null, undefined, '', '   ', '\n']) assert.equal(noteValue(v), null);
});

test('a Fill in field shows who types there until it has a label, and the label is the signer\'s hint', () => {
  assert.equal(fillInTag({ type: 'text', label: '' }, 'Ana Signer'), 'Ana Signer types here');
  assert.equal(fillInTag({ type: 'text', label: 'Email for notices' }, 'Ana Signer'), 'Email for notices');
  assert.equal(fillInTag({ type: 'text', label: '  ' }, null), 'Fill in');
  // On the signing page: the label, or "Type here" when the sender gave none. Never the word "Text".
  assert.equal(fieldName({ type: 'text', label: 'Email for notices' }), 'Email for notices');
  assert.equal(fieldName({ type: 'text', label: '' }), TYPE_HERE);
  assert.equal(TYPE_HERE, 'Type here');
  assert.equal(HEARD_AS.text, LABEL.text, 'the review step quotes what a screen reader says');
  assert.notEqual(LABEL.note, 'Note');
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /placeholder: name \+ \(f\.required \? ' \*' : ''\)/, 'the blank shows its label as the hint');
  // A Fill in field without a label is still brought up at review; the sender's own words never are.
  assert.deepEqual(unlabelled([{ type: 'text', label: '' }, { type: 'text', label: 'Email for notices' }, { type: 'note', readonly: true, value: '' }]).length, 1);
  // Next goes to a Fill in field, required or not, and never to the sender's own words.
  const items = buildItems([{ id: 'a', type: 'text', required: 1 }, { id: 'b', type: 'text', required: 0 }, { id: 'n', type: 'note', readonly: 1, value: 'x' }], () => false);
  assert.deepEqual(items.map((i) => i.key), ['a', 'b']);
});

// ---- The server ---------------------------------------------------------------------------------------------------

test('an empty "Your text" box is saved with no value, reaches no signer and is not on the signed PDF; one with words reaches everyone', async () => {
  const s = await person('Jo Sender', 'jo@notetext.example');
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', {
    subject: 'Notices', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Ana Signer', email: 'ana@notetext.example' }, { id: 'r2', role: 'cc', name: 'Cy Copy', email: 'cy@notetext.example' }],
    fields: [...NOTES, box('sig', 'r1', 'signature', 0.8, { h: 0.06, required: true }), box('mail', 'r1', 'text', 0.4, { label: 'Email for notices', required: true }), box('plain', 'r1', 'text', 0.5), box('em', 'r1', 'email', 0.6)],
    send: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const rows = db.all("SELECT value, y FROM fields WHERE envelope_id=? AND type='note' ORDER BY y", eid);
  assert.deepEqual(rows.map((x: any) => x.value), [null, null, null, 'Notices go to the address below.'], 'spaces alone are no words');
  assert.equal(r.data.envelope.status, 'sent', 'an empty box never stops a send');
  // The signing page: only the box with words is among what is already on the page. No field of the signer is a note.
  const a = await signer(eid, 'ana@notetext.example');
  const notes = a.v.others.filter((f: any) => f.type === 'note');
  assert.deepEqual(notes.map((f: any) => f.value), ['Notices go to the address below.']);
  assert.ok(!a.v.fields.some((f: any) => f.type === 'note'));
  assert.ok(![...a.v.fields, ...a.v.others].some((f: any) => f.value === 'Note'));
  // The Fill in field is theirs to type into, with its label; the Email field is filled in for them.
  const mail = a.v.fields.find((f: any) => f.label === 'Email for notices');
  assert.equal(mail.type, 'text');
  assert.ok(!mail.readonly && mail.required);
  assert.ok(a.v.fields.some((f: any) => f.type === 'email'));
  // Someone who only gets a copy is shown the same.
  const cyTok = tokenFor(eid, 'cy@notetext.example');
  const sig = a.v.fields.find((f: any) => f.type === 'signature').id;
  const refuse = await a.c.post(`/sign/${a.tok}/complete`, { values: { [sig]: '1' }, signature_png: PNG });
  assert.notEqual(refuse.status, 200, 'the required Fill in field has to be typed into');
  const done = await a.c.post(`/sign/${a.tok}/complete`, { values: { [sig]: '1', [mail.id]: 'ana@notices.example' }, signature_png: PNG });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  if (cyTok) {
    const cy = (await new Client().get(`/sign/${cyTok}`)).data;
    if (cy?.others) assert.deepEqual(cy.others.filter((f: any) => f.type === 'note').map((f: any) => f.value), ['Notices go to the address below.']);
  }
  const pdf = await pdfText((await s.get(`/envelopes/${eid}/download`)).data);
  assert.match(pdf, /Notices go to the address below\./);
  assert.match(pdf, /ana@notices\.example/, 'what the signer typed is printed');
  assert.match(pdf, /ana@notetext\.example/, 'the Email field prints the address it was sent to');
  // The word nobody wrote is not on any page of the document (the certificate has its own headings).
  assert.doesNotMatch(pdf.split(/Certificate/i)[0], /(^|\n)Note(\n|$)/);
});

test('a draft saved with an empty box, then written, then emptied again: the value follows the words', async () => {
  const s = await person('Di Draft', 'di@notetext.example');
  const file = await upload(s, 1);
  const base = { subject: 'Draft', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r1', role: 'signer', name: 'Ana Signer', email: 'ana2@notetext.example' }] };
  const fields = (value: any) => [{ ...box('n', null, 'note', 0.1), value }, box('sig', 'r1', 'signature', 0.8, { h: 0.06, required: true })];
  const d = await s.post('/envelopes', { ...base, fields: fields('') });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const eid = d.data.envelope.id;
  const note = () => db.get("SELECT id, value FROM fields WHERE envelope_id=? AND type='note'", eid);
  assert.equal(note().value, null);
  const put = async (value: any) => {
    const now = (await s.get(`/envelopes/${eid}`)).data.envelope; // as it stands, so the save is not from an older copy
    return s.put(`/envelopes/${eid}`, { ...now, fields: now.fields.map((f: any) => (f.type === 'note' ? { ...f, value } : f)) });
  };
  assert.equal((await put('Signed in two copies.')).status, 200);
  assert.equal(note().value, 'Signed in two copies.');
  assert.equal((await put('   ')).status, 200);
  assert.equal(note().value, null);
  const sent = await s.post(`/envelopes/${eid}/send`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const a = await signer(eid, 'ana2@notetext.example');
  assert.deepEqual(a.v.others.filter((f: any) => f.type === 'note'), []);
});

test('templates, copies made from them and a bulk send carry an empty box as empty and a written one with its words', async () => {
  const s = await person('Tom Template', 'tom@notetext.example');
  const file = await upload(s, 1);
  const tpl = await s.post('/envelopes', {
    kind: 'template', subject: 'Notice terms', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant' }],
    fields: [...NOTES, box('sig', 'r', 'signature', 0.85, { required: true, h: 0.06 }), box('mail', 'r', 'text', 0.4, { label: 'Email for notices' })],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const values = (eid: string) => db.all("SELECT value FROM fields WHERE envelope_id=? AND type='note' ORDER BY y", eid).map((x: any) => x.value);
  assert.deepEqual(values(tpl.data.envelope.id), [null, null, null, 'Notices go to the address below.']);
  const used = await s.post('/envelopes', { template_id: tpl.data.envelope.id, recipients: { Tenant: { name: 'Tia Tenant', email: 'tia@notetext.example' } }, send: true });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.deepEqual(values(used.data.envelope.id), [null, null, null, 'Notices go to the address below.']);
  const tia = await signer(used.data.envelope.id, 'tia@notetext.example');
  assert.deepEqual(tia.v.others.filter((f: any) => f.type === 'note').map((f: any) => f.value), ['Notices go to the address below.']);
  assert.equal(tia.v.fields.find((f: any) => f.type === 'text').label, 'Email for notices');
  const bulk = await s.post('/bulk', { template_id: tpl.data.envelope.id, rows: [{ Tenant: { name: 'Bo Bulk', email: 'bo@notetext.example' } }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  const be = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='bo@notetext.example'").id;
  assert.deepEqual(values(be), [null, null, null, 'Notices go to the address below.']);
  const bo = await signer(be, 'bo@notetext.example');
  assert.deepEqual(bo.v.others.filter((f: any) => f.type === 'note').map((f: any) => f.value), ['Notices go to the address below.']);
});

test('a box kept with only spaces from before this rule is still shown to nobody', async () => {
  const s = await person('Olga Old', 'olga@notetext.example');
  const file = await upload(s, 1);
  const r = await s.post('/envelopes', {
    subject: 'Old', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r1', role: 'signer', name: 'Ana Signer', email: 'ana3@notetext.example' }],
    fields: [box('n', null, 'note', 0.1, { value: 'x' }), box('sig', 'r1', 'signature', 0.8, { h: 0.06, required: true })], send: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  db.run("UPDATE fields SET value='   ' WHERE envelope_id=? AND type='note'", r.data.envelope.id);
  const a = await signer(r.data.envelope.id, 'ana3@notetext.example');
  assert.deepEqual(a.v.others.filter((f: any) => f.type === 'note'), []);
});
