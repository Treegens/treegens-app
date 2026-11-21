// Field checks: formats with the sender's own message, a character limit, number ranges, decimals and currency,
// tick-box group rules, hiding what is typed from the others, boxes of fixed size. The shared rules
// (src/lib/fieldrules.ts), the signing page's logic (src/components/sign/fields.ts), and the server, which checks it
// all again when a signer saves and finishes; templates, bulk sends and the API carry it, old and new forms.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, tokenFor, PNG, type Server } from './helpers.ts';
import { checksSendProblem, groupRuleProblem, groupRuleNote, patternProblem, valueProblem, groupProblem, checksOf, fitChars, limitOf, tidyChecks, storedChecks, isDateIn, currencySign, printedAmount, shownToOthers, DOTS, HIDDEN_IN_COPY } from '../src/lib/fieldrules.ts';
import { problemWith, finishProblem, amountHint, lengthHint, boxRuleHint } from '../src/components/sign/fields.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.91.${++n}.7`);

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

// ---- The shared rules -----------------------------------------------------------------------------------------

test('a pattern of the sender\'s own is read by our own reader first: long, unreadable, back-references and repeats inside repeats are refused, with why', () => {
  for (const ok of ['[0-9]{5}', '[A-Z]{2}\\d{6}', '(ab|cd)+', '(?:\\d+)?', '[(]+', '\\p{L}+', '(?:a|b)*c']) assert.equal(patternProblem(ok), '', ok);
  assert.match(patternProblem('(a+)+'), /cannot repeat something that already repeats/);
  assert.match(patternProblem('(a*){5}'), /already repeats/);
  assert.match(patternProblem('(a?){20}'), /already repeats/, 'the classic slow pattern');
  assert.match(patternProblem('((x|y)+z)*'), /already repeats/);
  assert.match(patternProblem('(x)\\1'), /refer back/);
  assert.match(patternProblem('(?<n>a)\\k<n>'), /refer back/);
  assert.match(patternProblem('a{1001}'), /at most 1,000 times/);
  assert.match(patternProblem('[0-9'), /cannot be read/);
  assert.match(patternProblem('x'.repeat(201)), /at most 200 characters/);
  assert.match(patternProblem(''), /Write the pattern/);
  // A pattern that was saved before it could be read first is never run: it says nothing rather than hang.
  const slow = { type: 'text', validation: '(a+)+$' };
  const t = Date.now();
  assert.equal(problemWith(slow, 'a'.repeat(40) + '!'), '');
  assert.ok(Date.now() - t < 200);
});

