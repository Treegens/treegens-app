// A form as questions (ds-web-forms): the open role's fields become questions in reading order, with their checks
// and "Only show when" rules; answers are kept for one browser for a day; the person sees the whole document with the
// answers in it; nothing is made and nothing is used until they go on to sign.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, signUp, upload, Client, PNG, type Server } from './helpers.ts';
import { questionsOf, firstProblem, shownQuestions, answersToKeep, choose } from '../src/lib/webforms.ts';

let srv: Server;
let owner: Client;
let tplId = '';
let slug = '';
let n = 0;
const visitor = () => Object.assign(new Client(), { ip: `10.91.0.${++n}` });
const box = (id: string, type: string, y: number, over: any = {}) => ({ id, document_id: 'd', recipient_id: 'r', type, page: 0, x: 0.1, y, w: 0.3, h: 0.03, ...over });

before(async () => {
  srv = await boot();
  owner = await signUp('Olga Owner', 'olga@webforms.example', '10.91.1.1');
  const file = await upload(owner, 2);
  const tpl = await owner.post('/envelopes', {
    kind: 'template', subject: 'Volunteer sign-up', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }],
    fields: [
      box('sig', 'signature', 0.85, { h: 0.06 }),
      // Out of reading order on purpose: the questions come in the order they are read on the pages.
      box('phone', 'text', 0.5, { page: 1, label: 'Phone', validation: { kind: 'phone' } }),
      box('zip', 'text', 0.3, { label: 'Postcode', validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' } }),
      box('first', 'text', 0.1, { label: 'Your town' }),
      box('minor', 'checkbox', 0.4, { label: 'I am under 18', required: false, w: 0.03, h: 0.03 }),
      box('guardian', 'text', 0.45, { label: 'Name of a parent or guardian', show_when: { field: 'minor', is: 'checked' } }),
      box('tA', 'radio', 0.6, { label: 'Mornings', group_name: 'When can you help', w: 0.03, h: 0.03 }),
      box('tB', 'radio', 0.6, { x: 0.5, label: 'Evenings', group_name: 'When can you help', w: 0.03, h: 0.03 }),
      box('size', 'dropdown', 0.7, { label: 'T-shirt size', options: ['S', 'M', 'L'] }),
    ],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  tplId = tpl.data.envelope.id;
  const pf = await owner.post('/powerforms', { template_id: tplId, name: 'Join the planting team' });
  assert.equal(pf.status, 200, JSON.stringify(pf.data));
  slug = srv.db.get('SELECT slug FROM powerforms WHERE id=?', pf.data.id).slug;
});

const label = (q: any) => q.label;
const fieldId = (label: string) => srv.db.get('SELECT id FROM fields WHERE envelope_id=? AND (label=? OR group_name=?)', tplId, label, label).id;
const envelopes = () => srv.db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='envelope' AND powerform_id IS NOT NULL").n;
const emails = () => srv.db.get('SELECT COUNT(*) n FROM emails').n;

function goodAnswers() {
  return { [fieldId('Your town')]: 'Mombasa', [fieldId('Postcode')]: '80100', [fieldId('I am under 18')]: '', [fieldId('Mornings')]: '1', [fieldId('Evenings')]: '', [fieldId('T-shirt size')]: 'M', [fieldId('Phone')]: '+254 700 000000' };
}

test('the fields become questions in reading order, with sections, help and choices; signatures stay on the signing page', async () => {
  const form = (await visitor().get(`/public/powerforms/${slug}`)).data;
  assert.deepEqual(form.questions.map(label), ['Your town', 'Postcode', 'I am under 18', 'Name of a parent or guardian', 'When can you help', 'T-shirt size', 'Phone']);
  const by = (l: string) => form.questions.find((q: any) => q.label === l);
  assert.equal(by('Your town').section, 'Page 1');
  assert.equal(by('Phone').section, 'Page 2', 'a new section where the page changes');
  assert.equal(by('Phone').help, 'A phone number');
  assert.deepEqual(by('When can you help').options.map((o: any) => o.label), ['Mornings', 'Evenings']);
  assert.deepEqual(by('T-shirt size').options.map((o: any) => o.value), ['S', 'M', 'L']);
  assert.ok(!form.questions.some((q: any) => q.kind === 'signature'));
  // The page also gets what it needs to check: the fields, never another person's typed answers.
  assert.ok(form.fields.every((f: any) => f.recipient_id === form.me || f.recipient_id === null));
});

test('checks and conditions: the same rules on the page and on the server', async () => {
  const form = (await visitor().get(`/public/powerforms/${slug}`)).data;
  const qs = form.questions;
  const a: any = goodAnswers();
  assert.equal(firstProblem(qs, form.fields, a, form.date_format), null);
  // The guardian question is shown only when the box is ticked, and then it is required.
  assert.equal(shownQuestions(qs, form.fields, a).some((q: any) => q.label === 'Name of a parent or guardian'), false);
  const minor = { ...a, [fieldId('I am under 18')]: '1' };
  assert.equal(firstProblem(qs, form.fields, minor)!.question.label, 'Name of a parent or guardian');
  assert.equal(firstProblem(qs, form.fields, minor)!.text, 'Answer this to go on.');
  // A hidden question's answer is not kept.
  assert.equal(fieldId('Name of a parent or guardian') in answersToKeep(qs, form.fields, { ...a, [fieldId('Name of a parent or guardian')]: 'Someone' }), false);
  // The sender's own pattern and message.
  assert.equal(firstProblem(qs, form.fields, { ...a, [fieldId('Postcode')]: '12a' })!.text, 'Type 5 digits, like 12345.');
  // One choice of a group.
  const both = choose(qs.find((q: any) => q.kind === 'choice'), a, fieldId('Evenings'));
  assert.equal(both[fieldId('Mornings')], '');
  assert.equal(both[fieldId('Evenings')], '1');
  // A dropdown takes only its own choices.
  assert.equal(firstProblem(qs, form.fields, { ...a, [fieldId('T-shirt size')]: 'XXL' })!.text, 'Choose one of the choices in the list.');

  // The server says the same, and makes nothing.
  const v = visitor();
  const before = envelopes();
  const refused = await v.post(`/public/powerforms/${slug}/start`, { name: 'Vic Visitor', email: 'vic@webforms.example', answers: { ...a, [fieldId('Postcode')]: '12a' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'Postcode: Type 5 digits, like 12345.');
  const missing = await v.post(`/public/powerforms/${slug}/start`, { name: 'Vic Visitor', email: 'vic@webforms.example', answers: minor });
  assert.equal(missing.data.error, 'Name of a parent or guardian: Answer this to go on.');
  assert.equal(envelopes(), before);
});

test('answers are kept for this browser only, for a day, and an abandoned form makes no envelope and sends nothing', async () => {
  const v = visitor();
  const [env0, mail0] = [envelopes(), emails()];
  const saved = await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Ana Answer', email: 'ana@webforms.example', answers: { [fieldId('Your town')]: 'Kilifi', notafield: 'x', [fieldId('Postcode')]: '8' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok(Date.parse(saved.data.kept_until) - Date.now() > 23 * 3600_000);
  const back = (await v.get(`/public/powerforms/${slug}/draft`)).data.draft;
  assert.equal(back.name, 'Ana Answer');
  assert.deepEqual(back.answers, { [fieldId('Your town')]: 'Kilifi', [fieldId('Postcode')]: '8' }, 'only answers to its own questions are kept');
  // Another browser, even on the same connection, sees nothing; a forged cookie sees nothing.
  const other = Object.assign(new Client(), { ip: v.ip });
  assert.equal((await other.get(`/public/powerforms/${slug}/draft`)).data.draft, null);
  const forged = Object.assign(new Client(), { ip: '10.91.9.9' });
  const [k, val] = Object.entries(v.cookies).find(([name]) => name.startsWith('ts_wf_'))!;
  forged.cookies[k] = `${val.split('.')[0]}.deadbeef`;
  assert.equal((await forged.get(`/public/powerforms/${slug}/draft`)).data.draft, null);
  // Nothing was made and nobody was emailed.
  assert.equal(envelopes(), env0);
  assert.equal(emails(), mail0);
  // After a day it is gone.
  srv.db.run("UPDATE form_drafts SET updated_at='2020-01-01T00:00:00.000Z'");
  assert.equal((await v.get(`/public/powerforms/${slug}/draft`)).data.draft, null);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM form_drafts').n, 0);
});

test('the person sees the whole document with their answers in it before anything is made', async () => {
  const v = visitor();
  const saved = await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Rui Review', email: 'rui@webforms.example', answers: goodAnswers() });
  const before = envelopes();
  const pdf = await v.get(`/public/powerforms/${slug}/review?k=${saved.data.review}`);
  assert.equal(pdf.status, 200);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf.data);
  assert.equal(doc.getPageCount(), 2, 'every page of the document, and no certificate');
  // The answers are drawn on the page (pdf-lib draws text with a subset font, so look for the operator count growing).
  const blank = Object.assign(new Client(), { ip: '10.91.8.8' });
  const none = await blank.call('PUT', `/public/powerforms/${slug}/draft`, { answers: {} });
  const empty = await blank.get(`/public/powerforms/${slug}/review?k=${none.data.review}`);
  assert.ok(pdf.data.length > empty.data.length, 'the copy with answers carries more than the empty one');
  assert.equal(envelopes(), before, 'looking at the document makes nothing');
});

test('only signing makes the envelope: the answers are in it as the person\'s own, and the signature is used at Finish', async () => {
  const v = visitor();
  const answers = goodAnswers();
  await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Sia Signer', email: 'sia@webforms.example', answers });
  const before = envelopes();
  const start = await v.post(`/public/powerforms/${slug}/start`, { name: 'Sia Signer', email: 'sia@webforms.example', answers });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.equal(envelopes(), before + 1);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM form_drafts WHERE ip=?', v.ip).n, 0, 'the kept answers went with the start');
  const tok = start.data.url.split('/sign/')[1];
  await v.post(`/sign/${tok}/consent`);
  const view = (await v.get(`/sign/${tok}`)).data;
  const val = (l: string) => view.fields.find((f: any) => f.label === l)?.value;
  assert.equal(val('Your town'), 'Mombasa');
  assert.equal(val('Postcode'), '80100');
  assert.equal(val('T-shirt size'), 'M');
  assert.equal(val('Mornings'), '1');
  const eid = srv.db.get('SELECT envelope_id e FROM recipients WHERE token=?', tok).e;
  assert.match(srv.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Form answered'", eid).detail, /answered the form's questions first \(\d+ fields\)/);
  const sig = view.fields.find((f: any) => f.type === 'signature').id;
  const done = await v.post(`/sign/${tok}/complete`, { values: { [sig]: '1' }, signature_png: PNG });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.envelope_status, 'completed');
});

test('limits and abuse rules: the same as the form, a closed form keeps nothing, and a connection keeps a bounded number', async () => {
  // A paused form keeps nothing and shows nothing.
  const pid = srv.db.get('SELECT id FROM powerforms WHERE slug=?', slug).id;
  await owner.call('PATCH', `/powerforms/${pid}`, { active: false });
  const v = visitor();
  const paused = await v.call('PUT', `/public/powerforms/${slug}/draft`, { answers: {} });
  assert.equal(paused.status, 404);
  // What happened, then what to do.
  assert.match(paused.data.error, /^[^.]+\. Ask whoever gave you the link/);
  assert.equal((await v.get(`/public/powerforms/${slug}/review?k=x`)).status, 404);
  await owner.call('PATCH', `/powerforms/${pid}`, { active: true });
  // Too long is refused with what to do.
  const long = await v.call('PUT', `/public/powerforms/${slug}/draft`, { answers: Object.fromEntries(srv.db.all('SELECT id FROM fields WHERE envelope_id=?', tplId).map((f: any) => [f.id, '"'.repeat(4000)])) });
  assert.equal(long.status, 413);
  assert.equal(long.data.error, 'These answers are longer than a form keeps. Make the longest ones shorter, then go on.');
  // One connection keeps at most 20 sets; the oldest goes, nobody is refused.
  const shared = '10.91.7.7';
  for (let i = 0; i < 25; i++) assert.equal((await Object.assign(new Client(), { ip: shared }).call('PUT', `/public/powerforms/${slug}/draft`, { answers: {} })).status, 200);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM form_drafts WHERE ip=?', shared).n, 20);
  // The fake-notice filter reads the answers, because the address typed is shown them under the form's name.
  const scam = await visitor().post(`/public/powerforms/${slug}/start`, { name: 'Sam Scam', email: 'sam@webforms.example', answers: { ...goodAnswers(), [fieldId('Your town')]: 'Your PayPal account is suspended, pay $50 to +1 800 555 0100 now' } });
  assert.equal(scam.status, 422, JSON.stringify(scam.data));
  assert.match(scam.data.error, /Nothing was sent\.$/);
});

test('a shared-device form never hands answers to the next person, and answers for fields that are not questions are ignored', async () => {
  const pid = srv.db.get('SELECT id FROM powerforms WHERE slug=?', slug).id;
  await owner.call('PATCH', `/powerforms/${pid}`, { shared_device: true });
  const tablet = visitor();
  assert.equal((await tablet.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'First Person', email: 'first@webforms.example', answers: goodAnswers() })).status, 200);
  assert.equal((await tablet.get(`/public/powerforms/${slug}/draft`)).data.draft, null, 'the next person at the tablet sees nothing');
  assert.equal((await tablet.call('DELETE', `/public/powerforms/${slug}/draft`)).status, 200);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM form_drafts WHERE ip=?', tablet.ip).n, 0);
  await owner.call('PATCH', `/powerforms/${pid}`, { shared_device: false });
  // The signature, or a field the template filled in, cannot be set through the answers.
  const v = visitor();
  const sigId = srv.db.get("SELECT id FROM fields WHERE envelope_id=? AND type='signature'", tplId).id;
  const start = await v.post(`/public/powerforms/${slug}/start`, { name: 'Ivy Ignored', email: 'ivy@webforms.example', answers: { ...goodAnswers(), [sigId]: '1' } });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const eid = srv.db.get('SELECT envelope_id e FROM recipients WHERE token=?', start.data.url.split('/sign/')[1]).e;
  assert.equal(srv.db.get("SELECT value FROM fields WHERE envelope_id=? AND type='signature'", eid).value, null);
});