test('formats: email, phone, letters only, a date in the envelope\'s format, and my own pattern with my own message', () => {
  const f = (validation: any) => ({ type: 'text', validation });
  assert.equal(valueProblem(f({ kind: 'email' }), 'a@b.org'), '');
  assert.match(valueProblem(f({ kind: 'email' }), 'nope'), /like name@example.org/);
  assert.match(valueProblem(f({ kind: 'phone' }), '12'), /area code/);
  assert.equal(valueProblem(f({ kind: 'letters' }), "Anne-Marie O'Neil"), '');
  assert.equal(valueProblem(f({ kind: 'letters' }), 'Ådne Øyvind'), '', 'letters of every language');
  assert.match(valueProblem(f({ kind: 'letters' }), 'R2D2'), /letters only/i);
  assert.equal(valueProblem(f({ kind: 'date' }), '20/03/2027', 'DD/MM/YYYY'), '');
  assert.match(valueProblem(f({ kind: 'date' }), '31/02/2027', 'DD/MM/YYYY'), /like 20\/03\/2027/);
  assert.match(valueProblem(f({ kind: 'date' }), '03/20/2027', 'DD/MM/YYYY'), /like 20\/03\/2027/);
  assert.ok(isDateIn('Mar 20, 2027', 'MMM D, YYYY') && isDateIn('20 Mar 2027', 'D MMM YYYY') && isDateIn('2027-03-20', 'YYYY-MM-DD'));
  const zip = f({ kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' });
  assert.equal(valueProblem(zip, '12345'), '');
  assert.equal(valueProblem(zip, '1234'), 'Type 5 digits, like 12345.', 'the sender\'s own words, and never the pattern');
  // The signing page says the same, from the form the server stores (JSON) and from an object.
  assert.equal(problemWith({ type: 'text', validation: JSON.stringify(zip.validation) }, '12a45'), 'Type 5 digits, like 12345.');
  assert.equal(problemWith(zip, '12345'), '');
  // The old words keep working, also on the signing page.
  assert.match(problemWith({ type: 'text', validation: 'email' }, 'x'), /email address/);
  assert.match(problemWith({ type: 'text', validation: '[0-9]{3}' }, 'abc'), /format the sender asked for/);
  assert.deepEqual(checksOf('phone'), { kind: 'phone' });
  assert.deepEqual(checksOf('[0-9]{3}'), { kind: 'pattern', pattern: '[0-9]{3}' });
});

test('numbers: smallest, largest, decimal places and a currency shown with its sign, kept as typed', () => {
  const amount = { type: 'number', validation: { min: 0, max: 1000, decimals: 2, currency: 'EUR' } };
  assert.equal(valueProblem(amount, '999,99'), '');
  assert.equal(valueProblem(amount, '€12.50'), '');
  assert.match(valueProblem(amount, '1.234,56'), /from 0 to 1,000/);
  assert.match(valueProblem(amount, '-1'), /from 0 to 1,000/);
  assert.match(valueProblem(amount, '12,345'), /from 0 to 1,000/, '12,345 alone reads as twelve thousand');
  assert.match(valueProblem({ type: 'number', validation: { decimals: 2 } }, '1.5,5'), /does not read as a number/);
  assert.match(valueProblem({ type: 'number', validation: { decimals: 1 } }, '2.5555'), /at most 1 decimal place/);
  assert.match(valueProblem({ type: 'number', validation: { decimals: 0 } }, '12.5'), /whole number/);
  assert.match(valueProblem(amount, '$5'), /in EUR/);
  assert.equal(currencySign('EUR'), '€');
  assert.equal(printedAmount('12.50', checksOf(amount.validation)), '€12.50');
  assert.equal(printedAmount('€12.50', checksOf(amount.validation)), '€12.50', 'never two signs');
  assert.match(amountHint(amount), /An amount in EUR \(€\), from 0 to 1,000, with at most 2 decimal places/);
  assert.equal(amountHint({ type: 'number' }), '', 'a number field with nothing set says what it always said');
  assert.match(tidyChecks('number', { currency: 'XYZ' }).problem, /not a currency code we know/);
  assert.match(tidyChecks('number', { min: 5, max: 1 }).problem, /Swap them/);
  assert.match(tidyChecks('number', { decimals: 11 }).problem, /0 to 10/);
});

test('character limit, fixed size, and tick-box groups with at least, at most and exactly', () => {
  assert.match(tidyChecks('text', { max_length: 0 }).problem, /1 to 4,000/);
  assert.match(tidyChecks('text', { max_length: 4001 }).problem, /1 to 4,000/);
  const short = { type: 'text', validation: { max_length: 5 } };
  assert.equal(limitOf(short), 5);
  assert.match(valueProblem(short, 'abcdef'), /at most 5 characters, and this has 6/);
  assert.equal(lengthHint(short, 'abc'), '3 of 5 characters.');
  assert.match(lengthHint(short, 'abcde'), /That is all this field takes/, 'typing that stops is said, never a mystery');
  assert.equal(lengthHint({ type: 'text' }, 'abc'), '');
  assert.equal(limitOf({ type: 'text', validation: { kind: 'pattern', pattern: 'a+', message: 'm' } }), 100, 'a field with a pattern takes at most 100 characters');
  // A one-line box a quarter of a Letter page wide: about 37 characters at 7 point.
  const fits = fitChars(0.25 * 612, 0.03 * 792);
  assert.ok(fits > 25 && fits < 45, String(fits));
  const fixed = tidyChecks('text', { fixed: true }, { w: 0.25, h: 0.03 }, { w: 612, h: 792 }).checks;
  assert.equal(fixed.fit_chars, fits);
  assert.match(valueProblem({ type: 'text', validation: fixed }, 'x'.repeat(fits + 1)), /fixed size/);
  // Groups.
  const boxes = (rule: string, count: number, message?: string) => ['a', 'b', 'c'].map((id) => ({ id, type: 'checkbox', group_name: 'Extras', validation: { group_rule: rule, group_count: count, ...(message ? { message } : {}) } }));
  const v = (...on: string[]) => Object.fromEntries(on.map((k) => [k, '1']));
  assert.equal(groupProblem(boxes('at_least', 2), v('a', 'b')), null);
  assert.equal(groupProblem(boxes('at_least', 2), v('a'))?.text, 'Tick at least 2 boxes of these.');
  assert.equal(groupProblem(boxes('at_least', 2), v()), null, 'an optional group nobody ticked in');
  assert.equal(groupProblem(boxes('at_most', 1), v('a', 'c'))?.text, 'Tick at most 1 box of these.');
  assert.equal(groupProblem(boxes('exactly', 2, 'Pick two extras.'), v('a', 'b', 'c'))?.text, 'Pick two extras.');
  assert.equal(groupProblem(boxes('exactly', 2), v('b', 'c')), null);
  assert.equal(groupProblem(boxes('at_least', 2), v('a'), new Set(['b', 'c'])), null, 'boxes that are not shown do not count');
  const stop = finishProblem(boxes('at_most', 1), v('a', 'b'));
  assert.equal(stop?.field.id, 'a');
  assert.match(tidyChecks('checkbox', { group_rule: 'at_least', group_count: 101 }).problem, /0 to 100/);
  assert.equal(storedChecks({ kind: 'email' }), 'email', 'the old word where it says it all');
});

test('hidden values: dots for the others while it is out, as typed once completed, or the words when hidden in the copy too', () => {
  const f = { type: 'text', validation: { hide: true } };
  assert.equal(shownToOthers(f, 'secret', false), DOTS);
  assert.equal(shownToOthers(f, 'secret', true), 'secret');
  assert.equal(shownToOthers({ type: 'text', validation: { hide: true, hide_in_copy: true } }, 'secret', true), HIDDEN_IN_COPY);
  assert.equal(shownToOthers({ type: 'text' }, 'plain', false), 'plain');
  assert.equal(tidyChecks('text', { hide_in_copy: true }).checks.hide_in_copy, undefined, 'hide in the copy only with hide');
});

// ---- The server ---------------------------------------------------------------------------------------------------

async function envelope(s: Client, fields: any[], extra: any = {}) {
  const file = await upload(s, 1);
  return s.post('/envelopes', {
    subject: 'Checks', documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada One', email: `ada${n}@checks.example`, routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Two', email: `ben${n}@checks.example`, routing_order: 2 },
    ],
    ordered: true,
    fields: [box('s1', 'r1', 'signature', 0.85, { required: true, h: 0.06 }), box('s2', 'r2', 'signature', 0.85, { x: 0.5, required: true, h: 0.06 }), ...fields],
    ...extra,
  });
}
async function signer(eid: string, email: string) {
  const c = new Client();
  c.ip = `10.92.${++n}.1`;
  const tok = tokenFor(eid, email);
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  const marks = Object.fromEntries(v.fields.filter((f: any) => f.type === 'signature').map((f: any) => [f.id, '1']));
  return { c, tok, v, done: (values: Record<string, string>) => c.post(`/sign/${tok}/complete`, { values: { ...marks, ...values }, signature_png: PNG, initials_png: PNG }) };
}
const fieldRow = (eid: string, label: string) => db.get('SELECT * FROM fields WHERE envelope_id=? AND label=?', eid, label);