test('a form with no questions works as before, and its QR code carries the public link', async () => {
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'Plain waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Guest' }], fields: [box('s', 'signature', 0.5, { h: 0.06 })] })).data.envelope;
  const pf = await owner.post('/powerforms', { template_id: tpl.id, name: 'Plain waiver' });
  const row = (await owner.get('/powerforms')).data.powerforms.find((p: any) => p.id === pf.data.id);
  assert.equal(row.url, `http://test.local/f/${row.slug}`);
  const { qrEncode } = await import('../src/lib/qr.ts');
  assert.ok(qrEncode(row.url).size >= 21, 'the link fits a QR code');
  const form = (await visitor().get(`/public/powerforms/${row.slug}`)).data;
  assert.deepEqual(form.questions, []);
  const start = await visitor().post(`/public/powerforms/${row.slug}/start`, { name: 'Gus Guest', email: 'gus@webforms.example' });
  assert.match(start.data.url, /\/sign\//);
});

test('the lib reads a template the same way without the server', () => {
  const qs = questionsOf([
    { id: 'b', recipient_id: 'r', type: 'text', page: 0, x: 0.5, y: 0.2, document_id: 'd2', label: 'B' },
    { id: 'a', recipient_id: 'r', type: 'text', page: 3, x: 0.5, y: 0.9, document_id: 'd1', label: 'A' },
    { id: 'z', recipient_id: 'other', type: 'text', page: 0, x: 0, y: 0, document_id: 'd1', label: 'Not mine' },
    { id: 'c', recipient_id: 'r', type: 'number', page: 0, x: 0, y: 0, document_id: 'd1', label: 'Worked out', formula: '{a}' },
  ], [{ id: 'd1', name: 'Waiver', position: 0 }, { id: 'd2', name: 'Photo consent', position: 1 }], 'r');
  assert.deepEqual(qs.map((q) => [q.label, q.section]), [['A', 'Waiver, page 4'], ['B', 'Photo consent, page 1']]);
});