test('the sender\'s checks are saved, given back as an object, and refused out loud when they cannot work', async () => {
  const s = await person('Sue Sender', 'sue@checks.example');
  const r = await envelope(s, [
    box('zip', 'r1', 'text', 0.1, { label: 'Postcode', validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' } }),
    box('mail', 'r1', 'text', 0.15, { label: 'Email', validation: 'email' }),
    box('amt', 'r1', 'number', 0.2, { label: 'Amount', validation: { kind: 'none', min: 1, max: 500, currency: 'eur' } }),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await s.get(`/envelopes/${r.data.envelope.id}`)).data.envelope;
  const by = (l: string) => e.fields.find((f: any) => f.label === l);
  assert.deepEqual(by('Postcode').checks, { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' });
  assert.equal(by('Email').validation, 'email', 'the old word is kept as it was sent');
  assert.deepEqual(by('Amount').checks, { min: 1, max: 500, currency: 'EUR' });
  // A draft is saved as the sender works, also with a pattern half typed. Sending it is refused, with why.
  const half = await envelope(s, [box('p', 'r1', 'text', 0.1, { label: 'Code', validation: { kind: 'pattern', pattern: '(a+)+', message: 'Letters a' } })]);
  assert.equal(half.status, 200, JSON.stringify(half.data));
  const sent = await s.post(`/envelopes/${half.data.envelope.id}/send`);
  assert.equal(sent.status, 400);
  assert.match(sent.data.error, /Code.*already repeats.*More options, then send again/);
  const noWords = await envelope(s, [box('p', 'r1', 'text', 0.1, { label: 'Code', validation: { kind: 'pattern', pattern: '[A-Z]{3}' } })]);
  assert.match((await s.post(`/envelopes/${noWords.data.envelope.id}/send`)).data.error, /Write the message people see/);
  const legacySlow = await envelope(s, [box('p', 'r1', 'text', 0.1, { label: 'Old', validation: '(x+)+y' })]);
  assert.match((await s.post(`/envelopes/${legacySlow.data.envelope.id}/send`)).data.error, /already repeats/, 'the old string form is read first too');
  // Sent straight away through the API: refused before anything goes out.
  for (const [validation, why] of [[{ max_length: 9000 }, /1 to 4,000/], [{ kind: 'shout' }, /does not exist/], [[1, 2], /is a word/]] as const) {
    const bad = await envelope(s, [box('t', 'r1', 'text', 0.1, { label: 'T', validation })], { send: true });
    assert.equal(bad.status, 400, JSON.stringify(bad.data));
    assert.match(bad.data.error, why);
  }
  const cur = await envelope(s, [box('t', 'r1', 'number', 0.1, { label: 'T', validation: { currency: 'ABC' } })], { send: true });
  assert.match(cur.data.error, /not a currency code we know/);
});

test('a signer is held to it on save and at Finish: limit, formats, range, currency, decimals and group rules; the number is kept too', async () => {
  const s = await person('Sam Sender', 'sam@checks.example');
  const r = await envelope(s, [
    box('name', 'r1', 'text', 0.1, { label: 'Name', validation: { kind: 'letters', max_length: 10 } }),
    box('when', 'r1', 'text', 0.15, { label: 'Start', validation: { kind: 'date' } }),
    box('zip', 'r1', 'text', 0.2, { label: 'Postcode', validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' } }),
    box('amt', 'r1', 'number', 0.25, { label: 'Amount', validation: { min: 1, max: 500, decimals: 2, currency: 'EUR' } }),
    box('x1', 'r1', 'checkbox', 0.3, { label: 'Tea', group_name: 'Drinks', validation: { group_rule: 'at_least', group_count: 2 }, required: true }),
    box('x2', 'r1', 'checkbox', 0.35, { label: 'Coffee', group_name: 'Drinks', validation: { group_rule: 'at_least', group_count: 2 } }),
    box('x3', 'r1', 'checkbox', 0.4, { label: 'Juice', group_name: 'Drinks', validation: { group_rule: 'at_least', group_count: 2 } }),
  ], { send: true, date_format: 'DD/MM/YYYY' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const a = await signer(eid, db.get('SELECT email FROM recipients WHERE envelope_id=? AND routing_order=1', eid).email);
  // The signing page gets the checks, so it can say what is wrong while the person is at the field.
  assert.equal(a.v.fields.find((f: any) => f.id === fieldRow(eid, 'Name').id).checks.max_length, 10);
  const id = (l: string) => fieldRow(eid, l).id;
  // Too long is refused at every save, also Finish later, and nothing is stored.
  const long = await a.c.post(`/sign/${a.tok}/save`, { values: { [id('Name')]: 'Bartholomew Jones' } });
  assert.equal(long.status, 400);
  assert.match(long.data.error, /at most 10 characters.*Nothing was saved/);
  assert.equal(fieldRow(eid, 'Name').value, null);
  const good = { [id('Name')]: 'Ada', [id('Start')]: '20/03/2027', [id('Postcode')]: '12345', [id('Amount')]: '1.234', [id('Tea')]: '1', [id('Coffee')]: '1' };
  const tries: [Record<string, string>, RegExp][] = [
    [{ [id('Name')]: 'Ada 2' }, /Use letters only/],
    [{ [id('Start')]: '2027-03-20' }, /like 20\/03\/2027/],
    [{ [id('Postcode')]: '1234' }, /Type 5 digits, like 12345\./],
    [{ [id('Amount')]: '1.234' }, /from 1 to 500/],
    [{ [id('Amount')]: '0,5' }, /from 1 to 500/],
    [{ [id('Amount')]: '$12' }, /in EUR/],
    [{ [id('Amount')]: '12,5,0' }, /does not read as a number/],
    [{ [id('Amount')]: '12,505' }, /from 1 to 500/],
    [{ [id('Amount')]: '1,5055' }, /at most 2 decimal places/],
    [{ [id('Coffee')]: '' }, /Drinks: Tick at least 2 boxes of these\./],
  ];
  for (const [over, why] of tries) {
    const res = await a.done({ ...good, [id('Amount')]: '12,50', ...over });
    assert.equal(res.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(res.data)}`);
    assert.match(res.data.error, why, JSON.stringify(over));
  }
  const fine = await a.done({ ...good, [id('Amount')]: '12,50' });
  assert.equal(fine.status, 200, JSON.stringify(fine.data));
  assert.equal(fieldRow(eid, 'Amount').value, '12,50', 'kept exactly as typed');
  assert.equal(fieldRow(eid, 'Amount').typed_num, '12.5', 'and as a number');
});

test('hidden values: dots for the next signer and in their copy, the sender sees it, and the completed copy follows the sender\'s choice', async () => {
  const s = await person('Hana Hider', 'hana@checks.example');
  for (const inCopy of [false, true]) {
    const r = await envelope(s, [box('pin', 'r1', 'text', 0.1, { label: 'Account number', validation: { hide: true, ...(inCopy ? { hide_in_copy: true } : {}) } })], { send: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const eid = r.data.envelope.id;
    const emails = db.all('SELECT email FROM recipients WHERE envelope_id=? ORDER BY routing_order', eid).map((x: any) => x.email);
    const a = await signer(eid, emails[0]);
    assert.equal((await a.done({ [fieldRow(eid, 'Account number').id]: 'NL91ABNA0417164300' })).status, 200);
    const b = await signer(eid, emails[1]);
    const seen = b.v.others.find((f: any) => f.label === 'Account number');
    assert.equal(seen.value, DOTS, 'the next signer sees dots');
    assert.ok(!JSON.stringify(b.v).includes('NL91ABNA'), 'nowhere in what their screen is given');
    const copy = await pdfText((await b.c.get(`/sign/${b.tok}/download`)).data);
    assert.ok(!copy.includes('NL91ABNA') && copy.includes(DOTS), 'nor in the copy they download while it is out');
    // The sender sees it, on the envelope and in the API.
    const env = (await s.get(`/envelopes/${eid}`)).data.envelope;
    assert.equal(env.fields.find((f: any) => f.label === 'Account number').value, 'NL91ABNA0417164300');
    assert.equal((await b.done({})).status, 200);
    const final = await pdfText((await s.get(`/envelopes/${eid}/download`)).data);
    if (inCopy) {
      assert.ok(!final.includes('NL91ABNA'), 'hidden in the completed copy too');
      assert.ok(final.includes(HIDDEN_IN_COPY));
      assert.match(final.replace(/\s+/g, ' '), /One value was hidden in this copy by the sender's choice/);
      assert.equal((await s.get(`/envelopes/${eid}`)).data.envelope.fields.find((f: any) => f.label === 'Account number').value, 'NL91ABNA0417164300', 'and still in the sender\'s records');
    } else {
      assert.ok(final.replace(/\s+/g, '').includes('NL91ABNA0417164300'), 'printed in the completed copy');
      assert.ok(!final.includes('hidden in this copy'));
    }
  }
});

test('fixed size: the server works out what fits from the box and refuses more; templates and bulk carry every check', async () => {
  const s = await person('Tom Template', 'tom@checks.example');
  const file = await upload(s, 1);
  const tpl = await s.post('/envelopes', {
    kind: 'template', subject: 'Checked form', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [
      box('sig', 'r', 'signature', 0.85, { required: true, h: 0.06 }),
      box('ref', 'r', 'text', 0.1, { label: 'Reference', w: 0.1, validation: { fixed: true } }),
      box('zip', 'r', 'text', 0.2, { label: 'Postcode', validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'Type 5 digits, like 12345.' } }),
    ],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const fits = JSON.parse(fieldRow(tpl.data.envelope.id, 'Reference').validation).fit_chars;
  assert.equal(fits, fitChars(0.1 * 612, 0.03 * 792));
  const used = await s.post('/envelopes', { template_id: tpl.data.envelope.id, recipients: { Client: { name: 'Cleo Client', email: 'cleo@checks.example' } }, send: true });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  const eid = used.data.envelope.id;
  assert.equal(fieldRow(eid, 'Postcode').validation, fieldRow(tpl.data.envelope.id, 'Postcode').validation, 'the copy has the same checks');
  const c = new Client();
  const tok = tokenFor(eid, 'cleo@checks.example');
  await c.post(`/sign/${tok}/consent`);
  const sig = db.get("SELECT id FROM fields WHERE envelope_id=? AND type='signature'", eid).id;
  const over = await c.post(`/sign/${tok}/complete`, { values: { [sig]: '1', [fieldRow(eid, 'Reference').id]: 'x'.repeat(fits + 1), [fieldRow(eid, 'Postcode').id]: '12345' }, signature_png: PNG });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /fixed size/);
  const ok = await c.post(`/sign/${tok}/complete`, { values: { [sig]: '1', [fieldRow(eid, 'Reference').id]: 'x'.repeat(fits), [fieldRow(eid, 'Postcode').id]: '12345' }, signature_png: PNG });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Bulk: every row's envelope carries the checks.
  const bulk = await s.post('/bulk', { template_id: tpl.data.envelope.id, rows: [{ Client: { name: 'Bo Bulk', email: 'bo@checks.example' } }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  const bid = bulk.data.results[0].id;
  assert.equal(fieldRow(bid, 'Postcode').validation, fieldRow(tpl.data.envelope.id, 'Postcode').validation);
  const bc = new Client();
  const btok = tokenFor(bid, 'bo@checks.example');
  await bc.post(`/sign/${btok}/consent`);
  const bsig = db.get("SELECT id FROM fields WHERE envelope_id=? AND type='signature'", bid).id;
  const bad = await bc.post(`/sign/${btok}/complete`, { values: { [bsig]: '1', [fieldRow(bid, 'Postcode').id]: '99' }, signature_png: PNG });
  assert.match(bad.data.error, /Type 5 digits, like 12345\./);
});

// ---- Repairs after review (tests/out/verify-ds-fields-checks, tests/out/ux-ds-fields-checks) ------------------------

test('slow patterns are refused: a repeated choice whose parts start alike, and too many open-ended repeats; safe ones still work', () => {
  for (const bad of ['(a|a)*', '(?:a|a)+b', '(\\w|\\d)+', '((a|a)b)*', '(a|)*', '(ab|a)+', '([ab]|c)+']) assert.match(patternProblem(bad), /repeat a choice/, bad);
  assert.match(patternProblem('\\d*\\d*\\d*\\d*x'), /at most 3 open-ended repeats/);
  assert.match(patternProblem('a?a?a?a?a?a?a?a?a?aaaaaaaaa'), /at most 8 repeats/);
  for (const ok of ['(ab|cd)+', '(?:a|b)*c', '(Mr|Mrs)\\.? [A-Z]+', '[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}']) assert.equal(patternProblem(ok), '', ok);
  // Even the pattern from the review no longer runs, in the browser or on the server: it says nothing, at once.
  const t = Date.now();
  assert.equal(valueProblem({ type: 'text', validation: { kind: 'pattern', pattern: '(a|a)*', message: 'm' } }, 'a'.repeat(40) + '!'), '');
  assert.equal(problemWith({ type: 'text', validation: '(a|a)*' }, 'a'.repeat(40) + '!'), '');
  assert.ok(Date.now() - t < 200);
});

test('a number field with only a currency, only decimals, only a smallest or only a largest never breaks on a fine value', () => {
  for (const validation of [{ currency: 'EUR' }, { decimals: 2 }, { min: 1 }, { max: 9 }, { currency: 'KES', decimals: 0 }]) {
    const f = { type: 'number', validation };
    assert.equal(valueProblem(f, '5'), '', JSON.stringify(validation));
    assert.equal(problemWith({ type: 'number', validation: JSON.stringify(validation) }, '5'), '', JSON.stringify(validation));
  }
  assert.match(valueProblem({ type: 'number', validation: { min: 10 } }, '5'), /of 10 or more/);
  assert.match(valueProblem({ type: 'number', validation: { max: 3 } }, '5'), /of 3 or less/);
  // An amount typed with its currency's letters is told plainly to type only the number, and the hint says so first.
  for (const v of ['KSh 100', 'Ksh100', '100 KES']) assert.match(valueProblem({ type: 'number', validation: { currency: 'KES' } }, v), /Type only the number/, v);
  assert.match(valueProblem({ type: 'number', validation: { currency: 'EUR' } }, '12 EUR'), /Type only the number/);
  assert.match(amountHint({ type: 'number', validation: { currency: 'KES' } }), /Type only the number\./);
});

test('a signer only sees a character count the sender chose, or near the quiet limit of a pattern field; pasting is named', () => {
  const pat = { type: 'text', validation: { kind: 'pattern', pattern: '[0-9]{5}', message: 'm' } };
  assert.equal(lengthHint(pat, ''), '', 'no "0 of 100 characters" the sender never set');
  assert.equal(lengthHint(pat, '1'.repeat(79)), '');
  assert.match(lengthHint(pat, '1'.repeat(80)), /80 of 100 characters/);
  assert.match(lengthHint({ type: 'text', validation: { max_length: 12 } }, ''), /0 of 12 characters/);
  assert.match(lengthHint({ type: 'text', validation: { max_length: 12 } }, 'x'.repeat(12)), /That is all this field takes\. If you pasted something longer, check what was kept\./);
});

test('a tick-box rule nobody could meet is refused at send, named the way the review step names it; the editor says what really happens', async () => {
  const req = (id: string, y: number, required: boolean, rule: any) => box(id, 'r1', 'checkbox', y, { label: id, group_name: 'Drinks', required, validation: rule });
  // Exactly 0, or at most 1, with two boxes required: the signer could never finish.
  for (const rule of [{ group_rule: 'exactly', group_count: 0 }, { group_rule: 'at_most', group_count: 1 }]) {
    const fields = [req('Tea', 0.3, true, rule), req('Coffee', 0.35, true, rule), req('Juice', 0.4, false, rule)];
    const mine = fields.map((f) => ({ ...f, recipient_id: 'r1' }));
    assert.match(checksSendProblem(mine[0], mine), /required.*Nobody could finish/);
    const s = await person('Gil Group', `gil${n}@checks.example`);
    const r = await envelope(s, fields, { send: true });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, /^"Tea" for Ada One, page 1: 2 boxes of this group are required.*Format and limits in the field's More options/);
  }
  // At least 2 with one required box is fine, and asking for more boxes than there are says the page asks for all.
  assert.equal(groupRuleProblem([{ type: 'checkbox', group_name: 'G', required: true, validation: { group_rule: 'at_least', group_count: 2 } }, { type: 'checkbox', group_name: 'G' }]), '');
  assert.match(groupRuleNote('exactly', 5, 3), /will be asked to tick all 3/);
  assert.equal(groupRuleNote('at_most', 5, 3), '');
  // The signer is told the rule where the box is, before Finish.
  const boxes = [{ id: 'a', type: 'checkbox', group_name: 'Drinks', validation: { group_rule: 'at_least', group_count: 2 } }, { id: 'b', type: 'checkbox', group_name: 'Drinks' }];
  assert.equal(boxRuleHint(boxes[1], boxes, true), 'Tick at least 2');
  assert.equal(boxRuleHint(boxes[0], boxes), 'Drinks: tick at least 2 boxes of these.');
  // A pattern without its message is named by label, person and page too.
  const s = await person('Nia Name', `nia${n}@checks.example`);
  const d = await envelope(s, [box('p', 'r1', 'text', 0.1, { label: 'Code', validation: { kind: 'pattern', pattern: '[A-Z]{3}' } })]);
  assert.match((await s.post(`/envelopes/${d.data.envelope.id}/send`)).data.error, /^"Code" for Ada One, page 1: Write the message/);
});

test('the server: Finish with a currency-only and a decimals-only amount works; a slow stored pattern cannot hold the server', async () => {
  const s = await person('Cy Currency', 'cy@checks.example');
  const r = await envelope(s, [
    box('eur', 'r1', 'number', 0.1, { label: 'Euros', validation: { currency: 'EUR' } }),
    box('dec', 'r1', 'number', 0.15, { label: 'Rate', validation: { decimals: 2 } }),
    box('code', 'r1', 'text', 0.2, { label: 'Code', validation: { kind: 'pattern', pattern: '[a-z]+', message: 'Small letters only.' } }),
  ], { send: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  // A pattern saved before the reader knew about repeated choices (as an old database could hold it).
  db.run('UPDATE fields SET validation=? WHERE id=?', JSON.stringify({ kind: 'pattern', pattern: '(a|a)*', message: 'Only a.' }), fieldRow(eid, 'Code').id);
  const a = await signer(eid, db.get('SELECT email FROM recipients WHERE envelope_id=? AND routing_order=1', eid).email);
  const t = Date.now();
  const done = await a.done({ [fieldRow(eid, 'Euros').id]: '12', [fieldRow(eid, 'Rate').id]: '1.25', [fieldRow(eid, 'Code').id]: 'a'.repeat(27) + '!' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.equal(fieldRow(eid, 'Euros').typed_num, '12');
  // The old string form on the server, too.
  const r2 = await envelope(s, [box('old', 'r1', 'text', 0.1, { label: 'Old', validation: '[a-z]+' })], { send: true });
  const eid2 = r2.data.envelope.id;
  db.run('UPDATE fields SET validation=? WHERE id=?', '(a|a)*', fieldRow(eid2, 'Old').id);
  const b = await signer(eid2, db.get('SELECT email FROM recipients WHERE envelope_id=? AND routing_order=1', eid2).email);
  const t2 = Date.now();
  assert.equal((await b.done({ [fieldRow(eid2, 'Old').id]: 'a'.repeat(30) + '!' })).status, 200);
  assert.ok(Date.now() - t2 < 3000);
});

test('the server tester stops a pattern that runs long instead of hanging', async () => {
  await import('../src/server/fieldchecks.ts');
  const { matchesPattern: m } = await import('../src/lib/fieldrules.ts');
  assert.equal(m('[0-9]{3}', '123'), true);
  assert.equal(m('[0-9]{3}', '12a'), false);
});