// Repairs after review (repair-ds-web-forms).

test('a second start in the same browser with changed answers signs the changed answers, and leaves no kept answers', async () => {
  const v = visitor();
  const who = { name: 'Tia Typo', email: 'tia@webforms.example' };
  const first = await v.post(`/public/powerforms/${slug}/start`, { ...who, answers: { ...goodAnswers(), [fieldId('Your town')]: 'Old town' } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  // She goes back to the form, fixes the town, checks the document and goes on again.
  await v.call('PUT', `/public/powerforms/${slug}/draft`, { ...who, answers: { ...goodAnswers(), [fieldId('Your town')]: 'New town' } });
  const again = await v.post(`/public/powerforms/${slug}/start`, { ...who, answers: { ...goodAnswers(), [fieldId('Your town')]: 'New town', [fieldId('Mornings')]: '', [fieldId('Evenings')]: '1' } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.url, first.data.url, 'the same start, not a second envelope');
  const tok = again.data.url.split('/sign/')[1];
  await v.post(`/sign/${tok}/consent`);
  const view = (await v.get(`/sign/${tok}`)).data;
  const val = (l: string) => view.fields.find((f: any) => f.label === l)?.value;
  assert.equal(val('Your town'), 'New town');
  assert.ok(!val('Mornings'), 'an answer taken back is taken out of the document too');
  assert.equal(val('Evenings'), '1');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM form_drafts WHERE ip=?', v.ip).n, 0, 'the kept answers went with the start');
  const eid = srv.db.get('SELECT envelope_id e FROM recipients WHERE token=?', tok).e;
  assert.ok(srv.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Form answered again'", eid));
  // Answers that break a rule are refused on the second start too, and change nothing.
  const bad = await v.post(`/public/powerforms/${slug}/start`, { ...who, answers: { ...goodAnswers(), [fieldId('Postcode')]: '1' } });
  assert.equal(bad.status, 400);
  assert.equal((await v.get(`/sign/${tok}`)).data.fields.find((f: any) => f.label === 'Your town').value, 'New town');
  // The old API, without answers, picks the start up unchanged.
  const plain = await v.post(`/public/powerforms/${slug}/start`, who);
  assert.equal(plain.data.resumed, true);
  assert.equal((await v.get(`/sign/${tok}`)).data.fields.find((f: any) => f.label === 'Your town').value, 'New town');
});

test('the document with answers opens only with the key of the latest save of this browser', async () => {
  const v = visitor();
  const one = await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Kai Key', email: 'kai@webforms.example', answers: goodAnswers() });
  assert.equal((await v.get(`/public/powerforms/${slug}/review?k=${one.data.review}`)).status, 200);
  // No key, a made-up key, or another browser's key: nothing is drawn, not even the bare template.
  const noKey = await v.get(`/public/powerforms/${slug}/review`);
  assert.equal(noKey.status, 409);
  assert.match(noKey.data.error, /Go back to the questions and press Next on the last one again\.$/);
  assert.equal((await v.get(`/public/powerforms/${slug}/review?k=deadbeef`)).status, 409);
  assert.equal((await visitor().get(`/public/powerforms/${slug}/review?k=${one.data.review}`)).status, 409);
  // A later save (another window) makes the first key stale, so the document shown is always the one saved last.
  await new Promise((r) => setTimeout(r, 5));
  const two = await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Kai Key', email: 'kai@webforms.example', answers: { ...goodAnswers(), [fieldId('Your town')]: 'Elsewhere' } });
  assert.notEqual(two.data.review, one.data.review);
  assert.equal((await v.get(`/public/powerforms/${slug}/review?k=${one.data.review}`)).status, 409);
  assert.equal((await v.get(`/public/powerforms/${slug}/review?k=${two.data.review}`)).status, 200);
});

test('on a shared device the next person at the tablet cannot open the person before\'s document, and saves have a larger allowance', async () => {
  const pid = srv.db.get('SELECT id FROM powerforms WHERE slug=?', slug).id;
  await owner.call('PATCH', `/powerforms/${pid}`, { shared_device: true });
  try {
    const tablet = visitor();
    const first = await tablet.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'First Person', email: 'first@webforms.example', answers: goodAnswers() });
    assert.equal(first.status, 200);
    // The next person has the same browser cookie but not the page that saved: nothing is drawn.
    assert.equal((await tablet.get(`/public/powerforms/${slug}/review`)).status, 409);
    // A front desk on one connection: more than 600 saves an hour still go through on a shared-device form.
    const desk = '10.91.6.6';
    for (let i = 0; i < 605; i++) {
      const r = await Object.assign(new Client(), { ip: desk }).call('PUT', `/public/powerforms/${slug}/draft`, { answers: {} });
      assert.equal(r.status, 200, `save ${i + 1}: ${JSON.stringify(r.data)}`);
    }
  } finally {
    await owner.call('PATCH', `/powerforms/${pid}`, { shared_device: false });
  }
});

test('fields with no label are not asked as questions: the form opens as the document, and the Forms list says why', async () => {
  const file = await upload(owner, 1);
  const tpl = (await owner.post('/envelopes', { kind: 'template', subject: 'No labels', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Guest' }],
    fields: [box('s', 'signature', 0.8, { h: 0.06 }), box('a', 'text', 0.1, { label: 'Your town' }), box('b', 'text', 0.2), box('c', 'checkbox', 0.3, { w: 0.03, h: 0.03 })] })).data.envelope;
  const pf = await owner.post('/powerforms', { template_id: tpl.id, name: 'No labels' });
  const row = (await owner.get('/powerforms')).data.powerforms.find((p: any) => p.id === pf.data.id);
  assert.equal(row.questions, 0);
  assert.equal(row.unlabelled, 2);
  assert.deepEqual((await visitor().get(`/public/powerforms/${row.slug}`)).data.questions, []);
  // A labelled form says none.
  assert.equal((await owner.get('/powerforms')).data.powerforms.find((p: any) => p.slug === slug).unlabelled, 0);
  // Radio buttons need a group name and their own words.
  const radio = (over: any) => ({ id: 'x', recipient_id: 'r', type: 'radio', page: 0, x: 0, y: 0, document_id: 'd', label: 'Yes', group_name: 'Come?', ...over });
  const { unlabelledCount } = await import('../src/lib/webforms.ts');
  assert.equal(unlabelledCount([radio({})], 'r'), 0);
  assert.equal(unlabelledCount([radio({ group_name: '' })], 'r'), 1);
  assert.equal(unlabelledCount([radio({ label: ' ' })], 'r'), 1);
  assert.deepEqual(questionsOf([radio({ group_name: '' })], [{ id: 'd', name: 'X', position: 0 }], 'r'), []);
});
